import assert from 'node:assert/strict';
import test from 'node:test';
import { initChartFocus } from '../utils/chartFocus.js';

// Small DOM fixture, no third-party runtime or browser/network dependency.
class Element {
  constructor(tag, doc) {
    this.tag = tag; this.doc = doc; this.children = []; this.attrs = new Map(); this.events = new Map();
    this.style = {
      values: new Map(), getPropertyValue(key) { return this.values.get(key)?.[0] || ''; },
      getPropertyPriority(key) { return this.values.get(key)?.[1] || ''; },
      setProperty(key, value, priority = '') { this.values.set(key, [value, priority]); },
      removeProperty(key) { this.values.delete(key); },
    };
    this.classes = new Set();
    this.classList = { add: name => this.classes.add(name), remove: name => this.classes.delete(name), contains: name => this.classes.has(name) };
  }
  set className(value) { this.classes = new Set(value.split(' ')); }
  get hidden() { return this.attrs.has('hidden'); }
  set hidden(value) { value ? this.attrs.set('hidden', '') : this.attrs.delete('hidden'); }
  get tabIndex() { return this.attrs.has('tabindex') ? Number(this.attrs.get('tabindex')) : this.tag === 'button' ? 0 : -1; }
  get isConnected() { return this === this.doc.body || !!this.parentElement?.isConnected; }
  get clientWidth() { return this.closest('.chart-focus-section') ? 1200 : 600; }
  get clientHeight() { return this.closest('.chart-focus-section') ? 700 : 400; }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  removeAttribute(name) { this.attrs.delete(name); }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  before(child) {
    child.parentElement = this.parentElement;
    this.parentElement.children.splice(this.parentElement.children.indexOf(this), 0, child);
  }
  remove() { this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; }
  matches(selector) {
    return selector.split(',').some(raw => {
      const sel = raw.trim();
      if (sel.startsWith('.')) return this.classes.has(sel.slice(1));
      if (sel === '[hidden]') return this.hidden;
      if (sel === '[tabindex]') return this.attrs.has('tabindex');
      if (sel === 'dialog[open]') return this.tag === 'dialog' && this.attrs.has('open');
      if (sel === '[role="dialog"][aria-modal="true"]') return this.attrs.get('role') === 'dialog' && this.attrs.get('aria-modal') === 'true';
      return this.tag === sel;
    });
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  contains(other) { return this === other || this.children.some(child => child.contains(other)); }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  getClientRects() { return this.closest('[hidden]') ? [] : [{}]; }
  addEventListener(name, callback) { this.events.set(name, callback); }
  focus(options) { this.doc.activeElement = this; this.focusOptions = options; }
  click() { this.events.get('click')?.(); }
}

function fixture() {
  const doc = {
    events: new Map(), createElement(tag) { return new Element(tag, this); },
    querySelectorAll(selector) { return this.body.querySelectorAll(selector); },
    addEventListener(name, callback) { this.events.set(name, callback); },
    removeEventListener(name) { this.events.delete(name); },
    dispatch(name, event) { this.events.get(name)?.(event); },
  };
  doc.getElementById = id => {
    const scan = node => node.id === id ? node : node.children.map(scan).find(Boolean);
    return scan(doc.body) || null;
  };
  doc.body = doc.createElement('body'); doc.activeElement = doc.body;
  const header = doc.createElement('header'); header.setAttribute('inert', 'existing');
  const section = doc.createElement('section'); section.className = 'tab-section'; section.setAttribute('role', 'region');
  const controls = doc.createElement('div'); controls.setAttribute('inert', 'prior');
  const host = doc.createElement('div'); host.id = 'chart';
  const otherSection = doc.createElement('section'); otherSection.className = 'tab-section'; otherSection.hidden = true;
  const dialog = doc.createElement('dialog');
  section.append(controls, host); doc.body.append(header, section, otherSection, dialog);
  const frames = new Map(); let frameId = 0;
  const options = { series: [{ data: [1, 2, 3] }], dataZoom: [{ start: 25, end: 80 }], legend: [{ selected: { QQQ: false } }] };
  const chart = {
    width: 600, height: 400, calls: 0, getDom: () => host, getOption: () => options,
    getWidth() { return this.width; }, getHeight() { return this.height; },
    resize() { this.calls++; this.width = host.clientWidth; this.height = host.clientHeight; },
    dispose() { throw new Error('must not dispose'); }, setOption() { throw new Error('must not replace options'); },
  };
  const win = {
    scrollX: 4, scrollY: 260, events: new Map(), echarts: { getInstanceByDom: element => element === host ? chart : null },
    scrollTo(position) { this.lastScroll = position; this.scrollX = position.left; this.scrollY = position.top; },
    requestAnimationFrame(callback) { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); },
    addEventListener(name, callback) { this.events.set(name, callback); }, removeEventListener(name) { this.events.delete(name); },
    MutationObserver: class {
      constructor(callback) { win.reconcile = callback; }
      observe() {} disconnect() { win.disconnected = true; }
    },
  };
  const flush = () => { for (const [id, callback] of [...frames]) { frames.delete(id); callback(); } };
  const key = (value, extra = {}) => {
    const event = { key: value, preventDefault() { this.defaultPrevented = true; }, ...extra };
    doc.dispatch('keydown', event); return event;
  };
  const api = initChartFocus({ document: doc, window: win });
  return { doc, win, section, host, header, controls, otherSection, dialog, chart, options, flush, key, api,
    button: section.children.find(child => child.classes.has('chart-focus-toolbar')).children.at(-1) };
}

test('enter/restore keeps chart host and financial options; restores attributes, scroll and focus', () => {
  const f = fixture();
  f.doc.body.style.setProperty('overflow', 'auto', 'important');
  f.host.style.setProperty('transition', 'height .2s ease');
  f.button.focus(); const before = structuredClone(f.options);
  assert.equal(f.api.enter('chart'), true);
  assert.equal(f.api.focusedChartId, 'chart');
  assert.equal(f.host.parentElement, f.section);
  assert.equal(f.section.getAttribute('aria-modal'), 'true');
  assert.equal(f.otherSection.getAttribute('inert'), '');
  assert.equal(f.button.textContent, '還原圖表');
  assert.equal(f.doc.body.style.getPropertyValue('overflow'), 'hidden');
  assert.equal(f.host.style.getPropertyValue('transition'), 'none');
  f.flush(); assert.deepEqual([f.chart.width, f.chart.height, f.chart.calls], [1200, 700, 1]);
  assert.equal(f.key('Tab').defaultPrevented, true);
  f.win.scrollY = 0;
  assert.equal(f.key('Escape').defaultPrevented, true);
  f.flush();
  assert.equal(f.api.focusedChartId, null);
  assert.deepEqual([f.chart.width, f.chart.height, f.chart.calls], [600, 400, 2]);
  assert.deepEqual(f.options, before);
  assert.equal(f.section.getAttribute('role'), 'region');
  assert.equal(f.section.getAttribute('aria-modal'), null);
  assert.equal(f.header.getAttribute('inert'), 'existing');
  assert.equal(f.controls.getAttribute('inert'), 'prior');
  assert.equal(f.otherSection.getAttribute('inert'), null);
  assert.equal(f.doc.body.style.getPropertyPriority('overflow'), 'important');
  assert.equal(f.doc.body.style.getPropertyValue('overflow'), 'auto');
  assert.equal(f.host.style.getPropertyValue('transition'), 'height .2s ease');
  assert.equal(f.win.scrollY, 260);
  assert.equal(f.doc.activeElement, f.button);
  assert.deepEqual(f.button.focusOptions, { preventScroll: true });
});

test('tab change cleans fixed state and scroll lock without returning focus to hidden controls', () => {
  const f = fixture(); f.button.click(); f.flush();
  f.section.hidden = true; f.otherSection.hidden = false;
  f.otherSection.focus(); f.win.reconcile(); f.flush();
  assert.equal(f.api.focusedChartId, null);
  assert.equal(f.section.classList.contains('chart-focus-section'), false);
  assert.equal(f.doc.body.style.getPropertyValue('overflow'), '');
  assert.equal(f.doc.activeElement, f.otherSection);
  assert.equal(f.api.enter('chart'), false);
});

test('an open dialog blocks entry and owns Escape; opening one while focused cleans the pilot', () => {
  const f = fixture(); f.dialog.setAttribute('open', '');
  assert.equal(f.api.enter('chart'), false);
  assert.equal(f.key('Escape').defaultPrevented, undefined);
  f.dialog.removeAttribute('open'); f.api.enter('chart'); f.flush();
  f.dialog.setAttribute('open', ''); f.dialog.focus();
  assert.equal(f.key('Escape').defaultPrevented, undefined);
  f.doc.dispatch('focusin', { target: f.dialog });
  assert.equal(f.api.focusedChartId, null);
  assert.equal(f.doc.activeElement, f.dialog);
  assert.equal(f.doc.body.style.getPropertyValue('overflow'), '');
});

test('Escape used to cancel IME composition leaves the chart focused', () => {
  const f = fixture(); f.api.enter('chart'); f.flush();
  assert.equal(f.key('Escape', { isComposing: true }).defaultPrevented, undefined);
  assert.equal(f.api.focusedChartId, 'chart');
  assert.equal(f.key('Escape', { keyCode: 229 }).defaultPrevented, undefined);
  assert.equal(f.api.focusedChartId, 'chart');
  assert.equal(f.key('Escape').defaultPrevented, true);
  assert.equal(f.api.focusedChartId, null);
});

test('a modal inside a hidden section does not block a visible chart', () => {
  const f = fixture();
  const hiddenModal = f.doc.createElement('div');
  hiddenModal.setAttribute('role', 'dialog');
  hiddenModal.setAttribute('aria-modal', 'true');
  f.otherSection.append(hiddenModal);
  assert.equal(f.api.enter('chart'), true);
  assert.equal(f.api.focusedChartId, 'chart');
  f.win.reconcile();
  assert.equal(f.api.focusedChartId, 'chart', 'hidden modal does not force exit either');
  assert.equal(f.key('Escape').defaultPrevented, true);
  assert.equal(f.api.focusedChartId, null);
});

test('resize shares chart lifecycle measurement and init/destroy are idempotent', () => {
  const f = fixture();
  assert.equal(initChartFocus({ document: f.doc, window: f.win }), f.api);
  assert.equal(f.section.children.filter(child => child.classes.has('chart-focus-toolbar')).length, 1);
  f.api.enter('chart'); f.flush();
  f.win.events.get('resize')(); f.flush();
  assert.equal(f.chart.calls, 1, 'same measured dimensions do not resize twice');
  f.chart.width = 800;
  f.win.events.get('resize')(); f.flush();
  assert.equal(f.chart.calls, 2, 'changed host measurement uses lifecycle resize');
  f.api.destroy(); f.flush();
  assert.deepEqual([f.chart.width, f.chart.height], [600, 400]);
  assert.equal(f.win.disconnected, true);
  assert.equal(f.doc.events.size, 0);
  assert.equal(f.win.events.size, 0);
  assert.equal(f.section.children.filter(child => child.classes.has('chart-focus-toolbar')).length, 0);
  assert.equal(f.section.classList.contains('chart-focus-section'), false);
});
