import { macroLoaded } from '../state.js';
import { isLight, tc, mob } from '../utils/theme.js';
import { tsToLocalDate } from '../utils/dates.js';
import { computeM2YoY } from '../utils/math.js';

let macroChart       = null;
let macroRangePreset = "10Y";
let macroShowM2      = false;
let macroShowCAPE    = false;

function filterMacroRange(rows) {
  if (macroRangePreset === "MAX") return rows;
  const d = new Date();
  if      (macroRangePreset === "5Y")  d.setFullYear(d.getFullYear() - 5);
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

  const axisClr = tc("#8b949e", "#57606a");
  const gridClr = tc("#21262d", "#e1e4e8");
  const tipBg   = tc("#161b22", "#ffffff");
  const tipBdr  = tc("#30363d", "#d0d7de");
  const tipText = tc("#e6edf3", "#1f2328");
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

export function activate() {
  const el = document.getElementById("macro-chart");
  if (!macroChart) {
    macroChart = echarts.init(el, isLight() ? null : "dark");
  }
  setTimeout(() => { macroChart.resize(); renderMacroTab(); }, 50);
}

export function onThemeChange(light) {
  if (!macroChart) return;
  macroChart.dispose();
  macroChart = echarts.init(document.getElementById("macro-chart"), light ? null : "dark");
  renderMacroTab();
}

export function resize() {
  macroChart?.resize();
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
});
