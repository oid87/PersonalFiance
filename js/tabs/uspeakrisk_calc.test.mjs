import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as U from './uspeakrisk_calc.mjs';

const D = JSON.parse(readFileSync(new URL('../../data/uspeakrisk.json', import.meta.url)));

test('SOX 領先分類與 P1 最終版一致', () => {
  const n = U.catCounts(D.lead_events, 'ndx'), s = U.catCounts(D.lead_events, 'spx');
  assert.deepEqual([n.sox_first, n.sync, n.target_first, n.no_follow, n.total], [14, 21, 39, 9, 83]);
  assert.deepEqual([s.sox_first, s.sync, s.target_first, s.no_follow, s.total], [16, 17, 44, 6, 83]);
});

test('領先天數：SOX 先轉弱中位 10.5，全部事件中位為負', () => {
  for (const t of ['ndx', 'spx']) {
    const L = U.lagStats(D.lead_events, t);
    assert.equal(L.medianSoxFirst, 10.5);
    assert.ok(L.medianAll < 0);
    assert.equal(L.medianAll, D.lag_dist[t].q[2]);
  }
});

test('NDX 252 日 −20% ＋SOX：最終審計數字', () => {
  const m = U.findModel(D.models, { t: 'ndx', x: 'sox', h: 252, k: 0.2 });
  assert.equal(m.dauc, 0.0845);
  assert.deepEqual(m.ci_crisis, [0.017, 0.165]);
  assert.equal(m.n_crisis, 5);
  assert.deepEqual(m.rec0, [0, 5]);
  assert.deepEqual(m.rec1, [2, 5]);
});

test('危機群 <5 的組合不給危機區塊 CI', () => {
  for (const m of D.models) if (m.n_crisis != null && m.n_crisis < 5) assert.equal(m.ci_crisis, null);
});

test('資料完整性年表', () => {
  const y = Object.fromEntries(D.coverage.map(r => [r.y, r.B]));
  assert.deepEqual([y[2000], y[2008], y[2015], y[2020], y[2022], y[2025]], [0.463, 0.593, 0.714, 0.838, 0.882, 0.934]);
});

test('公開資料不含原始行情與本機路徑', () => {
  const s = JSON.stringify(D);
  assert.ok(!/\/Users\/|\/Volumes\//.test(s));
  assert.ok(!('prices' in D) && !('close' in D));
  for (const e of D.lead_events) assert.deepEqual(Object.keys(e).sort(), ['c', 'd', 'dd10', 'hz', 'lag', 'pw', 'rec', 't']);
});

test('drawdown252 與 sma', () => {
  const s = Array.from({ length: 300 }, (_, i) => [`d${String(i).padStart(3, '0')}`, i < 260 ? 100 : 90]);
  const dd = U.drawdown252(s);
  assert.equal(dd[250], null);
  assert.ok(Math.abs(dd[270] + 0.1) < 1e-12);
  assert.equal(U.sma(s, 3)[2], 100);
});

test('relStrength 期初為 1、只用共同日期', () => {
  const a = [['2020-01-01', 10], ['2020-01-02', 12], ['2020-01-03', 11]];
  const b = [['2020-01-01', 5], ['2020-01-03', 5]];
  assert.deepEqual(U.relStrength(a, b, '2020-01-01', '2020-12-31'), [['2020-01-01', 1], ['2020-01-03', 1.1]]);
});

test('filterEvents 與分享狀態', () => {
  const r = U.filterEvents(D.lead_events, { t: 'ndx', from: 2020, to: 2022, cat: 'sox_first' });
  assert.ok(r.every(e => e.t === 'ndx' && e.c === 'sox_first' && e.d >= '2020' && e.d < '2023'));
  const h = U.stateHash({ t: 'spx', hz: 'h252k20', ev: '2022', mode: 'dd', pair: 'sox-spx' });
  assert.deepEqual(U.parseState(h), { t: 'spx', hz: 'h252k20', ev: '2022', mode: 'dd', pair: 'sox-spx' });
  assert.deepEqual(U.parseState('#tab=uspeakrisk&t=evil&ev=<x>'), {});
});

test('森林圖列與 CI 跨零判斷', () => {
  const rows = U.forestRows(D.models, U.HORIZONS[2]);
  assert.equal(rows.length, 4);
  assert.ok(U.ciCrossesZero([-0.05, 0.07]) && !U.ciCrossesZero([0.017, 0.165]));
});
