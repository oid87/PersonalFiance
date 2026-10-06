import assert from 'node:assert/strict';
import test from 'node:test';
import nativeConsole from 'node:console';
import { loaded, loadedHLC, loadedVol } from '../state.js';
import { clearRequestCache, requestJSON } from '../utils/data.js';

const OPTIONAL = 'data/stlfsi_kcfsi.json';
const NFCI = 'data/nfci.json';
const days = Array.from({ length: 70 }, (_, index) => new Date(Date.UTC(2026, 7, index + 1)).toISOString().slice(0, 10));
const nfci = { data: days.map((date, i) => ({ date, nfci: i / 100 - 0.6 })) };
const stress = { data: days.map((date, i) => ({ date, stlfsi4: i / 50 - 0.5, kcfsi: i / 100 - 0.4 })) };
const price = { data: days.map((date, i) => ({ date, high: 102 + i, low: 99 + i, close: 100 + i })) };
const response = payload => ({ ok: true, json: async () => structuredClone(payload) });
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(predicate) {
  for (let i = 0; i < 50 && !predicate(); i++) await tick();
  assert.ok(predicate(), 'asynchronous state settled');
}

class Element {
  constructor(id = '') {
    this.id = id; this.children = []; this.attributes = new Map(); this.listeners = new Map();
    this.style = {}; this.hidden = false; this.dataset = {}; this.disabled = false;
    this.classList = { contains: () => false, toggle() {} };
  }
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); }
  set innerHTML(value) { this.html = value; this.children = []; }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  querySelector(selector) { return this.children.find(child => child.id === selector.slice(1)) || null; }
  click() { if (!this.disabled) this.listeners.get('click')?.(); }
}

let sequence = 0;
async function setup(optional = async () => response(stress)) {
  clearRequestCache();
  for (const store of [loaded, loadedHLC, loadedVol]) for (const key of Object.keys(store)) delete store[key];
  const ids = ['tab-stressdash', 'stressdash-chart', 'stressdash-status', 'stressdash-table'];
  for (const name of ['nfci', 'stlfsi', 'kcfsi']) for (const field of ['val', 'sub', 'signal']) ids.push(`stressdash-${name}-${field}`);
  const elements = Object.fromEntries(ids.map(id => [id, new Element(id)]));
  const calls = [], errors = [], charts = [];
  globalThis.document = {
    baseURI: 'http://localhost/', body: new Element(),
    getElementById: id => elements[id] || null,
    createElement: () => new Element(),
  };
  globalThis.window = { innerWidth: 1280, innerHeight: 900 };
  globalThis.requestAnimationFrame = callback => callback();
  let optionalFetcher = optional, requiredFetcher = url => response(url === NFCI ? nfci : price);
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return url === OPTIONAL ? optionalFetcher(url, options) : requiredFetcher(url, options);
  };
  globalThis.echarts = { init: host => {
    const chart = {
      options: null, renders: 0, actions: [],
      getDom: () => host, isDisposed: () => false, resize() {}, dispose() {},
      getOption() { return this.options || {}; },
      setOption(options) { this.options = options; this.renders++; },
      dispatchAction(action) {
        this.actions.push(action);
        if (action.type === 'dataZoom') Object.assign(this.options.dataZoom[action.dataZoomIndex], { start: action.start, end: action.end });
        if (action.type.startsWith('legend')) this.options.legend[action.legendIndex].selected[action.name] = action.type === 'legendSelect';
      },
    };
    charts.push(chart); return chart;
  } };
  // Node's runtime warning logger retains the native Console. Keep its error
  // method intact while collecting the browser module's global console calls.
  const originalConsole = globalThis.console;
  globalThis.console = Object.assign(Object.create(originalConsole), {
    error: (...args) => errors.push(args),
  });
  let module;
  try { module = await import(`../tabs/stressdash.js?test=${++sequence}`); }
  catch (error) { globalThis.console = originalConsole; throw error; }
  return {
    module, elements, calls, charts, errors,
    optional: fetcher => { optionalFetcher = fetcher; },
    required: fetcher => { requiredFetcher = fetcher; },
    retry: () => elements['stressdash-status'].querySelector('#stressdash-optional-retry'),
    restore: () => { globalThis.console = originalConsole; },
  };
}
const series = (s, name) => s.charts.at(-1).options.series.find(row => row.name === name).data;
const value = (s, name) => s.elements[`stressdash-${name}-val`].textContent;

test('application console spy preserves native warning output and still captures application errors', async t => {
  const originalNativeError = nativeConsole.error;
  const s = await setup(); t.after(s.restore);
  assert.equal(nativeConsole.error, originalNativeError);
  const observed = [];
  const onWarning = warning => observed.push(warning);
  process.on('warning', onWarning); t.after(() => process.off('warning', onWarning));
  process.emitWarning('Intentional runtime-warning isolation regression', {
    code: 'STRESSDASH_TEST_RUNTIME_WARNING',
  });
  await until(() => observed.some(warning => warning.code === 'STRESSDASH_TEST_RUNTIME_WARNING'));
  assert.deepEqual(s.errors, []);
  console.error('application error sentinel');
  assert.deepEqual(s.errors, [['application error sentinel']]);
});
function assertUnavailable(s) {
  for (const name of ['stlfsi', 'kcfsi']) {
    assert.equal(value(s, name), 'Unavailable');
    assert.equal(s.elements[`stressdash-${name}-val`].style.color, 'var(--muted)');
    assert.equal(s.elements[`stressdash-${name}-signal`].textContent, '無法判斷壓力');
  }
  for (const name of ['STLFSI4', 'STLFSI4 MA20', 'KCFSI', 'KCFSI MA20']) assert.deepEqual(series(s, name), []);
  assert.equal(value(s, 'nfci'), '+0.09');
  assert.ok(series(s, 'NFCI（下圖）').length);
  assert.ok(series(s, 'SPY').length);
  assert.match(s.elements['stressdash-table'].html, /SPY 4週報酬/);
  assert.match(s.elements['stressdash-status'].textContent, /STLFSI4 \/ KCFSI Unavailable/);
  assert.equal(s.elements['stressdash-status'].attributes.get('role'), 'status');
  assert.equal(s.retry().attributes.get('aria-label'), '重試 STLFSI4 / KCFSI 資料');
  assert.equal(s.retry().className, 'chip');
  assert.equal(s.errors.length, 0);
}

test('all-valid activation renders existing values, thresholds, all series and original status', async t => {
  const s = await setup(); t.after(s.restore);
  await s.module.activate();
  assert.equal(value(s, 'nfci'), '+0.09'); assert.equal(value(s, 'stlfsi'), '+0.88'); assert.equal(value(s, 'kcfsi'), '+0.29');
  assert.match(s.elements['stressdash-stlfsi-signal'].textContent, /▲ 高於 MA20（0.69）· 略緊 · 高於歷史均值/);
  assert.equal(s.charts[0].options.series.length, 10);
  assert.deepEqual(series(s, 'STLFSI4'), stress.data.map(row => [row.date, +row.stlfsi4.toFixed(3)]));
  assert.deepEqual(series(s, 'KCFSI'), stress.data.map(row => [row.date, +row.kcfsi.toFixed(3)]));
  assert.equal(s.elements['stressdash-status'].textContent, `SPY 週K × NFCI/STLFSI4/KCFSI · ${series(s, 'SPY').length} 週（3Y）· 來源 FRED NFCI/STLFSI4/KCFSI`);
  assert.equal(s.retry(), null); assert.equal(s.calls.length, 5); assert.equal(s.errors.length, 0);
});

for (const missing of ['stlfsi4', 'kcfsi', 'both', 'empty']) {
  test(`valid JSON with ${missing} no observations remains — without retry`, async t => {
    const payload = { data: missing === 'empty' ? [] : stress.data.map(row => {
      const copy = { ...row };
      if (missing !== 'kcfsi') copy.stlfsi4 = null;
      if (missing !== 'stlfsi4') delete copy.kcfsi;
      return copy;
    }) };
    const s = await setup(async () => response(payload)); t.after(s.restore);
    await s.module.activate();
    if (missing !== 'kcfsi') { assert.equal(value(s, 'stlfsi'), '—'); assert.deepEqual(series(s, 'STLFSI4'), []); }
    else assert.equal(value(s, 'stlfsi'), '+0.88');
    if (missing !== 'stlfsi4') { assert.equal(value(s, 'kcfsi'), '—'); assert.deepEqual(series(s, 'KCFSI'), []); }
    else assert.equal(value(s, 'kcfsi'), '+0.29');
    assert.equal(value(s, 'nfci'), '+0.09'); assert.equal(s.retry(), null); assert.equal(s.errors.length, 0);
  });
}

test('numeric zero is observed and retains original zero-level classification', async t => {
  const s = await setup(async () => response({ data: [{ date: days.at(-1), stlfsi4: 0, kcfsi: 0 }] })); t.after(s.restore);
  await s.module.activate();
  assert.equal(value(s, 'stlfsi'), '+0.00'); assert.equal(value(s, 'kcfsi'), '+0.00');
  assert.deepEqual(series(s, 'STLFSI4'), [[days.at(-1), 0]]);
  assert.equal(s.elements['stressdash-stlfsi-signal'].textContent, '略緊 · 高於歷史均值');
});

const failures = {
  HTTP: async () => ({ ok: false, status: 503 }),
  network: async () => { throw new Error('offline'); },
  parse: async () => ({ ok: true, json: async () => { throw new SyntaxError('bad JSON'); } }),
  shape: async () => response({ data: {} }),
  'null row': async () => response({ data: [null] }),
  'invalid date': async () => response({ data: [{ date: '2026-02-30', stlfsi4: 1 }] }),
  string: async () => response({ data: [{ date: days[0], stlfsi4: '0' }] }),
  boolean: async () => response({ data: [{ date: days[0], kcfsi: false }] }),
  NaN: async () => response({ data: [{ date: days[0], kcfsi: NaN }] }),
  Infinity: async () => response({ data: [{ date: days[0], stlfsi4: Infinity }] }),
};
for (const [name, failure] of Object.entries(failures)) {
  test(`optional ${name} failure remains local and Unavailable`, async t => {
    const s = await setup(failure); t.after(s.restore);
    await s.module.activate(); assertUnavailable(s);
  });
}

for (const failing of [NFCI, 'data/SPY.json', 'data/QQQ.json', 'data/SOXX.json']) {
  test(`required ${failing} failure propagates and a later activation retries`, async t => {
    const s = await setup(); t.after(s.restore);
    s.required(url => url === failing ? { ok: false, status: 503 } : response(url === NFCI ? nfci : price));
    await assert.rejects(s.module.activate(), /HTTP 503/);
    assert.equal(s.charts[0].renders, 0); assert.equal(s.errors.length, 1);
    s.required(url => response(url === NFCI ? nfci : price));
    await s.module.activate(); assert.equal(value(s, 'nfci'), '+0.09'); assert.equal(s.retry(), null);
    assert.equal(s.calls.filter(call => call.url === failing).length, 2);
  });
}
for (const payload of [{ data: [] }, { data: [{ date: days[0], nfci: '0' }] }, { data: [{ date: days[0], nfci: null }] }]) {
  test(`invalid required NFCI ${JSON.stringify(payload)} does not commit partial state`, async t => {
    const s = await setup(); t.after(s.restore);
    s.required(url => response(url === NFCI ? payload : price));
    await assert.rejects(s.module.activate(), /invalid rows/); assert.equal(s.charts[0].renders, 0);
    s.required(url => response(url === NFCI ? nfci : price));
    await s.module.activate(); assert.equal(value(s, 'nfci'), '+0.09');
  });
}

test('local retry success requests only optional source and preserves zoom/legend changed while pending', async t => {
  const s = await setup(failures.HTTP); t.after(s.restore);
  await s.module.activate(); assertUnavailable(s);
  const pending = deferred(); s.optional(() => pending.promise);
  const button = s.retry(); button.click(); button.click();
  assert.equal(button.disabled, true); assert.equal(button.textContent, '重試中…');
  assert.equal(s.elements['stressdash-status'].attributes.get('aria-busy'), 'true');
  assert.equal(s.calls.filter(call => call.url === OPTIONAL).length, 2);
  const chart = s.charts[0]; chart.options.dataZoom[0].start = 25; chart.options.dataZoom[0].end = 75;
  chart.options.legend[1].selected.KCFSI = false;
  pending.resolve(response(stress)); await until(() => value(s, 'stlfsi') === '+0.88');
  assert.equal(chart.options.dataZoom[0].start, 25); assert.equal(chart.options.dataZoom[0].end, 75);
  assert.equal(chart.options.legend[1].selected.KCFSI, false);
  assert.equal(s.calls.filter(call => call.url !== OPTIONAL).length, 4); assert.equal(s.retry(), null);
  assert.equal(s.errors.length, 0, s.errors.map(args => args.map(String).join(' ')).join('\n'));
});

test('retry failure keeps the same accessible button retryable, then a second retry can succeed', async t => {
  const s = await setup(failures.HTTP); t.after(s.restore);
  await s.module.activate(); const button = s.retry(); button.click();
  await until(() => !button.disabled); assertUnavailable(s); assert.equal(s.retry(), button);
  assert.equal(s.elements['stressdash-status'].attributes.get('aria-busy'), 'false');
  s.optional(async () => response(stress)); button.click(); await until(() => !s.retry());
  assert.equal(value(s, 'kcfsi'), '+0.29'); assert.equal(s.calls.filter(call => call.url !== OPTIONAL).length, 4);
});

test('local retry forces a fresh optional request even when another consumer populated its JSON cache', async t => {
  const s = await setup(failures.HTTP); t.after(s.restore); await s.module.activate();
  s.optional(async () => response({ data: [{ date: days[0], stlfsi4: 99, kcfsi: 99 }] }));
  await requestJSON(OPTIONAL);
  s.optional(async () => response(stress)); s.retry().click(); await until(() => !s.retry());
  assert.equal(value(s, 'stlfsi'), '+0.88'); assert.equal(value(s, 'kcfsi'), '+0.29');
  assert.equal(s.calls.filter(call => call.url === OPTIONAL).length, 3);
  assert.equal(s.calls.filter(call => call.url !== OPTIONAL).length, 4);
});

test('retry success with no observations clears Unavailable and removes retry', async t => {
  const s = await setup(failures.HTTP); t.after(s.restore); await s.module.activate();
  s.optional(async () => response({ data: [] })); s.retry().click(); await until(() => !s.retry());
  assert.equal(value(s, 'stlfsi'), '—'); assert.equal(value(s, 'kcfsi'), '—'); assert.deepEqual(series(s, 'KCFSI'), []);
});

for (const interruption of ['hidden', 'abort', 'isCurrent']) {
  test(`retry ${interruption} interruption cannot commit or repaint; route reentry stays usable`, async t => {
    const s = await setup(failures.HTTP); t.after(s.restore);
    const controller = new AbortController(); let current = true;
    await s.module.activate({ signal: controller.signal, isCurrent: () => current });
    const pending = deferred(); s.optional(() => pending.promise); s.retry().click();
    const renders = s.charts[0].renders;
    if (interruption === 'hidden') s.elements['tab-stressdash'].hidden = true;
    if (interruption === 'abort') controller.abort();
    if (interruption === 'isCurrent') current = false;
    pending.resolve(response(stress)); await tick(); await tick();
    assert.equal(value(s, 'stlfsi'), 'Unavailable'); assert.equal(s.charts[0].renders, renders);
    s.elements['tab-stressdash'].hidden = false; await s.module.activate(); assertUnavailable(s); assert.equal(s.retry().disabled, false);
    s.optional(async () => response(stress)); s.retry().click(); await until(() => !s.retry());
    assert.equal(value(s, 'kcfsi'), '+0.29'); assert.equal(s.calls.filter(call => call.url !== OPTIONAL).length, 4);
  });
}

test('reentry invalidates old retry even if it resolves after a new retry succeeded', async t => {
  const s = await setup(failures.HTTP); t.after(s.restore); await s.module.activate();
  const old = deferred(); s.optional(() => old.promise); s.retry().click();
  s.elements['tab-stressdash'].hidden = true; s.elements['tab-stressdash'].hidden = false;
  await s.module.activate(); assert.equal(s.retry().disabled, false);
  s.optional(async () => response(stress)); s.retry().click(); await until(() => !s.retry());
  const renders = s.charts[0].renders;
  old.resolve(response({ data: [{ date: days[0], stlfsi4: 99, kcfsi: 99 }] })); await tick(); await tick();
  assert.equal(value(s, 'stlfsi'), '+0.88'); assert.equal(s.charts[0].renders, renders); assert.equal(s.errors.length, 0);
});

test('aborted cold optional activation never becomes Unavailable or caches tab state', async t => {
  const pending = deferred(); const s = await setup(() => pending.promise); t.after(s.restore);
  const controller = new AbortController(); const activation = s.module.activate({ signal: controller.signal });
  const rejected = assert.rejects(activation, error => error.name === 'AbortError');
  controller.abort(); pending.resolve(response(stress)); await rejected;
  assert.equal(s.charts[0].renders, 0); assert.notEqual(value(s, 'stlfsi'), 'Unavailable'); assert.equal(s.errors.length, 0);
  clearRequestCache(); s.optional(async () => response(stress)); await s.module.activate(); assert.equal(value(s, 'stlfsi'), '+0.88');
  assert.equal(s.calls.filter(call => call.url === NFCI).length, 2);
});

test('abort before first animation frame leaves required module cache uncommitted', async t => {
  const s = await setup(); t.after(s.restore); let frame;
  globalThis.requestAnimationFrame = callback => { frame = callback; };
  const controller = new AbortController(); const activation = s.module.activate({ signal: controller.signal });
  const rejected = assert.rejects(activation, error => error.name === 'AbortError');
  await until(() => Boolean(frame)); controller.abort(); frame(); await rejected; assert.equal(s.charts[0].renders, 0);
  clearRequestCache(); globalThis.requestAnimationFrame = callback => callback(); await s.module.activate();
  assert.equal(value(s, 'nfci'), '+0.09'); assert.equal(s.calls.filter(call => call.url === NFCI).length, 2);
});
