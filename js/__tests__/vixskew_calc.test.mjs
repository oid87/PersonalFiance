import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { rangeStart, rollingMean, percentile, cxRollingPctRank, cxDedupeSignals, cxSummarize, mainChartModel, termStructureModel, putCallModel, complacencyModel } from '../tabs/vixskew_calc.mjs';

const legacy = readFileSync(fileURLToPath(new URL('./fixtures/calculations-three/vixskew.js', import.meta.url)), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function block(start, end) { return legacy.slice(legacy.indexOf(start), legacy.indexOf(end, legacy.indexOf(start))); }
function oldFn(start, end, name, context = {}) { return vm.runInNewContext(`${block(start, end)}\n${name}`, context); }

test('rolling P/C mean, nearest-rank percentile and SKEW rank match legacy snapshot', () => {
  const oldMean = oldFn('function rollingMean(arr, win)', 'function percentile(sorted, p)', 'rollingMean');
  const oldPct = oldFn('function percentile(sorted, p)', 'function renderPCChart()', 'percentile');
  const oldRank = oldFn('function cxRollingPctRank(arr, window, minPeriods)', 'function cxDedupeSignals(idxList, dates, gapDays)', 'cxRollingPctRank');
  const values = [null, 1, 1.2, 0.9, null, 1.1, 1.3, 0, 1.2];
  for (const win of [2, 5, 20]) assert.deepEqual(rollingMean(values, win), plain(oldMean(values, win)));
  for (const p of [0, .1, .5, .9, 1]) assert.equal(percentile([1, 3, 5, 7], p), oldPct([1, 3, 5, 7], p));
  for (const [window, min] of [[3, 2], [5, 5], [504, 120]])
    assert.deepEqual(cxRollingPctRank(values, window, min), plain(oldRank(values, window, min)));
});

test('signal gap in calendar days and stats match legacy snapshot', () => {
  const oldDedupe = oldFn('function cxDedupeSignals(idxList, dates, gapDays)', 'function cxSummarize(vals)', 'cxDedupeSignals');
  const oldSummary = oldFn('function cxSummarize(vals)', 'function renderComplacency()', 'cxSummarize');
  const dates = ['2024-01-31', '2024-02-01', '2024-02-29', '2024-03-01', '2024-04-01'];
  assert.deepEqual(cxDedupeSignals([0, 1, 2, 3, 4], dates, 30), plain(oldDedupe([0, 1, 2, 3, 4], dates, 30)));
  for (const vals of [[], [0], [-3, 0, 5], [-3, -1, 2, 4]]) assert.deepEqual(cxSummarize(vals), plain(oldSummary(vals)));
});

test('range cutoff uses explicit local-calendar anchor', () => {
  const fixed = new Date('2024-02-29T12:00:00Z');
  const FrozenDate = class extends Date { constructor(...args) { super(...(args.length ? args : [fixed])); } };
  const old = oldFn('function rangeStart(key)', 'function retColor(v)', 'rangeStart', { Date: FrozenDate });
  for (const key of ['all', '3Y', '5Y', '10Y', '20Y', 'other']) assert.equal(rangeStart(key, fixed), old(key));
});

test('chart models keep normalized SPY, thresholds and backwardation segments', () => {
  const history = Array.from({ length: 140 }, (_, i) => ({
    d: `2024-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + i % 28).padStart(2, '0')}`,
    sp: 100 + i, v: 20 + i % 10, sk: i % 35 === 0 ? 90 : 110 + i % 7, ds: i % 2 ? -1 : 2,
  }));
  const signals = [{ date: history[10].d, vix: 20, vix_drop: -15, skew: 110, skew_hold: -2, bear_trend: false, ret_63d: 5 }];
  const main = mainChartModel(history, signals, history[0].d);
  const oldRange = () => history[0].d;
  const oldMainBody = block('  const from  = rangeStart(vsRange);', '  const axisClr = PALETTE.muted;');
  const oldMain = vm.runInNewContext(`(function(vsData) { ${oldMainBody}\nreturn { dates, spyData, vixData, skewData, divData, sigSpy, sigVix, vixMax, skMin, skMax }; })`, { rangeStart: oldRange, vsRange: '5Y' });
  const { dates, spyData, vixData, skewData, divData, sigSpy, sigVix, vixMax, skMin, skMax } = main;
  assert.deepEqual(plain({ dates, spyData, vixData, skewData, divData, sigSpy, sigVix, vixMax, skMin, skMax }),
    plain(oldMain({ history, signals })));
  assert.equal(main.spyData[0], 0);
  assert.equal(main.spyData[10], 10);
  assert.deepEqual(main.sigVix, [{ value: [history[10].d, history[10].v] }]);
  assert.equal(main.vixMax, 40);
  const ts = termStructureModel([
    { date: '2024-01-01', vix: 20, vix3m: 19, ts_ratio: 1.052 },
    { date: '2024-01-02', vix: 21, vix3m: 19, ts_ratio: 1.105 },
    { date: '2024-01-03', vix: 20, vix3m: 22, ts_ratio: .909 },
  ]);
  const oldTsBody = block('  const dates   = rows.map(r => r.date);', '  const axisClr = PALETTE.muted;');
  const oldTs = vm.runInNewContext(`(function(rows) { ${oldTsBody}\nreturn { dates, vixData, v3mData, tsData, backAreas }; })`);
  assert.deepEqual(ts, plain(oldTs([
    { date: '2024-01-01', vix: 20, vix3m: 19, ts_ratio: 1.052 },
    { date: '2024-01-02', vix: 21, vix3m: 19, ts_ratio: 1.105 },
    { date: '2024-01-03', vix: 20, vix3m: 22, ts_ratio: .909 },
  ])));
  assert.deepEqual(ts.backAreas, [[{ xAxis: '2024-01-01' }, { xAxis: '2024-01-02' }]]);
  const pc = putCallModel([{ date: '2024-01-01', pc: 1 }, { date: '2024-01-02', pc: .5 }], '2024-01-01');
  assert.equal(pc.p10, .5);
  assert.deepEqual(pc.ma20, [null, null]);
  const cx = complacencyModel(history, { window: 40, minPeriods: 20, pctThreshold: 10, gapDays: 30, horizons: [21, 63, 126] });
  assert.equal(cx.result[126].baseline.n, 14);
  assert.ok(cx.sigIdx.length > 0);
  assert.ok(cx.sigIdx.every(i => cx.skPct[i] <= 10));
  const oldContext = {
    CX_WINDOW: 40, CX_MIN_PERIODS: 20, CX_PCT_THRESHOLD: 10,
    CX_GAP_DAYS: 30, CX_HORIZONS: [21, 63, 126], status: null,
    cxRollingPctRank: oldFn('function cxRollingPctRank(arr, window, minPeriods)', 'function cxDedupeSignals(idxList, dates, gapDays)', 'cxRollingPctRank'),
    cxDedupeSignals: oldFn('function cxDedupeSignals(idxList, dates, gapDays)', 'function cxSummarize(vals)', 'cxDedupeSignals'),
    cxSummarize: oldFn('function cxSummarize(vals)', 'function renderComplacency()', 'cxSummarize'),
  };
  const oldBody = block('  // 1. 平行陣列', '  console.log("[vixskew:complacency]');
  const oldModel = vm.runInNewContext(`(function(vsData) { ${oldBody}\n return { sigIdx, result, curSk, curPctFull, n }; })`, oldContext);
  assert.deepEqual({ sigIdx: cx.sigIdx, result: cx.result, curSk: cx.curSk, curPctFull: cx.curPctFull, n: cx.n }, plain(oldModel({ history })));
});
