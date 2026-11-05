// VIX 單日急升回測（純函式，無 DOM）。
//
// 口徑：
//   • VIX 1990 起：1990–1999 取 data/VIX_early.json 的 ^VIX 段（1986–1989 是舊制 VXO，不用），2000 起 data/VIX.json。
//   • 單日漲幅 = 當日（盤中最高 或 收盤）÷ 前一交易日收盤 − 1。盤中最高是「當天最多漲到多少」，收盤是「收在多少」。
//   • 區間 [lo, hi)：lo ≤ 漲幅 < hi；hi = null 表示無上限。
//   • 進場：美股標的 T 日收盤（lag 0）或 T+1 收盤；台股標的的「T」= 美股 T 日之後第一個台股交易日（台北時間隔天），
//     lag 0 = 該日收盤，lag 1 = 再隔一個台股交易日收盤。報酬以標的自己的交易日數計。
//   • 冷卻：事件後 cooldown 個 VIX 交易日內的符合日不算新事件（同一波恐慌只算第一天）。
//   • 平常日子：所有「沒有符合條件」的日子都當進場日，同樣口徑算報酬，作為對照。

import { mean, percentile } from '../utils/math.js';

export const HORIZONS = Object.freeze([1, 5, 10, 20, 60, 120]);
export const VIX_START = '1990-01-01';
export const DEFAULTS = Object.freeze({ measure: 'high', lo: 0.5, hi: null, cooldown: 10, lag: 0 });
export const PARAM_KEYS = Object.freeze(Object.keys(DEFAULTS));
/** 區間掃描用的分組（下限含、上限不含）。 */
export const BUCKETS = Object.freeze([[0.1, 0.2], [0.2, 0.3], [0.3, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 0.8], [0.8, null]]);

const finite = v => typeof v === 'number' && Number.isFinite(v);

/**
 * 合併 VIX（1990 起），算每日盤中最高／收盤相對前收的漲幅。
 * @param {Array<{date,high,close}>} early  VIX_early.json 的 data
 * @param {Array<{date,high,close}>} recent VIX.json 的 data
 */
export function buildVix(early = [], recent = []) {
  const byDate = new Map();
  for (const r of [...early, ...recent]) {
    if (!r?.date || r.date < VIX_START || !finite(r.close) || r.close <= 0) continue;
    byDate.set(r.date, r);                       // recent 蓋 early
  }
  const rows = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  const v = { dates: [], close: [], high: [], prev: [], chHigh: [], chClose: [] };
  rows.forEach((r, i) => {
    const prev = i ? rows[i - 1].close : null;
    const high = finite(r.high) && r.high >= r.close ? r.high : r.close;
    v.dates.push(r.date); v.close.push(r.close); v.high.push(high); v.prev.push(prev);
    v.chHigh.push(prev ? high / prev - 1 : null);
    v.chClose.push(prev ? r.close / prev - 1 : null);
  });
  if (v.dates.length < 500) throw new Error('VIX 資料不足');
  return v;
}

/** 標的價格：[[date, close], ...] → {dates, px}。 */
export function buildAsset(rows) {
  const ok = (rows ?? []).filter(r => r && finite(r[1]) && r[1] > 0).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (ok.length < 300) throw new Error('標的資料不足');
  return { dates: ok.map(r => r[0]), px: ok.map(r => r[1]) };
}

const changeOf = (v, p, i) => (p.measure === 'close' ? v.chClose[i] : v.chHigh[i]);
const inRange = (x, lo, hi) => finite(x) && x >= lo && (hi == null || x < hi);

/** 原始符合日（未套冷卻）。 */
export function rawSignals(v, p) {
  return v.dates.map((_, i) => inRange(changeOf(v, p, i), p.lo, p.hi));
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
 *   events[k] = { i, date, prev, high, close, chHigh, chClose, ch, entry, entryDate, ret:{h}, mae60, path[], merged[] }
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
    return { i, date: v.dates[i], prev: v.prev[i], high: v.high[i], close: v.close[i], chHigh: v.chHigh[i], chClose: v.chClose[i],
      ch: changeOf(v, p, i), entry, entryDate: entry == null ? null : a.dates[entry], ret,
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
export function bucketScan(v, a, params, { nextSession = false, horizon = 20, buckets = BUCKETS } = {}) {
  return buckets.map(([lo, hi]) => {
    const st = runStudy(v, a, { ...params, lo, hi }, { nextSession, horizons: [horizon], pathLen: 0 }).stats[horizon];
    return { lo, hi, n: st.n, mean: st.mean, median: st.median, win: st.win, base: st.base, excess: st.excess };
  });
}

/** 最新一天的 VIX 狀態。 */
export function currentStatus(v, study) {
  const i = v.dates.length - 1, p = study.params;
  const last = study.events.at(-1) ?? null;
  const ch = changeOf(v, p, i);
  // 歷史上單日漲幅 ≥ 今天的日子占比（含今天）。
  let ge = 0, n = 0;
  if (finite(ch)) v.dates.forEach((_, k) => { const x = changeOf(v, p, k); if (finite(x)) { n++; if (x >= ch) ge++; } });
  return { date: v.dates[i], prev: v.prev[i], high: v.high[i], close: v.close[i], chHigh: v.chHigh[i], chClose: v.chClose[i],
    ch, rank: n ? ge : null, rankN: n, hit: !!study.raw[i], lastEvent: last, sessionsSince: last ? i - last.i : null };
}

/** 歷史單日漲幅前 top 名（依口徑），給「多高算罕見」參考。 */
export function extremes(v, { top = 10, measure = 'high' } = {}) {
  const ch = measure === 'close' ? v.chClose : v.chHigh;
  return v.dates.map((d, i) => ({ date: d, ch: ch[i], prev: v.prev[i], level: measure === 'close' ? v.close[i] : v.high[i] }))
    .filter(r => finite(r.ch)).sort((x, y) => y.ch - x.ch).slice(0, top);
}
