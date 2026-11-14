import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import * as C from './marketrisklab_calc.mjs';

const LAB_PATH = new URL('../../data/market_risk_lab.json', import.meta.url);
const BT_PATH = new URL('../../data/market_risk_lab_backtest.json', import.meta.url);

test('sma / ema match Python definitions (EMA seeded with SMA)', () => {
  assert.deepEqual(C.sma([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
  assert.deepEqual(C.sma([1, null, 3, 4], 2), [null, null, null, 3.5]);
  const e = C.ema([1, 2, 3, 4], 3);
  assert.deepEqual(e.slice(0, 3), [null, null, 2]);
  assert.equal(e[3], 3);
});

test('dataStatus flags stale, partial and missing payloads', () => {
  assert.equal(C.dataStatus(null).level, 'unknown');
  assert.equal(C.dataStatus({ updated: '2026-11-01' }, '2026-11-14').level, 'stale');
  assert.equal(C.dataStatus({ updated: '2026-11-13', extra_prices_failed: ['QLD'] }, '2026-11-14').level, 'partial');
  assert.equal(C.dataStatus({ updated: '2026-11-13', extra_prices_failed: [] }, '2026-11-14').level, 'ok');
});

test('filterStats excludes pending events and filters by year', () => {
  const ev = [
    { date: '2018-10-26', clustered: false, h: { 60: { status: 'complete', ret: 0.1, mae: -0.05, mfe: 0.12, mdd: -0.06, rebreak: true } } },
    { date: '2022-01-24', clustered: false, h: { 60: { status: 'complete', ret: -0.2, mae: -0.25, mfe: 0.02, mdd: -0.22, rebreak: true } } },
    { date: '2026-11-05', clustered: false, h: { 60: { status: 'pending' } } },
  ];
  const all = C.filterStats(ev, 60, 2000, 2026);
  assert.equal(all.n, 2);
  assert.equal(all.pending, 1);
  assert.equal(all.up, 0.5);
  assert.ok(Math.abs(all.mean - -0.05) < 1e-12);
  const y22 = C.filterStats(ev, 60, 2020, 2026);
  assert.equal(y22.n, 1);
  assert.equal(C.filterStats(ev, 60, 2030, 2031).n, 0);
});

test('pickVariant returns null for combinations not precomputed', () => {
  assert.equal(C.pickVariant({ variants: { 'SMA|rearm60': {} } }, 'EMA', 90), null);
  assert.deepEqual(C.pickVariant({ variants: { 'SMA|rearm60': { a: 1 } } }, 'SMA', 60), { a: 1 });
});

test('committed payloads: browser MA equals Python state MA and stats match', { skip: !existsSync(LAB_PATH) || !existsSync(BT_PATH) }, () => {
  const lab = JSON.parse(readFileSync(LAB_PATH, 'utf8'));
  const bt = JSON.parse(readFileSync(BT_PATH, 'utf8'));
  for (const mk of ['US_NDX', 'TW']) {
    const s = C.marketSeries(lab, mk);
    const st = lab.states[mk];
    const i = s.dates.indexOf(st.date);
    assert.ok(i >= 0, mk);
    for (const n of [150, 200, 300]) {
      const js = C.sma(s.close.slice(0, i + 1), n).at(-1);
      // chart 序列四捨五入到 2 位，容許極小誤差
      assert.ok(Math.abs(js - st.ma[String(n)]) / st.ma[String(n)] < 1e-4, `${mk} MA${n}`);
    }
  }
  const sig = bt.variants['SMA|rearm60'].signals['US_NDX:reset300'];
  const js = C.filterStats(sig.events, 252, 1900, 2100);
  assert.equal(js.n, sig.all['252'].n);
  assert.equal(js.pending, sig.all['252'].pending);
  assert.ok(Math.abs(js.median - sig.all['252'].median) < 1e-4);
});
