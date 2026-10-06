import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../tabs/levvol.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace(/export /g, '');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const days = Array.from({ length: 265 }, (_, i) => new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10));
function fixture(n = 265) {
  let price = 100;
  const under = days.slice(0, n).map((date, i) => {
    price *= Math.exp((i % 7 - 3) / 1000);
    return [date, price];
  });
  return {
    etfs: [{ id: 'TQQQ', underlying: 'QQQ', leverage: 3, real: under.map(([date, p]) => [date, 100 * (p / 100) ** 3]) }],
    underlyings: { QQQ: { data: under } },
  };
}
const response = (bundle = fixture()) => ({ ok: true, json: async () => bundle });
function setup(fetcher = async () => response()) {
  const calls = [], charts = [], diagnostics = [];
  const elements = Object.fromEntries(['tab-levvol', 'levvol-chart', 'levvol-pair', 'levvol-status', 'levvol-table'].map(id => [id, {
    id, dataset: {}, hidden: false, innerHTML: '', textContent: '', disabled: false, listeners: {}, listenerCounts: {},
    addEventListener(name, listener) { this.listeners[name] = listener; this.listenerCounts[name] = (this.listenerCounts[name] || 0) + 1; },
  }]));
  const context = vm.createContext({
    AbortController, DOMException, Promise,
    document: { getElementById: id => elements[id] || null },
    isLight: () => false, tc: dark => dark, mob: () => false, PALETTE: {}, tsToLocalDate: date => date,
    bindOnce: element => { if (!element || element.dataset.built) return false; element.dataset.built = '1'; return true; },
    fetch: (...args) => { calls.push(args); return fetcher(...args); },
    console: { error: (...args) => diagnostics.push(args), warn: (...args) => diagnostics.push(args) },
    setTimeout: () => { throw new Error('First render must not be detached from activation'); },
    echarts: { init: host => {
      const chart = {
        host, renders: 0, clears: 0, disposed: false, options: {},
        resize() {}, dispose() { this.disposed = true; }, clear() { this.clears++; this.options = {}; },
        setOption(option) { this.options = option; this.renders++; },
        getOption() { return this.options; }, getDom() { return host; },
      };
      charts.push(chart); return chart;
    } },
  });
  vm.runInContext(source + '\nglobalThis.api = {init, getCharts, onThemeChange, resize};', context);
  return { api: context.api, elements, calls, charts, diagnostics, fetcher: next => { fetcher = next; } };
}
const status = s => s.elements['levvol-status'].textContent;
const chart = s => s.charts.at(-1);
function assertFailure(s) {
  assert.match(status(s), /Unavailable · 載入失敗/);
  assert.equal(s.elements['levvol-pair'].disabled, true);
  assert.equal(s.elements['levvol-table'].innerHTML, '');
  assert.equal(chart(s).options.series, undefined);
  assert.equal(s.diagnostics.length, 0, 'module propagates error to dispatcher without duplicate diagnostics');
}

test('first activation stays pending until valid chart and table have rendered', async () => {
  const pending = deferred(); const s = setup(() => pending.promise); let done = false;
  const activation = s.api.init().then(() => { done = true; });
  await tick();
  assert.equal(done, false); assert.equal(chart(s).renders, 0);
  assert.match(status(s), /載入槓桿資料中/); assert.equal(s.elements['levvol-pair'].disabled, true);
  pending.resolve(response()); await activation;
  assert.equal(done, true); assert.equal(chart(s).renders, 1);
  assert.match(s.elements['levvol-table'].innerHTML, /單日基準/);
  assert.equal(s.elements['levvol-pair'].disabled, false);
  assert.deepEqual([...s.api.getCharts()], [chart(s)]);
});

for (const [name, fetcher] of [
  ['HTTP', async () => ({ ok: false, status: 503 })],
  ['network', async () => { throw new Error('connection lost'); }],
  ['parse', async () => ({ ok: true, json: async () => { throw new SyntaxError('bad JSON'); } })],
]) {
  test(`${name} failure propagates for dispatcher retry, repeat failure remains retryable, then recovers`, async () => {
    const s = setup(fetcher);
    await assert.rejects(s.api.init()); assertFailure(s);
    await assert.rejects(s.api.init()); assertFailure(s); assert.equal(s.calls.length, 2);
    s.fetcher(async () => response()); await s.api.init();
    assert.equal(s.calls.length, 3); assert.equal(chart(s).renders, 1);
    assert.match(status(s), /TQQQ vs QQQ/); assert.equal(s.elements['levvol-pair'].disabled, false);
  });
}

test('repeated pending activations share one fetch and only latest activation renders', async () => {
  const pending = deferred(); const s = setup(() => pending.promise);
  const activations = [s.api.init(), s.api.init(), s.api.init()]; await tick();
  assert.equal(s.calls.length, 1);
  pending.resolve(response()); await Promise.all(activations);
  assert.equal(chart(s).renders, 1);
});

test('already-aborted or stale invocation cannot supersede an active valid request', async () => {
  const pending = deferred(); const s = setup(() => pending.promise); const valid = s.api.init();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(s.api.init({ signal: controller.signal }), error => error.name === 'AbortError');
  await assert.rejects(s.api.init({ isCurrent: () => false }), error => error.name === 'AbortError');
  pending.resolve(response()); await valid;
  assert.equal(s.calls.length, 1); assert.equal(chart(s).renders, 1);
});

test('naturally unusable parsed payload rolls back data and can retry without adding financial admission rules', async () => {
  const bad = fixture(); delete bad.underlyings;
  const s = setup(async () => response(bad));
  await assert.rejects(s.api.init()); assertFailure(s);
  s.fetcher(async () => response()); await s.api.init();
  assert.equal(s.calls.length, 2); assert.equal(chart(s).renders, 1);
  assert.match(s.elements['levvol-pair'].innerHTML, /TQQQ/);
});

test('failed initial option construction leaves selector bindable so valid retry restores actual pair controls', async () => {
  const bad = fixture(); bad.etfs.push(null);
  const s = setup(async () => response(bad));
  await assert.rejects(s.api.init()); assertFailure(s);
  const select = s.elements['levvol-pair'];
  assert.equal(select.dataset.built, undefined); assert.equal(select.listenerCounts.change, undefined);
  s.fetcher(async () => response()); await s.api.init();
  assert.match(select.innerHTML, /TQQQ \/ QQQ \(3x\)/);
  assert.equal(select.disabled, false); assert.equal(select.listenerCounts.change, 1);
  const listener = select.listeners.change;
  await s.api.init();
  assert.equal(select.listenerCounts.change, 1); assert.equal(select.listeners.change, listener);
  assert.equal(s.calls.length, 2); assert.match(status(s), /TQQQ vs QQQ/);
});

test('failed reentry keeps an existing successful selector binding intact', async () => {
  const s = setup(); await s.api.init();
  const select = s.elements['levvol-pair'], listener = select.listeners.change;
  const setOption = chart(s).setOption;
  chart(s).setOption = () => { throw new Error('chart temporarily unavailable'); };
  await assert.rejects(s.api.init()); assertFailure(s);
  assert.equal(select.dataset.built, '1'); assert.equal(select.listeners.change, listener);
  chart(s).setOption = setOption; await s.api.init();
  assert.equal(select.listenerCounts.change, 1); assert.equal(select.listeners.change, listener);
  assert.equal(s.calls.length, 1); assert.match(status(s), /TQQQ vs QQQ/);
});

test('abort rejects immediately; ignored old network response cannot replace newer successful data', async () => {
  const old = deferred(); const s = setup(() => old.promise); const controller = new AbortController();
  const activation = s.api.init({ signal: controller.signal }); await tick();
  const rejected = assert.rejects(activation, error => error.name === 'AbortError');
  controller.abort(); await rejected;
  assert.equal(s.calls[0][1].signal.aborted, true);
  assert.match(status(s), /Unavailable · 載入中斷，請重試/);
  assert.doesNotMatch(status(s), /載入槓桿資料中/);
  s.fetcher(async () => response()); await s.api.init();
  const text = status(s), table = s.elements['levvol-table'].innerHTML, renders = chart(s).renders;
  const stale = fixture(); stale.etfs[0].leverage = 9;
  old.resolve(response(stale)); await tick();
  assert.equal(status(s), text); assert.equal(s.elements['levvol-table'].innerHTML, table);
  assert.equal(chart(s).renders, renders); assert.equal(s.calls.length, 2);
});

test('superseded consumer abort cannot cancel the newer consumer sharing its request', async () => {
  const pending = deferred(); const s = setup(() => pending.promise); const controller = new AbortController();
  const old = s.api.init({ signal: controller.signal });
  const newest = s.api.init(); await tick(); controller.abort();
  await old; assert.equal(s.calls[0][1].signal.aborted, false);
  assert.match(status(s), /載入槓桿資料中/);
  pending.resolve(response()); await newest;
  assert.equal(s.calls.length, 1); assert.equal(chart(s).renders, 1);
});

test('dispatcher-style timeout clears visible loading helper even when isCurrent becomes false on abort', async () => {
  const pending = deferred(); const s = setup(() => pending.promise); const controller = new AbortController();
  const activation = s.api.init({ signal: controller.signal, isCurrent: () => !controller.signal.aborted });
  await tick(); controller.abort(); await activation;
  assert.match(status(s), /Unavailable · 載入中斷，請重試/);
  assert.equal(chart(s).renders, 0); assert.equal(s.elements['levvol-table'].innerHTML, '');
  s.fetcher(async () => response()); await s.api.init();
  const valid = status(s); pending.resolve(response()); await tick();
  assert.equal(status(s), valid); assert.equal(chart(s).renders, 1);
});

test('hidden active abort does not write unavailable helper or render into hidden page', async () => {
  const pending = deferred(); const s = setup(() => pending.promise); const controller = new AbortController();
  const activation = s.api.init({ signal: controller.signal }); await tick();
  s.elements['tab-levvol'].hidden = true;
  const previous = status(s), rejected = assert.rejects(activation, error => error.name === 'AbortError');
  controller.abort(); await rejected;
  assert.equal(status(s), previous); assert.equal(chart(s).renders, 0);
  s.elements['tab-levvol'].hidden = false; s.fetcher(async () => response()); await s.api.init();
  pending.resolve(response()); await tick(); assert.match(status(s), /TQQQ vs QQQ/);
});

test('stale isCurrent context cannot render/cache; return loads a current response', async () => {
  const pending = deferred(); const s = setup(() => pending.promise); let current = true;
  const old = s.api.init({ isCurrent: () => current }); await tick(); current = false;
  pending.resolve(response()); await old;
  assert.equal(chart(s).renders, 0);
  s.fetcher(async () => response()); await s.api.init(); assert.equal(s.calls.length, 2);
  assert.equal(chart(s).renders, 1);
});

test('route away during load has no hidden commit/render; later return recovers', async () => {
  const pending = deferred(); const s = setup(() => pending.promise);
  const loading = s.api.init(); await tick(); s.elements['tab-levvol'].hidden = true;
  pending.resolve(response()); await loading; assert.equal(chart(s).renders, 0);
  s.elements['tab-levvol'].hidden = false; s.fetcher(async () => response()); await s.api.init();
  assert.equal(chart(s).renders, 1); assert.equal(s.calls.length, 2);
});

test('route returns before pending response: one request completes current visible render', async () => {
  const pending = deferred(); const s = setup(() => pending.promise); const loading = s.api.init();
  await tick(); s.elements['tab-levvol'].hidden = true; s.elements['tab-levvol'].hidden = false;
  pending.resolve(response()); await loading;
  assert.equal(chart(s).renders, 1); assert.equal(s.calls.length, 1);
});

test('cached route reentry resolves only after render, so restored interactions have no late overwrite', async () => {
  const s = setup(); await s.api.init(); await s.api.init();
  const current = chart(s), renders = current.renders;
  current.options.dataZoom[0].start = 37;
  current.options.legend.selected = { 'w=5': false };
  await tick();
  assert.equal(current.renders, renders); assert.equal(current.options.dataZoom[0].start, 37);
  assert.equal(current.options.legend.selected['w=5'], false); assert.equal(s.calls.length, 1);
});

test('theme during delayed load recreates chart without results, then only live instance renders', async () => {
  const pending = deferred(); const s = setup(() => pending.promise); const loading = s.api.init();
  await tick(); s.api.onThemeChange(true);
  assert.equal(s.charts[0].disposed, true); assert.equal(chart(s).renders, 0);
  pending.resolve(response()); await loading;
  assert.equal(s.charts[0].renders, 0); assert.equal(chart(s).renders, 1);
});

test('actual numerical windows/sample counts and population-volatility ratio remain unchanged', async () => {
  const s = setup(); await s.api.init();
  const series = chart(s).options.series;
  assert.deepEqual(Array.from(series, item => item.name), ['w=5', 'w=21', 'w=63', 'w=126', 'w=252']);
  for (const [index, window] of [5, 21, 63, 126, 252].entries()) {
    const observations = series[index].data;
    assert.equal(observations.length, 264);
    assert.equal(observations.filter(([, value]) => value === null).length, window - 1);
    assert.equal(observations.filter(([, value]) => value !== null).length, 265 - window);
    for (const [, value] of observations.slice(window - 1)) assert.ok(Math.abs(value - 3) < 1e-10);
  }
  assert.match(s.elements['levvol-table'].innerHTML, /3\.000/);
  assert.match(status(s), /重疊交易日 264/);
});

test('existing 252+5 overlap boundary remains data-insufficient at256, usable at257', async () => {
  const short = setup(async () => response(fixture(256))); await short.api.init();
  assert.match(status(short), /重疊交易日 < 257 天/); assert.equal(chart(short).renders, 0);
  assert.equal(short.elements['levvol-table'].innerHTML, '');
  const enough = setup(async () => response(fixture(257))); await enough.api.init();
  assert.equal(chart(enough).renders, 1); assert.match(status(enough), /重疊交易日 256/);
});

test('unselected ETF invalid prices and absent underlying do not create whole-bundle gates', async () => {
  const bundle = fixture(); bundle.etfs.push({ id: 'UNSELECTED', underlying: 'MISSING', leverage: 2, real: [[days[0], 0], [days[1], -1]] });
  const s = setup(async () => response(bundle)); await s.api.init();
  assert.equal(chart(s).renders, 1); assert.match(status(s), /TQQQ vs QQQ/);
  s.elements['levvol-pair'].value = 'UNSELECTED'; s.elements['levvol-pair'].listeners.change();
  assert.match(status(s), /UNSELECTED 資料不足/); assert.equal(s.elements['levvol-table'].innerHTML, '');
});
