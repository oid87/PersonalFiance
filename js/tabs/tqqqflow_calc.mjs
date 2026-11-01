// TQQQ 大額資金流入事件研究（純函式，無 DOM）。
//
// 資料口徑：
//   • 流量 flow_t = (股數_t − 股數_{t−1}) × NAV_t（ProShares 官方 NAV／流通股數；ProShares 的 t 日股數
//     已含 t 日申贖，t 日收盤後公布，與 ETFIQ navDate 口徑逐日相同）。
//   • 回撤 = QQQ 收盤 ÷ 近 252 個交易日（含當日）收盤高點 − 1。不用歷史高點：QQQ 到 2015 年前後才收復
//     2000 年高點，2010–2015 會整段都算「回撤 ≥10%」。
//   • 報酬：TQQQ／QLD 用 NAV、QQQ 用收盤價（皆未含息；ProShares 拆股後回溯調整 NAV 與股數，序列連續）。
//   • 進場 lag：0 = T 日收盤（流量要收盤後才公布，不可交易，只用來對照外部表格）；1 = T+1 收盤（預設）；
//     2 = T+2 收盤（以 ETFIQ 隔一晚才更新的公開時間為準）。
//   • 情緒／波動開關：CNN 恐懼貪婪（2011 起）、VIX、VXN 都用 T 日收盤值；開啟後當天沒有資料就不算符合。

import { mean, percentile } from '../utils/math.js';

export const HORIZONS = Object.freeze([5, 10, 20, 30, 60]);
export const ASSETS = Object.freeze(['QQQ', 'QLD', 'TQQQ']);
export const DD_WINDOW = 252;
export const SPLIT_DATE = '2021-01-01';
const FILTERS_OFF = { fgOn: false, fgMax: 25, vixOn: false, vixMin: 25, vxnOn: false, vxnMin: 30 };
export const DEFAULTS = Object.freeze({ thrMode: 'usd', thr: 8e8, ddMin: 0.10, cooldown: 20, lag: 1, ...FILTERS_OFF });
/** 外部表格（只看資金流 ≥ 8 億、T 日收盤 NAV 起算、無回撤條件、無冷卻）的口徑。 */
export const CHART_PRESET = Object.freeze({ thrMode: 'usd', thr: 8e8, ddMin: 0, cooldown: 0, lag: 0, ...FILTERS_OFF });
export const PARAM_KEYS = Object.freeze(Object.keys(DEFAULTS));

/**
 * 對齊成同一條交易日軸（QQQ 交易日 ∩ TQQQ 有 NAV 的日子）。
 * @param {{funds:{TQQQ:{data:Array}, QLD:{data:Array}}}} flowsJson
 * @param {Array<[string, number]>} qqqRows  [[date, close], ...]（需含 TQQQ 上市前一年以上，算 252 日高點）
 * @param {{fg?:Array<[string, number]>, vix?:Array<[string, number]>, vxn?:Array<[string, number]>}} extras  [[date, 收盤值], ...]
 */
export function buildSeries(flowsJson, qqqRows, extras = {}) {
  const tq = flowsJson?.funds?.TQQQ?.data, ql = flowsJson?.funds?.QLD?.data;
  if (!Array.isArray(tq) || tq.length < 2 || !Array.isArray(ql)) throw new Error('ProShares 資料不足');
  if (!Array.isArray(qqqRows) || !qqqRows.length) throw new Error('QQQ 資料不足');
  const tqMap = new Map(tq.map(r => [r[0], r]));
  const qlMap = new Map(ql.map(r => [r[0], r[1]]));
  const firstTq = tq[0][0];

  // 252 日滾動收盤高點（單調佇列），在完整 QQQ 序列上算，再裁到 TQQQ 期間。
  const ddByDate = new Map();
  const dq = [];
  qqqRows.forEach(([date, close], i) => {
    while (dq.length && qqqRows[dq.at(-1)][1] <= close) dq.pop();
    dq.push(i);
    while (dq[0] <= i - DD_WINDOW) dq.shift();
    ddByDate.set(date, close / qqqRows[dq[0]][1] - 1);
  });

  const ext = Object.fromEntries(['fg', 'vix', 'vxn'].map(k => [k, new Map(extras[k] ?? [])]));
  const s = { dates: [], qqq: [], qld: [], tqqq: [], flow: [], pct: [], aum: [], dd: [], fg: [], vix: [], vxn: [] };
  let prev = null;
  for (const [date, close] of qqqRows) {
    if (date < firstTq) continue;
    const row = tqMap.get(date);
    if (!row) continue;                     // ProShares 未報價的日子（理論上不會有）
    if (prev) {
      const sharesPrev = prev[2] * 1000, aumPrev = sharesPrev * prev[1];
      const flow = (row[2] * 1000 - sharesPrev) * row[1];
      s.dates.push(date); s.qqq.push(close); s.qld.push(qlMap.get(date) ?? null); s.tqqq.push(row[1]);
      s.flow.push(flow); s.pct.push(aumPrev > 0 ? flow / aumPrev : null);
      s.aum.push(row[2] * 1000 * row[1]); s.dd.push(ddByDate.get(date));
      for (const k of ['fg', 'vix', 'vxn']) s[k].push(ext[k].get(date) ?? null);
    }
    prev = row;
  }
  if (s.dates.length < 300) throw new Error('對齊後交易日不足');
  return s;
}

const priceOf = (s, asset) => (asset === 'QQQ' ? s.qqq : asset === 'QLD' ? s.qld : s.tqqq);

/** 原始符合條件的日子（未套冷卻），回傳 boolean 陣列。 */
export function rawSignals(s, p) {
  return s.dates.map((_, i) => flowHit(s, i, p) && marketHit(s, i, p));
}
function flowHit(s, i, p) {
  return p.thrMode === 'pct' ? (s.pct[i] ?? -Infinity) >= p.thr : s.flow[i] >= p.thr;
}
function ddHit(s, i, p) {
  return !(p.ddMin > 0) || s.dd[i] <= -p.ddMin;
}
const fgHit = (s, i, p) => !p.fgOn || (s.fg[i] != null && s.fg[i] <= p.fgMax);
const vixHit = (s, i, p) => !p.vixOn || (s.vix[i] != null && s.vix[i] >= p.vixMin);
const vxnHit = (s, i, p) => !p.vxnOn || (s.vxn[i] != null && s.vxn[i] >= p.vxnMin);
/** 資金流以外的市場條件（回撤＋開啟的情緒／波動條件）。 */
function marketHit(s, i, p) {
  return ddHit(s, i, p) && fgHit(s, i, p) && vixHit(s, i, p) && vxnHit(s, i, p);
}
/** 有沒有任何資金流以外的條件（決定要不要算「同市場條件」基準）。 */
export const hasMarketFilter = p => p.ddMin > 0 || p.fgOn || p.vixOn || p.vxnOn;

/** 套冷卻：訊號後 cooldown 個交易日內的符合日不再計為新事件。 */
export function applyCooldown(raw, cooldown) {
  const out = [];
  let last = -Infinity;
  raw.forEach((hit, i) => {
    if (!hit || i - last <= cooldown) return;
    out.push(i); last = i;
  });
  return out;
}

function fwd(px, e, h) {
  const end = e + h;
  if (end >= px.length || px[e] == null || px[end] == null) return null;
  return px[end] / px[e] - 1;
}
function mae(px, e, h) {
  if (e + h >= px.length || px[e] == null) return null;
  let worst = 0;
  for (let k = 1; k <= h; k++) {
    if (px[e + k] == null) return null;
    worst = Math.min(worst, px[e + k] / px[e] - 1);
  }
  return worst;
}

function groupOf(date, split) { return date < split ? 'is' : 'oos'; }

function describe(values) {
  const v = values.filter(x => x != null).sort((a, b) => a - b);
  if (!v.length) return { n: 0, mean: null, median: null, max: null, min: null, win: null };
  return { n: v.length, mean: mean(v), median: percentile(v, 0.5), max: v.at(-1), min: v[0],
    win: v.filter(x => x > 0).length / v.length };
}

/**
 * 主計算。
 * @returns {{events, stats, raw, params}}
 *   events[i] = { i, date, flow, pct, dd, fg, vix, vxn, entry, entryDate, group, overlap, ret:{asset:{h}}, mae:{asset:{h}} }
 *   stats[group][asset][h] = { n, mean, median, max, min, win, maeMean, maeWorst, base, baseN, excess, mktBase, mktBaseN, mktExcess }
 */
export function runStudy(s, params = DEFAULTS, { split = SPLIT_DATE, horizons = HORIZONS } = {}) {
  const p = { ...DEFAULTS, ...params };
  const raw = rawSignals(s, p);
  const idx = applyCooldown(raw, p.cooldown);
  const last = s.dates.length - 1;
  const maxH = Math.max(...horizons);

  let prevEntry = -Infinity;
  const events = idx.map(i => {
    const entry = i + p.lag <= last ? i + p.lag : null;
    const ev = { i, date: s.dates[i], flow: s.flow[i], pct: s.pct[i], dd: s.dd[i], fg: s.fg[i], vix: s.vix[i], vxn: s.vxn[i], entry,
      entryDate: entry == null ? null : s.dates[entry], group: groupOf(s.dates[i], split),
      overlap: entry != null && entry - prevEntry < maxH, ret: {}, mae: {} };
    if (entry != null) prevEntry = entry;
    for (const a of ASSETS) {
      const px = priceOf(s, a);
      ev.ret[a] = {}; ev.mae[a] = {};
      for (const h of horizons) {
        ev.ret[a][h] = entry == null ? null : fwd(px, entry, h);
        ev.mae[a][h] = entry == null ? null : mae(px, entry, h);
      }
    }
    return ev;
  });

  // 基準：所有「訊號日」（符合條件、含被冷卻擋掉的）以外的日子，同樣 lag 進場、同一期間分組。
  // mktBase：資金流以外的條件（回撤、情緒／波動開關）都成立、但資金流未達門檻的日子（有這些條件時才有意義）。
  const stats = {}, mkt = hasMarketFilter(p);
  for (const g of ['all', 'is', 'oos']) {
    stats[g] = {};
    const inGroup = ev => g === 'all' || ev.group === g;
    for (const a of ASSETS) {
      const px = priceOf(s, a);
      stats[g][a] = {};
      for (const h of horizons) {
        const evs = events.filter(inGroup);
        const st = describe(evs.map(ev => ev.ret[a][h]));
        const maes = evs.map(ev => ev.mae[a][h]).filter(x => x != null);
        st.maeMean = maes.length ? mean(maes) : null;
        st.maeWorst = maes.length ? Math.min(...maes) : null;
        let sum = 0, n = 0, dsum = 0, dn = 0;
        for (let d = 0; d + p.lag <= last; d++) {
          if (raw[d]) continue;
          if (g !== 'all' && groupOf(s.dates[d], split) !== g) continue;
          const r = fwd(px, d + p.lag, h);
          if (r == null) continue;
          sum += r; n++;
          if (mkt && marketHit(s, d, p)) { dsum += r; dn++; }
        }
        st.base = n ? sum / n : null; st.baseN = n;
        st.excess = st.mean != null && st.base != null ? st.mean - st.base : null;
        st.mktBase = dn ? dsum / dn : null; st.mktBaseN = dn;
        st.mktExcess = st.mean != null && st.mktBase != null ? st.mean - st.mktBase : null;
        stats[g][a][h] = st;
      }
    }
  }
  return { events, stats, raw, params: p };
}

/** 參數敏感度：門檻 × 回撤，固定冷卻／lag，回傳每格 {n, mean, excess}（全期、指定資產與天期）。 */
export function sensitivity(s, params, { asset = 'TQQQ', horizon = 20,
  thresholds = [{ thrMode: 'usd', thr: 5e8 }, { thrMode: 'usd', thr: 8e8 }, { thrMode: 'usd', thr: 10e8 }, { thrMode: 'pct', thr: 0.03 }],
  dds = [0, 0.05, 0.10, 0.15] } = {}) {
  return thresholds.map(t => ({ ...t, cells: dds.map(ddMin => {
    const st = runStudy(s, { ...params, ...t, ddMin }, { horizons: [horizon] }).stats.all[asset][horizon];
    return { ddMin, n: st.n, mean: st.mean, excess: st.excess };
  }) }));
}

/** 最新一天的狀態。 */
export function currentStatus(s, study) {
  const i = s.dates.length - 1, p = study.params;
  const lastEv = study.events.at(-1) ?? null;
  const since = lastEv ? i - lastEv.i : null;
  return { date: s.dates[i], flow: s.flow[i], pct: s.pct[i], dd: s.dd[i], aum: s.aum[i],
    fg: s.fg[i], vix: s.vix[i], vxn: s.vxn[i],
    flowHit: flowHit(s, i, p), ddHit: ddHit(s, i, p), fgHit: fgHit(s, i, p), vixHit: vixHit(s, i, p), vxnHit: vxnHit(s, i, p),
    signal: !!study.raw[i],
    lastEvent: lastEv, sessionsSince: since,
    cooldownLeft: lastEv && p.cooldown > 0 ? Math.max(0, p.cooldown - since) : 0 };
}
