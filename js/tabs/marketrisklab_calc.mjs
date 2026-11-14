// 市場預警與策略回測：前端純計算（無 DOM）。
// 均線算法與 scripts/_market_risk_lab.py 相同（EMA 以前 n 筆 SMA 起算），測試會對 Python 輸出核對。
// 前端只做「切換已預先計算的結果」與「依年份篩選已完成事件」；不重跑回測、不產生新的 NAV。

export const finite = v => typeof v === 'number' && Number.isFinite(v);

export function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let s = 0, q = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!finite(v)) { s = 0; q = []; continue; }
    q.push(v); s += v;
    if (q.length > n) s -= q.shift();
    if (q.length === n) out[i] = s / n;
  }
  return out;
}

export function ema(values, n) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (n + 1);
  let prev = null, buf = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!finite(v)) { prev = null; buf = []; continue; }
    if (prev == null) {
      buf.push(v);
      if (buf.length === n) { prev = buf.reduce((a, b) => a + b, 0) / n; out[i] = prev; }
      continue;
    }
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export const movingAverage = (values, n, kind = 'SMA') => (kind === 'EMA' ? ema(values, n) : sma(values, n));

/** 前端資料狀態：更新日距今天數、是否過期、抓取失敗清單。 */
export function dataStatus(payload, today = new Date().toISOString().slice(0, 10), maxAgeDays = 5) {
  if (!payload?.updated) return { level: 'unknown', text: '無法判定（缺更新日期）' };
  const age = Math.round((Date.parse(today) - Date.parse(payload.updated)) / 86400000);
  const failed = payload.extra_prices_failed || [];
  if (age > maxAgeDays) return { level: 'stale', age, text: `過期：最後成功更新 ${payload.updated}（${age} 天前）`, failed };
  if (failed.length) return { level: 'partial', age, text: `部分來源抓取失敗（沿用上次資料）：${failed.join('、')}`, failed };
  return { level: 'ok', age, text: `更新 ${payload.updated}`, failed };
}

/** 依年份篩選逐事件明細，重算描述統計（不含 bootstrap；CI 只對全期間由 Python 提供）。 */
export function filterStats(events, horizon, fromYear, toYear) {
  const h = String(horizon);
  const sel = (events || []).filter(e => {
    const y = Number(e.date.slice(0, 4));
    return y >= fromYear && y <= toYear;
  });
  const done = sel.map(e => e.h?.[h]).filter(x => x && x.status === 'complete' && finite(x.ret));
  const pending = sel.filter(e => e.h?.[h]?.status === 'pending').length;
  if (!done.length) return { n: 0, pending, total: sel.length };
  const rets = done.map(d => d.ret).sort((a, b) => a - b);
  const med = arr => { const s = [...arr].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  return {
    n: done.length, pending, total: sel.length,
    mean: rets.reduce((a, b) => a + b, 0) / rets.length,
    median: med(rets),
    up: done.filter(d => d.ret > 0).length / done.length,
    rebreak: done.filter(d => d.rebreak).length / done.length,
    maeMedian: med(done.map(d => d.mae)),
    mfeMedian: med(done.map(d => d.mfe)),
    mddWorst: Math.min(...done.map(d => d.mdd)),
    declusteredN: sel.filter(e => !e.clustered && e.h?.[h]?.status === 'complete').length,
  };
}

/** 依控制項取已預先計算的變體；不存在 → null（前端顯示「需重新批次計算」，不在瀏覽器假裝算出）。 */
export function pickVariant(bt, kind, rearm) {
  return bt?.variants?.[`${kind}|rearm${rearm}`] ?? null;
}

export const MARKET_FAMILIES = {
  US_NDX: ['reset300', 'reclaim150_after_reset'],
  US_SPX: ['break200_reclaim125', 'break200_reclaim150'],
  US_SOX: ['reset300', 'reclaim150_after_reset'],
  TW: ['reset300', 'reclaim150_after_reset'],
};

export const MARKET_STRATEGIES = {
  US_NDX: ['QLD_reset_r150'],
  US_SPX: ['SSO_b200_r125', 'SSO_b200_r150'],
  US_SOX: ['USD_reset_r150'],
  TW: ['631L_reset_r150'],
};

/** 主圖所需：某市場的日期／收盤／低點序列（從 market_risk_lab.json 的 chart 區塊）。 */
export function marketSeries(lab, market) {
  const us = lab.chart.us, tw = lab.chart.tw;
  if (market === 'TW') return { dates: tw.dates, close: tw.c, low: tw.l };
  const key = { US_NDX: 'qqq_c', US_SPX: 'spx_c', US_SOX: 'sox_c' }[market];
  return { dates: us.dates, close: us[key], low: market === 'US_NDX' ? us.qqq_l : null };
}

/** 摘要：最近一次重要訊號（跨市場，取日期最新者）。 */
export function latestSignal(lab, kind = 'SMA') {
  const ev = lab?.events?.[kind] || {};
  let best = null;
  for (const [mk, fams] of Object.entries(ev)) {
    for (const [fam, list] of Object.entries(fams)) {
      if (!Array.isArray(list) || !list.length) continue;
      const e = list.at(-1);
      if (!best || e.date > best.date) best = { market: mk, family: fam, date: e.date };
    }
  }
  return best;
}

/** 歷史事件之間比較：各案例 60 日路徑最終報酬與最大跌幅。 */
export function caseOutcome(c, sym = 'SPY') {
  const f = c?.forward?.[sym];
  if (!f?.path?.length) return null;
  const vals = f.path.map(p => p[1]);
  return { end: vals.at(-1), worst: Math.min(...vals), days: vals.length - 1, complete: !!f.complete };
}
