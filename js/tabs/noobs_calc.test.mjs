import test from 'node:test';
import assert from 'node:assert/strict';
import * as N from './noobs_calc.mjs';


test('startDate goes back 10 years', () => {
  assert.equal(N.startDate('2026-11-06'), '2016-11-06');
});

test('baseline counts every start with a full horizon', () => {
  const p = Array.from({ length: 200 }, (_, i) => ({ date: 'd' + String(i).padStart(3, '0'), close: 100 }));
  const b = N.baseline(p, null);
  assert.equal(b[20].n, 180);
  assert.equal(b[120].n, 80);
  assert.equal(b[60].median, 0);
});

test('verdict compares 60/120 medians with 1pp margin', () => {
  const mk = (a, b, n = 6) => ({ 20: { n, median: 0 }, 60: { n, median: a }, 120: { n, median: b } });
  const base = mk(0.04, 0.07, 100);
  assert.equal(N.verdict(mk(0.10, 0.12), base).level, 'better');
  assert.equal(N.verdict(mk(0.0, 0.02), base).level, 'worse');
  assert.equal(N.verdict(mk(0.05, 0.06), base).level, 'same');
  assert.equal(N.verdict(mk(0.10, 0.12, 3), base).few, true);
});

test('indicator thresholds follow direction', () => {
  const tw = [{ date: 'a', noObs: 3, tw50: 5 }, { date: 'b', noObs: 2, tw50: 2 }];
  assert.deepEqual(N.indicator('tw', tw, []).map(r => r.hit), [true, false]);
  assert.deepEqual(N.indicator('tw50', tw, []).map(r => r.hit), [false, true]);
  assert.deepEqual(N.indicator('qqq', [], [{ date: 'a', qqq_rate: 4 }, { date: 'b', qqq_rate: null }]).map(r => r.hit), [true, false]);
});
