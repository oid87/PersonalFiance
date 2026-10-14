import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// corr.js touches the DOM at import time, so run its source in a vm with inert stubs.
const source = readFileSync(new URL('../tabs/corr.js', import.meta.url), 'utf8');
const ctx = {
  SERIES: [], CORR_EXTRA: [], loaded: {}, isLight: () => true, tc: a => a, PALETTE: { text: '#1f2328' },
  loadSeries: async () => {}, toArithReturns: () => [], pearsonCorr: () => 0, chipPicker() {},
  document: { getElementById: () => null }, echarts: {},
};
vm.createContext(ctx);
vm.runInContext(source.replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '').replace(/\bexport /g, ''), ctx);

// Independent oracle: WCAG ratios from the five stops, interpolated linearly in RGB.
const stops = ['#1565c0', '#c8d8f0', '#f5f5f5', '#f5c0c0', '#c62828'];
const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const lin = c => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
const lum = c => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const at = r => {
  const t = (r + 1) / 2 * 4, i = Math.min(Math.floor(t), 3), f = t - i;
  return rgb(stops[i]).map((c, k) => c + (rgb(stops[i + 1])[k] - c) * f);
};
const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

test('cell text is black or white, whichever is more legible, for every r', () => {
  let worst = Infinity;
  for (let n = -1000; n <= 1000; n++) {
    const r = n / 1000, bg = at(r);
    const tag = ctx.cellTextTag(r);
    const picked = ratio(tag === 'k' ? [0, 0, 0] : [255, 255, 255], bg);
    const other = ratio(tag === 'k' ? [255, 255, 255] : [0, 0, 0], bg);
    assert.ok(picked >= other, `r=${r}: picked ${picked} < other ${other}`);
    worst = Math.min(worst, picked);
  }
  assert.ok(worst >= 4.5, `worst case contrast ${worst}`);
});

test('red and blue sides switch at different |r| because their luminance differs', () => {
  const switchPoint = sign => { for (let n = 0; n <= 1000; n++) if (ctx.cellTextTag(sign * n / 1000) === 'w') return n / 1000; return null; };
  const pos = switchPoint(1), neg = switchPoint(-1);
  assert.ok(pos > 0.8 && pos < 0.95 && neg > 0.8 && neg < 0.95, `${pos} ${neg}`);
  assert.notEqual(pos, neg);
  assert.equal(ctx.cellTextTag(0), 'k');
  assert.equal(ctx.cellTextTag(1), 'w');
  assert.equal(ctx.cellTextTag(-1), 'w');
});
