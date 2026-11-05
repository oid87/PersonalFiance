import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from './vixspike_calc.mjs';

const day = i => new Date(Date.UTC(2000, 0, 3) + i * 86400000).toISOString().slice(0, 10);
// 合成 VIX：平常 20，指定的日子盤中／收盤跳升。
function synthVix(n, spikes = {}) {
  return Array.from({ length: n }, (_, i) => {
    const s = spikes[i];
    return { date: day(i), high: s?.high ?? 20.5, close: s?.close ?? 20 };
  });
}
const asset = (n, f = i => 100 + i) => C.buildAsset(Array.from({ length: n }, (_, i) => [day(i), f(i)]));

test('buildVix: change vs prior close, high falls back to close, drops pre-1990 and recent overrides early', () => {
  const early = [{ date: '1989-12-29', high: 99, close: 99 }, ...synthVix(600).slice(0, 2).map(r => ({ ...r, close: 1 }))];
  const v = C.buildVix(early, synthVix(600, { 5: { high: 30, close: 25 }, 6: { high: 0, close: 22 } }));
  assert.equal(v.dates[0], day(0));
  assert.equal(v.close[0], 20);                       // recent 蓋 early
  assert.equal(v.chHigh[0], null);
  assert.ok(Math.abs(v.chHigh[5] - 0.5) < 1e-12);
  assert.ok(Math.abs(v.chClose[5] - 0.25) < 1e-12);
  assert.equal(v.high[6], 22);                        // high 缺／小於收盤 → 用收盤
});

test('range is [lo, hi), hi null = no cap; measure switches high/close', () => {
  const v = C.buildVix([], synthVix(600, { 100: { high: 30, close: 24 }, 200: { high: 40, close: 32 } }));
  const a = asset(600);
  const ev = p => C.runStudy(v, a, { ...C.DEFAULTS, cooldown: 0, ...p }).events.map(e => e.i);
  assert.deepEqual(ev({ lo: 0.5, hi: null }), [100, 200]);
  assert.deepEqual(ev({ lo: 0.5, hi: 1.0 }), [100]);         // +100% 不含在 [50%, 100%)
  assert.deepEqual(ev({ lo: 0.5, hi: null, measure: 'close' }), [200]);
});

test('cooldown keeps only the first day of a cluster', () => {
  assert.deepEqual(C.applyCooldown([true, true, false, true, false, false, true], 3), [0, 6]);
  assert.deepEqual(C.applyCooldown([true, true], 0), [0, 1]);
  const v = C.buildVix([], synthVix(600, { 100: { high: 30, close: 24 }, 103: { high: 40, close: 30 }, 300: { high: 40, close: 30 } }));
  const evs = C.runStudy(v, asset(600), { ...C.DEFAULTS, cooldown: 10 }).events;
  assert.deepEqual(evs.map(e => e.i), [100, 300]);
  assert.deepEqual(evs[0].merged, [day(103)]);
  assert.deepEqual(evs[1].merged, []);
});

test('forward returns, lag, Taiwan next session and baseline', () => {
  const v = C.buildVix([], synthVix(600, { 100: { high: 30, close: 25 } }));
  const a = asset(600);
  const s = C.runStudy(v, a, { ...C.DEFAULTS, lo: 0.5 });
  const e = s.events[0];
  assert.equal(e.entryDate, day(100));
  assert.ok(Math.abs(e.ret[20] - (220 / 200 - 1)) < 1e-12);
  assert.equal(e.path[0], 0);
  assert.equal(s.stats[20].n, 1);
  assert.ok(s.stats[20].baseN > 400);
  const lag1 = C.runStudy(v, a, { ...C.DEFAULTS, lo: 0.5, lag: 1 }).events[0];
  assert.equal(lag1.entryDate, day(101));
  // 台股：取 T 之後第一個交易日；標的少了 T+1 那天 → 進場跳到 T+2。
  const tw = C.buildAsset(Array.from({ length: 600 }, (_, i) => [day(i), 100 + i]).filter(r => r[0] !== day(101)));
  assert.equal(C.runStudy(v, tw, { ...C.DEFAULTS, lo: 0.5 }, { nextSession: true }).events[0].entryDate, day(102));
  // 美股標的 T 日缺資料 → 不對齊（entry null）。
  const us = C.buildAsset(Array.from({ length: 600 }, (_, i) => [day(i), 100 + i]).filter(r => r[0] !== day(100)));
  assert.equal(C.runStudy(v, us, { ...C.DEFAULTS, lo: 0.5 }).events[0].entry, null);
});

test('events before the asset starts are kept but excluded from stats; scan + status', () => {
  const v = C.buildVix([], synthVix(800, { 50: { high: 40, close: 30 }, 500: { high: 35, close: 30 } }));
  const a = C.buildAsset(Array.from({ length: 600 }, (_, i) => [day(i + 200), 100 + i]));
  const s = C.runStudy(v, a, { ...C.DEFAULTS, lo: 0.5 });
  assert.equal(s.events.length, 2);
  assert.equal(s.events[0].entry, null);
  assert.equal(s.stats[1].n, 1);
  const scan = C.bucketScan(v, a, C.DEFAULTS, { horizon: 5 });
  assert.equal(scan.length, C.BUCKETS.length);
  assert.equal(scan.find(b => b.lo === 0.6).n, 1);                     // +75%
  const st = C.currentStatus(v, s);
  assert.equal(st.date, day(799));
  assert.equal(st.hit, false);
  assert.equal(C.extremes(v, { top: 1 })[0].date, day(50));
});

test('level mode: only the day VIX enters the range counts; buckets and status follow the kind', () => {
  // 收盤 20 → 第 100–104 天 32 → 105 回 20 → 200 天 45（直接跳過 30–40）。
  const spikes = {};
  for (let i = 100; i < 105; i++) spikes[i] = { high: 33, close: 32 };
  spikes[200] = { high: 46, close: 45 };
  spikes[599] = { high: 31, close: 30.5 };
  const v = C.buildVix([], synthVix(600, spikes));
  const a = asset(600);
  const ev = p => C.runStudy(v, a, { ...C.DEFAULTS, cooldown: 0, kind: 'level', measure: 'close', ...p }).events.map(e => e.i);
  assert.deepEqual(ev({ lo: 30, hi: null }), [100, 200, 599]);
  assert.deepEqual(ev({ lo: 30, hi: 40 }), [100, 599]);
  assert.deepEqual(ev({ lo: 40, hi: null }), [200]);
  const s = C.runStudy(v, a, { ...C.DEFAULTS, kind: 'level', measure: 'close', lo: 30, hi: null, cooldown: 0 });
  const st = C.currentStatus(v, s);
  assert.equal(st.ch, 30.5);
  assert.equal(st.inside, true);
  assert.equal(st.hit, true);
  assert.deepEqual(C.bucketScan(v, a, s.params, { horizon: 1 }).map(b => b.lo), C.LEVEL_BUCKETS.map(b => b[0]));
});

test('movingAvg: null until n days, then simple mean; buildVix carries ma50', () => {
  assert.deepEqual(C.movingAvg([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  const rows = Array.from({ length: 600 }, (_, i) => ({ date: `2000-${String(1 + Math.floor(i / 28) % 12).padStart(2, '0')}-${String(1 + i % 28).padStart(2, '0')}`, close: 10 + (i % 5) }));
  const v = C.buildVix([], rows.map((r, i) => ({ ...r, date: `${2000 + Math.floor(i / 336)}-${r.date.slice(5)}` })));
  assert.equal(v.ma50[48], null);
  assert.ok(Math.abs(v.ma50[49] - v.close.slice(0, 50).reduce((s, x) => s + x, 0) / 50) < 1e-9);
  assert.equal(C.vixDay(v, 49).ma50, v.ma50[49]);
});
