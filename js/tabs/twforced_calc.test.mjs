import test from 'node:test';
import assert from 'node:assert/strict';
import { forcedRangeStats, classifyForcedSell } from './twforced_calc.mjs';

const twii = [['2026-01-02', 100], ['2026-01-05', 95], ['2026-01-06', 90], ['2026-01-07', 85], ['2026-01-08', 80]];
const margin = [['2026-01-02', 1000], ['2026-01-05', 1000], ['2026-01-06', 880], ['2026-01-07', 860], ['2026-01-08', 820]];
const ratio = [['2026-01-02', 180], ['2026-01-07', 150]];

test('range stats use trading-day endpoints and report points and percent changes', () => {
  const s = forcedRangeStats({ twii, margin, ratio }, '2026-01-02', '2026-01-08');
  assert.equal(s.tradingDays, 4);
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !~ ${b}`);
  assert.equal(s.idxPts, -20);
  near(s.idxPct, -20);
  assert.equal(s.mgnAmt, -180);
  near(s.mgnPct, -18);
  assert.equal(s.mrPts, -30);
  near(s.mrPct, (150 / 180 - 1) * 100);
});

test('dragging backwards gives the same window and non-trading endpoints snap to the prior trading day', () => {
  const fwd = forcedRangeStats({ twii, margin, ratio }, '2026-01-03', '2026-01-08');
  const back = forcedRangeStats({ twii, margin, ratio }, '2026-01-08', '2026-01-03');
  assert.equal(fwd.d0, '2026-01-02');
  assert.deepEqual(back, fwd);
});

test('margin and ratio fall back to the last value on or before the endpoint and report its date', () => {
  const s = forcedRangeStats({ twii, margin, ratio }, '2026-01-05', '2026-01-06');
  assert.equal(s.mrDate0, '2026-01-02');
  assert.equal(s.mr0, 180);
  assert.equal(s.mrDate1, '2026-01-02');
});

test('before the index history returns null', () => {
  assert.equal(forcedRangeStats({ twii, margin, ratio }, '2025-12-01', '2026-01-08'), null);
});

test('same-day selection is not judged', () => {
  const s = forcedRangeStats({ twii, margin, ratio }, '2026-01-06', '2026-01-06');
  assert.equal(s.tradingDays, 0);
  assert.equal(s.verdict.level, 'na');
});

test('verdict tiers: kill needs index <= -8 and margin <= -10; big needs -10 and -20', () => {
  const base = { tradingDays: 10 };
  assert.equal(classifyForcedSell({ ...base, idxPct: -8, mgnPct: -10 }).level, 'kill');
  assert.equal(classifyForcedSell({ ...base, idxPct: -7.9, mgnPct: -30 }).level, 'none');
  assert.equal(classifyForcedSell({ ...base, idxPct: -10, mgnPct: -19.9 }).level, 'kill');
  assert.equal(classifyForcedSell({ ...base, idxPct: -10, mgnPct: -20 }).level, 'big');
  assert.equal(classifyForcedSell({ ...base, idxPct: -12, mgnPct: -4 }).level, 'no');
  assert.equal(classifyForcedSell({ ...base, idxPct: -12, mgnPct: null }).level, 'na');
});

test('calibrated flag marks windows longer than 10 trading days as indicative only', () => {
  const longTwii = Array.from({ length: 13 }, (_, i) =>
    [`2026-02-${String(i + 1).padStart(2, '0')}`, 100 - i]);
  const longMargin = longTwii.map(([d]) => [d, 1000]);
  const s = forcedRangeStats({ twii: longTwii, margin: longMargin, ratio: [] }, '2026-02-01', '2026-02-13');
  assert.equal(s.tradingDays, 12);
  assert.equal(s.calibrated, false);
  assert.equal(s.mrPct, null);
});
