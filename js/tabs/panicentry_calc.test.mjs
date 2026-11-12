import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from './panicentry_calc.mjs';

// 合成資料：每天一列，0050 與加權同步，00631L＝兩倍日報酬
function synth(closes, vol = null) {
  const n = closes.length, date = closes.map((_, i) => new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10));
  const lev = [100]; for (let i = 1; i < n; i++) lev.push(lev[i - 1] * (1 + 2 * (closes[i] / closes[i - 1] - 1)));
  const same = a => ({ o: [...a], h: [...a], l: [...a], c: [...a] });
  const tw = same(closes), e = same(closes), l = same(lev);
  return C.prepare({ date, tw_o: tw.o, tw_h: tw.h, tw_l: tw.l, tw_c: tw.c, e50_o: e.o, e50_h: e.h, e50_l: e.l, e50_c: e.c, lev_o: l.o, lev_h: l.h, lev_l: l.l, lev_c: l.c,
    tsm_ret: closes.map(() => 0), tsm_low_ret: closes.map(() => 0), us_vix: vol || closes.map(() => 20), us_vxn: closes.map(() => 20), us_vxsmh: closes.map(() => null), us_smhrv: closes.map(() => 20), vix_c: closes.map(() => null), meta: { sim_cost_annual: 0 } });
}

test('drawdown uses intraday high→low over the trailing window and events respect cooldown', () => {
  const closes = [100, 100, 79, 78, 90, 100, 100, 79, 100, 100];
  const D = synth(closes), dd = C.drawdown(D, 'i252');
  assert.ok(Math.abs(dd[2] - -0.21) < 1e-9);
  const ok = C.signalDays(D, { dd: 20 });
  assert.deepEqual(ok.map((v, i) => (v ? i : -1)).filter(i => i >= 0), [2, 3, 7]);
  assert.deepEqual(C.events(ok, 3), [2, 7]);
  assert.deepEqual(C.events(ok, 60), [2]);
});

test('next-open entry, holding-period return, MAE and simulated 2x with zero cost equals 2x daily compounding', () => {
  const D = synth([100, 80, 80, 72, 88, 96]);
  const t = C.trade(D, 1, 'e50', 'open', 3);
  assert.equal(t.entryDate, D.date[2]);
  assert.ok(Math.abs(t.ret - (88 / 80 - 1)) < 1e-9);
  assert.ok(Math.abs(t.mae - (72 / 80 - 1)) < 1e-9);
  assert.equal(t.complete, true);
  assert.equal(C.trade(D, 3, 'e50', 'open', 5).complete, false);
  for (let i = 0; i < D.date.length; i++) assert.ok(Math.abs(D.sim_c[i] - D.lev_c[i]) < 1e-9);
});

test('rolling percentile only looks backwards and needs a full window', () => {
  const p = C.pctRank([1, 2, 3, 10, 0, 5], 3);
  assert.deepEqual(p.slice(0, 3), [null, null, null]);
  assert.equal(p[3], 1);          // 10 高於前三筆
  assert.equal(p[4], 0);          // 0 低於 2,3,10
  assert.ok(Math.abs(p[5] - 2 / 3) < 1e-9); // 5 高於 3,0，不高於 10
});

test('after-peak signals fire strictly after the arming day', () => {
  const vol = [20, 20, 50, 55, 48, 47, 20, 20];
  const D = synth([100, 100, 100, 100, 100, 100, 100, 100], vol);
  const first = C.signalDays(D, { vols: [{ k: 'vix', mode: 'abs', thr: 45 }] });
  assert.equal(first.indexOf(true), 2);
  const idx = t => C.signalDays(D, { vols: [{ k: 'vix', mode: 'abs', thr: 45 }], sigType: t }).indexOf(true);
  assert.equal(idx('down1'), 4);  // 55 → 48
  assert.equal(idx('down2'), 5);  // 55 → 48 → 47
  assert.equal(idx('off10'), 4);  // 48 ≤ 55×0.9
});

test('Wilson interval and summary handle small samples', () => {
  const [lo, hi] = C.wilson(3, 3);
  assert.ok(lo > 0.43 && lo < 0.44 && hi === 1);
  assert.equal(C.summarize([]).n, 0);
});
