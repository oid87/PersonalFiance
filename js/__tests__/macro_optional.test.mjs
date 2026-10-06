import assert from 'node:assert/strict';
import test from 'node:test';
import { macroLoaded } from '../state.js';
import { clearRequestCache } from '../utils/data.js';

const valid = { data: [{ date: '2026-08-01', score: 35, light: '黃紅燈' }] };
const required = { data: [{ date: '2026-08-01', value: 4 }] };
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
const response = payload => ({ ok: true, json: async () => payload });
const tick = () => new Promise(resolve => setImmediate(resolve));

class Element {
  constructor(id = '') {
    this.id = id; this.children = []; this.attributes = new Map();
    this.listeners = new Map(); this.hidden = false; this.dataset = {};
    this.classList = { contains: () => false, toggle() {} };
  }
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return this.text || ''; }
  set innerHTML(value) { this.html = value; this.children = []; }
  append(child) { child.parent = this; this.children.push(child); }
  appendChild(child) { this.append(child); }
  remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); }
  setAttribute(key, value) { this.attributes.set(key, value); }
  removeAttribute(key) { this.attributes.delete(key); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  click() { return this.listeners.get('click')?.(); }
  contains(child) { return this.children.includes(child); }
  querySelector(selector) { return this.children.find(child => '.' + child.className === selector); }
  querySelectorAll(selector) { return selector === '[_echarts_instance_]' ? this.children.filter(child => child.chart) : []; }
}

async function setup(fetcher = async () => response(valid)) {
  clearRequestCache();
  for (const key of Object.keys(macroLoaded)) delete macroLoaded[key];
  for (const key of ['US10Y', 'US2Y', 'M2', 'CAPE']) macroLoaded[key] = [['2026-08-01', 4]];
  const elements = Object.fromEntries(['tab-macro', 'macro-chart', 'biz-chart', 'macro-status', 'biz-status'].map(id => [id, new Element(id)]));
  elements['tab-macro'].children = [elements['macro-chart'], elements['biz-chart']];
  globalThis.document = {
    baseURI: 'http://localhost/', body: new Element(),
    getElementById: id => elements[id] || null,
    createElement: () => new Element(),
    querySelectorAll: selector => selector === '.tab-section' ? [elements['tab-macro']] : [],
  };
  globalThis.window = { innerWidth: 1280, innerHeight: 900 };
  globalThis.requestAnimationFrame = callback => callback();
  globalThis.fetch = async url => String(url).includes('taiwan_business_signal') ? fetcher(url) : response(required);
  const charts = [];
  globalThis.echarts = {
    getInstanceByDom: el => el.chart,
    init: el => {
      const chart = {
        options: null, renders: 0, wires: [],
        setOption(options) { this.options = options; this.renders++; },
        getOption() {
          if (!this.options) return {};
          return Object.fromEntries(Object.entries(this.options).map(([key, value]) => [key, Array.isArray(value) ? value : [value]]));
        },
        getDom: () => el, clear() { this.options = null; }, resize() {},
        getZr: () => ({ on() {} }), on(name) { this.wires.push(name); },
        dispatchAction() {}, isDisposed: () => false,
      };
      charts.push(chart); el.chart = chart;
      return chart;
    },
  };
  const macro = await import(`../tabs/macro.js?optional=${Date.now()}-${Math.random()}`);
  return { macro, elements, charts, status: elements['biz-status'] };
}

test('cold activation itself awaits all four required sources and optional BIZ before its first render', async () => {
  const { macro, charts, status } = await setup();
  for (const key of Object.keys(macroLoaded)) delete macroLoaded[key];
  const calls = [];
  const pending = deferred();
  globalThis.fetch = async url => {
    calls.push(url);
    return String(url).includes('taiwan_business_signal') ? pending.promise : response(required);
  };
  const activation = macro.activate();
  for (let i = 0; i < 10 && calls.length < 5; i++) await tick();
  assert.deepEqual(calls, ['data/US10Y.json', 'data/US2Y.json', 'data/M2.json', 'data/CAPE.json', 'data/taiwan_business_signal.json']);
  assert.equal(charts[0].renders, 0);
  assert.equal(status.children[0].disabled, true);
  pending.resolve(response(valid));
  await activation;
  assert.equal(charts[0].renders, 1);
  assert.equal(charts.length, 2);
  assert.deepEqual(macroLoaded.US10Y, [['2026-08-01', 4]]);
  assert.deepEqual(macroLoaded.BIZ, [['2026-08-01', 35, '黃紅燈']]);
});

test('optional HTTP, network, malformed JSON and every invalid BIZ row remain local and retryable', async () => {
  const invalidRows = [
    null, {}, { date: 'bad', score: 35 }, { date: '2026-02-30', score: 35 },
    { date: '2026-08-01', score: null }, { date: '2026-08-01', score: '35' },
    { date: '2026-08-01', score: Infinity },
  ];
  const failures = [
    async () => ({ ok: false, status: 503 }),
    async () => { throw new Error('offline'); },
    async () => ({ ok: true, json: async () => { throw new SyntaxError('bad JSON'); } }),
    async () => response({ data: [] }), async () => response({}),
    ...invalidRows.map(row => async () => response({ data: [valid.data[0], row] })),
  ];
  const warnings = [];
  const previousWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    for (const failure of failures) {
      const { macro, status, charts } = await setup(failure);
      await macro.activate();
      assert.equal(macroLoaded.BIZ, undefined);
      assert.match(status.textContent, /暫不可用.*無法判斷景氣燈號.*美國曲線仍可查看/);
      assert.equal(status.children.length, 1);
      assert.equal(status.children[0].disabled, false);
      assert.equal(charts.length, 1, 'missing BIZ never creates an empty chart for cross sync');
      assert.equal(charts[0].options.series.length, 3);
      assert.equal(charts[0].wires.length, 0);
      globalThis.fetch = async () => response(valid);
      await macro.activate();
      assert.deepEqual(macroLoaded.BIZ, [['2026-08-01', 35, '黃紅燈']]);
      assert.match(status.html, /黃紅燈.*35 分/);
      assert.equal(status.children.length, 0);
      assert.equal(charts.length, 2);
      assert.deepEqual(charts[1].options.series[0].data, [['2026-08-01', 35]]);
      assert.equal(charts[0].wires.length, 2);
    }
    assert.deepEqual(warnings, []);
  } finally { console.warn = previousWarn; }
});

test('awaited activation exposes pending retry and resets it after another optional failure', async () => {
  const pending = deferred();
  const { macro, status, charts } = await setup(() => pending.promise);
  const activation = macro.activate();
  assert.match(status.textContent, /資料載入中.*尚無法判斷/);
  assert.equal(status.children[0].disabled, true);
  assert.equal(status.children[0].textContent, '重試中…');
  assert.equal(status.attributes.get('role'), 'status');
  assert.equal(status.attributes.get('aria-live'), 'polite');
  assert.equal(status.attributes.get('aria-busy'), 'true');
  pending.resolve({ ok: false, status: 503 });
  await activation;
  assert.equal(status.children[0].disabled, false);
  assert.equal(status.attributes.get('aria-busy'), 'false');
  assert.equal(charts[0].renders, 1);
});

test('route departure while BIZ resolves defers chart creation and repaint until reentry', async () => {
  const pending = deferred();
  const { macro, elements, charts, status } = await setup(() => pending.promise);
  const activation = macro.activate();
  elements['tab-macro'].hidden = true;
  const pendingText = status.textContent;
  pending.resolve(response(valid));
  await activation;
  assert.equal(charts.length, 1);
  assert.equal(charts[0].renders, 0);
  assert.equal(status.textContent, pendingText);
  elements['tab-macro'].hidden = false;
  await macro.activate();
  assert.equal(charts.length, 2);
  assert.equal(charts[0].renders, 1);
  assert.equal(status.children.length, 0);
  assert.equal(status.attributes.has('aria-busy'), false);
});

for (const interruption of ['abort', 'supersede']) {
  test(`${interruption} during optional request prevents BIZ commit and late repaint`, async () => {
    const pending = deferred();
    const { macro, status, charts } = await setup(() => pending.promise);
    const controller = new AbortController();
    let current = true;
    const activation = macro.activate({ signal: controller.signal, isCurrent: () => current });
    const rejection = assert.rejects(activation, error => error.name === 'AbortError');
    const pendingText = status.textContent;
    if (interruption === 'abort') controller.abort(); else current = false;
    pending.resolve(response(valid));
    await rejection;
    await tick();
    assert.equal(macroLoaded.BIZ, undefined);
    assert.equal(status.textContent, pendingText);
    assert.equal(charts[0].renders, 0);
    await macro.activate({ isCurrent: () => true });
    assert.deepEqual(macroLoaded.BIZ, [['2026-08-01', 35, '黃紅燈']]);
    assert.equal(status.children.length, 0);
  });
}

test('missing optional retry uses switcher pending state and repeated clicks share one request', async () => {
  const { macro, status, elements } = await setup(async () => ({ ok: false, status: 503 }));
  await macro.activate();
  const switcher = await import('../switcher.js');
  switcher.registerAll([{ id: 'macro', module: macro }]);
  const pending = deferred();
  let calls = 0;
  globalThis.fetch = async () => { calls++; return pending.promise; };
  const retry = status.children[0];
  const first = retry.click();
  await retry.click();
  for (let i = 0; i < 10 && !calls; i++) await tick();
  assert.equal(calls, 1);
  assert.equal(status.children[0].disabled, true);
  assert.equal(elements['tab-macro'].attributes.get('aria-busy'), 'true');
  pending.resolve(response(valid));
  await first;
  assert.equal(elements['tab-macro'].attributes.has('aria-busy'), false);
  assert.equal(status.children.length, 0);
  assert.deepEqual(macroLoaded.BIZ, [['2026-08-01', 35, '黃紅燈']]);
});
