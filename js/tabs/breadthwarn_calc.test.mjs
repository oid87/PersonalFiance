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
