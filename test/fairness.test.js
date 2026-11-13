import test from 'node:test';
import assert from 'node:assert';
import { distributeQuotas, computeProbabilities, startSession, pickWinner, drawNext, isSessionComplete } from '../src/fairness.js';

test('distributeQuotas splits evenly when n is divisible by k', () => {
  const q = distributeQuotas(10, ['A', 'B'], () => 0.1);
  assert.deepEqual(q, [{name:'A', quota:5}, {name:'B', quota:5}]);
});

test('distributeQuotas sums to n with 3 participants and a remainder', () => {
  const q = distributeQuotas(10, ['A', 'B', 'C'], () => 0.1);
  assert.equal(q.reduce((s, x) => s + x.quota, 0), 10);
  assert.ok(q.every(x => x.quota === 3 || x.quota === 4));
  assert.equal(q.filter(x => x.quota === 4).length, 1); // 10 mod 3 = 1
});

test('distributeQuotas remainder assignment depends on randomFn, not always the first name', () => {
  const lowRandom = distributeQuotas(10, ['A', 'B', 'C'], () => 0.01);
  const highRandom = distributeQuotas(10, ['A', 'B', 'C'], () => 0.99);
  const extraLow = lowRandom.find(x => x.quota === 4).name;
  const extraHigh = highRandom.find(x => x.quota === 4).name;
  assert.notEqual(extraLow, extraHigh);
});

test('computeProbabilities matches remaining ratios and sums to 1', () => {
  const p = computeProbabilities([{name:'A', remaining:3}, {name:'B', remaining:1}]);
  assert.equal(p.find(x => x.name === 'A').p, 0.75);
  assert.equal(p.find(x => x.name === 'B').p, 0.25);
});

test('computeProbabilities throws when all remaining are zero', () => {
  assert.throws(() => computeProbabilities([{name:'A', remaining:0}, {name:'B', remaining:0}]));
});

test('pickWinner picks by cumulative probability boundary', () => {
  const participants = [{name:'A', remaining:3}, {name:'B', remaining:1}]; // P(A)=0.75
  assert.equal(pickWinner(participants, 0.5).name, 'A');
  assert.equal(pickWinner(participants, 0.8).name, 'B');
});

test('pickWinner reports forced when only one participant has remaining', () => {
  const participants = [{name:'A', remaining:0}, {name:'B', remaining:2}];
  const result = pickWinner(participants, 0.9);
  assert.equal(result.name, 'B');
  assert.equal(result.p, 1);
  assert.equal(result.forced, true);
});

test('drawNext decrements the winner and advances mealsLogged', () => {
  const session = startSession(4, ['A', 'B'], () => 0.1, '2026-11-12T00:00:00.000Z', 1);
  const { winner, mealNumber } = drawNext(session, () => 0.1); // P(A)=0.5 at start, r=0.1 -> A
  assert.equal(winner.name, 'A');
  assert.equal(mealNumber, 1);
  assert.equal(session.mealsLogged, 1);
  assert.equal(session.participants.find(p => p.name === 'A').remaining, 1);
});

test('a full session ends with totals exactly equal to quotas (10 meals, 3 people)', () => {
  const session = startSession(10, ['A', 'B', 'C'], () => 0.1, '2026-11-12T00:00:00.000Z', 1);
  const quotas = Object.fromEntries(session.participants.map(p => [p.name, p.quota]));
  const totals = { A: 0, B: 0, C: 0 };
  const draws = [0.9, 0.1, 0.5, 0.99, 0.01, 0.4, 0.6, 0.2, 0.8, 0.3];
  let i = 0;
  while (!isSessionComplete(session)) {
    totals[drawNext(session, () => draws[i++]).winner.name]++;
  }
  assert.deepEqual(totals, quotas);
  assert.equal(i, 10);
});
