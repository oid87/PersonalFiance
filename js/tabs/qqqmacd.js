// 週MACD死叉 → 回MA20 tab（探索性研究，複製 wkrev.js 模式）
//   命題：QQQ/SPX 週MACD死叉時，①股價「加速」回頭找週MA20（短horizon有edge、長horizon收斂基率）
//         ②觸及MA20後突破/震盪/跌破分布 ③死叉「不」系統性抬高 ≥8% 大跌機率（≈基率，誠實負結果）
//   標的：QQQ / SPX(^GSPC，用 data/SP500.json)；資料直接讀現成 data/QQQ.json、data/SP500.json
//
// 防前視：死叉在第 i 週收盤確立，只用到第 i 週(含)以前資料；觸及/下檔統計一律從 i+1 週起算。
// 尾端覆蓋防護：資料末端 partial（未走完）週整根丟棄，不進入任何統計或圖表（同 python ground truth）。
//
// 對拍基準（python: qqq_macd_ma20_revert.py / qqq_macd_downside.py）：
//   QQQ N=56, SPX(SP500) N=91；QQQ 觸及率 2/4/8週 = 62.5%/67.9%/78.6%；
//   QQQ ≥8%捕捉 8週 ≈26.8%(≈基率)；QQQ 三桶 突破43.4%/震盪43.4%/跌破13.2%。

import { isLight, tc, PALETTE } from '../utils/theme.js';
import { computeMA, computeMACD } from '../utils/math.js';

const TICKERS = [
  { key: "QQQ", label: "QQQ",       file: "data/QQQ.json",   color: "#f778ba" },
  { key: "SPX", label: "SPX（^GSPC）", file: "data/SP500.json", color: "#58a6ff" },
];

const HORIZONS = [2, 4, 8];
const DOWNSIDE_THRESHOLDS = [0.05, 0.08, 0.10];
const TOUCH_HORIZON = 26; // 死叉後找首次觸及MA20的上限週數，同 python TOUCH_HORIZON

let chart = null;
let ticker = "QQQ";
const cache = {}; // key -> { weeks, dif, dea, ma20, ma50, crossIdx }

// ── 週K 重採樣（複製自 wkrev.js，需同步） ──────────────────────────
function toWeeklyOHLC(daily) {
  // daily: [[date, open, high, low, close, volume], ...] ascending
  const byWeek = new Map();
  const order = [];
  for (const [date, open, high, low, close, volume] of daily) {
    const d = new Date(date + "T00:00:00Z");
    const day = d.getUTCDay();
    const diff = day === 0 ? -6 : 1 - day;
    const mon = new Date(d);
    mon.setUTCDate(d.getUTCDate() + diff);
    const key = mon.toISOString().slice(0, 10);
    let w = byWeek.get(key);
    if (!w) {
      w = { weekStart: key, weekEndDate: date, open, high, low, close, volume: volume || 0 };
      byWeek.set(key, w);
      order.push(key);
    } else {
      w.high = Math.max(w.high, high);
      w.low = Math.min(w.low, low);
      w.close = close;
      w.weekEndDate = date;
      w.volume += volume || 0;
    }
  }
  const weeks = order.map(k => byWeek.get(k)).sort((a, b) => a.weekStart < b.weekStart ? -1 : 1);
  // partial: 只有「資料末端那一週」且該週最後交易日不是週五(UTC getUTCDay()===5) 才算
  if (weeks.length) {
    const last = weeks[weeks.length - 1];
    const lastDow = new Date(last.weekEndDate + "T00:00:00Z").getUTCDay();
    last.partial = lastDow !== 5;
  }
  for (let i = 0; i < weeks.length - 1; i++) weeks[i].partial = false;
  return weeks;
}

// ── MA20/MA50 對齊回完整長度陣列（computeMA 回傳的是砍掉暖身期的短陣列） ──
function alignMA(weeks, period) {
  const closeSeries = weeks.map(w => [w.weekStart, w.close]);
  const raw = computeMA(closeSeries, period); // [[date,val],...] 從 index period-1 開始
  const out = new Array(weeks.length).fill(null);
  for (let k = 0; k < raw.length; k++) out[period - 1 + k] = raw[k][1];
  return out;
}

// ── 死叉偵測（防前視：只用 i-1/i 兩週資料，且要求 MA20 已定義） ──────
function detectDeathCrosses(dif, dea, ma20) {
  const out = [];
  for (let i = 1; i < dif.length; i++) {
    if (ma20[i] == null) continue;
    if (dif[i - 1] >= dea[i - 1] && dif[i] < dea[i]) out.push(i);
  }
  return out;
}

// ── 首次觸及 MA20（j-i, j>=i+1），touched = low[j]<=MA20[j]<=high[j] ──
function firstTouchWithin(weeks, ma20, startI, maxN) {
  const n = weeks.length;
  const end = Math.min(startI + maxN, n - 1);
  for (let j = startI + 1; j <= end; j++) {
    if (ma20[j] == null) continue;
    if (weeks[j].low <= ma20[j] && ma20[j] <= weeks[j].high) return j - startI;
  }
  return null;
}

// ── 未來 N 週最大回檔：min(low[i+1..i+N])/close[i]-1；i+N 超尾端回傳 null ──
function maxDeclineN(weeks, i, n) {
  const length = weeks.length;
  if (i + n > length - 1) return null;
  let lo = Infinity;
  for (let j = i + 1; j <= i + n; j++) lo = Math.min(lo, weeks[j].low);
  return lo / weeks[i].close - 1;
}

function pct(flags) {
  if (!flags.length) return null;
  return 100 * flags.filter(Boolean).length / flags.length;
}
function median(vals) {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  const m = s.length;
  return m % 2 ? s[(m - 1) / 2] : (s[m / 2 - 1] + s[m / 2]) / 2;
}

// ── 核心計算：死叉組(A) vs 全樣本無條件基率(B) ───────────────────────
function analyze(weeks, dif, dea, ma20, ma50) {
  const n = weeks.length;
  const crossIdx = detectDeathCrosses(dif, dea, ma20);

  // B 組起點：MA20 已定義的每一週
  const bStarts = [];
  for (let i = 0; i < n; i++) if (ma20[i] != null) bStarts.push(i);

  // 表1：回歸速度（horizon 2/4/8）
  const touchRows = HORIZONS.map(h => {
    const aFlags = crossIdx.map(i => firstTouchWithin(weeks, ma20, i, h) != null);
    const bFlags = bStarts.filter(i => i + h <= n - 1).map(i => firstTouchWithin(weeks, ma20, i, h) != null);
    const a = pct(aFlags), b = pct(bFlags);
    return { h, a, b, ratio: (a != null && b) ? a / b : null };
  });
  // A 首次觸及中位週數（全 horizon 內出現過的事件，用 TOUCH_HORIZON 上限）
  const aFirstTouchWeeks = crossIdx
    .map(i => firstTouchWithin(weeks, ma20, i, TOUCH_HORIZON))
    .filter(v => v != null);
  const aMedianWeeks = median(aFirstTouchWeeks);

  // 表2：下檔捕捉（門檻 5/8/10% × horizon 2/4/8）
  const downsideRows = [];
  for (const h of HORIZONS) {
    const aValid = crossIdx.filter(i => i + h <= n - 1);
    const aDeclines = aValid.map(i => maxDeclineN(weeks, i, h)).filter(d => d != null);
    const bValid = bStarts.filter(i => i + h <= n - 1);
    const bDeclines = bValid.map(i => maxDeclineN(weeks, i, h)).filter(d => d != null);
    for (const thresh of DOWNSIDE_THRESHOLDS) {
      const aRate = pct(aDeclines.map(d => d <= -thresh));
      const bRate = pct(bDeclines.map(d => d <= -thresh));
      downsideRows.push({ h, thresh, a: aRate, b: bRate, ratio: (aRate != null && bRate) ? aRate / bRate : null });
    }
  }

  // 表3：觸及後三桶（首次觸及後8週，以觸及當週MA20為錨±5%）
  let breakout = 0, chop = 0, breakdown = 0, breakdownTouchMa50 = 0, nTouchedEvents = 0, excluded = 0;
  for (const i of crossIdx) {
    const ft = firstTouchWithin(weeks, ma20, i, TOUCH_HORIZON);
    if (ft == null) continue;
    nTouchedEvents++;
    const t = i + ft;
    const target = t + 8;
    if (target > n - 1) { excluded++; continue; }
    const maTouch = ma20[t];
    if (maTouch == null) { excluded++; continue; }
    const c8 = weeks[target].close;
    if (c8 >= maTouch * 1.05) {
      breakout++;
    } else if (c8 <= maTouch * 0.95) {
      breakdown++;
      let touchedMa50 = false;
      for (let j = t + 1; j <= Math.min(target, n - 1); j++) {
        if (ma50[j] != null && weeks[j].low <= ma50[j] && ma50[j] <= weeks[j].high) { touchedMa50 = true; break; }
      }
      if (touchedMa50) breakdownTouchMa50++;
    } else {
      chop++;
    }
  }
  const counted = breakout + chop + breakdown;

  return {
    crossIdx, touchRows, aMedianWeeks, downsideRows,
    buckets: { nTouchedEvents, excluded, counted, breakout, chop, breakdown, breakdownTouchMa50 },
    nB: bStarts.length,
  };
}

function fmtPct(v) { return v == null ? "N/A" : `${v.toFixed(1)}%`; }
function fmtRatio(v) { return v == null ? "N/A" : `${v.toFixed(2)}x`; }

function renderTables(res) {
  const host = document.getElementById("qqqmacd-tables");
  if (!host) return;

  const t1 = res.touchRows.map(r => `
    <tr style="border-top:2px solid var(--border);font-weight:600">
      <td>${r.h} 週</td><td>${fmtPct(r.a)}</td><td>${fmtPct(r.b)}</td><td>${fmtRatio(r.ratio)}</td>
      <td>${res.aMedianWeeks == null ? "N/A" : res.aMedianWeeks.toFixed(1)}</td>
    </tr>`).join("");

  const t2 = res.downsideRows.map(r => `
    <tr>
      <td>${r.h} 週</td><td>${(r.thresh * 100).toFixed(0)}%</td>
      <td>${fmtPct(r.a)}</td><td>${fmtPct(r.b)}</td><td>${fmtRatio(r.ratio)}</td>
    </tr>`).join("");

  const b = res.buckets;
  const t3 = b.counted > 0 ? `
    <tr><td>突破向上（觸及後8週收盤 ≥ 錨×1.05）</td><td>${b.breakout}</td><td>${fmtPct(100 * b.breakout / b.counted)}</td></tr>
    <tr><td>區間震盪</td><td>${b.chop}</td><td>${fmtPct(100 * b.chop / b.counted)}</td></tr>
    <tr><td>跌破向下（觸及後8週收盤 ≤ 錨×0.95）</td><td>${b.breakdown}</td><td>${fmtPct(100 * b.breakdown / b.counted)}</td></tr>
  ` : `<tr><td colspan="3">無可計樣本（全部被尾端排除或無觸及事件）</td></tr>`;

  host.innerHTML = `
    <h4 style="margin:12px 0 4px">表1・回歸速度（死叉組 vs 全樣本無條件基率）</h4>
    <table class="info-table">
      <thead><tr><th>horizon</th><th>A死叉組觸及%</th><th>B基率%</th><th>倍數</th><th>A首次觸及中位週數</th></tr></thead>
      <tbody>${t1}</tbody>
    </table>

    <h4 style="margin:16px 0 4px">表2・下檔捕捉（≥門檻%回檔，死叉組 vs 基率）</h4>
    <table class="info-table">
      <thead><tr><th>horizon</th><th>門檻</th><th>A死叉組%</th><th>B基率%</th><th>倍數</th></tr></thead>
      <tbody>${t2}</tbody>
    </table>
    <p style="margin-top:6px;color:var(--muted)">⚠️ 死叉組捕捉率與基率倍數普遍 ≈1.0x（甚至 &lt;1x）→ 週MACD死叉<b>不</b>系統性抬高 ≥8% 大跌機率，<b>非崩跌預警</b>；死叉的 edge 在「快速回MA20」，不在「預告下殺」。</p>

    <h4 style="margin:16px 0 4px">表3・觸及MA20後8週走法（觸及事件數=${b.nTouchedEvents}，計入=${b.counted}${b.excluded ? `，尾端排除=${b.excluded}` : ""}）</h4>
    <table class="info-table">
      <thead><tr><th>結果</th><th>次數</th><th>比例</th></tr></thead>
      <tbody>${t3}</tbody>
    </table>
    <p style="margin-top:6px;color:var(--muted)">跌破向下組中，8週內也觸及週MA50：${b.breakdown > 0 ? `${b.breakdownTouchMa50}/${b.breakdown}（${fmtPct(100 * b.breakdownTouchMa50 / b.breakdown)}）` : "無跌破樣本"}</p>
  `;
}

// ── 主圖渲染 ───────────────────────────────────────────────────────
function render(weeks, dif, dea, ma20, ma50, res) {
  if (!chart) return;
  const t = TICKERS.find(x => x.key === ticker);
  const axisClr = PALETTE.muted;
  const gridClr = PALETTE.grid;
  const tipBg   = PALETTE.bg;
  const tipBdr  = PALETTE.border;
  const textClr = PALETTE.text2;

  const dates = weeks.map(w => w.weekStart);
  const candle = weeks.map(w => [w.open, w.close, w.low, w.high]);
  const ma20Line = weeks.map((w, i) => [w.weekStart, ma20[i]]);
  const ma50Line = weeks.map((w, i) => [w.weekStart, ma50[i]]);

  const crossPoints = res.crossIdx.map(i => ({
    coord: [dates[i], weeks[i].high], symbol: "triangle", symbolRotate: 180, symbolSize: 10,
    itemStyle: { color: "#f85149" }, label: { show: false },
  }));
  const touchPoints = [];
  for (const i of res.crossIdx) {
    const ft = firstTouchWithin(weeks, ma20, i, TOUCH_HORIZON);
    if (ft == null) continue;
    const t2 = i + ft;
    touchPoints.push({
      coord: [dates[t2], ma20[t2]], symbol: "circle", symbolSize: 8,
      itemStyle: { color: "#e3b341" }, label: { show: false },
    });
  }

  const status = document.getElementById("qqqmacd-status");
  if (status) {
    status.textContent = `${t.label} · ${weeks.length} 根週K · 死叉 ${res.crossIdx.length} 次 · 觸及MA20 ${res.buckets.nTouchedEvents} 次`;
  }

  chart.setOption({
    backgroundColor: "transparent", animation: false,
    tooltip: {
      trigger: "axis",
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        const p = params.find(x => x.seriesType === "candlestick");
        if (!p) return "";
        const [o, c, l, h] = p.data;
        const i = p.dataIndex;
        let html = `<div style="font-weight:600;margin-bottom:4px">${dates[i]}</div>`;
        html += `<div>開 ${o.toFixed(1)}　高 ${h.toFixed(1)}　低 ${l.toFixed(1)}　收 ${c.toFixed(1)}</div>`;
        if (ma20[i] != null) html += `<div>MA20: ${ma20[i].toFixed(2)}</div>`;
        if (ma50[i] != null) html += `<div>MA50: ${ma50[i].toFixed(2)}</div>`;
        html += `<div>DIF ${dif[i].toFixed(2)} / DEA ${dea[i].toFixed(2)}</div>`;
        return html;
      },
    },
    grid: { left: 56, right: 30, top: "6%", bottom: "12%" },
    xAxis: {
      type: "category", data: dates, boundaryGap: true,
      axisLine: { lineStyle: { color: axisClr } }, axisTick: { show: false },
      axisLabel: { color: axisClr, fontSize: 11 }, splitLine: { show: false },
    },
    yAxis: {
      scale: true, position: "left",
      axisLabel: { color: axisClr, fontSize: 11 }, axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: gridClr } },
    },
    dataZoom: [{ type: "inside", filterMode: "none" }, { type: "slider", height: 18, bottom: 4 }],
    series: [
      {
        name: t.label, type: "candlestick", data: candle,
        itemStyle: { color: "#3fb950", color0: "#f85149", borderColor: "#3fb950", borderColor0: "#f85149" },
        markPoint: { silent: false, data: [...crossPoints, ...touchPoints] },
      },
      {
        name: "MA20", type: "line", data: ma20Line.map(r => r[1]), showSymbol: false,
        lineStyle: { color: "#58a6ff", width: 1.3 },
      },
      {
        name: "MA50", type: "line", data: ma50Line.map(r => r[1]), showSymbol: false,
        lineStyle: { color: "#d2a8ff", width: 1.3 },
      },
    ],
  }, { notMerge: true });
}

// ── controls ───────────────────────────────────────────────────────
function buildControls() {
  const host = document.getElementById("qqqmacd-ticker-picker");
  if (!host || host.dataset.built) return;
  host.innerHTML = TICKERS.map(t =>
    `<span class="chip${t.key === ticker ? " active" : ""}" data-qqqmacd-ticker="${t.key}">${t.label}</span>`).join("");
  host.dataset.built = "1";
  host.querySelectorAll(".chip").forEach(c => c.addEventListener("click", () => {
    host.querySelectorAll(".chip").forEach(e => e.classList.remove("active"));
    c.classList.add("active");
    ticker = c.dataset.qqqmacdTicker;
    refresh();
  }));
}

async function loadTicker(key) {
  if (cache[key]) return cache[key];
  const t = TICKERS.find(x => x.key === key);
  const resp = await fetch(t.file, { cache: "no-cache" });
  if (!resp.ok) throw new Error(`${key}: HTTP ${resp.status}`);
  const j = await resp.json();
  const daily = (j.data || []).map(r => [r.date, r.open, r.high, r.low, r.close, r.volume || 0]);
  let weeks = toWeeklyOHLC(daily);
  // 尾端 partial 週整根丟棄（同 python：load_weekly 丟棄未走完的最後一週，不進入任何統計/圖表）
  if (weeks.length && weeks[weeks.length - 1].partial) weeks = weeks.slice(0, -1);

  const closes = weeks.map(w => w.close);
  const { dif, dea } = computeMACD(closes, 12, 26, 9);
  const ma20 = alignMA(weeks, 20);
  const ma50 = alignMA(weeks, 50);
  const res = analyze(weeks, dif, dea, ma20, ma50);

  cache[key] = { weeks, dif, dea, ma20, ma50, res };
  return cache[key];
}

async function refresh() {
  const status = document.getElementById("qqqmacd-status");
  try {
    const { weeks, dif, dea, ma20, ma50, res } = await loadTicker(ticker);
    render(weeks, dif, dea, ma20, ma50, res);
    renderTables(res);
  } catch (e) {
    if (status) status.textContent = `載入失敗：${e.message}`;
  }
}

// ── lifecycle ──────────────────────────────────────────────────────
export async function activate() {
  const host = document.getElementById("qqqmacd-chart");
  if (!host) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : "dark");
  buildControls();
  await refresh();
}
export function onThemeChange(light) {
  if (!chart) return;
  chart.dispose();
  chart = echarts.init(document.getElementById("qqqmacd-chart"), light ? null : "dark");
  if (cache[ticker]) render(cache[ticker].weeks, cache[ticker].dif, cache[ticker].dea, cache[ticker].ma20, cache[ticker].ma50, cache[ticker].res);
}
export function resize() { chart?.resize(); }
