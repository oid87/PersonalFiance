import test from 'node:test';
import assert from 'node:assert/strict';
import { monthlyReturnHeatmapModel, monthlyReturnHeatmapOption } from '../tabs/monthly_return_heatmap.mjs';

const options = { calculationLabel: 'Caller-confirmed price-return endpoints',
  colors: { negative: '#f00', neutral: '#fff', positive: '#0f0', text: '#111', border: '#aaa' } };

test('presentation keeps missing, null, zero, supplied partial flags and raw returns distinct', () => {
  const rows = [
    { month: '2026-10', returnPct: 1.234567, partial: true, from: '2026-09-30', to: '2026-10-06' },
    { month: '2025-12', returnPct: 0, partial: false },
    { month: '2026-09', returnPct: null, partial: false },
  ];
  const before = structuredClone(rows);
  const model = monthlyReturnHeatmapModel(rows);
  assert.deepEqual(model.years, ['2025', '2026']);
  assert.equal(model.cells.length, 24);
  const find = month => model.cells.find(cell => cell.month === month);
  assert.equal(find('2025-12').returnPct, 0);
  assert.equal(find('2026-09').returnPct, null);
  assert.equal(find('2026-09').provided, true);
  assert.equal(find('2026-08').provided, false);
  assert.equal(find('2026-08').partial, null);
  assert.equal(find('2026-10').returnPct, 1.234567);
  assert.equal(find('2026-10').partial, true);
  assert.deepEqual(rows, before);
  const option = monthlyReturnHeatmapOption(model, options);
  const partial = option.series[0].data.find(item => item.cell.month === '2026-10');
  assert.equal(partial.value[2], 1.234567);
  assert.equal(option.series[0].label.formatter({ data: partial }), '1.23%（未完整）');
  assert.match(option.tooltip.formatter({ data: partial }), /2026-09-30 → 2026-10-06/);
  assert.equal(option.tooltip.renderMode, 'richText');
});

test('renderer requires explicit calculated values and never infers returns or completeness', () => {
  for (const row of [
    { month: '2026-13', returnPct: 1, partial: false },
    { month: '2026-01', returnPct: Infinity, partial: false },
    { month: '2026-01', returnPct: '1', partial: false },
    { month: '2026-01', close: 100, partial: false },
    { month: '2026-01', returnPct: 1 },
  ]) assert.throws(() => monthlyReturnHeatmapModel([row]));
  const row = { month: '2026-01', returnPct: 0, partial: false };
  assert.throws(() => monthlyReturnHeatmapModel([row, row]), /Duplicate/);
  assert.throws(() => monthlyReturnHeatmapOption(monthlyReturnHeatmapModel([row]), { colors: options.colors }));
  const empty = monthlyReturnHeatmapModel([]);
  assert.deepEqual(empty, { years: [], cells: [] });
  assert.equal(monthlyReturnHeatmapOption(empty, options).series[0].data.length, 0);
});
