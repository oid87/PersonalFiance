// VIX/SKEW calculations; no DOM, data fetch, or implicit clock.
export function rangeStart(key, now) {
  if (key === "all") return "1900-01-01";
  const y = { "3Y": 3, "5Y": 5, "10Y": 10, "20Y": 20 }[key] ?? 5;
  const d = new Date(now);
  d.setFullYear(d.getFullYear() - y);
  return d.toISOString().slice(0, 10);
}

export function rollingMean(arr, win) {
  const out = new Array(arr.length).fill(null);
  let sum = 0, cnt = 0;
  const q = [];
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    q.push(v);
    if (v != null) { sum += v; cnt++; }
    if (q.length > win) {
      const old = q.shift();
      if (old != null) { sum -= old; cnt--; }
    }
    out[i] = cnt >= Math.min(win, 5) ? +(sum / cnt).toFixed(3) : null;
  }
  return out;
}

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

export function cxRollingPctRank(arr, window, minPeriods) {
  const out = new Array(arr.length).fill(null);
  for (let i = 0; i < arr.length; i++) {
    const lo = Math.max(0, i - window + 1);
    const v = arr[i];
    let n = 0, countLE = 0;
    for (let j = lo; j <= i; j++) {
      n++;
      if (arr[j] <= v) countLE++;
    }
    out[i] = n >= minPeriods ? (countLE / n) * 100 : null;
  }
  return out;
}

export function cxDedupeSignals(idxList, dates, gapDays) {
  const out = [];
  let lastMs = null;
  for (const i of idxList) {
    const ms = new Date(dates[i]).getTime();
    if (lastMs === null || (ms - lastMs) / 86400000 >= gapDays) {
      out.push(i);
      lastMs = ms;
    }
  }
  return out;
}

export function cxSummarize(vals) {
  if (!vals.length) return { n: 0, mean: null, median: null, winrate: null };
  const sorted = [...vals].sort((a, b) => a - b);
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const winrate = (vals.filter(v => v > 0).length / vals.length) * 100;
  return { n: vals.length, mean, median, winrate };
}

export function mainChartModel(history, signals, from) {
  const rows = history.filter(r => r.d >= from);
  if (rows.length < 10) return null;
  const dates = rows.map(r => r.d);
  const dateSet = new Set(dates);
  const spyBase = rows[0].sp;
  const spyData = rows.map(r => r.sp != null ? +((r.sp / spyBase - 1) * 100).toFixed(2) : null);
  const vixData = rows.map(r => r.v != null ? +r.v.toFixed(1) : null);
  const skewData = rows.map(r => r.sk != null ? +r.sk.toFixed(1) : null);
  const divData = rows.map(r => r.ds != null
    ? { value: +r.ds.toFixed(1), itemStyle: { color: r.ds > 0 ? "#f0883e" : "#3fb950" } } : null);
  const sigs = signals.filter(s => s.date >= from && dateSet.has(s.date));
  const dateIdx = Object.fromEntries(dates.map((d, i) => [d, i]));
  const sigSpy = sigs.map(s => {
    const y = spyData[dateIdx[s.date]];
    return y != null ? { value: [s.date, y], name: s.date,
      label: { show: false }, tooltip: { formatter: () =>
        `<b>⚠️ 序列信號 ${s.date}</b><br>VIX ${s.vix}（距峰 ${s.vix_drop}%）<br>SKEW ${s.skew}（距峰 ${s.skew_hold}%）<br>` +
        `趨勢反轉：${s.bear_trend ? "是" : "否"}<br>` +
        `3M 後 SPY：${s.ret_63d != null ? (s.ret_63d > 0 ? "+" : "") + s.ret_63d + "%" : "—"}` } } : null;
  }).filter(Boolean);
  const sigVix = sigs.map(s => {
    const y = vixData[dateIdx[s.date]];
    return y != null ? { value: [s.date, y] } : null;
  }).filter(Boolean);
  const vValid = vixData.filter(v => v != null);
  const skValid = skewData.filter(v => v != null);
  const vixMax = Math.ceil(Math.max(...vValid, 40) / 10) * 10;
  const skMin = Math.floor((Math.min(...skValid) - 5) / 10) * 10;
  const skMax = Math.ceil((Math.max(...skValid) + 5) / 10) * 10;
  return { rows, dates, spyData, vixData, skewData, divData, sigSpy, sigVix, vixMax, skMin, skMax };
}

export function termStructureModel(rows) {
  const dates = rows.map(r => r.date);
  const vixData = rows.map(r => r.vix != null ? +r.vix.toFixed(2) : null);
  const v3mData = rows.map(r => r.vix3m != null ? +r.vix3m.toFixed(2) : null);
  const tsData = rows.map(r => r.ts_ratio != null ? +r.ts_ratio.toFixed(3) : null);
  const backAreas = [];
  let segStart = null;
  for (let i = 0; i < rows.length; i++) {
    const on = rows[i].ts_ratio != null && rows[i].ts_ratio > 1;
    if (on && segStart === null) segStart = dates[i];
    if (!on && segStart !== null) {
      backAreas.push([{ xAxis: segStart }, { xAxis: dates[i - 1] }]);
      segStart = null;
    }
  }
  if (segStart !== null) backAreas.push([{ xAxis: segStart }, { xAxis: dates[dates.length - 1] }]);
  return { dates, vixData, v3mData, tsData, backAreas };
}

export function putCallModel(allRows, from) {
  const allPcSorted = allRows.map(r => r.pc).filter(v => v != null).slice().sort((a, b) => a - b);
  const p10 = percentile(allPcSorted, 0.10), p90 = percentile(allPcSorted, 0.90);
  const rows = allRows.filter(r => r.date >= from);
  const dates = rows.map(r => r.date);
  const pcVals = rows.map(r => r.pc != null ? +r.pc.toFixed(3) : null);
  return { rows, dates, pcVals, ma20: rollingMean(pcVals, 20), p10, p90 };
}

export function complacencyModel(history, {
  window = 504, minPeriods = 120, pctThreshold = 10, gapDays = 30,
  horizons = [21, 63, 126],
} = {}) {
  const rows = history.filter(r => r.sk != null && r.sp != null);
  const dates = rows.map(r => r.d);
  const sk = rows.map(r => r.sk), sp = rows.map(r => r.sp);
  const n = sk.length;
  if (n < minPeriods + 10) return null;
  const skPct = cxRollingPctRank(sk, window, minPeriods);
  const rawIdx = [];
  for (let i = 0; i < n; i++) if (skPct[i] != null && skPct[i] <= pctThreshold) rawIdx.push(i);
  const sigIdx = cxDedupeSignals(rawIdx, dates, gapDays);
  const result = {};
  for (const td of horizons) {
    const sigVals = [];
    for (const i of sigIdx) if (i + td < n) sigVals.push((sp[i + td] / sp[i] - 1) * 100);
    const baseVals = [];
    for (let i = 0; i < n; i++) if (i + td < n) baseVals.push((sp[i + td] / sp[i] - 1) * 100);
    const sigStat = cxSummarize(sigVals), baseStat = cxSummarize(baseVals);
    const diff = (sigStat.mean != null && baseStat.mean != null) ? sigStat.mean - baseStat.mean : null;
    result[td] = { signal: sigStat, baseline: baseStat, diff };
  }
  const curSk = sk[n - 1];
  const curPctFull = (sk.filter(v => v <= curSk).length / n) * 100;
  return { rows, dates, sk, sp, skPct, sigIdx, result, curSk, curPctFull, n };
}
