// 週K反轉 confluence tab — 多方訊號共振觀察（環境理解，非交易觸發）
//   四訊號（皆多方）：BIR（事件）· TD9買進setup（事件）· 週KD超賣（狀態）· 週RSI超賣（狀態）
//   主圖：週K candlestick + 訊號標記；下方勝率表（含全樣本無條件基率對照）
//   標的：SPX(^GSPC) / QQQ；資料直接讀現成 data/SP500.json、data/QQQ.json（無新 fetch 腳本）
//
// 防前視：訊號在第 i 週收盤確立，前瞻報酬一律從第 i+1 週收盤起算；
// partial（末端未走完）週排除於所有統計（BIR/TD9/KD/RSI/confluence/勝率表）之外，但仍可畫在圖上。

import { isLight, tc, PALETTE } from '../utils/theme.js';
import { computeRSI } from '../utils/math.js';

const TICKERS = [
  { key: "SPX", label: "SPX（^GSPC）", file: "data/SP500.json", color: "#58a6ff" },
  { key: "QQQ", label: "QQQ",          file: "data/QQQ.json",   color: "#f778ba" },
];

const KD_PERIOD = 9, KD_SMOOTH = 3;
const RSI_PERIOD = 14;
const TD_LOOKBACK = 4, TD_COUNT = 9;
const HORIZONS = [1, 4, 12];

let chart = null;
let ticker = "SPX";
const cache = {}; // key -> { weeks, sig }

// ── 週K 重採樣（週一=key；open=首日open、high=max、low=min、close=末日close） ──
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

// ── 四訊號逐週計算 ──────────────────────────────────────────────────
function computeSignals(weeks) {
  const n = weeks.length;
  const bir = new Array(n).fill(false);
  const td9 = new Array(n).fill(false);
  const kdOS = new Array(n).fill(false);
  const rsiOS = new Array(n).fill(false);
  const kArr = new Array(n).fill(null);
  const dArr = new Array(n).fill(null);
  const rsiArr = new Array(n).fill(null);

  // 1. BIR：前週收黑 AND 當週 high<=前高 low>=前低 AND 當週收紅
  for (let i = 1; i < n; i++) {
    if (weeks[i].partial) continue;
    const p = weeks[i - 1], c = weeks[i];
    if (p.close < p.open && c.high <= p.high && c.low >= p.low && c.close > c.open) bir[i] = true;
  }

  // 2. TD9 買進 setup：連續 9 週 close[i] < close[i-TD_LOOKBACK]，第9根標記
  {
    let dc = 0;
    for (let i = 0; i < n; i++) {
      if (i < TD_LOOKBACK) continue;
      if (weeks[i].close < weeks[i - TD_LOOKBACK].close) {
        dc = dc >= TD_COUNT ? 1 : dc + 1;
        if (dc === TD_COUNT && !weeks[i].partial) td9[i] = true;
      } else {
        dc = 0;
      }
    }
  }

  // 3. 週KD(9,3,3)：raw %K = (close-L9)/(H9-L9)*100 → 3週SMA得平滑K → 3週SMA得D
  {
    const rawK = new Array(n).fill(null);
    for (let i = KD_PERIOD - 1; i < n; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = i - KD_PERIOD + 1; j <= i; j++) { hh = Math.max(hh, weeks[j].high); ll = Math.min(ll, weeks[j].low); }
      rawK[i] = hh === ll ? 50 : (weeks[i].close - ll) / (hh - ll) * 100;
    }
    const smaK = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      if (rawK[i] == null) continue;
      const start = i - KD_SMOOTH + 1;
      if (start < KD_PERIOD - 1) continue;
      let sum = 0, cnt = 0, ok = true;
      for (let j = start; j <= i; j++) { if (rawK[j] == null) { ok = false; break; } sum += rawK[j]; cnt++; }
      if (ok && cnt === KD_SMOOTH) smaK[i] = sum / KD_SMOOTH;
    }
    const smaD = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      if (smaK[i] == null) continue;
      const start = i - KD_SMOOTH + 1;
      let sum = 0, cnt = 0, ok = true;
      for (let j = start; j <= i; j++) { if (smaK[j] == null) { ok = false; break; } sum += smaK[j]; cnt++; }
      if (ok && cnt === KD_SMOOTH) smaD[i] = sum / KD_SMOOTH;
    }
    for (let i = 0; i < n; i++) {
      kArr[i] = smaK[i]; dArr[i] = smaD[i];
      if (smaK[i] != null && smaD[i] != null && smaK[i] < 30 && smaD[i] < 30 && !weeks[i].partial) kdOS[i] = true;
    }
  }

  // 4. 週RSI(14, Wilder)：< 30 為超賣
  {
    const closeSeries = weeks.map(w => [w.weekStart, w.close]);
    const rsi = computeRSI(closeSeries, RSI_PERIOD); // [[date, val], ...] aligned by date, starts late
    const rsiMap = new Map(rsi.map(r => [r[0], r[1]]));
    for (let i = 0; i < n; i++) {
      const v = rsiMap.get(weeks[i].weekStart);
      if (v == null) continue;
      rsiArr[i] = v;
      if (v < 30 && !weeks[i].partial) rsiOS[i] = true;
    }
  }

  // confluence：0-4，partial 週不計（但仍給個 count 供繪圖需要時用，圖上照樣可畫）
  const confluence = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    confluence[i] = (bir[i] ? 1 : 0) + (td9[i] ? 1 : 0) + (kdOS[i] ? 1 : 0) + (rsiOS[i] ? 1 : 0);
  }

  return { bir, td9, kdOS, rsiOS, confluence, kArr, dArr, rsiArr };
}

// ── 前瞻報酬（防前視：從 i+1 週收盤起算）──────────────────────────
function forwardReturn(weeks, i, h) {
  if (i + h >= weeks.length) return null;
  if (weeks[i + h].partial) return null;
  return (weeks[i + h].close - weeks[i].close) / weeks[i].close;
}

function statsForIndices(weeks, indices) {
  const row = {};
  for (const h of HORIZONS) {
    const rets = [];
    for (const i of indices) {
      const r = forwardReturn(weeks, i, h);
      if (r != null) rets.push(r);
    }
    row[`n${h}`] = rets.length;
    row[`up${h}`] = rets.length ? rets.filter(r => r > 0).length / rets.length * 100 : null;
    if (h === 12) {
      row.avg12 = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length * 100 : null;
      const sorted = [...rets].sort((a, b) => a - b);
      row.median12 = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2]
        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) * 100 : null;
    }
  }
  return row;
}

function buildWinRateRows(weeks, sig) {
  const nonPartial = [];
  for (let i = 0; i < weeks.length; i++) if (!weeks[i].partial) nonPartial.push(i);

  const rows = [];
  const defs = [
    { label: "BIR", idx: nonPartial.filter(i => sig.bir[i]) },
    { label: "TD9 買進 setup", idx: nonPartial.filter(i => sig.td9[i]) },
    { label: "週KD 超賣(<30)", idx: nonPartial.filter(i => sig.kdOS[i]) },
    { label: "週RSI 超賣(<30)", idx: nonPartial.filter(i => sig.rsiOS[i]) },
    { label: "Confluence ≥2", idx: nonPartial.filter(i => sig.confluence[i] >= 2) },
  ];
  for (const d of defs) rows.push({ label: d.label, count: d.idx.length, ...statsForIndices(weeks, d.idx) });
  rows.push({ label: "全樣本無條件基率", count: nonPartial.length, ...statsForIndices(weeks, nonPartial), baseline: true });
  return rows;
}

function fmtPct(v) { return v == null ? "N/A" : `${v.toFixed(1)}%`; }
function fmtSigned(v) { return v == null ? "N/A" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`; }

function renderTable(rows) {
  const host = document.getElementById("wkrev-table");
  if (!host) return;
  const trs = rows.map(r => `
    <tr${r.baseline ? ' style="border-top:2px solid var(--border);font-weight:600"' : ''}>
      <td>${r.label}</td>
      <td>${r.count}</td>
      <td>${fmtPct(r.up1)}</td>
      <td>${fmtPct(r.up4)}</td>
      <td>${fmtPct(r.up12)}</td>
      <td>${fmtSigned(r.avg12)}</td>
      <td>${fmtSigned(r.median12)}</td>
    </tr>`).join("");
  host.innerHTML = `
    <table class="info-table">
      <thead><tr>
        <th>訊號</th><th>次數</th><th>次1週收漲率</th><th>次4週收漲率</th><th>次12週收漲率</th>
        <th>avg 12週報酬</th><th>median 12週報酬</th>
      </tr></thead>
      <tbody>${trs}</tbody>
    </table>`;
}

// ── 主圖渲染 ───────────────────────────────────────────────────────
function render(weeks, sig) {
  if (!chart) return;
  const t = TICKERS.find(x => x.key === ticker);
  const axisClr = PALETTE.muted;
  const gridClr = PALETTE.grid;
  const tipBg   = PALETTE.bg;
  const tipBdr  = PALETTE.border;
  const textClr = PALETTE.text2;

  const dates = weeks.map(w => w.weekStart);
  const candle = weeks.map(w => [w.open, w.close, w.low, w.high]);

  const birPoints = [];
  const td9Points = [];
  const confPoints = [];
  const dualOsAreas = [];
  let areaStart = null;
  for (let i = 0; i < weeks.length; i++) {
    if (sig.bir[i]) birPoints.push({ coord: [dates[i], weeks[i].low], symbol: "triangle", symbolSize: 10,
      itemStyle: { color: "#3fb950" }, label: { show: false } });
    if (sig.td9[i]) td9Points.push({ coord: [dates[i], weeks[i].high], symbol: "circle", symbolSize: 16,
      itemStyle: { color: "#e3b341" }, label: { show: true, formatter: "9", color: "#1f2328", fontSize: 10, fontWeight: "bold" } });
    if (sig.confluence[i] >= 2) {
      const strong = sig.confluence[i] >= 3;
      confPoints.push({ coord: [dates[i], weeks[i].high], symbol: "pin", symbolSize: strong ? 30 : 22,
        itemStyle: { color: strong ? "#f85149" : "#d2a8ff" },
        label: { show: true, formatter: String(sig.confluence[i]), color: "#fff", fontSize: 10 } });
    }
    const dualOs = sig.kdOS[i] && sig.rsiOS[i];
    if (dualOs && areaStart == null) areaStart = dates[i];
    if (!dualOs && areaStart != null) { dualOsAreas.push([{ xAxis: areaStart }, { xAxis: dates[i - 1] }]); areaStart = null; }
  }
  if (areaStart != null) dualOsAreas.push([{ xAxis: areaStart }, { xAxis: dates[dates.length - 1] }]);

  const status = document.getElementById("wkrev-status");
  if (status) {
    const lastPartial = weeks.length && weeks[weeks.length - 1].partial;
    status.textContent = `${t.label} · ${weeks.length} 根週K${lastPartial ? "（最後一根當週未走完，已排除統計）" : ""} · BIR ${sig.bir.filter(Boolean).length} 次 · TD9 ${sig.td9.filter(Boolean).length} 次 · confluence≥2 ${sig.confluence.filter(c => c >= 2).length} 週`;
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
        let html = `<div style="font-weight:600;margin-bottom:4px">${dates[i]}${weeks[i].partial ? "（未走完）" : ""}</div>`;
        html += `<div>開 ${o.toFixed(1)}　高 ${h.toFixed(1)}　低 ${l.toFixed(1)}　收 ${c.toFixed(1)}</div>`;
        if (sig.kArr[i] != null) html += `<div>KD: K ${sig.kArr[i].toFixed(1)} / D ${sig.dArr[i].toFixed(1)}</div>`;
        if (sig.rsiArr[i] != null) html += `<div>RSI: ${sig.rsiArr[i].toFixed(1)}</div>`;
        html += `<div>Confluence: ${sig.confluence[i]}</div>`;
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
        markPoint: { silent: false, data: [...birPoints, ...td9Points, ...confPoints] },
        markArea: { silent: true, itemStyle: { color: tc("rgba(88,166,255,0.10)", "rgba(88,166,255,0.14)") }, data: dualOsAreas },
      },
    ],
  }, { notMerge: true });
}

// ── controls ───────────────────────────────────────────────────────
function buildControls() {
  const host = document.getElementById("wkrev-ticker-picker");
  if (!host || host.dataset.built) return;
  host.innerHTML = TICKERS.map(t =>
    `<span class="chip${t.key === ticker ? " active" : ""}" data-wkrev-ticker="${t.key}">${t.label}</span>`).join("");
  host.dataset.built = "1";
  host.querySelectorAll(".chip").forEach(c => c.addEventListener("click", () => {
    host.querySelectorAll(".chip").forEach(e => e.classList.remove("active"));
    c.classList.add("active");
    ticker = c.dataset.wkrevTicker;
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
  const weeks = toWeeklyOHLC(daily);
  const sig = computeSignals(weeks);
  cache[key] = { weeks, sig };
  return cache[key];
}

async function refresh() {
  const status = document.getElementById("wkrev-status");
  try {
    const { weeks, sig } = await loadTicker(ticker);
    render(weeks, sig);
    renderTable(buildWinRateRows(weeks, sig));
  } catch (e) {
    if (status) status.textContent = `載入失敗：${e.message}`;
  }
}

// ── lifecycle ──────────────────────────────────────────────────────
export async function activate() {
  const host = document.getElementById("wkrev-chart");
  if (!host) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : "dark");
  buildControls();
  await refresh();
}
export function onThemeChange(light) {
  if (!chart) return;
  chart.dispose();
  chart = echarts.init(document.getElementById("wkrev-chart"), light ? null : "dark");
  if (cache[ticker]) render(cache[ticker].weeks, cache[ticker].sig);
}
export function resize() { chart?.resize(); }
