import test from 'node:test';
import assert from 'node:assert';
import { sendMessage } from '../src/telegram.js';

test('sendMessage posts the chat id and text', async () => {
  let captured;
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => { captured = {url, init}; return {ok:true, status:200, json: async () => ({ok:true, result:{}})}; };
  await sendMessage({BOT_TOKEN:'t'}, 42, 'hello');
  assert.match(captured.url, /\/bott\/sendMessage$/);
  assert.deepEqual(JSON.parse(captured.init.body), {chat_id:42, text:'hello'});
  global.fetch = originalFetch;
});

test('sendMessage throws with the token redacted on failure', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ok:false, status:401, json: async () => ({ok:false, description:'bad token-secret'})});
  await assert.rejects(() => sendMessage({BOT_TOKEN:'token-secret'}, 42, 'hi'), /\[REDACTED\]/);
  global.fetch = originalFetch;
});
