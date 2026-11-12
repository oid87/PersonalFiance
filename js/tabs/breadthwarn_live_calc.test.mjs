import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from './breadthwarn_live_calc.mjs';
const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} vs ${b}`);

test('融資成數 60% 買進的起始維持率是 166.7%，跌 22% 碰到 130%', () => {
  near(L.initialMaint(0.6), 1 / 0.6);
  near(L.dropToCall(0.6), -0.22);
  near(L.dropToCall(0.5), -0.35);
});

test('維持率隨股價等比例下降', () => {
  const s = L.marginSim({ m0: 1.6, drop: -0.1 });
  near(s.m1, 1.44); assert.equal(s.called, false);
  near(s.room, 1.3 / 1.6 - 1);                 // −18.75%
  near(s.roomAfter, 1.3 / 1.44 - 1);
  assert.equal(s.payCall, 0);
});

test('跌破 130% 時算出補繳差額，回到 166% 要補更多', () => {
  const s = L.marginSim({ m0: 1.5, drop: -0.2 });   // 維持率 120%
  near(s.m1, 1.2); assert.equal(s.called, true);
  const loan = 100 / 1.5, value = 80;
  near(s.payCall, loan - value / 1.3);
  near(s.payClear, loan - value / 1.66);
  assert.ok(s.payClear > s.payCall);
  near((value) / (loan - s.payCall), 1.3);         // 補完剛好 130%
  near(s.equity, value - loan);
});

test('門檻可以自訂（券商另有約定）；不合理輸入回 null', () => {
  assert.equal(L.marginSim({ m0: 1.5, drop: -0.1, thr: 1.4 }).called, true);
  assert.equal(L.marginSim({ m0: 0, drop: -0.1 }), null);
  assert.equal(L.marginSim({ m0: 1.5, drop: -1 }), null);
  assert.equal(L.simTable(1.6, [-0.03, -0.2], 1.3).length, 2);
});

test('回放指標：缺值不補、不產生無限大', () => {
  const day = { r: [0, -1, null], bq: [100, 200, null], sq: [50, 300, 10], tq: [0, 30, 5], tv: [0, 10, 20], vb: [0, 5, 10] };
  const x = L.indicators(day);
  near(x.cimb[0], (50 - 100) / 150 * 100); near(x.cimb[1], 20); assert.equal(x.cimb[2], null);
  near(x.fill[1], 10); assert.equal(x.vp[0], null); near(x.vp[1], 2);
  assert.deepEqual(L.coverage([1, null, null, 2, null]), { have: 2, missing: 3, maxGap: 2 });
  assert.equal(L.hhmm(0), '09:00'); assert.equal(L.hhmm(270), '13:30');
});
