import test from 'node:test';
import assert from 'node:assert';
import worker from '../src/index.js';
import { freshEnv } from './helpers.js';
import { getActiveSession, readFoodLog, listMenu, hasProcessed } from '../src/db.js';

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
  assert.equal(await getActiveSession(env, '1'), null); // /ate never touches sessions
});

test('/menu add twice reports already-added the second time', async (t) => {
  const env = await bindings(t);
  const sent = stubTelegram(t);
  await worker.fetch(validRequest({ chatId: '1', text: '/menu add Pasta', updateId: '1' }), env);
  sent.length = 0;
  await worker.fetch(validRequest({ chatId: '1', text: '/menu add Pasta', updateId: '2' }), env);
  assert.match(sent[0].text, /already on the menu/);
  assert.deepEqual(await listMenu(env, '1'), ['Pasta']); // not duplicated
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
