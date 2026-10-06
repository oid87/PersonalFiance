import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMarginRows, monthChange, rebaseToPercent,
  computeDivergence, computeVWAC } from '../tabs/marginglobal_calc.mjs';

test('market normalization excludes incomplete exchange dates', () => {
  const market = { needsExchangeSum: true };
  assert.deepEqual(normalizeMarginRows(market, [
    { date: '2026-01-01', exchange: 'SSE', margin_balance: 10 },
    { date: '2026-01-01', exchange: 'SZSE', margin_balance: 20 },
    { date: '2026-01-02', exchange: 'SSE', margin_balance: 12 },
  ]), [['2026-01-01', 30]]);
});

test('monthly change, anchor rebase and divergence keep zero-denominator rules', () => {
  const rows = [['2026-01-01', 100], ['2026-02-01', 110]];
  assert.equal(monthChange(rows), 0.1);
  assert.equal(monthChange([['2026-01-01', 0], ['2026-02-01', 110]]), null);
  assert.deepEqual(rebaseToPercent(rows, '2026-01-01'),
    [['2026-01-01', 0], ['2026-02-01', 10.000000000000009]]);
  assert.deepEqual(computeDivergence([['2026-01-01', 20]], [['2026-01-01', 5]]),
    [['2026-01-01', 15]]);
});

test('VWAC only adds positive borrowing at current index price', () => {
  const result = computeVWAC([['2026-01-01', 100], ['2026-01-02', 200],
    ['2026-01-03', 150]], [['2026-01-01', 10], ['2026-01-02', 20],
    ['2026-01-03', 30]]);
  assert.deepEqual(result, [['2026-01-01', 10], ['2026-01-02', 15],
    ['2026-01-03', 15]]);
});
