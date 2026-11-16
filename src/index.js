// Worker entry point: the Telegram webhook. Wires together commands.js
// (pure command logic), telegram.js (outbound replies), and db.js (D1
// persistence). See docs/superpowers/specs/2026-11-11-meal-chooser-bot-design.md
// for the product-level default values used below.

import { handle } from './commands.js';
import { sendMessage } from './telegram.js';
import {
  getRoster,
  saveRoster,
  getActiveSession,
  createSession,
  recordDraw,
  readSessionLog,
  appendFoodLog,
  readFoodLog,
  listSessionSummaries,
  listMenu,
  addMenuItem,
  removeMenuItem,
  hasProcessed,
  markProcessed,
} from './db.js';

const DEFAULT_PARTICIPANTS = ['Person 1', 'Person 2'];
const DEFAULT_SESSION_LENGTH = 21;
// Fixed for this user rather than configurable: a 2-person personal bot,
// not a multi-timezone product. Drives both /ate's breakfast/lunch/dinner
// auto-tagging and /food's displayed dates.
const TIMEZONE = 'Asia/Kolkata';

function formatAuditRows(rows) {
  if (rows.length === 0) return 'No picks logged yet.';
  return rows
    .map((r) => {
      const methodLabel = r.method === 'manual' ? 'manual' : r.forced ? 'auto, forced' : 'auto';
      const probText = r.probability != null ? ` (p=${r.probability.toFixed(2)})` : '';
      return `${r.mealNumber}. ${r.name} [${methodLabel}]${probText}`;
    })
    .join('\n');
}

function formatFoodRows(rows) {
  if (rows.length === 0) return 'No food logged yet.';
  return rows
    .map((r) => {
      const date = new Date(r.loggedAt).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        timeZone: TIMEZONE,
      });
      // mealType is null for any row logged before this feature existed.
      return r.mealType ? `${date}, ${r.mealType}: ${r.dish}` : `${date}: ${r.dish}`;
    })
    .join('\n');
}

function formatHistoryRows(summaries) {
  if (summaries.length === 0) return 'No sessions yet.';
  const lastIndex = summaries.length - 1;
  return summaries
    .map((s, i) => {
      const totalPicks = s.totals.reduce((sum, t) => sum + t.count, 0);
      const inProgress = i === lastIndex && totalPicks < s.n ? ' (in progress)' : '';
      const tally = s.totals.map((t) => `${t.name} ${t.count}`).join(', ');
      return `Session ${s.sessionIndex} (n=${s.n}): ${tally}${inProgress}`;
    })
    .join('\n');
}

// Parses and validates the inbound Telegram update. Returns null for any
// shape that should be silently IGNORED (malformed JSON, missing fields) --
// the caller never touches D1 in that case.
async function parseUpdate(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;

  const message = body.message;
  if (!message || typeof message !== 'object') return null;

  const chat = message.chat;
  if (!chat || chat.id === undefined || chat.id === null) return null;
  if (typeof message.text !== 'string') return null;
  if (body.update_id === undefined || body.update_id === null) return null;

  return { chatId: chat.id, text: message.text, updateId: body.update_id };
}

// Executes the effects produced by handle(), in order, against D1 and
// Telegram. `originalSession` is whatever was loaded from D1 *before*
// calling handle() (possibly null) -- it's needed because commands.js
// mutates an existing session object in place (so it's still the right
// object to persist a draw against even after handle() returns a
// *different* object in result.state.session following an auto-roll).
async function runEffects(env, chatId, updateId, nowIso, originalSession, result) {
  for (const effect of result.effects) {
    switch (effect.type) {
      case 'send':
        await sendMessage(env, chatId, effect.text);
        break;

      case 'log': {
        // The session this draw/log was recorded against:
        // - If a session was already active, commands.js mutates it in
        //   place (drawNext / the manual decrement in handleLog), so
        //   `originalSession` is still that exact object, `.id` and all.
        // - If no session was active, resolveActiveSession() auto-started
        //   a brand-new one. As long as that single draw doesn't *also*
        //   complete it (true for any sane defaultSessionLength > 1, and
        //   our default is 21), that new session is still
        //   result.state.session here, so create it now to obtain its id.
        const drawnSession = originalSession ?? result.state.session;
        if (!drawnSession.id) {
          await createSession(env, chatId, drawnSession);
        }
        await recordDraw(env, drawnSession, effect.entry, updateId, nowIso);
        break;
      }

      case 'audit': {
        // /audit only ever reports on the currently active session, and
        // handleAudit never mutates state, so result.state.session *is*
        // the same object we loaded from D1 -- already carrying `.id`.
        const rows = await readSessionLog(env, result.state.session.id);
        await sendMessage(env, chatId, formatAuditRows(rows));
        break;
      }

      case 'food_log':
        await appendFoodLog(env, chatId, effect.entry.dish, effect.entry.mealType, updateId, nowIso);
        break;

      case 'food_history': {
        const rows = await readFoodLog(env, chatId, effect.limit);
        await sendMessage(env, chatId, formatFoodRows(rows));
        break;
      }

      case 'history_summary': {
        const summaries = await listSessionSummaries(env, chatId);
        await sendMessage(env, chatId, formatHistoryRows(summaries));
        break;
      }

      case 'menu_list': {
        const items = await listMenu(env, chatId, effect.category);
        let text;
        if (items.length > 0) {
          text = items.join('\n');
        } else if (effect.category === 'breakfast') {
          text = 'No breakfast items yet — add one with /menu add breakfast <dish>.';
        } else if (effect.category === 'lunch_dinner') {
          text = 'No lunch/dinner items yet — add one with /menu add lunch <dish>.';
        } else {
          text = 'The menu is empty — add one with /menu add <breakfast|lunch|dinner> <dish>.';
        }
        await sendMessage(env, chatId, text);
        break;
      }

      case 'menu_add': {
        const { added } = await addMenuItem(env, chatId, effect.name, effect.category, nowIso);
        const categoryLabel = effect.category === 'breakfast' ? 'breakfast' : 'lunch/dinner';
        const text = added
          ? `Added ${effect.name} to the menu (${categoryLabel}).`
          : `${effect.name} is already on the menu.`;
        await sendMessage(env, chatId, text);
        break;
      }

      case 'menu_remove': {
        const { removed } = await removeMenuItem(env, chatId, effect.name);
        const text = removed ? `Removed ${effect.name} from the menu.` : `${effect.name} isn't on the menu.`;
        await sendMessage(env, chatId, text);
        break;
      }

      default:
        break;
    }
  }

  // Covers every case where handle() produced a brand-new session object
  // that hasn't been persisted yet: /newsession, /setup's first use (via
  // ensureRoster's lazy defaults interacting with a later /newsession),
  // and an auto-roll completing the old session (handled above for the
  // completing draw itself; this is the freshly-rolled *next* session).
  // Safe to call even when the 'log' case above already created a session
  // this same request, since that session already has `.id` set by then.
  if (result.state.session && !result.state.session.id) {
    await createSession(env, chatId, result.state.session);
  }
}

export default {
  async fetch(request, env, _ctx) {
    if (request.method !== 'POST') {
      return new Response('Meal chooser bot is running.');
    }

    const secretHeader = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (!secretHeader || secretHeader !== env.WEBHOOK_SECRET) {
      return new Response('IGNORED');
    }

    const update = await parseUpdate(request);
    if (!update) {
      return new Response('IGNORED');
    }

    const { chatId, text, updateId } = update;
    if (String(chatId) !== String(env.AUTHORIZED_CHAT_ID)) {
      return new Response('IGNORED');
    }

    if (await hasProcessed(env, chatId, updateId)) {
      return new Response('OK');
    }

    // Everything below touches D1 and/or the Telegram API, so any throw
    // here (a bug, a D1 hiccup, a Telegram API failure) must not propagate:
    // an uncaught throw would make the Worker return a 500, and Telegram
    // retries a failed delivery indefinitely -- re-running every effect
    // that already succeeded on a partial failure, since markProcessed is
    // the last statement in the happy path. Swallowing here and returning
    // 'OK' regardless means a single poisoned update can degrade at worst
    // to a dropped reply, never a permanent retry-storm lockout.
    try {
      const roster = await getRoster(env, chatId);
      const session = await getActiveSession(env, chatId);
      const state = { roster, session };

      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const context = {
        config: {
          defaultParticipants: DEFAULT_PARTICIPANTS,
          defaultSessionLength: DEFAULT_SESSION_LENGTH,
          timezone: TIMEZONE,
        },
        nowMs,
        nowIso,
        random: Math.random,
      };

      const result = handle(state, { text }, context);

      await runEffects(env, chatId, updateId, nowIso, session, result);

      // Reference-inequality, not truthiness: handle() passes the loaded
      // roster through unchanged for most commands (/status, /audit, /ate,
      // /food, /menu, and even a non-completing /draw or /log), so a bare
      // truthiness check would re-save an identical roster on nearly every
      // call once one exists. Only a real change -- null -> object on the
      // first /setup, or a new object from a later /setup -- produces a
      // different reference here.
      if (result.state.roster !== roster) {
        await saveRoster(env, chatId, result.state.roster);
      }

      await markProcessed(env, chatId, updateId);
    } catch (err) {
      console.error('Unhandled error processing update', updateId, 'for chat', chatId, err);
    }

    return new Response('OK');
  },
};
