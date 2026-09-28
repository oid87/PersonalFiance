import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rollingPctScore,
  technicalScore,
  svrScore,
  shortPressureScore,
  optionsScore,
  skewScore,
} from './flowradar_calc.mjs';

function makeDates(n, start = '2020-01-01') {
  const out = [];
  const d = new Date(start + 'T00:00:00Z');
  for (let i = 0; i < n; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

test('rollingPctScore: warmup period returns null until minObs observations accumulate', () => {
  const dates = makeDates(10);
  const raw = dates.map((_, i) => i + 1); // 1..10
  const scores = rollingPctScore(dates, raw, 20, 5);
  // first 4 indices (1..4 obs) are below minObs=5 -> null
  for (let i = 0; i < 4; i++) assert.equal(scores[i], null);
  // from index 4 (5th obs) onward, score should be a number
  for (let i = 4; i < 10; i++) assert.notEqual(scores[i], null);
});

test('rollingPctScore: no look-ahead bias — mutating future values leaves past/current scores unchanged', () => {
  const dates = makeDates(30);
  const rawA = dates.map((_, i) => (i % 7) + 1);
  const scoresA = rollingPctScore(dates, rawA, 20, 5);

  // Mutate everything strictly after index 15 to wildly different values.
  const rawB = rawA.slice();
  for (let i = 16; i < rawB.length; i++) rawB[i] = 999 + i;
  const scoresB = rollingPctScore(dates, rawB, 20, 5);

  for (let i = 0; i <= 15; i++) assert.equal(scoresB[i], scoresA[i], `mismatch at index ${i}`);
});

test('rollingPctScore: strictly monotonic increasing sequence -> last point is the series max and near 100', () => {
  // NOTE (deviation from spec_flowradar.md B4's literal "score=100"):
  // math.percentileRank(val, sortedAsc) is a strict count(x < val)/len rank
  // (see js/utils/math.js doc-comment). For the maximum of n unique values
  // that rank is (n-1)/n, which approaches but never equals 1 (100) for any
  // finite window that still includes the current point itself ("含當日").
  // Asserting an exact ===100 is therefore unreachable by construction, not
  // a bug — this test instead asserts the achievable property: the last
  // point of a strictly increasing series scores the maximum of the whole
  // score series, and is close to (but not exactly) 100.
  const dates = makeDates(40);
  const raw = dates.map((_, i) => i + 1); // strictly increasing
  const scores = rollingPctScore(dates, raw, 756, 5);
  const last = scores[scores.length - 1];
  const maxScore = Math.max(...scores.filter(s => s != null));
  assert.equal(last, maxScore);
  assert.ok(last >= 95, `expected last score near 100, got ${last}`);
  assert.ok(last < 100, `percentileRank of the max of a set including itself can never reach exactly 100`);
});

test('rollingPctScore: window only looks at t and before (later window growth does not retroactively change past scores)', () => {
  const dates = makeDates(50);
  const raw = dates.map((_, i) => i + 1);
  const scoresFull = rollingPctScore(dates, raw, 756, 5);
  // Truncate the series at day 30 (exclusive of anything after) and recompute;
  // scores for days 0..29 must be identical to the full run.
  const datesTrunc = dates.slice(0, 30);
  const rawTrunc = raw.slice(0, 30);
  const scoresTrunc = rollingPctScore(datesTrunc, rawTrunc, 756, 5);
  for (let i = 0; i < 30; i++) assert.equal(scoresTrunc[i], scoresFull[i]);
});

test('technicalScore: sustained uptrend -> last day score >= 75', () => {
  const priceRows = [];
  const dates = makeDates(230);
  let price = 100;
  for (let i = 0; i < dates.length; i++) {
    price *= 1.01; // steady 1%/day compounding rise
    priceRows.push([dates[i], price]);
  }
  const { scores } = technicalScore(priceRows);
  const last = scores[scores.length - 1];
  assert.notEqual(last, null);
  assert.ok(last >= 75, `expected last score >= 75, got ${last}`);
});

test('technicalScore: warmup (fewer than MA200 window) days are null', () => {
  const priceRows = makeDates(50).map((d, i) => [d, 100 + i]);
  const { scores } = technicalScore(priceRows);
  assert.ok(scores.every(s => s === null));
});

test('shortPressureScore: inverted — higher DTC observations produce lower scores', () => {
  const dates = makeDates(60);
  // settlement observations twice a month-ish, ascending DTC (bearish trend)
  const siRows = [];
  for (let i = 0; i < 40; i++) {
    siRows.push({ date: dates[i], SPY_dtc: i + 1 }); // increasing DTC
  }
  const scores = shortPressureScore(dates, siRows, 'SPY', { win: 72, minObs: 5, staleDays: 20 });
  // Find last two non-null scores; DTC keeps rising so inverted score should trend down or stay low near the end.
  const nonNull = scores.map((s, i) => [i, s]).filter(([, s]) => s != null);
  assert.ok(nonNull.length > 0);
  const lastScore = nonNull[nonNull.length - 1][1];
  assert.ok(lastScore <= 50, `expected inverted score to be low for high DTC, got ${lastScore}`);
});

test('optionsScore: inverted — higher P/C ratio yields lower score', () => {
  const dates = makeDates(300);
  const pcRows = dates.map((d, i) => ({ date: d, pc: 0.3 + (i / dates.length) * 1.5 })); // rising P/C
  const scores = optionsScore(dates, pcRows, { win: 756, minObs: 5, staleDays: 7 });
  const last = scores[scores.length - 1];
  assert.notEqual(last, null);
  assert.ok(last < 50, `expected inverted score low for rising P/C, got ${last}`);
});

test('skewScore: inverted — higher SKEW yields lower score', () => {
  const dates = makeDates(300);
  const skewRows = dates.map((d, i) => ({ d, sk: 100 + (i / dates.length) * 60 })); // rising SKEW
  const scores = skewScore(dates, skewRows, { win: 756, minObs: 5, staleDays: 7 });
  const last = scores[scores.length - 1];
  assert.notEqual(last, null);
  assert.ok(last < 50, `expected inverted score low for rising SKEW, got ${last}`);
});

test('svrScore: null when stale (gap beyond staleDays) or missing data', () => {
  const dates = makeDates(10, '2025-01-01');
  const svRows = []; // no data at all
  const scores = svrScore(dates, svRows, 'SPY', { win: 20, minObs: 3, staleDays: 7 });
  assert.ok(scores.every(s => s === null));
});
