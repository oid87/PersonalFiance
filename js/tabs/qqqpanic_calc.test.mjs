import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, buildFrame, isEvent, eventRow, rawEvents, groupEvents, runThreshold, panicClass, wilson, bootstrapCI, bootstrapDiff, quantile, sma, compareAB, periodProfile } from './qqqpanic_calc.mjs';

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
