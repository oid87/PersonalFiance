import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { bindOnce, chipPicker } from '../utils/dom.js';
import { normalizeMarginRows, monthChange, rebaseToPercent, computeDivergence, computeVWAC } from '../tabs/marginglobal_calc.mjs';

// Runs the real marginglobal.js (imports stripped, DOM/echarts faked): the market chips above
// the chart and the table rows must drive one state variable and re-sync each other.
const source = readFileSync(new URL('../tabs/marginglobal.js', import.meta.url), 'utf8')
  .replace(/^import [\s\S]*?;\n/gm, '').replace(/^export /gm, '');

function fakeEl(id) {
  return { id, dataset: {}, style: {}, innerHTML: '', textContent: '', listeners: {},
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); },
    querySelectorAll() { return []; }, getBoundingClientRect() { return { top: 0, bottom: 0 }; }, scrolled: [],
    scrollIntoView(arg) { this.scrolled.push(arg); } };
}
// Chip elements parsed from the picker's innerHTML, with classList / dataset / closest.
function chipsFrom(html) {
  return [...html.matchAll(/<span class="chip( active)?" data-mg-market="([^"]+)">([^<]*)<\/span>/g)].map(([, active, id, label]) => {
    const classes = new Set(['chip', ...(active ? ['active'] : [])]);
    const chip = { dataset: { mgMarket: id }, textContent: label,
      classList: { toggle: (c, on) => { on ? classes.add(c) : classes.delete(c); }, contains: c => classes.has(c) },
      closest(sel) { return /^\.chip\[data-mg-market\]$/.test(sel) ? chip : null; } };
    return chip;
  });
}

function setup({ mobile = false, coarse = false, pickerRect = { top: 0, bottom: 52 }, chartRect = { top: 52, bottom: 324 }, innerHeight = 340 } = {}) {
  const els = Object.fromEntries(['mg-table', 'mg-market-picker', 'mg-chart', 'mg-range-picker', 'mg-altindex-picker', 'mg-status', 'mg-vwac-status',
    'mg-anchor-clear', 'mg-pct-chart', 'mg-pct-status', 'mg-drag-status'].map(id => [id, fakeEl(id)]));
  const picker = { chips: [] };
  els['mg-market-picker'].querySelectorAll = () => picker.chips;
  els['mg-market-picker'].getBoundingClientRect = () => pickerRect;
  els['mg-chart'].getBoundingClientRect = () => chartRect;
  const options = [];
  const context = vm.createContext({
    console, window: { innerWidth: mobile ? 390 : 1280 }, document: { getElementById: id => els[id] || null }, innerHeight,
    isLight: () => false, mob: () => mobile, PALETTE: new Proxy({}, { get: () => '#888' }),
    echartsBase: o => o, cutoffDate: () => '1900-01-01', presetStart: () => '1900-01-01', tsToLocalDate: x => x,
    lookupLE: (rows, d) => { let r = null; for (const row of rows) if (row[0] <= d) r = row; return r; },
    bindOnce, chipPicker, requestJSON: async () => ({}), clearRequestCache() {},
    normalizeMarginRows, monthChange, rebaseToPercent, computeDivergence, computeVWAC,
    echarts: { init: () => ({}) }, requestAnimationFrame: fn => fn(),
  });
  // the module reads globalThis.matchMedia: that is the vm global
  context.matchMedia = () => ({ matches: coarse });
  vm.runInContext(source + `\nglobalThis.api = { buildControls, renderTable, selectMarket, MARKETS,
    state: () => ({ activeMarket, anchorDate, activeAltIndexKey }), setAnchor: d => { anchorDate = d; },
    seed: () => { for (const m of MARKETS) { marginCache[m.id] = [['2026-09-01', 100], ['2026-10-01', 110]]; indexCache[m.id] = [['2026-09-01', 10], ['2026-10-01', 11]]; } },
    setChart: c => { chart = c; } };`, context);
  const api = context.api;
  api.seed();
  api.setChart({ setOption: (o) => options.push(o), getModel: () => { throw new Error('no grid'); } });
  api.renderTable();
  api.buildControls();
  picker.chips = chipsFrom(els['mg-market-picker'].innerHTML);
  const clickChip = id => { const chip = picker.chips.find(c => c.dataset.mgMarket === id); els['mg-market-picker'].listeners.click.forEach(fn => fn({ target: chip })); };
  const clickRow = id => { const tr = { dataset: { mgId: id } }; els['mg-table'].listeners.click.forEach(fn => fn({ target: { closest: () => tr } })); };
  const activeChips = () => picker.chips.filter(c => c.classList.contains('active')).map(c => c.dataset.mgMarket);
  const activeRows = () => [...els['mg-table'].innerHTML.matchAll(/<tr data-mg-id="([^"]+)"[^>]*>\s*<td[^>]*font-weight:700/g)].map(m => m[1]);
  const legend = () => options.at(-1)?.legend.data[1];
  return { api, els, options, picker, clickChip, clickRow, activeChips, activeRows, legend };
}

const plain = x => JSON.parse(JSON.stringify(x));

test('chips: one per market, same order and labels as the table, default market active', () => {
  const s = setup();
  assert.deepEqual(s.picker.chips.map(c => c.dataset.mgMarket), plain(s.api.MARKETS.map(m => m.id)));
  assert.deepEqual(s.picker.chips.map(c => c.textContent), plain(s.api.MARKETS.map(m => m.label)));
  assert.equal(s.picker.chips.length, 6);
  assert.deepEqual(s.activeChips(), ['tw_listed']);
  assert.deepEqual(s.activeRows(), ['tw_listed']);
});

test('chip click and table click use one state: chart, table highlight and chips agree', () => {
  const s = setup();
  s.clickRow('tw_otc');
  assert.equal(s.api.state().activeMarket, 'tw_otc');
  assert.deepEqual(s.activeChips(), ['tw_otc']);
  assert.deepEqual(s.activeRows(), ['tw_otc']);
  assert.equal(s.legend(), '櫃買指數（右軸）');
  s.clickChip('jp');
  assert.equal(s.api.state().activeMarket, 'jp');
  assert.deepEqual(s.activeChips(), ['jp']);
  assert.deepEqual(s.activeRows(), ['jp']);
  assert.equal(s.legend(), '日經225（右軸）');
  s.clickRow('kr');
  assert.deepEqual(s.activeChips(), ['kr']);
  assert.deepEqual(s.activeRows(), ['kr']);
  assert.equal(s.legend(), 'KOSPI（右軸）');
});

test('picking a market from either place resets the anchor and the US index choice, as the table always did', () => {
  for (const pick of ['clickChip', 'clickRow']) {
    const s = setup();
    s.api.setAnchor('2026-09-01');
    s[pick]('cn');
    assert.deepEqual({ ...s.api.state() }, { activeMarket: 'cn', anchorDate: null, activeAltIndexKey: 'sp500' });
  }
});

test('unknown market ids are ignored', () => {
  const s = setup();
  s.api.selectMarket('nope');
  assert.equal(s.api.state().activeMarket, 'tw_listed');
  assert.deepEqual(s.activeChips(), ['tw_listed']);
});

test('touch: scrolls the chips + chart into view only when they are not fully visible', () => {
  const hidden = setup({ mobile: true, pickerRect: { top: -300, bottom: -250 }, chartRect: { top: -250, bottom: 30 } });
  hidden.clickRow('jp');
  assert.equal(hidden.els['mg-market-picker'].scrolled.length, 1, 'scroll target is the chip row');
  assert.deepEqual({ ...hidden.els['mg-market-picker'].scrolled[0] }, { block: 'start', behavior: 'auto' });
  assert.equal(hidden.els['mg-chart'].scrolled.length, 0);
  const visible = setup({ mobile: true });
  visible.clickChip('jp');
  assert.equal(visible.els['mg-market-picker'].scrolled.length, 0, 'already on screen: no scroll');
  const bottomCut = setup({ mobile: true, pickerRect: { top: 0, bottom: 52 }, chartRect: { top: 52, bottom: 360 } });
  bottomCut.clickChip('jp');
  assert.equal(bottomCut.els['mg-market-picker'].scrolled.length, 1, 'chart bottom below the viewport');
});

test('desktop (fine pointer, wide): selecting a market never scrolls', () => {
  const s = setup({ mobile: false, coarse: false, pickerRect: { top: -300, bottom: -250 }, chartRect: { top: 900, bottom: 1400 } });
  s.clickRow('jp'); s.clickChip('us');
  assert.equal(s.els['mg-market-picker'].scrolled.length + s.els['mg-chart'].scrolled.length, 0);
});

test('chart grids use containLabel and a small px bottom that depends on label rotation (no percentage whitespace)', () => {
  assert.match(source, /const mgGridBottom = rotate => \(rotate \? 0 : 6\);/);
  assert.equal([...source.matchAll(/bottom: mgGridBottom\(xRotate\), containLabel: true/g)].length, 2, 'main chart and anchor % chart');
  assert.equal([...source.matchAll(/rotate: xRotate/g)].length, 2);
  assert.doesNotMatch(source, /bottom: isMob \? '18%'/);
  assert.doesNotMatch(source, /rotate: isMob \? 30 : 0/);
});

test('x labels rotate only on narrow charts', () => {
  const run = width => {
    const context = vm.createContext({ window: { innerWidth: width } });
    vm.runInContext(source.slice(source.indexOf('const mgXRotate'), source.indexOf('const MARGIN_COLOR')) + '\nglobalThis.r = mgXRotate();', context);
    return context.r;
  };
  assert.equal(run(390), 30);
  assert.equal(run(599), 30);
  assert.equal(run(600), 0);
  assert.equal(run(844), 0);
  assert.equal(run(1280), 0);
});
