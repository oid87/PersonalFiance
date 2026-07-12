// 殖利率曲線 tab — US Treasury 利差倒掛（T10Y2Y / T10Y3M）+ 各段殖利率
//   資料：data/yield_curve.json（fetch_yield_curve.py 抓 FRED CSV，免 key）

import { isLight, tc, mob } from '../utils/theme.js';

const SPREAD_LINES = [
  { key: "t10y2y", name: "10Y−2Y 利差", color: "#58a6ff" },
  { key: "t10y3m", name: "10Y−3M 利差", color: "#e3b341" },
];
const YIELD_LINES = [
  { key: "dgs3mo", name: "3M 殖利率",  color: "#8b949e" },
  { key: "dgs2",   name: "2Y 殖利率",  color: "#d2a8ff" },
  { key: "dgs5",   name: "5Y 殖利率",  color: "#f778ba" },
  { key: "dgs10",  name: "10Y 殖利率", color: "#f0883e" },
  { key: "dgs30",  name: "30Y 殖利率", color: "#3fb950" },
];

let chart   = null;
let range   = "3Y";
let showSet = new Set();  // 目前開啟的殖利率細項
let rows    = null;

async function loadAll() {
  if (rows) return;
  const r = await fetch("data/yield_curve.json", { cache: "no-cache" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  rows = (j?.data ?? []).filter(x => x.t10y2y != null || x.t10y3m != null).map(x => ({ ...x }));
}

function cutoffDate(key) {
  if (key === "MAX") return "0000-00-00";
  const d = new Date();
  const yrs = { "1Y": 1, "3Y": 3, "5Y": 5, "10Y": 10 }[key] ?? 3;
  d.setFullYear(d.getFullYear() - yrs);
  return d.toISOString().slice(0, 10);
}

// ── cards ─────────────────────────────────────────────────────────────
function setText(id, txt, color) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = txt;
  if (color) el.style.color = color;
}

function lastNonNull(key) {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i][key] != null) return rows[i];
  }
  return null;
}

function updateCards() {
  const r2 = lastNonNull("t10y2y");
  const r3 = lastNonNull("t10y3m");

  if (r2) {
    const v = r2.t10y2y;
    const clr = v < 0 ? "#f85149" : "#3fb950";
    setText("yc-2y-val", (v >= 0 ? "+" : "") + v.toFixed(2) + "%", clr);
    setText("yc-2y-sub", `${r2.date} · 10Y − 2Y`, "var(--muted)");
    setText("yc-2y-signal", v < 0 ? "倒掛中" : "正常", clr);
  }
  if (r3) {
    const v = r3.t10y3m;
    const clr = v < 0 ? "#f85149" : "#3fb950";
    setText("yc-3m-val", (v >= 0 ? "+" : "") + v.toFixed(2) + "%", clr);
    setText("yc-3m-sub", `${r3.date} · 10Y − 3M`, "var(--muted)");
    setText("yc-3m-signal", v < 0 ? "倒掛中" : "正常", clr);
  }

  const inverted = (r2 && r2.t10y2y < 0) || (r3 && r3.t10y3m < 0);
  setText("yc-inv-val", inverted ? "倒掛中" : "正常", inverted ? "#f85149" : "#3fb950");
  setText("yc-inv-sub",
    `10Y-2Y ${r2 ? r2.t10y2y.toFixed(2) : "—"}% · 10Y-3M ${r3 ? r3.t10y3m.toFixed(2) : "—"}%`,
    "var(--muted)");
  setText("yc-inv-signal", inverted ? "任一利差 < 0" : "兩利差皆 ≥ 0", inverted ? "#f85149" : "#3fb950");
}

// ── chart render ──────────────────────────────────────────────────────
export function render() {
  if (!chart || !rows?.length) return;

  const axisClr = tc("#8b949e", "#57606a");
  const gridClr = tc("rgba(48,54,61,0.5)", "rgba(208,215,222,0.4)");
  const tipBg   = tc("#161b22", "#ffffff");
  const tipBdr  = tc("#30363d", "#d0d7de");
  const textClr = tc("#c9d1d9", "#24292f");

  updateCards();

  const cut  = cutoffDate(range);
  const view = rows.filter(r => r.date >= cut);
  const dates = view.map(r => r.date);

  const status = document.getElementById("yc-status");
  if (status) status.textContent =
    `殖利率曲線 · ${dates.length} 個交易日（${range}）· 資料 FRED DGS 系列`;

  const L = mob() ? 40 : 52;
  const R = mob() ? 16 : 28;

  // 倒掛區間視覺強調（t10y2y < 0）
  const invAreas = [];
  let segStart = null;
  for (let i = 0; i < view.length; i++) {
    const on = view[i].t10y2y != null && view[i].t10y2y < 0;
    if (on && segStart === null) segStart = dates[i];
    if (!on && segStart !== null) {
      invAreas.push([{ xAxis: segStart }, { xAxis: dates[i - 1] }]);
      segStart = null;
    }
  }
  if (segStart !== null) invAreas.push([{ xAxis: segStart }, { xAxis: dates[dates.length - 1] }]);

  const zeroLine = {
    silent: true, symbol: "none",
    lineStyle: { color: "#f85149", type: "dashed", width: 1, opacity: 0.6 },
    label: { formatter: "0%（倒掛線）", color: "#f85149", fontSize: 9, position: "insideEndTop" },
    data: [{ yAxis: 0 }],
  };

  const series = [];
  for (const ln of SPREAD_LINES) {
    series.push({
      name: ln.name, type: "line",
      data: view.map(r => r[ln.key] != null ? +r[ln.key].toFixed(3) : null),
      symbol: "none", connectNulls: true,
      itemStyle: { color: ln.color },
      lineStyle: { color: ln.color, width: 2 },
      yAxisIndex: 0, z: 5,
      markLine: ln.key === "t10y2y" ? zeroLine : undefined,
      markArea: ln.key === "t10y2y" ? {
        silent: true,
        itemStyle: { color: "rgba(248,81,73,0.10)" },
        data: invAreas,
      } : undefined,
    });
  }

  for (const ln of YIELD_LINES) {
    if (!showSet.has(ln.key)) continue;
    series.push({
      name: ln.name, type: "line",
      data: view.map(r => r[ln.key] != null ? +r[ln.key].toFixed(3) : null),
      symbol: "none", connectNulls: true,
      itemStyle: { color: ln.color },
      lineStyle: { color: ln.color, width: 1.2, opacity: 0.8, type: "dashed" },
      yAxisIndex: 0, z: 3,
    });
  }

  const legendData = [
    ...SPREAD_LINES.map(l => l.name),
    ...YIELD_LINES.filter(l => showSet.has(l.key)).map(l => l.name),
  ];

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
          html += `<div>${p.marker}${p.seriesName}: <b>${(+p.value).toFixed(2)}%</b></div>`;
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
    yAxis: [{
      type: "value", scale: true, name: "%",
      nameTextStyle: { color: axisClr, fontSize: 10 },
      axisLabel: { color: axisClr, fontSize: 11, formatter: v => v.toFixed(1) + "%" },
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: gridClr } },
    }],
    dataZoom: [{ type: "inside", filterMode: "none" }],
    series,
  }, { notMerge: true });
}

// ── controls ──────────────────────────────────────────────────────────
function buildControls() {
  const rp = document.getElementById("yc-range-picker");
  if (rp && !rp.dataset.built) {
    rp.dataset.built = "1";
    rp.addEventListener("click", e => {
      const t = e.target.closest(".chip[data-yc-range]");
      if (!t) return;
      range = t.dataset.ycRange;
      rp.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c === t));
      render();
    });
  }
  const sub = document.getElementById("yc-yield-toggles");
  if (sub && !sub.dataset.built) {
    sub.dataset.built = "1";
    sub.addEventListener("click", e => {
      const t = e.target.closest(".chip[data-yc-yield]");
      if (!t) return;
      const key = t.dataset.ycYield;
      if (showSet.has(key)) showSet.delete(key); else showSet.add(key);
      t.classList.toggle("active", showSet.has(key));
      render();
    });
  }
}

// ── lifecycle ─────────────────────────────────────────────────────────
export async function activate() {
  const host = document.getElementById("yc-chart");
  if (!host) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : "dark");
  buildControls();
  try {
    await loadAll();
    setTimeout(() => { chart?.resize(); render(); }, 50);
  } catch (e) {
    const s = document.getElementById("yc-status");
    if (s) s.textContent = "載入失敗：" + (e.message || e);
    console.error("[yield_curve] load failed", e);
  }
}
export function onThemeChange(light) {
  if (!chart) return;
  chart.dispose();
  chart = echarts.init(document.getElementById("yc-chart"), light ? null : "dark");
  if (rows) render();
}
export function resize() { chart?.resize(); }
