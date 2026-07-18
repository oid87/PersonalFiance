// 消費者信心 tab — University of Michigan Consumer Sentiment Index (UMCSENT)
//   UMCSENT 月頻折線（左軸）+ SPY 月頻對數右軸（可關）+ NBER 衰退陰影
//   MA12 / MA24 均線（前端滾動計算）
//   資料：data/umich.json（fetch_umich.py 抓 FRED UMCSENT + USREC + yfinance SPY）

import { isLight, tc, mob, PALETTE } from '../utils/theme.js';

const CSI_COLOR  = "#e3b341";  // amber — UMCSENT line
const SPY_COLOR  = "#f778ba";  // pink — SPY
const MA12_COLOR = "#58a6ff";  // blue
const MA24_COLOR = "#f85149";  // red
const REC_COLOR  = "rgba(248,81,73,0.12)"; // recession band fill

let chart   = null;
let range   = "MAX";
let showSPY = true;
let rows    = null;  // [{date, csi, ma12, ma24}]
let recessions = null;  // [{start, end}]
let spyMap  = null;  // Map<date, close>

// ── data load ────────────────────────────────────────────────────────
async function loadAll() {
  if (rows) return;
  const r = await fetch("data/umich.json", { cache: "no-cache" });
  if (!r.ok) throw new Error(`umich.json: HTTP ${r.status}`);
  const j = await r.json();

  rows = (j.umich ?? []).map(x => ({ ...x }));
  computeMA(rows);
  recessions = j.recessions ?? [];
  spyMap = new Map((j.spy ?? []).map(x => [x.date, x.close]));
}

// check_reuse: keep — 就地 mutate 物件陣列、一次跑一整組 period 並綁死欄位名,與 canonical math.computeMA(data, period) 是不同概念
function computeMA(rs) {
  const n = rs.length;
  for (const p of [12, 24]) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += rs[i].csi;
      if (i >= p) sum -= rs[i - p].csi;
      if (i >= p - 1) rs[i][`ma${p}`] = sum / p;
    }
  }
}

function cutoffDate(key) {
  if (key === "MAX") return "0000-00-00";
  const d = new Date();
  const yrs = { "5Y": 5, "10Y": 10, "20Y": 20, "30Y": 30 }[key] ?? 10;
  d.setFullYear(d.getFullYear() - yrs);
  // check_reuse: keep — 本地 range cutoff 變體:preset key 集合/MAX 哨兵/未命中預設與 dates.presetStart、dates.cutoffDate 皆不同,換過去會改行為
  return d.toISOString().slice(0, 10);
}

// ── cards ─────────────────────────────────────────────────────────────
function setText(id, txt, color) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = txt;
  if (color) el.style.color = color;
}

function updateCards() {
  const last = rows[rows.length - 1];
  const csi  = last.csi;

  // 1. current level + signal
  let sig, clr;
  if      (csi < 55)  { sig = "歷史低位 · 衰退警戒區";  clr = "#f85149"; }
  else if (csi < 70)  { sig = "悲觀偏弱 · 注意下行風險"; clr = "#f0883e"; }
  else if (csi < 85)  { sig = "中性偏弱";                clr = "#e3b341"; }
  else if (csi < 100) { sig = "溫和樂觀";                clr = "#3fb950"; }
  else                { sig = "高度樂觀 · 留意過熱";     clr = "#58a6ff"; }
  setText("umich-level-val", csi.toFixed(1), PALETTE.text);
  setText("umich-level-sub", `${last.date}（基期 1966:Q1=100）`, "var(--muted)");
  setText("umich-level-signal", sig, clr);

  // 2. trend — YoY change
  const prevIdx = rows.findIndex(r => r.date >= last.date.slice(0, 4 - 1) + (parseInt(last.date.slice(0, 4)) - 1) + last.date.slice(4));
  const prev12 = rows[rows.length - 13]?.csi;
  if (prev12 != null) {
    const chg = csi - prev12;
    const pct = ((chg / prev12) * 100).toFixed(1);
    const tClr = chg >= 0 ? "#3fb950" : "#f85149";
    setText("umich-trend-val", (chg >= 0 ? "▲ +" : "▼ ") + chg.toFixed(1), tClr);
    setText("umich-trend-sub", `vs 12個月前（${prev12.toFixed(1)}）| 變幅 ${pct}%`, "var(--muted)");
    setText("umich-trend-signal", chg >= 0 ? "消費信心改善中" : "消費信心持續惡化", tClr);
  }

  // 3. MA context
  const ma12 = last.ma12, ma24 = last.ma24;
  if (ma12 != null && ma24 != null) {
    const above = csi > ma12;
    const cross = ma12 > ma24 ? "MA12 在 MA24 之上（短期強於中期）" : "MA12 在 MA24 之下（短弱中強）";
    const mClr  = above ? "#3fb950" : "#f85149";
    setText("umich-ma-val", above ? "▲ 高於 MA12" : "▼ 低於 MA12", mClr);
    setText("umich-ma-sub", `MA12 ${ma12.toFixed(1)} · MA24 ${ma24.toFixed(1)} | ${cross}`, "var(--muted)");
    setText("umich-ma-signal", above ? "短期情緒改善" : "短期情緒仍低迷", mClr);
  }
}

// ── chart render ──────────────────────────────────────────────────────
export function render() {
  if (!chart || !rows) return;

  const axisClr = PALETTE.muted;
  const gridClr = tc("rgba(48,54,61,0.5)", "rgba(208,215,222,0.4)");
  const tipBg   = PALETTE.bg;
  const tipBdr  = PALETTE.border;
  const textClr = PALETTE.text2;

  updateCards();

  const cut   = cutoffDate(range);
  const view  = rows.filter(r => r.date >= cut);
  const dates = view.map(r => r.date);
  const csiData  = view.map(r => +r.csi.toFixed(2));
  const ma12Data = view.map(r => r.ma12 != null ? +r.ma12.toFixed(2) : null);
  const ma24Data = view.map(r => r.ma24 != null ? +r.ma24.toFixed(2) : null);

  // SPY aligned by date
  let spyData = null;
  if (showSPY && spyMap?.size) {
    spyData = dates.map(d => spyMap.has(d) ? +spyMap.get(d).toFixed(2) : null);
  }

  // recession markArea data pairs [start, end] within view range
  const recAreas = (recessions ?? [])
    .filter(p => p.end >= (dates[0] ?? ""))
    .map(p => [
      { xAxis: p.start < dates[0] ? dates[0] : p.start },
      { xAxis: p.end   > dates[dates.length - 1] ? dates[dates.length - 1] : p.end },
    ]);

  const status = document.getElementById("umich-status");
  if (status) status.textContent =
    `密西根大學消費者信心 · ${dates.length} 個月（${range}）· NBER 衰退陰影 · 資料 FRED`;

  const L = mob() ? 40 : 52, R = showSPY ? (mob() ? 48 : 62) : (mob() ? 16 : 28);

  const yAxis = [
    {
      type: "value", scale: true, name: "CSI",
      nameTextStyle: { color: CSI_COLOR, fontSize: 10 },
      axisLabel: { color: axisClr, fontSize: 11 },
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: gridClr } },
    },
  ];
  let spyAxisIdx = -1;
  if (showSPY && spyData) {
    spyAxisIdx = yAxis.length;
    yAxis.push({
      type: "log", scale: true, position: "right",
      name: "SPY", nameTextStyle: { color: SPY_COLOR, fontSize: 10 },
      axisLine: { lineStyle: { color: SPY_COLOR } },
      axisLabel: { color: SPY_COLOR, fontSize: 10, formatter: v => v >= 1000 ? (v / 1000).toFixed(0) + "K" : v },
      splitLine: { show: false },
    });
  }

  const recMarkArea = {
    silent: true,
    itemStyle: { color: REC_COLOR },
    data: recAreas,
    label: { show: false },
  };

  // horizontal reference lines at key levels
  const refMark = {
    silent: true, symbol: "none",
    data: [
      { yAxis: 70, lineStyle: { color: "#f0883e", type: "dashed", width: 1, opacity: 0.5 },
        label: { formatter: "70 悲觀線", color: "#f0883e", fontSize: 9, position: "insideEndTop" } },
      { yAxis: 85, lineStyle: { color: axisClr, type: "dashed", width: 1, opacity: 0.35 },
        label: { formatter: "85 中性", color: axisClr, fontSize: 9, position: "insideEndTop" } },
    ],
  };

  const series = [
    {
      name: "CSI", type: "line", data: csiData,
      symbol: "none", smooth: false, z: 5,
      itemStyle: { color: CSI_COLOR }, lineStyle: { color: CSI_COLOR, width: 2 },
      markArea: recMarkArea, markLine: refMark,
      yAxisIndex: 0,
    },
    {
      name: "MA12（1年）", type: "line", data: ma12Data,
      symbol: "none", connectNulls: true,
      itemStyle: { color: MA12_COLOR }, lineStyle: { color: MA12_COLOR, width: 1.2, opacity: 0.85 },
      yAxisIndex: 0, z: 3,
    },
    {
      name: "MA24（2年）", type: "line", data: ma24Data,
      symbol: "none", connectNulls: true,
      itemStyle: { color: MA24_COLOR }, lineStyle: { color: MA24_COLOR, width: 1.2, opacity: 0.85 },
      yAxisIndex: 0, z: 3,
    },
  ];
  if (showSPY && spyData) {
    series.push({
      name: "SPY", type: "line", data: spyData,
      symbol: "none", connectNulls: true, z: 2,
      itemStyle: { color: SPY_COLOR }, lineStyle: { color: SPY_COLOR, width: 1.3, opacity: 0.8 },
      yAxisIndex: spyAxisIdx,
    });
  }

  const legendData = ["CSI", "MA12（1年）", "MA24（2年）", ...(showSPY ? ["SPY"] : [])];

  chart.setOption({
    backgroundColor: "transparent", animation: false,
    tooltip: {
      trigger: "axis", axisPointer: { type: "cross" },
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        const d = params[0]?.axisValue ?? "";
        let html = `<div style="font-weight:600;margin-bottom:4px">${d}</div>`;
        for (const p of params) {
          if (p.value == null) continue;
          const v = p.seriesName === "SPY" ? (+p.value).toFixed(2) : (+p.value).toFixed(1);
          html += `<div>${p.marker}${p.seriesName}: <b>${v}</b></div>`;
        }
        return html;
      },
    },
    legend: {
      data: legendData, top: 2, left: "center",
      textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr,
    },
    grid: { left: L, right: R, top: "10%", bottom: "12%" },
    xAxis: {
      type: "category", data: dates, boundaryGap: false,
      axisLine: { lineStyle: { color: axisClr } }, axisTick: { show: false },
      axisLabel: { color: axisClr, fontSize: 11 },
      splitLine: { show: false },
    },
    yAxis,
    dataZoom: [{ type: "inside", filterMode: "none" }],
    series,
  }, { notMerge: true });
}

// ── controls ──────────────────────────────────────────────────────────
function buildControls() {
  const rp = document.getElementById("umich-range-picker");
  if (rp && !rp.dataset.built) {
    rp.dataset.built = "1";
    rp.addEventListener("click", e => {
      const t = e.target.closest(".chip[data-umich-range]");
      if (!t) return;
      range = t.dataset.umichRange;
      rp.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c === t));
      render();
    });
  }
  const sb = document.getElementById("umich-spy-toggle");
  if (sb && !sb.dataset.built) {
    sb.dataset.built = "1";
    sb.addEventListener("click", () => {
      showSPY = !showSPY;
      sb.classList.toggle("active", showSPY);
      render();
    });
  }
}

// ── lifecycle ─────────────────────────────────────────────────────────
export async function activate() {
  const host = document.getElementById("umich-chart");
  if (!host) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : "dark");
  buildControls();
  try {
    await loadAll();
    setTimeout(() => { chart?.resize(); render(); }, 50);
  } catch (e) {
    const s = document.getElementById("umich-status");
    if (s) s.textContent = "載入失敗：" + (e.message || e);
    console.error("[umich] load failed", e);
  }
}
export function onThemeChange(light) {
  if (!chart) return;
  chart.dispose();
  chart = echarts.init(document.getElementById("umich-chart"), light ? null : "dark");
  if (rows) render();
}
export function resize() { chart?.resize(); }
