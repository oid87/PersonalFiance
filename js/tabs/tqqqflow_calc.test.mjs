import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as C from './tqqqflow_calc.mjs';

// 合成資料：QQQ 300 日前置期（算 52 週高點）＋ TQQQ 期間。
function synth({ n = 400, flows = {}, qqq = i => 100 + i * 0.1 } = {}) {
  const day = i => new Date(Date.UTC(2009, 0, 1) + i * 86400000).toISOString().slice(0, 10);
  const qqqRows = [], tq = [], ql = [];
  let shares = 1000;
  for (let i = 0; i < n + 300; i++) {
    const d = day(i);
    qqqRows.push([d, qqq(i)]);
    if (i >= 300) {
      const nav = 10 + (i - 300) * 0.05;
      shares += (flows[i - 300] ?? 0) / (nav * 1000);
      tq.push([d, nav, shares]); ql.push([d, nav / 2, 1]);
    }
  }
  return { flows: { funds: { TQQQ: { data: tq }, QLD: { data: ql } } }, qqqRows, day };
}

test('buildSeries: flow = Δshares × NAV_t, pct over prior AUM, 252-day drawdown', () => {
  const { flows, qqqRows } = synth({ flows: { 10: 5e6 } });
  const s = C.buildSeries(flows, qqqRows);
  const i = s.dates.indexOf(flows.funds.TQQQ.data[10][0]);
  assert.ok(Math.abs(s.flow[i] - 5e6) < 1);
  const prev = flows.funds.TQQQ.data[9];
  assert.ok(Math.abs(s.pct[i] - 5e6 / (prev[2] * 1000 * prev[1])) < 1e-12);
  assert.equal(s.dd[i], 0); // rising QQQ → always at its high
});

test('drawdown uses a rolling 252-session high, not the all-time high', () => {
  // QQQ peaks at index 0 (200), drops to 100 and stays: after 252 sessions the old peak rolls off.
  const { flows, qqqRows } = synth({ qqq: i => (i === 0 ? 200 : 100) });
  const s = C.buildSeries(flows, qqqRows);
  assert.equal(s.dd[0], 0);
});

test('cooldown suppresses signals within N sessions; lag shifts entry; tail event is pending', () => {
  const { flows, qqqRows } = synth({ flows: { 50: 9e8, 60: 9e8, 80: 9e8, 399: 9e8 } });
  const s = C.buildSeries(flows, qqqRows);
  const p = { thrMode: 'usd', thr: 8e8, ddMin: 0, cooldown: 20, lag: 1 };
  const r = C.runStudy(s, p);
  assert.deepEqual(r.events.map(e => e.i), [49, 79, 398]);   // series starts at the 2nd TQQQ day
  assert.equal(r.events[0].entry, 50);
  assert.equal(r.events.at(-1).entry, null);
  assert.equal(r.events.at(-1).ret.TQQQ[5], null);
  const noCool = C.runStudy(s, { ...p, cooldown: 0 });
  assert.equal(noCool.events.length, 4);
});

test('returns, MAE and baseline excess on a known path', () => {
  const { flows, qqqRows } = synth({ flows: { 100: 9e8 } });
  const s = C.buildSeries(flows, qqqRows);
  const r = C.runStudy(s, { thrMode: 'usd', thr: 8e8, ddMin: 0, cooldown: 0, lag: 0 });
  const e = r.events[0];
  assert.ok(Math.abs(e.ret.TQQQ[5] - (s.tqqq[e.i + 5] / s.tqqq[e.i] - 1)) < 1e-12);
  assert.equal(e.mae.TQQQ[5], 0); // monotonic rise → no adverse move
  const st = r.stats.all.TQQQ[5];
  assert.equal(st.n, 1);
  assert.ok(st.baseN > 300);
  assert.ok(Math.abs(st.excess - (st.mean - st.base)) < 1e-12);
  assert.equal(r.stats.is.TQQQ[5].n, 1);
  assert.equal(r.stats.oos.TQQQ[5].n, 0);
});

test('pct threshold mode and drawdown filter', () => {
  const { flows, qqqRows } = synth({ flows: { 30: 1e5 } });
  const s = C.buildSeries(flows, qqqRows);
  assert.equal(C.runStudy(s, { thrMode: 'pct', thr: 1e-3, ddMin: 0, cooldown: 0, lag: 1 }).events.length, 1);
  assert.equal(C.runStudy(s, { thrMode: 'pct', thr: 1e-3, ddMin: 0.1, cooldown: 0, lag: 1 }).events.length, 0);
});

// 真實資料：重現外部表格（TQQQ 單日淨流入 ≥ 8 億、T 日收盤 NAV 起算、無回撤條件、無冷卻）。
test('real data reproduces the ≥$800M TQQQ inflow table', () => {
  const flows = JSON.parse(readFileSync(new URL('../../data/proshares_flows.json', import.meta.url)));
  const qqq = JSON.parse(readFileSync(new URL('../../data/QQQ.json', import.meta.url))).data.map(r => [r.date, r.close]);
  const s = C.buildSeries(flows, qqq);
  const r = C.runStudy(s, C.CHART_PRESET);
  const byDate = Object.fromEntries(r.events.map(e => [e.date, e]));
  const expected = {
    '2021-09-28': [859883120, [-2.1, -2.5, 16.2, 31.4, 28.0]],
    '2021-12-03': [1432105585, [11.8, 0.8, 14.2, -11.4, -30.0]],
    '2024-03-18': [1084497125, [4.3, 1.4, -6.1, -11.3, 21.2]],
    '2025-03-06': [858466700, [-12.6, -6.7, -23.9, -31.5, 8.5]],
    '2025-04-04': [1490459850, [18.7, 1.9, 42.1, 74.6, 101.1]],
    '2025-04-07': [1019507320, [20.1, 9.3, 37.5, 71.7, 105.8]],
    '2026-03-30': [827702035, [16.6, 41.1, 60.3, 97.8, 97.8]],
  };
  for (const [date, [flow, rets]] of Object.entries(expected)) {
    const e = byDate[date];
    assert.ok(e, `missing event ${date}`);
    assert.ok(Math.abs(e.flow - flow) < 1e4, `${date} flow ${e.flow}`);
    C.HORIZONS.forEach((h, k) => assert.equal(+(e.ret.TQQQ[h] * 100).toFixed(1), rets[k], `${date} ${h}D`));
  }
  const st = r.stats.all.TQQQ;
  assert.deepEqual(C.HORIZONS.map(h => +(st[h].mean * 100).toFixed(1)), [8.1, 6.5, 20.0, 31.6, 47.5]);
  // 2021 前 TQQQ 規模小，固定 8 億從未出現。
  assert.ok(r.events.every(e => e.date >= '2021-01-01'));
});
