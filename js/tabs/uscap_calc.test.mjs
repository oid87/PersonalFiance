import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, MODELS, stageSensitive, buildDataset, buildFrame, stageA, stageB, pickEvents, findWaves, confirmStage, invalidation, outcomeAt, modelEvents, runModels, cftcAt, finraAt, volDivergence, liveStatus } from './uscap_calc.mjs';

function businessDays(start, n) {
  const out = []; let t = Date.parse(start);
  while (out.length < n) { const d = new Date(t); if (![0, 6].includes(d.getUTCDay())) out.push(d.toISOString().slice(0, 10)); t += 86400000; }
  return out;
}
const bar = (c, o = c) => ({ open: o, high: Math.max(o, c) * 1.005, low: Math.min(o, c) * 0.995, close: c });
/** closes → rows; vix/vxn maps are filled by caller */
function rows(dates, closes) { return dates.map((date, i) => ({ date, ...bar(closes[i], i ? closes[i - 1] : closes[i]) })); }
function dataset({ dates, closes, vix, vxn = null, pcr = null }) {
  const series = a => a.map((close, i) => ({ date: dates[i], close }));
  return buildDataset({
    SPY: rows(dates, closes), QQQ: rows(dates, closes), VIX: series(vix), VXN: vxn ? series(vxn) : [],
    vixTerm: [], putcall: { equity: pcr ? dates.map((date, i) => ({ date, pc: pcr[i] })) : [] },
  });
}
const flat = (n, v) => new Array(n).fill(v);

test('Stage A is unavailable (null) — never false — when both vol indices are missing', () => {
  const dates = businessDays('2023-01-02', 200), closes = flat(200, 100);
  closes[199] = 85; // deep drawdown on the last day
  const ds = dataset({ dates, closes, vix: flat(200, 40) });
  const frame = buildFrame(ds, 'SPY');
  const d = { ...frame.days[199], vix: null, vxn: null };
  assert.equal(stageA(d, DEFAULTS), null);
  assert.equal(stageA(frame.days[199], DEFAULTS), true);
  assert.equal(stageB(frame.days[199], DEFAULTS), null, 'PCR history missing → Model B cannot be evaluated');
});

test('VXN-only extreme triggers Stage A for the OR rule', () => {
  const dates = businessDays('2023-01-02', 200), closes = flat(200, 100); closes[199] = 85;
  const ds = dataset({ dates, closes, vix: flat(200, 20), vxn: flat(200, 36) });
  const f = buildFrame(ds, 'QQQ');
  assert.equal(stageA(f.days[199], DEFAULTS), true);
});

test('PCR percentile never mixes regimes and needs 126 earlier same-regime values', () => {
  const dates = businessDays('2019-04-01', 330);
  const brk = dates.findIndex(d => d >= '2019-10-05');
  const pcr = dates.map((_, i) => (i < brk ? 0.5 : 1.0 + (i % 7) * 0.001));   // all-exchange regime sits far above the CBOE-only regime
  const ds = dataset({ dates, closes: flat(330, 100), vix: flat(330, 20), pcr });
  const f = buildFrame(ds, 'SPY');
  const firstValid = f.days.findIndex((d, i) => i >= brk && Number.isFinite(d.pcrThr));
  assert.equal(firstValid, brk + 4 + 126, 'first valid index = break + 4 (5-day mean) + 126 prior averages');
  assert.ok(f.days.slice(brk, firstValid).every(d => d.pcrExt === null), 'unavailable, not false');
  assert.ok(f.days[firstValid].pcrThr < 1.01, 'threshold comes from the new regime only (old 0.5 values are ignored)');
});

test('next-open entry, horizon includes the entry day, MAE/MFE use window low/high', () => {
  const dates = businessDays('2023-01-02', 10);
  const raw = { SPY: dates.map((date, i) => ({ date, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i })), QQQ: [], VIX: dates.map(date => ({ date, close: 20 })) };
  raw.QQQ = raw.SPY;
  const f = buildFrame(buildDataset(raw), 'SPY', { lookback: 3, maDays: 3, horizons: [2], troughWindow: 3, rebreakWindow: 3 });
  const o = outcomeAt(f.days, 3, f.cfg);
  assert.equal(o.entryDate, dates[4]);
  assert.equal(o.entry, 104);
  assert.equal(o.h[2].status, 'complete');
  assert.ok(Math.abs(o.h[2].ret - (105.5 / 104 - 1) * 100) < 1e-9, 'return = close of 2nd bar (entry day + 1) / entry open');
  assert.ok(Math.abs(o.h[2].mae - 0) < 1e-12 || o.h[2].mae <= 0);
  assert.ok(Math.abs(o.h[2].mfe - (106 / 104 - 1) * 100) < 1e-9);
  assert.equal(outcomeAt(f.days, 9, f.cfg).h[2].status, 'rightCensored');
});

test('cooldown keeps the first signal and spaces later ones by at least N sessions', () => {
  const days = Array.from({ length: 30 }, (_, i) => ({ i, date: String(i) }));
  const hits = new Set([2, 3, 4, 12, 13, 25]);
  assert.deepEqual(pickEvents(days, d => hits.has(d.i), 10), [2, 12, 25]);
});

test('drawdown waves enter at 8% and leave below 3%', () => {
  const days = [0, 1, 5, 9, 8, 6, 4, 2.5, 1, 9, 3.5, 2].map((dd, i) => ({ i, date: `d${i}`, dd, ok: true, close: 100 - dd }));
  const w = findWaves(days, DEFAULTS);
  assert.equal(w.length, 2);
  assert.deepEqual([w[0].start, w[0].end], [3, 7]);
  assert.deepEqual([w[1].start, w[1].end], [9, 11]);
});

test('Stage C needs all three: no new low, vol retreat, reclaim — and uses only data up to that day', () => {
  const n = 60, dates = businessDays('2023-01-02', n);
  // falls to a low at index 20, then recovers; VIX peaks at 40 on day 18 and decays
  const closes = Array.from({ length: n }, (_, i) => (i <= 20 ? 100 - i : 80 + (i - 20) * 0.8));
  const vix = Array.from({ length: n }, (_, i) => (i <= 18 ? 20 + i * (20 / 18) : Math.max(18, 40 - (i - 18) * 2)));
  const ds = dataset({ dates, closes, vix });
  const f = buildFrame(ds, 'SPY', { lookback: 5 });
  const c = confirmStage(f.days, 15, f.cfg);
  assert.ok(c, 'confirms after the bounce');
  assert.ok(c.index >= 20 + f.cfg.noNewLowDays, 'cannot confirm before 5 sessions without a new low');
  assert.ok(f.days[c.index].vol <= f.cfg.volRetreat * c.volPeak && f.days[c.index].close > f.days[c.index].sma);
  // truncating the future must not change an already-made decision
  const cut = { ...f, days: f.days.slice(0, c.index + 1) };
  assert.equal(confirmStage(cut.days, 15, f.cfg).index, c.index);
  // volatility that never retreats → no confirmation
  const stuck = buildFrame(dataset({ dates, closes, vix: flat(n, 40) }), 'SPY', { lookback: 5 });
  assert.equal(confirmStage(stuck.days, 15, stuck.cfg), null);
});

test('failure recognition = close below the lowest close between Stage A and the confirmation', () => {
  const days = Array.from({ length: 30 }, (_, i) => ({ i, date: `d${i}`, ok: true, open: 100, close: i < 10 ? 100 : i === 15 ? 90 : 105, low: 90, high: 110 }));
  const conf = { index: 10, runLow: 95 };
  const inv = invalidation(days, conf, 60);
  assert.equal(inv.index, 15);
  assert.equal(inv.days, 5);
  assert.ok(Math.abs(inv.lossAtInvalidation - (90 / 100 - 1) * 100) < 1e-9);
  assert.equal(invalidation(days, { index: 10, runLow: 80 }, 60), null);
});

test('Models C and D are reported unavailable (no Down Volume), never approximated', () => {
  const dates = businessDays('2023-01-02', 200);
  const f = buildFrame(dataset({ dates, closes: flat(200, 100), vix: flat(200, 20) }), 'SPY');
  const r = runModels(f);
  assert.match(r.C.unavailable, /Down Volume/);
  assert.match(r.D.unavailable, /Down Volume/);
  assert.ok(MODELS.filter(m => m.unavailable).map(m => m.id).join() === 'C,D');
  assert.equal(r.A.baseCount, 0);
});

test('CFTC reports are visible only after the Friday release (as-of Tuesday + 3 days, strictly before the decision date)', () => {
  const rows = [{ date: '2024-01-02', lev_long: 100, lev_short: 300, open_interest: 1000, lev_net: -200 }, { date: '2023-12-26', lev_long: 100, lev_short: 100, open_interest: 1000, lev_net: 0 }];
  const cftc = { main: { instruments: [{ id: 'sp500', rows }] }, history: null };
  assert.equal(cftcAt(cftc, 'sp500', '2024-01-05').date, '2023-12-26', 'release day itself is not usable for a same-day close decision');
  const seen = cftcAt(cftc, 'sp500', '2024-01-06');
  assert.equal(seen.date, '2024-01-02');
  assert.equal(seen.ratio, -20);
  assert.equal(cftcAt(cftc, 'sp500', '2023-12-20'), null);
});

test('FINRA monthly margin debt is assumed public ~25 days after month-end and never interpolated', () => {
  const rows = Array.from({ length: 14 }, (_, k) => ({ date: `${2023 + Math.floor(k / 12)}-${String(k % 12 + 1).padStart(2, '0')}-01`, margin_balance: 1000 + k * 10 }));
  const a = finraAt(rows, '2024-02-26');      // Jan-2024 month-end 01-31 + 25 = 02-25 → visible from 02-26
  assert.equal(a.month, '2024-01');
  const b = finraAt(rows, '2024-02-25');
  assert.equal(b.month, '2023-12');
  assert.ok(Math.abs(a.mom - (1120 / 1110 - 1) * 100) < 1e-9);
});

test('volatility divergence uses only the prior 60 sessions', () => {
  const n = 70, days = Array.from({ length: n }, (_, i) => ({ i, ok: true, close: 100 - i * 0.1, vol: 20 + (i === 30 ? 15 : 0) }));
  days[69] = { ...days[69], close: 80, vol: 25 };
  const v = volDivergence(days, 69, DEFAULTS);
  assert.deepEqual([v.newLow, v.volNotHigh, v.diverged], [true, true, true]);
  days[69].vol = 40;
  assert.equal(volDivergence(days, 69, DEFAULTS).diverged, false);
  assert.equal(volDivergence(days, 10, DEFAULTS), null);
});

test('liveStatus marks Down Volume unavailable and reports the latest Stage A / Stage C state', () => {
  const n = 220, dates = businessDays('2023-01-02', n);
  const closes = Array.from({ length: n }, (_, i) => (i < 150 ? 100 : 100 - (i - 150) * 0.6));
  const vix = Array.from({ length: n }, (_, i) => (i < 150 ? 18 : 18 + (i - 150) * 0.6));
  const f = buildFrame(dataset({ dates, closes, vix }), 'SPY');
  const s = liveStatus(f, buildDataset({ SPY: rows(dates, closes), QQQ: rows(dates, closes), VIX: dates.map((date, i) => ({ date, close: vix[i] })) }));
  assert.equal(s.a.downVolume.ok, null);
  assert.equal(s.date, dates[n - 1]);
  assert.equal(typeof s.anyA, 'boolean');
  assert.ok(s.a.pcr.ok === null, 'no put/call data → unavailable');
});

test('stabilization models re-time events to the confirmation day and skip unconfirmed ones', () => {
  const n = 120, dates = businessDays('2023-01-02', n);
  const closes = Array.from({ length: n }, (_, i) => (i < 40 ? 100 : i < 60 ? 100 - (i - 40) * 1.2 : 76 + (i - 60) * 0.6));
  const vix = Array.from({ length: n }, (_, i) => (i < 40 ? 15 : i < 60 ? 15 + (i - 40) * 1.5 : Math.max(18, 45 - (i - 60) * 1.5)));
  const f = buildFrame(dataset({ dates, closes, vix }), 'SPY', { gate: 8, lookback: 30 });
  const a = modelEvents(f, MODELS.find(m => m.id === 'A'));
  const s = modelEvents(f, MODELS.find(m => m.id === 'AS'));
  assert.ok(a.baseCount >= 1);
  assert.ok(s.confirmedCount >= 1);
  for (const e of s.confirmed) { assert.ok(e.index > e.panicIdx); assert.equal(e.index, e.panicIdx + e.conf.lag); }
});

test('sensitive tier fires on VXN ≥ 30 alone (no VIX needed) but stays off the primary Stage A', () => {
  const dates = businessDays('2023-01-02', 200), closes = flat(200, 100); closes[199] = 85;
  const mk = vxn => buildFrame(dataset({ dates, closes, vix: flat(200, 20), vxn: flat(200, vxn) }), 'QQQ').days[199];
  const hot = mk(30.8), cool = mk(29);
  assert.equal(stageSensitive(hot, DEFAULTS), true);
  assert.equal(stageA(hot, DEFAULTS), false, 'VXN 30.8 < 35 and VIX 20 < 30');
  assert.equal(stageSensitive(cool, DEFAULTS), false);
  assert.equal(stageSensitive({ ...hot, vxn: null }, DEFAULTS), null);
  assert.equal(stageSensitive({ ...hot, dd: 5 }, DEFAULTS), false, 'same drawdown gate');
  const f = buildFrame(dataset({ dates, closes, vix: flat(200, 20), vxn: flat(200, 31) }), 'QQQ');
  assert.equal(runModels(f).S.baseCount, 1);
});
