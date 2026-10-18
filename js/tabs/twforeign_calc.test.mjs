import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rollingSum, trailingPercentile, findAlerts, eventStudy, alignForeignWithIndex, buildForeign, summarizeEvents,
} from './twforeign_calc.mjs';

test('rollingSum：前 n-1 為 null，之後為窗內加總；缺值使窗內為 null', () => {
  assert.deepEqual(rollingSum([1, 2, 3, 4, 5], 3), [null, null, 6, 9, 12]);
  assert.deepEqual(rollingSum([1, NaN, 3, 4, 5], 2), [null, null, null, 7, 9]);
});

test('trailingPercentile：只用當日以前資料；樣本不足為 null', () => {
  const s = [5, 4, 3, 2, 1];
  const p = trailingPercentile(s, 10, 3);
  assert.deepEqual(p, [null, null, (1 / 3) * 100, 25, 20]);
  // 追加未來資料不改變過去百分位
  const p2 = trailingPercentile([...s, 100, -100], 10, 3);
  assert.deepEqual(p2.slice(0, 5), p);
});

test('findAlerts：門檻與冷卻期', () => {
  const pct = [null, 3, 2, 50, 4, 1, 90, 2];
  assert.deepEqual(findAlerts(pct, 5, 3), [1, 4, 7]);
  assert.deepEqual(findAlerts(pct, 5, 1), [1, 2, 4, 5, 7]);
});

test('eventStudy：最大跌幅、報酬與 mature', () => {
  const c = [100, 98, 95, 99, 101];
  const [a] = eventStudy(c, [0], 3);
  assert.equal(a.mature, true);
  assert.ok(Math.abs(a.maxDrop - -5) < 1e-9);
  assert.ok(Math.abs(a.ret - -1) < 1e-9);
  const [b] = eventStudy(c, [3], 3);
  assert.equal(b.mature, false);
  assert.equal(b.days, 1);
  assert.ok(Math.abs(b.ret - (101 / 99 - 1) * 100) < 1e-9);
  const [z] = eventStudy(c, [4], 3);
  assert.equal(z.maxDrop, null);
});

test('alignForeignWithIndex：日期交集，不補值', () => {
  const f = [{ date: 'a', foreign_net_yi: 1 }, { date: 'b', foreign_net_yi: 2 }, { date: 'c', foreign_net_yi: NaN }];
  const t = [{ date: 'b', close: 10 }, { date: 'c', close: 11 }, { date: 'd', close: 12 }];
  assert.deepEqual(alignForeignWithIndex(f, t), { dates: ['b'], net: [2], close: [10] });
});

test('buildForeign + summarizeEvents：端到端合成資料', () => {
  const n = 400;
  const f = [], t = [];
  for (let i = 0; i < n; i++) {
    const d = `d${String(i).padStart(4, '0')}`;
    // 前 380 日小幅買賣，之後連續大賣
    f.push({ date: d, foreign_net_yi: i >= 380 ? -500 : (i % 2 ? 50 : -50) });
    t.push({ date: d, close: 100 - (i >= 380 ? (i - 380) : 0) });
  }
  const r = buildForeign(f, t, { thr: 5, cooldown: 20, horizon: 5 });
  assert.equal(r.dates.length, n);
  assert.ok(r.alerts.length >= 1);
  assert.ok(r.alerts[0] >= 380);
  const s = summarizeEvents(r.events);
  assert.equal(s.n, r.events.length);
});
