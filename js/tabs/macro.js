import { macroLoaded } from '../state.js';
import { isLight, tc, mob, PALETTE } from '../utils/theme.js';
import { tsToLocalDate } from '../utils/dates.js';
import { computeM2YoY } from '../utils/math.js';

let macroChart       = null;
let bizChart         = null;
let macroRangePreset = "10Y";
let macroShowM2      = false;
let macroShowCAPE    = false;

const BIZ_ZONES = [
  { lo: 38, hi: 46, c: "#c62a47", name: "紅燈" },
  { lo: 32, hi: 38, c: "#e6912c", name: "黃紅燈" },
  { lo: 23, hi: 32, c: "#3fae5a", name: "綠燈" },
  { lo: 17, hi: 23, c: "#5b9bd5", name: "黃藍燈" },
  { lo:  0, hi: 17, c: "#2f6fb0", name: "藍燈" },
];

function filterMacroRange(rows) {
  if (macroRangePreset === "MAX") return rows;
  const d = new Date();
  if      (macroRangePreset === "1Y")  d.setFullYear(d.getFullYear() - 1);
  else if (macroRangePreset === "3Y")  d.setFullYear(d.getFullYear() - 3);
  else if (macroRangePreset === "5Y")  d.setFullYear(d.getFullYear() - 5);
  else if (macroRangePreset === "10Y") d.setFullYear(d.getFullYear() - 10);
  else if (macroRangePreset === "20Y") d.setFullYear(d.getFullYear() - 20);
  const from = d.toISOString().slice(0, 10);
  return rows.filter(r => r[0] >= from);
}

export async function loadMacroData() {
  for (const stem of ["US10Y", "US2Y", "M2", "CAPE"]) {
    if (macroLoaded[stem]) continue;
    const resp = await fetch(`data/${stem}.json`, { cache: "no-cache" });
    if (!resp.ok) throw new Error(`${stem}: HTTP ${resp.status}`);
    const j = await resp.json();
    macroLoaded[stem] = (j.data || []).map(r => [r.date, r.value]);
  }
  if (!macroLoaded["BIZ"]) {
    try {
      const r = await fetch("data/taiwan_business_signal.json", { cache: "no-cache" });
      if (r.ok) {
        const j = await r.json();
        macroLoaded["BIZ"] = (j.data || []).map(d => [d.date, d.score, d.light]);
      }
    } catch (_) { /* optional, skip if unavailable */ }
  }
}

export function renderMacroTab() {
  if (!macroChart) return;
  const statusEl = document.getElementById("macro-status");
  const us10y = macroLoaded["US10Y"];
  const us2y  = macroLoaded["US2Y"];
  if (!us10y || !us2y) { statusEl.textContent = "數據未載入"; return; }

  const map2y = new Map(us2y.map(r => [r[0], r[1]]));
  const spreadRaw = [];
  for (const [date, v10] of us10y) {
    const v2 = map2y.get(date);
    if (v2 != null) spreadRaw.push([date, +(v10 - v2).toFixed(4)]);
  }

  const y10f    = filterMacroRange(us10y);
  const y2f     = filterMacroRange(us2y);
  const spreadF = filterMacroRange(spreadRaw);

  const invZones = [];
  let invStart = null, invLast = null;
  for (const [date, v] of spreadF) {
    if (v < 0)    { if (!invStart) invStart = date; invLast = date; }
    else if (invStart) { invZones.push([invStart, invLast]); invStart = null; }
  }
  if (invStart) invZones.push([invStart, invLast]);

  const markAreaData = invZones.map(([s, e]) => [
    { xAxis: s, itemStyle: { color: "rgba(239,68,68,0.12)" } },
    { xAxis: e },
  ]);

  const axisClr = PALETTE.muted;
  const gridClr = PALETTE.grid;
  const tipBg   = PALETTE.bg;
  const tipBdr  = PALETTE.border;
  const tipText = PALETTE.text;
  const lineBase = { type: "line", showSymbol: false, emphasis: { focus: "series" } };

  // Build dynamic right-axis overlays
  const yAxisList = [
    { scale: true, axisLine: { lineStyle: { color: axisClr } },
      axisLabel: { formatter: v => v + "%", fontSize: 12 },
      splitLine: { lineStyle: { color: gridClr } } },
  ];
  let m2AxisIdx = -1, capeAxisIdx = -1;
  if (macroShowM2) {
    m2AxisIdx = yAxisList.length;
    yAxisList.push({ scale: true, position: "right", offset: 0,
      axisLine: { lineStyle: { color: "#3fb950" } },
      axisLabel: { formatter: v => v + "%", fontSize: 11, color: "#3fb950" },
      splitLine: { show: false } });
  }
  if (macroShowCAPE) {
    capeAxisIdx = yAxisList.length;
    yAxisList.push({ scale: true, position: "right", offset: macroShowM2 ? (mob() ? 42 : 70) : 0,
      axisLine: { lineStyle: { color: "#a371f7" } },
      axisLabel: { fontSize: 11, color: "#a371f7" },
      splitLine: { show: false } });
  }
  const yAxisCfg = yAxisList.length === 1 ? yAxisList[0] : yAxisList;

  const overlayCount = (macroShowM2 ? 1 : 0) + (macroShowCAPE ? 1 : 0);
  const gridRight = mob()
    ? (overlayCount === 0 ? 12 : overlayCount === 1 ? 42 : 80)
    : (overlayCount === 0 ? 24 : overlayCount === 1 ? 72 : 130);

  let m2yoyF = [];
  if (macroShowM2 && macroLoaded["M2"]) m2yoyF = filterMacroRange(computeM2YoY(macroLoaded["M2"]));

  let capeF = [];
  if (macroShowCAPE && macroLoaded["CAPE"]) capeF = filterMacroRange(macroLoaded["CAPE"]);

  const legendData = ["美債10Y", "美債2Y", "利差 10Y-2Y"];
  if (macroShowM2)   legendData.push("M2年增率");
  if (macroShowCAPE) legendData.push("CAPE");

  const seriesList = [
    { ...lineBase, name: "美債10Y", data: y10f, yAxisIndex: 0,
      lineStyle: { width: 1.8, color: "#58a6ff" }, itemStyle: { color: "#58a6ff" } },
    { ...lineBase, name: "美債2Y",  data: y2f,  yAxisIndex: 0,
      lineStyle: { width: 1.8, color: "#f778ba" }, itemStyle: { color: "#f778ba" } },
    { ...lineBase, name: "利差 10Y-2Y", data: spreadF, yAxisIndex: 0,
      lineStyle: { width: 1.5, color: "#e3b341", type: "dashed" },
      itemStyle: { color: "#e3b341" },
      markArea: { silent: true, data: markAreaData },
      markLine: { silent: true, symbol: "none",
        data: [{ yAxis: 0, lineStyle: { color: "rgba(239,68,68,0.55)", type: "solid", width: 1 } }],
        label: { show: false } },
    },
  ];
  if (macroShowM2)   seriesList.push({ ...lineBase, name: "M2年增率", data: m2yoyF,
    yAxisIndex: m2AxisIdx, lineStyle: { width: 1.5, color: "#3fb950" }, itemStyle: { color: "#3fb950" } });
  if (macroShowCAPE) seriesList.push({ ...lineBase, name: "CAPE", data: capeF,
    yAxisIndex: capeAxisIdx, lineStyle: { width: 1.5, color: "#a371f7" }, itemStyle: { color: "#a371f7" },
    markLine: { silent: true, symbol: "none",
      data: [{ yAxis: 16.8, lineStyle: { color: "rgba(163,113,247,0.45)", type: "dashed", width: 1 } }],
      label: { formatter: "均值 16.8", color: "#a371f7", fontSize: 10, position: "insideEndTop" } },
  });

  macroChart.setOption({
    backgroundColor: "transparent",
    tooltip: {
      trigger: "axis", axisPointer: { type: "cross" },
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: tipText },
      formatter(params) {
        const ts = params[0]?.axisValue;
        const dateLabel = ts ? tsToLocalDate(ts) : "";
        let out = `<b>${dateLabel}</b><br/>`;
        for (const p of params) {
          if (p.seriesName.startsWith("__")) continue;
          const v = p.value?.[1];
          if (v == null) continue;
          const unit = p.seriesName === "CAPE" ? "" : "%";
          out += `<span style="color:${p.color}">●</span> ${p.seriesName}: <b>${v.toFixed(2)}${unit}</b><br/>`;
        }
        return out;
      },
    },
    legend: { data: legendData, textStyle: { color: tipText }, top: 6 },
    grid: { left: mob() ? 45 : 72, right: gridRight, top: 44, bottom: 56 },
    xAxis: { type: "time", axisLine: { lineStyle: { color: axisClr } }, splitLine: { show: false } },
    yAxis: yAxisCfg,
    dataZoom: [{ type: "inside" }, { type: "slider", height: 18, bottom: 14 }],
    series: seriesList,
  }, { notMerge: true });

  const latestSpread = spreadF.at(-1)?.[1];
  const spreadStr = latestSpread != null
    ? `${latestSpread >= 0 ? "+" : ""}${latestSpread.toFixed(2)}%` : "—";
  const latestDate = y10f.at(-1)?.[0] ?? "—";
  statusEl.textContent =
    `美債殖利率曲線 · ${macroRangePreset} · 目前利差 ${spreadStr} · 倒掛事件 ${invZones.length} 次 · 最新 ${latestDate}`;
}

function renderBizChart() {
  const el = document.getElementById("biz-chart");
  if (!el || !macroLoaded["BIZ"]) return;
  if (!bizChart) bizChart = echarts.init(el, isLight() ? null : "dark");

  const d = new Date();
  if (macroRangePreset !== "MAX") {
    const y = { "1Y": -1, "3Y": -3, "5Y": -5, "10Y": -10, "20Y": -20 }[macroRangePreset] ?? -10;
    d.setFullYear(d.getFullYear() + y);
  }
  const from = macroRangePreset === "MAX" ? "1900-01-01" : d.toISOString().slice(0, 10);
  const bizData = macroLoaded["BIZ"].filter(r => r[0] >= from).map(r => [r[0], r[1]]);

  const last  = macroLoaded["BIZ"].at(-1);
  const zone  = BIZ_ZONES.find(z => last[1] >= z.lo) ?? BIZ_ZONES.at(-1);
  const bizEl = document.getElementById("biz-status");
  if (bizEl) bizEl.innerHTML =
    `<span style="color:${zone.c};font-weight:600">${zone.name}</span> ${last[1]} 分 ` +
    `· ${last[0].slice(0, 7)} · 資料來源：NDC data.gov.tw`;

  const axisClr = PALETTE.muted;
  const gridClr = PALETTE.grid;
  const tipBg   = PALETTE.bg;
  const tipBdr  = PALETTE.border;
  const tipText = PALETTE.text;

  bizChart.setOption({
    backgroundColor: "transparent",
    tooltip: {
      trigger: "axis", backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: tipText },
      formatter(params) {
        const v = params[0]?.value?.[1];
        if (v == null) return "";
        const z = BIZ_ZONES.find(z => v >= z.lo) ?? BIZ_ZONES.at(-1);
        return `<b>${params[0].axisValue?.slice(0, 7)}</b><br/>` +
          `<span style="color:${z.c}">●</span> ${z.name} <b>${v}</b> 分`;
      },
    },
    grid: { top: 10, left: mob() ? 30 : 42, right: mob() ? 10 : 80, bottom: 34 },
    xAxis: {
      type: "time", splitLine: { show: false },
      axisLine: { lineStyle: { color: axisClr } },
      axisLabel: { fontSize: 10, color: axisClr },
    },
    yAxis: {
      type: "value", min: 0, max: 46, interval: 9,
      splitLine: { lineStyle: { color: gridClr } },
      axisLabel: { fontSize: 10, color: axisClr },
    },
    visualMap: {
      show: false, type: "piecewise", dimension: 1, seriesIndex: 0,
      pieces: BIZ_ZONES.map(z => ({ min: z.lo, max: z.hi, color: z.c })),
    },
    series: [{
      type: "line", data: bizData, showSymbol: false, lineStyle: { width: 2 },
      markLine: {
        silent: true, symbol: "none",
        data: BIZ_ZONES.slice(0, -1).map(z => ({
          yAxis: z.lo,
          lineStyle: { color: tc("rgba(0,0,0,0.12)", "rgba(255,255,255,0.08)"), type: "dashed", width: 1 },
          label: { show: !mob(), formatter: z.name, position: "insideEndTop", fontSize: 9, color: z.c },
        })),
      },
    }],
    dataZoom: [{ type: "inside", xAxisIndex: 0 }],
  }, { notMerge: true });
}

const MACRO_CHART_GROUP = "macro-tab";

function connectMacroCharts() {
  if (macroChart) macroChart.group = MACRO_CHART_GROUP;
  if (bizChart) bizChart.group = MACRO_CHART_GROUP;
  echarts.connect(MACRO_CHART_GROUP);
}

// echarts' axisPointer `link` only value-matches axes within ONE chart instance; macroChart
// and bizChart are separate instances (and different frequency: daily vs monthly), so the
// crosshair is relayed manually — see js/tabs/credit.js for the fuller writeup of why
// dispatchAction({type:"showTip", x, y}) (position-based) is used instead of a dataIndex.
function targetMacroY(chart) {
  return chart.getHeight() * 0.5;
}

function wireMacroCrossSync() {
  const charts = [macroChart, bizChart].filter(Boolean);
  if (charts.length < 2) return;
  for (const src of charts) {
    src.on("updateAxisPointer", event => {
      const xInfo = (event.axesInfo || []).find(a => a.axisDim === "x");
      if (xInfo?.value == null) return;
      for (const dst of charts) {
        if (dst === src) continue;
        const w = dst.getWidth();
        let px = dst.convertToPixel({ xAxisIndex: 0 }, xInfo.value);
        if (px == null || Number.isNaN(px) || px < -50 || px > w + 50) {
          dst.dispatchAction({ type: "hideTip" });
          continue;
        }
        px = Math.max(0, Math.min(px, w - 1));
        dst.dispatchAction({ type: "showTip", x: px, y: targetMacroY(dst) });
      }
    });
    src.getZr().on("globalout", () => {
      for (const dst of charts) if (dst !== src) dst.dispatchAction({ type: "hideTip" });
    });
  }
}

export function activate() {
  const el = document.getElementById("macro-chart");
  if (!macroChart) macroChart = echarts.init(el, isLight() ? null : "dark");
  const bEl = document.getElementById("biz-chart");
  if (!bizChart && bEl) bizChart = echarts.init(bEl, isLight() ? null : "dark");
  connectMacroCharts();
  wireMacroCrossSync();
  setTimeout(() => { macroChart.resize(); bizChart?.resize(); renderMacroTab(); renderBizChart(); }, 50);
}

export function onThemeChange(light) {
  if (!macroChart) return;
  macroChart.dispose();
  macroChart = echarts.init(document.getElementById("macro-chart"), light ? null : "dark");
  renderMacroTab();
  if (bizChart) {
    bizChart.dispose();
    const bEl = document.getElementById("biz-chart");
    bizChart = bEl ? echarts.init(bEl, light ? null : "dark") : null;
    renderBizChart();
  }
  connectMacroCharts();
  wireMacroCrossSync();
}

export function resize() {
  macroChart?.resize();
  bizChart?.resize();
}

document.getElementById("m2-toggle")?.addEventListener("click", () => {
  macroShowM2 = !macroShowM2;
  document.getElementById("m2-toggle").classList.toggle("active", macroShowM2);
  renderMacroTab();
});

document.getElementById("cape-toggle")?.addEventListener("click", () => {
  macroShowCAPE = !macroShowCAPE;
  document.getElementById("cape-toggle").classList.toggle("active", macroShowCAPE);
  renderMacroTab();
});

document.getElementById("macro-range-picker")?.addEventListener("click", e => {
  const t = e.target.closest(".chip[data-macro-range]");
  if (!t) return;
  macroRangePreset = t.dataset.macroRange;
  for (const c of e.currentTarget.querySelectorAll(".chip"))
    c.classList.toggle("active", c === t);
  renderMacroTab();
  renderBizChart();
});
