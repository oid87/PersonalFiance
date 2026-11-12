import test from 'node:test';
import assert from 'node:assert/strict';
import * as W from './breadthwarn_calc.mjs';

const mk = n => {
  const date = Array.from({ length: n }, (_, i) => `d${String(i).padStart(4, '0')}`), c = new Array(n).fill(100);
  return { date, tw_o: [...c], tw_h: [...c], tw_l: [...c], tw_c: [...c], lev_o: [...c], lev_h: [...c], lev_l: [...c], lev_c: [...c], e50_c: [...c] };
};

test('delta 與 accel：只用當天與之前的值', () => {
  const a = [80, 78, 70, 60, 40, 30, 28];
  assert.deepEqual(W.delta(a, 2), [null, null, -10, -18, -30, -30, -12]);
  assert.equal(W.accel(a, 2)[4], (40 - 70) - (70 - 80));
  assert.equal(W.accel(a, 2)[3], null);
});

test('attach：依日期對齊，檔數不足視為無資料', () => {
  const D = { date: ['a', 'b', 'c'] };
  const u = { a20: [10, 20], n: [50, 10] }, big = { a20: [1, 2], n: [500, 100] };
  const Bx = W.attach(D, { date: ['b', 'c'], tw50: u, twse: big, tpex: big });
  assert.deepEqual(Bx.tw50.a20, [null, 10, null]);
  assert.deepEqual(Bx.twse.a20, [null, 1, null]);
});

test('labels／evaluate：命中率、基準、提前天數', () => {
  const D = mk(120);
  for (let i = 60; i < 120; i++) { D.tw_c[i] = 85; D.tw_l[i] = 85; D.tw_h[i] = 85; D.tw_o[i] = 85; }
  const y = W.labels(D, 'd10', 20, {});
  assert.equal(y[39], false); assert.equal(y[40], true); assert.equal(y[59], true); assert.equal(y[60], false); assert.equal(y[100], null);
  const ok = new Array(120).fill(false); ok[50] = true; ok[10] = true;
  const e = W.evaluate(D, ok, { target: 'd10', H: 20, cooldown: 20 }, {});
  assert.equal(e.n, 2); assert.equal(e.tp, 1); assert.equal(e.precision, 0.5);
  assert.equal(e.nEp, 1); assert.equal(e.episodes[0].onset, 60); assert.equal(e.episodes[0].lead, 10); assert.equal(e.recall, 1);
  assert.ok(Math.abs(e.base - 20 / 100) < 1e-9);
});

test('auc：指標越低越危險時接近 1，無關時 0.5', () => {
  const y = [true, true, false, false];
  assert.equal(W.auc([1, 2, 3, 4], y), 1);
  assert.equal(W.auc([4, 3, 2, 1], y), 0);
  assert.equal(W.auc([1, 1, 1, 1], y), 0.5);
});

test('confirmDay／tradeLegs：修復訊號在事件之後才成立，隔天開盤進場', () => {
  const D = mk(40), a = new Array(40).fill(10);
  a[12] = 12; a[13] = 15; a[20] = 35;
  assert.equal(W.confirmDay(D, a, 10, 'A'), 10);
  assert.equal(W.confirmDay(D, a, 10, 'B'), 12);
  assert.equal(W.confirmDay(D, a, 10, 'C'), 13);
  assert.equal(W.confirmDay(D, a, 10, 'E'), 20);
  assert.equal(W.confirmDay(D, a, 10, 'D'), 20);
  for (let i = 11; i < 40; i++) { D.lev_o[i] = 50; D.lev_c[i] = 55; D.lev_l[i] = 45; D.lev_h[i] = 56; }
  const t = W.tradeLegs(D, [{ day: 10, w: 0.5 }, { day: null, w: 0.5 }], 5, 'lev');
  assert.equal(t.entryDate, 'd0011'); assert.ok(Math.abs(t.ret - 0.05) < 1e-9); assert.ok(Math.abs(t.mae + 0.05) < 1e-9); assert.equal(t.invested, 0.5);
});

test('attachMargin：依日期對齊，變化率只用當天與之前', () => {
  const D = mk(6), M = D.date.map((d, i) => ({ date: d, margin_money: [100, 100, 90, 90, 81, 82][i], margin_lots: 10 + i }));
  M.splice(3, 1);                                   // 缺一天 → 那天與隔天的單日變化都是缺值，不是 0
  const g = W.attachMargin(D, M);
  assert.equal(g.bal[3], null); assert.equal(g.chg1[3], null); assert.equal(g.chg1[4], null);
  assert.ok(Math.abs(g.chg1[2] + 10) < 1e-9); assert.equal(g.amt1[2], -10); assert.ok(Math.abs(g.chg1[5] - (82 / 81 - 1) * 100) < 1e-9);
});

test('跌停降溫（L1／L2／L3）：高峰只看事件前 10 日到當天，之後才能確認', () => {
  const D = mk(40), ld = new Array(40).fill(0), a = new Array(40).fill(10);
  ld[9] = 3; ld[10] = 8; ld[11] = 9; ld[12] = 6; ld[13] = 5; ld[14] = 4; ld[15] = 1;
  const ctx = { a, ld };
  assert.equal(W.confirmDay(D, ctx, 10, 'L2'), 14);          // 高峰 9（第 11 天創新高）→ ≤ 4.5 的第一天
  assert.equal(W.confirmDay(D, ctx, 10, 'L1'), 13);          // 6 → 5，連兩天下降（都在事件之後）
  assert.equal(W.confirmDay(D, ctx, 10, 'L3'), 15);          // 回到 2% 以下
  const calm = { a, ld: new Array(40).fill(0.2) };
  assert.equal(W.confirmDay(D, calm, 10, 'L2'), 10);         // 沒有跌停潮 → 當天就成立
  assert.equal(W.confirmDay(D, calm, 10, 'L3'), 10);
  assert.equal(W.confirmDay(D, { a }, 10, 'L2'), null);      // 沒有資料 → 不成立，不是當成 0
});

test('融資放緩（G1／G2／G3）與組合、分批', () => {
  const D = mk(40), a = new Array(40).fill(10), chg1 = new Array(40).fill(0), lots = D.date.map((_, i) => 100 - i);
  chg1[10] = -4; chg1[11] = -6; chg1[12] = -2.9; chg1[13] = -0.4; chg1[14] = -0.3; lots[20] = 200;
  a[16] = 12;
  const ctx = { a, ld: new Array(40).fill(0), chg1, lots };
  assert.equal(W.confirmDay(D, ctx, 10, 'G1'), 12);          // 高峰 6% → ≤ 3% 的第一天
  assert.equal(W.confirmDay(D, ctx, 10, 'G2'), 14);          // 連兩天減幅 < 0.5%
  assert.equal(W.confirmDay(D, ctx, 10, 'G3'), 20);
  assert.equal(W.confirmDay(D, ctx, 10, 'X2'), 16);          // G2（14）與廣度回升（16）都成立的那天
  assert.equal(W.confirmDay(D, { a, ld: ctx.ld }, 10, 'X2'), null);
  for (const k of Object.values(W.REPAIR_GROUPS).flat()) assert.ok(W.REPAIRS[k], k);
});

test('tradeLegs（anchor）：等待期間算現金，沒進場＝整段 0', () => {
  const D = mk(40);
  for (let i = 11; i < 40; i++) { D.lev_o[i] = 100 - (i - 10) * 2; D.lev_c[i] = D.lev_o[i]; D.lev_l[i] = D.lev_o[i] - 1; D.lev_h[i] = D.lev_o[i] + 1; }
  const wait = W.tradeLegs(D, [{ day: 14, w: 1 }], 10, 'lev', 10), none = W.tradeLegs(D, [{ day: null, w: 1 }], 10, 'lev', 10), direct = W.tradeLegs(D, [{ day: 10, w: 1 }], 10, 'lev', 10);
  assert.equal(none.ret, 0); assert.equal(none.mae, 0); assert.equal(none.invested, 0); assert.equal(none.complete, true);
  assert.ok(Math.abs(direct.ret - (80 / 98 - 1)) < 1e-9);    // 第 11 天開盤 98 → 第 20 天收 80
  assert.ok(Math.abs(wait.ret - (80 / 90 - 1)) < 1e-9);      // 第 15 天開盤 90 才買，同一天結束
  assert.ok(wait.mae > direct.mae);
});

test('rollPct／stressScore：只用過去資料，分項缺值時分數也是缺值', () => {
  const a = Array.from({ length: 300 }, (_, i) => i % 50);
  const r = W.rollPct(a, 1260, 250);
  assert.equal(r[100], null); assert.equal(r[299], 1);
  const b = [...a]; b[299] = -1; assert.equal(W.rollPct(b, 1260, 250)[298], r[298]);     // 改未來的值不影響過去
  const n = 300, z = () => new Array(n).fill(1), Bx = { twse: { ld: z(), ld5u: a, ldq: z(), dnv: z() }, tw50: { a60: a } };
  const S = W.stressScore(Bx, { chg5: new Array(n).fill(null) }, {});
  assert.ok(S.score.every(x => x == null));
  const S2 = W.stressScore(Bx, { chg5: a.map(x => -x) }, {});
  assert.ok(S2.score[299] > 0 && S2.score[299] <= 1);
});
