// VIX 單日急升回測（純函式，無 DOM）。
//
// 口徑：
//   • VIX 1990 起：1990–1999 取 data/VIX_early.json 的 ^VIX 段（1986–1989 是舊制 VXO，不用），2000 起 data/VIX.json。
//   • 單日漲幅 = 當日（盤中最高 或 收盤）÷ 前一交易日收盤 − 1。盤中最高是「當天最多漲到多少」，收盤是「收在多少」。
//   • 盤中振幅 =（最高 − 最低）÷ 前一交易日收盤（VIX 與標的同一口徑）。開／高／低缺值時用收盤補，並保證 低 ≤ 開、收 ≤ 高。
//   • 區間 [lo, hi)：lo ≤ 值 < hi；hi = null 表示無上限。
//   • 條件類型 kind：'change' = 單日漲幅（lo/hi 是比例，0.5 = 50%）；'level' = VIX 水位（lo/hi 是點數，盤中最高或收盤），
//     水位只算「進入區間的那一天」（前一天還不在區間），否則 VIX 高檔期間天天都是事件。
//   • 進場：美股標的 T 日收盤（lag 0）或 T+1 收盤；台股標的的「T」= 美股 T 日之後第一個台股交易日（台北時間隔天），
//     lag 0 = 該日收盤，lag 1 = 再隔一個台股交易日收盤。報酬以標的自己的交易日數計。
//   • 冷卻：事件後 cooldown 個 VIX 交易日內的符合日不算新事件（同一波恐慌只算第一天）。
//   • 平常日子：所有「沒有符合條件」的日子都當進場日，同樣口徑算報酬，作為對照。

import { mean, percentile } from '../utils/math.js';

export const HORIZONS = Object.freeze([1, 5, 10, 20, 60, 120]);
export const VIX_START = '1990-01-01';
export const DEFAULTS = Object.freeze({ kind: 'change', measure: 'high', lo: 0.5, hi: null, cooldown: 10, lag: 0 });
/** 切換條件類型時的預設區間。 */
export const KIND_RANGE = Object.freeze({ change: { lo: 0.5, hi: null }, level: { lo: 30, hi: null } });
export const PARAM_KEYS = Object.freeze(Object.keys(DEFAULTS));
/** 區間掃描用的分組（下限含、上限不含）。 */
export const BUCKETS = Object.freeze([[0.1, 0.2], [0.2, 0.3], [0.3, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 0.8], [0.8, null]]);
export const LEVEL_BUCKETS = Object.freeze([[15, 20], [20, 25], [25, 30], [30, 35], [35, 40], [40, 50], [50, null]]);
export const bucketsOf = kind => (kind === 'level' ? LEVEL_BUCKETS : BUCKETS);

const finite = v => typeof v === 'number' && Number.isFinite(v);

/**
 * 合併 VIX（1990 起），算每日盤中最高／收盤相對前收的漲幅。
 * @param {Array<{date,open,high,low,close}>} early  VIX_early.json 的 data
 * @param {Array<{date,open,high,low,close}>} recent VIX.json 的 data
 */
export function buildVix(early = [], recent = []) {
  const byDate = new Map();
  for (const r of [...early, ...recent]) {
    if (!r?.date || r.date < VIX_START || !finite(r.close) || r.close <= 0) continue;
    byDate.set(r.date, r);                       // recent 蓋 early
  }
  const rows = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  const v = { dates: [], open: [], high: [], low: [], close: [], prev: [], chHigh: [], chClose: [], amp: [] };
  rows.forEach((r, i) => {
    const prev = i ? rows[i - 1].close : null;
    const [open, high, low] = ohlc(r.close, r.open, r.high, r.low);
    v.dates.push(r.date); v.open.push(open); v.high.push(high); v.low.push(low); v.close.push(r.close); v.prev.push(prev);
    v.chHigh.push(prev ? high / prev - 1 : null);
    v.chClose.push(prev ? r.close / prev - 1 : null);
    v.amp.push(prev ? (high - low) / prev : null);
  });
  if (v.dates.length < 500) throw new Error('VIX 資料不足');
  return v;
}

/** 開／高／低缺值或不合理時用收盤補：回傳 [open, high, low]，保證 low ≤ open, close ≤ high。 */
function ohlc(close, open, high, low) {
  const o = finite(open) && open > 0 ? open : close;
  const h = finite(high) && high > 0 ? Math.max(high, o, close) : Math.max(o, close);
  const l = finite(low) && low > 0 ? Math.min(low, o, close) : Math.min(o, close);
  return [o, h, l];
}

/** 標的價格：[[date, close, open?, high?, low?], ...] → {dates, px, open, high, low}。 */
export function buildAsset(rows) {
  const ok = (rows ?? []).filter(r => r && finite(r[1]) && r[1] > 0).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (ok.length < 300) throw new Error('標的資料不足');
  const bars = ok.map(r => ohlc(r[1], r[2], r[3], r[4]));
  return { dates: ok.map(r => r[0]), px: ok.map(r => r[1]), open: bars.map(b => b[0]), high: bars.map(b => b[1]), low: bars.map(b => b[2]) };
}

/** 標的第 k 天的開高低收、收盤漲跌、盤中振幅（相對前一天收盤）。 */
export function assetDay(a, k) {
  if (k == null || k < 0 || k >= a.dates.length) return null;
  const prev = k ? a.px[k - 1] : null;
  return { date: a.dates[k], open: a.open[k], high: a.high[k], low: a.low[k], close: a.px[k], prev,
    ch: prev ? a.px[k] / prev - 1 : null, amp: prev ? (a.high[k] - a.low[k]) / prev : null };
}

/** VIX 第 i 天的開高低收、收盤漲跌、盤中最高漲幅、盤中振幅。 */
export function vixDay(v, i) {
  return { date: v.dates[i], open: v.open[i], high: v.high[i], low: v.low[i], close: v.close[i], prev: v.prev[i],
    ch: v.chClose[i], chHigh: v.chHigh[i], amp: v.amp[i] };
}

/** 條件看的值：單日漲幅（比例）或 VIX 水位（點數），依 measure 取盤中最高或收盤。 */
export function valueOf(v, p, i) {
  if (p.kind === 'level') return p.measure === 'close' ? v.close[i] : v.high[i];
  return p.measure === 'close' ? v.chClose[i] : v.chHigh[i];
}
const inRange = (x, lo, hi) => finite(x) && x >= lo && (hi == null || x < hi);
export const inRangeAt = (v, p, i) => inRange(valueOf(v, p, i), p.lo, p.hi);

/** 原始符合日（未套冷卻）；水位只算進入區間當天。 */
export function rawSignals(v, p) {
  return v.dates.map((_, i) => inRangeAt(v, p, i) && !(p.kind === 'level' && i > 0 && inRangeAt(v, p, i - 1)));
}

export function applyCooldown(raw, cooldown) {
  const out = [];
  let last = -Infinity;
  raw.forEach((hit, i) => {
    if (!hit || i - last <= cooldown) return;
    out.push(i); last = i;
  });
  return out;
}

/** 第一個 ≥ date（美股）或 > date（台股）的標的索引；找不到回 -1。 */
function firstIndex(dates, date, strict) {
  let lo = 0, hi = dates.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (strict ? dates[m] <= date : dates[m] < date) lo = m + 1; else hi = m;
  }
  return lo < dates.length ? lo : -1;
}

/** VIX 第 i 天對應的標的進場索引（null = 標的當時沒資料或還沒到）。 */
export function entryIndex(v, a, i, p, nextSession = false) {
  const d = v.dates[i];
  if (d < a.dates[0]) return null;
  const base = firstIndex(a.dates, d, nextSession);
  if (base < 0) return null;
  // 美股標的若 T 日休市（資料缺一天），往後找到的日子已不是 T，視為無法對齊。
  if (!nextSession && a.dates[base] !== d) return null;
  const e = base + p.lag;
  return e < a.dates.length ? e : null;
}

const fwd = (px, e, h) => (e + h < px.length ? px[e + h] / px[e] - 1 : null);
function mae(px, e, h) {
  if (e + h >= px.length) return null;
  let worst = 0;
  for (let k = 1; k <= h; k++) worst = Math.min(worst, px[e + k] / px[e] - 1);
  return worst;
}

function describe(values) {
  const v = values.filter(finite).sort((a, b) => a - b);
  if (!v.length) return { n: 0, mean: null, median: null, max: null, min: null, win: null };
  return { n: v.length, mean: mean(v), median: percentile(v, 0.5), max: v.at(-1), min: v[0],
    win: v.filter(x => x > 0).length / v.length };
}

/**
 * 主計算。
 * @param v buildVix() 結果
 * @param a buildAsset() 結果
 * @param params {measure:'high'|'close', lo, hi|null, cooldown, lag}
 * @param opts {nextSession: 台股標的=true, horizons, pathLen}
 * @returns {{events, stats, path, raw, params}}
 *   events[k] = { i, date, prev, open, high, low, close, chHigh, chClose, amp, ch, entry, entryDate, day, ret:{h}, mae60, path[], merged[] }
 *     day = 標的「當天」（美股 T 日；台股 T 之後第一個台股交易日）的 assetDay()
 *   stats[h]  = { n, mean, median, max, min, win, base, baseMedian, baseWin, baseN, excess }
 *   path      = { len, mean[], median[], base[] }（第 0 日 = 0，累積報酬）
 */
export function runStudy(v, a, params = DEFAULTS, { nextSession = false, horizons = HORIZONS, pathLen = 60 } = {}) {
  const p = { ...DEFAULTS, ...params };
  const raw = rawSignals(v, p);
  const idx = applyCooldown(raw, p.cooldown);

  const events = idx.map(i => {
    const entry = entryIndex(v, a, i, p, nextSession);
    const ret = {};
    for (const h of horizons) ret[h] = entry == null ? null : fwd(a.px, entry, h);
    const dayIdx = entryIndex(v, a, i, { ...p, lag: 0 }, nextSession);
    return { i, date: v.dates[i], prev: v.prev[i], open: v.open[i], high: v.high[i], low: v.low[i], close: v.close[i],
      chHigh: v.chHigh[i], chClose: v.chClose[i], amp: v.amp[i],
      ch: valueOf(v, p, i), entry, entryDate: entry == null ? null : a.dates[entry], day: assetDay(a, dayIdx), ret,
      mae60: entry == null ? null : mae(a.px, entry, 60),
      path: entry == null ? null : Array.from({ length: pathLen + 1 }, (_, k) => fwd(a.px, entry, k)) };
  });

  // 平常日子：標的有資料、VIX 不符合條件的日子（含被冷卻擋掉的符合日也排除）。
  const baseEntries = [];
  const seen = new Set();
  v.dates.forEach((_, i) => {
    if (raw[i] || v.prev[i] == null) return;
    const e = entryIndex(v, a, i, p, nextSession);
    if (e == null || seen.has(e)) return;
    seen.add(e); baseEntries.push(e);
  });

  const stats = {};
  for (const h of horizons) {
    const st = describe(events.map(e => e.ret[h]));
    const b = describe(baseEntries.map(e => fwd(a.px, e, h)));
    Object.assign(st, { base: b.mean, baseMedian: b.median, baseWin: b.win, baseN: b.n,
      excess: st.mean != null && b.mean != null ? st.mean - b.mean : null });
    stats[h] = st;
  }

  const path = { len: pathLen, mean: [], median: [], base: [], n: [] };
  for (let k = 0; k <= pathLen; k++) {
    const d = describe(events.map(e => e.path?.[k]));
    path.mean.push(d.mean); path.median.push(d.median); path.n.push(d.n);
    path.base.push(describe(baseEntries.map(e => fwd(a.px, e, k))).mean);
  }
  // 冷卻期內又符合條件的日子併入前一筆事件（events[k].merged = 那些日期）。
  events.forEach((e, k) => {
    const end = events[k + 1]?.i ?? v.dates.length;
    e.merged = [];
    for (let i = e.i + 1; i < end; i++) if (raw[i]) e.merged.push(v.dates[i]);
  });
  return { events, stats, path, raw, params: p };
}

/** 區間掃描：每個漲幅分組各自的事件數與 horizon 日平均／勝率（同口徑、冷卻、進場）。 */
export function bucketScan(v, a, params, { nextSession = false, horizon = 20, buckets = bucketsOf(params.kind) } = {}) {
  return buckets.map(([lo, hi]) => {
    const st = runStudy(v, a, { ...params, lo, hi }, { nextSession, horizons: [horizon], pathLen: 0 }).stats[horizon];
    return { lo, hi, n: st.n, mean: st.mean, median: st.median, win: st.win, base: st.base, excess: st.excess };
  });
}

/** 最新一天的 VIX 狀態。 */
export function currentStatus(v, study) {
  const i = v.dates.length - 1, p = study.params;
  const last = study.events.at(-1) ?? null;
  const ch = valueOf(v, p, i);
  // 歷史上單日漲幅 ≥ 今天的日子占比（含今天）。
  let ge = 0, n = 0;
  if (finite(ch)) v.dates.forEach((_, k) => { const x = valueOf(v, p, k); if (finite(x)) { n++; if (x >= ch) ge++; } });
  return { date: v.dates[i], prev: v.prev[i], high: v.high[i], close: v.close[i], chHigh: v.chHigh[i], chClose: v.chClose[i],
    ch, rank: n ? ge : null, rankN: n, hit: !!study.raw[i], inside: inRangeAt(v, p, i), lastEvent: last, sessionsSince: last ? i - last.i : null };
}

/** 歷史單日漲幅前 top 名（依口徑），給「多高算罕見」參考。 */
export function extremes(v, { top = 10, measure = 'high' } = {}) {
  const ch = measure === 'close' ? v.chClose : v.chHigh;
  return v.dates.map((d, i) => ({ date: d, ch: ch[i], prev: v.prev[i], level: measure === 'close' ? v.close[i] : v.high[i] }))
    .filter(r => finite(r.ch)).sort((x, y) => y.ch - x.ch).slice(0, top);
}
