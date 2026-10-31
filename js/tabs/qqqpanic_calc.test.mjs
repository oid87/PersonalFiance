import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, buildFrame, isEvent, eventRow, rawEvents, groupEvents, runThreshold, panicClass, wilson, newcombe, bootstrapCI, bootstrapDiff, quantile, sma, compareAB, periodProfile, priorPercentile, matchEvents, yearBlockCI, maBreakEvents, maBreakUnion } from './qqqpanic_calc.mjs';

function businessDays(start, n) {
  const out = []; let t = Date.parse(start);
  while (out.length < n) { const d = new Date(t); if (![0, 6].includes(d.getUTCDay())) out.push(d.toISOString().slice(0, 10)); t += 86400000; }
  return out;
}
// Flat market at 100 with tight bars; callers poke individual days.
function fixture(n = 520, start = '2023-01-02') {
  const dates = businessDays(start, n);
  const Q = dates.map(date => ({ date, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000 }));
  const VIX = dates.map(date => ({ date, open: 15, high: 16, low: 14, close: 15 }));
  const VXN = dates.map(date => ({ date, open: 20, high: 21, low: 19, close: 20 }));
  const FG = dates.map(date => ({ date, value: 50 }));
  return { dates, raw: { QQQ: Q, VIX, VXN, FG } };
}
const cfgFor = dates => ({ ...DEFAULTS, start: dates[320], end: dates.at(-1) });

test('event is defined by intraday Low vs previous Close, even when the close recovers', () => {
  const { dates, raw } = fixture();
  raw.QQQ[400] = { ...raw.QQQ[400], low: 96.9, close: 100.2 };   // -3.1% intraday, closes green
  raw.QQQ[401] = { ...raw.QQQ[401], low: 97.3, close: 97.5 };    // 97.3 / 100.2 − 1 = −2.89%: not a −3% event
  const F = buildFrame(raw, cfgFor(dates));
  assert.equal(isEvent(F, 400, -3), true);
  assert.equal(isEvent(F, 401, -3), false);
  assert.equal(isEvent(F, 401, -2), true);
  const r = eventRow(F, 400);
  assert.ok(Math.abs(r.dropLow - -3.1) < 1e-9);
  assert.ok(r.closeChg > 0, 'close-to-close change is kept as a side field, not a filter');
  assert.ok(Math.abs(r.hlRange - (96.9 / 100.5 - 1) * 100) < 1e-9);
});

test('pre window is T-60..T-1 and never sees the event day or later', () => {
  const { dates, raw } = fixture();
  raw.QQQ[340] = { ...raw.QQQ[340], high: 120 };           // T-60 for i=400 → included
  raw.QQQ[339] = { ...raw.QQQ[339], high: 130 };           // T-61 → excluded
  raw.QQQ[400] = { ...raw.QQQ[400], high: 140, low: 96 };  // event day high → excluded
  raw.QQQ[401] = { ...raw.QQQ[401], high: 150 };           // future → excluded
  const F = buildFrame(raw, cfgFor(dates));
  const r = eventRow(F, 400);
  assert.equal(r.preHigh, 120);
  assert.equal(r.preHighDate, dates[340]);
  assert.equal(r.preHighAgo, 60);
  assert.ok(Math.abs(r.eventDD - (96 / 120 - 1) * 100) < 1e-9);
});

test('post window starts at T+1: entry is T+1 open, rebreak / extra drop are measured vs event-day Low', () => {
  const { dates, raw } = fixture();
  raw.QQQ[400] = { ...raw.QQQ[400], low: 96 };
  raw.QQQ[401] = { ...raw.QQQ[401], open: 98 };
  raw.QQQ[415] = { ...raw.QQQ[415], low: 94 };   // T+15
  raw.QQQ[430] = { ...raw.QQQ[430], low: 90 };   // T+30
  const F = buildFrame(raw, cfgFor(dates));
  const r = eventRow(F, 400);
  assert.equal(r.entryOpen, 98);
  assert.equal(r.h[5].rebreak, false);
  assert.equal(r.h[5].extra, 0);
  assert.equal(r.h[20].rebreak, true);
  assert.ok(Math.abs(r.h[20].extra - (94 / 96 - 1) * 100) < 1e-9);
  assert.ok(Math.abs(r.h[60].extra - (90 / 96 - 1) * 100) < 1e-9);
  assert.equal(r.firstRebreakDays, 15);
  assert.ok(Math.abs(r.h[20].maeOpen - (94 / 98 - 1) * 100) < 1e-9);
  assert.ok(Math.abs(r.h[20].retOpen - (100 / 98 - 1) * 100) < 1e-9);
});

test('windows past the study end are censored, not filled', () => {
  const { dates, raw } = fixture();
  raw.QQQ[515] = { ...raw.QQQ[515], low: 96 };
  const F = buildFrame(raw, cfgFor(dates));
  const r = eventRow(F, 515);
  assert.equal(r.avail, 4);
  assert.equal(r.complete, false);
  assert.equal(r.h[5], null);
  assert.equal(r.h[60], null);
});

test('panic class: B if VIX High ≥ 30 or F&G < 15; missing F&G never becomes A', () => {
  assert.equal(panicClass(30, 50).cls, 'B');
  assert.equal(panicClass(29.99, 14.9).cls, 'B');
  assert.equal(panicClass(29.99, 15).cls, 'A');
  assert.equal(panicClass(25, null).cls, 'U');
  assert.equal(panicClass(31, null).cls, 'B');
  assert.equal(panicClass(31, null).detail, 'VIX only');
});

test('VXN is auxiliary only: a VXN spike does not move an event out of class A', () => {
  const { dates, raw } = fixture();
  raw.QQQ[400] = { ...raw.QQQ[400], low: 96 };
  raw.VXN[400] = { ...raw.VXN[400], high: 55 };
  const F = buildFrame(raw, cfgFor(dates));
  const r = eventRow(F, 400);
  assert.equal(r.panic, 'A');
  assert.equal(r.vxnAux, true);
});

test('anchored 20-day grouping: window counts from the first event, not chained', () => {
  const g = groupEvents([100, 110, 119, 120, 135, 141], 20);
  assert.deepEqual(g.map(x => x.members), [[100, 110, 119], [120, 135], [141]]);
});

test('runThreshold keeps every raw event and marks only the first of each group as representative', () => {
  const { dates, raw } = fixture();
  for (const i of [400, 405, 425]) raw.QQQ[i] = { ...raw.QQQ[i], low: 96 };
  const F = buildFrame(raw, cfgFor(dates));
  const R = runThreshold(F, -3);
  assert.equal(R.rows.length, 3);
  assert.equal(R.groups.length, 2);
  assert.deepEqual(R.rows.map(r => r.isRep), [true, false, true]);
  assert.deepEqual(rawEvents(F, -3), [400, 405, 425]);
});

test('MA reclaim: first close above MA after the event; +2.5% confirmation tracked separately; above-MA marked independently', () => {
  const { dates, raw } = fixture();
  for (let i = 400; i < 410; i++) raw.QQQ[i] = { ...raw.QQQ[i], close: 95, low: 94, open: 95, high: 95.5 };
  raw.QQQ[400] = { ...raw.QQQ[400], low: 92 };
  raw.QQQ[410] = { ...raw.QQQ[410], close: 100.5 };       // > MA (~99.7) but < MA×1.025
  raw.QQQ[412] = { ...raw.QQQ[412], close: 104, high: 104.5 };
  const F = buildFrame(raw, cfgFor(dates));
  const r = eventRow(F, 400);
  assert.equal(r.ma[150].status, 'reclaimed');
  assert.equal(r.ma[150].reclaimDays, 10);
  assert.equal(r.ma[150].confirmDays, 12);
  raw.QQQ[400] = { ...raw.QQQ[399], low: 96.5, close: 100 };   // closes at MA → 'above'
  const r2 = eventRow(buildFrame(raw, cfgFor(dates)), 400);
  assert.equal(r2.ma[150].status, 'above');
});

test('F&G post window: first date below 15 and post extreme-panic date', () => {
  const { dates, raw } = fixture();
  raw.QQQ[400] = { ...raw.QQQ[400], low: 96 };
  raw.VIX[405] = { ...raw.VIX[405], high: 31 };
  raw.FG[410] = { ...raw.FG[410], value: 12 };
  raw.FG[399] = { ...raw.FG[399], value: 5 };          // pre window only
  const F = buildFrame(raw, cfgFor(dates));
  const r = eventRow(F, 400);
  assert.equal(r.pre.fgMin, 5);
  assert.equal(r.post.fgMin, 12);
  assert.equal(r.post.fgBelow15Days, 10);
  assert.equal(r.post.panicDays, 5);
  assert.equal(r.post.vix30Days, 5);
});

test('missing F&G stays null in the frame', () => {
  const { dates, raw } = fixture();
  raw.FG.splice(400, 1);
  const F = buildFrame(raw, cfgFor(dates));
  assert.equal(F.fg[400], null);
});

test('stats helpers: quantile, sma, wilson, deterministic bootstrap', () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.deepEqual(sma([1, 2, 3, null, 5, 6, 7], 2), [null, 1.5, 2.5, null, null, 5.5, 6.5]);
  const w = wilson(12, 12);
  assert.ok(w.lo > 0.7 && w.lo < 0.8 && w.hi === 1);
  const vals = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.deepEqual(bootstrapCI(vals, 'median'), bootstrapCI(vals, 'median'));
  const ci = bootstrapCI(vals, 'median');
  assert.ok(ci.lo <= 5.5 && ci.hi >= 5.5);
  assert.equal(bootstrapCI([1], 'median').lo, null);
  const d = bootstrapDiff([true, false, false, false], [true, true, true, false], 'share');
  assert.equal(d.est, 0.5);
});

test('compareAB never diffs the A-only "later panic" metrics', () => {
  const { dates, raw } = fixture();
  for (const i of [400, 430]) raw.QQQ[i] = { ...raw.QQQ[i], low: 96 };
  raw.VIX[430] = { ...raw.VIX[430], high: 35 };
  const F = buildFrame(raw, cfgFor(dates));
  const R = runThreshold(F, -3);
  const ab = compareAB(R.reps);
  assert.equal(ab.A.n, 1);
  assert.equal(ab.B.n, 1);
  assert.equal(ab.diff.panicLater20, null);
});

test('periodProfile counts only days inside the window', () => {
  const { dates, raw } = fixture();
  raw.QQQ[420] = { ...raw.QQQ[420], low: 96 };
  const F = buildFrame(raw, cfgFor(dates));
  const runs = [runThreshold(F, -3), runThreshold(F, -2)];
  const p = periodProfile(F, dates[410], dates[430], runs);
  assert.equal(p.days, 21);
  assert.equal(p.events[-3].raw, 1);
  assert.equal(periodProfile(F, dates[421], dates[430], runs).events[-3].raw, 0);
});

test('Newcombe matches the published hybrid-score interval (12/14 vs 12/12)', () => {
  const d = newcombe(12, 14, 12, 12);
  assert.ok(Math.abs(d.est - 0.142857) < 1e-5);
  assert.ok(Math.abs(d.lo - -0.12051) < 1e-4 && Math.abs(d.hi - 0.39941) < 1e-4);
});

test('volume percentile uses only T-252..T-1', () => {
  const arr = Array.from({ length: 300 }, (_, i) => i);   // strictly rising: today beats every prior day
  const p = priorPercentile(arr, 252);
  assert.equal(p[251], null);
  assert.equal(p[252], 100);
  arr[260] = -1;
  assert.equal(priorPercentile(arr, 252)[260], 0);
});

test('gap and session drop split the intraday drop; A0/A1 depend only on T-60..T-1', () => {
  const { dates, raw } = fixture();
  raw.QQQ[400] = { ...raw.QQQ[400], open: 97, low: 96.5 };
  raw.VIX[350] = { ...raw.VIX[350], high: 33 };            // inside pre window → A1
  raw.VIX[401] = { ...raw.VIX[401], high: 33 };            // future: must not change A0/A1
  const F = buildFrame(raw, cfgFor(dates));
  const r = eventRow(F, 400);
  assert.ok(Math.abs(r.gap - -3) < 1e-9);
  assert.ok(Math.abs(r.sessionDrop - (96.5 / 97 - 1) * 100) < 1e-9);
  assert.equal(r.panic, 'A');
  assert.equal(r.panicSub, 'A1');
  assert.equal(r.path, 'A→B ≤20日');
  raw.VIX[350] = { ...raw.VIX[350], high: 16 };
  assert.equal(eventRow(buildFrame(raw, cfgFor(dates)), 400).panicSub, 'A0');
});

test('deep5/deep10 flags are relative to event-day Low', () => {
  const { dates, raw } = fixture();
  raw.QQQ[400] = { ...raw.QQQ[400], low: 96 };
  raw.QQQ[430] = { ...raw.QQQ[430], low: 96 * 0.94 };
  const r = eventRow(buildFrame(raw, cfgFor(dates)), 400);
  assert.equal(r.h[20].deep5, false);
  assert.equal(r.h[60].deep5, true);
  assert.equal(r.h[60].deep10, false);
});

test('matching never uses later or same-group events and returns fixed-k neighbours', () => {
  const { dates, raw } = fixture(700);
  for (const i of [380, 420, 460, 500, 540, 580, 620]) raw.QQQ[i] = { ...raw.QQQ[i], low: 96 };
  raw.QQQ[625] = { ...raw.QQQ[625], low: 96 };            // same group as 620
  const F = buildFrame(raw, cfgFor(dates));
  const R = runThreshold(F, -3);
  const target = R.rows.find(r => r.idx === 620);
  const [m] = matchEvents([target], R.rows);
  assert.ok(m.neighbors.length <= 5);
  for (const x of m.neighbors) { assert.ok(x.r.date < target.date); assert.notEqual(x.r.groupId, target.groupId); assert.equal(x.r.complete, true); }
});

test('year-block bootstrap needs at least three years', () => {
  const rows = [{ date: '2020-01-01', x: 1 }, { date: '2021-01-01', x: 2 }];
  assert.equal(yearBlockCI(rows, rs => rs.length).lo, null);
});

test('MA break: general needs prior close ≥ MA, close < MA and RVOL ≥ 1.5; strict also needs 20 days above', () => {
  const { dates, raw } = fixture(560);
  for (let i = 380; i < 400; i++) raw.QQQ[i] = { ...raw.QQQ[i], close: 103, high: 103.5, open: 103 };   // above MA for 20 days
  raw.QQQ[400] = { ...raw.QQQ[400], close: 95, low: 94.5, open: 102, volume: 5000 };                   // break with RVOL 5
  raw.QQQ[401] = { ...raw.QQQ[401], close: 101, high: 101.5 };
  raw.QQQ[402] = { ...raw.QQQ[402], close: 95, low: 94.8, volume: 1200 };                              // re-break but RVOL < 1.5
  const F = buildFrame(raw, cfgFor(dates));
  const ev = maBreakEvents(F, 150);
  assert.deepEqual(ev.map(r => r.date), [dates[400]]);
  assert.equal(ev[0].strict, true);
  assert.equal(ev[0].reclaim20, 'yes');
  assert.equal(ev[0].reclaimDays, 1);
  assert.equal(ev[0].alreadyDeep, false);
  assert.equal(maBreakEvents(F, 150, { ...DEFAULTS, mas: [150], rvol: 0, strictDays: 20, post: 120, deep: -20, preHighDays: 252, below: 0.7 }).length, 2);
});

test('MA break union counts a same-day 125/150 break once', () => {
  const u = maBreakUnion({ 125: [{ date: '2024-01-02', idx: 1 }], 150: [{ date: '2024-01-02', idx: 1 }, { date: '2024-02-01', idx: 20 }] });
  assert.equal(u.length, 2);
  assert.deepEqual(u[0].mas, [125, 150]);
});

// ── 互動頁預設設定必須與研究腳本一致（真實資料，離線）──────────────────
import { readFileSync } from 'node:fs';
import { configure, isFormal, run } from './qqqpanic_calc.mjs';
const realData = () => {
  const rd = p => JSON.parse(readFileSync(new URL('../../data/' + p, import.meta.url), 'utf8')).data;
  return { QQQ: rd('QQQ.json'), VIX: rd('VIX.json'), VXN: rd('VXN.json'), FG: rd('fear_greed.json') };
};
const report = () => JSON.parse(readFileSync(new URL('../../docs/research/qqq-panic-divergence-backtest.json', import.meta.url), 'utf8'));

test('UI default configuration reproduces the research report sample counts', () => {
  const cfg = configure({});
  assert.equal(isFormal(cfg, -3), true);
  const { F } = run(realData());
  for (const s of report().samples) {
    const R = runThreshold(F, s.threshold, cfg);
    assert.equal(R.rows.length, s.raw, `raw ${s.threshold}`);
    assert.equal(R.groups.length, s.groups, `groups ${s.threshold}`);
    assert.equal(R.rows.filter(r => r.panic === 'A').length, s.rawA);
    assert.equal(R.rows.filter(r => r.panic === 'B').length, s.rawB);
    assert.equal(R.reps.filter(r => r.volSurge && r.panic === 'A').length, s.groupVolA);
  }
});

test('acceptance: 2026-10-22 / 10-30 values, RVOL 2.0 filter and VIX threshold 20 reclassification', () => {
  const { F } = run(realData());
  const R = runThreshold(F, -3, configure({}));
  const e22 = R.rows.find(r => r.date === '2026-10-22'), e30 = R.rows.find(r => r.date === '2026-10-30');
  assert.ok(e22 && e30, 'both events kept in the all-events set even though they share a 20-day group');
  assert.equal(e22.groupId, e30.groupId);
  assert.ok(Math.abs(e30.dropLow - -4.458) < 0.01);
  assert.ok(Math.abs(e30.volRatio - 2.32) < 0.01);
  assert.equal(e30.vixHigh, 23.93);
  assert.equal(e30.fg, 26.24);
  assert.equal(e30.panicSub, 'A0');
  assert.ok(Math.abs(e30.ma[150].dist - -1.90) < 0.01);
  assert.equal(e30.avail, 0);
  assert.equal(e30.h[60], null);
  assert.ok(e22.volRatio < 2 && e30.volRatio >= 2, 'RVOL 2.0 keeps 10-30 and drops 10-22');
  const R20 = runThreshold(F, -3, configure({ vixPanic: 20 }));
  assert.equal(R20.rows.find(r => r.date === '2026-10-30').panic, 'B');
  assert.equal(isFormal(configure({ vixPanic: 20 }), -3), false);
});

test('exploratory drop definitions and windows recompute events instead of relabelling', () => {
  const { F } = run(realData());
  const low = runThreshold(F, -3, configure({})).rows.length;
  const close = runThreshold(F, -3, configure({ dropDef: 'close' })).rows;
  assert.ok(close.length < low);
  for (const r of close) assert.ok(r.closeChg <= -3 + 1e-9);
  const c120 = configure({ postWin: 120, preWin: 20 });
  assert.deepEqual(c120.horizons, [5, 20, 60, 120]);
  assert.deepEqual(configure({ postWin: 20 }).horizons, [5, 20]);
  const r120 = runThreshold(F, -3, c120).rows.find(x => x.date === '2022-01-05');
  assert.ok(r120.h[120] && r120.complete && r120.avail === 120);
});
