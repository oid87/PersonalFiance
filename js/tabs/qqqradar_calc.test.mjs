import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AXIS_KEYS, bucketOf, compositeScore, forwardOutcomes, pointInTimeRates, bucketTable,
  alignField, vxnScore, breadthRaw,
} from './qqqradar_calc.mjs';

function makeDates(n, start = '2020-01-01') {
  const out = [];
  const d = new Date(start + 'T00:00:00Z');
  for (let i = 0; i < n; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

test('bucketOf: fixed 20-point buckets, 100 falls in the top bucket, null stays null', () => {
  assert.equal(bucketOf(0), 0);
  assert.equal(bucketOf(19.99), 0);
  assert.equal(bucketOf(20), 1);
  assert.equal(bucketOf(79.9), 3);
  assert.equal(bucketOf(80), 4);
  assert.equal(bucketOf(100), 4);
  assert.equal(bucketOf(null), null);
});

test('compositeScore: equal-weight mean only when all six axes are present', () => {
  const axes = Object.fromEntries(AXIS_KEYS.map((k, i) => [k, [10 * (i + 1), i === 2 ? null : 50]]));
  const out = compositeScore(axes, 2);
  assert.equal(out[0], 35); // (10+20+...+60)/6
  assert.equal(out[1], null);
});

test('forwardOutcomes: uses intraday high/low over i+1..i+h against close_i; tail has no outcome', () => {
  const rows = [
    { date: 'a', close: 100, high: 100, low: 100 },
    { date: 'b', close: 101, high: 103.5, low: 99 },
    { date: 'c', close: 99, high: 100, low: 96.5 },
    { date: 'd', close: 100, high: 100, low: 100 },
  ];
  const { up, down } = forwardOutcomes(rows, 2, 0.03);
  assert.deepEqual(up, [1, 0, null, null]); // day0: 103.5/100 ≥ +3%；day1: max 100/101
  assert.deepEqual(down, [1, 1, null, null]); // day0: 96.5/100 = −3.5%；day1: 96.5/101 = −4.5%
});

test('forwardOutcomes: day1 down move measured from its own close', () => {
  const rows = [
    { date: 'a', close: 100, high: 100, low: 100 },
    { date: 'b', close: 100, high: 100, low: 100 },
    { date: 'c', close: 100, high: 100, low: 96 },
    { date: 'd', close: 100, high: 100, low: 100 },
  ];
  const { down } = forwardOutcomes(rows, 2, 0.03);
  assert.deepEqual(down, [1, 1, null, null]);
});

test('pointInTimeRates: day t only counts samples whose window ended by t (no look-ahead)', () => {
  const n = 80;
  const composite = new Array(n).fill(50);
  const up = new Array(n).fill(0);
  const down = new Array(n).fill(0);
  for (let i = 0; i < 40; i++) up[i] = 1;
  const rates = pointInTimeRates(composite, { up, down }, 5, { minSamples: 30 });
  // t=34 → samples j=0..29 (30 samples) → first non-null rate
  assert.equal(rates.upRate[33], null);
  assert.equal(rates.upRate[34], 100);
  assert.equal(rates.samples[34], 30);

  // Mutating outcomes at j ≥ t−horizon+1 must not change rate at t.
  const up2 = up.slice();
  for (let j = 50; j < n; j++) up2[j] = 1;
  const rates2 = pointInTimeRates(composite, { up: up2, down }, 5, { minSamples: 30 });
  for (let t = 0; t <= 54; t++) assert.equal(rates2.upRate[t], rates.upRate[t], `t=${t}`);
  assert.notEqual(rates2.upRate[60], rates.upRate[60]);
});

test('bucketTable: excludes rows without completed outcome and computes base rate', () => {
  const composite = [10, 30, 30, 90, 90];
  const outcomes = { up: [1, 0, 1, 0, null], down: [0, 1, 1, 0, null] };
  const { buckets, base } = bucketTable(composite, outcomes);
  assert.equal(base.n, 4);
  assert.equal(base.upRate, 50);
  assert.equal(buckets[1].n, 2);
  assert.equal(buckets[1].upRate, 50);
  assert.equal(buckets[1].downRate, 100);
  assert.equal(buckets[4].n, 1);
  assert.equal(buckets[2].upRate, null);
});

test('alignField: forward-fills within staleDays only', () => {
  const dates = makeDates(12);
  const src = [{ date: dates[0], v: 1 }, { date: dates[1], v: 2 }];
  const out = alignField(dates, src, r => r.v, 7);
  assert.equal(out[0], 1);
  assert.equal(out[8], 2);
  assert.equal(out[9], null);
});

test('vxnScore inverts the percentile (higher VXN → lower score); breadth passes through', () => {
  const dates = makeDates(10);
  const vxn = dates.map((date, i) => ({ date, close: i < 9 ? 20 + i : 5 }));
  const s = vxnScore(dates, vxn, { win: 20, minObs: 5 });
  assert.equal(s[3], null);
  assert.ok(s[8] < 20); // new high → low score
  assert.equal(s[9], 100); // new low → percentile 0 → score 100
  const b = breadthRaw(dates, dates.map(date => ({ date, above20_pct: 42.5 })));
  assert.equal(b[5], 42.5);
});

test('short interest is only usable after the FINRA publication lag', async () => {
  const { addBusinessDays, shiftToPublication, buildQqqAxes } = await import('./qqqradar_calc.mjs');
  assert.equal(addBusinessDays('2026-09-15', 8), '2026-09-25'); // Tue → +8 weekdays
  assert.equal(addBusinessDays('2026-09-30', 8), '2026-10-12');
  assert.equal(shiftToPublication([{ date: '2026-09-15', QQQ_dtc: 2 }])[0].date, '2026-09-25');

  // Changing the value of a settlement must not change axes.short before its publication date.
  const dates = makeDates(900, '2022-01-03').filter(d => ![0, 6].includes(new Date(d + 'T00:00:00Z').getUTCDay()));
  const ohlc = dates.map((date, i) => ({ date, close: 100 + i % 7, high: 101 + i % 7, low: 99 + i % 7 }));
  const settle = dates.filter((_, i) => i % 10 === 0).map((date, k) => ({ date, QQQ_dtc: 1 + (k % 5) }));
  const base = { ohlc, svRows: [], pcRows: [], vxnRows: [], breadthRows: [] };
  const a = buildQqqAxes({ ...base, siRows: settle });
  const last = settle.at(-5).date;
  const mutated = settle.map(r => r.date === last ? { ...r, QQQ_dtc: 99 } : r);
  const b = buildQqqAxes({ ...base, siRows: mutated });
  const pub = addBusinessDays(last, 8);
  for (let i = 0; i < dates.length; i++) {
    if (dates[i] < pub) assert.equal(b.axes.short[i], a.axes.short[i], dates[i]);
  }
  assert.ok(dates.includes(pub));
  assert.notEqual(b.axes.short[dates.indexOf(pub)], a.axes.short[dates.indexOf(pub)]);
});

test('bucketOf rejects NaN', () => {
  assert.equal(bucketOf(NaN), null);
});
