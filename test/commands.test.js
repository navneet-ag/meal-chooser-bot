import test from 'node:test';
import assert from 'node:assert';
import { handle, LIMITS } from '../src/commands.js';

function msg(text) {
  return { text, chatId: 1, updateId: 1 };
}

function ctx() {
  return {
    config: { defaultParticipants: ['Person 1', 'Person 2'], defaultSessionLength: 21 },
    nowMs: 0,
    nowIso: '2026-11-12T00:00:00.000Z',
    random: () => 0.1,
  };
}

test('/setup requires 2-10 names', () => {
  const r1 = handle({roster:null, session:null}, msg('/setup'), ctx());
  assert.match(r1.effects[0].text, /Usage: \/setup/);
  const r2 = handle({roster:null, session:null}, msg('/setup Solo'), ctx());
  assert.match(r2.effects[0].text, /between 2 and 10/);
});

test('/setup updates the roster and defers mid-session changes', () => {
  let state = handle({roster:null, session:null}, msg('/setup Anshika, Partner'), ctx()).state;
  state = handle(state, msg('/newsession 4'), ctx()).state;
  const result = handle(state, msg('/setup A, B, C'), ctx());
  assert.deepEqual(state.roster.names, ['Anshika', 'Partner']); // unchanged by the call above until reassigned
  assert.match(result.effects[0].text, /next session/);
  assert.deepEqual(result.state.roster.names, ['A', 'B', 'C']);
  assert.equal(result.state.session.participants.length, 2); // active session untouched
});

test('/newsession without an arg uses the roster default', () => {
  const result = handle({roster:{names:['A','B'], defaultN:21}, session:null}, msg('/newsession'), ctx());
  assert.equal(result.state.session.n, 21);
});

test('/newsession rejects n smaller than the participant count', () => {
  const result = handle({roster:{names:['A','B','C'], defaultN:21}, session:null}, msg('/newsession 2'), ctx());
  assert.match(result.effects[0].text, /at least 3/);
});

test('/status with no active session', () => {
  const result = handle({roster:null, session:null}, msg('/status'), ctx());
  assert.match(result.effects[0].text, /No active session/);
});

test('unknown command falls back to help pointer', () => {
  const result = handle({roster:null, session:null}, msg('/nonsense'), ctx());
  assert.match(result.effects[0].text, /\/help/);
});
