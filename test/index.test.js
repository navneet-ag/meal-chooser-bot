import test from 'node:test';
import assert from 'node:assert';
import worker from '../src/index.js';
import { freshEnv } from './helpers.js';
import { getActiveSession, readFoodLog, listMenu, hasProcessed, readSessionLog } from '../src/db.js';

const SECRET = 'test-secret';

function makeRequest({ method = 'POST', headers = {}, body } = {}) {
  const init = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request('https://example.com/webhook', init);
}

function validRequest({ chatId = '1', text, updateId = '1', secret = SECRET } = {}) {
  return makeRequest({
    headers: { 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: {
      update_id: Number(updateId),
      message: { chat: { id: Number(chatId) }, text },
    },
  });
}

// Mirrors the monkeypatch pattern test/telegram.test.js already uses:
// sendMessage calls the real global fetch, so stubbing it here captures
// every outbound Telegram call without a second mocking mechanism.
function stubTelegram(t) {
  const sent = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
  };
  t.after(() => {
    global.fetch = originalFetch;
  });
  return sent;
}

async function bindings(t, extra = {}) {
  return freshEnv(t, {
    AUTHORIZED_CHAT_ID: '1',
    BOT_TOKEN: 'tok',
    WEBHOOK_SECRET: SECRET,
    ...extra,
  });
}

test('GET (non-POST) requests return a simple running message', async (t) => {
  const env = await bindings(t);
  const res = await worker.fetch(makeRequest({ method: 'GET' }), env);
  assert.equal(await res.text(), 'Meal chooser bot is running.');
});

test('rejects a request with a missing or wrong secret header, touching no D1 state', async (t) => {
  const env = await bindings(t);
  stubTelegram(t);

  const res1 = await worker.fetch(
    makeRequest({ body: { update_id: 1, message: { chat: { id: 1 }, text: '/draw' } } }),
    env
  );
  assert.equal(await res1.text(), 'IGNORED');
  assert.equal(await hasProcessed(env, '1', 1), false);

  const res2 = await worker.fetch(validRequest({ secret: 'wrong', text: '/draw' }), env);
  assert.equal(await res2.text(), 'IGNORED');
  assert.equal(await hasProcessed(env, '1', '1'), false);
  assert.equal(await getActiveSession(env, '1'), null);
});

test('rejects a request with a malformed JSON body', async (t) => {
  const env = await bindings(t);
  const res = await worker.fetch(
    makeRequest({ headers: { 'X-Telegram-Bot-Api-Secret-Token': SECRET }, body: undefined }),
    env
  );
  assert.equal(await res.text(), 'IGNORED');
});

test('rejects an update missing required fields (no text)', async (t) => {
  const env = await bindings(t);
  const res = await worker.fetch(
    makeRequest({
      headers: { 'X-Telegram-Bot-Api-Secret-Token': SECRET },
      body: { update_id: 1, message: { chat: { id: 1 } } },
    }),
    env
  );
  assert.equal(await res.text(), 'IGNORED');
});

test('rejects an update from an unconfigured chat id, touching no D1 state for it', async (t) => {
  const env = await bindings(t);
  stubTelegram(t);
  const res = await worker.fetch(validRequest({ chatId: '999', text: '/draw' }), env);
  assert.equal(await res.text(), 'IGNORED');
  assert.equal(await getActiveSession(env, '999'), null);
  assert.equal(await hasProcessed(env, '999', '1'), false);
});

test('duplicate update_id is processed once', async (t) => {
  const env = await bindings(t);
  stubTelegram(t);
  const req = () => validRequest({ chatId: '1', text: '/draw', updateId: '5' });
  await worker.fetch(req(), env);
  await worker.fetch(req(), env);
  const session = await getActiveSession(env, '1');
  assert.equal(session.mealsLogged, 1);
});

test('a full 10-meal, 3-participant session ends exactly on quota and audit reflects only the current session', async (t) => {
  const env = await bindings(t);
  const sent = stubTelegram(t);

  await worker.fetch(validRequest({ chatId: '1', text: '/setup Anshika, Partner, Guest', updateId: '1' }), env);
  await worker.fetch(validRequest({ chatId: '1', text: '/newsession 10', updateId: '2' }), env);
  for (let i = 0; i < 10; i++) {
    await worker.fetch(validRequest({ chatId: '1', text: '/draw', updateId: String(10 + i) }), env);
  }

  const session2 = await getActiveSession(env, '1'); // auto-rolled
  assert.equal(session2.sessionIndex, 2);
  assert.equal(session2.mealsLogged, 0);
  assert.equal(session2.n, 10);
  assert.equal(session2.participants.length, 3);

  sent.length = 0;
  await worker.fetch(validRequest({ chatId: '1', text: '/audit', updateId: '100' }), env);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'No picks logged yet.'); // session 2, not session 1's 10 rows
});

test('/ate and /food work with no setup/session ever run', async (t) => {
  const env = await bindings(t);
  stubTelegram(t);
  await worker.fetch(validRequest({ chatId: '1', text: '/ate Pasta', updateId: '1' }), env);
  const rows = await readFoodLog(env, '1', 10);
  assert.equal(rows[0].dish, 'Pasta');
  // The real wall clock (not injectable here) decides which of the three
  // buckets this lands in; the exact boundary math is pinned deterministically
  // in commands.test.js. This just proves the value makes it through end to end.
  assert.ok(['breakfast', 'lunch', 'dinner'].includes(rows[0].mealType));
  assert.equal(await getActiveSession(env, '1'), null); // /ate never touches sessions
});

test('/history summarizes every session oldest-first, marking only the latest in progress', async (t) => {
  const env = await bindings(t);
  const sent = stubTelegram(t);

  await worker.fetch(validRequest({ chatId: '1', text: '/setup A, B', updateId: '1' }), env);
  await worker.fetch(validRequest({ chatId: '1', text: '/newsession 2', updateId: '2' }), env);
  await worker.fetch(validRequest({ chatId: '1', text: '/draw', updateId: '3' }), env);
  await worker.fetch(validRequest({ chatId: '1', text: '/draw', updateId: '4' }), env); // completes session 1 (n=2, k=2 -> exactly A 1, B 1), auto-rolls to session 2
  await worker.fetch(validRequest({ chatId: '1', text: '/draw', updateId: '5' }), env); // one pick into session 2, which also carries n=2 forward -- still incomplete

  sent.length = 0;
  await worker.fetch(validRequest({ chatId: '1', text: '/history', updateId: '6' }), env);

  const text = sent[0].text;
  // Session 1 is fully determined regardless of who won which draw: with
  // n=2 and 2 participants, the exact-balance guarantee means both totals
  // are exactly 1 -- only the (alphabetical) name order could vary, and it
  // can't here since the roster is already alphabetical (A, B).
  assert.match(text, /Session 1 \(n=2\): A 1, B 1(\n|$)/);
  // Session 2's single draw could have gone to either participant.
  assert.match(text, /Session 2 \(n=2\): [AB] 1 \(in progress\)/);
});

test('/menu add twice reports already-added the second time', async (t) => {
  const env = await bindings(t);
  const sent = stubTelegram(t);
  await worker.fetch(validRequest({ chatId: '1', text: '/menu add lunch Pasta', updateId: '1' }), env);
  sent.length = 0;
  await worker.fetch(validRequest({ chatId: '1', text: '/menu add lunch Pasta', updateId: '2' }), env);
  assert.match(sent[0].text, /already on the menu/);
  assert.deepEqual(await listMenu(env, '1'), ['Pasta']); // not duplicated
});

test('/menu breakfast and /menu lunch only show items added to that category', async (t) => {
  const env = await bindings(t);
  const sent = stubTelegram(t);
  await worker.fetch(validRequest({ chatId: '1', text: '/menu add breakfast Poha', updateId: '1' }), env);
  await worker.fetch(validRequest({ chatId: '1', text: '/menu add lunch Pasta', updateId: '2' }), env);

  sent.length = 0;
  await worker.fetch(validRequest({ chatId: '1', text: '/menu breakfast', updateId: '3' }), env);
  assert.equal(sent[0].text, 'Poha');

  sent.length = 0;
  await worker.fetch(validRequest({ chatId: '1', text: '/menu dinner', updateId: '4' }), env); // "dinner" is a synonym for the same lunch_dinner bucket as "lunch"
  assert.equal(sent[0].text, 'Pasta');

  sent.length = 0;
  await worker.fetch(validRequest({ chatId: '1', text: '/menu', updateId: '5' }), env);
  assert.equal(sent[0].text, 'Pasta\nPoha');
});

test('/draw with no setup ever run auto-starts a session using config defaults', async (t) => {
  const env = await bindings(t);
  stubTelegram(t);
  await worker.fetch(validRequest({ chatId: '1', text: '/draw', updateId: '1' }), env);
  const session = await getActiveSession(env, '1');
  assert.equal(session.mealsLogged, 1);
  assert.equal(session.n, 21); // design doc default session length
  assert.equal(session.participants.length, 2); // design doc default participant count
});

// Regression for Fix 1: a bare /draw against a fresh chat (no /newsession
// ever run) auto-starts a session via index.js's auto-start path. Before
// Fix 1, that path double-decremented the winner's `remaining` (once via
// createSession persisting the already-decremented in-memory session, once
// again via recordDraw's relative decrement), breaking this invariant on
// the very first draw.
test('a bare /draw auto-start keeps sum(remaining) === n - mealsLogged for the persisted session', async (t) => {
  const env = await bindings(t);
  stubTelegram(t);
  await worker.fetch(validRequest({ chatId: '1', text: '/draw', updateId: '1' }), env);
  const session = await getActiveSession(env, '1');
  const sumRemaining = session.participants.reduce((s, p) => s + p.remaining, 0);
  assert.equal(sumRemaining, session.n - session.mealsLogged);
});

// Regression for Fix 1: drive a complete session that was started by /draw
// itself (never /newsession) -- the exact scenario the critical bug broke,
// and which the pre-existing full-session test above did NOT catch because
// it calls /newsession first. Confirms the session completes (auto-rolls)
// and that each participant's persisted total in meal_log matches their
// quota exactly.
test('a full session auto-started by /draw alone (never /newsession) completes with totals matching quotas exactly', async (t) => {
  const env = await bindings(t);
  stubTelegram(t);

  await worker.fetch(validRequest({ chatId: '1', text: '/setup Anshika, Partner, Guest', updateId: '1' }), env);

  await worker.fetch(validRequest({ chatId: '1', text: '/draw', updateId: '2' }), env);
  const firstSession = await getActiveSession(env, '1'); // auto-started by /draw itself, not /newsession
  const quotas = Object.fromEntries(firstSession.participants.map((p) => [p.name, p.quota]));
  const n = firstSession.n;

  for (let i = 1; i < n; i++) {
    await worker.fetch(validRequest({ chatId: '1', text: '/draw', updateId: String(10 + i) }), env);
  }

  const rolledSession = await getActiveSession(env, '1');
  assert.equal(rolledSession.sessionIndex, 2); // confirms the session completed and auto-rolled
  assert.equal(rolledSession.mealsLogged, 0);

  const log = await readSessionLog(env, firstSession.id);
  assert.equal(log.length, n);
  const totals = { Anshika: 0, Partner: 0, Guest: 0 };
  for (const row of log) totals[row.name]++;
  assert.deepEqual(totals, quotas);
});

// Regression for the project's second headline guarantee (independence of
// /draw from the menu), currently untested anywhere: seeding /menu add with
// dishes and running a full session must never leak those dish names into
// any outbound Telegram message, proving /draw genuinely never reads
// menu_items.
test('menu dish names never appear in outbound messages during a full /draw session', async (t) => {
  const env = await bindings(t);
  const sent = stubTelegram(t);

  const dishes = ['Zzyzx Casserole', 'Qwirkle Soup', 'Plimsoll Pie'];
  for (let i = 0; i < dishes.length; i++) {
    await worker.fetch(validRequest({ chatId: '1', text: `/menu add lunch ${dishes[i]}`, updateId: String(i) }), env);
  }
  sent.length = 0;

  await worker.fetch(validRequest({ chatId: '1', text: '/setup Anshika, Partner', updateId: '100' }), env);
  await worker.fetch(validRequest({ chatId: '1', text: '/newsession 4', updateId: '101' }), env);
  for (let i = 0; i < 4; i++) {
    await worker.fetch(validRequest({ chatId: '1', text: '/draw', updateId: String(200 + i) }), env);
  }

  for (const m of sent) {
    for (const dish of dishes) {
      assert.ok(!m.text.includes(dish), `outbound message unexpectedly mentions menu dish "${dish}": ${m.text}`);
    }
  }
});
