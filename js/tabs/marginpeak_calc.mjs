// Margin peak descriptive research. Existing event arithmetic is unchanged.
import { percentile, mean } from '../utils/math.js';
export const HORIZONS = { '1m': 21, '3m': 63, '6m': 126, '12m': 252 };
export const EVENT_STUDY_WINDOW_TD = 252;
export const BASELINE_VERSION = 'marginpeak-monthly-raw-v1';
export const BASELINE_START_MONTH = '1999-04';
export const BASELINE_END_MONTH = '2025-06';

// ── date helpers ─────────────────────────────────────────────────────
// margin 日期是 'YYYY-MM-01'；python 用 PeriodIndex('M').to_timestamp('M') 取月底當 anchor，
// 這裡對齊同一邏輯：月底 = 該月最後一天。
export function monthEnd(dateStr) {
  const y = +dateStr.slice(0, 4), m = +dateStr.slice(5, 7);
  // check_reuse: keep — UTC 建構的時間戳轉日期鍵,slice 與建構端同為 UTC 故自洽;tsToLocalDate 是給 ECharts 本地午夜 axisValue 用的,換過去反而會差一天
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
export function daysBetween(a, b) {
  return (new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000;
}

// ── forward return（貼齊 ≤ 月底最近交易日為錨，往後 td 個交易日）──────
// 對拍 lab.fwd_ret：anchor = 最近 ≤ dt 的交易日；future 取 anchor 之後第 td 個交易日。
export function findAnchorIdx(series, targetDate) {
  let lo = 0, hi = series.length - 1, res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].date <= targetDate) { res = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return res;
}
export function fwdRet(series, anchorIdx, td) {
  if (anchorIdx < 0) return null;
  const targetIdx = anchorIdx + td;
  if (targetIdx >= series.length) return null;
  return +(((series[targetIdx].close / series[anchorIdx].close) - 1) * 100).toFixed(2);
}

export function median(vals) {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  const m = s.length;
  return m % 2 ? s[(m - 1) / 2] : (s[m / 2 - 1] + s[m / 2]) / 2;
}

// ── signal detection（對拍 margin_yoy_spy_qqq.py sig50 / peaks）──────
export function detectSignalA(yoySeries) {
  const out = [];
  let lastDate = null;
  for (const r of yoySeries) {
    if (r.yoy > 50) {
      if (!lastDate || daysBetween(lastDate, r.date) > 365) {
        out.push(r);
        lastDate = r.date;
      }
    }
  }
  return out;
}
// 對拍注意：python 在「含前12個月NaN的完整月序列」上跑 range(6, len(yoy)-6)，
// NaN 被 pandas max() 自動忽略；yoySeries（本檔）已經把前12個月NaN砍掉，
// 所以邊界要往前clip到0而非再退6格，否則會漏掉序列開頭附近的訊號（例：1998-04）。
export function detectSignalB(yoySeries) {
  const out = [];
  const n = yoySeries.length;
  for (let i = 0; i <= n - 7; i++) {
    const v = yoySeries[i].yoy;
    if (v == null || v <= 30) continue;
    let windowMax = -Infinity;
    for (let j = Math.max(0, i - 6); j <= i + 6; j++) windowMax = Math.max(windowMax, yoySeries[j].yoy);
    if (v === windowMax) out.push(yoySeries[i]);
  }
  return out;
}

export function computeSignalRow(sig, spxSeries, qqqSeries) {
  const anchor = monthEnd(sig.date);
  const spxIdx = findAnchorIdx(spxSeries, anchor);
  const qqqIdx = findAnchorIdx(qqqSeries, anchor);
  const row = { signal: sig.date.slice(0, 7), yoy: +sig.yoy.toFixed(1) };
  for (const [hk, td] of Object.entries(HORIZONS)) {
    row[`SPX_${hk}`] = fwdRet(spxSeries, spxIdx, td);
    row[`QQQ_${hk}`] = fwdRet(qqqSeries, qqqIdx, td);
  }
  return row;
}

export const COLS = ['SPX_1m', 'SPX_3m', 'SPX_6m', 'SPX_12m', 'QQQ_1m', 'QQQ_3m', 'QQQ_6m', 'QQQ_12m'];
export function groupMedians(rows) {
  const out = {};
  for (const k of COLS) out[k] = median(rows.map(r => r[k]).filter(v => v != null));
  return out;
}

// Counts use exactly the same non-nullish population as groupMedians.
export function groupCounts(rows) {
  return Object.fromEntries(COLS.map(key => [key, rows.filter(row => row[key] != null).length]));
}

// Fixed reference anchor window. Future prices may lie beyond endMonth.
export function computeBaseline(spxSeries, qqqSeries,
  { startMonth = BASELINE_START_MONTH, endMonth = BASELINE_END_MONTH } = {}) {
  const rows = [];
  for (let year = +startMonth.slice(0, 4); year <= +endMonth.slice(0, 4); year++) {
    for (let month = 1; month <= 12; month++) {
      const ym = `${year}-${String(month).padStart(2, '0')}`;
      if (ym < startMonth || ym > endMonth) continue;
      rows.push(computeSignalRow({ date: `${ym}-01`, yoy: 0 }, spxSeries, qqqSeries));
    }
  }
  return { medians: groupMedians(rows), counts: groupCounts(rows), months: rows.length };
}

// ── event study（融資 YoY 局部峰值 t=0 → SPX/QQQ rebase=100 percentile band）──
// 沿用 detectSignalB 的局部峰值事件，錨點對齊邏輯與 computeSignalRow 相同
// （monthEnd + findAnchorIdx，貼齊 ≤ 月底最近交易日），往後取真實交易日精度
// （非月頻近似），滿足投影片「Days」x 軸語意。
export function buildEventStudyPure(idxKey, state) {
  const series = idxKey === 'QQQ' ? state.qqqDaily : state.spxDaily;
  const eventDates = state.sigBDates;
  const paths = [];
  for (const d of eventDates) {
    const anchorIdx = findAnchorIdx(series, monthEnd(d));
    if (anchorIdx < 0) continue;
    const base = series[anchorIdx].close;
    if (!base) continue;
    const path = new Array(EVENT_STUDY_WINDOW_TD + 1).fill(null);
    for (let i = 0; i <= EVENT_STUDY_WINDOW_TD; i++) {
      const p = series[anchorIdx + i];
      if (p) path[i] = (p.close / base) * 100;
    }
    paths.push(path);
  }
  const meanArr = [], p25Arr = [], p75Arr = [], counts = [];
  for (let i = 0; i <= EVENT_STUDY_WINDOW_TD; i++) {
    const vals = paths.map(p => p[i]).filter(v => v != null).sort((a, b) => a - b);
    counts.push(vals.length);
    meanArr.push(vals.length ? +mean(vals).toFixed(2) : null);
    p25Arr.push(vals.length ? +percentile(vals, 0.25).toFixed(2) : null);
    p75Arr.push(vals.length ? +percentile(vals, 0.75).toFixed(2) : null);
  }
  return { meanArr, p25Arr, p75Arr, counts, n: paths.length };
}
