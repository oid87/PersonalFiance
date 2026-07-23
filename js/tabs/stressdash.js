// 壓力總覽 tab — 金融壓力/狀況三指標 × SPY/QQQ/SOXX 週K 疊圖
//   上 grid：選定標的週K蠟燭 + NFCI 折線（副軸）+ NFCI MA20/MA50（預設隱藏）+ NFCI 正/負背景色帶
//   下 grid：NFCI + STLFSI4（週頻）+ KCFSI（月頻）三條原始線 + 各自 20MA（預設隱藏）
//
// 資料：data/nfci.json（既有，週五 1971+）+ data/stlfsi_kcfsi.json（新增，週頻+月頻聯集，
// 兩欄位互斥、皆可能 null）。SPY/QQQ/SOXX 週K 皆由既有 SERIES registry 觸發載入，本檔不新抓。
//
// 對齊：NFCI/STLFSI4 皆用 lookupLE（backward，取「該日期當下或之前最新一筆」，不用未來值）
// 對齊到週K 日期骨架 —— 不用 Map 精確字串比對（NFCI 週五 vs 週K 收盤日在假日週會對不上、
// Map 比對會靜默漏值）。
//
// 與原始 Python 版 spec 的刻意差異：
//   1) 3 組並排（SPY/QQQ/SOXX 各自 2-panel）→ 單組 + ticker 切換 chip：這裡是活的多 tab
//      儀表板，3 組堆疊會過長，改比照 pentagram.js 的單一 chart + chip 切換慣例。
//   2) ANFCI 只抓不畫（跟獨立 Python 版工具一致）：下圖維持 NFCI/STLFSI4/KCFSI 三條，
//      不加 ANFCI，避免超出原始逐字規格。
//
// 定位「環境理解」非交易訊號。

import { loadedHLC } from '../state.js';
import { ensureLoaded, fetchJSON } from '../utils/data.js';
import { isLight, tc, mob, PALETTE } from '../utils/theme.js';
import { cutoffDate, toWeeklyHLC, lookupLE } from '../utils/dates.js';
import { computeMA } from '../utils/math.js';

const TICKERS = ["SPY", "QQQ", "SOXX"];
const NFCI_COLOR    = "#d2a8ff";
const NFCI_MA_COLOR = { 20: "#58a6ff", 50: "#f85149" };
const STLFSI_COLOR  = "#e3b341";
const KCFSI_COLOR   = "#2dd4bf";
const CANDLE_UP   = "#3fb950";
const CANDLE_DOWN = "#f85149";

let chart      = null;
let ticker     = "SPY";
let range      = "3Y";

// ── module-level data state ────────────────────────────────────────────
let nfciAnfci    = null;  // raw data/nfci.json rows [{date, nfci, anfci, risk, credit, leverage}]
let stlfsiKcfsi  = null;  // raw data/stlfsi_kcfsi.json rows [{date, stlfsi4, kcfsi}]

let nfciPairs     = null; // [date, nfci][] full history, ascending
let nfciMA20Pairs = null;
let nfciMA50Pairs = null;
let stlfsiPairs     = null; // [date, stlfsi4][] non-null only, ascending
let stlfsiMA20Pairs = null;
let kcfsiPairs       = null; // [date, kcfsi][] non-null only, ascending
let kcfsiMA20Pairs   = null;

const weeklyCache = {}; // ticker -> [[date, open, high, low, close], ...] (derived from toWeeklyHLC)

// ── load ─────────────────────────────────────────────────────────────
async function loadAll() {
  if (nfciAnfci) return;
  const [nfciRows, stressRows] = await Promise.all([
    fetchJSON("data/nfci.json"),
    fetchJSON("data/stlfsi_kcfsi.json"),
  ]);
  nfciAnfci   = nfciRows ?? [];
  stlfsiKcfsi = stressRows ?? [];

  nfciPairs     = nfciAnfci.map(r => [r.date, r.nfci]);
  nfciMA20Pairs = computeMA(nfciPairs, 20);
  nfciMA50Pairs = computeMA(nfciPairs, 50);

  stlfsiPairs     = stlfsiKcfsi.filter(r => r.stlfsi4 != null).map(r => [r.date, r.stlfsi4]);
  stlfsiMA20Pairs = computeMA(stlfsiPairs, 20);

  kcfsiPairs     = stlfsiKcfsi.filter(r => r.kcfsi != null).map(r => [r.date, r.kcfsi]);
  kcfsiMA20Pairs = computeMA(kcfsiPairs, 20);

  await Promise.all(TICKERS.map(k => ensureLoaded(k)));
}

// toWeeklyHLC only carries [date, high, low, close] — no open (loadedHLC never
// stores open; wkrev.js's own weekly resampler is the only place open survives,
// via its own dedicated fetch). For a candlestick body we approximate weekly
// open as the previous week's close (no-gap convention); the very first week
// uses its own close. High/low are widened if needed so open/close never fall
// outside the recorded high/low band.
function getWeeklyCandles(tkr) {
  if (!weeklyCache[tkr]) {
    const hlc = loadedHLC[tkr] || [];
    const wk = toWeeklyHLC(hlc); // [[date, high, low, close], ...]
    const out = [];
    let prevClose = null;
    for (const [date, high, low, close] of wk) {
      const open = prevClose == null ? close : prevClose;
      out.push([date, open, Math.max(high, open, close), Math.min(low, open, close), close]);
      prevClose = close;
    }
    weeklyCache[tkr] = out; // [date, open, high, low, close][]
  }
  return weeklyCache[tkr];
}

// ── readout cards ────────────────────────────────────────────────────
function setText(id, txt, color) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = txt;
  if (color) el.style.color = color;
}

function levelSignal(v) {
  if (v == null) return { sig: "—", clr: "var(--muted)" };
  if (v >= 1.0)   return { sig: "明顯緊縮 · 壓力偏高",  clr: "#f85149" };
  if (v >= 0)     return { sig: "略緊 · 高於歷史均值",   clr: "#f0883e" };
  if (v >= -0.5)  return { sig: "略鬆 · 低於歷史均值",   clr: "#3fb950" };
  return                 { sig: "明顯寬鬆 · 壓力偏低",   clr: "#3fb950" };
}

function updateCards() {
  const lastNfci   = nfciPairs[nfciPairs.length - 1];
  const lastNfciMA = nfciMA20Pairs[nfciMA20Pairs.length - 1];
  const nSig = levelSignal(lastNfci[1]);
  setText("stressdash-nfci-val", (lastNfci[1] >= 0 ? "+" : "") + lastNfci[1].toFixed(2), PALETTE.text);
  setText("stressdash-nfci-sub", `${lastNfci[0]}｜0＝歷史均值`, "var(--muted)");
  setText("stressdash-nfci-signal",
    lastNfciMA ? (lastNfci[1] > lastNfciMA[1] ? `▲ 高於 MA20（${lastNfciMA[1].toFixed(2)}）· ${nSig.sig}` : `▼ 低於 MA20（${lastNfciMA[1].toFixed(2)}）· ${nSig.sig}`)
               : nSig.sig,
    nSig.clr);

  const lastStl   = stlfsiPairs[stlfsiPairs.length - 1];
  const lastStlMA = stlfsiMA20Pairs[stlfsiMA20Pairs.length - 1];
  const sSig = levelSignal(lastStl?.[1]);
  setText("stressdash-stlfsi-val", lastStl ? (lastStl[1] >= 0 ? "+" : "") + lastStl[1].toFixed(2) : "—", PALETTE.text);
  setText("stressdash-stlfsi-sub", lastStl ? `${lastStl[0]}｜週頻` : "—", "var(--muted)");
  setText("stressdash-stlfsi-signal",
    lastStl && lastStlMA ? (lastStl[1] > lastStlMA[1] ? `▲ 高於 MA20（${lastStlMA[1].toFixed(2)}）· ${sSig.sig}` : `▼ 低於 MA20（${lastStlMA[1].toFixed(2)}）· ${sSig.sig}`)
                         : sSig.sig,
    sSig.clr);

  const lastKc   = kcfsiPairs[kcfsiPairs.length - 1];
  const lastKcMA = kcfsiMA20Pairs[kcfsiMA20Pairs.length - 1];
  const kSig = levelSignal(lastKc?.[1]);
  setText("stressdash-kcfsi-val", lastKc ? (lastKc[1] >= 0 ? "+" : "") + lastKc[1].toFixed(2) : "—", PALETTE.text);
  setText("stressdash-kcfsi-sub", lastKc ? `${lastKc[0]}｜月頻` : "—", "var(--muted)");
  setText("stressdash-kcfsi-signal",
    lastKc && lastKcMA ? (lastKc[1] > lastKcMA[1] ? `▲ 高於 MA20（${lastKcMA[1].toFixed(2)}）· ${kSig.sig}` : `▼ 低於 MA20（${lastKcMA[1].toFixed(2)}）· ${kSig.sig}`)
                       : kSig.sig,
    kSig.clr);
}

// ── summary table ────────────────────────────────────────────────────
function renderTable() {
  const host = document.getElementById("stressdash-table");
  if (!host) return;
  const spyWeekly = getWeeklyCandles("SPY");
  const qqqWeekly = getWeeklyCandles("QQQ");
  const soxxWeekly = getWeeklyCandles("SOXX");
  if (!spyWeekly.length) { host.innerHTML = "<p style='color:var(--muted);font-size:12px'>無資料</p>"; return; }

  const spyClose  = spyWeekly.map(w => [w[0], w[4]]);
  const qqqClose  = qqqWeekly.map(w => [w[0], w[4]]);
  const soxxClose = soxxWeekly.map(w => [w[0], w[4]]);

  const last12 = spyWeekly.slice(-12);
  const ret4w = (closePairs, idx) => {
    if (idx < 4) return null;
    const now = closePairs[idx][1], then = closePairs[idx - 4][1];
    return then ? (now / then - 1) * 100 : null;
  };

  const rows = last12.map(w => {
    const d = w[0];
    const iSpy = spyClose.findIndex(r => r[0] === d);
    const nfciHit = lookupLE(nfciPairs, d);
    const nfciMAHit = lookupLE(nfciMA20Pairs, d);
    const stlHit = lookupLE(stlfsiPairs, d);
    const spyRet  = ret4w(spyClose, iSpy);
    const qqqIdx  = qqqClose.findIndex(r => r[0] === d);
    const soxxIdx = soxxClose.findIndex(r => r[0] === d);
    const qqqRet  = ret4w(qqqClose, qqqIdx);
    const soxxRet = ret4w(soxxClose, soxxIdx);
    return {
      date: d,
      nfci: nfciHit ? nfciHit[1] : null,
      stlfsi: stlHit ? stlHit[1] : null,
      nfciMA20: nfciMAHit ? nfciMAHit[1] : null,
      spyRet, qqqRet, soxxRet,
    };
  });

  const fmt = v => v == null ? "—" : (v >= 0 ? "+" : "") + v.toFixed(2);
  const fmtPct = v => v == null ? "—" : (v >= 0 ? "+" : "") + v.toFixed(1) + "%";
  const nfciBg = v => v == null ? "" : v >= 0 ? "rgba(248,81,73,0.12)" : "rgba(63,185,80,0.12)";
  const retClr = v => v == null ? "var(--muted)" : v >= 0 ? "#3fb950" : "#f85149";

  host.innerHTML = `
    <div style="color:var(--muted);font-size:12px;margin-bottom:4px">最近 12 週（以 SPY 週K 骨架為準,NFCI/STLFSI 用 backward lookup 對齊,不用未來值）</div>
    <table class="info-table">
      <thead><tr><th>日期</th><th>NFCI</th><th>STLFSI4</th><th>NFCI_20MA</th><th>SPY 4週報酬</th><th>QQQ 4週報酬</th><th>SOXX 4週報酬</th></tr></thead>
      <tbody>
        ${rows.map(r => `<tr>
          <td>${r.date}</td>
          <td style="background:${nfciBg(r.nfci)}">${fmt(r.nfci)}</td>
          <td>${fmt(r.stlfsi)}</td>
          <td>${fmt(r.nfciMA20)}</td>
          <td style="color:${retClr(r.spyRet)}">${fmtPct(r.spyRet)}</td>
          <td style="color:${retClr(r.qqqRet)}">${fmtPct(r.qqqRet)}</td>
          <td style="color:${retClr(r.soxxRet)}">${fmtPct(r.soxxRet)}</td>
        </tr>`).join("")}
      </tbody>
    </table>`;
}

// ── render ───────────────────────────────────────────────────────────
export function render() {
  if (!chart || !nfciAnfci) return;
  const axisClr = PALETTE.muted;
  const gridClr = tc("rgba(48,54,61,0.5)", "rgba(208,215,222,0.4)");
  const tipBg   = PALETTE.bg;
  const tipBdr  = PALETTE.border;
  const textClr = PALETTE.text2;

  updateCards();
  renderTable();

  const cut = cutoffDate(range);

  // ── panel 1: ticker weekly candlestick + NFCI overlay ────────────
  const weekly = getWeeklyCandles(ticker).filter(w => w[0] >= cut);
  const dates1 = weekly.map(w => w[0]);
  const candle = weekly.map(w => [w[1], w[4], w[3], w[2]]); // [open, close, low, high]

  const nfciAligned1 = dates1.map(d => { const h = lookupLE(nfciPairs, d); return h ? +h[1].toFixed(3) : null; });
  const nfciMA20Aligned1 = dates1.map(d => { const h = lookupLE(nfciMA20Pairs, d); return h ? +h[1].toFixed(3) : null; });
  const nfciMA50Aligned1 = dates1.map(d => { const h = lookupLE(nfciMA50Pairs, d); return h ? +h[1].toFixed(3) : null; });

  // NFCI 正/負背景色帶 —— 掃描連續分段（比照 yield_curve.js 的倒掛區間演算法）
  const posAreas = [], negAreas = [];
  let posStart = null, negStart = null;
  for (let i = 0; i < dates1.length; i++) {
    const v = nfciAligned1[i];
    const isPos = v != null && v >= 0;
    const isNeg = v != null && v < 0;
    if (isPos && posStart === null) posStart = dates1[i];
    if (!isPos && posStart !== null) { posAreas.push([{ xAxis: posStart }, { xAxis: dates1[i - 1] }]); posStart = null; }
    if (isNeg && negStart === null) negStart = dates1[i];
    if (!isNeg && negStart !== null) { negAreas.push([{ xAxis: negStart }, { xAxis: dates1[i - 1] }]); negStart = null; }
  }
  if (posStart !== null) posAreas.push([{ xAxis: posStart }, { xAxis: dates1[dates1.length - 1] }]);
  if (negStart !== null) negAreas.push([{ xAxis: negStart }, { xAxis: dates1[dates1.length - 1] }]);

  // ── panel 2: NFCI + STLFSI4 + KCFSI raw lines, each on its own native dates ──
  const nfciView2   = nfciPairs.filter(r => r[0] >= cut).map(r => [r[0], +r[1].toFixed(3)]);
  const nfciMA20View2 = nfciMA20Pairs.filter(r => r[0] >= cut).map(r => [r[0], +r[1].toFixed(3)]);
  const stlfsiView2 = stlfsiPairs.filter(r => r[0] >= cut).map(r => [r[0], +r[1].toFixed(3)]);
  const stlfsiMA20View2 = stlfsiMA20Pairs.filter(r => r[0] >= cut).map(r => [r[0], +r[1].toFixed(3)]);
  const kcfsiView2 = kcfsiPairs.filter(r => r[0] >= cut).map(r => [r[0], +r[1].toFixed(3)]);
  const kcfsiMA20View2 = kcfsiMA20Pairs.filter(r => r[0] >= cut).map(r => [r[0], +r[1].toFixed(3)]);

  const status = document.getElementById("stressdash-status");
  if (status) status.textContent =
    `${ticker} 週K × NFCI/STLFSI4/KCFSI · ${dates1.length} 週（${range}）· 來源 FRED NFCI/STLFSI4/KCFSI`;

  const L = mob() ? 40 : 52, R = mob() ? 46 : 60;
  const grid = [
    { left: L, right: R, top: "9%",  height: mob() ? "36%" : "39%" },
    { left: L, right: R, top: "63%", height: mob() ? "23%" : "25%" },
  ];
  const xAxis = [
    { gridIndex: 0, type: "category", data: dates1, boundaryGap: true,
      axisLine: { lineStyle: { color: axisClr } }, axisTick: { show: false },
      axisLabel: { show: false }, splitLine: { show: false } },
    { gridIndex: 1, type: "time", boundaryGap: false,
      axisLine: { lineStyle: { color: axisClr } }, axisTick: { show: false },
      axisLabel: { color: axisClr, fontSize: 11 }, splitLine: { show: false } },
  ];
  const yAxis = [
    { gridIndex: 0, scale: true, name: ticker, nameTextStyle: { color: axisClr, fontSize: 10 },
      axisLabel: { color: axisClr, fontSize: 11 }, axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: gridClr } } },
    { gridIndex: 0, scale: true, position: "right", name: "NFCI",
      nameTextStyle: { color: NFCI_COLOR, fontSize: 10 },
      axisLabel: { color: NFCI_COLOR, fontSize: 10 },
      axisLine: { lineStyle: { color: NFCI_COLOR } }, splitLine: { show: false } },
    { gridIndex: 1, scale: true, name: "壓力指數", nameTextStyle: { color: axisClr, fontSize: 10 },
      axisLabel: { color: axisClr, fontSize: 10 }, axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: gridClr } } },
  ];

  const zeroMarkPanel1 = {
    silent: true, symbol: "none",
    data: [{ yAxis: 0, xAxisIndex: 1, lineStyle: { color: NFCI_COLOR, type: "dashed", width: 1, opacity: 0.5 },
      label: { formatter: "NFCI=0", color: NFCI_COLOR, fontSize: 9, position: "insideEndTop" } }],
  };
  const zeroMarkPanel2 = {
    silent: true, symbol: "none",
    data: [{ yAxis: 0, lineStyle: { color: axisClr, type: "solid", width: 1, opacity: 0.5 },
      label: { formatter: "0 歷史均值", color: axisClr, fontSize: 10, position: "insideEndTop" } }],
  };

  const series = [
    {
      name: ticker, type: "candlestick", xAxisIndex: 0, yAxisIndex: 0, data: candle,
      itemStyle: { color: CANDLE_UP, color0: CANDLE_DOWN, borderColor: CANDLE_UP, borderColor0: CANDLE_DOWN },
      z: 3,
    },
    {
      name: "NFCI", type: "line", xAxisIndex: 0, yAxisIndex: 1, data: nfciAligned1,
      symbol: "none", smooth: false, z: 5, connectNulls: true,
      itemStyle: { color: NFCI_COLOR }, lineStyle: { color: NFCI_COLOR, width: 1.6 },
      markLine: zeroMarkPanel1,
      markArea: {
        silent: true,
        data: [
          ...posAreas.map(a => [{ ...a[0], itemStyle: { color: "rgba(248,81,73,0.10)" } }, a[1]]),
          ...negAreas.map(a => [{ ...a[0], itemStyle: { color: "rgba(63,185,80,0.10)" } }, a[1]]),
        ],
      },
    },
    { name: "NFCI MA20", type: "line", xAxisIndex: 0, yAxisIndex: 1, data: nfciMA20Aligned1,
      symbol: "none", smooth: false, z: 4, connectNulls: true,
      itemStyle: { color: NFCI_MA_COLOR[20] }, lineStyle: { color: NFCI_MA_COLOR[20], width: 1.2, opacity: 0.85 } },
    { name: "NFCI MA50", type: "line", xAxisIndex: 0, yAxisIndex: 1, data: nfciMA50Aligned1,
      symbol: "none", smooth: false, z: 4, connectNulls: true,
      itemStyle: { color: NFCI_MA_COLOR[50] }, lineStyle: { color: NFCI_MA_COLOR[50], width: 1.2, opacity: 0.85 } },

    { name: "NFCI（下圖）", type: "line", xAxisIndex: 1, yAxisIndex: 2, data: nfciView2,
      symbol: "none", smooth: false, connectNulls: true, z: 5,
      itemStyle: { color: NFCI_COLOR }, lineStyle: { color: NFCI_COLOR, width: 1.4 },
      markLine: zeroMarkPanel2 },
    { name: "NFCI MA20（下圖）", type: "line", xAxisIndex: 1, yAxisIndex: 2, data: nfciMA20View2,
      symbol: "none", smooth: false, connectNulls: true, z: 4,
      itemStyle: { color: NFCI_COLOR }, lineStyle: { color: NFCI_COLOR, width: 1, opacity: 0.6, type: "dashed" } },
    { name: "STLFSI4", type: "line", xAxisIndex: 1, yAxisIndex: 2, data: stlfsiView2,
      symbol: "none", smooth: false, connectNulls: true, z: 5,
      itemStyle: { color: STLFSI_COLOR }, lineStyle: { color: STLFSI_COLOR, width: 1.4 } },
    { name: "STLFSI4 MA20", type: "line", xAxisIndex: 1, yAxisIndex: 2, data: stlfsiMA20View2,
      symbol: "none", smooth: false, connectNulls: true, z: 4,
      itemStyle: { color: STLFSI_COLOR }, lineStyle: { color: STLFSI_COLOR, width: 1, opacity: 0.6, type: "dashed" } },
    { name: "KCFSI", type: "line", xAxisIndex: 1, yAxisIndex: 2, data: kcfsiView2,
      symbol: "none", smooth: false, connectNulls: true, z: 5,
      itemStyle: { color: KCFSI_COLOR }, lineStyle: { color: KCFSI_COLOR, width: 1.4 } },
    { name: "KCFSI MA20", type: "line", xAxisIndex: 1, yAxisIndex: 2, data: kcfsiMA20View2,
      symbol: "none", smooth: false, connectNulls: true, z: 4,
      itemStyle: { color: KCFSI_COLOR }, lineStyle: { color: KCFSI_COLOR, width: 1, opacity: 0.6, type: "dashed" } },
  ];

  const topLegend = [ticker, "NFCI", "NFCI MA20", "NFCI MA50"];
  const bottomLegend = ["NFCI（下圖）", "NFCI MA20（下圖）", "STLFSI4", "STLFSI4 MA20", "KCFSI", "KCFSI MA20"];

  chart.setOption({
    backgroundColor: "transparent", animation: false,
    tooltip: {
      trigger: "axis", axisPointer: { type: "cross", link: [{ xAxisIndex: "all" }] },
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        const d = params[0]?.axisValueLabel ?? params[0]?.axisValue ?? "";
        let html = `<div style="font-weight:600;margin-bottom:4px">${d}</div>`;
        for (const p of params) {
          if (p.seriesType === "candlestick") {
            const [o, c, l, h] = p.data;
            html += `<div>${p.marker}${p.seriesName} 開${o?.toFixed?.(1)} 收${c?.toFixed?.(1)} 低${l?.toFixed?.(1)} 高${h?.toFixed?.(1)}</div>`;
            continue;
          }
          if (p.value == null || (Array.isArray(p.value) && p.value[1] == null)) continue;
          const v = Array.isArray(p.value) ? p.value[1] : p.value;
          html += `<div>${p.marker}${p.seriesName}: <b>${(+v).toFixed(2)}</b></div>`;
        }
        return html;
      },
    },
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    grid, xAxis, yAxis,
    dataZoom: [{ type: "inside", xAxisIndex: [0, 1], filterMode: "none" }],
    legend: [
      { data: topLegend, top: 2, left: "center", textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr,
        selected: { "NFCI MA20": false, "NFCI MA50": false } },
      { data: bottomLegend, top: "53%", left: "center", textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr,
        selected: { "NFCI MA20（下圖）": false, "STLFSI4 MA20": false, "KCFSI MA20": false } },
    ],
    series,
  }, { notMerge: true });
}

// ── controls ─────────────────────────────────────────────────────────
function buildControls() {
  const tp = document.getElementById("stressdash-ticker-toggle");
  if (tp && !tp.dataset.built) {
    tp.dataset.built = "1";
    tp.addEventListener("click", e => {
      const t = e.target.closest(".chip[data-stressdash-ticker]");
      if (!t) return;
      ticker = t.dataset.stressdashTicker;
      tp.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c === t));
      render();
    });
  }
  const rp = document.getElementById("stressdash-range-picker");
  if (rp && !rp.dataset.built) {
    rp.dataset.built = "1";
    rp.addEventListener("click", e => {
      const t = e.target.closest(".chip[data-stressdash-range]");
      if (!t) return;
      range = t.dataset.stressdashRange;
      rp.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c === t));
      render();
    });
  }
}

// ── lifecycle ────────────────────────────────────────────────────────
export async function activate() {
  const host = document.getElementById("stressdash-chart");
  if (!host) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : "dark");
  buildControls();
  try {
    await loadAll();
    setTimeout(() => { chart?.resize(); render(); }, 50);
  } catch (e) {
    const s = document.getElementById("stressdash-status");
    if (s) s.textContent = "載入失敗：" + (e.message || e);
    console.error("[stressdash] load failed", e);
  }
}
export function onThemeChange(light) {
  if (!chart) return;
  chart.dispose();
  chart = echarts.init(document.getElementById("stressdash-chart"), light ? null : "dark");
  if (nfciAnfci) render();
}
export function resize() { chart?.resize(); }
