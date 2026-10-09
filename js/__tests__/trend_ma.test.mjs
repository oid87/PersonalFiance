import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as model from '../state.js';
import * as dates from '../utils/dates.js';
import * as math from '../utils/math.js';
import * as calc from '../tabs/trend_calc.mjs';
import * as lifecycle from '../utils/chartLifecycle.js';

const periods = [20, 50, 100, 125, 150, 200, 300];
const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const pickerHTML = html.match(/<div[^>]+id="ma-picker"[^>]*>([\s\S]*?)<\/div>/)[1];
const source = readFileSync(new URL('../tabs/trend.js', import.meta.url), 'utf8')
  .replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')
  .replace(/\bexport /g, '');
const plain = value => JSON.parse(JSON.stringify(value));
const history = length => Array.from({ length }, (_, i) => [
  new Date(Date.UTC(2020, 0, 1 + i * 3)).toISOString().slice(0, 10),
  100 + i * 0.173 + (i % 7) * 0.011,
]);
// Independent arithmetic oracle: N observations, regardless of calendar gaps.
const expectedMA = (rows, n) => rows.slice(n - 1).map((row, i) => [row[0],
  +(rows.slice(i, i + n).reduce((sum, r) => sum + r[1], 0) / n).toFixed(4),
]);

function element() {
  const listeners = new Map();
  return { value: '', hidden: true, focus() {}, listeners,
    addEventListener: (name, fn) => listeners.set(name, fn) };
}

function harness(rows = history(350)) {
  for (const bag of [model.loaded, model.loadedHLC, model.loadedVol])
    for (const key of Object.keys(bag)) delete bag[key];
  model.active.clear(); model.active.add('QQQ');
  model.maActive.clear(); model.customSeries.splice(0);
  Object.assign(model.state, { rangePreset: 'MAX', customFrom: '', customTo: '', sigMaps: null });
  model.loaded.QQQ = rows;
  const select = element(), custom = element();
  const charts = [];
  const maCalls = [];
  const context = {
    ...model, ...dates, ...math, ...calc, ...lifecycle,
    calcFearZones: calc.fearZones, calcFearEpisodes: calc.fearEpisodes, calcBuildSigMaps: calc.buildSigMaps,
    computeMA: (data, n) => { maCalls.push(n); return math.computeMA(data, n); },
    PALETTE: { muted: '#888', grid: '#333', bg: '#111', border: '#444', text: '#fff' },
    tc: dark => dark, mob: () => false,
    chipPicker() {},
    loadSeries: async () => {}, ensureLoaded: async () => {},
    requestJSON: async () => { throw new Error('network is forbidden in scoped tests'); },
    document: {
      getElementById: id => ({ 'ma-select': select, 'ma-custom': custom })[id] ?? null,
      querySelectorAll: () => [],
      querySelector: () => null,
    },
    echarts: { init() {
      const chart = { on() {}, resize() {}, dispose() { this.disposed = true; },
        setOption(option, flags) { this.option = option; this.flags = flags; } };
      charts.push(chart); return chart;
    } },
    setTimeout, clearTimeout,
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'trend.js' });
  return {
    context, select, custom, charts, maCalls,
    render: () => context.render(),
    pick(value) { select.value = String(value); select.listeners.get('change')(); },
    typeCustom(value) { custom.value = String(value); custom.listeners.get('keydown')({ key: 'Enter' }); },
    maNames() { return plain(charts.at(-1).option.series.filter(s => s.name.startsWith('__ma_')).map(s => s.name)); },
    ma(n, key = 'QQQ') { return charts.at(-1).option.series.find(s => s.name === `__ma_${key}_${n}`); },
  };
}

test('compact select lists the usual periods plus none/custom and is single-select', () => {
  assert.match(html, /id="ma-picker" role="group" aria-label="移動平均線"/);
  assert.deepEqual([...pickerHTML.matchAll(/<option value="([^"]*)"/g)].map(m => m[1]),
    ['', ...periods.map(String), 'custom']);
  assert.doesNotMatch(pickerHTML, /selected/);
  assert.match(pickerHTML, /<input type="number" id="ma-custom"[^>]*hidden/);
  const h = harness();
  h.render();
  assert.equal(model.maActive.size, 0);
  assert.deepEqual(h.maNames(), []);
  for (const n of periods) {
    h.pick(n);
    assert.deepEqual([...model.maActive], [n]);
    assert.deepEqual(h.maNames(), [`__ma_QQQ_${n}`]);
    assert.deepEqual(plain(h.ma(n).data), expectedMA(model.loaded.QQQ, n));
    assert.equal(h.ma(n).yAxisIndex, 0);
    assert.equal(h.custom.hidden, true);
  }
  h.pick('');
  assert.equal(model.maActive.size, 0);
  assert.deepEqual(h.maNames(), []);
});

test('custom period draws any valid integer and ignores invalid input', () => {
  const h = harness();
  h.pick(50);
  h.pick('custom');
  assert.equal(h.custom.hidden, false);
  assert.deepEqual(h.maNames(), [], 'switching to an empty custom box clears the preset line');
  h.typeCustom(37);
  assert.deepEqual([...model.maActive], [37]);
  assert.deepEqual(plain(h.ma(37).data), expectedMA(model.loaded.QQQ, 37));
  for (const bad of ['1', 'abc', '5000', '']) {
    h.typeCustom(bad);
    assert.deepEqual(h.maNames(), ['__ma_QQQ_37']);
  }
  h.pick(200);
  assert.equal(h.custom.hidden, true);
  assert.deepEqual(h.maNames(), ['__ma_QQQ_200']);
  h.pick('custom');
  assert.deepEqual(h.maNames(), [], 'an invalid custom value never leaves the previous preset drawn');
  h.typeCustom(37); h.pick(20); h.pick('custom');
  assert.deepEqual(h.maNames(), ['__ma_QQQ_37'], 'returning to custom reuses the typed period');
  h.typeCustom('2.5');
  assert.deepEqual(h.maNames(), ['__ma_QQQ_37'], 'fractional periods are rejected');
});

for (const n of periods) {
  test(`MA${n} render respects insufficient history, first point and rounding`, () => {
    const h = harness(history(n - 1));
    h.pick(n);
    assert.deepEqual(plain(h.ma(n).data), []);
    model.loaded.QQQ = history(n);
    h.render();
    assert.deepEqual(plain(h.ma(n).data), expectedMA(model.loaded.QQQ, n));
    assert.equal(h.ma(n).data.length, 1);
    assert.equal(h.ma(n).data[0][0], model.loaded.QQQ[n - 1][0]);
  });
}

test('every period computes full history before cropping to a narrow display window', () => {
  const rows = history(350), h = harness(rows);
  model.state.customFrom = rows[320][0]; model.state.customTo = rows[330][0];
  for (const n of periods) {
    h.pick(n);
    assert.deepEqual(plain(h.ma(n).data), expectedMA(rows, n).filter(([date]) =>
      date >= rows[320][0] && date <= rows[330][0]));
    assert.equal(h.ma(n).data.length, 11);
  }
});

test('selection survives theme render while volatility indices and F&G never generate MA', () => {
  const h = harness();
  h.pick(150);
  for (const key of ['VIX', 'VXN', 'F&G', 'SPY']) { model.loaded[key] = history(350); model.active.add(key); }
  model.loadedHLC.VIX = history(350).map(([d, v]) => [d, v + 5, v - 5, v]);
  model.active.add('VIX高');
  model.active.delete('QQQ');
  h.render();
  for (const key of ['VIX', 'VXN', 'F&G', 'VIX高']) assert.equal(h.ma(150, key), undefined);
  assert.equal(h.ma(150), undefined); assert.ok(h.ma(150, 'SPY'));
  const before = plain(h.charts.at(-1).option.series);
  h.context.onThemeChange(false);
  assert.equal(h.charts[0].disposed, true);
  assert.deepEqual(plain(h.charts.at(-1).option.series), before);
  assert.deepEqual([...model.maActive], [150]);
});

test('VXN close and VIX/VXN intraday-high lines plot on the volatility axis', () => {
  const h = harness();
  const hlc = history(30).map(([d, v]) => [d, v + 7, v - 3, v]);
  model.loadedHLC.VIX = hlc;
  model.loaded.VIX = hlc.map(([d, , , c]) => [d, c]);
  model.loaded.VXN = hlc.map(([d, , , c]) => [d, c + 1]);
  model.loadedHLC.VXN = hlc.map(([d, hi, lo, c]) => [d, hi + 2, lo, c + 1]);
  h.render();
  const names = () => h.charts.at(-1).option.series.map(s => s.name);
  for (const key of ['VIX', 'VXN', 'VIX高', 'VXN高']) assert.equal(names().includes(key), false);
  for (const key of ['VIX', 'VXN', 'VIX高', 'VXN高']) model.active.add(key);
  h.render();
  const find = n => h.charts.at(-1).option.series.find(s => s.name === n);
  assert.deepEqual(plain(find('VIX高').data), hlc.map(([d, hi]) => [d, hi]));
  assert.deepEqual(plain(find('VXN高').data), hlc.map(([d, hi]) => [d, hi + 2]));
  assert.deepEqual(plain(find('VXN').data), plain(model.loaded.VXN));
  for (const n of ['VIX', 'VXN', 'VIX高', 'VXN高']) assert.equal(find(n).yAxisIndex, 1);
  assert.equal(find('VIX高').lineStyle.type, 'dotted');
  assert.equal(find('VIX').lineStyle.type, undefined);
  assert.equal(h.charts.at(-1).option.yAxis[1].name, 'VIX/VXN');
  assert.ok(h.charts.at(-1).option.legend.data.includes('VIX高'));
});

test('display MA changes leave fixed signal MA200, bounce data and signal snapshot unchanged', () => {
  const h = harness();
  model.loaded['F&G'] = model.loaded.QQQ.map(([date]) => [date, 12]);
  model.loaded.VIX = model.loaded.QQQ.map(([date]) => [date, 32]);
  h.render(); h.context.buildSigMaps();
  const sigBefore = plain(model.state.sigMaps);
  const snapBefore = calc.signalSnapshot(model.state.sigMaps, model.loaded.QQQ.at(-1)[0], dates.lookupLE);
  const bounceBefore = plain(h.charts.at(-1).option.series.filter(s => s.name === '__bounceSignal'));
  assert.ok(h.maCalls.length > 0);
  assert.ok(h.maCalls.every(n => n === 200));
  for (const n of periods) h.pick(n);
  h.pick('custom'); h.typeCustom(42);
  assert.deepEqual(plain(h.charts.at(-1).option.series.filter(s => s.name === '__bounceSignal')), bounceBefore);
  model.state.sigMaps = null; h.maCalls.splice(0); h.context.buildSigMaps();
  assert.ok(h.maCalls.length > 0); assert.ok(h.maCalls.every(n => n === 200));
  assert.deepEqual(plain(model.state.sigMaps), sigBefore);
  assert.deepEqual(calc.signalSnapshot(model.state.sigMaps, model.loaded.QQQ.at(-1)[0], dates.lookupLE), snapBefore);
});
