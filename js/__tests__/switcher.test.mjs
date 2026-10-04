import assert from "node:assert/strict";
import test from "node:test";

class ClassList {
  constructor(values = []) { this.values = new Set(values); }
  toggle(name, force) {
    if (force === undefined) force = !this.values.has(name);
    if (force) this.values.add(name); else this.values.delete(name);
    return force;
  }
  contains(name) { return this.values.has(name); }
}

class Element {
  constructor(id = "", classes = []) {
    this.id = id;
    this.hidden = false;
    this.classList = new ClassList(classes);
    this.dataset = {};
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.textContent = "";
  }
  set className(value) { this.classList = new ClassList(String(value).split(/\s+/).filter(Boolean)); }
  get className() { return [...this.classList.values].join(" "); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  append(...children) { this.children.push(...children.filter(c => typeof c !== "string")); }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  contains(node) { return node === this || this.children.some(child => child.contains?.(node)); }
  remove() { this.parent?.children.splice(this.parent.children.indexOf(this), 1); }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  click() { this.listeners.get("click")?.(); }
  querySelector(selector) {
    const className = selector.startsWith(".") ? selector.slice(1) : null;
    return this.children.find(child => className && child.classList?.contains(className)) || null;
  }
}

function installDOM(sectionIds) {
  const sections = sectionIds.map(id => new Element(`tab-${id}`, ["tab-section"]));
  for (const section of sections) {
    const append = section.append.bind(section);
    section.append = (...children) => {
      append(...children);
      for (const child of section.children) child.parent = section;
    };
  }
  globalThis.document = {
    createElement: () => new Element(),
    getElementById: id => sections.find(section => section.id === id) || null,
    querySelectorAll: selector => selector === ".tab-section" ? sections : [],
  };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  return sections;
}

async function freshSwitcher() {
  return import(`../switcher.js?test=${Date.now()}-${Math.random()}`);
}

test("unknown tab preserves the currently visible section", async () => {
  const [first, second] = installDOM(["first", "second"]);
  first.hidden = false;
  second.hidden = true;
  const switcher = await freshSwitcher();
  switcher.registerAll([{ id: "first", module: {} }]);
  assert.equal(await switcher.switchTo("missing"), false);
  assert.equal(first.hidden, false);
  assert.equal(second.hidden, true);
});

for (const [label, activate] of [
  ["synchronous", () => { throw new Error("sync boom"); }],
  ["asynchronous", async () => { throw new Error("async boom"); }],
]) {
  test(`${label} activation failure shows an alert`, async () => {
    const [section] = installDOM(["broken"]);
    const switcher = await freshSwitcher();
    switcher.registerAll([{ id: "broken", module: { activate } }]);
    assert.equal(await switcher.switchTo("broken"), false);
    const alert = section.querySelector(".tab-load-error");
    assert.ok(alert);
    assert.equal(alert.getAttribute("role"), "alert");
    assert.match(alert.children[0].textContent, /boom/);
    assert.equal(section.getAttribute("aria-busy"), null);
  });
}

test("retry invokes activation again and clears the error", async () => {
  const [section] = installDOM(["retry"]);
  let attempts = 0;
  const switcher = await freshSwitcher();
  switcher.registerAll([{
    id: "retry",
    module: { activate: () => { if (++attempts === 1) throw new Error("first"); } },
  }]);
  assert.equal(await switcher.switchTo("retry"), false);
  const retry = section.querySelector(".tab-load-error").children[1];
  retry.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 2);
  assert.equal(section.querySelector(".tab-load-error"), null);
  assert.equal(section.getAttribute("aria-busy"), null);
});

test('required payload rejection invalidates its successful JSON fetch for retry', async () => {
  const [section] = installDOM(['shape']);
  const { requestJSON, clearRequestCache } = await import('../utils/data.js');
  clearRequestCache();
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => (++calls === 1 ? { data: [] } : { data: [{ date: '2026-10-01', value: 1 }] }) });
  try {
    const switcher = await freshSwitcher();
    switcher.registerAll([{ id: 'shape', module: { async activate({ signal }) {
      const payload = await requestJSON('/shape', { signal });
      if (!payload.data.length) throw new Error('missing data rows');
    } } }]);
    assert.equal(await switcher.switchTo('shape'), false);
    assert.ok(section.querySelector('.tab-load-error'));
    assert.equal(await switcher.switchTo('shape'), true);
    assert.equal(calls, 2);
    assert.equal(section.querySelector('.tab-load-error'), null);
  } finally { globalThis.fetch = originalFetch; }
});

test("concurrent switches to the same tab share one activation", async () => {
  installDOM(["slow"]);
  let calls = 0;
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const switcher = await freshSwitcher();
  switcher.registerAll([{
    id: "slow",
    module: { activate: async () => { calls++; await gate; } },
  }]);
  const first = switcher.switchTo("slow");
  const second = switcher.switchTo("slow");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  finish();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
});

test('lazy load failure retries and hidden completion never steals selection', async () => {
  const [lazy, other] = installDOM(['lazy', 'other']);
  const switcher = await freshSwitcher();
  let loads = 0;
  switcher.registerAll([
    { id: 'lazy', load: async () => { if (++loads === 1) throw new Error('import failed'); return { activate() {} }; } },
    { id: 'other', module: { activate() {} } },
  ]);
  assert.equal(await switcher.switchTo('lazy'), false);
  assert.equal(await switcher.switchTo('lazy'), true);
  assert.equal(loads, 2);
  await switcher.switchTo('other');
  assert.equal(lazy.hidden, true);
  assert.equal(other.hidden, false);
});

test('timeout aborts old activation; immediate retry survives late old completion', async () => {
  const [section] = installDOM(['slow']);
  const switcher = await freshSwitcher();
  let finishOld;
  let attempts = 0;
  switcher.registerAll([{ id: 'slow', timeoutMs: 5, module: {
    activate({ signal }) {
      attempts++;
      if (attempts === 1) return new Promise(resolve => { finishOld = resolve; });
      assert.equal(signal.aborted, false);
    },
  } }]);
  assert.equal(await switcher.switchTo('slow'), false);
  assert.equal(section.querySelector('.tab-load-error')?.getAttribute('role'), 'alert');
  assert.equal(await switcher.switchTo('slow'), true);
  finishOld();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(section.querySelector('.tab-load-error'), null);
  assert.equal(section.getAttribute('aria-busy'), null);
});

test('timed-out JSON fetch cannot poison retry or overwrite new tab state', async () => {
  installDOM(['slow-data']);
  const { requestJSON, clearRequestCache } = await import('../utils/data.js');
  clearRequestCache();
  const originalFetch = globalThis.fetch;
  let finishOld, calls = 0, committed = null;
  globalThis.fetch = () => ++calls === 1
    ? new Promise(resolve => { finishOld = () => resolve({ ok: true, json: async () => ({ data: ['old'] }) }); })
    : Promise.resolve({ ok: true, json: async () => ({ data: ['new'] }) });
  try {
    const switcher = await freshSwitcher();
    switcher.registerAll([{ id: 'slow-data', timeoutMs: 5, module: { async activate({ signal, isCurrent }) {
      const payload = await requestJSON('/slow-data', { signal });
      if (isCurrent()) committed = payload.data[0];
    } } }]);
    assert.equal(await switcher.switchTo('slow-data'), false);
    assert.equal(await switcher.switchTo('slow-data'), true);
    assert.equal(committed, 'new');
    finishOld();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(committed, 'new');
    assert.equal((await requestJSON('/slow-data')).data[0], 'new');
    assert.equal(calls, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test('initially rendered chart receives theme and resize before switchTo', async () => {
  installDOM(['initial', 'unloaded']);
  const switcher = await freshSwitcher();
  const chart = {
    getDom: () => ({}),
    getOption: () => ({ dataZoom: [], legend: [] }),
    dispatchAction() {},
  };
  let themed = 0, resized = 0, untouched = 0;
  switcher.registerAll([
    { id: 'initial', module: { getCharts: () => [chart], onThemeChange: () => { themed++; }, resize: () => { resized++; } } },
    { id: 'unloaded', module: { getCharts: () => [], onThemeChange: () => { untouched++; }, resize: () => { untouched++; } } },
  ]);
  await switcher.applyThemeAll(true);
  await switcher.resizeAll();
  assert.deepEqual([themed, resized, untouched], [1, 1, 0]);
});

test('returning to a rendered tab preserves zoom and legend through activation', async () => {
  installDOM(['primary', 'other']);
  const switcher = await freshSwitcher();
  const host = {};
  let option = { dataZoom: [{ start: 0, end: 100 }], legend: [{ selected: { price: true } }] };
  const chart = {
    getDom: () => host,
    getOption: () => option,
    dispatchAction(action) {
      if (action.type === 'dataZoom') Object.assign(option.dataZoom[0], { start: action.start, end: action.end });
      if (action.type === 'legendUnSelect') option.legend[0].selected[action.name] = false;
      if (action.type === 'legendSelect') option.legend[0].selected[action.name] = true;
    },
  };
  switcher.registerAll([
    { id: 'primary', module: {
      getCharts: () => [chart],
      activate: () => { option = { dataZoom: [{ start: 0, end: 100 }], legend: [{ selected: { price: true } }] }; },
      onThemeChange: () => { option = { dataZoom: [{ start: 0, end: 100 }], legend: [{ selected: { price: true } }] }; },
    } },
    { id: 'other', module: { activate() {} } },
  ]);
  await switcher.switchTo('primary');
  chart.dispatchAction({ type: 'dataZoom', start: 20, end: 80 });
  chart.dispatchAction({ type: 'legendUnSelect', name: 'price' });
  await switcher.switchTo('other');
  await switcher.applyThemeAll(true);
  assert.deepEqual(option.dataZoom[0], { start: 20, end: 80 });
  assert.equal(option.legend[0].selected.price, false);
  await switcher.switchTo('primary');
  assert.deepEqual(option.dataZoom[0], { start: 20, end: 80 });
  assert.equal(option.legend[0].selected.price, false);
});

test('late hidden activation cannot resize until its section is visible again', async () => {
  const [slow] = installDOM(['slow-chart', 'other-chart']);
  const host = slow.appendChild(new Element('host'));
  host.clientWidth = 390;
  host.clientHeight = 420;
  let width = 0, height = 0, resized = 0, finish;
  const chart = {
    getDom: () => host,
    getOption: () => ({ dataZoom: [], legend: [] }),
    getWidth: () => width,
    getHeight: () => height,
    resize() { resized++; width = host.clientWidth; height = host.clientHeight; },
  };
  let count = 0;
  const switcher = await freshSwitcher();
  switcher.registerAll([
    { id: 'slow-chart', module: { getCharts: () => [chart], activate() {
      if (++count === 1) return new Promise(resolve => { finish = resolve; });
    } } },
    { id: 'other-chart', module: { activate() {} } },
  ]);
  const old = switcher.switchTo('slow-chart');
  await new Promise(resolve => setImmediate(resolve));
  await switcher.switchTo('other-chart');
  finish();
  await old;
  assert.equal(resized, 0);
  await switcher.switchTo('slow-chart');
  assert.deepEqual([width, height, resized], [390, 420, 1]);
});
