import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { percentile, rollingMin, rangeStart, latestNonNull, contributionModel, heatmapModel, releaseTableRows, marketModel } from '../tabs/cpi_calc.mjs';

const legacy = readFileSync(fileURLToPath(new URL('./fixtures/calculations-three/cpi.js', import.meta.url)), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function block(start, end) { return legacy.slice(legacy.indexOf(start), legacy.indexOf(end, legacy.indexOf(start))); }
function oldFn(start, end, name, context = {}) { return vm.runInNewContext(`${block(start, end)}\n${name}`, context); }

const market = [
  { date: '2024-01-01', dgs10: 4.01, dgs2: null },
  { date: '2024-01-02', dgs10: null, dgs2: 4.30 },
  { date: '2024-01-03', dgs10: 4.07, dgs2: 4.32 },
  { date: '2024-01-04', dgs10: 4.05, dgs2: null },
];
test('CPI percentile interpolation, nulls and rolling low match legacy', () => {
  const oldPct = oldFn('function percentile(arr, p)', 'function rollingMin(rows, key, window)', 'percentile');
  const oldMin = oldFn('function rollingMin(rows, key, window)', 'function rangeStart(key)', 'rollingMin');
  const oldLatest = oldFn('function latestNonNull(rows, key)', 'function dateLabel(firstParam)', 'latestNonNull');
  for (const values of [[], [null, NaN], [1], [1, 2, 5, 9], [0, null, 10]]) {
    for (const p of [0, .05, .5, .95, 1]) assert.deepEqual(percentile(values, p), oldPct(values, p));
  }
  assert.deepEqual(rollingMin(market, 'dgs10', 2), plain(oldMin(market, 'dgs10', 2)));
  assert.equal(latestNonNull(market, 'dgs2'), oldLatest(market, 'dgs2'));
});

test('CPI local-calendar range uses supplied clock, including leap-day rollover', () => {
  const fixed = new Date('2024-02-29T12:00:00Z');
  const FrozenDate = class extends Date { constructor(...args) { super(...(args.length ? args : [fixed])); } };
  const old = oldFn('function rangeStart(key)', 'function latestNonNull(rows, key)', 'rangeStart', { Date: FrozenDate });
  for (const key of ['MAX', '1Y', '3Y', '5Y', '10Y', 'unknown']) assert.equal(rangeStart(key, fixed), old(key));
});

test('release-day bp table matches legacy snapshot, including unavailable dates and prior non-null yield', () => {
  const releaseDates = ['2023-12-30', '2024-01-03', '2024-01-04'];
  const old = oldFn('function releaseTableRows()', 'function renderReleaseTable()', 'releaseTableRows', { payload: { market, release_dates: releaseDates }, Map, Math });
  assert.deepEqual(releaseTableRows(market, releaseDates), plain(old()));
  assert.deepEqual(releaseTableRows([], releaseDates), []);
});

test('decomposition, heatmap and market models retain chart data conventions', () => {
  const row = { date: '2024-01-01', headline_mom: .12, residual_pp: -.03, parts: [
    { key: 'energy', label: 'Energy', contrib_pp: -.10, weight: 7, mom: -1 },
    { key: 'core', label: 'Core', contrib_pp: .25, weight: 80, mom: .3 },
  ] };
  const contribution = contributionModel(row);
  const oldItemsBody = block('  const items = [', '  if (sub) sub.textContent');
  const oldItems = vm.runInNewContext(`(function(row) { ${oldItemsBody}\nreturn items; })`)(row);
  assert.deepEqual(contribution.items, plain(oldItems));
  assert.deepEqual(contribution.items.map(x => x.label), ['Energy', '近似誤差', 'Core']);
  assert.equal(contribution.nonEnergyTotal, .12 - -.10);
  assert.equal(contribution.residualDominates, false);
  assert.ok(contribution.xMin < -.10 && contribution.xMax > .25);
  const heat = heatmapModel([
    { key: 'headline', label: 'Headline CPI', data: [{ date: '2024-01-01', mom: .2 }] },
    { key: 'core', label: 'Core CPI', data: [{ date: '2024-01-01', mom: .1 }] },
    { key: 'energy', label: 'Energy', data: [{ date: '2024-01-01', mom: -1.23456 }] },
  ]);
  const comps = [
    { key: 'headline', label: 'Headline CPI', data: [{ date: '2024-01-01', mom: .2 }] },
    { key: 'core', label: 'Core CPI', data: [{ date: '2024-01-01', mom: .1 }] },
    { key: 'energy', label: 'Energy', data: [{ date: '2024-01-01', mom: -1.23456 }] },
  ];
  const oldHeatBody = block('  const dateSet = new Set();', '  const axisClr = PALETTE.muted;');
  const oldPct = oldFn('function percentile(arr, p)', 'function rollingMin(rows, key, window)', 'percentile');
  const oldHeat = vm.runInNewContext(`(function(comps) { ${oldHeatBody}\nreturn { colLabels, rowLabels, heatData, bound }; })`, { percentile: oldPct });
  assert.deepEqual({ colLabels: heat.colLabels, rowLabels: heat.rowLabels,
    heatData: heat.heatData, bound: heat.bound }, plain(oldHeat(comps)));
  assert.deepEqual(heat.rowLabels, ['Energy', '', 'Headline CPI', 'Core CPI']);
  assert.deepEqual(heat.heatData[0], [0, 0, -1.235]);
  assert.equal(heat.bound, Math.max(Math.abs(percentile([-1.23456, .2, .1], .05)), Math.abs(percentile([-1.23456, .2, .1], .95)), .05));
  const model = marketModel(market, ['2024-01-02', '2024-01-04', '2024-02-01'], '2024-01-02');
  assert.deepEqual(model.releaseDatesInView, ['2024-01-02', '2024-01-04']);
  assert.deepEqual(model.rows.map(r => [r.date, model.rollMinMap.get(r.date)]), [
    ['2024-01-02', 4.01], ['2024-01-03', 4.01], ['2024-01-04', 4.01],
  ]);
});
