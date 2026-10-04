import test from 'node:test';
import assert from 'node:assert/strict';
import { rollingPctRank, findEntryDate, dedupeSignals, ffillPctRankDaily,
  fwdRet, realizedVol, computeForTickerPure } from '../tabs/naaim_calc.mjs';

test('NAAIM legacy rank uses average ties and minimum observations', () => {
  const got = rollingPctRank([1, 2, 2, 4], 3, 2);
  assert.equal(got[0], null);
  assert.equal(got[1], 100);
  assert.ok(Math.abs(got[2] - 250 / 3) < 1e-10);
  assert.equal(got[3], 100);
});

test('NAAIM t0 and daily display fill do not move survey data earlier', () => {
  const prices = ['2026-01-02', '2026-01-05', '2026-01-06'];
  assert.equal(findEntryDate(prices, '2026-01-01'), '2026-01-05');
  assert.deepEqual(dedupeSignals(['2026-01-01', '2026-01-15', '2026-02-01'], 30),
    ['2026-01-01', '2026-02-01']);
  const filled = ffillPctRankDaily(prices, ['2026-01-01'], [80], new Map([['2026-01-01', '2026-01-05']]));
  assert.deepEqual(filled, [null,
    { pct: 80, naaimDate: '2026-01-01', isOriginal: true },
    { pct: 80, naaimDate: '2026-01-01', isOriginal: false }]);
});

test('NAAIM return and volatility preserve missing-horizon behavior', () => {
  assert.equal(fwdRet([100, 110, 121], 0, 2), 21);
  assert.equal(fwdRet([100, 110, 121], 1, 2), null);
  assert.equal(realizedVol([100, 110, 121], 1, 2), null);
  const dates = ['2026-01-01', '2026-01-08'];
  const result = computeForTickerPure({ naaimDates: dates, naaimVals: [50, 60],
    priceDates: ['2026-01-05', '2026-01-12'], priceCloses: [100, 101] });
  assert.deepEqual(result.pctRank, [null, null]);
  assert.ok(result.groups.every(group => group.nPre === 0));
});

test('NAAIM first complete 104-week window enters the weekly event population once', () => {
  const iso = ms => new Date(ms).toISOString().slice(0, 10);
  const start = Date.UTC(2020, 0, 1);
  const naaimDates = Array.from({ length: 104 }, (_, i) => iso(start + i * 7 * 86400000));
  const priceDates = Array.from({ length: 1000 }, (_, i) => iso(start + i * 86400000));
  const result = computeForTickerPure({ naaimDates,
    naaimVals: naaimDates.map((_, i) => i + 1), priceDates,
    priceCloses: priceDates.map((_, i) => 100 + i) });
  assert.equal(result.pctRank.filter(v => v != null).length, 1);
  assert.equal(result.pctRank.at(-1), 100);
  assert.equal(result.groups[0].nPre, 1);
  assert.equal(result.groups[0].nPost, 1);
  assert.equal(result.baseline[1].n, 1);
});
