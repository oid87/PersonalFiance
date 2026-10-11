// qqqradar_calc.mjs — 「QQQ 短線籌碼雷達」tab 的純函數計算層（無 DOM／ECharts）。
// 六軸皆 0–100、方向統一「分數高＝偏多／風險偏好」：
//   offex 場外空賣比 / short 空單壓力 / options 期權情緒 / technical 技術面 /
//   vxn 科技波動(VXN) / breadth NDX 廣度。
// 前四軸直接重用 flowradar_calc.mjs（同一套定義，不另寫一份）。
// 另提供 Prospero「Upside / Downside Breakout」的可回測替代：
// 依綜合分數分組的「歷史條件命中率」，每天只用當天已完結的過去樣本（point-in-time）。

import { rollingPctScore, svrScore, shortPressureScore, optionsScore, technicalScore } from './flowradar_calc.mjs';
import { lookupLE } from '../utils/dates.js';

export const AXIS_KEYS = ['offex', 'short', 'options', 'technical', 'vxn', 'breadth'];
// FINRA 空單餘額以結算日(settlementDate)標日期，但約 8 個營業日後才公布。
// 先把每筆資料的日期往後移到「可取得日」再對齊，否則回測會用到當時還看不到的值。
export const SHORT_PUBLICATION_LAG_BDAYS = 8;
// 移到公布日後，兩次公布間隔約 13–17 個日曆天；超過 25 天沒新資料視為過期。
export const SHORT_STALE_DAYS = 25;

// 週一至週五算營業日（不扣美國假日 → 實際公布可能再晚 1–2 天，這裡只求不早於公布）。
export function addBusinessDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d.toISOString().slice(0, 10);
}

export function shiftToPublication(siRows, lag = SHORT_PUBLICATION_LAG_BDAYS) {
  return siRows.filter(r => typeof r?.date === 'string').map(r => ({ ...r, date: addBusinessDays(r.date, lag) }));
}
export const BUCKET_EDGES = [0, 20, 40, 60, 80, 100];
export const HORIZONS = {
  '5D': { horizon: 5, threshold: 0.02 },
  '10D': { horizon: 10, threshold: 0.03 },
  '20D': { horizon: 20, threshold: 0.05 },
};

// dates 對齊 srcRows（{date,...} 升冪），超過 staleDays 個日曆天視為缺值。
export function alignField(dates, srcRows, pick, staleDays = 7) {
  const pairs = srcRows.filter(r => typeof r?.date === 'string').map(r => [r.date, r]);
  return dates.map(d => {
    const hit = lookupLE(pairs, d);
    if (!hit) return null;
    if ((Date.parse(d) - Date.parse(hit[0])) / 86400000 > staleDays) return null;
    const v = pick(hit[1]);
    return Number.isFinite(v) ? v : null;
  });
}

// VXN 收盤：近 756 筆百分位、取反（VXN 越高＝科技股恐慌越高 → 分數越低）。
export function vxnRaw(dates, vxnRows) {
  return alignField(dates, vxnRows, r => r.close);
}
export function vxnScore(dates, vxnRows, { win = 756, minObs = 252 } = {}) {
  return rollingPctScore(dates, vxnRaw(dates, vxnRows), win, minObs)
    .map(s => s == null ? null : +(100 - s).toFixed(2));
}

// NDX 成分股站上 20 日線比例：本身即 0–100，不做百分位。
export function breadthRaw(dates, breadthRows) {
  return alignField(dates, breadthRows, r => r.above20_pct);
}

// 六軸都有值才給綜合分數（等權平均）。
export function compositeScore(axes, n) {
  const out = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let ok = true;
    for (const k of AXIS_KEYS) {
      const v = axes[k][i];
      if (v == null) { ok = false; break; }
      sum += v;
    }
    if (ok) out[i] = +(sum / AXIS_KEYS.length).toFixed(2);
  }
  return out;
}

// inputs: { ohlc: [{date,high,low,close}] 升冪, svRows, siRows, pcRows, vxnRows, breadthRows }
export function buildQqqAxes({ ohlc, svRows, siRows, pcRows, vxnRows, breadthRows }) {
  const rows = ohlc.filter(r => typeof r?.date === 'string' && Number.isFinite(r.close));
  const dates = rows.map(r => r.date);
  const priceRows = rows.map(r => [r.date, r.close]);
  const axes = {
    offex: svrScore(dates, svRows, 'QQQ'),
    short: shortPressureScore(dates, shiftToPublication(siRows), 'QQQ', { staleDays: SHORT_STALE_DAYS }),
    options: optionsScore(dates, pcRows),
    technical: technicalScore(priceRows).scores,
    vxn: vxnScore(dates, vxnRows),
    breadth: breadthRaw(dates, breadthRows),
  };
  return { dates, rows, axes, composite: compositeScore(axes, dates.length) };
}

export function bucketOf(score, edges = BUCKET_EDGES) {
  if (!Number.isFinite(score)) return null;
  for (let b = 0; b < edges.length - 1; b++) {
    if (score < edges[b + 1] || b === edges.length - 2) return b;
  }
  return null;
}

// 第 i 天往後 horizon 個交易日內（i+1..i+h）是否曾觸及 ±threshold（以盤中高低價對 i 日收盤）。
// 視窗未走完回 null —— 最新 horizon 天沒有結果，不偷看未來。
export function forwardOutcomes(rows, horizon, threshold) {
  const n = rows.length;
  const up = new Array(n).fill(null);
  const down = new Array(n).fill(null);
  for (let i = 0; i + horizon < n; i++) {
    const base = rows[i].close;
    let hi = -Infinity;
    let lo = Infinity;
    let ok = true;
    for (let j = i + 1; j <= i + horizon; j++) {
      const h = Number.isFinite(rows[j].high) ? rows[j].high : rows[j].close;
      const l = Number.isFinite(rows[j].low) ? rows[j].low : rows[j].close;
      if (!Number.isFinite(h) || !Number.isFinite(l)) { ok = false; break; }
      if (h > hi) hi = h;
      if (l < lo) lo = l;
    }
    if (!ok || !(base > 0)) continue;
    up[i] = hi / base - 1 >= threshold ? 1 : 0;
    down[i] = lo / base - 1 <= -threshold ? 1 : 0;
  }
  return { up, down };
}

// Point-in-time 條件命中率：第 t 天只用 j ≤ t − horizon 的樣本（其前瞻視窗在 t 收盤時已完結），
// 取與 t 同一分數組的歷史命中率；樣本 < minSamples 回 null。
export function pointInTimeRates(composite, outcomes, horizon, { minSamples = 30, edges = BUCKET_EDGES } = {}) {
  const n = composite.length;
  const nb = edges.length - 1;
  const cnt = new Array(nb).fill(0);
  const upHits = new Array(nb).fill(0);
  const downHits = new Array(nb).fill(0);
  const upRate = new Array(n).fill(null);
  const downRate = new Array(n).fill(null);
  const samples = new Array(n).fill(0);
  for (let t = 0; t < n; t++) {
    const j = t - horizon;
    if (j >= 0) {
      const b = bucketOf(composite[j], edges);
      if (b != null && outcomes.up[j] != null) {
        cnt[b]++;
        upHits[b] += outcomes.up[j];
        downHits[b] += outcomes.down[j];
      }
    }
    const bt = bucketOf(composite[t], edges);
    if (bt == null) continue;
    samples[t] = cnt[bt];
    if (cnt[bt] >= minSamples) {
      upRate[t] = +(upHits[bt] / cnt[bt] * 100).toFixed(1);
      downRate[t] = +(downHits[bt] / cnt[bt] * 100).toFixed(1);
    }
  }
  return { upRate, downRate, samples };
}

// 全部已完結樣本的分組統計（表格用）＋不分組的基準率。
export function bucketTable(composite, outcomes, { edges = BUCKET_EDGES } = {}) {
  const nb = edges.length - 1;
  const buckets = Array.from({ length: nb }, (_, b) => ({ lo: edges[b], hi: edges[b + 1], n: 0, up: 0, down: 0 }));
  const base = { n: 0, up: 0, down: 0 };
  for (let i = 0; i < composite.length; i++) {
    const b = bucketOf(composite[i], edges);
    if (b == null || outcomes.up[i] == null) continue;
    for (const target of [buckets[b], base]) {
      target.n++;
      target.up += outcomes.up[i];
      target.down += outcomes.down[i];
    }
  }
  const rate = (hits, n) => n ? +(hits / n * 100).toFixed(1) : null;
  const finish = x => ({ ...x, upRate: rate(x.up, x.n), downRate: rate(x.down, x.n) });
  return { buckets: buckets.map(finish), base: finish(base) };
}
