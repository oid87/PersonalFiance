// cashking_calc — 現金為王（izaax）週線邏輯；cashking.js 與 nonnormal.js 共用。
import assert from 'node:assert/strict';
import test from 'node:test';
import { ckWeekStart, computeCKWeekly } from './cashking_calc.mjs';

const ASSETS = [{ key: 'GLD', isGold: true }, { key: 'BTC' }, { key: 'TLT' }, { key: 'QQQ' }];
/** Daily rows Mon–Fri for `weeks` weeks; price(key, weekIndex) gives that week's close. */
function raw(weeks, price, fg = () => 50) {
  const out = { 'F&G': [] };
  for (const { key } of ASSETS) out[key] = [];
  for (let w = 0; w < weeks; w++) for (let d = 0; d < 5; d++) {
    const date = new Date(Date.parse('2024-01-01') + (w * 7 + d) * 86400000).toISOString().slice(0, 10);
    for (const { key } of ASSETS) out[key].push([date, price(key, w)]);
    out['F&G'].push([date, fg(w)]);
  }
  return out;
}

test('ckWeekStart keys every weekday to its Monday', () => {
  assert.equal(ckWeekStart('2026-10-22'), '2026-10-19');
  assert.equal(ckWeekStart('2026-10-19'), '2026-10-19');
  assert.equal(ckWeekStart('2026-10-25'), '2026-10-19');
});

test('all four down over 4 weeks + F&G < 25 → 4/4 (現金為王 condition)', () => {
  const rows = computeCKWeekly(raw(14, (k, w) => 100 - (w >= 10 ? (w - 9) * 2 : 0), w => (w >= 12 ? 18 : 50)), ASSETS, '2024-01-01');
  const last = rows.at(-1);
  assert.equal(last.cum4Down, 4);
  assert.ok(last.fgMin4w < 25);
  assert.equal(last.ftg4w, false);
});

test('only gold up while the rest fall → 逃往黃金 (ftg4w)', () => {
  const rows = computeCKWeekly(raw(14, (k, w) => (k === 'GLD' ? 100 + w : 100 - w)), ASSETS, '2024-01-01');
  const last = rows.at(-1);
  assert.equal(last.cum4Down, 3);
  assert.equal(last.ftg4w, true);
  assert.ok(last.cum4Rets.GLD > 0 && last.cum4Rets.QQQ < 0);
});
