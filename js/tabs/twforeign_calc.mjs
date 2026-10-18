// 外資買賣超 — 純計算（無 DOM）。累計、歷史百分位、警戒事件、事後表現。
// 所有統計只用「當日以前」資料（trailing window），不含未來函數。

export const WINDOWS = [5, 10, 20];

// 滾動加總；前 n-1 筆為 null。
export function rollingSum(values, n) {
  const out = new Array(values.length).fill(null);
  let s = 0, bad = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) bad++; else s += v;
    if (i >= n) {
      const o = values[i - n];
      if (!Number.isFinite(o)) bad--; else s -= o;
    }
    out[i] = i >= n - 1 && bad === 0 ? s : null;
  }
  return out;
}

// 目前值在「含當日、往前最多 window 筆」中的百分位（≤ 自己的比例 × 100）；樣本不足 minHist 回 null。
export function trailingPercentile(series, window = 1250, minHist = 250) {
  const out = new Array(series.length).fill(null);
  for (let i = 0; i < series.length; i++) {
    const x = series[i];
    if (!Number.isFinite(x)) continue;
    let n = 0, le = 0;
    for (let j = Math.max(0, i - window + 1); j <= i; j++) {
      const v = series[j];
      if (!Number.isFinite(v)) continue;
      n++;
      if (v <= x) le++;
    }
    if (n >= minHist) out[i] = (le / n) * 100;
  }
  return out;
}

// 警戒：強度百分位 ≤ thr；兩次警戒之間至少隔 cooldown 個交易日（以第一天為準，避免同一波重複計算）。
export function findAlerts(pct, thr, cooldown = 20) {
  const idx = [];
  let last = -Infinity;
  for (let i = 0; i < pct.length; i++) {
    if (Number.isFinite(pct[i]) && pct[i] <= thr && i - last >= cooldown) { idx.push(i); last = i; }
  }
  return idx;
}

// 警戒後表現：以警戒日收盤為基準，往後 horizon 個交易日內最大跌幅與 horizon 日報酬。
// 後續不足 horizon 日 → mature=false，數值為「目前為止」。
export function eventStudy(closes, alertIdx, horizon = 20) {
  return alertIdx.map(i => {
    const base = closes[i];
    const end = Math.min(closes.length - 1, i + horizon);
    let minRet = 0;
    for (let j = i + 1; j <= end; j++) {
      const r = closes[j] / base - 1;
      if (r < minRet) minRet = r;
    }
    const mature = i + horizon <= closes.length - 1;
    const days = end - i;
    return {
      idx: i,
      mature,
      days,
      maxDrop: Number.isFinite(base) && days > 0 ? minRet * 100 : null,
      ret: Number.isFinite(base) && days > 0 ? (closes[end] / base - 1) * 100 : null,
    };
  });
}

export function median(arr) {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// 外資列 × 加權收盤 以日期交集對齊。回傳 {dates, net, close}；不補值。
export function alignForeignWithIndex(foreignRows, twiiRows) {
  const px = new Map(twiiRows.filter(r => Number.isFinite(r?.close)).map(r => [r.date, r.close]));
  const dates = [], net = [], close = [];
  for (const r of foreignRows) {
    if (!Number.isFinite(r?.foreign_net_yi) || !px.has(r.date)) continue;
    dates.push(r.date); net.push(r.foreign_net_yi); close.push(px.get(r.date));
  }
  return { dates, net, close };
}

export function buildForeign(foreignRows, twiiRows, { thr = 5, cooldown = 20, horizon = 20 } = {}) {
  const { dates, net, close } = alignForeignWithIndex(foreignRows, twiiRows);
  const sums = Object.fromEntries(WINDOWS.map(n => [n, rollingSum(net, n)]));
  const pct5 = trailingPercentile(sums[5]);
  const pct20 = trailingPercentile(sums[20]);
  const alerts = findAlerts(pct5, thr, cooldown);
  const events = eventStudy(close, alerts, horizon);
  return { dates, net, close, sums, pct5, pct20, alerts, events };
}

export function summarizeEvents(events) {
  const mature = events.filter(e => e.mature);
  return {
    n: events.length,
    nMature: mature.length,
    medianMaxDrop: median(mature.map(e => e.maxDrop)),
    medianRet: median(mature.map(e => e.ret)),
    winRate: mature.length ? (mature.filter(e => e.ret > 0).length / mature.length) * 100 : null,
  };
}
