// 金融狀況指數 tab — 美國 Chicago Fed National Financial Conditions Index (NFCI)
//   上 grid: NFCI 總分 + MA4/13/52（週）+ 零軸；可疊 S&P 500（log 右軸）；可疊 ANFCI（同軸虛線）
//   下 grid: 三大細項獨立線（風險/信用/槓桿，不堆疊 —— 這三條各自獨立 renormalize，不加總=總分）
//
// 資料 data/nfci.json（fetch_nfci.py 抓 FRED NFCI/ANFCI/NFCIRISK/NFCICREDIT/NFCILEVERAGE，
// 每週五 1971+，免 key）。MA 全前端 rolling 計算。0＝各變量在歷史均值；>0 財務條件偏緊、<0 偏鬆
// （含資產泡沫堆積期的「過度寬鬆」，這是跟「金融壓力」FSI tab 最大的不同 —— FSI 只在市場失序時
// 才偏離 0，是同步壓力指標；NFCI 涵蓋整個鬆緊光譜）。定位「環境理解」非交易訊號。

import { isLight, tc, mob, PALETTE } from '../utils/theme.js';

const COMPS = [
  { key: "risk",     name: "風險",  color: "#f85149" },
  { key: "credit",   name: "信用",  color: "#e3b341" },
  { key: "leverage", name: "槓桿",  color: "#58a6ff" },
];
const PERIODS  = [4, 13, 52];
const MA_COLOR = { 4: "#58a6ff", 13: "#e3b341", 52: "#f85149" };
const MA_NAME  = { 4: "MA4", 13: "MA13", 52: "MA52" };
const SP_COLOR   = "#f778ba";
const ANFCI_COLOR = "#d2a8ff";

let nfciChart = null;
let nfciRange = "10Y";
let showSP     = true;
let showANFCI  = false;
let rows       = null;   // [{date, nfci, anfci, risk, credit, leverage, ma4, ma13, ma52}]
let sp         = null;   // [[date, close]]

// ── load + compute MA (rolling mean of the headline NFCI) ─────────────
async function loadAll() {
  if (rows) return;
  const fetchJson = async (path, optional = false) => {
    try {
      const r = await fetch(path, { cache: "no-cache" });
      if (!r.ok) { if (optional) return null; throw new Error(`${path}: HTTP ${r.status}`); }
      return await r.json();
    } catch (e) { if (optional) return null; throw e; }
  };
  const [nfciJson, spJson] = await Promise.all([
    fetchJson("data/nfci.json"),
    fetchJson("data/SP500.json", true),
  ]);
  rows = (nfciJson?.data ?? []).map(r => ({ ...r }));
  computeMA(rows);
  sp = (spJson?.data ?? []).map(r => [r.date, r.close]);
}

function computeMA(rs) {
  const n = rs.length;
  for (const p of PERIODS) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += rs[i].nfci;
      if (i >= p) sum -= rs[i - p].nfci;
      if (i >= p - 1) rs[i][`ma${p}`] = sum / p;
    }
  }
}

function rangeCutoff(key) {
  if (key === "MAX") return "0000-00-00";
  const d = new Date();
  ({ "1Y": 1, "3Y": 3, "5Y": 5, "10Y": 10 }[key] || 10) &&
    d.setFullYear(d.getFullYear() - ({ "1Y": 1, "3Y": 3, "5Y": 5, "10Y": 10 }[key] || 10));
  return d.toISOString().slice(0, 10);
}

// ── readout cards ────────────────────────────────────────────────────
function setText(id, txt, color) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = txt;
  if (color) el.style.color = color;
}

function updateCards() {
  const last = rows[rows.length - 1];
  // 1. level
  let lSig, lClr;
  if      (last.nfci >= 1.0)  { lSig = "明顯緊縮 · 金融條件明顯收緊"; lClr = "#f85149"; }
  else if (last.nfci >= 0)    { lSig = "略緊 · 高於長期均值";        lClr = "#f0883e"; }
  else if (last.nfci >= -0.5) { lSig = "略鬆 · 低於長期均值";        lClr = "#3fb950"; }
  else                        { lSig = "明顯寬鬆 · 資金環境寬鬆";     lClr = "#3fb950"; }
  setText("nfci-level-val", (last.nfci >= 0 ? "+" : "") + last.nfci.toFixed(2), PALETTE.text);
  setText("nfci-level-sub", `${last.date}｜0＝歷史均值`, "var(--muted)");
  setText("nfci-level-signal", lSig, lClr);

  // 2. trend — NFCI vs MA13 + MA4/MA13 cross
  const above13 = last.ma13 != null && last.nfci > last.ma13;
  const cross   = last.ma4 != null && last.ma13 != null
    ? (last.ma4 > last.ma13 ? "MA4 在 MA13 之上" : "MA4 在 MA13 之下") : "—";
  let tVal, tSig, tClr;
  if (last.ma13 == null) { tVal = "—"; tSig = "—"; tClr = "var(--muted)"; }
  else if (above13)      { tVal = "▲ 緊縮中"; tSig = `高於季均（${cross}）`; tClr = "#f0883e"; }
  else                    { tVal = "▼ 寬鬆中"; tSig = `低於季均（${cross}）`; tClr = "#3fb950"; }
  setText("nfci-trend-val", tVal, tClr);
  setText("nfci-trend-sub", last.ma13 != null ? `MA13 ${last.ma13.toFixed(2)}｜MA52 ${last.ma52?.toFixed(2) ?? "—"}` : "—", "var(--muted)");
  setText("nfci-trend-signal", tSig, tClr);

  // 3. top driver — largest of the three subindexes (or least-negative)
  const drv = COMPS.map(c => ({ name: c.name, v: last[c.key], color: c.color }))
                   .sort((a, b) => b.v - a.v);
  const top = drv[0];
  setText("nfci-driver-val", top.name, top.color);
  setText("nfci-driver-sub", `貢獻 ${top.v >= 0 ? "+" : ""}${top.v.toFixed(2)}｜最低 ${drv[drv.length - 1].name} ${drv[drv.length - 1].v.toFixed(2)}`, "var(--muted)");
  setText("nfci-driver-signal", top.v >= 0 ? "目前最大緊縮來源" : "各面向均低於均值", top.v >= 0 ? "#f0883e" : "#3fb950");
}

// ── render ───────────────────────────────────────────────────────────
export function render() {
  if (!nfciChart || !rows) return;
  const axisClr = PALETTE.muted;
  const gridClr = tc("rgba(48,54,61,0.5)", "rgba(208,215,222,0.4)");
  const tipBg   = PALETTE.bg;
  const tipBdr  = PALETTE.border;
  const textClr = PALETTE.text2;

  updateCards();

  const cutoff = rangeCutoff(nfciRange);
  const view   = rows.filter(r => r.date >= cutoff);
  const dates  = view.map(r => r.date);
  const nfciLine  = view.map(r => +r.nfci.toFixed(3));
  const anfciLine = view.map(r => +r.anfci.toFixed(3));
  const maData  = Object.fromEntries(PERIODS.map(p =>
                    [p, view.map(r => r[`ma${p}`] != null ? +r[`ma${p}`].toFixed(3) : null)]));
  const compData = Object.fromEntries(COMPS.map(c =>
                    [c.key, view.map(r => +r[c.key].toFixed(3))]));

  // S&P overlay aligned to NFCI dates (weekly vs daily; both keyed by exact date string)
  let spData = null;
  if (showSP && sp?.length) {
    const m = new Map(sp);
    spData = dates.map(d => (m.has(d) ? +m.get(d).toFixed(2) : null));
  }

  const status = document.getElementById("nfci-status");
  if (status) status.textContent =
    `Chicago Fed 金融狀況指數 · ${dates.length} 週（${nfciRange}）· 總分＋MA4/13/52週均線 · 來源 FRED NFCI`;

  const L = mob() ? 40 : 52, R = showSP ? (mob() ? 46 : 60) : (mob() ? 16 : 28);
  // two stacked grids, each with its OWN legend directly above it (總分+均線 上 / 細項 下)
  const grid = [
    { left: L, right: R, top: "9%",  height: mob() ? "36%" : "39%" },
    { left: L, right: R, top: "63%", height: mob() ? "23%" : "25%" },
  ];
  const xAxis = grid.map((_, i) => ({
    gridIndex: i, type: "category", data: dates, boundaryGap: false,
    axisLine: { lineStyle: { color: axisClr } }, axisTick: { show: false },
    axisLabel: { show: i === 1, color: axisClr, fontSize: 11 },
    splitLine: { show: false },
  }));

  const yAxis = [
    { gridIndex: 0, scale: true, name: "NFCI", nameTextStyle: { color: axisClr, fontSize: 10 },
      axisLabel: { color: axisClr, fontSize: 11 }, axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: gridClr } } },
  ];
  let spAxisIdx = -1;
  if (showSP && spData) {
    spAxisIdx = yAxis.length;
    yAxis.push({ gridIndex: 0, type: "log", scale: true, position: "right",
      name: "S&P500", nameTextStyle: { color: SP_COLOR, fontSize: 10 },
      axisLine: { lineStyle: { color: SP_COLOR } },
      axisLabel: { color: SP_COLOR, fontSize: 10, formatter: v => v >= 1000 ? (v / 1000).toFixed(0) + "K" : v },
      splitLine: { show: false } });
  }
  const compAxisIdx = yAxis.length;
  yAxis.push({ gridIndex: 1, scale: true, name: "細項", nameTextStyle: { color: axisClr, fontSize: 10 },
    axisLabel: { color: axisClr, fontSize: 10 }, axisLine: { show: false }, axisTick: { show: false },
    splitLine: { lineStyle: { color: gridClr } },
    markLine: { silent: true, symbol: "none",
      data: [{ yAxis: 0, lineStyle: { color: axisClr, type: "solid", width: 1, opacity: 0.4 } }] } });

  // top grid markLines: zero baseline + tightening zone
  const zeroMark = {
    silent: true, symbol: "none",
    data: [
      { yAxis: 0, lineStyle: { color: axisClr, type: "solid", width: 1, opacity: 0.5 },
        label: { formatter: "0 歷史均值", color: axisClr, fontSize: 10, position: "insideEndTop" } },
      { yAxis: 1, lineStyle: { color: "#f85149", type: "dashed", width: 1, opacity: 0.5 },
        label: { formatter: "明顯緊縮", color: "#f85149", fontSize: 9, position: "insideEndTop" } },
    ],
  };

  const maSeries = PERIODS.map(p => ({
    name: MA_NAME[p], type: "line", xAxisIndex: 0, yAxisIndex: 0, data: maData[p],
    symbol: "none", smooth: false, z: 3, itemStyle: { color: MA_COLOR[p] },
    lineStyle: { color: MA_COLOR[p], width: 1.2, opacity: 0.85 },
  }));

  // 細項：三條獨立線（不堆疊）——各自獨立 renormalize，不加總=總分，只看相對走勢
  const compSeries = COMPS.map(c => ({
    name: c.name, type: "line", xAxisIndex: 1, yAxisIndex: compAxisIdx,
    data: compData[c.key], symbol: "none", smooth: false, connectNulls: true,
    itemStyle: { color: c.color }, lineStyle: { color: c.color, width: 1.3 },
    emphasis: { focus: "series" },
  }));

  const nfciColor = PALETTE.text;
  const series = [
    { name: "NFCI 總分", type: "line", xAxisIndex: 0, yAxisIndex: 0, data: nfciLine,
      symbol: "none", smooth: false, z: 5, itemStyle: { color: nfciColor },
      lineStyle: { color: nfciColor, width: 1.8 },
      markLine: zeroMark },
    ...maSeries,
    ...compSeries,
  ];
  if (showANFCI) {
    series.splice(1, 0, { name: "ANFCI", type: "line", xAxisIndex: 0, yAxisIndex: 0, data: anfciLine,
      symbol: "none", smooth: false, z: 4, itemStyle: { color: ANFCI_COLOR },
      lineStyle: { color: ANFCI_COLOR, width: 1.4, type: "dashed" } });
  }
  if (showSP && spData) {
    series.splice(1, 0, { name: "S&P 500", type: "line", xAxisIndex: 0, yAxisIndex: spAxisIdx,
      data: spData, symbol: "none", smooth: false, z: 2, connectNulls: true,
      itemStyle: { color: SP_COLOR },
      lineStyle: { color: SP_COLOR, width: 1.3, opacity: 0.8 } });
  }

  const topLegend  = ["NFCI 總分", ...(showANFCI ? ["ANFCI"] : []), ...(showSP ? ["S&P 500"] : []), ...PERIODS.map(p => MA_NAME[p])];
  const compLegend = COMPS.map(c => c.name);

  nfciChart.setOption({
    backgroundColor: "transparent", animation: false,
    tooltip: {
      trigger: "axis", axisPointer: { type: "cross", link: [{ xAxisIndex: "all" }] },
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        const d = params[0]?.axisValue ?? "";
        let html = `<div style="font-weight:600;margin-bottom:4px">${d}</div>`;
        for (const p of params) {
          if (p.value == null) continue;
          const v = p.seriesName === "S&P 500" ? (+p.value).toFixed(0) : (+p.value).toFixed(2);
          html += `<div>${p.marker}${p.seriesName}: <b>${v}</b></div>`;
        }
        return html;
      },
    },
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    grid, xAxis, yAxis,
    dataZoom: [{ type: "inside", xAxisIndex: [0, 1], filterMode: "none" }],
    legend: [
      { data: topLegend,  top: 2,     left: "center", textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr },
      { data: compLegend, top: "53%", left: "center", textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr },
    ],
    series,
  }, { notMerge: true });
}

// ── controls ─────────────────────────────────────────────────────────
function buildControls() {
  const rp = document.getElementById("nfci-range-picker");
  if (rp && !rp.dataset.built) {
    rp.dataset.built = "1";
    rp.addEventListener("click", e => {
      const t = e.target.closest(".chip[data-nfci-range]");
      if (!t) return;
      nfciRange = t.dataset.nfciRange;
      rp.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c === t));
      render();
    });
  }
  const sb = document.getElementById("nfci-sp-toggle");
  if (sb && !sb.dataset.built) {
    sb.dataset.built = "1";
    sb.addEventListener("click", () => {
      showSP = !showSP;
      sb.classList.toggle("active", showSP);
      render();
    });
  }
  const ab = document.getElementById("nfci-anfci-toggle");
  if (ab && !ab.dataset.built) {
    ab.dataset.built = "1";
    ab.addEventListener("click", () => {
      showANFCI = !showANFCI;
      ab.classList.toggle("active", showANFCI);
      render();
    });
  }
}

// ── lifecycle ────────────────────────────────────────────────────────
export async function activate() {
  const host = document.getElementById("nfci-chart");
  if (!host) return;
  if (!nfciChart) nfciChart = echarts.init(host, isLight() ? null : "dark");
  buildControls();
  try {
    await loadAll();
    setTimeout(() => { nfciChart?.resize(); render(); }, 50);
  } catch (e) {
    const s = document.getElementById("nfci-status");
    if (s) s.textContent = "載入失敗：" + (e.message || e);
    console.error("[nfci] load failed", e);
  }
}
export function onThemeChange(light) {
  if (!nfciChart) return;
  nfciChart.dispose();
  nfciChart = echarts.init(document.getElementById("nfci-chart"), light ? null : "dark");
  if (rows) render();
}
export function resize() { nfciChart?.resize(); }
