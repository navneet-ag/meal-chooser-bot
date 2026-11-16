import test from 'node:test';
import assert from 'node:assert';
import { startSession, drawNext } from '../src/fairness.js';
import { freshEnv } from './helpers.js';
import {
  getRoster, saveRoster,
  getActiveSession, createSession, recordDraw, readSessionLog,
  appendFoodLog, readFoodLog, listSessionSummaries,
  listMenu, addMenuItem, removeMenuItem,
  hasProcessed, markProcessed,
} from '../src/db.js';

// NOTE on chatId fixtures: the task brief's example tests used non-numeric
// string chat ids like 'chat1'. The `roster` table declares `chat_id` as a
// bare `INTEGER PRIMARY KEY`, which SQLite treats as a rowid alias -- such
// columns only accept values that are integers, or losslessly convertible
// to one (confirmed against real D1 via Miniflare: binding a non-numeric
// string such as 'chat1' into that column raises
// `D1_ERROR: datatype mismatch: SQLITE_MISMATCH`, even via a plain
// parameterless literal INSERT, so this is inherent SQLite rowid-alias
// behavior, not a binding quirk). Every other table's chat_id column is
// either not a sole-column PRIMARY KEY or is part of a composite key, so it
// tolerates arbitrary string values fine. Task 9's plan consistently uses
// numeric-looking chat id strings ('1', '999', ...) rather than 'chat1', so
// these tests follow that same convention instead of the brief's literal
// 'chat1'/'chat2' placeholders.

test('saveRoster then getRoster round-trips', async (t) => {
  const env = await freshEnv(t);
  await saveRoster(env, '1', { names: ['A', 'B'], defaultN: 21 });
  assert.deepEqual(await getRoster(env, '1'), { names: ['A', 'B'], defaultN: 21 });
});

test('getRoster returns null when no roster has been saved', async (t) => {
  const env = await freshEnv(t);
  assert.equal(await getRoster(env, '1'), null);
});

test('saveRoster overwrites an existing roster for the same chat', async (t) => {
  const env = await freshEnv(t);
  await saveRoster(env, '1', { names: ['A', 'B'], defaultN: 21 });
  await saveRoster(env, '1', { names: ['A', 'B', 'C'], defaultN: 30 });
  assert.deepEqual(await getRoster(env, '1'), { names: ['A', 'B', 'C'], defaultN: 30 });
});

test('createSession then getActiveSession reconstructs the Session shape', async (t) => {
  const env = await freshEnv(t);
  const session = startSession(4, ['A', 'B'], () => 0.1, '2026-11-12T00:00:00.000Z', 1);
  await createSession(env, '1', session);
  assert.deepEqual(await getActiveSession(env, '1'), session);
});

test('recordDraw persists the decrement and the log row', async (t) => {
  const env = await freshEnv(t);
  const session = startSession(4, ['A', 'B'], () => 0.1, '2026-11-12T00:00:00.000Z', 1);
  await createSession(env, '1', session);
  const { winner, mealNumber } = drawNext(session, () => 0.1);
  await recordDraw(
    env,
    session,
    { sessionIndex: 1, mealNumber, name: winner.name, method: 'auto', probability: winner.p, forced: winner.forced },
    'upd1',
    '2026-11-12T00:01:00.000Z',
  );
  const reloaded = await getActiveSession(env, '1');
  assert.equal(
    reloaded.participants.find(p => p.name === winner.name).remaining,
    session.participants.find(p => p.name === winner.name).remaining,
  );
  const log = await readSessionLog(env, reloaded.id);
  assert.equal(log.length, 1);
  assert.equal(log[0].name, winner.name);
});

// Regression for the Fix 1 critical bug: src/index.js's auto-start path for
// /draw calls drawNext() (which decrements `remaining` in memory) BEFORE
// createSession() ever persists the session, then calls recordDraw()
// against that already-decremented object. If recordDraw does a *relative*
// decrement (`remaining = remaining - 1`), the winner's remaining gets
// double-decremented: once implicitly via createSession persisting the
// already-mutated in-memory value, and again via recordDraw's own
// decrement. This test reproduces that exact call order directly against
// db.js (without going through the Worker) and asserts the invariant that
// must hold after any draw: sum(remaining) === n - mealsLogged.
test('recordDraw against a session created AFTER drawNext already mutated it does not double-decrement', async (t) => {
  const env = await freshEnv(t);
  const session = startSession(4, ['A', 'B'], () => 0.1, '2026-11-12T00:00:00.000Z', 1);
  const { winner, mealNumber } = drawNext(session, () => 0.1); // mutates session.participants in memory first
  await createSession(env, '1', session); // persists the ALREADY-decremented value, like index.js's auto-start path
  await recordDraw(
    env,
    session,
    { sessionIndex: 1, mealNumber, name: winner.name, method: 'auto', probability: winner.p, forced: winner.forced },
    'u1',
    '2026-11-12T00:01:00.000Z',
  );
  const reloaded = await getActiveSession(env, '1');
  const sumRemaining = reloaded.participants.reduce((s, p) => s + p.remaining, 0);
  assert.equal(sumRemaining, reloaded.n - reloaded.mealsLogged);
});

test('hasProcessed/markProcessed dedupe by (chatId, updateId)', async (t) => {
  const env = await freshEnv(t);
  assert.equal(await hasProcessed(env, '1', 'upd1'), false);
  await markProcessed(env, '1', 'upd1');
  assert.equal(await hasProcessed(env, '1', 'upd1'), true);
  await markProcessed(env, '1', 'upd1'); // second call must not throw
});

// Ruling 3: the brief's own version of this test (named "readSessionLog only
// returns rows for the given session id") never actually exercised
// cross-session isolation -- it only asserted `sessionRow.sessionIndex === 1`.
// This replacement proves isolation for real, using `session.id` (available
// per Ruling 1, since createSession mutates the passed-in session object).
test('readSessionLog returns ordered rows scoped to one session id', async (t) => {
  const env = await freshEnv(t);
  const s1 = startSession(2, ['A', 'B'], () => 0.1, '2026-11-12T00:00:00.000Z', 1);
  await createSession(env, '1', s1); // s1.id now set by createSession's mutation
  const d1 = drawNext(s1, () => 0.1);
  await recordDraw(
    env,
    s1,
    { sessionIndex: 1, mealNumber: d1.mealNumber, name: d1.winner.name, method: 'auto', probability: d1.winner.p, forced: d1.winner.forced },
    'u1',
    '2026-11-12T00:01:00.000Z',
  );
  const s2 = startSession(2, ['A', 'B'], () => 0.1, '2026-11-12T01:00:00.000Z', 2);
  await createSession(env, '1', s2); // different session, same chat
  const log1 = await readSessionLog(env, s1.id);
  assert.equal(log1.length, 1);
  assert.equal(log1[0].mealNumber, 1);
  const log2 = await readSessionLog(env, s2.id);
  assert.equal(log2.length, 0);
});

test('appendFoodLog then readFoodLog returns most-recent-first, limited, with mealType', async (t) => {
  const env = await freshEnv(t);
  await appendFoodLog(env, '1', 'Pasta', 'breakfast', 'u1', '2026-11-12T00:00:00.000Z');
  await appendFoodLog(env, '1', 'Dal Rice', 'dinner', 'u2', '2026-11-12T01:00:00.000Z');
  const rows = await readFoodLog(env, '1', 1);
  assert.deepEqual(rows, [{ dish: 'Dal Rice', mealType: 'dinner', loggedAt: '2026-11-12T01:00:00.000Z' }]);
});

test('listSessionSummaries returns per-session pick totals, oldest first', async (t) => {
  const env = await freshEnv(t);

  const s1 = startSession(2, ['A', 'B'], () => 0.1, '2026-11-12T00:00:00.000Z', 1);
  await createSession(env, '1', s1);
  const d1 = drawNext(s1, () => 0.1);
  await recordDraw(env, s1, { sessionIndex: 1, mealNumber: d1.mealNumber, name: d1.winner.name, method: 'auto', probability: d1.winner.p, forced: d1.winner.forced }, 'u1', '2026-11-12T00:01:00.000Z');
  const d2 = drawNext(s1, () => 0.9);
  await recordDraw(env, s1, { sessionIndex: 1, mealNumber: d2.mealNumber, name: d2.winner.name, method: 'auto', probability: d2.winner.p, forced: d2.winner.forced }, 'u2', '2026-11-12T00:02:00.000Z');

  const s2 = startSession(2, ['A', 'B'], () => 0.1, '2026-11-13T00:00:00.000Z', 2);
  await createSession(env, '1', s2);
  const d3 = drawNext(s2, () => 0.1);
  await recordDraw(env, s2, { sessionIndex: 2, mealNumber: d3.mealNumber, name: d3.winner.name, method: 'auto', probability: d3.winner.p, forced: d3.winner.forced }, 'u3', '2026-11-13T00:01:00.000Z');
  // session 2 left incomplete on purpose: only 1 of 2 meals logged.

  const summaries = await listSessionSummaries(env, '1');
  assert.deepEqual(summaries, [
    { sessionIndex: 1, n: 2, totals: [{ name: 'A', count: 1 }, { name: 'B', count: 1 }] },
    { sessionIndex: 2, n: 2, totals: [{ name: 'A', count: 1 }] },
  ]);
});

test('listSessionSummaries returns an empty array when the chat has never started a session', async (t) => {
  const env = await freshEnv(t);
  assert.deepEqual(await listSessionSummaries(env, '1'), []);
});

test('addMenuItem reports added:false on a second identical add', async (t) => {
  const env = await freshEnv(t);
  assert.deepEqual(await addMenuItem(env, '1', 'Pasta', 'lunch_dinner', '2026-11-12T00:00:00.000Z'), { added: true });
  assert.deepEqual(await addMenuItem(env, '1', 'Pasta', 'lunch_dinner', '2026-11-12T00:01:00.000Z'), { added: false });
  assert.deepEqual(await listMenu(env, '1'), ['Pasta']);
});

test('removeMenuItem reports removed:false when the dish is not on the menu', async (t) => {
  const env = await freshEnv(t);
  assert.deepEqual(await removeMenuItem(env, '1', 'Pasta'), { removed: false });
  await addMenuItem(env, '1', 'Pasta', 'lunch_dinner', '2026-11-12T00:00:00.000Z');
  assert.deepEqual(await removeMenuItem(env, '1', 'Pasta'), { removed: true });
  assert.deepEqual(await listMenu(env, '1'), []);
});

test('listMenu orders items by name', async (t) => {
  const env = await freshEnv(t);
  await addMenuItem(env, '1', 'Zucchini Bake', 'lunch_dinner', '2026-11-12T00:00:00.000Z');
  await addMenuItem(env, '1', 'Apple Crumble', 'breakfast', '2026-11-12T00:01:00.000Z');
  assert.deepEqual(await listMenu(env, '1'), ['Apple Crumble', 'Zucchini Bake']);
});

test('listMenu filters by category when one is given', async (t) => {
  const env = await freshEnv(t);
  await addMenuItem(env, '1', 'Poha', 'breakfast', '2026-11-12T00:00:00.000Z');
  await addMenuItem(env, '1', 'Pasta', 'lunch_dinner', '2026-11-12T00:01:00.000Z');
  await addMenuItem(env, '1', 'Sooji Toast', 'breakfast', '2026-11-12T00:02:00.000Z');

  assert.deepEqual(await listMenu(env, '1', 'breakfast'), ['Poha', 'Sooji Toast']);
  assert.deepEqual(await listMenu(env, '1', 'lunch_dinner'), ['Pasta']);
  assert.deepEqual(await listMenu(env, '1'), ['Pasta', 'Poha', 'Sooji Toast']);
});
