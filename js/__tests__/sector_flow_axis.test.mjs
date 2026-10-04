import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSectorAxis } from '../tabs/twsectorflow.js';

test('sector category axis is the sorted union, including dates missing from index', () => {
  const index = [['2026-01-01', 100], ['2026-01-03', 105]];
  const flow = [['2026-01-01', 10], ['2026-01-02', 20], ['2026-01-03', 30]];
  assert.deepEqual(buildSectorAxis(index, flow), ['2026-01-01', '2026-01-02', '2026-01-03']);
  assert.deepEqual(index, [['2026-01-01', 100], ['2026-01-03', 105]]);
  assert.deepEqual(flow, [['2026-01-01', 10], ['2026-01-02', 20], ['2026-01-03', 30]]);
});

test('sector axis accepts asymmetric ranges, empty sources, and duplicate dates', () => {
  assert.deepEqual(buildSectorAxis([['2026-02-03', 3], ['2026-02-01', 1]], [['2026-02-02', 2], ['2026-02-02', 9]]),
    ['2026-02-01', '2026-02-02', '2026-02-03']);
  assert.deepEqual(buildSectorAxis([], [['2026-01-02', 4]]), ['2026-01-02']);
  assert.deepEqual(buildSectorAxis([['2026-01-01', 4]], []), ['2026-01-01']);
  assert.deepEqual(buildSectorAxis([], []), []);
});
