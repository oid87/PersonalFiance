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
