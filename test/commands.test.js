import test from 'node:test';
import assert from 'node:assert';
import { handle, LIMITS } from '../src/commands.js';

function msg(text) {
  return { text, chatId: 1, updateId: 1 };
}

function ctx(overrides = {}) {
  return {
    config: {
      defaultParticipants: ['Person 1', 'Person 2'],
      defaultSessionLength: 21,
      timezone: 'Asia/Kolkata',
    },
    nowMs: 0,
    nowIso: '2026-11-12T00:00:00.000Z',
    random: () => 0.1,
    ...overrides,
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

test('/draw auto-starts a session when none is active and logs the draw', () => {
  const result = handle({roster:{names:['A','B'], defaultN:4}, session:null}, msg('/draw'), ctx());
  const logEffect = result.effects.find(e => e.type === 'log');
  assert.equal(logEffect.entry.method, 'auto');
  assert.equal(logEffect.entry.mealNumber, 1);
  assert.equal(result.state.session.mealsLogged, 1);
});

test('/draw completing a session auto-rolls into the next one', () => {
  let state = {roster:{names:['A','B'], defaultN:2}, session:null};
  state = handle(state, msg('/draw'), ctx()).state;
  const result = handle(state, msg('/draw'), ctx());
  assert.equal(result.state.session.sessionIndex, 2);
  assert.equal(result.state.session.mealsLogged, 0);
  assert.match(result.effects.find(e => e.type === 'send').text, /new session/i);
});

test('/log applies a manual entry and allows negative remaining with a note', () => {
  let state = handle({roster:{names:['A','B'], defaultN:4}, session:null}, msg('/newsession 6'), ctx()).state;
  for (let i = 0; i < 4; i++) state = handle(state, msg('/log A'), ctx()).state; // overshoot A's quota of 2
  const participantA = state.session.participants.find(p => p.name === 'A');
  assert.ok(participantA.remaining < 0);
});

test('/log on an unmatched name errors without mutating state', () => {
  const state = handle({roster:{names:['A','B'], defaultN:4}, session:null}, msg('/newsession'), ctx()).state;
  const result = handle(state, msg('/log Nobody'), ctx());
  assert.match(result.effects[0].text, /No participant named/);
  assert.equal(result.state.session.mealsLogged, 0);
});

test('/audit with an active session emits an audit effect for the shell to fulfill', () => {
  const state = handle({roster:{names:['A','B'], defaultN:4}, session:null}, msg('/newsession'), ctx()).state;
  const result = handle(state, msg('/audit'), ctx());
  assert.deepEqual(result.effects[0], {type:'audit', sessionIndex: state.session.sessionIndex});
});

test('/history emits a history_summary effect regardless of roster/session state', () => {
  const result = handle({roster:null, session:null}, msg('/history'), ctx());
  assert.deepEqual(result.effects, [{type:'history_summary'}]);
});

test('auto-rolled session picks up a roster change made mid-session', () => {
  let state = handle({roster:{names:['A','B'], defaultN:2}, session:null}, msg('/newsession 2'), ctx()).state;
  state = handle(state, msg('/draw'), ctx()).state; // mealsLogged=1, session 1 still active with A,B
  state = handle(state, msg('/setup C, D'), ctx()).state; // roster updated; current session (A,B) untouched
  const result = handle(state, msg('/draw'), ctx()); // completes session 1, auto-rolls to session 2
  assert.equal(result.state.session.sessionIndex, 2);
  assert.deepEqual(result.state.session.participants.map(p => p.name), ['C', 'D']);
});

test('/ate logs a standalone food diary entry with a pre-baked confirmation', () => {
  // ctx()'s default nowIso (2026-11-12T00:00:00.000Z) is 05:30 local in
  // Asia/Kolkata (UTC+5:30) -- within the 4-11 breakfast window.
  const result = handle({roster:null, session:null}, msg('/ate Pasta'), ctx());
  assert.deepEqual(result.effects.find(e => e.type === 'food_log').entry, {dish:'Pasta', mealType:'breakfast'});
  assert.match(result.effects.find(e => e.type === 'send').text, /Logged: Pasta \(breakfast\)/);
});

test('/ate tags lunch and dinner correctly from local time of day', () => {
  // 2026-11-12T07:00:00.000Z = 12:30 IST -> lunch (11-16).
  const lunch = handle({roster:null, session:null}, msg('/ate Dal'), ctx({nowIso:'2026-11-12T07:00:00.000Z'}));
  assert.equal(lunch.effects.find(e => e.type === 'food_log').entry.mealType, 'lunch');

  // 2026-11-12T14:00:00.000Z = 19:30 IST -> dinner (16-24).
  const dinner = handle({roster:null, session:null}, msg('/ate Khichdi'), ctx({nowIso:'2026-11-12T14:00:00.000Z'}));
  assert.equal(dinner.effects.find(e => e.type === 'food_log').entry.mealType, 'dinner');

  // 2026-11-12T20:00:00.000Z = 01:30 IST (next day) -> dinner (0-4 wraps in).
  const lateNight = handle({roster:null, session:null}, msg('/ate Chai'), ctx({nowIso:'2026-11-12T20:00:00.000Z'}));
  assert.equal(lateNight.effects.find(e => e.type === 'food_log').entry.mealType, 'dinner');
});

test('/ate rejects an empty dish without requiring a roster', () => {
  const result = handle({roster:null, session:null}, msg('/ate'), ctx());
  assert.match(result.effects[0].text, /Usage: \/ate/);
});

test('/ate rejects a dish name over the length limit', () => {
  const result = handle({roster:null, session:null}, msg('/ate ' + 'x'.repeat(100)), ctx());
  assert.match(result.effects[0].text, /characters or fewer/);
});

test('/food with no arg emits a food_history effect with the default limit', () => {
  const result = handle({roster:null, session:null}, msg('/food'), ctx());
  assert.deepEqual(result.effects[0], {type:'food_history', limit: LIMITS.foodHistoryDefault});
});

test('/food caps an oversized limit argument', () => {
  const result = handle({roster:null, session:null}, msg('/food 500'), ctx());
  assert.deepEqual(result.effects[0], {type:'food_history', limit: LIMITS.foodHistoryMax});
});

test('/menu with no args emits a menu_list effect with no category filter', () => {
  const result = handle({roster:null, session:null}, msg('/menu'), ctx());
  assert.deepEqual(result.effects[0], {type:'menu_list'});
});

test('/menu breakfast and /menu lunch/dinner emit category-filtered menu_list effects', () => {
  const breakfast = handle({roster:null, session:null}, msg('/menu breakfast'), ctx());
  assert.deepEqual(breakfast.effects[0], {type:'menu_list', category:'breakfast'});

  const lunch = handle({roster:null, session:null}, msg('/menu lunch'), ctx());
  assert.deepEqual(lunch.effects[0], {type:'menu_list', category:'lunch_dinner'});

  const dinner = handle({roster:null, session:null}, msg('/menu dinner'), ctx());
  assert.deepEqual(dinner.effects[0], {type:'menu_list', category:'lunch_dinner'});
});

test('/menu add requires a leading breakfast|lunch|dinner category', () => {
  const result = handle({roster:null, session:null}, msg('/menu add Pasta'), ctx());
  assert.match(result.effects[0].text, /Usage: \/menu/);
});

test('/menu add emits a category-tagged menu_add effect with no pre-baked reply', () => {
  const breakfast = handle({roster:null, session:null}, msg('/menu add breakfast Poha'), ctx());
  assert.deepEqual(breakfast.effects, [{type:'menu_add', name:'Poha', category:'breakfast'}]);

  const lunch = handle({roster:null, session:null}, msg('/menu add lunch Arhar Dal Tadka + Rice'), ctx());
  assert.deepEqual(lunch.effects, [{type:'menu_add', name:'Arhar Dal Tadka + Rice', category:'lunch_dinner'}]);

  const dinner = handle({roster:null, session:null}, msg('/menu add dinner Kadhi + Rice'), ctx());
  assert.deepEqual(dinner.effects, [{type:'menu_add', name:'Kadhi + Rice', category:'lunch_dinner'}]);
});

test('/menu remove emits a menu_remove effect with no pre-baked reply', () => {
  const result = handle({roster:null, session:null}, msg('/menu remove Pasta'), ctx());
  assert.deepEqual(result.effects, [{type:'menu_remove', name:'Pasta'}]);
});

test('/menu add rejects a dish name over the length limit', () => {
  const result = handle({roster:null, session:null}, msg('/menu add breakfast ' + 'x'.repeat(100)), ctx());
  assert.match(result.effects[0].text, /characters or fewer/);
});
