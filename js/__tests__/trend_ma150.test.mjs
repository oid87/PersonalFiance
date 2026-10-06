import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as math from '../utils/math.js';
import * as dates from '../utils/dates.js';
import * as lifecycle from '../utils/chartLifecycle.js';

const source = readFileSync(new URL('../tabs/trend.js', import.meta.url), 'utf8');
const legacy = readFileSync(new URL('./fixtures/calculations-three/trend.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const rows = Array.from({ length: 480 }, (_, i) => [
  new Date(Date.UTC(2020, 0, 1 + i * 3)).toISOString().slice(0, 10),
  100 + i * 0.173 + (i % 7) * 0.011,
]);
const plain = value => JSON.parse(JSON.stringify(value));
// Independent per-window arithmetic, never calls computeMA.
const oracle = (input, n) => input.slice(n - 1).map((row, offset) => [row[0],
  +(input.slice(offset, offset + n).reduce((total, point) => total + point[1], 0) / n).toFixed(4),
]);

function harness(code = source) {
  const maActive = new Set();
  const chips = [20, 50, 150, 200].map(n => ({ dataset: { ma: String(n) },
    classList: { toggle() {} }, closest() { return this; } }));
  let click;
  const chart = { on() {}, resize() {}, getDom() { return null; },
    getOption() { return this.option; },
    setOption(option, flags) { this.option = option; this.flags = flags; },
    dispatchAction(action) {
      if (action.type === 'dataZoom') Object.assign(this.option.dataZoom[action.dataZoomIndex], action);
      else { this.option.legend.selected ||= {}; this.option.legend.selected[action.name] = action.type === 'legendSelect'; }
    },
  };
  // Chart option object uses one legend object; ECharts getOption exposes arrays.
  chart.getOption = function () { return { ...this.option, legend: [this.option.legend] }; };
  const ctx = { ...math, ...dates, ...lifecycle, maActive,
    SERIES: [{ key: 'QQQ', color: '#f778ba', yAxis: 0 }], customSeries: [], active: new Set(['QQQ']),
    loaded: { QQQ: rows, 'F&G': rows.map(([date], i) => [date, i % 100]) }, loadedHLC: {}, loadedVol: {},
    state: { sigMaps: null }, filterRange: data => data,
    PALETTE: {}, mob: () => false, chipPicker() {}, setTimeout() {}, clearTimeout() {},
    echarts: { init: () => chart },
    document: {
      getElementById: id => id === 'ma-picker' ? { addEventListener: (_, fn) => { click = fn; } } : null,
      querySelectorAll: () => chips, querySelector: () => null,
    },
  };
  vm.createContext(ctx);
  vm.runInContext(code.replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '').replace(/\bexport /g, ''), ctx);
  return { ctx, chart, maActive, click: n => click({ target: chips.find(c => +c.dataset.ma === n) }),
    render: () => ctx.render(), signal: () => { ctx.buildSigMaps(); return plain(ctx.state.sigMaps); } };
}

test('MA150 warmup, known observations and independent sum/N oracle', () => {
  assert.deepEqual(math.computeMA(rows.slice(0, 149), 150), []);
  assert.deepEqual(math.computeMA(rows.slice(0, 150), 150), oracle(rows.slice(0, 150), 150));
  assert.equal(math.computeMA(rows.slice(0, 151), 150).length, 2);
  assert.deepEqual(math.computeMA(rows, 150), oracle(rows, 150));
  const integers = Array.from({ length: 152 }, (_, i) => [String(i), i + 1]);
  assert.deepEqual(math.computeMA(integers, 150), [['149', 75.5], ['150', 76.5], ['151', 77.5]]);
});

test('picker adds only MA150 and preserves initial OFF and existing legend policy', () => {
  const picker = html.match(/id="ma-picker"[\s\S]*?<\/div>/)[0];
  assert.deepEqual([...picker.matchAll(/data-ma="(\d+)"/g)].map(m => +m[1]), [20, 50, 150, 200]);
  assert.doesNotMatch(picker, /class="chip active"/);
  const h = harness(); h.render();
  assert.equal(h.maActive.size, 0);
  assert.equal(h.chart.option.series.some(s => s.name.startsWith('__ma_')), false);
  h.click(150);
  assert.deepEqual(plain(h.chart.option.series.find(s => s.name === '__ma_QQQ_150').data), oracle(rows, 150));
  assert.equal(h.chart.option.legend.data.some(n => n.startsWith('__ma_')), false);
  h.click(150);
  assert.equal(h.chart.option.series.some(s => s.name === '__ma_QQQ_150'), false);
});

test('multi-select and repeated toggle keep old series, zoom, legend and fixed MA200 signals', () => {
  const h = harness(), old = harness(legacy);
  h.render(); old.render();
  assert.deepEqual(plain(h.chart.option), plain(old.chart.option));
  for (const n of [20, 50, 200]) { h.click(n); old.click(n); }
  assert.deepEqual(plain(h.chart.option), plain(old.chart.option));
  const existing = plain(h.chart.option.series);
  h.chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 0, start: 25, end: 80 });
  h.chart.dispatchAction({ type: 'legendUnSelect', name: 'QQQ' });
  for (let i = 0; i < 8; i++) {
    h.click(150);
    assert.equal(h.chart.option.series.filter(s => s.name === '__ma_QQQ_150').length, i % 2 === 0 ? 1 : 0);
    assert.deepEqual(plain(h.chart.option.series.filter(s => s.name !== '__ma_QQQ_150')), existing);
    assert.equal(h.chart.option.dataZoom[0].start, 25);
    assert.equal(h.chart.option.dataZoom[0].end, 80);
    assert.equal(h.chart.option.legend.selected.QQQ, false);
  }
  assert.deepEqual(h.signal(), old.signal());
});
