import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// trend.js needs a browser DOM at import, so run its real axis-layout block (between the
// `axis-layout:begin/end` markers) in a bare vm context. There is no canvas there, so
// textWidth() uses its documented per-character estimate; the rules are what is tested.
const source = readFileSync(new URL('../tabs/trend.js', import.meta.url), 'utf8');
const block = source.slice(source.indexOf('// axis-layout:begin'), source.indexOf('// axis-layout:end'));
assert.ok(block.length > 500, 'axis-layout block found');
const ctx = vm.createContext({});
vm.runInContext(block + '\nglobalThis.api = { computeAxisLayout, legendFootprint, axisLabelWidth, textWidth, seriesExtent, C: { AXIS_TICK_PX, AXIS_LABEL_GAP_PX, AXIS_LABEL_PAD_PX, AXIS_BLOCK_GAP_PX, GRID_TOP_PX, NAME_HEIGHT_PX, NAME_UNDER_LEGEND_GAP_PX } };', ctx);
const { computeAxisLayout, legendFootprint, axisLabelWidth, textWidth, C } = ctx.api;

// Axis order and sides as declared in trend.js render(): price, vix, fg, tw, btc, (fpe).
const DECL = [
  { id: 'price', name: 'USD Price', position: 'left', labelText: '836' },
  { id: 'vix', name: 'VIX/VXN', position: 'right', labelText: '58' },
  { id: 'fg', name: 'F&G', position: 'right', labelText: '100' },
  { id: 'tw', name: 'TWD', position: 'left', labelText: '129' },
  { id: 'btc', name: 'BTC', position: 'right', labelText: '137,228' },
  { id: 'fpe', name: 'FPE', position: 'right', labelText: '42x' },
];
const axes = used => DECL.map(a => ({ position: a.position, name: a.name, used: used.includes(a.id),
  labelW: used.includes(a.id) ? textWidth(a.labelText) + textWidth('.0') : 0 }));
const NAMES = { default: ['QQQ', 'F&G'], all: ['QQQ', '0050', 'BTC', 'VIX', 'F&G'], allfpe: ['QQQ', '0050', 'BTC', 'VIX', 'F&G', 'QQQ FPE'] };
const SCEN = {
  default: ['price', 'fg'],
  all: ['price', 'vix', 'fg', 'tw', 'btc'],
  allfpe: ['price', 'vix', 'fg', 'tw', 'btc', 'fpe'],
};
const WIDTHS = [1280, 844, 390];
const block_ = a => C.AXIS_TICK_PX + C.AXIS_LABEL_GAP_PX + a.labelW + C.AXIS_LABEL_PAD_PX;

test('offsets stack inner to outer per side: first axis at 0, then strictly increasing', () => {
  for (const [scen, used] of Object.entries(SCEN)) for (const w of WIDTHS) {
    const a = axes(used), l = computeAxisLayout(a, NAMES[scen], w);
    for (const side of ['left', 'right']) {
      const idx = a.map((x, i) => (x.used && x.position === side ? i : -1)).filter(i => i >= 0);
      idx.forEach((i, k) => {
        if (k === 0) assert.equal(l.offsets[i], 0, `${scen} ${side} innermost`);
        else assert.ok(l.offsets[i] > l.offsets[idx[k - 1]], `${scen}@${w} ${DECL[i].id} offset grows`);
      });
    }
    a.forEach((x, i) => { if (!x.used) assert.equal(l.offsets[i], 0); });
  }
});

test('neighbouring tick-label blocks and axis names never overlap', () => {
  for (const [scen, used] of Object.entries(SCEN)) for (const w of WIDTHS) {
    const a = axes(used), l = computeAxisLayout(a, NAMES[scen], w);
    for (const side of ['left', 'right']) {
      const idx = a.map((x, i) => (x.used && x.position === side ? i : -1)).filter(i => i >= 0);
      for (let k = 1; k < idx.length; k++) {
        const p = idx[k - 1], q = idx[k];
        // label block of p spans [offset_p, offset_p + block_p]; axis q's line starts after it
        assert.ok(l.offsets[q] >= l.offsets[p] + block_(a[p]) + C.AXIS_BLOCK_GAP_PX - 1e-9, `${scen} ${DECL[p].id}->${DECL[q].id} labels`);
        // names are centred on their axis line
        const half = (textWidth(a[p].name) + textWidth(a[q].name)) / 2;
        assert.ok(l.offsets[q] - l.offsets[p] >= half + 6 - 1e-9, `${scen} ${DECL[p].id}->${DECL[q].id} names`);
      }
    }
  }
});

test('grid margins cover the outermost axis on each side (labels and centred name)', () => {
  for (const [scen, used] of Object.entries(SCEN)) for (const w of WIDTHS) {
    const a = axes(used), l = computeAxisLayout(a, NAMES[scen], w);
    for (const side of ['left', 'right']) {
      let need = 8;
      a.forEach((x, i) => { if (x.used && x.position === side) need = Math.max(need, l.offsets[i] + Math.max(block_(x), textWidth(x.name) / 2 + 2)); });
      assert.equal(l[side], Math.ceil(need), `${scen}@${w} ${side}`);
    }
  }
});

test('turning an axis on never moves an existing axis inward or shrinks a margin', () => {
  const order = ['price', 'fg', 'vix', 'tw', 'btc', 'fpe'];
  for (const w of WIDTHS) {
    let prev = null;
    for (let n = 1; n <= order.length; n++) {
      const used = order.slice(0, n);
      const names = NAMES.allfpe.slice(0, Math.max(2, n));
      const l = computeAxisLayout(axes(used), names, w);
      if (prev) {
        assert.ok(l.left >= prev.left && l.right >= prev.right, `margins monotone with ${order[n - 1]}@${w}`);
        // axes already on the chart only ever move outward when another axis joins
        prev.offsets.forEach((o, i) => { if (prev.used[i]) assert.ok(l.offsets[i] >= o - 1e-9, `${DECL[i].id} offset after adding ${order[n - 1]}@${w}`); });
      }
      prev = { ...l, used: axes(used).map(x => x.used) };
    }
  }
});

test('hidden axes take no space: default view is not narrower than the old fixed offsets', () => {
  // old declarations: fg offset mob 35 / desktop 55, grid margins from offset + labels
  const l844 = computeAxisLayout(axes(SCEN.default), NAMES.default, 844);
  const oldFgNeed = 35 + C.AXIS_TICK_PX + C.AXIS_LABEL_GAP_PX + textWidth('100') + textWidth('.0') + C.AXIS_LABEL_PAD_PX;
  assert.ok(l844.right < oldFgNeed, `right ${l844.right} < old ${Math.ceil(oldFgNeed)}`);
  assert.equal(l844.offsets[2], 0);
  const l1280 = computeAxisLayout(axes(SCEN.default), NAMES.default, 1280);
  assert.equal(l1280.offsets[2], 0);
  assert.ok(l1280.right < 55 + 5 + 8 + textWidth('100') + textWidth('.0') + 4);
});

test('legend and axis names: share a row when they cannot touch, otherwise names go under the legend', () => {
  const wide = computeAxisLayout(axes(SCEN.default), NAMES.default, 1280);
  assert.equal(wide.stacked, false);
  assert.equal(wide.top, C.GRID_TOP_PX);
  assert.equal(wide.nameGap, 15);
  const phone = computeAxisLayout(axes(SCEN.all), NAMES.all, 390);
  assert.equal(phone.stacked, true);
  const legend = legendFootprint(NAMES.all, 390);
  assert.ok(phone.top >= legend.bottom + 2 + C.NAME_HEIGHT_PX + C.NAME_UNDER_LEGEND_GAP_PX);
  assert.equal(phone.nameGap, C.NAME_UNDER_LEGEND_GAP_PX);
  // a legend that wraps to a second row pushes the plot further down
  const many = ['QQQ', '0050', 'BTC', 'VIX', 'F&G', 'QQQ FPE', 'SOXX', 'MAGS'];
  const wrapped = computeAxisLayout(axes(SCEN.allfpe), many, 390);
  assert.ok(legendFootprint(many, 390).rows >= 2);
  assert.ok(wrapped.top > phone.top);
});

test('layout depends on the chart width, so a resize can re-derive it', () => {
  const a = axes(SCEN.allfpe);
  const desk = computeAxisLayout(a, NAMES.allfpe, 1280), phone = computeAxisLayout(a, NAMES.allfpe, 390);
  assert.deepEqual(desk.offsets, phone.offsets);          // offsets come from the axes, not the width
  assert.ok(phone.top >= desk.top);                       // legend wraps / collides on the narrow chart
});

test('axisLabelWidth keeps using the declared min/max and formatter', () => {
  const axis = { min: v => Math.floor(v.min * 0.9), max: v => Math.ceil(v.max * 1.1), axisLabel: { formatter: v => `${v}x` } };
  const w = axisLabelWidth(axis, { min: 10, max: 100 });
  assert.equal(w, Math.max(textWidth('9x'), textWidth('110x')) + textWidth('.0'));
  assert.equal(axisLabelWidth({ min: 0, max: 100 }, null), textWidth('100') + textWidth('.0'));
});

test('financial semantics untouched: axis ids, positions, min/max, names, series bindings', () => {
  const decl = source.slice(source.indexOf('const yAxisDef = ['), source.indexOf('for (const s of [...SERIES, ...TREND_EXTRA, ...customSeries])'));
  const norm = t => t.replace(/\s+/g, ' ');
  for (const part of [
    '{ id: "price", name: "USD Price", position: "left", min: v => Math.floor(v.min * 0.9), max: v => Math.ceil(v.max * 1.1),',
    '{ id: "vix",  name: "VIX/VXN",  position: "right", min: v => Math.floor(v.min * 0.9), max: v => Math.ceil(v.max * 1.1),',
    '{ id: "fg",   name: "F&G",  position: "right", min: 0, max: 100,',
    '{ id: "tw",   name: "TWD",  position: "left", min: v => Math.floor(v.min * 0.9), max: v => Math.ceil(v.max * 1.1),',
    '{ id: "btc",  name: "BTC",  position: "right", min: v => Math.floor(v.min * 0.9), max: v => Math.ceil(v.max * 1.1),',
    'yAxisDef.push({ id:"fpe", name:"FPE", position:"right", min: v => Math.floor(v.min - 1), max: v => Math.ceil(v.max + 1),',
    'axisLabel: { formatter: v => `${v}x`, color:"#58a6ff", fontSize:11 },',
  ]) assert.ok(norm(decl).includes(norm(part)), part);
  assert.doesNotMatch(decl, /offset:/, 'offsets are no longer hard-coded');
  assert.match(source, /axis\.offset = layout\.offsets\[i\]/);
  assert.match(source, /grid: \{ left: layout\.left, right: layout\.right, top: layout\.top, bottom: 56 \}/);
  assert.match(source, /relayoutAxes\(\);\s*\}\);/, 'resize observer re-derives the layout');
});
