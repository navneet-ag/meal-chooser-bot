import { startSession, isSessionComplete, drawNext } from './fairness.js';

export const LIMITS = {
  nameLength: 40,
  maxParticipants: 10,
  dishLength: 80,
  foodHistoryDefault: 10,
  foodHistoryMax: 50,
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
  '/ate <dish> - log what was eaten (auto-tagged breakfast/lunch/dinner)',
  '/food [n] - show recent food log entries',
  '/menu [breakfast|lunch|dinner] - show meal ideas, all or filtered',
  '/menu add <breakfast|lunch|dinner> <dish> - add an idea',
  '/menu remove <dish> - remove an idea',
  '/history - show a one-line summary of every session, oldest first',
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
  const spaceMatch = trimmed.match(/\s/);
  const spaceIdx = spaceMatch ? spaceMatch.index : -1;
  const rawCommand = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
  // Group chats with 2+ bots send "/draw@SomeBotName" via Telegram's command
  // picker (and sometimes users type it by hand) -- strip the @botname
  // suffix before matching against known commands.
  const command = rawCommand.toLowerCase().split('@')[0];
  return { command, args };
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

// /ate, /food, and /menu are intentionally decoupled from the roster/session
// machinery: they never call ensureRoster and never read or write
// state.roster or state.session, so they work identically with or without a
// roster configured.

// Shared by /ate, /menu add, and /menu remove: enforces LIMITS.dishLength
// on a dish/menu-item name. Returns a reply result if the name is too
// long, or null if it's within the limit.
function dishLengthError(state, dish) {
  if (dish.length > LIMITS.dishLength) {
    return reply(state, `Dish name must be ${LIMITS.dishLength} characters or fewer.`);
  }
  return null;
}

// Local hour-of-day (0-23) for a UTC instant in a given IANA timezone.
// Intl can report "24" for midnight under hour12:false in some
// environments -- % 24 normalizes that to 0.
function localHour(nowIso, timezone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hour12: false,
  });
  const hourPart = formatter.formatToParts(new Date(nowIso)).find((p) => p.type === 'hour').value;
  return parseInt(hourPart, 10) % 24;
}

// Fixed, non-overlapping, full-day coverage -- deliberately simple (no
// per-user configuration) since this is a 2-person personal bot, not a
// general scheduling tool.
function mealTypeForHour(hour) {
  if (hour >= 4 && hour < 11) return 'breakfast';
  if (hour >= 11 && hour < 16) return 'lunch';
  return 'dinner';
}

function handleAte(state, args, context) {
  // args is already trimmed by parseCommand's dispatcher, so no need to
  // trim it again here.
  const dish = args;

  if (!dish) {
    return reply(state, 'Usage: /ate <dish>.');
  }

  const lengthError = dishLengthError(state, dish);
  if (lengthError) return lengthError;

  const mealType = mealTypeForHour(localHour(context.nowIso, context.config.timezone));

  return {
    state,
    effects: [
      { type: 'food_log', entry: { dish, mealType } },
      { type: 'send', text: `Logged: ${dish} (${mealType})` },
    ],
  };
}

function handleFood(state, args) {
  const parsed = args ? Number(args) : LIMITS.foodHistoryDefault;
  const n = Number.isInteger(parsed) ? parsed : LIMITS.foodHistoryDefault;
  const limit = Math.min(Math.max(n, 1), LIMITS.foodHistoryMax);

  return { state, effects: [{ type: 'food_history', limit }] };
}

function handleHistory(state) {
  return { state, effects: [{ type: 'history_summary' }] };
}

// /menu categories are deliberately just two buckets, not three matching
// /ate's breakfast/lunch/dinner tagging: a menu IDEA (unlike something you
// actually ate at a specific recorded time) is often equally valid for
// lunch or dinner, which is exactly why the user grouped their own list
// that way rather than splitting it.
const MENU_CATEGORIES = { breakfast: 'breakfast', lunch: 'lunch_dinner', dinner: 'lunch_dinner' };

const MENU_USAGE =
  'Usage: /menu | /menu breakfast | /menu lunch | /menu add <breakfast|lunch|dinner> <dish> | /menu remove <dish>.';

// Splits "breakfast Poha" into {category:'breakfast', dish:'Poha'}, or
// null if the leading word isn't a recognized category or no dish name
// follows it.
function parseMenuAdd(rest) {
  const spaceIdx = rest.indexOf(' ');
  if (spaceIdx === -1) return null;
  const category = MENU_CATEGORIES[rest.slice(0, spaceIdx).toLowerCase()];
  if (!category) return null;
  const dish = rest.slice(spaceIdx + 1).trim();
  if (!dish) return null;
  return { category, dish };
}

function handleMenu(state, args) {
  if (!args) {
    return { state, effects: [{ type: 'menu_list' }] };
  }

  const lower = args.toLowerCase();

  if (lower === 'breakfast') {
    return { state, effects: [{ type: 'menu_list', category: 'breakfast' }] };
  }
  if (lower === 'lunch' || lower === 'dinner') {
    return { state, effects: [{ type: 'menu_list', category: 'lunch_dinner' }] };
  }

  if (lower.startsWith('add ')) {
    const parsed = parseMenuAdd(args.slice(4).trim());
    if (!parsed) {
      return reply(state, MENU_USAGE);
    }
    const lengthError = dishLengthError(state, parsed.dish);
    if (lengthError) return lengthError;
    return { state, effects: [{ type: 'menu_add', name: parsed.dish, category: parsed.category }] };
  }

  if (lower.startsWith('remove ')) {
    const name = args.slice(7).trim();
    if (!name) {
      return reply(state, MENU_USAGE);
    }
    const lengthError = dishLengthError(state, name);
    if (lengthError) return lengthError;
    return { state, effects: [{ type: 'menu_remove', name }] };
  }

  return reply(state, MENU_USAGE);
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
    case '/ate':
      return handleAte(working, args, context);
    case '/food':
      return handleFood(working, args);
    case '/menu':
      return handleMenu(working, args);
    case '/history':
      return handleHistory(working);
    default:
      return reply(working, 'Unknown command. Type /help to see what I can do.');
  }
}
