import test from 'node:test';
import assert from 'node:assert/strict';
import { monthEnd, findAnchorIdx, fwdRet, median, detectSignalA,
  detectSignalB, computeSignalRow, computeBaseline, groupMedians, buildEventStudyPure } from '../tabs/marginpeak_calc.mjs';

test('month-end anchor and forward return use last prior trading date', () => {
  assert.equal(monthEnd('2024-02-01'), '2024-02-29');
  const series = [{ date: '2024-02-28', close: 100 }, { date: '2024-03-01', close: 110 }];
  assert.equal(findAnchorIdx(series, '2024-02-29'), 0);
  assert.equal(fwdRet(series, 0, 1), 10);
  assert.equal(fwdRet(series, 1, 1), null);
  assert.equal(median([3, 1, 2, 4]), 2.5);
});

test('threshold and local peak signals retain original boundaries', () => {
  const rows = [10, 20, 45, 60, 20, 10, 5, 4, 3, 2].map((yoy, i) =>
    ({ date: `2025-0${i + 1}-01`, yoy }));
  assert.deepEqual(detectSignalA(rows).map(r => r.date), ['2025-04-01']);
  assert.deepEqual(detectSignalB(rows).map(r => r.date), ['2025-04-01']);
  assert.equal(groupMedians([{ SPX_1m: 1 }, { SPX_1m: 3 }]).SPX_1m, 2);
  const daily = Array.from({ length: 254 }, (_, i) => ({
    date: new Date(Date.UTC(2024, 1, 29 + i)).toISOString().slice(0, 10), close: 100 + i }));
  const signal = computeSignalRow({ date: '2024-02-01', yoy: 60 }, daily, daily);
  assert.equal(signal.signal, '2024-02');
  assert.equal(signal.SPX_1m, 21);
  assert.equal(signal.QQQ_1m, 21);
});

test('event study returns a 253 trading-day band with sparse tail', () => {
  const state = { qqqDaily: [{ date: '2024-02-28', close: 100 },
    { date: '2024-03-01', close: 110 }], spxDaily: [], sigBDates: ['2024-02-01'] };
  const result = buildEventStudyPure('QQQ', state);
  assert.equal(result.n, 1);
  assert.equal(result.meanArr.length, 253);
  assert.deepEqual(result.meanArr.slice(0, 3), [100, 110, null]);
});

test('raw monthly baseline uses the month-end anchor and counts only available horizons', () => {
  const spx = Array.from({ length: 284 }, (_, i) => ({
    date: new Date(Date.UTC(2024, 3, 30 + i)).toISOString().slice(0, 10), close: 100 + i,
  }));
  const qqq = Array.from({ length: 22 }, (_, i) => ({
    date: new Date(Date.UTC(2024, 4, 31 + i)).toISOString().slice(0, 10), close: 200 + i,
  }));
  const result = computeBaseline(spx, qqq, { startMonth: '2024-04', endMonth: '2024-05' });
  assert.equal(result.months, 2);
  assert.equal(result.counts.SPX_1m, 2);
  assert.equal(result.counts.SPX_12m, 2);
  assert.equal(result.medians.SPX_1m, 18.515); // April 21%, May 16.03%.
  assert.equal(result.counts.QQQ_1m, 1); // QQQ begins after April's anchor.
  assert.equal(result.medians.QQQ_1m, 10.5);
  for (const horizon of ['3m', '6m', '12m']) {
    assert.equal(result.counts[`QQQ_${horizon}`], 0);
    assert.equal(result.medians[`QQQ_${horizon}`], null);
  }
  const fixedRange = computeBaseline([], []);
  assert.equal(fixedRange.months, 315);
  assert.equal(fixedRange.counts.SPX_1m, 0);
  assert.equal(fixedRange.medians.SPX_1m, null);
});
