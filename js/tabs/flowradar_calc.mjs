// flowradar_calc.mjs — 「資金雷達」tab 的純函數計算層。
// 不 import DOM 或圖表繪製函式庫；只 import js/utils 的純函數。
// 五軸：暗池買盤(darkpool) / 空單壓力(short) / 期權情緒(options) / 技術面(technical) / 尾部風險(skew)。
// 全部方向統一為 0–100，分數高＝偏多／風險偏好。詳細定義見 spec_flowradar.md B2。

import { percentileRank, computeMA, computeRSI, computeMACD } from '../utils/math.js';
import { lookupLE } from '../utils/dates.js';

// ── rollingPctScore ──────────────────────────────────────────────────────
// dates: 升冪日期陣列（分數輸出的日期軸，通常是價格檔的交易日）。
// raw:   對應 dates 的原始值陣列（null 代表當天沒有原始值 → score 也是 null）。
// win: 往回看幾筆「原始值非 null」的觀測（含當日），只看 t 當天及以前（無未來函數）。
// minObs: 累積不到這個筆數時 score = null（暖身期）。
// 回傳與 dates 等長的 score 陣列（0–100 或 null）。
// ⚠️ 注意：math.percentileRank(val, sortedAsc) 是嚴格 count(x<val)/len（見
// js/utils/math.js 文件註解），對一組 n 個相異值的最大值而言 rank 恆為
// (n-1)/n，隨 n 增加漸近但永遠到不了剛好 1（即 score 恆 <100，不會等於
// 100）。這是照 spec 指定使用 math.percentileRank 的必然結果，不是本檔的
// bug；見 flowradar_calc.test.mjs 的相應測試註解。
export function rollingPctScore(dates, raw, win, minObs) {
  const scores = new Array(dates.length).fill(null);
  const buf = []; // 滾動視窗：只放非 null 的歷史 raw 值，最多 win 筆
  for (let i = 0; i < dates.length; i++) {
    const v = raw[i];
    if (v == null) continue; // score 維持 null；buf 不變(這天沒有新觀測)
    buf.push(v);
    if (buf.length > win) buf.shift();
    if (buf.length >= minObs) {
      const sorted = [...buf].sort((a, b) => a - b);
      const frac = percentileRank(v, sorted);
      scores[i] = frac == null ? null : +(frac * 100).toFixed(2);
    }
  }
  return scores;
}

function invert(scores) {
  return scores.map(s => s == null ? null : +(100 - s).toFixed(2));
}

// ── 5 日簡單平均 ──────────────────────────────────────────────────────────
function sma(arr, period) {
  const out = new Array(arr.length).fill(null);
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] == null) continue;
    let sum = 0, n = 0, ok = true;
    for (let j = i - period + 1; j <= i; j++) {
      if (j < 0 || arr[j] == null) { ok = false; break; }
      sum += arr[j]; n++;
    }
    if (ok && n === period) out[i] = sum / period;
  }
  return out;
}

// ── 軸 1：暗池買盤(SVR) ───────────────────────────────────────────────────
// dates: S 價格日期軸；svRows: finra_shortvol.json 的 data[]（{date, SPY_sv, SPY_tv, ...}）
// symbol: 'SPY' | 'QQQ'
// win=756（約 3 年交易日），minObs=252（約 1 年）
export function svrRaw(dates, svRows, symbol, { staleDays = 7 } = {}) {
  const raw = alignByLookupLE(dates, svRows, staleDays, row => {
    const sv = row[`${symbol}_sv`], tv = row[`${symbol}_tv`];
    return (sv != null && tv != null && tv > 0) ? sv / tv : null;
  });
  return sma(raw, 5);
}

export function svrScore(dates, svRows, symbol, { win = 756, minObs = 252, staleDays = 7 } = {}) {
  const svr5 = svrRaw(dates, svRows, symbol, { staleDays });
  return rollingPctScore(dates, svr5, win, minObs);
}

// ── 軸 2：空單壓力(DTC, days to cover) ────────────────────────────────────
// siRows: finra_short_interest.json 的 data[]（{date(settlementDate), SPY_dtc, QQQ_dtc, ...}）
// 每月兩次資料 forward-fill 到每個交易日；percentile 視窗用「≤t 的最近 72 筆
// settlement 觀測」（不是日頻視窗），取反（DTC 越高分數越低）。
// dates 對齊的原始 DTC 值（forward-fill，非百分位、非取反）——供 tooltip 顯示用。
export function shortPressureRaw(dates, siRows, symbol, { staleDays = 20 } = {}) {
  const field = `${symbol}_dtc`;
  return alignByLookupLE(dates, siRows, staleDays, row => row[field] ?? null);
}

export function shortPressureScore(dates, siRows, symbol, { win = 72, minObs = 24, staleDays = 20 } = {}) {
  const field = `${symbol}_dtc`;
  // siRows 依 settlementDate 升冪；每筆都是一個「觀測」，先算好每個 settlementDate
  // 的 percentile-win 分數，再 ffill 到日頻。
  const obsDates = [];
  const obsRaw = [];
  for (const r of siRows) {
    if (r[field] != null) { obsDates.push(r.date); obsRaw.push(r[field]); }
  }
  const obsScore = rollingPctScore(obsDates, obsRaw, win, minObs);
  // pack 成 [[date, score], ...] 供 lookupLE 對齊
  const scoreRows = obsDates.map((d, i) => [d, obsScore[i]]);

  const out = new Array(dates.length).fill(null);
  for (let i = 0; i < dates.length; i++) {
    const hit = lookupLE(scoreRows, dates[i]);
    if (!hit) continue;
    const [hitDate, score] = hit;
    if (score == null) continue;
    const gapDays = (Date.parse(dates[i]) - Date.parse(hitDate)) / 86400000;
    if (gapDays > staleDays) continue;
    out[i] = score;
  }
  return invert(out);
}

// ── 軸 3：期權情緒(equity P/C 5日均，取反) ─────────────────────────────────
// pcRows: putcall.json 的 equity[]（{date, pc}），全市場、不分 S。
export function optionsRaw(dates, pcRows, { staleDays = 7 } = {}) {
  const raw = alignByLookupLE(dates, pcRows, staleDays, row => row.pc ?? null);
  return sma(raw, 5);
}

export function optionsScore(dates, pcRows, { win = 756, minObs = 252, staleDays = 7 } = {}) {
  const pc5 = optionsRaw(dates, pcRows, { staleDays });
  const score = rollingPctScore(dates, pc5, win, minObs);
  return invert(score);
}

// ── 軸 5：尾部風險(CBOE SKEW，取反) ────────────────────────────────────────
// skewRows: vix_skew.json 的 history[]（{d, sk, ...}）。
export function skewRaw(dates, skewRows, { staleDays = 7 } = {}) {
  const normalized = skewRows.map(r => ({ date: r.d, sk: r.sk }));
  return alignByLookupLE(dates, normalized, staleDays, row => row.sk ?? null);
}

export function skewScore(dates, skewRows, { win = 756, minObs = 252, staleDays = 7 } = {}) {
  const raw = skewRaw(dates, skewRows, { staleDays });
  const score = rollingPctScore(dates, raw, win, minObs);
  return invert(score);
}

// ── 軸 4：技術面（不做 percentile，本身就是 0–100） ─────────────────────────
// priceRows: [[date, close], ...] 升冪（S 的收盤價）。
export function technicalScore(priceRows) {
  const dates = priceRows.map(r => r[0]);
  const closes = priceRows.map(r => r[1]);
  const out = new Array(dates.length).fill(null);

  const ma50 = computeMA(priceRows, 50);
  const ma200 = computeMA(priceRows, 200);
  const macd = computeMACD(closes, 12, 26, 9);
  const rsi = computeRSI(priceRows, 14);

  const ma50Map = new Map(ma50.map(r => [r[0], r[1]]));
  const ma200Map = new Map(ma200.map(r => [r[0], r[1]]));
  const rsiMap = new Map(rsi.map(r => [r[0], r[1]]));

  for (let i = 0; i < dates.length; i++) {
    const d = dates[i], close = closes[i];
    const m50 = ma50Map.get(d);
    const m200 = ma200Map.get(d);
    const hist = macd.hist[i];
    const rsiVal = rsiMap.get(d);
    if (m50 == null || m200 == null || hist == null || rsiVal == null) continue;
    const score = 25 * (close > m50 ? 1 : 0)
                + 25 * (close > m200 ? 1 : 0)
                + 25 * (hist > 0 ? 1 : 0)
                + 0.25 * rsiVal;
    out[i] = +score.toFixed(2);
  }
  return { dates, scores: out };
}

// ── 對齊工具 ──────────────────────────────────────────────────────────────
// dates: 目標日期軸（升冪）；srcRows: [{date, ...}] 升冪；staleDays: 超過幾個
// 日曆天沒更新就視為 null；pick(row): 取出原始值。
function alignByLookupLE(dates, srcRows, staleDays, pick) {
  const pairs = srcRows.map(r => [r.date, r]);
  const out = new Array(dates.length).fill(null);
  for (let i = 0; i < dates.length; i++) {
    const hit = lookupLE(pairs, dates[i]);
    if (!hit) continue;
    const [hitDate, row] = hit;
    const gapDays = (Date.parse(dates[i]) - Date.parse(hitDate)) / 86400000;
    if (gapDays > staleDays) continue;
    const v = pick(row);
    if (v != null) out[i] = v;
  }
  return out;
}

// ── buildAxes ────────────────────────────────────────────────────────────
// inputs: {
//   symbol: 'SPY'|'QQQ',
//   priceRows: [[date, close], ...] 升冪 (S 的收盤價),
//   svRows: finra_shortvol.json.data,
//   siRows: finra_short_interest.json.data,
//   pcRows: putcall.json.equity,
//   skewRows: vix_skew.json.history,
// }
// 回傳 { dates, axes: { darkpool, short, options, technical, skew } }（各軸皆與 dates 等長）
export function buildAxes(inputs) {
  const { symbol, priceRows, svRows, siRows, pcRows, skewRows } = inputs;
  const dates = priceRows.map(r => r[0]);

  const darkpool = svrScore(dates, svRows, symbol);
  const short = shortPressureScore(dates, siRows, symbol);
  const options = optionsScore(dates, pcRows);
  const { scores: technical } = technicalScore(priceRows);
  const skew = skewScore(dates, skewRows);

  return { dates, axes: { darkpool, short, options, technical, skew } };
}
