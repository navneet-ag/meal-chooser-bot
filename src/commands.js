import { startSession, isSessionComplete, drawNext } from './fairness.js';

export const LIMITS = {
  nameLength: 40,
  maxParticipants: 10,
};

const START_TEXT =
  'Welcome to Meal Chooser Bot! Use /setup <name1>, <name2>, ... to configure ' +
  'who is picking meals, then /newsession to start a fair session. Type /help ' +
  'for the full command list.';

const HELP_TEXT = [
  'Commands:',
  '/setup <name1>, <name2>, ... - configure participants (2-10 names)',
  '/newsession [n] - start a new fairness session (default length from roster)',
  '/draw - pick who gets the next meal',
  '/log <name> - manually log a pick for the next meal slot',
  '/status - show the current session',
  '/audit - show the full session log',
  '/config - show the current roster and limits',
  '/ate <dish> - log what was eaten',
  '/food [n] - show recent food log entries',
  '/menu - show or manage the meal idea list',
].join('\n');

// Lazily initializes state.roster from config defaults on first use.
// Only called by the roster/session/draw commands — never by /ate, /food, or /menu.
function ensureRoster(state, context) {
  if (!state.roster || typeof state.roster !== 'object') {
    state.roster = {
      names: [...context.config.defaultParticipants],
      defaultN: context.config.defaultSessionLength,
    };
  }
  return state.roster;
}

function reply(state, text) {
  return { state, effects: [{ type: 'send', text }] };
}

function parseCommand(text) {
  const trimmed = (text || '').trim();
  const spaceIdx = trimmed.indexOf(' ');
  const rawCommand = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
  return { command: rawCommand.toLowerCase(), args };
}

function parseNames(args) {
  const rawNames = args.includes(',') ? args.split(',') : args.split(/\s+/);
  return rawNames.map((n) => n.trim()).filter((n) => n.length > 0);
}

function handleSetup(state, args, context) {
  if (!args) {
    return reply(
      state,
      `Usage: /setup <name1>, <name2>, ... (between 2 and ${LIMITS.maxParticipants} names)`
    );
  }

  const names = parseNames(args);

  if (names.length < 2 || names.length > LIMITS.maxParticipants) {
    return reply(state, `Please provide between 2 and ${LIMITS.maxParticipants} names.`);
  }

  const tooLong = names.find((n) => n.length > LIMITS.nameLength);
  if (tooLong) {
    return reply(
      state,
      `Names must be ${LIMITS.nameLength} characters or fewer ("${tooLong}" is too long).`
    );
  }

  ensureRoster(state, context);
  const deferred = state.session !== null && !isSessionComplete(state.session);
  const newRoster = { ...state.roster, names };
  const newState = { ...state, roster: newRoster };

  const text = deferred
    ? `Roster updated to: ${names.join(', ')}. This applies starting next session — ` +
      'the active session keeps its original participants.'
    : `Roster updated to: ${names.join(', ')}.`;

  return reply(newState, text);
}

function handleNewSession(state, args, context) {
  ensureRoster(state, context);
  const roster = state.roster;
  const k = roster.names.length;

  const n = args ? Number(args) : roster.defaultN;

  if (!Number.isInteger(n) || n < k) {
    return reply(
      state,
      `Session length must be at least ${k} (one meal per participant minimum).`
    );
  }

  const prior = state.session;
  const priorIncomplete = prior !== null && !isSessionComplete(prior);
  const sessionIndex = (prior ? prior.sessionIndex : 0) + 1;

  const newSession = startSession(n, roster.names, context.random, context.nowIso, sessionIndex);

  let prefix = '';
  if (priorIncomplete) {
    const tally = prior.participants
      .map((p) => `${p.name}: ${p.quota - p.remaining}/${p.quota}`)
      .join(', ');
    prefix = `Previous session ended early at ${prior.mealsLogged}/${prior.n} meals (${tally}). `;
  }

  const newState = { ...state, session: newSession };
  const text = `${prefix}New session started: ${n} meals among ${roster.names.join(', ')}.`;

  return reply(newState, text);
}

function handleStatus(state) {
  if (!state.session) {
    return reply(
      state,
      'No active session. Use /setup to configure participants, then /newsession to start one.'
    );
  }

  const s = state.session;
  const lines = s.participants.map((p) => `${p.name}: ${p.remaining}/${p.quota} remaining`);
  const text = `Session ${s.sessionIndex}: ${s.mealsLogged}/${s.n} meals logged.\n${lines.join('\n')}`;

  return reply(state, text);
}

// Resolves {roster, session} for the draw/log commands without ever mutating
// the caller-supplied `state` object. Lazily initializes the roster from
// config defaults (mirroring ensureRoster) and, when no session is active,
// auto-starts one the same way /newsession with no arg would. Because this
// operates on a scratch holder rather than `state` itself, callers can still
// discard the result and return `state` untouched (e.g. /log on no match).
function resolveActiveSession(state, context) {
  const holder = { roster: state.roster, session: state.session };
  ensureRoster(holder, context);

  if (!holder.session) {
    const roster = holder.roster;
    holder.session = startSession(roster.defaultN, roster.names, context.random, context.nowIso, 1);
  }

  return { roster: holder.roster, session: holder.session };
}

// Shared by /draw and /log: after the command's own mutation, checks whether
// the session just completed and, if so, appends a completion summary and
// rolls into a fresh session — unconditionally, the instant mealsLogged
// reaches n. The new session carries forward the completed session's `n`
// but uses the CURRENT roster's names (state.roster.names), since the
// auto-rolled session *is* "next session" — exactly the point at which a
// mid-session /setup roster change (deferred until now) should take effect.
function rollIfComplete(state, context, baseText) {
  const session = state.session;

  if (!isSessionComplete(session)) {
    return { state, text: baseText };
  }

  const tally = session.participants
    .map((p) => `${p.name}: ${p.quota - p.remaining}/${p.quota}`)
    .join(', ');
  const names = state.roster.names;
  const nextSession = startSession(session.n, names, context.random, context.nowIso, session.sessionIndex + 1);

  const text =
    `${baseText} Session complete (${tally})! Starting a new session: ` +
    `${session.n} meals among ${names.join(', ')}.`;

  return { state: { ...state, session: nextSession }, text };
}

function handleDraw(state, context) {
  const { roster, session } = resolveActiveSession(state, context);
  const newState = { roster, session };

  const { winner, mealNumber } = drawNext(session, context.random);
  const logEntry = {
    sessionIndex: session.sessionIndex,
    mealNumber,
    name: winner.name,
    method: 'auto',
    probability: winner.p,
    forced: winner.forced,
  };

  const baseText = `${winner.name} is picked for meal ${mealNumber}/${session.n}.`;
  const { state: finalState, text } = rollIfComplete(newState, context, baseText);

  return {
    state: finalState,
    effects: [{ type: 'send', text }, { type: 'log', entry: logEntry }],
  };
}

function handleLog(state, args, context) {
  if (!args) {
    return reply(state, 'Usage: /log <name>');
  }

  const { roster, session } = resolveActiveSession(state, context);
  const participant = session.participants.find(
    (p) => p.name.toLowerCase() === args.toLowerCase()
  );

  if (!participant) {
    return reply(state, `No participant named "${args}" in the current session.`);
  }

  participant.remaining--;
  session.mealsLogged++;
  const mealNumber = session.mealsLogged;

  const logEntry = {
    sessionIndex: session.sessionIndex,
    mealNumber,
    name: participant.name,
    method: 'manual',
    probability: null,
    forced: false,
  };

  const newState = { roster, session };
  const baseText = `Logged ${participant.name} for meal ${mealNumber}/${session.n}.`;
  const { state: finalState, text } = rollIfComplete(newState, context, baseText);

  return {
    state: finalState,
    effects: [{ type: 'send', text }, { type: 'log', entry: logEntry }],
  };
}

function handleAudit(state) {
  if (!state.session) {
    return reply(state, 'No active session yet.');
  }

  return { state, effects: [{ type: 'audit', sessionIndex: state.session.sessionIndex }] };
}

function handleConfig(state, context) {
  ensureRoster(state, context);
  const roster = state.roster;
  const text = [
    `Participants: ${roster.names.join(', ')}`,
    `Default session length: ${roster.defaultN}`,
    `Limits: up to ${LIMITS.maxParticipants} participants, names up to ${LIMITS.nameLength} characters.`,
  ].join('\n');

  return reply(state, text);
}

export function handle(state, event, context) {
  const working =
    state && typeof state === 'object'
      ? { roster: state.roster ?? null, session: state.session ?? null }
      : { roster: null, session: null };

  const { command, args } = parseCommand(event && event.text);

  switch (command) {
    case '/start':
      return reply(working, START_TEXT);
    case '/help':
      return reply(working, HELP_TEXT);
    case '/setup':
      return handleSetup(working, args, context);
    case '/newsession':
      return handleNewSession(working, args, context);
    case '/status':
      return handleStatus(working);
    case '/draw':
      return handleDraw(working, context);
    case '/log':
      return handleLog(working, args, context);
    case '/audit':
      return handleAudit(working);
    case '/config':
      return handleConfig(working, context);
    default:
      return reply(working, 'Unknown command. Type /help to see what I can do.');
  }
}
