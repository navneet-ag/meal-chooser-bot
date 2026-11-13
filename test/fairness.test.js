import test from 'node:test';
import assert from 'node:assert';
import { distributeQuotas, computeProbabilities } from '../src/fairness.js';

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
