// US Capitulation Alert — pure engine (no DOM). Shared by js/tabs/uscap.js and scripts/research/backtest_us_capitulation.mjs.
// Descriptive research only: no trade instructions, no change to any formal trading rule.
//
// Three stages, deliberately NOT summed into one score:
//   Stage A  Panic Detection         VIX/VXN extreme, equity put/call extreme, price drawdown gate
//   Stage B  Deleveraging context    CFTC leveraged-fund positioning, FINRA margin debt, credit (display only; never a model input)
//   Stage C  Stabilization confirm   vol index retreat + no new closing low + close back above a short moving average
// NYSE/Nasdaq Down/Up Volume has no qualified source in this project (docs/research/us-capitulation-alert.md), so every
// Down-Volume rule is reported as unavailable instead of being replaced by SPY/QQQ volume.
import { percentile } from '../utils/math.js';

const DAY = 86400000;
const finite = v => typeof v === 'number' && Number.isFinite(v);
const addDays = (date, n) => new Date(Date.parse(date) + n * DAY).toISOString().slice(0, 10);

/** Fixed (pre-registered) parameters. Thresholds come from the requirement's candidate list and the existing usrisk defaults;
 *  none was fitted to the 2022 sample. The sensitivity tables vary them for exploration only. */
export const DEFAULTS = Object.freeze({
  gate: 8, cooldown: 10, lookback: 120,
  vix: 30, vxn: 35, vxnSensitive: 30,
  pcrPct: 95, pcrWindow: 504, pcrMin: 126, pcrAvg: 5, pcrBreak: '2019-10-05',
  waveEnter: 8, waveExit: 3,
  confirmWindow: 40, noNewLowDays: 5, volRetreat: 0.8, maDays: 10,
  horizons: [5, 10, 20, 60, 120], troughWindow: 60, rebreakWindow: 20,
});

export const MODELS = Object.freeze([
  { id: 'A', label: 'A：VIX/VXN 極端', base: 'A', stabilize: false },
  { id: 'B', label: 'B：A ＋ Put/Call 極端', base: 'B', stabilize: false },
  { id: 'C', label: 'C：A ＋ 90% Down Volume', unavailable: '沒有合格的 NYSE/Nasdaq Down Volume 資料來源' },
  { id: 'D', label: 'D：A ＋ PCR ＋ 90% Down Volume', unavailable: '沒有合格的 NYSE/Nasdaq Down Volume 資料來源' },
  { id: 'AS', label: 'A′：A ＋ 止穩確認', base: 'A', stabilize: true },
  { id: 'S', label: '敏感層（非主設定）：VXN ≥ 30 ＋ 回撤閘門，不要求 VIX', base: 'S', stabilize: false, tier: 'sensitive' },
  { id: 'E', label: 'E′：B ＋ 止穩確認（Model D 缺 Down Volume，以 B 取代）', base: 'B', stabilize: true },
]);

export const PERIODS = Object.freeze([
  ['2000–2002', '2000-01-01', '2002-12-31'], ['2008–2009', '2008-01-01', '2009-12-31'], ['2011', '2011-01-01', '2011-12-31'],
  ['2015–2016', '2015-01-01', '2016-12-31'], ['2018', '2018-01-01', '2018-12-31'], ['2020', '2020-01-01', '2020-12-31'],
  ['2022', '2022-01-01', '2022-12-31'], ['2025', '2025-01-01', '2025-12-31'], ['2026', '2026-01-01', '2026-12-31'],
]);

export const goodBar = r => !!r && ['open', 'high', 'low', 'close'].every(k => finite(r[k]) && r[k] > 0) &&
  r.low <= Math.min(r.open, r.close) && r.high >= Math.max(r.open, r.close);

const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return percentile(s, 0.5); };
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const q = (a, p) => { if (!a.length) return null; return percentile([...a].sort((x, y) => x - y), p); };
const mapBy = (rows, key) => new Map((rows || []).filter(r => r && typeof r.date === 'string' && finite(r[key])).map(r => [r.date, r[key]]));

// ── Dataset ───────────────────────────────────────────────────────────────
/** raw = { SPY, QQQ, VIX, VXN: [{date,open,high,low,close}], vixTerm: [{date,vix9d,vix3m}], putcall: {equity:[{date,pc}]} }  */
export function buildDataset(raw) {
  for (const id of ['SPY', 'QQQ', 'VIX']) if (!Array.isArray(raw?.[id]) || !raw[id].length) throw new Error(`Unavailable core source: ${id}`);
  const equity = raw.putcall?.equity || [];
  return {
    prices: { SPY: raw.SPY, QQQ: raw.QQQ },
    vix: mapBy(raw.VIX, 'close'), vxn: mapBy(raw.VXN, 'close'),
    vix9d: mapBy(raw.vixTerm, 'vix9d'), vix3m: mapBy(raw.vixTerm, 'vix3m'),
    pcr: mapBy(equity, 'pc'),
    hyg: raw.HYG || [], oas: mapBy(raw.credit, 'hy'),
    breadthSpx: mapBy(raw.breadth, 'above50_pct'), breadthNdx: mapBy(raw.breadthNdx, 'above50_pct'),
    cftc: raw.cftc || null, finra: raw.finra || [],
    lastDate: raw[raw.SPY ? 'SPY' : 'QQQ'].at(-1).date,
  };
}

/** Rolling percentile threshold of `series` (null-tolerant) using only earlier values inside the same segment. */
function rollingThreshold(values, segments, pct, window, min) {
  const out = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    if (!finite(values[i])) continue;
    const past = [];
    for (let j = i - 1; j >= 0 && i - j <= window; j--) {
      if (segments[j] !== segments[i]) break;           // never mix the CBOE-only and all-exchange put/call regimes
      if (finite(values[j])) past.push(values[j]);
    }
    if (past.length >= min) out[i] = percentile(past.sort((a, b) => a - b), pct / 100);
  }
  return out;
}

/** One analysis frame per asset: every derived series is aligned to the asset's own trading days; nothing is forward-filled. */
export function buildFrame(ds, asset, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const bars = ds.prices[asset];
  const n = bars.length, days = new Array(n);
  const volOf = date => (asset === 'QQQ' && ds.vxn.has(date) ? ds.vxn.get(date) : ds.vix.get(date) ?? null);
  const pcrRaw = bars.map(b => ds.pcr.get(b.date) ?? null);
  const segs = bars.map(b => (b.date < c.pcrBreak ? 0 : 1));
  const pcrAvg = pcrRaw.map((_, i) => {
    if (i < c.pcrAvg - 1) return null;
    let s = 0;
    for (let k = 0; k < c.pcrAvg; k++) { const v = pcrRaw[i - k]; if (!finite(v) || segs[i - k] !== segs[i]) return null; s += v; }
    return s / c.pcrAvg;
  });
  const thr = rollingThreshold(pcrAvg, segs, c.pcrPct, c.pcrWindow, c.pcrMin);
  for (let i = 0; i < n; i++) {
    const b = bars[i], ok = goodBar(b);
    let dd = null;
    if (ok && i >= c.lookback - 1) {
      let hi = -Infinity, bad = false;
      for (let k = i - c.lookback + 1; k <= i; k++) { if (!goodBar(bars[k])) { bad = true; break; } if (bars[k].close > hi) hi = bars[k].close; }
      if (!bad) dd = (1 - b.close / hi) * 100;
    }
    let sma = null;
    if (ok && i >= c.maDays - 1) { let s = 0; for (let k = 0; k < c.maDays; k++) { if (!goodBar(bars[i - k])) { s = NaN; break; } s += bars[i - k].close; } if (Number.isFinite(s)) sma = s / c.maDays; }
    const vix = ds.vix.get(b.date) ?? null, vxn = ds.vxn.get(b.date) ?? null;
    const prevVix = i ? (ds.vix.get(bars[i - 1].date) ?? null) : null;
    days[i] = {
      i, date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, ok, dd, sma,
      vix, vxn, vol: volOf(b.date), vixChg: finite(vix) && finite(prevVix) && prevVix > 0 ? (vix / prevVix - 1) * 100 : null,
      term: finite(ds.vix9d.get(b.date)) && ds.vix3m.get(b.date) > 0 ? ds.vix9d.get(b.date) / ds.vix3m.get(b.date) : null,
      pcr: pcrRaw[i], pcrAvg: pcrAvg[i], pcrThr: thr[i],
      pcrExt: finite(pcrAvg[i]) && finite(thr[i]) ? pcrAvg[i] >= thr[i] : null,
    };
  }
  return { asset, cfg: c, days, byDate: new Map(days.map(d => [d.date, d])), segs, pcrAvg };
}

// ── Stage A predicates ────────────────────────────────────────────────────
/** Three-valued: true / false / null (unavailable). Callers treat null as "cannot evaluate", never as "not triggered". */
export function volExtreme(d, c) {
  const a = finite(d.vix) ? d.vix >= c.vix : null, b = finite(d.vxn) ? d.vxn >= c.vxn : null;
  if (a === true || b === true) return true;
  if (a === null && b === null) return null;
  return false;
}
export const stageA = (d, c) => (d.ok && finite(d.dd) ? (volExtreme(d, c) === null ? null : volExtreme(d, c) && d.dd >= c.gate) : null);
export const stageB = (d, c) => { const a = stageA(d, c); if (a === null) return null; if (!a) return false; return d.pcrExt === null ? null : d.pcrExt; };
/** QQQ-oriented sensitive tier: VXN alone at 30 (no VIX requirement) plus the same drawdown gate. Shown beside, never merged into, the primary models. */
export const stageSensitive = (d, c) => (d.ok && finite(d.dd) && finite(d.vxn) ? d.vxn >= c.vxnSensitive && d.dd >= c.gate : null);
const PRED = { A: stageA, B: stageB, S: stageSensitive };

// ── Event selection ───────────────────────────────────────────────────────
export function pickEvents(days, pred, cooldown) {
  const out = []; let last = -Infinity;
  for (const d of days) if (pred(d) === true && d.i - last >= cooldown) { out.push(d.i); last = d.i; }
  return out;
}
export function findWaves(days, c) {
  const waves = []; let w = null;
  for (const d of days) {
    if (!w && finite(d.dd) && d.dd >= c.waveEnter) w = { start: d.i, end: null, maxDd: d.dd, troughIdx: d.i };
    if (w) {
      if (finite(d.dd) && d.dd > w.maxDd) w.maxDd = d.dd;
      if (d.ok && d.close < days[w.troughIdx].close) w.troughIdx = d.i;
      if (finite(d.dd) && d.dd < c.waveExit) { w.end = d.i; waves.push(w); w = null; }
    }
  }
  if (w) waves.push(w);
  for (const x of waves) { x.startDate = days[x.start].date; x.endDate = x.end == null ? null : days[x.end].date; x.troughDate = days[x.troughIdx].date; }
  return waves;
}
const waveOf = (waves, i) => waves.findIndex(w => i >= w.start && (w.end == null || i <= w.end));
export function waveFirst(waves, idxs) {
  const seen = new Set(), out = [];
  for (const i of idxs) { const w = waveOf(waves, i); if (w >= 0 && !seen.has(w)) { seen.add(w); out.push(i); } }
  return out;
}

// ── Stage C: stabilization confirmation after a Stage A event ─────────────
/** Causal: on day t only data up to t is used. Returns the first confirmation day inside the window, or null. */
export function confirmStage(days, a, c) {
  const end = Math.min(days.length - 1, a + c.confirmWindow);
  let low = Infinity, lowIdx = a, volPeak = -Infinity;
  for (let t = a; t <= end; t++) {
    const d = days[t];
    if (!d.ok) continue;
    if (d.close <= low) { low = d.close; lowIdx = t; }
    if (finite(d.vol) && d.vol > volPeak) volPeak = d.vol;
    if (t === a) continue;
    const noNewLow = t - lowIdx >= c.noNewLowDays;
    const volDown = finite(d.vol) && volPeak > 0 && d.vol <= c.volRetreat * volPeak;
    const reclaim = finite(d.sma) && d.close > d.sma;
    if (noNewLow && volDown && reclaim) return { index: t, lag: t - a, runLow: low, runLowIdx: lowIdx, volPeak };
  }
  return null;
}
/** Re-break after confirmation: first close below the lowest close seen between the Stage A day and the confirmation day. */
export function invalidation(days, conf, horizon) {
  for (let t = conf.index + 1; t <= Math.min(days.length - 1, conf.index + horizon); t++) {
    if (days[t].ok && days[t].close < conf.runLow) {
      const entry = days[conf.index + 1]?.open;
      return { index: t, days: t - conf.index, lossAtInvalidation: finite(entry) ? (days[t].close / entry - 1) * 100 : null };
    }
  }
  return null;
}

// ── Outcomes ──────────────────────────────────────────────────────────────
/** Signal known after the close of day i → earliest entry is day i+1's open. Horizon h covers days i+1 … i+h (entry day included). */
export function outcomeAt(days, i, c, refLow = days[i].low) {
  const entryBar = days[i + 1];
  const res = { date: days[i].date, entryDate: entryBar?.date ?? null, entry: null, h: {}, trough: null, rebreak: null };
  if (!entryBar || !goodBar(entryBar)) { for (const h of c.horizons) res.h[h] = { status: entryBar ? 'badPrice' : 'rightCensored' }; return res; }
  res.entry = entryBar.open;
  const clean = len => { for (let k = 1; k <= len; k++) if (!days[i + k]?.ok) return false; return true; };
  for (const h of c.horizons) {
    if (i + h >= days.length) { res.h[h] = { status: 'rightCensored' }; continue; }
    if (!clean(h)) { res.h[h] = { status: 'badPrice' }; continue; }
    let lo = Infinity, hi = -Infinity;
    for (let k = 1; k <= h; k++) { lo = Math.min(lo, days[i + k].low); hi = Math.max(hi, days[i + k].high); }
    res.h[h] = { status: 'complete', ret: (days[i + h].close / res.entry - 1) * 100, mae: Math.min(0, (lo / res.entry - 1) * 100), mfe: Math.max(0, (hi / res.entry - 1) * 100) };
  }
  if (i + c.troughWindow < days.length && clean(c.troughWindow)) {
    let lo = Infinity, at = 1;
    for (let k = 1; k <= c.troughWindow; k++) if (days[i + k].low < lo) { lo = days[i + k].low; at = k; }
    res.trough = { days: at, pct: (lo / res.entry - 1) * 100, newLow: lo < refLow };
  }
  if (i + c.rebreakWindow < days.length && clean(c.rebreakWindow)) {
    let lo = Infinity; for (let k = 1; k <= c.rebreakWindow; k++) lo = Math.min(lo, days[i + k].low);
    res.rebreak = lo < refLow;
  }
  return res;
}

function summarize(items, c) {
  const rows = items.map(x => x.out);
  const by = {};
  for (const h of c.horizons) {
    const cs = rows.map(r => r.h[h]).filter(x => x?.status === 'complete');
    const rets = cs.map(x => x.ret);
    by[h] = {
      n: cs.length, mean: mean(rets), median: median(rets), win: rets.length ? rets.filter(v => v > 0).length / rets.length * 100 : null,
      maeMedian: median(cs.map(x => x.mae)), maeP10: q(cs.map(x => x.mae), 0.1), mfeMedian: median(cs.map(x => x.mfe)), mfeP90: q(cs.map(x => x.mfe), 0.9),
      retP10: q(rets, 0.1), retP90: q(rets, 0.9),
    };
  }
  const tr = rows.map(r => r.trough).filter(Boolean), rb = rows.map(r => r.rebreak).filter(v => v !== null);
  return { count: items.length, by, trough: { n: tr.length, medianDays: median(tr.map(x => x.days)), medianPct: median(tr.map(x => x.pct)), newLowRate: tr.length ? tr.filter(x => x.newLow).length / tr.length * 100 : null },
    rebreakRate: rb.length ? rb.filter(Boolean).length / rb.length * 100 : null, rebreakN: rb.length };
}

// ── Model runs ────────────────────────────────────────────────────────────
/** Events for one model on one frame. Stage-C models re-time each Stage A event to its confirmation day. */
export function modelEvents(frame, model, extra = {}) {
  const c = frame.cfg, days = frame.days;
  const pred = extra.pred || PRED[model.base];
  const from = extra.from || '0000-00-00', to = extra.to || '9999-99-99';
  const inRange = i => days[i].date >= from && days[i].date <= to;
  const triggerDays = days.filter(d => inRange(d.i) && pred(d, c) === true).map(d => d.i);
  const bases = pickEvents(days.filter(d => inRange(d.i)), d => pred(d, c), c.cooldown);
  const waves = findWaves(days, c);
  const make = baseIdx => {
    if (!model.stabilize) return { index: baseIdx, panicIdx: baseIdx, conf: null, out: outcomeAt(days, baseIdx, c) };
    const conf = confirmStage(days, baseIdx, c);
    if (!conf) return { index: null, panicIdx: baseIdx, conf: null, out: null };
    let refLow = Infinity; for (let t = baseIdx; t <= conf.index; t++) if (days[t].ok) refLow = Math.min(refLow, days[t].low);
    return { index: conf.index, panicIdx: baseIdx, conf, out: outcomeAt(days, conf.index, c, refLow), invalid: invalidation(days, conf, 60) };
  };
  const events = bases.map(make);
  const confirmed = events.filter(e => e.index !== null);
  const firstOfWave = waveFirst(waves, bases).map(make).filter(e => e.index !== null);
  return {
    model: model.id, label: model.label, stabilize: !!model.stabilize, triggerDays: triggerDays.length, baseCount: bases.length, confirmedCount: confirmed.length,
    events, confirmed, waveFirst: firstOfWave,
    stats: summarize(confirmed.filter(e => e.out), c), waveStats: summarize(firstOfWave.filter(e => e.out), c),
    allDaysStats: model.stabilize ? null : summarize(triggerDays.map(i => ({ out: outcomeAt(days, i, c) })), c),
  };
}

/** Baselines that need no signal: every eligible day, and drawdown-only (same gate, same cooldown). */
export function baselines(frame, extra = {}) {
  const c = frame.cfg, days = frame.days, from = extra.from || '0000-00-00', to = extra.to || '9999-99-99';
  const elig = days.filter(d => d.date >= from && d.date <= to && d.ok && finite(d.dd));
  const dd = pickEvents(elig, d => d.dd >= c.gate, c.cooldown);
  return {
    allDays: summarize(elig.map(d => ({ out: outcomeAt(days, d.i, c) })), c),
    drawdownOnly: summarize(dd.map(i => ({ out: outcomeAt(days, i, c) })), c), drawdownEvents: dd.length, eligibleDays: elig.length,
  };
}

export function runModels(frame, extra = {}) {
  const out = {};
  for (const m of MODELS) out[m.id] = m.unavailable ? { model: m.id, label: m.label, unavailable: m.unavailable } : modelEvents(frame, m, extra);
  return out;
}

// ── Sensitivity (exploration only — never used to choose the primary thresholds) ──
export function sensitivityDefs(c) {
  const gate = (d, f) => (d.ok && finite(d.dd) ? (f(d) === null ? null : f(d) && d.dd >= c.gate) : null);
  const ge = (key, thr) => d => (finite(d[key]) ? d[key] >= thr : null);
  const defs = [];
  for (const t of [20, 25, 30, 40, 50, 60]) defs.push({ group: 'VIX 水準', label: `VIX ≥ ${t}`, pred: d => gate(d, ge('vix', t)) });
  for (const t of [25, 30, 35, 40, 50, 60]) defs.push({ group: 'VXN 水準', label: `VXN ≥ ${t}`, pred: d => gate(d, ge('vxn', t)) });
  for (const t of [10, 15, 20, 30]) defs.push({ group: 'VIX 單日漲幅', label: `VIX 單日 ≥ +${t}%`, pred: d => gate(d, ge('vixChg', t)) });
  for (const t of [1, 1.05, 1.1, 1.2]) defs.push({ group: 'VIX9D/VIX3M（現貨，2011 起）', label: `VIX9D/VIX3M ≥ ${t}`, pred: d => gate(d, ge('term', t)) });
  defs.push({ group: 'Put/Call（5 日均）', label: `PCR5 ≥ P${c.pcrPct}（2 年窗，主設定）`, pred: d => gate(d, d2 => d2.pcrExt) });
  defs.push({ group: '價格', label: `只有回撤 ≥ ${c.gate}%（無任何指標）`, pred: d => (d.ok && finite(d.dd) ? d.dd >= c.gate : null) });
  return defs;
}
export function runSensitivity(frame, extra = {}) {
  const c = frame.cfg;
  const rows = [];
  for (const def of sensitivityDefs(c)) {
    const ev = modelEvents(frame, { id: def.label, base: 'A', stabilize: false }, { ...extra, pred: def.pred });
    rows.push({ group: def.group, label: def.label, triggerDays: ev.triggerDays, events: ev.baseCount, stats: ev.stats });
  }
  return rows;
}
/** PCR percentile / window variants (requires rebuilding the threshold, so it takes the dataset). */
export function runPcrVariants(ds, asset, extra = {}) {
  const rows = [];
  for (const pct of [90, 95, 99]) for (const [label, window, min] of [['2 年', 504, 126], ['5 年', 1260, 126]]) {
    const frame = buildFrame(ds, asset, { pcrPct: pct, pcrWindow: window, pcrMin: min });
    const ev = modelEvents(frame, { id: 'B', base: 'B', stabilize: false }, extra);
    rows.push({ label: `PCR5 ≥ P${pct}（${label}窗）＋VIX/VXN 極端＋回撤`, triggerDays: ev.triggerDays, events: ev.baseCount, stats: ev.stats });
  }
  return rows;
}

/** Divergence: a new 60-day closing low while the vol index is NOT at a new 60-day high (window fixed in advance, causal). */
export function volDivergence(days, i, c, window = 60) {
  const d = days[i];
  if (i < window || !d.ok || !finite(d.vol)) return null;
  let lo = Infinity, hi = -Infinity;
  for (let k = i - window; k < i; k++) { if (!days[k].ok || !finite(days[k].vol)) return null; lo = Math.min(lo, days[k].close); hi = Math.max(hi, days[k].vol); }
  return { newLow: d.close < lo, volNotHigh: d.vol < hi, diverged: d.close < lo && d.vol < hi };
}

// ── Stage B context (display only; availability-stamped, never a model input) ──
const cftcRows = (cftc, id) => {
  const main = cftc?.main?.instruments?.find(x => x.id === id)?.rows || [];
  const old = cftc?.history?.instruments?.find(x => x.id === id)?.rows || [];
  const seen = new Set(main.map(r => r.date));
  return [...old.filter(r => !seen.has(r.date)), ...main].filter(r => finite(r.lev_net) && r.open_interest > 0).sort((a, b) => (a.date < b.date ? -1 : 1));
};
/** CFTC TFF is as-of Tuesday and public after Friday 15:30 ET: only reports released strictly before `asOf` are visible. */
export function cftcAt(cftc, id, asOf) {
  const rows = cftcRows(cftc, id).filter(r => addDays(r.date, 3) < asOf);
  if (!rows.length) return null;
  const last = rows.at(-1), ratios = rows.map(r => r.lev_net / r.open_interest * 100);
  const cur = last.lev_net / last.open_interest * 100;
  const rank = ratios.filter(v => v <= cur).length / ratios.length * 100;
  return { date: last.date, releasedOn: addDays(last.date, 3), levLong: last.lev_long, levShort: last.lev_short, net: last.lev_net, oi: last.open_interest, ratio: cur, rank, history: rows.length,
    firstDate: rows[0].date, lowest10: rank <= 10, lowest5: rank <= 5, lowest1: rank <= 1 };
}
/** FINRA margin debt is monthly; the month's figure is assumed public ~25 days after month-end (not an official calendar). */
export function finraAt(rows, asOf) {
  const vis = (rows || []).filter(r => finite(r.margin_balance) && addDays(addMonthEnd(r.date), 25) < asOf).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (vis.length < 7) return null;
  const last = vis.at(-1), chg = k => (last.margin_balance / vis.at(-1 - k).margin_balance - 1) * 100;
  const peak = Math.max(...vis.slice(-13).map(r => r.margin_balance));
  return { month: last.date.slice(0, 7), balance: last.margin_balance, mom: chg(1), m3: chg(3), m6: chg(6), fromPeak12: (last.margin_balance / peak - 1) * 100, assumedPublic: addDays(addMonthEnd(last.date), 25) };
}
function addMonthEnd(monthStart) { const d = new Date(Date.parse(monthStart)); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10); }
export function creditAt(ds, asOf) {
  const bars = ds.hyg.filter(b => b.date <= asOf && finite(b.close));
  if (bars.length < 60) return null;
  const last = bars.at(-1), win = bars.slice(-60), sma10 = mean(bars.slice(-10).map(b => b.close));
  const oasDates = [...ds.oas.keys()].filter(d => d <= asOf).sort();
  const oasNow = oasDates.length ? ds.oas.get(oasDates.at(-1)) : null, oas5 = oasDates.length > 5 ? ds.oas.get(oasDates.at(-6)) : null;
  const stale = oasDates.length ? (Date.parse(asOf) - Date.parse(oasDates.at(-1))) / DAY > 7 : true;
  return { date: last.date, hygClose: last.close, fromHigh60: (last.close / Math.max(...win.map(b => b.close)) - 1) * 100, aboveSma10: last.close > sma10,
    oas: stale ? null : oasNow, oasDate: oasDates.at(-1) ?? null, oasChg5: stale || !finite(oas5) ? null : oasNow - oas5, oasFirst: oasDates[0] ?? null,
    note: 'HYG 是價格代理：價格同時反映利率與信用利差，不等於信用風險下降；與 HY OAS（僅 2023-06 起）交叉比對。' };
}
export function stageBContext(ds, asOf) {
  return { cftcES: cftcAt(ds.cftc, 'sp500', asOf), cftcNQ: cftcAt(ds.cftc, 'nasdaq100', asOf), finra: finraAt(ds.finra, asOf), credit: creditAt(ds, asOf) };
}

// ── Live status for the page ──────────────────────────────────────────────
/** Newest value of a date→value map within `maxDays` calendar days before `date` (inclusive); the observation date is returned with it. */
function newestWithin(map, date, maxDays) {
  for (let k = 0; k <= maxDays; k++) { const d = addDays(date, -k); if (map.has(d)) return { value: map.get(d), date: d }; }
  return null;
}
export function liveStatus(frame, ds) {
  const c = frame.cfg, days = frame.days;
  // The newest bar can be unusable (e.g. a contradictory OHLC row): report the newest usable day and say so, never repair it.
  const L = days.reduce((m, d) => (d.ok ? d.i : m), -1), last = days[L];
  if (!last) return null;
  // Indicators published a day late (VXN, put/call) may use their own newest observation within 3 sessions; the observation date is reported, never hidden.
  const lagged = (key, ok = d => finite(d[key])) => { for (let k = 0; k <= 3 && L - k >= 0; k++) if (ok(days[L - k])) return { day: days[L - k], date: days[L - k].date }; return { day: last, date: null }; };
  const vxnAt = lagged('vxn'), pcrAt = lagged('pcrAvg', d => finite(d.pcrAvg) && finite(d.pcrThr));
  const eff = { ...last, vxn: vxnAt.date ? vxnAt.day.vxn : last.vxn, pcrAvg: pcrAt.date ? pcrAt.day.pcrAvg : last.pcrAvg, pcrThr: pcrAt.date ? pcrAt.day.pcrThr : last.pcrThr, pcrExt: pcrAt.date ? pcrAt.day.pcrExt : last.pcrExt };
  const asOf = { vix: last.date, vxn: vxnAt.date, pcr: pcrAt.date };
  const cond = (value, ok, text) => ({ value, ok, text });
  const a = {
    vix: cond(eff.vix, finite(eff.vix) ? eff.vix >= c.vix : null, `VIX ≥ ${c.vix}`),
    vxn: cond(eff.vxn, finite(eff.vxn) ? eff.vxn >= c.vxn : null, `VXN ≥ ${c.vxn}`),
    pcr: cond(eff.pcrAvg, eff.pcrExt, `PCR 5 日均 ≥ 近 2 年 P${c.pcrPct}${finite(eff.pcrThr) ? `（${eff.pcrThr.toFixed(3)}）` : ''}`),
    vxnSens: cond(eff.vxn, finite(eff.vxn) ? eff.vxn >= c.vxnSensitive : null, `VXN ≥ ${c.vxnSensitive}（敏感層）`),
    drawdown: cond(last.dd, finite(last.dd) ? last.dd >= c.gate : null, `距 ${c.lookback} 日高 ≥ ${c.gate}%`),
    downVolume: cond(null, null, '90% Down Volume（無合格資料來源）'),
  };
  const lastA = [...days].reverse().find(d => d.i <= L && d.i >= L - c.confirmWindow && stageA(d, c) === true) || null;
  let stageC = null;
  if (lastA) {
    const conf = confirmStage(days, lastA.i, c);
    let low = Infinity, lowIdx = lastA.i, peak = -Infinity;
    for (let t = lastA.i; t <= L; t++) { if (!days[t].ok) continue; if (days[t].close <= low) { low = days[t].close; lowIdx = t; } if (finite(days[t].vol)) peak = Math.max(peak, days[t].vol); }
    stageC = { panicDate: lastA.date, sinceDays: L - lastA.i, confirmed: conf && conf.index <= L ? { date: days[conf.index].date, lag: conf.lag } : null,
      checks: { noNewLow: { ok: L - lowIdx >= c.noNewLowDays, text: `近 ${c.noNewLowDays} 日沒有創恐慌後新低收盤`, value: L - lowIdx },
        volRetreat: { ok: finite(last.vol) && peak > 0 ? last.vol <= c.volRetreat * peak : null, text: `波動指標 ≤ 恐慌後高點的 ${(c.volRetreat * 100).toFixed(0)}%`, value: finite(last.vol) && peak > 0 ? last.vol / peak : null },
        reclaim: { ok: finite(last.sma) ? last.close > last.sma : null, text: `收盤站回 ${c.maDays} 日均線`, value: finite(last.sma) ? (last.close / last.sma - 1) * 100 : null } },
    };
  }
  return { date: last.date, latestBarDate: days.at(-1).date, latestBarUsable: days.at(-1).ok, close: last.close, a, anyA: stageA(eff, c), anySensitive: stageSensitive(eff, c), stageB: stageB(eff, c), asOf, eff, lastA: lastA?.date ?? null, stageC, context: stageBContext(ds, last.date), breadthSpx: newestWithin(ds.breadthSpx, last.date, 5), breadthNdx: newestWithin(ds.breadthNdx, last.date, 5), day: last };
}

/** Rows for the historical comparison / 2022 tables: every Stage A (model A) cooldown event, with its Stage B (PCR) / Stage C follow-up. */
export function eventRows(frame, ds, { from, to } = {}) {
  const c = frame.cfg, days = frame.days, rows = [];
  const base = pickEvents(days.filter(d => (!from || d.date >= from) && (!to || d.date <= to)), d => stageA(d, c), c.cooldown);
  const waves = findWaves(days, c);
  for (const a of base) {
    const d = days[a], conf = confirmStage(days, a, c), out = outcomeAt(days, a, c);
    const cOut = conf ? outcomeAt(days, conf.index, c, Math.min(...days.slice(a, conf.index + 1).filter(x => x.ok).map(x => x.low))) : null;
    rows.push({
      date: d.date, close: d.close, dd: d.dd, vix: d.vix, vxn: d.vxn, pcr: d.pcrAvg, pcrExt: d.pcrExt, pcrThr: d.pcrThr,
      breadthSpx: ds.breadthSpx.get(d.date) ?? null, breadthNdx: ds.breadthNdx.get(d.date) ?? null,
      modelB: stageB(d, c) === true, wave: waveOf(waves, a), out,
      confirm: conf ? { date: days[conf.index].date, lag: conf.lag, close: days[conf.index].close, out: cOut, invalid: invalidation(days, conf, 60) } : null,
      context: ds.cftc || ds.finra?.length ? stageBContext(ds, d.date) : null,
    });
  }
  return { rows, waves };
}

/** Answers for a set of eventRows (used by the 2022 stress-test text on the page and in the report). MAE bucket cut-points are descriptive, not model parameters. */
export function episodeSummary(rows) {
  const mae60 = r => (r.out.h[60]?.status === 'complete' ? r.out.h[60].mae : null);
  const bucket = (lo, hi) => rows.filter(r => mae60(r) !== null && mae60(r) > lo && mae60(r) <= hi).map(r => r.date);
  const cf = rows.filter(r => r.confirm), lags = cf.map(r => r.confirm.lag).sort((a, b) => a - b);
  const failed = cf.filter(r => r.confirm.invalid);
  return {
    n: rows.length, modelB: rows.filter(r => r.modelB).length,
    deep: bucket(-Infinity, -10), mid: bucket(-10, -5), shallow: bucket(-5, Infinity), incomplete: rows.filter(r => mae60(r) === null).map(r => r.date),
    confirmed: cf.length, lagMedian: lags.length ? lags[Math.floor((lags.length - 1) / 2)] : null, lagMin: lags[0] ?? null, lagMax: lags.at(-1) ?? null,
    confirmedNegative60: cf.filter(r => r.confirm.out?.h[60]?.status === 'complete' && r.confirm.out.h[60].ret < 0).length,
    failed: failed.map(r => ({ confirmDate: r.confirm.date, days: r.confirm.invalid.days, loss: r.confirm.invalid.lossAtInvalidation })),
  };
}

export const fmt = { num: (x, dg = 1) => (finite(x) ? x.toFixed(dg) : '—'), sg: (x, dg = 1) => (finite(x) ? `${x > 0 ? '+' : ''}${x.toFixed(dg)}` : '—') };
