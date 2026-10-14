import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { initTooltips, TOUCH_TOOLTIP_MS } from '../utils/tooltip.js';

// Minimal DOM fixture: just enough surface for initTooltips() (no jsdom, no browser).
function installDom() {
  const docListeners = new Map();
  const winListeners = new Map();
  const byId = new Map();
  const make = (tag = 'div') => ({
    tag, attrs: new Map(), style: {}, hidden: false, textContent: '', offsetWidth: 120, offsetHeight: 30,
    isConnected: true,
    getAttribute(name) { return this.attrs.get(name) ?? null; },
    setAttribute(name, value) { this.attrs.set(name, String(value)); if (name === 'id') byId.set(value, this); },
    removeAttribute(name) { this.attrs.delete(name); },
    closest(selector) { return selector === '[data-tooltip]' && this.attrs.has('data-tooltip') ? this : null; },
    contains(other) { return other === this; },
    getBoundingClientRect() { return { left: 100, right: 160, top: 200, bottom: 230, width: 60, height: 30 }; },
  });
  const add = (map, name, fn) => map.set(name, [...(map.get(name) ?? []), fn]);
  globalThis.document = {
    body: { append(el) { if (el.id) byId.set(el.id, el); } },
    createElement: make,
    getElementById: id => byId.get(id) ?? null,
    addEventListener: (name, fn) => add(docListeners, name, fn),
  };
  globalThis.window = { addEventListener: (name, fn) => add(winListeners, name, fn) };
  globalThis.innerWidth = 844;
  globalThis.innerHeight = 390;
  const host = make('span');
  host.setAttribute('data-tooltip', '說明文字');
  const other = make('span');
  const fire = (name, event = {}) => {
    for (const fn of [...(docListeners.get(name) ?? []), ...(winListeners.get(name) ?? [])]) fn(event);
  };
  initTooltips();
  const tip = byId.get('shared-tooltip');
  // Stub the tooltip element: createElement gave it a plain object, setAttribute('id') registered it.
  return { fire, host, other, tip };
}

test('touch tap opens the tooltip and it auto-hides after the reading time', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { fire, host, tip } = installDom();
    fire('pointerdown', { pointerType: 'touch', target: host });
    assert.equal(tip.hidden, false);
    assert.equal(tip.textContent, '說明文字');
    assert.match(host.getAttribute('aria-describedby'), /shared-tooltip/);
    mock.timers.tick(TOUCH_TOOLTIP_MS - 1);
    assert.equal(tip.hidden, false);
    mock.timers.tick(1);
    assert.equal(tip.hidden, true);
    assert.equal(host.getAttribute('aria-describedby'), null);
  } finally { mock.timers.reset(); }
});

test('a later tap restarts the timer and a tap elsewhere hides immediately', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { fire, host, other, tip } = installDom();
    fire('pointerdown', { pointerType: 'touch', target: host });
    mock.timers.tick(2000);
    fire('pointerdown', { pointerType: 'touch', target: host });
    mock.timers.tick(2000);
    assert.equal(tip.hidden, false, 'second tap restarted the countdown');
    fire('pointerdown', { pointerType: 'touch', target: other });
    assert.equal(tip.hidden, true);
    mock.timers.tick(TOUCH_TOOLTIP_MS * 2); // stale timer must not throw or re-show
    assert.equal(tip.hidden, true);
  } finally { mock.timers.reset(); }
});

test('scrolling and route changes dismiss a tap-opened tooltip', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let ctx = installDom();
    ctx.fire('pointerdown', { pointerType: 'touch', target: ctx.host });
    ctx.fire('scroll');
    assert.equal(ctx.tip.hidden, true);
    ctx = installDom();
    ctx.fire('pointerdown', { pointerType: 'touch', target: ctx.host });
    ctx.fire('hashchange');
    assert.equal(ctx.tip.hidden, true);
  } finally { mock.timers.reset(); }
});

test('mouse hover keeps its behavior: no auto-hide, hides on mouseout, scroll only repositions', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { fire, host, tip } = installDom();
    fire('mouseover', { target: host });
    assert.equal(tip.hidden, false);
    mock.timers.tick(TOUCH_TOOLTIP_MS * 4);
    assert.equal(tip.hidden, false, 'hover tooltips have no timer');
    fire('scroll');
    assert.equal(tip.hidden, false, 'scroll repositions a hover tooltip instead of hiding it');
    assert.equal(tip.style.left, '70px');
    fire('mouseout', { target: host, relatedTarget: null });
    assert.equal(tip.hidden, true);
  } finally { mock.timers.reset(); }
});
