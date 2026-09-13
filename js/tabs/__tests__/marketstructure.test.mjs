import test from 'node:test';
import assert from 'node:assert/strict';

import { aaiiSpread, marginYoY } from '../marketstructure.js';

test('margin YoY matches the same calendar month one year earlier', () => {
  const rows = [
    { date: '2025-08-01', debit: 100 },
    { date: '2026-07-01', debit: 900 },
    { date: '2026-08-01', debit: 125 },
  ];
  assert.equal(marginYoY(rows), 25);
});

test('margin YoY stays unavailable when the matching prior-year month is missing', () => {
  assert.equal(marginYoY([
    { date: '2025-07-01', debit: 100 },
    { date: '2026-08-01', debit: 125 },
  ]), null);
});

test('AAII spread is recalculated from bull minus bear and rounded to one decimal', () => {
  assert.equal(aaiiSpread({ bull: 41.24, bear: 29.96, spread: -999 }), 11.3);
  assert.equal(aaiiSpread({ bull: null, bear: 29.96 }), null);
});
