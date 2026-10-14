import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as math from '../utils/math.js';
import * as dates from '../utils/dates.js';
import * as lifecycle from '../utils/chartLifecycle.js';
import * as calc from '../tabs/trend_calc.mjs';

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
  const control = () => { const l = new Map(); return { value: '', hidden: true, focus() {}, l,
    addEventListener: (name, fn) => l.set(name, fn) }; };
  const select = control(), custom = control();
  const status = { textContent: '' };
  const fearHandlers = new Map();
  const fearToggle = { classList: { toggle() {}, remove() {} }, addEventListener: (name, fn) => fearHandlers.set(name, fn) };
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
  const ctx = { ...math, ...dates, ...lifecycle, ...calc, maActive,
    calcFearZones: calc.fearZones, calcFearEpisodes: calc.fearEpisodes, calcBuildSigMaps: calc.buildSigMaps,
    requestJSON: async () => { throw new Error('network is forbidden in scoped tests'); },
    ensureLoaded: async () => {},
    SERIES: [{ key: 'QQQ', color: '#f778ba', yAxis: 0 }], customSeries: [], active: new Set(['QQQ']),
    loaded: { QQQ: rows, 'F&G': rows.map(([date], i) => [date, i % 100]) }, loadedHLC: {}, loadedVol: {},
    state: { sigMaps: null }, filterRange: data => data, CUSTOM_COLORS: ['#e879f9', '#34d399'],
    PALETTE: {}, mob: () => false, chipPicker() {}, setTimeout() {}, clearTimeout() {},
    echarts: { init: () => chart },
    document: {
      getElementById: id => id === 'ma-picker' ? { addEventListener: (_, fn) => { click = fn; } }
        : ({ 'ma-select': select, 'ma-custom': custom, status, 'fear-toggle': fearToggle })[id] ?? null,
      querySelectorAll: () => chips, querySelector: () => null,
    },
  };
  vm.createContext(ctx);
  vm.runInContext(code.replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '').replace(/\bexport /g, ''), ctx);
  return { ctx, chart, maActive, status, fearClick: () => fearHandlers.get('click')(), click: n => click({ target: chips.find(c => +c.dataset.ma === n) }),
    pick: v => { select.value = String(v); select.l.get('change')(); },
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

// The legacy fixture labels the volatility axis "VIX"; it now hosts VIX and VXN.
// It also predates axis hiding (axes with no plotted series now carry `show: false`) and
// width-aware grid margins (grid.left/right now follow the visible axes). Both are
// presentation only: drop exactly those fields so everything else must stay identical.
// Independent expectation for the default (QQQ only) state: one visible left axis, nothing on the
// right. Left = tick + gap + widest end label + ".0" + pad (or half the axis name), right = floor.
const expectedDefaultGrid = () => {
  const w = text => String(text).length * 12 * 0.62; // the test environment's text-width fallback
  const values = rows.map(r => r[1]);
  const lo = Math.floor(Math.min(...values) * 0.9), hi = Math.ceil(Math.max(...values) * 1.1);
  const labels = 5 + 8 + Math.max(w(lo.toLocaleString('en-US')), w(hi.toLocaleString('en-US'))) + w('.0') + 4;
  return { left: Math.ceil(Math.max(labels, w('USD Price') / 2 + 2)), right: 8 };
};
const sameAxisNames = option => {
  const o = plain(option);
  o.yAxis[1].name = 'VIX';
  for (const axis of o.yAxis) if (axis.show === false) delete axis.show;
  delete o.grid.left; delete o.grid.right;
  return o;
};

test('select offers MA150 among single-choice presets, initial OFF and existing legend policy', () => {
  const picker = html.match(/id="ma-picker"[\s\S]*?<\/div>/)[0];
  assert.deepEqual([...picker.matchAll(/<option value="(\d+)"/g)].map(m => +m[1]), [20, 50, 100, 125, 150, 200, 300]);
  assert.doesNotMatch(picker, /selected/);
  const h = harness(); h.render();
  assert.equal(h.maActive.size, 0);
  assert.equal(h.chart.option.series.some(s => s.name.startsWith('__ma_')), false);
  h.pick(150);
  assert.deepEqual(plain(h.chart.option.series.find(s => s.name === '__ma_QQQ_150').data), oracle(rows, 150));
  assert.equal(h.chart.option.legend.data.some(n => n.startsWith('__ma_')), false);
  h.pick('');
  assert.equal(h.chart.option.series.some(s => s.name === '__ma_QQQ_150'), false);
});

test('single selection matches legacy per period and repeated switching keeps series, zoom, legend and fixed MA200 signals', () => {
  const h = harness(), old = harness(legacy);
  h.render(); old.render();
  assert.deepEqual(sameAxisNames(h.chart.option), sameAxisNames(old.chart.option));
  const grid = () => ({ left: h.chart.option.grid.left, right: h.chart.option.grid.right });
  assert.deepEqual(grid(), expectedDefaultGrid(), 'default grid margins are the computed ones, not just "ignored"');
  assert.ok(grid().left < old.chart.option.grid.left && grid().right < old.chart.option.grid.right, 'tighter than the legacy fixed 115/160');
  // The legacy fixture predates MA150, so it is the oracle only for 20/50/200.
  for (const n of [20, 50, 200]) {
    h.pick(n); old.click(n);
    assert.deepEqual(sameAxisNames(h.chart.option), sameAxisNames(old.chart.option));
    assert.deepEqual(grid(), expectedDefaultGrid(), `MA${n} leaves the margins unchanged`);
    old.click(n);
  }
  h.pick('');
  const existing = plain(h.chart.option.series);
  h.chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 0, start: 25, end: 80 });
  h.chart.dispatchAction({ type: 'legendUnSelect', name: 'QQQ' });
  for (let i = 0; i < 8; i++) {
    h.pick(i % 2 === 0 ? 150 : '');
    assert.equal(h.chart.option.series.filter(s => s.name.startsWith('__ma_')).length, i % 2 === 0 ? 1 : 0);
    assert.deepEqual(plain(h.chart.option.series.filter(s => !s.name.startsWith('__ma_'))), existing);
    assert.equal(h.chart.option.dataZoom[0].start, 25);
    assert.equal(h.chart.option.dataZoom[0].end, 80);
    assert.equal(h.chart.option.legend.selected.QQQ, false);
  }
  assert.deepEqual(h.signal(), old.signal());
});

test('y axes without a plotted series are hidden; declarations, offsets and min/max stay', () => {
  const h = harness(); h.render();
  const shown = () => [...h.chart.option.yAxis].map(a => a.show !== false);
  assert.deepEqual(shown(), [true, false, false, false, false], 'only QQQ is active: price axis only');
  const declare = () => [...h.chart.option.yAxis].map(a => [a.id, a.name, a.position, a.offset, typeof a.min, typeof a.max]);
  const declared = declare();
  h.ctx.SERIES.push({ key: 'BTC', color: '#f7931a', yAxis: 4 }, { key: 'TWII', color: '#3fb950', yAxis: 3 });
  h.ctx.loaded.BTC = rows; h.ctx.loaded.TWII = rows;
  h.ctx.active.add('BTC'); h.render();
  assert.deepEqual(shown(), [true, false, false, false, true], 'BTC chip on: BTC axis appears');
  h.ctx.active.add('TWII'); h.render();
  assert.deepEqual(shown(), [true, false, false, true, true], 'TWII chip on: TWD axis appears');
  h.ctx.active.delete('BTC'); h.ctx.active.delete('TWII'); h.render();
  assert.deepEqual(shown(), [true, false, false, false, false], 'chips off: axes hidden again');
  assert.deepEqual(declare(), declared);
});

const ticker = () => {
  const h = harness(); h.render();
  h.ctx.renderSeriesPicker = () => {};
  return h;
};

test('typing a built-in code that is not loaded yet loads it, shows it and overwrites an old error', async () => {
  const h = ticker();
  h.ctx.SERIES.push({ key: 'VOO', color: '#58a6ff', yAxis: 0 });
  const loads = [];
  h.ctx.loadSeries = async s => { loads.push(s.key); h.ctx.loaded[s.key] = rows; };
  h.status.textContent = '⚠ 找不到代號 ZZZ（本地無資料，Yahoo 也查無此代號）';
  assert.equal(h.ctx.active.has('VOO'), false);
  await h.ctx.loadCustomTicker('voo');
  assert.deepEqual([...loads], ['VOO']);
  assert.equal(h.status.textContent, '已顯示 VOO');
  assert.equal(h.ctx.active.has('VOO'), true);
  assert.ok([...h.chart.option.series].some(s => s.name === 'VOO' && s.data.length > 0), 'series is in the chart option');
});

test('a failed built-in load reports a plain reason, keeps the chip off and never prints a URL', async () => {
  const h = ticker();
  h.ctx.SERIES.push({ key: 'VOO', color: '#58a6ff', yAxis: 0 });
  h.ctx.loadSeries = async () => { throw new Error('VOO: HTTP 500'); };
  await h.ctx.loadCustomTicker('VOO');
  assert.equal(h.status.textContent, '⚠ 無法載入 VOO：伺服器回應 500');
  assert.equal(h.ctx.active.has('VOO'), false);
  h.ctx.loadSeries = async s => { h.ctx.loaded[s.key] = rows; };
  await h.ctx.loadCustomTicker('VOO');
  assert.equal(h.status.textContent, '已顯示 VOO', 'next load action overwrites the old error');
});

test('typing an existing custom code re-enables it and overwrites the status', async () => {
  const h = ticker();
  h.ctx.customSeries.push({ key: 'ABC', color: '#e879f9', yAxis: 0, custom: true });
  h.ctx.loaded.ABC = rows;
  h.status.textContent = '⚠ 無法載入 X：伺服器回應 500';
  await h.ctx.loadCustomTicker('abc');
  assert.equal(h.status.textContent, '已顯示 ABC');
  assert.ok([...h.chart.option.series].some(s => s.name === 'ABC'));
});

test('unknown code: 404 locally and at /api/stock is a plain not-found message', async () => {
  const h = ticker();
  const calls = [];
  h.ctx.requestJSON = async url => { calls.push(url); throw new Error(`${url}: HTTP 404`); };
  await h.ctx.loadCustomTicker('zzzz');
  assert.deepEqual([...calls], ['data/ZZZZ.json', '/api/stock?ticker=ZZZZ']);
  assert.equal(h.status.textContent, '⚠ 找不到代號 ZZZZ（本地無資料，Yahoo 也查無此代號）');
});

// ── load-failure wording: every status writer, every error type ─────────────
const kinds = {
  http404: { make: () => new Error('data/X.json: HTTP 404'), reason: '伺服器回應 404' },
  http500: { make: () => new Error('/api/stock?ticker=X: HTTP 500'), reason: '伺服器回應 500' },
  timeout: { make: () => Object.assign(new Error('data/X.json: request timed out after 15000ms'), { cause: { name: 'AbortError' } }), reason: '連線逾時' },
  network: { make: () => new Error('data/X.json: Failed to fetch', { cause: new TypeError('Failed to fetch') }), reason: '網路連線失敗' },
  json: { make: () => new Error('data/X.json: invalid JSON', { cause: new SyntaxError('Unexpected token <') }), reason: '資料格式錯誤' },
  incomplete: { make: () => new Error('X: missing or empty data rows'), reason: '資料內容不完整' },
};
const unknownWithUrl = () => new Error('boom while fetching https://example.test/api/stock?ticker=X exploded');
const noLeak = text => assert.doesNotMatch(text, /\/|http|\?ticker=/i, text);
const sources = {
  'ticker box (not in data)': async (h, err) => {
    h.ctx.requestJSON = async () => { throw err; };
    await h.ctx.loadCustomTicker('qq1');
    return 'QQ1';
  },
  'ticker box (built-in)': async (h, err) => {
    h.ctx.SERIES.push({ key: 'VOO', color: '#58a6ff', yAxis: 0 });
    h.ctx.loadSeries = async () => { throw err; };
    await h.ctx.loadCustomTicker('voo');
    return 'VOO';
  },
  'chip click': async (h, err) => {
    h.ctx.SERIES.push({ key: 'VOO', color: '#58a6ff', yAxis: 0 });
    h.ctx.loadSeries = async () => { throw err; };
    const chips = [];
    const node = () => ({ style: {}, dataset: {}, appendChild() {}, set textContent(v) { this.text = v; } });
    const original = h.ctx.document.getElementById;
    h.ctx.document.createElement = node;
    h.ctx.document.createTextNode = text => ({ text });
    h.ctx.document.getElementById = id => id === 'series-picker' ? { innerHTML: '', appendChild: chip => chips.push(chip) } : original(id);
    h.ctx.renderSeriesPicker();
    await chips.find(chip => chip.text === 'VOO').onclick();
    return 'VOO';
  },
  'TREND_EXTRA chip click (VXN)': async (h, err) => {
    h.ctx.loadSeries = async () => { throw err; };
    const chips = [];
    const node = () => ({ style: {}, dataset: {}, appendChild() {}, set textContent(v) { this.text = v; } });
    const original = h.ctx.document.getElementById;
    h.ctx.document.createElement = node;
    h.ctx.document.createTextNode = text => ({ text });
    h.ctx.document.getElementById = id => id === 'series-picker' ? { innerHTML: '', appendChild: chip => chips.push(chip) } : original(id);
    h.ctx.renderSeriesPicker();
    await chips.find(chip => chip.text === 'VXN').onclick();
    return 'VXN';
  },
  'fear toggle': async (h, err) => {
    h.ctx.ensureLoaded = async () => { throw err; };
    await h.fearClick();
    return 'F&G／SPY';
  },
  'FPE toggle': async (h, err) => {
    h.ctx.requestJSON = async () => { throw err; };
    await h.ctx.toggleTrendFpe();
    return '前瞻本益比';
  },
};

for (const [name, run] of Object.entries(sources)) {
  test(`${name}: plain wording per error type, no URL or raw message`, async () => {
    for (const [kind, { make, reason }] of Object.entries(kinds)) {
      const h = harness(); h.render();
      h.status.textContent = '舊訊息';
      const subject = await run(h, make());
      let expected = `⚠ 無法載入 ${subject}：${reason}`;
      // Both the local file and /api/stock answering 404 is the only "not found" (ticker box only).
      if (kind === 'http404' && name === 'ticker box (not in data)') expected = `⚠ 找不到代號 ${subject}（本地無資料，Yahoo 也查無此代號）`;
      assert.equal(h.status.textContent, expected, `${name} / ${kind}`);
      noLeak(h.status.textContent);
    }
    const h = harness(); h.render();
    const subject = await run(h, unknownWithUrl());
    assert.equal(h.status.textContent, `⚠ 載入 ${subject} 失敗，請稍後再試`);
    noLeak(h.status.textContent);
    const aborted = harness(); aborted.render();
    aborted.status.textContent = '舊訊息';
    await run(aborted, new DOMException('Request aborted', 'AbortError'));
    assert.equal(aborted.status.textContent, '舊訊息', 'a cancelled request shows no error');
    // requestJSON wraps a fetch abort as "<label>: <message>" with the AbortError as cause
    const wrapped = harness(); wrapped.render();
    wrapped.status.textContent = '舊訊息';
    await run(wrapped, Object.assign(new Error('data/X.json: The operation was aborted.'), { cause: { name: 'AbortError' } }));
    assert.equal(wrapped.status.textContent, '舊訊息', 'a wrapped abort is silent too');
  });
}

test('ticker box: "not found" needs both requests to be 404; other combinations stay plain', async () => {
  const combos = [
    [() => new Error('data/Q.json: HTTP 404'), () => new Error('/api/stock?ticker=Q: HTTP 502'), '⚠ 無法載入 Q：伺服器回應 502'],
    [() => new Error('data/Q.json: HTTP 404'), () => Object.assign(new Error('/api/stock?ticker=Q: request timed out after 15000ms'), { cause: { name: 'AbortError' } }), '⚠ 無法載入 Q：連線逾時'],
    [() => new Error('data/Q.json: HTTP 500'), () => new Error('/api/stock?ticker=Q: HTTP 404'), '⚠ 無法載入 Q：伺服器回應 500'],
    [() => new Error('data/Q.json: HTTP 404'), () => new Error('/api/stock?ticker=Q: HTTP 404'), '⚠ 找不到代號 Q（本地無資料，Yahoo 也查無此代號）'],
  ];
  for (const [local, api, expected] of combos) {
    const h = ticker();
    h.ctx.requestJSON = async url => { throw url.startsWith('data/') ? local() : api(); };
    await h.ctx.loadCustomTicker('q');
    assert.equal(h.status.textContent, expected);
    noLeak(h.status.textContent);
  }
});

// ── latest submit wins the status line ──────────────────────────────────────
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tickerRows = [{ date: '2026-01-02', close: 10, high: 11, low: 9, volume: 5 }, { date: '2026-01-05', close: 11, high: 12, low: 10, volume: 6 }];

test('slow A then fast B: A failing late cannot overwrite B\'s status', async () => {
  const h = ticker();
  h.ctx.SERIES.push({ key: 'GLD', color: '#d4a843', yAxis: 0 });
  h.ctx.loadSeries = async s => { h.ctx.loaded[s.key] = rows; };
  const slow = deferred();
  h.ctx.requestJSON = async url => url === 'data/AAA.json' ? slow.promise : (() => { throw new Error(`${url}: HTTP 404`); })();
  const a = h.ctx.loadCustomTicker('aaa');
  assert.equal(h.status.textContent, '載入 AAA 中…');
  await h.ctx.loadCustomTicker('gld');
  assert.equal(h.status.textContent, '已顯示 GLD');
  slow.reject(new Error('data/AAA.json: HTTP 404')); // then /api/stock 404 too: a late "not found"
  await a;
  assert.equal(h.status.textContent, '已顯示 GLD', 'late failure of A is not shown');
});

test('slow A succeeds after B: A still joins the chart, B keeps the status', async () => {
  const h = ticker();
  const slow = deferred();
  h.ctx.requestJSON = async url => url === 'data/AAA.json' ? slow.promise : { data: tickerRows };
  const a = h.ctx.loadCustomTicker('aaa');
  await h.ctx.loadCustomTicker('bbb');
  const statusB = h.status.textContent;
  assert.match(statusB, /^已載入 BBB（2 筆，至 2026-01-05）$/);
  slow.resolve({ data: tickerRows });
  await a;
  assert.equal(h.status.textContent, statusB, 'B status untouched by A completion');
  assert.ok(h.ctx.customSeries.some(c => c.key === 'AAA') && h.ctx.active.has('AAA'), 'A was requested, so it is added');
  assert.ok([...h.chart.option.series].some(s => s.name === 'AAA'), 'and plotted');
  assert.equal(h.ctx.customSeries.filter(c => c.key === 'BBB').length, 1);
});

test('slow A failing after fast B success keeps B\'s success text; same code twice adds one series', async () => {
  const h = ticker();
  const slow = deferred();
  h.ctx.requestJSON = async url => url === 'data/AAA.json' ? slow.promise : { data: tickerRows };
  const a = h.ctx.loadCustomTicker('aaa');
  await h.ctx.loadCustomTicker('bbb');
  slow.reject(new Error('data/AAA.json: HTTP 500'));
  await a;
  assert.match(h.status.textContent, /^已載入 BBB/);
  const h2 = ticker();
  const first = deferred();
  h2.ctx.requestJSON = async () => first.promise;
  const p1 = h2.ctx.loadCustomTicker('dup'), p2 = h2.ctx.loadCustomTicker('dup');
  first.resolve({ data: tickerRows });
  await Promise.all([p1, p2]);
  assert.equal(h2.ctx.customSeries.filter(c => c.key === 'DUP').length, 1);
});

test('grid margins follow the visible axes: every outer axis fits, default layout gets tighter', () => {
  const h = harness();
  h.render();
  const base = plain(h.chart.option.grid);
  assert.ok(base.left <= 115 && base.right <= 160, `default QQQ-only margins ${base.left}/${base.right} never exceed the old fixed ones`);
  assert.ok(base.right < 160, 'idle right-hand space shrinks');
  const big = rows.map(([d, v]) => [d, v * 1000]);
  h.ctx.SERIES.push({ key: 'VIX', color: '#f0883e', yAxis: 1 }, { key: 'F&G', color: '#e3b341', yAxis: 2 },
    { key: '0050', color: '#3fb950', yAxis: 3 }, { key: 'BTC', color: '#f7931a', yAxis: 4 });
  for (const key of ['VIX', 'F&G', '0050', 'BTC']) { h.ctx.loaded[key] = key === 'BTC' ? big : rows; h.ctx.active.add(key); }
  h.render();
  const grid = plain(h.chart.option.grid), axes = [...h.chart.option.yAxis];
  const width = text => String(text).length * 12 * 0.62; // the test environment's conservative fallback
  assert.ok(grid.right >= 110 + 13 + width('130,000'), 'BTC (offset 110) labels fit on the right');
  assert.ok(grid.left >= 70 + 13 + width('100'), 'TWD (offset 70) labels fit on the left');
  assert.deepEqual([...axes].map(a => a.show !== false), [true, true, true, true, true]);
});

// ── same-code races and a "loading…" line that must never be left behind ────
const rowsAt = close => [{ date: '2026-01-02', close, high: close + 1, low: close - 1, volume: 5 },
  { date: '2026-01-05', close, high: close + 1, low: close - 1, volume: 6 }];

test('same code twice: the older, slower request cannot overwrite the newer rows', async () => {
  const h = ticker();
  const slow = deferred();
  let calls = 0;
  h.ctx.requestJSON = async () => (++calls === 1 ? slow.promise : { data: rowsAt(20) });
  const a = h.ctx.loadCustomTicker('same');
  const b = h.ctx.loadCustomTicker('same');
  await b;
  const statusB = h.status.textContent;
  assert.equal(statusB, '已載入 SAME（2 筆，至 2026-01-05）');
  assert.equal(h.ctx.loaded.SAME.at(-1)[1], 20);
  slow.resolve({ data: rowsAt(10) });
  await a;
  assert.equal(h.ctx.loaded.SAME.at(-1)[1], 20, 'close stays at the newer 20');
  assert.equal(h.ctx.loadedHLC.SAME.at(-1)[3], 20);
  assert.equal(h.ctx.loadedVol.SAME.at(-1)[1], 6);
  assert.equal(h.status.textContent, statusB, 'status still describes the data that is shown');
  assert.equal(h.ctx.customSeries.filter(c => c.key === 'SAME').length, 1);
});

test('same code, strict latest-wins: newer fails, older arrives late and succeeds -> nothing is committed', async () => {
  const h = ticker();
  const slow = deferred();
  let calls = 0;
  h.ctx.requestJSON = async () => { if (++calls === 1) return slow.promise; throw new Error('data/SAME.json: HTTP 500'); };
  const a = h.ctx.loadCustomTicker('same');
  await h.ctx.loadCustomTicker('same');
  const statusB = h.status.textContent;
  assert.equal(statusB, '⚠ 無法載入 SAME：伺服器回應 500');
  slow.resolve({ data: rowsAt(10) });
  await a;
  assert.equal(h.ctx.loaded.SAME, undefined, 'no old rows appear after the newer request failed');
  assert.equal(h.ctx.loadedHLC.SAME, undefined);
  assert.equal(h.ctx.loadedVol.SAME, undefined);
  assert.equal(h.ctx.customSeries.some(c => c.key === 'SAME'), false, 'no new series');
  assert.equal(h.ctx.active.has('SAME'), false);
  assert.equal([...h.chart.option.series].some(s => s.name === 'SAME'), false);
  assert.equal(h.status.textContent, statusB, 'status is still the newer request\'s error, consistent with the chart');
});

test('same code, strict latest-wins: the newer request is cancelled, older succeeds -> not committed either', async () => {
  const h = ticker();
  const slow = deferred();
  let calls = 0;
  h.status.textContent = '舊訊息';
  h.ctx.requestJSON = async () => { if (++calls === 1) return slow.promise; throw new DOMException('Request aborted', 'AbortError'); };
  const a = h.ctx.loadCustomTicker('same');
  await h.ctx.loadCustomTicker('same');
  slow.resolve({ data: rowsAt(10) });
  await a;
  assert.equal(h.ctx.loaded.SAME, undefined);
  assert.doesNotMatch(h.status.textContent, /載入 .* 中…/);
});

test('A loading, B submitted then cancelled, A succeeds: status ends on A\'s result, never "loading"', async () => {
  const h = ticker();
  const slow = deferred();
  h.status.textContent = '舊訊息';
  h.ctx.requestJSON = async url => {
    if (url === 'data/AAA.json') return slow.promise;
    throw new DOMException('Request aborted', 'AbortError');
  };
  const a = h.ctx.loadCustomTicker('aaa');
  assert.equal(h.status.textContent, '載入 AAA 中…');
  await h.ctx.loadCustomTicker('bbb');
  assert.equal(h.status.textContent, '載入 AAA 中…', 'cancelled B hands the line back to the still-running A');
  slow.resolve({ data: rowsAt(10) });
  await a;
  assert.equal(h.status.textContent, '已載入 AAA（2 筆，至 2026-01-05）');
});

test('A loading, B cancelled, A fails: status is A\'s error; only cancellations: back to the old text', async () => {
  const h = ticker();
  const slow = deferred();
  h.status.textContent = '舊訊息';
  h.ctx.requestJSON = async url => {
    if (url === 'data/AAA.json') return slow.promise;
    throw new DOMException('Request aborted', 'AbortError');
  };
  const a = h.ctx.loadCustomTicker('aaa');
  await h.ctx.loadCustomTicker('bbb');
  slow.reject(new Error('data/AAA.json: HTTP 500'));
  await a;
  assert.equal(h.status.textContent, '⚠ 無法載入 AAA：伺服器回應 500');

  const g = ticker();
  g.status.textContent = '舊訊息';
  g.ctx.requestJSON = async () => { throw new DOMException('Request aborted', 'AbortError'); };
  await Promise.all([g.ctx.loadCustomTicker('c1'), g.ctx.loadCustomTicker('c2')]);
  assert.equal(g.status.textContent, '舊訊息', 'nothing reported, nothing left behind');
});

test('every completion order of two overlapping requests ends without "loading…"', async () => {
  const outcomes = { ok: () => ({ data: rowsAt(10) }), fail: () => { throw new Error('data/X.json: HTTP 500'); }, abort: () => { throw new DOMException('Request aborted', 'AbortError'); } };
  for (const first of Object.keys(outcomes)) for (const second of Object.keys(outcomes)) for (const order of ['AB', 'BA']) {
    const h = ticker();
    h.status.textContent = '舊訊息';
    const gate = { a: deferred(), b: deferred() };
    h.ctx.requestJSON = async url => (url === 'data/AAA.json' ? gate.a.promise : gate.b.promise);
    const settle = (g, kind) => { try { g.resolve(outcomes[kind]()); } catch (e) { g.reject(e); } };
    const a = h.ctx.loadCustomTicker('aaa'), b = h.ctx.loadCustomTicker('bbb');
    for (const which of order) settle(gate[which.toLowerCase()], which === 'A' ? first : second);
    await Promise.all([a, b]);
    assert.doesNotMatch(h.status.textContent, /載入 .* 中…/, `${first}/${second}/${order}: ${h.status.textContent}`);
  }
});

// ── three overlapping ticker requests: named interleavings + exhaustive check ─────────────
// Rule under test (written here independently of the implementation): per busy period the
// request with the highest sequence number that is not silent decides #status - "loading…"
// while pending, its message once final; all silent -> the baseline. A request is silent when
// cancelled, or (once settled) when a newer request for the same code exists. Data: only the
// newest request for a code may commit.
const oneRow = (close, date) => ({ data: [{ date, close, high: close + 1, low: close - 1, volume: 1 }] });
const dateOf = i => `2026-01-0${i + 2}`;
const closeOf = i => 10 * (i + 1);
const okText = (code, i) => `已載入 ${code}（1 筆，至 ${dateOf(i)}）`;
const failText = code => `⚠ 無法載入 ${code}：伺服器回應 500`;

async function interleave(codes, completions, { onStep } = {}) {
  const h = ticker();
  h.status.textContent = 'BASE';
  const gates = codes.map(() => deferred());
  let call = 0;
  h.ctx.requestJSON = () => gates[call++].promise;
  const tasks = [], seen = [];
  for (const code of codes) { tasks.push(h.ctx.loadCustomTicker(code)); seen.push(h.status.textContent); }
  const steps = [];
  for (const [i, outcome] of completions) {
    if (outcome === 'success') gates[i].resolve(oneRow(closeOf(i), dateOf(i)));
    else if (outcome === 'fail') gates[i].reject(new Error(`data/${codes[i]}.json: HTTP 500`));
    else gates[i].reject(new DOMException('Request aborted', 'AbortError'));
    await tasks[i];
    steps.push({ status: h.status.textContent, active: [...h.ctx.active].filter(k => k !== 'QQQ').sort(),
      close: Object.fromEntries(Object.entries(h.ctx.loaded).filter(([k]) => !['QQQ', 'F&G'].includes(k)).map(([k, v]) => [k, v.at(-1)[1]])) });
  }
  return { h, seen, steps };
}

// Independent oracle.
function ruleOracle(codes, completions) {
  const outcomeOf = new Map(completions.map(([i, o]) => [i, o]));
  const statusAfter = done => {
    let best = -1;
    codes.forEach((code, i) => {
      const finished = done.has(i);
      const silent = finished && (outcomeOf.get(i) === 'abort' || codes.some((c, j) => j > i && c === code));
      if (!silent) best = i;
    });
    if (best < 0) return 'BASE';
    if (!done.has(best)) return `載入 ${codes[best]} 中…`;
    return outcomeOf.get(best) === 'success' ? okText(codes[best], best) : failText(codes[best]);
  };
  const dataAfter = done => {
    const active = [], close = {};
    for (const code of new Set(codes)) {
      const latest = codes.map((c, i) => (c === code ? i : -1)).filter(i => i >= 0).at(-1);
      if (done.has(latest) && outcomeOf.get(latest) === 'success') { active.push(code); close[code] = closeOf(latest); }
    }
    return { active: active.sort(), close };
  };
  const seen = codes.map((_, k) => `載入 ${codes[k]} 中…`); // each submit shows the newest request's line
  const done = new Set(), steps = [];
  for (const [i] of completions) { done.add(i); steps.push({ status: statusAfter(done), ...dataAfter(done) }); }
  return { seen, steps };
}

const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
const outcomesAll = ['success', 'fail', 'abort'];

test('three overlapping requests: every outcome x every completion order x same/different codes (324 cases) follows the rule', async () => {
  let cases = 0;
  for (const codes of [['AAA', 'BBB', 'CCC'], ['AAA', 'AAA', 'BBB']]) {
    for (const order of orders) for (const a of outcomesAll) for (const b of outcomesAll) for (const c of outcomesAll) {
      const outs = [a, b, c];
      const completions = order.map(i => [i, outs[i]]);
      const { seen, steps, h } = await interleave(codes, completions);
      const expected = ruleOracle(codes, completions);
      const label = `${codes.join('/')} order ${order} outcomes ${outs}`;
      assert.deepEqual(seen, expected.seen, `${label}: status after each submit`);
      steps.forEach((step, k) => {
        assert.equal(step.status, expected.steps[k].status, `${label}: status after step ${k + 1}`);
        assert.deepEqual(step.active, expected.steps[k].active, `${label}: active after step ${k + 1}`);
        assert.deepEqual(step.close, expected.steps[k].close, `${label}: rows after step ${k + 1}`);
      });
      assert.doesNotMatch(h.status.textContent, /載入 .* 中…/, `${label}: nothing is pending, so no "loading…"`);
      assert.equal(h.ctx.customSeries.length, new Set(h.ctx.customSeries.map(s => s.key)).size, `${label}: one series per code`);
      cases++;
    }
  }
  assert.equal(cases, 324);
});

test('interleaving #1: C cancelled, B succeeds, A succeeds late -> B\'s success', async () => {
  const { steps } = await interleave(['AAA', 'BBB', 'CCC'], [[2, 'abort'], [1, 'success'], [0, 'success']]);
  assert.deepEqual(steps.map(s => s.status), ['載入 BBB 中…', okText('BBB', 1), okText('BBB', 1)]);
  assert.deepEqual(steps.at(-1).active, ['AAA', 'BBB'], 'both codes were requested, so both are plotted');
});

test('interleaving #2: C cancelled, newer AAA fails, older AAA succeeds late -> the newer failure, no rows', async () => {
  const { steps } = await interleave(['AAA', 'AAA', 'BBB'], [[2, 'abort'], [1, 'fail'], [0, 'success']]);
  assert.deepEqual(steps.map(s => s.status), ['載入 AAA 中…', failText('AAA'), failText('AAA')]);
  assert.deepEqual(steps.at(-1).active, []);
  assert.deepEqual(steps.at(-1).close, {});
});

test('interleaving #3: C(BBB) succeeds, B cancelled, A succeeds late -> C\'s success; AAA never appears', async () => {
  const { steps } = await interleave(['AAA', 'AAA', 'BBB'], [[2, 'success'], [1, 'abort'], [0, 'success']]);
  assert.deepEqual(steps.map(s => s.status), Array(3).fill(okText('BBB', 2)));
  assert.deepEqual(steps.at(-1).active, ['BBB']);
});

test('interleaving #4: A succeeds, C cancelled, B cancelled -> A\'s success (not the baseline)', async () => {
  const { steps } = await interleave(['AAA', 'BBB', 'CCC'], [[0, 'success'], [2, 'abort'], [1, 'abort']]);
  assert.deepEqual(steps.map(s => s.status), ['載入 CCC 中…', '載入 BBB 中…', okText('AAA', 0)]);
  assert.deepEqual(steps.at(-1).active, ['AAA'], 'the data on the chart and the status agree');
});

test('same code whose older request falls back to the API: newer rows win, one series', async () => {
  const h = ticker();
  let finishOldApi, localCalls = 0;
  h.ctx.requestJSON = url => {
    if (url === 'data/DUP.json') return ++localCalls === 1 ? Promise.reject(new Error('data/DUP.json: HTTP 404')) : Promise.resolve(oneRow(20, '2026-01-03'));
    return new Promise(resolve => { finishOldApi = resolve; });
  };
  const old = h.ctx.loadCustomTicker('DUP');
  await new Promise(resolve => setImmediate(resolve));
  await h.ctx.loadCustomTicker('DUP');
  const after = h.status.textContent;
  assert.equal(after, '已載入 DUP（1 筆，至 2026-01-03）');
  finishOldApi(oneRow(10, '2026-01-02'));
  await old;
  assert.equal(h.ctx.loaded.DUP.at(-1)[1], 20);
  assert.equal(h.status.textContent, after);
  assert.equal(h.ctx.customSeries.filter(s => s.key === 'DUP').length, 1);
});

// ── chip / FPE / fear errors take part in the same status rule ────────────────────────────
// A load error is an immediately final participant numbered when it is reported; a cancelled
// load (AbortError) is silent and takes no number. While a ticker request is pending, the
// participant with the highest number that is not silent decides #status.
const chipError = h => h.ctx.showLoadError('VIX', new Error('data/VIX.json: HTTP 500'));
const vixText = '⚠ 無法載入 VIX：伺服器回應 500';

test('chip error during a ticker busy period is not overwritten when the ticker completes', async () => {
  const h = ticker(); h.status.textContent = 'BASE';
  const gate = deferred();
  h.ctx.requestJSON = () => gate.promise;
  const a = h.ctx.loadCustomTicker('AAA');
  assert.equal(h.status.textContent, '載入 AAA 中…');
  chipError(h);
  assert.equal(h.status.textContent, vixText);
  gate.resolve(oneRow(10, '2026-01-02'));
  await a;
  assert.equal(h.status.textContent, vixText, 'the later error stays visible');
  assert.ok(h.ctx.active.has('AAA') && h.ctx.loaded.AAA.at(-1)[1] === 10, 'the ticker data was still committed');
});

test('chip error with no ticker pending is written directly and is the next baseline', async () => {
  const h = ticker(); h.status.textContent = 'BASE';
  chipError(h);
  assert.equal(h.status.textContent, vixText);
  h.ctx.requestJSON = async () => { throw new DOMException('Request aborted', 'AbortError'); };
  await h.ctx.loadCustomTicker('zzz'); // only cancelled: back to the baseline, which is the error
  assert.equal(h.status.textContent, vixText);
});

test('a ticker submitted after a chip error shows its own progress and result', async () => {
  const h = ticker(); h.status.textContent = 'BASE';
  const gateA = deferred();
  h.ctx.requestJSON = url => (url === 'data/AAA.json' ? gateA.promise : { data: oneRow(30, '2026-01-04').data });
  const a = h.ctx.loadCustomTicker('AAA');
  chipError(h);
  const b = h.ctx.loadCustomTicker('BBB'); // newer than the error
  assert.equal(h.status.textContent, '載入 BBB 中…');
  await b;
  assert.equal(h.status.textContent, okText('BBB', 2), 'B result');
  gateA.resolve(oneRow(10, '2026-01-02'));
  await a;
  assert.equal(h.status.textContent, '已載入 BBB（1 筆，至 2026-01-04）');
  // and once nothing is pending, a new chip error is written directly again
  chipError(h);
  assert.equal(h.status.textContent, vixText);
  const c = h.ctx.loadCustomTicker('CCC');
  await c;
  assert.equal(h.status.textContent, '已載入 CCC（1 筆，至 2026-01-04）', 'error is kept only until the next load action');
});

test('a cancelled chip / FPE / fear load shows nothing and takes no number', async () => {
  const h = ticker(); h.status.textContent = 'BASE';
  const gate = deferred();
  h.ctx.requestJSON = () => gate.promise;
  const a = h.ctx.loadCustomTicker('AAA');
  h.ctx.showLoadError('VIX', new DOMException('Request aborted', 'AbortError'));
  assert.equal(h.status.textContent, '載入 AAA 中…');
  gate.resolve(oneRow(10, '2026-01-02'));
  await a;
  assert.equal(h.status.textContent, '已載入 AAA（1 筆，至 2026-01-02）');
});

// Sol's three "extra" scenarios (four requests, period boundary, chip during busy).
test('extra #1: four requests, newest two cancelled, B fails, A finishes last', async () => {
  const { steps } = await interleave(['AAA', 'BBB', 'CCC', 'DDD'], [[0, 'success'], [3, 'abort'], [2, 'abort'], [1, 'fail']]);
  assert.deepEqual(steps.map(s => s.status), ['載入 DDD 中…', '載入 CCC 中…', '載入 BBB 中…', failText('BBB')]);
  assert.deepEqual(steps.at(-1).active, ['AAA']);
});

test('extra #2: a final message becomes the next period\'s baseline', async () => {
  const h = ticker(); h.status.textContent = 'BASE';
  const gates = [deferred(), deferred(), deferred()];
  let call = 0; h.ctx.requestJSON = () => gates[call++].promise;
  const a = h.ctx.loadCustomTicker('AAA'); gates[0].resolve(oneRow(10, '2026-01-02')); await a;
  const afterA = h.status.textContent;
  const b = h.ctx.loadCustomTicker('BBB'); assert.equal(h.status.textContent, '載入 BBB 中…');
  gates[1].reject(new DOMException('x', 'AbortError')); await b;
  assert.equal(h.status.textContent, afterA);
  const c = h.ctx.loadCustomTicker('CCC'); gates[2].reject(new DOMException('x', 'AbortError')); await c;
  assert.equal(h.status.textContent, afterA);
  assert.equal(afterA, '已載入 AAA（1 筆，至 2026-01-02）');
});

test('extra #3 (rule changed): chip error during busy keeps its error after the ticker completes', async () => {
  const h = ticker(); h.status.textContent = 'BASE';
  const gate = deferred(); h.ctx.requestJSON = () => gate.promise;
  const a = h.ctx.loadCustomTicker('AAA');
  chipError(h);
  const afterChip = h.status.textContent;
  gate.resolve(oneRow(10, '2026-01-02')); await a;
  assert.equal(afterChip, vixText);
  assert.equal(h.status.textContent, vixText);
  assert.deepEqual([...h.ctx.active].filter(k => k !== 'QQQ'), ['AAA']);
});

// Exhaustive: the 324 ticker interleavings, with one chip error inserted at every one of the
// 7 gaps of the 6-event timeline (3 submits, then 3 completions): 324 x 7 = 2268 runs.
// Independent oracle: same rule, simulated event by event, including busy-period baselines.
function chipOracle(codes, completions, chipAt) {
  const events = [...codes.map((_, i) => ({ t: 'submit', i })), ...completions.map(([i, outcome]) => ({ t: 'settle', i, outcome }))];
  events.splice(chipAt, 0, { t: 'chip' });
  const outcomeOf = new Map(completions.map(([i, o]) => [i, o]));
  let screen = 'BASE', baseline = 'BASE', seq = 0;
  const parts = new Map(), pending = new Set(), out = [];
  const decide = () => {
    let best = null;
    for (const [n, p] of parts) if (p.kind !== 'silent' && (best === null || n > best)) best = n;
    if (best === null) return baseline;
    const p = parts.get(best);
    return p.kind === 'pending' ? p.loading : p.text;
  };
  for (const ev of events) {
    if (ev.t === 'submit') {
      if (!pending.size) { parts.clear(); baseline = screen; }
      parts.set(++seq, { ticker: ev.i, kind: 'pending', loading: `載入 ${codes[ev.i]} 中…` });
      pending.add(ev.i); screen = decide();
    } else if (ev.t === 'settle') {
      const n = [...parts].find(([, p]) => p.ticker === ev.i)[0];
      const superseded = codes.some((c, j) => j > ev.i && c === codes[ev.i]);
      parts.set(n, ev.outcome === 'abort' || superseded ? { ticker: ev.i, kind: 'silent' }
        : { ticker: ev.i, kind: 'final', text: ev.outcome === 'success' ? okText(codes[ev.i], ev.i) : failText(codes[ev.i]) });
      pending.delete(ev.i); screen = decide();
      if (!pending.size) parts.clear();
    } else if (pending.size) {
      parts.set(++seq, { kind: 'final', text: vixText }); screen = decide();
    } else { ++seq; screen = vixText; }
    out.push(screen);
  }
  return out;
}

async function runWithChip(codes, completions, chipAt) {
  const h = ticker(); h.status.textContent = 'BASE';
  const gates = codes.map(() => deferred());
  let call = 0; h.ctx.requestJSON = () => gates[call++].promise;
  const events = [...codes.map((_, i) => ({ t: 'submit', i })), ...completions.map(([i, outcome]) => ({ t: 'settle', i, outcome }))];
  events.splice(chipAt, 0, { t: 'chip' });
  const tasks = [], seen = [];
  for (const ev of events) {
    if (ev.t === 'submit') tasks[ev.i] = h.ctx.loadCustomTicker(codes[ev.i]);
    else if (ev.t === 'chip') chipError(h);
    else {
      if (ev.outcome === 'success') gates[ev.i].resolve(oneRow(closeOf(ev.i), dateOf(ev.i)));
      else if (ev.outcome === 'fail') gates[ev.i].reject(new Error(`data/${codes[ev.i]}.json: HTTP 500`));
      else gates[ev.i].reject(new DOMException('Request aborted', 'AbortError'));
      await tasks[ev.i];
    }
    seen.push(h.status.textContent);
  }
  return { h, seen };
}

test('a chip error inserted at every point of every ticker interleaving follows the rule (2268 runs)', async () => {
  let runs = 0;
  for (const codes of [['AAA', 'BBB', 'CCC'], ['AAA', 'AAA', 'BBB']]) {
    for (const order of orders) for (const a of outcomesAll) for (const b of outcomesAll) for (const c of outcomesAll) {
      const outs = [a, b, c], completions = order.map(i => [i, outs[i]]);
      for (let chipAt = 0; chipAt <= 6; chipAt++) {
        const { h, seen } = await runWithChip(codes, completions, chipAt);
        const label = `${codes.join('/')} order ${order} outcomes ${outs} chip after ${chipAt} events`;
        assert.deepEqual(seen, chipOracle(codes, completions, chipAt), label);
        // data: the chip error never changes what is committed
        const expectedActive = [...new Set(codes)].filter(code => {
          const latest = codes.map((x, i) => (x === code ? i : -1)).filter(i => i >= 0).at(-1);
          return outs[latest] === 'success';
        }).sort();
        assert.deepEqual([...h.ctx.active].filter(k => k !== 'QQQ').sort(), expectedActive, label);
        runs++;
      }
    }
  }
  assert.equal(runs, 2268);
});

// ── #status is only written when its text actually changes ───────────────────────────────
function countWrites(h) {
  const writes = [];
  let value = h.status.textContent;
  Object.defineProperty(h.status, 'textContent', { get: () => value, set: v => { writes.push([value, v]); value = v; } });
  return writes;
}

test('one ticker from submit to settle writes #status once per actual text change', async () => {
  const h = ticker(); h.status.textContent = 'BASE';
  const writes = countWrites(h);
  h.ctx.requestJSON = async () => oneRow(10, '2026-01-02');
  await h.ctx.loadCustomTicker('AAA');
  assert.deepEqual(writes, [['BASE', '載入 AAA 中…'], ['載入 AAA 中…', '已載入 AAA（1 筆，至 2026-01-02）']]);
});

test('no #status write ever repeats the text already shown (overlapping requests, cancellations, chip errors)', async () => {
  for (const [codes, completions, chipAt] of [
    [['AAA', 'BBB', 'CCC'], [[2, 'abort'], [1, 'success'], [0, 'success']], 3],
    [['AAA', 'AAA', 'BBB'], [[2, 'abort'], [1, 'fail'], [0, 'success']], 4],
    [['AAA', 'BBB', 'CCC'], [[0, 'success'], [2, 'abort'], [1, 'abort']], 6],
  ]) {
    const h = ticker(); h.status.textContent = 'BASE';
    const writes = countWrites(h);
    const gates = codes.map(() => deferred());
    let call = 0; h.ctx.requestJSON = () => gates[call++].promise;
    const events = [...codes.map((_, i) => ({ t: 'submit', i })), ...completions.map(([i, outcome]) => ({ t: 'settle', i, outcome }))];
    events.splice(chipAt, 0, { t: 'chip' });
    const tasks = [];
    for (const ev of events) {
      if (ev.t === 'submit') tasks[ev.i] = h.ctx.loadCustomTicker(codes[ev.i]);
      else if (ev.t === 'chip') chipError(h);
      else {
        if (ev.outcome === 'success') gates[ev.i].resolve(oneRow(closeOf(ev.i), dateOf(ev.i)));
        else if (ev.outcome === 'fail') gates[ev.i].reject(new Error(`data/${codes[ev.i]}.json: HTTP 500`));
        else gates[ev.i].reject(new DOMException('Request aborted', 'AbortError'));
        await tasks[ev.i];
      }
    }
    for (const [from, to] of writes) assert.notEqual(from, to, `redundant write of "${to}"`);
  }
});
