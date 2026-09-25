import test from 'node:test';
import assert from 'node:assert/strict';

import { spliceMarginRatio } from '../twsentiment.js';

test('mm rows before the daily file start are prepended, overlap uses daily', () => {
  const mm = [
    ['2004-02-11', 171.0],
    ['2022-11-30', 160.0],   // overlaps/precedes daily start by one day, still before it -> kept
    ['2022-12-01', 999.0],   // same date as daily first row -> dropped, daily wins
    ['2022-12-05', 999.0],   // after daily start -> dropped
  ];
  const daily = [
    ['2022-12-01', 162.79],
    ['2022-12-02', 163.49],
  ];
  assert.deepEqual(spliceMarginRatio(mm, daily), [
    ['2004-02-11', 171.0],
    ['2022-11-30', 160.0],
    ['2022-12-01', 162.79],
    ['2022-12-02', 163.49],
  ]);
});

test('null ratio_all rows in mm are skipped', () => {
  const mm = [
    ['2004-02-11', 171.0],
    ['2004-02-12', null],
    ['2004-02-13', undefined],
  ];
  const daily = [['2022-12-01', 162.79]];
  assert.deepEqual(spliceMarginRatio(mm, daily), [
    ['2004-02-11', 171.0],
    ['2022-12-01', 162.79],
  ]);
});

test('empty daily array falls back to mm only (filtered)', () => {
  const mm = [['2004-02-11', 171.0], ['2004-02-12', null]];
  assert.deepEqual(spliceMarginRatio(mm, []), [['2004-02-11', 171.0]]);
});

test('empty mm array falls back to daily only', () => {
  const daily = [['2022-12-01', 162.79]];
  assert.deepEqual(spliceMarginRatio([], daily), daily);
});

test('both empty returns empty array', () => {
  assert.deepEqual(spliceMarginRatio([], []), []);
});

test('null/undefined inputs are treated as empty', () => {
  assert.deepEqual(spliceMarginRatio(null, undefined), []);
});
