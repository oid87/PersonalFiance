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
  const src = { obs: [{ date: 'a', noObs: 3, tw50: 5 }, { date: 'b', noObs: 2, tw50: 2 }], br: [{ date: 'a', p20: 10 }, { date: 'b', p20: null }] };
  assert.deepEqual(N.indicator('obs', src).map(r => r.hit), [true, false]);
  assert.deepEqual(N.indicator('obs50', src).map(r => r.hit), [false, true]);
  assert.deepEqual(N.indicator('b20', src).map(r => r.hit), [true, false]);
});

test('episodes start on first hit and need 20 quiet days to reset', () => {
  const br = Array.from({ length: 60 }, (_, i) => ({ date: 'd' + String(i).padStart(2, '0'), p20: [5, 30, 8].includes(i) || i === 40 ? 5 : 50 }));
  const px = br.map((r, i) => ({ date: r.date, close: 100 + i }));
  const e = N.episodesFor('b20', { br }, px, null);
  assert.deepEqual(e.map(x => x.date), ['d05', 'd30']);
});
