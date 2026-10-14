import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Source-level contract (the tab module needs a browser DOM): the TPEx unit keeps both
// facts "張" and "非金額" without nesting parentheses, and every label that embeds
// marginUnit wraps it in exactly one pair of full-width parentheses.
const source = readFileSync(new URL('../tabs/marginglobal.js', import.meta.url), 'utf8');

test('tw_otc unit says 張 and 非金額 without nested parentheses', () => {
  const otc = source.match(/id: 'tw_otc'[\s\S]*?\n  \},/)[0];
  assert.match(otc, /marginUnit: '張，非金額'/);
  assert.match(otc, /tableUnit: '張'/);
  assert.doesNotMatch(otc.match(/marginUnit: '([^']*)'/)[1], /[()（）]/);
});

test('axis name, legend and tooltip wrap marginUnit in one full-width pair', () => {
  const uses = [...source.matchAll(/`融資餘額([（(])\$\{market\.marginUnit\}([）)])`/g)];
  assert.ok(uses.length >= 4, 'axis name, legend, tooltip row, anchor base');
  for (const [, open, close] of uses) { assert.equal(open, '（'); assert.equal(close, '）'); }
});

test('no market unit carries parentheses; tables keep the CN display unit', () => {
  const units = [...source.matchAll(/marginUnit: '([^']*)'/g)].map(m => m[1]);
  assert.equal(units.length, 6);
  for (const unit of units) assert.doesNotMatch(unit, /[()（）]/, unit);
  const cn = source.match(/id: 'cn'[\s\S]*?\n  \},/)[0];
  assert.match(cn, /marginUnit: '元，人民幣'/);
  assert.match(cn, /tableUnit: '元\(人民幣\)'/);
});
