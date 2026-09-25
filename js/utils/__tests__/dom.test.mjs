import assert from "node:assert/strict";
import test from "node:test";

const { bindOnce, chipPicker } = await import("../dom.js");

// ── minimal DOM stub ─────────────────────────────────────────────────────
class FakeClassList {
  constructor() { this.set = new Set(); }
  add(c) { this.set.add(c); }
  remove(c) { this.set.delete(c); }
  toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); }
  contains(c) { return this.set.has(c); }
}

class FakeEl {
  constructor({ tag = "div", dataset = {}, classes = [] } = {}) {
    this.tag = tag;
    this.dataset = { ...dataset };
    this.classList = new FakeClassList();
    classes.forEach(c => this.classList.add(c));
    this.children = [];
    this.parent = null;
    this._listeners = {};
  }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  dispatch(type, target) {
    (this._listeners[type] || []).forEach(fn => fn({ target: target || this }));
  }
  // matches(".chip") / matches(".chip[data-x]")
  matches(sel) {
    const m = /^\.([\w-]+)(?:\[data-([\w-]+)\])?$/.exec(sel);
    if (!m) return false;
    const [, cls, attr] = m;
    if (!this.classList.contains(cls)) return false;
    if (attr) {
      const camel = attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (!(camel in this.dataset)) return false;
    }
    return true;
  }
  closest(sel) {
    let node = this;
    while (node) {
      if (node.matches(sel)) return node;
      node = node.parent;
    }
    return null;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = n => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
}

function makeHost(chipDefs) {
  const host = new FakeEl();
  const chips = chipDefs.map(d => new FakeEl({ dataset: d.dataset, classes: ["chip", ...(d.active ? ["active"] : [])] }));
  chips.forEach(c => host.appendChild(c));
  return { host, chips };
}

// ── bindOnce ─────────────────────────────────────────────────────────────
test("bindOnce: null/undefined returns false", () => {
  assert.equal(bindOnce(null), false);
  assert.equal(bindOnce(undefined), false);
});

test("bindOnce: first call true, marks dataset.built", () => {
  const el = new FakeEl();
  assert.equal(bindOnce(el), true);
  assert.equal(el.dataset.built, "1");
});

test("bindOnce: second call on same el returns false", () => {
  const el = new FakeEl();
  bindOnce(el);
  assert.equal(bindOnce(el), false);
});

// ── chipPicker basics ────────────────────────────────────────────────────
test("chipPicker: click on chip fires onPick with value and element", () => {
  const { host, chips } = makeHost([{ dataset: { xRange: "1Y" } }, { dataset: { xRange: "5Y" } }]);
  let got;
  chipPicker(host, "x-range", (v, t) => { got = [v, t]; });
  host.dispatch("click", chips[1]);
  assert.equal(got[0], "5Y");
  assert.equal(got[1], chips[1]);
});

test("chipPicker: click on a child of the chip still resolves via closest", () => {
  const { host, chips } = makeHost([{ dataset: { xRange: "1Y" } }]);
  const child = new FakeEl();
  chips[0].appendChild(child);
  let got;
  chipPicker(host, "x-range", v => { got = v; });
  host.dispatch("click", child);
  assert.equal(got, "1Y");
});

test("chipPicker: click on host blank area (no matching chip) does not fire onPick", () => {
  const { host } = makeHost([{ dataset: { xRange: "1Y" } }]);
  let called = false;
  chipPicker(host, "x-range", () => { called = true; });
  host.dispatch("click", host);
  assert.equal(called, false);
});

test("chipPicker: default mode toggles active across all .chip in host", () => {
  const other = new FakeEl({ classes: ["chip", "active"] });
  const { host, chips } = makeHost([{ dataset: { xRange: "1Y" }, active: true }, { dataset: { xRange: "5Y" } }]);
  host.appendChild(other);
  chipPicker(host, "x-range", () => {});
  host.dispatch("click", chips[1]);
  assert.equal(chips[0].classList.contains("active"), false);
  assert.equal(chips[1].classList.contains("active"), true);
  assert.equal(other.classList.contains("active"), false);
});

test("chipPicker: onlyMatching only toggles chips sharing the same data attr", () => {
  const other = new FakeEl({ classes: ["chip", "active"] }); // no data-x-range
  const { host, chips } = makeHost([{ dataset: { xRange: "1Y" }, active: true }, { dataset: { xRange: "5Y" } }]);
  host.appendChild(other);
  chipPicker(host, "x-range", () => {}, { onlyMatching: true });
  host.dispatch("click", chips[1]);
  assert.equal(chips[0].classList.contains("active"), false);
  assert.equal(chips[1].classList.contains("active"), true);
  assert.equal(other.classList.contains("active"), true); // untouched
});

test("chipPicker: camelCase conversion (ck-window -> ckWindow)", () => {
  const { host, chips } = makeHost([{ dataset: { ckWindow: "30" } }]);
  let got;
  chipPicker(host, "ck-window", v => { got = v; });
  host.dispatch("click", chips[0]);
  assert.equal(got, "30");
});

test("chipPicker: repeated call with same (host, attr) only binds once", () => {
  const { host, chips } = makeHost([{ dataset: { xRange: "1Y" } }]);
  let count = 0;
  chipPicker(host, "x-range", () => { count++; });
  chipPicker(host, "x-range", () => { count++; });
  host.dispatch("click", chips[0]);
  assert.equal(count, 1);
});

test("chipPicker: still binds after bindOnce(host) already marked it", () => {
  const { host, chips } = makeHost([{ dataset: { xRange: "1Y" } }]);
  assert.equal(bindOnce(host), true);
  let got;
  chipPicker(host, "x-range", v => { got = v; });
  host.dispatch("click", chips[0]);
  assert.equal(got, "1Y");
});
