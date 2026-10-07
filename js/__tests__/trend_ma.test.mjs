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

function harness(rows = history(350)) {
  for (const bag of [model.loaded, model.loadedHLC, model.loadedVol])
    for (const key of Object.keys(bag)) delete bag[key];
  model.active.clear(); model.active.add('QQQ');
  model.maActive.clear(); model.customSeries.splice(0);
  Object.assign(model.state, { rangePreset: 'MAX', customFrom: '', customTo: '', sigMaps: null });
  model.loaded.QQQ = rows;
  const chips = [...pickerHTML.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)].map(([, attrs, text]) => {
    const classes = new Set();
    return {
      dataset: { ma: attrs.match(/data-ma="(\d+)"/)[1] }, textContent: text,
      classList: { toggle(name, force) { if (force) classes.add(name); else classes.delete(name); },
        contains: name => classes.has(name) },
      closest: selector => selector === '.chip[data-ma]' ? chips.find(c => c.textContent === text) : null,
    };
  });
  const listeners = new Map();
  const picker = { addEventListener: (name, fn) => listeners.set(name, fn) };
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
      getElementById: id => id === 'ma-picker' ? picker : null,
      querySelectorAll: selector => selector === '#ma-picker .chip[data-ma]' ? chips : [],
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
    context, chips, charts, maCalls,
    render: () => context.render(),
    click(n) { const chip = chips.find(c => +c.dataset.ma === n); assert.ok(chip); listeners.get('click')({ target: chip }); },
    ma(n, key = 'QQQ') { return charts.at(-1).option.series.find(s => s.name === `__ma_${key}_${n}`); },
  };
}

test('seven real HTML buttons wire to independent multi-select and cancellation in chart render', () => {
  const h = harness();
  assert.match(html, /id="ma-picker" role="group" aria-label="移動平均線週期，可多選"/);
  assert.deepEqual(h.chips.map(c => +c.dataset.ma), periods);
  for (const n of periods) {
    assert.match(pickerHTML, new RegExp(`type="button" class="chip" data-ma="${n}"`));
    assert.ok(pickerHTML.includes(`最近 ${n} 筆資料的算術平均；滿 ${n} 筆後顯示`));
  }
  h.render();
  assert.equal(model.maActive.size, 0);
  assert.equal(h.charts.at(-1).option.series.filter(s => s.name.startsWith('__ma_')).length, 0);
  for (const n of periods) {
    h.click(n);
    assert.ok(model.maActive.has(n));
    assert.ok(h.chips.find(c => +c.dataset.ma === n).classList.contains('active'));
    assert.deepEqual(plain(h.ma(n).data), expectedMA(model.loaded.QQQ, n));
    assert.equal(h.ma(n).yAxisIndex, 0);
  }
  assert.equal(model.maActive.size, 7);
  for (const n of periods) {
    h.click(n);
    assert.equal(h.ma(n), undefined);
    assert.equal(model.maActive.has(n), false);
    assert.equal(h.chips.find(c => +c.dataset.ma === n).classList.contains('active'), false);
    for (const selected of model.maActive) assert.ok(h.ma(selected));
  }
});

for (const n of periods) {
  test(`MA${n} render respects insufficient history, first point and rounding`, () => {
    const h = harness(history(n - 1));
    h.click(n);
    assert.deepEqual(plain(h.ma(n).data), []);
    model.loaded.QQQ = history(n);
    h.render();
    assert.deepEqual(plain(h.ma(n).data), expectedMA(model.loaded.QQQ, n));
    assert.equal(h.ma(n).data.length, 1);
    assert.equal(h.ma(n).data[0][0], model.loaded.QQQ[n - 1][0]);
  });
}

test('all periods compute full history before cropping to a narrow display window', () => {
  const rows = history(350), h = harness(rows);
  for (const n of periods) h.click(n);
  model.state.customFrom = rows[320][0]; model.state.customTo = rows[330][0];
  h.render();
  for (const n of periods) {
    assert.deepEqual(plain(h.ma(n).data), expectedMA(rows, n).filter(([date]) =>
      date >= rows[320][0] && date <= rows[330][0]));
    assert.equal(h.ma(n).data.length, 11);
  }
});

test('selection survives product and theme render while VIX and F&G never generate MA', () => {
  const h = harness();
  for (const n of periods) h.click(n);
  for (const key of ['VIX', 'F&G', 'SPY']) { model.loaded[key] = history(350); model.active.add(key); }
  model.active.delete('QQQ');
  h.render();
  for (const n of periods) {
    assert.equal(h.ma(n, 'VIX'), undefined); assert.equal(h.ma(n, 'F&G'), undefined);
    assert.equal(h.ma(n), undefined); assert.ok(h.ma(n, 'SPY'));
  }
  const before = plain(h.charts.at(-1).option.series);
  h.context.onThemeChange(false);
  assert.equal(h.charts[0].disposed, true);
  assert.deepEqual(plain(h.charts.at(-1).option.series), before);
  assert.deepEqual([...model.maActive], periods);
});

test('display MA toggles leave fixed signal MA200, bounce data and signal snapshot unchanged', () => {
  const h = harness();
  model.loaded['F&G'] = model.loaded.QQQ.map(([date]) => [date, 12]);
  model.loaded.VIX = model.loaded.QQQ.map(([date]) => [date, 32]);
  h.render(); h.context.buildSigMaps();
  const sigBefore = plain(model.state.sigMaps);
  const snapBefore = calc.signalSnapshot(model.state.sigMaps, model.loaded.QQQ.at(-1)[0], dates.lookupLE);
  const bounceBefore = plain(h.charts.at(-1).option.series.filter(s => s.name === '__bounceSignal'));
  assert.ok(h.maCalls.length > 0);
  assert.ok(h.maCalls.every(n => n === 200));
  for (const n of periods) h.click(n);
  assert.deepEqual(plain(h.charts.at(-1).option.series.filter(s => s.name === '__bounceSignal')), bounceBefore);
  model.state.sigMaps = null; h.maCalls.splice(0); h.context.buildSigMaps();
  assert.ok(h.maCalls.length > 0); assert.ok(h.maCalls.every(n => n === 200));
  assert.deepEqual(plain(model.state.sigMaps), sigBefore);
  assert.deepEqual(calc.signalSnapshot(model.state.sigMaps, model.loaded.QQQ.at(-1)[0], dates.lookupLE), snapBefore);
});
