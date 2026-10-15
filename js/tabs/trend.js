import {
  SERIES, CUSTOM_COLORS, customSeries, active, maActive,
  loaded, loadedHLC, loadedVol, state,
} from '../state.js';
import { tc, PALETTE } from '../utils/theme.js';
import {
  tsToLocalDate, currentWindow, filterRange,
  dateAddDays, closestOnOrAfter, minBetween, lookupLE,
  toWeekly, toWeeklyHLC,
} from '../utils/dates.js';
import {
  computeMA, computeRSI, computeKD, computeTDSetup, computeDDZones, computeBounceSignals,
} from '../utils/math.js';
import { loadSeries, ensureLoaded, requestJSON } from '../utils/data.js';
import { chipPicker } from '../utils/dom.js';
import { captureChartState, restoreChartState } from '../utils/chartLifecycle.js';
import { interpFpe } from './trend_calc.mjs';
import { fearZones as calcFearZones, fearEpisodes as calcFearEpisodes, buildSigMaps as calcBuildSigMaps, signalSnapshot, scoreZones } from './trend_calc.mjs';

const chartEl = document.getElementById("chart");
let chart = echarts.init(chartEl, null); // light by default

// The host height animates during rotation and fear-panel changes. Measure the
// final layout as well as intermediate frames, including after theme recreation.
if (chartEl && typeof ResizeObserver !== 'undefined') {
  const observer = new ResizeObserver(() => {
    if (!chart || chart.isDisposed() || !chartEl.getClientRects().length) return;
    const width = chartEl.clientWidth, height = chartEl.clientHeight;
    if (width > 0 && height > 0 &&
        (chart.getWidth() !== width || chart.getHeight() !== height)) chart.resize();
    relayoutAxes();
  });
  observer.observe(chartEl);
}

let fearActive    = false;
let fearThreshold = 20;

let ddZoneActive    = false;
let sigZoneActive   = false;
let trendFpeActive  = false;
let trendFpeData    = null;

// Trend-only extras (kept out of SERIES so corr/tools don't pick them up).
// `high` entries plot the intraday high of their `src` series from loadedHLC.
const VXN_SERIES = Object.freeze({ key: "VXN", file: "data/VXN.json", color: "#8b949e", yAxis: 1 });
const TREND_EXTRA = Object.freeze([
  VXN_SERIES,
  // Same key/file as SERIES "VIX", so both share loaded["VIX"] and the request cache.
  { key: "VIX高", src: { key: "VIX", file: "data/VIX.json" }, color: "#f0883e", yAxis: 1, high: true },
  { key: "VXN高", src: VXN_SERIES, color: "#8b949e", yAxis: 1, high: true },
]);
const MA_SKIP = new Set(["F&G", "VIX", "VXN", "VIX高", "VXN高"]);

function seriesData(s) {
  if (!s.high) return loaded[s.key];
  const hlc = loadedHLC[s.src.key];
  return hlc ? hlc.map(r => [r[0], r[1]]) : undefined;
}

const dateFrom = document.getElementById("date-from");
const dateTo   = document.getElementById("date-to");

chart.on("updateAxisPointer", evt => {
  try {
    const ts = evt?.axesInfo?.[0]?.value;
    if (typeof ts !== "number") return;
    renderSignalPanel(tsToLocalDate(ts));
  } catch (_) {}
});
chart.on("globalout", () => { if (state.sigMaps) renderSignalPanel(); });

// ── Fear helpers ───────────────────────────────────────────────
function fearZones(threshold) { return calcFearZones(loaded["F&G"], threshold); }
function fearEpisodes(threshold) { return calcFearEpisodes(loaded["F&G"], threshold); }

function updateChartHeight() {
  const h = (fearActive && loaded["F&G"]) ? 212 : 0;
  document.documentElement.style.setProperty("--fear-h", h + "px");
  setTimeout(() => chart.resize(), 220);
}

function renderFearPanel() {
  const panel = document.getElementById("fear-panel");
  if (!fearActive || !loaded["F&G"]) {
    panel.style.display = "none";
    updateChartHeight();
    return;
  }
  panel.style.display = "block";
  document.getElementById("fear-thresh-label").textContent = fearThreshold;
  updateChartHeight();

  const pk = loaded["SPY"] ? "SPY" : (loaded["VOO"] ? "VOO" : null);
  const eps = fearEpisodes(fearThreshold).reverse();

  document.getElementById("fear-ep-count").textContent = `${eps.length} 個事件`;
  document.getElementById("fear-price-note").textContent =
    pk ? `以 ${pk} 計算` : "（請啟用 SPY 或 VOO 顯示價格）";

  document.getElementById("fp-head").innerHTML = `<tr>
    <th>#</th><th>期間</th><th>天數</th><th>F&G低</th>
    ${pk ? `<th>${pk}最低</th><th>最低日</th><th>3M後</th><th>6M後</th><th>漲幅3M</th><th>漲幅6M</th>` : ""}
  </tr>`;

  if (!pk) {
    document.getElementById("fp-body").innerHTML =
      `<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:10px">啟用 SPY 或 VOO 以顯示價格欄位</td></tr>`;
    return;
  }

  const f  = v => v != null ? "$" + v.toFixed(2) : "—";
  const fp = (base, v) => {
    if (base == null || v == null) return `<td style="color:var(--muted)">—</td>`;
    const pct = (v / base - 1) * 100;
    return `<td class="${pct >= 0 ? "pos" : "neg"}">${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%</td>`;
  };

  document.getElementById("fp-body").innerHTML = eps.map((ep, i) => {
    const minP = minBetween(pk, ep.start, ep.end);
    const p3m  = closestOnOrAfter(pk, dateAddDays(ep.end, 90));
    const p6m  = closestOnOrAfter(pk, dateAddDays(ep.end, 180));
    return `<tr>
      <td style="color:var(--muted)">${eps.length - i}</td>
      <td>${ep.start} ~ ${ep.end}</td>
      <td style="color:var(--muted)">${ep.days}天</td>
      <td class="fear-val">${ep.fgMin}</td>
      <td><b>${f(minP?.price)}</b></td>
      <td style="color:var(--muted);font-size:11px">${minP?.date ?? "—"}</td>
      <td>${f(p3m)}</td>
      <td>${f(p6m)}</td>
      ${fp(minP?.price, p3m)}
      ${fp(minP?.price, p6m)}
    </tr>`;
  }).join("");
}

// ── Signal panel data builder ──────────────────────────────────
function buildSigMaps() {
  if (!loaded["QQQ"]?.length) return;
  state.sigMaps = calcBuildSigMaps({
    qqq: loaded["QQQ"], qqqHLC: loadedHLC["QQQ"],
    fg: loaded["F&G"] || [], vix: loaded["VIX"] || [], vol: loadedVol["QQQ"] || [],
  }, { toWeekly, toWeeklyHLC, computeKD, computeRSI, computeTDSetup,
    computeMA, lookupLE, computeBounceSignals });
}

export function renderSignalPanel(date) {
  if (!state.sigMaps) buildSigMaps();
  if (!state.sigMaps) return;

  const isLive = !date;
  const d = date || state.sigMaps.qqq.at(-1)?.[0];
  if (!d) return;

  const snapshot = signalSnapshot(state.sigMaps, d, lookupLE);
  const { kdK, rsiVal, tdCount, tdDir, fgVal, vixVal, ma200Dev,
    volVal, ddVal, dailyRetV, bounceHit, hits: [kdHit, rsiHit, fgHit,
    vixHit, maHit, tdHit, ddHit, volHit] } = snapshot;

  const set = (id, label, txt, hit) => {
    const el = document.getElementById(id); if (!el) return;
    el.textContent = txt != null ? `${label} ${txt}` : `${label} —`;
    el.classList.toggle("hit", !!hit);
  };
  set("sig-kd",   "週K",   kdK      != null ? kdK.toFixed(1)    : null, kdHit);
  set("sig-rsi",  "週RSI", rsiVal   != null ? rsiVal.toFixed(1)  : null, rsiHit);
  set("sig-fg",   "F&G",   fgVal    != null ? fgVal.toFixed(0)   : null, fgHit);
  set("sig-vix",  "VIX",   vixVal   != null ? vixVal.toFixed(1)  : null, vixHit);
  set("sig-ma",   "MA200", ma200Dev != null ? `${ma200Dev >= 0 ? "↑" : "↓"}${Math.abs(ma200Dev).toFixed(1)}%` : null, maHit);
  set("sig-td",   "九轉",  tdDir === 'down' && tdCount > 0 ? `${tdCount}計` : "0計", tdHit);
  set("sig-dd",   "12W",   ddVal    != null ? `${ddVal.toFixed(1)}%`    : null, ddHit);
  set("sig-vol",  "量",    volVal   != null ? `${(volVal / 1e6).toFixed(0)}M` : null, volHit);
  set("sig-bounce", "恐慌反彈", bounceHit ? `F&G:${fgVal.toFixed(0)} +${(dailyRetV * 100).toFixed(1)}%` : null, bounceHit);
  const hits = snapshot.count;
  const countEl = document.getElementById("sig-count");
  if (countEl) {
    countEl.textContent = `${hits}/8`;
    countEl.style.color = hits >= 5 ? "#f85149" : hits >= 3 ? "#e3b341" : "var(--muted)";
  }
  const labelEl = document.querySelector("#signal-panel > span:first-child");
  if (labelEl) labelEl.textContent = isLive ? "QQQ 極端低點" : `QQQ @ ${d}`;
}

// ── Chart render ───────────────────────────────────────────────
// y-axis indexes that at least one series with data is plotted on.
function usedAxisIndexes(series) {
  const used = new Set();
  for (const s of series) {
    if (Array.isArray(s.data) && s.data.length > 0) used.add(s.yAxisIndex ?? 0);
  }
  return used;
}

// ── Axis layout that fits the visible axes ─────────────────────
// axis-layout:begin
// Value axes outside the plot are stacked by `offset` (px from the grid edge, inner axis
// first). Each visible axis claims tick + label gap + its widest tick label, and the next
// axis on that side starts after it, so tick labels never overlap; neighbouring axis names
// (centred on their axis line) are kept apart too. The grid margin then covers the
// outermost axis, and axis names that would share a row with the legend are moved down
// under it. Widths come from the axes' own min/max functions and formatters (unchanged), so
// nothing is clipped even when VIX, F&G, BTC, TWD and FPE are all on. Presentation only.
const AXIS_TICK_PX = 5, AXIS_LABEL_GAP_PX = 8, AXIS_LABEL_PAD_PX = 4, AXIS_FONT_PX = 12;
const AXIS_BLOCK_GAP_PX = 4;  // clear space between one axis' label block and the next axis line
const AXIS_NAME_GAP_PX = 6;   // clear space between neighbouring axis names
const NAME_DEFAULT_GAP_PX = 15, NAME_UNDER_LEGEND_GAP_PX = 8, NAME_HEIGHT_PX = 14; // 15 = ECharts' own default
const LEGEND_TOP_PX = 6, LEGEND_ROW_PX = 24, LEGEND_ITEM_PX = 30, LEGEND_ITEM_GAP_PX = 10, LEGEND_SAFETY_PX = 6;
const GRID_TOP_PX = 44;
let measureCtx = null;
function textWidth(text, px = AXIS_FONT_PX) {
  try {
    measureCtx ||= document.createElement("canvas").getContext("2d");
    measureCtx.font = `${px}px sans-serif`;
    return measureCtx.measureText(text).width;
  } catch (_) {
    return String(text).length * px * 0.62; // no canvas (tests): conservative estimate
  }
}

function seriesExtent(series, axisIndex) {
  let min = Infinity, max = -Infinity;
  for (const s of series) {
    if ((s.yAxisIndex ?? 0) !== axisIndex || !Array.isArray(s.data)) continue;
    for (const point of s.data) {
      const v = point?.[1];
      if (typeof v === "number" && Number.isFinite(v)) { if (v < min) min = v; if (v > max) max = v; }
    }
  }
  return min <= max ? { min, max } : null;
}

function axisLabelWidth(axis, extent) {
  const bound = b => typeof b === "function" ? (extent ? b(extent) : null) : b;
  const fmt = axis.axisLabel?.formatter || (v => Number(v).toLocaleString("en-US"));
  const px = axis.axisLabel?.fontSize || AXIS_FONT_PX;
  const texts = [bound(axis.min), bound(axis.max)].filter(Number.isFinite).map(v => String(fmt(v)));
  if (!texts.length) return 0;
  // the widest end label, plus room for one decimal place on narrow ranges
  return Math.max(...texts.map(t => textWidth(t, px))) + textWidth(".0", px);
}

// Legend rows at chart width `width` (greedy wrap, like the horizontal legend) and the
// horizontal extent of the first row, which is centred.
function legendFootprint(names, width) {
  const items = names.map(n => LEGEND_ITEM_PX + textWidth(n));
  const usable = Math.max(1, width - 10 - LEGEND_SAFETY_PX);
  let rows = items.length ? 1 : 0, rowW = 0;
  for (const w of items) {
    const next = rowW ? rowW + LEGEND_ITEM_GAP_PX + w : w;
    if (rowW && next > usable) { rows += 1; rowW = w; } else rowW = next;
  }
  const total = items.reduce((a, w) => a + w, 0) + LEGEND_ITEM_GAP_PX * Math.max(0, items.length - 1);
  const spanW = rows > 1 ? width : Math.min(width, total + 2 * LEGEND_SAFETY_PX);
  return { rows, left: (width - spanW) / 2, right: (width + spanW) / 2, bottom: rows ? LEGEND_TOP_PX + LEGEND_ROW_PX * rows : 0 };
}

// axes: [{ position: "left"|"right", name, labelW, used }] in declaration order (inner axis
// first on each side). Returns one offset per axis (0 for unused ones), the grid margins
// and top, and the name gap to use.
function computeAxisLayout(axes, legendNames, width, floor = { left: 8, right: 8 }) {
  const offsets = axes.map(() => 0);
  const need = { left: floor.left, right: floor.right };
  const edge = { left: [], right: [] }; // per side: [{ i, block, nameW }]
  axes.forEach((axis, i) => {
    if (!axis.used) return;
    const side = axis.position === "left" ? "left" : "right";
    const block = AXIS_TICK_PX + AXIS_LABEL_GAP_PX + axis.labelW + AXIS_LABEL_PAD_PX;
    const nameW = textWidth(axis.name || "");
    const prev = edge[side][edge[side].length - 1];
    offsets[i] = prev
      ? offsets[prev.i] + Math.max(prev.block + AXIS_BLOCK_GAP_PX, (prev.nameW + nameW) / 2 + AXIS_NAME_GAP_PX)
      : 0;
    edge[side].push({ i, block, nameW });
    need[side] = Math.max(need[side], offsets[i] + Math.max(block, nameW / 2 + 2));
  });
  const left = Math.ceil(need.left), right = Math.ceil(need.right);
  // Names sit just above the plot. If any name could land under the legend (same row), put
  // the names on their own row below the legend and push the plot down accordingly.
  const legend = legendFootprint(legendNames, width);
  let clash = false;
  for (const side of ["left", "right"]) for (const { i, nameW } of edge[side]) {
    const cx = side === "left" ? left - offsets[i] : width - right + offsets[i];
    if (cx + nameW / 2 > legend.left && cx - nameW / 2 < legend.right) clash = true;
  }
  const stacked = clash || legend.rows > 1;
  const top = stacked
    ? Math.max(GRID_TOP_PX, Math.ceil(legend.bottom + 2 + NAME_HEIGHT_PX + NAME_UNDER_LEGEND_GAP_PX))
    : GRID_TOP_PX;
  return { offsets, left, right, top, nameGap: stacked ? NAME_UNDER_LEGEND_GAP_PX : NAME_DEFAULT_GAP_PX, stacked, legendRows: legend.rows };
}
// axis-layout:end

// The legend wrap and the name row depend on the chart width, which changes without a
// re-render (放大圖表, rotation, window resize). Re-derive just the layout and merge it in;
// zoom state and series are untouched.
let axisLayoutInput = null, layoutAppliedKey = "";
const layoutKey = (layout, width) => JSON.stringify([width, layout.offsets, layout.left, layout.right, layout.top, layout.nameGap]);
function relayoutAxes() {
  if (!axisLayoutInput || !chart || chart.isDisposed()) return;
  const width = chart.getWidth();
  const layout = computeAxisLayout(axisLayoutInput.axes, axisLayoutInput.legendNames, width);
  const key = layoutKey(layout, width);
  if (key === layoutAppliedKey) return;
  layoutAppliedKey = key;
  chart.setOption({
    grid: { left: layout.left, right: layout.right, top: layout.top },
    yAxis: axisLayoutInput.ids.map((id, i) => ({ id, offset: layout.offsets[i], nameGap: layout.nameGap })),
  });
}

export function render() {
  const series = [];
  const axisClr  = PALETTE.muted;
  const gridClr  = PALETTE.grid;
  const tipBg    = PALETTE.bg;
  const tipBdr   = PALETTE.border;
  const tipText  = PALETTE.text;

  const yAxisDef = [
    { id: "price", name: "USD Price", position: "left",
      min: v => Math.floor(v.min * 0.9), max: v => Math.ceil(v.max * 1.1),
      axisLine: { lineStyle: { color: axisClr } },
      splitLine: { lineStyle: { color: gridClr } } },
    { id: "vix",  name: "VIX/VXN",  position: "right",
      min: v => Math.floor(v.min * 0.9), max: v => Math.ceil(v.max * 1.1),
      axisLine: { lineStyle: { color: "#f0883e" } }, splitLine: { show: false } },
    { id: "fg",   name: "F&G",  position: "right", min: 0, max: 100,
      axisLine: { lineStyle: { color: "#e3b341" } }, splitLine: { show: false } },
    { id: "tw",   name: "TWD",  position: "left",
      min: v => Math.floor(v.min * 0.9), max: v => Math.ceil(v.max * 1.1),
      axisLine: { lineStyle: { color: "#3fb950" } }, splitLine: { show: false } },
    { id: "btc",  name: "BTC",  position: "right",
      min: v => Math.floor(v.min * 0.9), max: v => Math.ceil(v.max * 1.1),
      axisLine: { lineStyle: { color: "#f7931a" } }, splitLine: { show: false } },
  ];

  const fpeYIdx = trendFpeActive && trendFpeData ? yAxisDef.length : -1;
  if (fpeYIdx >= 0) {
    yAxisDef.push({ id:"fpe", name:"FPE", position:"right",
      min: v => Math.floor(v.min - 1), max: v => Math.ceil(v.max + 1),
      axisLabel: { formatter: v => `${v}x`, color:"#58a6ff", fontSize:11 },
      axisLine: { lineStyle:{ color:"#58a6ff" } }, splitLine:{ show:false } });
  }

  for (const s of [...SERIES, ...TREND_EXTRA, ...customSeries]) {
    const rows = seriesData(s);
    if (!active.has(s.key) || !rows) continue;
    series.push({
      name: s.key,
      type: "line",
      data: filterRange(rows),
      yAxisIndex: s.yAxis,
      showSymbol: false,
      lineStyle: s.high ? { width: 1, color: s.color, type: "dotted" } : { width: 1.5, color: s.color },
      itemStyle: { color: s.color },
      emphasis: { focus: "series" },
    });
  }

  if (maActive.size > 0) {
    for (const s of [...SERIES, ...customSeries]) {
      if (!active.has(s.key) || !loaded[s.key] || MA_SKIP.has(s.key)) continue;
      for (const period of maActive) {
        const maData   = computeMA(loaded[s.key], period);
        const filtered = filterRange(maData);
        series.push({
          name: `__ma_${s.key}_${period}`,
          type: "line",
          data: filtered,
          yAxisIndex: s.yAxis,
          showSymbol: false,
          lineStyle: { width: 1, color: s.color, type: "dashed", opacity: 0.55 },
          itemStyle:  { color: s.color },
          silent: true,
          tooltip: {
            formatter: () => "",
            show: true,
          },
        });
      }
    }
  }

  if (fearActive && loaded["F&G"]) {
    const DEEP = 15;
    const markAreaData = [
      ...fearZones(fearThreshold).map(([s, e]) => [
        { xAxis: s, itemStyle: { color: "rgba(239,68,68,0.10)" } },
        { xAxis: e },
      ]),
      ...(fearThreshold > DEEP ? fearZones(DEEP) : []).map(([s, e]) => [
        { xAxis: s, itemStyle: { color: "rgba(185,28,28,0.22)" } },
        { xAxis: e },
      ]),
    ];
    series.push({
      name: "__fearZone",
      type: "line",
      data: [],
      yAxisIndex: 0,
      lineStyle: { width: 0 },
      symbol: "none",
      silent: true,
      markArea: { silent: true, data: markAreaData },
    });
  }

  if (sigZoneActive && loaded["QQQ"]) {
    if (!state.sigMaps) buildSigMaps();
    if (state.sigMaps?.scoreArr) {
      const zones = scoreZones(state.sigMaps.scoreArr);
      if (zones.length) {
        series.push({
          name: "__sigZone", type: "line", data: [], yAxisIndex: 0,
          lineStyle: { width: 0 }, symbol: "none", silent: true,
          markArea: { silent: true, data: zones.map(([s, e]) => [
            { xAxis: s, itemStyle: { color: "rgba(63,185,80,0.13)" } },
            { xAxis: e },
          ])},
        });
      }
    }
  }

  if (ddZoneActive && loaded["QQQ"]) {
    const zones = computeDDZones(loaded["QQQ"], 60, 0.10);
    if (zones.length) {
      series.push({
        name: "__ddZone", type: "line", data: [], yAxisIndex: 0,
        lineStyle: { width: 0 }, symbol: "none", silent: true,
        markArea: { silent: true, data: zones.map(([s, e]) => [
          { xAxis: s, itemStyle: { color: "rgba(248,81,73,0.10)" } },
          { xAxis: e },
        ])},
      });
    }
  }

  if (fpeYIdx >= 0 && trendFpeData) {
    const fpeInterp = interpFpe(trendFpeData);
    series.push({
      name: "QQQ FPE", type: "line",
      data: filterRange(fpeInterp),
      yAxisIndex: fpeYIdx,
      showSymbol: false,
      connectNulls: false,
      lineStyle: { color: "#58a6ff", width: 1.5 },
      itemStyle: { color: "#58a6ff" },
      emphasis: { focus: "series" },
    });
  }

  if (loaded["QQQ"] && loaded["F&G"]) {
    const qqqD   = loaded["QQQ"];
    const ma200B = computeMA(qqqD, 200);
    const { bounceSignals, bounceRetMap } = computeBounceSignals(qqqD, loaded["F&G"], ma200B);
    const filteredBouncePoints = filterRange(bounceSignals);
    if (filteredBouncePoints.length) {
      series.push({
        name: "__bounceSignal",
        type: "scatter",
        data: filteredBouncePoints,
        xAxisIndex: 0,
        yAxisIndex: 0,
        symbol: "triangle",
        symbolSize: 10,
        itemStyle: { color: "#f97316", opacity: 0.85 },
        z: 5,
        legendHoverLink: false,
        tooltip: {
          trigger: "item",
          formatter: p => {
            const info = bounceRetMap.get(p.data[0]);
            return `<b>${p.data[0]}</b><br/>恐慌反彈<br/>QQQ: $${(+p.data[1]).toFixed(2)}<br/>單日: +${((info?.ret ?? 0) * 100).toFixed(2)}%`;
          },
        },
      });
    }
  }

  // Presentation only: an axis that nothing plots on is hidden (line, ticks, labels, name).
  // Axis ids, positions, min/max functions and series bindings are untouched; only `offset`
  // (stacking of the visible axes), name placement and the grid margins are derived below.
  const usedAxes = usedAxisIndexes(series);
  yAxisDef.forEach((axis, i) => { if (!usedAxes.has(i)) axis.show = false; });
  const legendNames = series.filter(s => !s.name.startsWith("__")).map(s => s.name);
  axisLayoutInput = {
    ids: yAxisDef.map(axis => axis.id), legendNames,
    axes: yAxisDef.map((axis, i) => ({
      position: axis.position, name: axis.name, used: usedAxes.has(i),
      labelW: usedAxes.has(i) ? axisLabelWidth(axis, seriesExtent(series, i)) : 0,
    })),
  };
  const layout = computeAxisLayout(axisLayoutInput.axes, legendNames, chart.getWidth());
  layoutAppliedKey = layoutKey(layout, chart.getWidth());
  yAxisDef.forEach((axis, i) => { axis.offset = layout.offsets[i]; axis.nameGap = layout.nameGap; });

  chart.setOption({
    backgroundColor: "transparent",
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "cross" },
      backgroundColor: tipBg,
      borderColor: tipBdr,
      textStyle: { color: tipText },
      formatter(params) {
        let out = `<b>${params[0]?.axisValueLabel}</b><br/>`;
        for (const p of params) {
          if (p.seriesName.startsWith("__")) continue;
          out += `<span style="color:${p.color}">●</span> ${p.seriesName}: <b>${
            typeof p.value?.[1] === "number" ? p.value[1].toLocaleString() : "—"
          }</b><br/>`;
        }
        return out;
      },
    },
    legend: {
      data: series.filter(s => !s.name.startsWith("__")).map(s => s.name),
      textStyle: { color: tipText },
      top: 6,
    },
    grid: { left: layout.left, right: layout.right, top: layout.top, bottom: 56 },
    xAxis: {
      type: "time",
      axisLine: { lineStyle: { color: axisClr } },
      axisLabel: { hideOverlap: true }, // many y axes leave a narrow plot (phone portrait): drop date labels that would collide
      splitLine: { show: false },
    },
    yAxis: yAxisDef,
    dataZoom: [
      { type: "inside" },
      { type: "slider", height: 18, bottom: 14 },
    ],
    series,
  }, { notMerge: true });
}

// ── Series picker ──────────────────────────────────────────────
export function renderSeriesPicker() {
  const wrap = document.getElementById("series-picker");
  wrap.innerHTML = "";
  for (const s of SERIES) {
    const on = active.has(s.key);
    const el = document.createElement("span");
    el.className = "chip";
    el.textContent = s.key;
    el.style.borderColor = on ? s.color : "";
    el.style.color       = on ? s.color : "";
    el.onclick = async () => {
      if (active.has(s.key)) { active.delete(s.key); }
      else {
        try { await loadSeries(s); active.add(s.key); }
        catch (err) { showLoadError(s.key, err); return; }
      }
      renderSeriesPicker();
      render();
      if (fearActive) renderFearPanel();
    };
    wrap.appendChild(el);
  }
  for (const s of TREND_EXTRA) {
    const on = active.has(s.key);
    const el = document.createElement("span");
    el.className = "chip";
    el.textContent = s.key;
    if (s.high) el.dataset.tooltip = `${s.src.key} 當日盤中最高價（虛線）`;
    el.style.borderColor = on ? s.color : "";
    el.style.color       = on ? s.color : "";
    el.onclick = async () => {
      if (active.has(s.key)) { active.delete(s.key); }
      else {
        try { await loadSeries(s.high ? s.src : s); active.add(s.key); }
        catch (err) { showLoadError(s.key, err); return; }
      }
      renderSeriesPicker();
      render();
    };
    wrap.appendChild(el);
  }
  for (const s of customSeries) {
    const on = active.has(s.key);
    const el = document.createElement("span");
    el.className = "chip";
    el.style.borderColor = on ? s.color : "";
    el.style.color       = on ? s.color : "";
    el.style.fontStyle   = "italic";
    const label = document.createTextNode(s.key + " ");
    const x = document.createElement("span");
    x.textContent = "×";
    x.className = "chip-x";
    x.style.cssText = "opacity:.55;cursor:pointer;font-style:normal";
    x.onclick = e => {
      e.stopPropagation();
      const idx = customSeries.indexOf(s);
      if (idx !== -1) customSeries.splice(idx, 1);
      active.delete(s.key);
      delete loaded[s.key]; delete loadedHLC[s.key]; delete loadedVol[s.key];
      renderSeriesPicker(); render();
    };
    el.appendChild(label); el.appendChild(x);
    el.onclick = () => {
      if (active.has(s.key)) active.delete(s.key); else active.add(s.key);
      renderSeriesPicker(); render();
    };
    wrap.appendChild(el);
  }
}

// ── Load-failure wording for #status ───────────────────────────
// requestJSON (data.js) throws plain Errors without a status field, so the kind is read
// from its known, anchored formats ("<label>: HTTP 404", "<label>: invalid JSON" with a
// SyntaxError cause, "<label>: request timed out after Nms" with an AbortError cause, a
// TypeError cause for network failures) and from loadSeries' own validation messages.
// Anything else is "unknown": fixed wording, no raw message text (it may contain URLs).
const LOAD_REASON = {
  timeout: "連線逾時", network: "網路連線失敗", json: "資料格式錯誤",
  incomplete: "資料內容不完整", nodata: "無資料",
};
function classifyLoadError(err) {
  if (err?.name === "AbortError") return { kind: "abort" };
  if (err?.tickerNotFound) return { kind: "notfound" };
  if (err?.noData) return { kind: "nodata" };
  const message = typeof err?.message === "string" ? err.message : "";
  const causeName = err?.cause?.name;
  const http = message.match(/^\S+: HTTP (\d{3})$/);
  if (http) return { kind: "http", status: Number(http[1]) };
  if (causeName === "AbortError" && /^\S+: request timed out after \d+ms$/.test(message)) return { kind: "timeout" };
  if (causeName === "AbortError") return { kind: "abort" }; // cancelled from outside (e.g. navigation), not our timeout
  if (causeName === "SyntaxError" && /^\S+: invalid JSON$/.test(message)) return { kind: "json" };
  if (causeName === "TypeError" && /^\S+: /.test(message)) return { kind: "network" };
  if (/^\S+: (missing or empty data rows|missing data rows|invalid (HLC |volume )?row \d+)$/.test(message)) return { kind: "incomplete" };
  return { kind: "unknown" };
}

// Text for the status line, or null when nothing should be shown (cancelled by navigation).
function loadErrorText(subject, err) {
  const info = classifyLoadError(err);
  console.debug("[trend] load failed:", subject, err);
  if (info.kind === "abort") return null;
  if (info.kind === "notfound") return `⚠ 找不到代號 ${subject}（本地無資料，Yahoo 也查無此代號）`;
  if (info.kind === "http") return `⚠ 無法載入 ${subject}：伺服器回應 ${info.status}`;
  if (LOAD_REASON[info.kind]) return `⚠ 無法載入 ${subject}：${LOAD_REASON[info.kind]}`;
  return `⚠ 載入 ${subject} 失敗，請稍後再試`;
}
// Chip / FPE / fear failures report at the moment they happen. They take part in the ticker
// box's status rule (below) as an immediately final participant with the next sequence number:
// while a ticker request is pending, a later ticker result cannot overwrite them, and a ticker
// submitted afterwards (higher number) shows its own progress and result as usual. A cancelled
// load (text === null) takes no number and shows nothing.
function showLoadError(subject, err) {
  const text = loadErrorText(subject, err);
  if (text === null) return;
  const status = document.getElementById("status");
  const run = ++tickerPeriod.seq;
  if (hasPendingTickerRun()) {
    tickerPeriod.runs.set(run, { state: "final", progress: null, text });
    recomputeTickerStatus(status);
  } else {
    if (status.textContent !== text) status.textContent = text; // no busy period: written directly, becomes the next baseline
  }
}

// ── Ticker-box requests: one status rule, one data rule ───────────────────
// A "busy period" starts when a request is submitted while none is pending (the text on
// screen then is its baseline) and ends when none is pending. Every request finishes as
//   final  - its success or error message, or
//   silent - cancelled, or superseded by a newer request for the same code.
// Chip / FPE / fear load errors join the same numbering (see showLoadError) as immediately
// final participants. After every submit, settle and such error, the status line is
// recomputed from one rule:
// the request with the highest sequence number that is not silent decides - its
// "loading…" line while pending, its message once final; if every request of the period
// is silent, the baseline. So a "loading…" line never outlives its request, and an older
// request never overwrites a newer one.
const tickerPeriod = { seq: 0, baseline: "", runs: new Map() }; // run -> { state, progress, text }
// Data: only the newest request for a code may write loaded*/customSeries (strict
// latest-wins, whether the newer one succeeds, fails or is cancelled), so an older, slower
// request for the same code never puts old rows on the chart.
const latestRunByCode = new Map();

const hasPendingTickerRun = () => [...tickerPeriod.runs.values()].some(r => r.state === "pending");
function recomputeTickerStatus(status) {
  let best = null;
  for (const [run, r] of tickerPeriod.runs) if (r.state !== "silent" && (best === null || run > best)) best = run;
  const r = best === null ? null : tickerPeriod.runs.get(best);
  const text = r === null ? tickerPeriod.baseline : (r.state === "pending" ? r.progress : r.text);
  if (status.textContent !== text) status.textContent = text; // no redundant DOM write / re-announcement
  if (!hasPendingTickerRun()) tickerPeriod.runs.clear(); // period over
}
function beginTickerRun(status, progress) {
  if (!hasPendingTickerRun()) { tickerPeriod.runs.clear(); tickerPeriod.baseline = status.textContent; }
  const run = ++tickerPeriod.seq;
  tickerPeriod.runs.set(run, { state: "pending", progress, text: null });
  recomputeTickerStatus(status);
  return run;
}
// text === null: silent (nothing to report).
function settleTickerRun(status, run, text) {
  const r = tickerPeriod.runs.get(run);
  if (!r || r.state !== "pending") return;
  if (text === null) r.state = "silent"; else { r.state = "final"; r.text = text; }
  recomputeTickerStatus(status);
}

async function loadCustomTicker(rawSymbol) {
  const key = rawSymbol.trim().toUpperCase();
  if (!key) return;
  const status = document.getElementById("status");
  const run = beginTickerRun(status, `載入 ${key} 中…`);
  latestRunByCode.set(key, run);
  let settled = false;
  // A request superseded by a newer one for the same code is silent whatever its outcome.
  const finish = text => {
    if (settled) return;
    settled = true;
    settleTickerRun(status, run, latestRunByCode.get(key) === run ? text : null);
  };

  try {
    // Built-in series (SERIES / TREND_EXTRA) go through the same loader as their chips.
    // loadSeries shares requestJSON's per-URL de-duplication, so concurrent requests for the
    // same built-in code receive the same payload and need no commit ordering here.
    const known = TREND_EXTRA.find(s => s.key === key) || SERIES.find(s => s.key === key);
    if (known) {
      const source = known.high ? known.src : known;
      await loadSeries(source);
      active.add(key);
      renderSeriesPicker();
      render();
      if (fearActive && SERIES.includes(known)) renderFearPanel();
      finish(`已顯示 ${key}`);
      return;
    }
    if (customSeries.find(s => s.key === key)) {
      active.add(key);
      renderSeriesPicker();
      render();
      finish(`已顯示 ${key}`);
      return;
    }

    let j;
    try {
      j = await requestJSON(`data/${key}.json`);
    } catch (error) {
      const local = classifyLoadError(error);
      if (local.kind !== "http" || local.status !== 404) throw error;
      try {
        j = await requestJSON(`/api/stock?ticker=${encodeURIComponent(key)}`);
      } catch (apiError) {
        // "Not found" only when the local file and the API each answered 404.
        const api = classifyLoadError(apiError);
        if (api.kind === "http" && api.status === 404) throw Object.assign(new Error("ticker not found"), { tickerNotFound: true });
        throw apiError;
      }
    }
    if (!Array.isArray(j?.data)) throw Object.assign(new Error("no data"), { noData: true });

    const rows = (j.data || []).filter(r => r.close != null);
    if (!rows.length) throw Object.assign(new Error("no data"), { noData: true });

    // A newer request for this code exists: it alone decides what is shown for this code.
    if (latestRunByCode.get(key) !== run) { finish(null); return; }

    loaded[key]    = rows.map(r => [r.date, r.close]);
    loadedHLC[key] = rows.map(r => [r.date, r.high, r.low, r.close]);
    loadedVol[key] = rows.map(r => [r.date, r.volume ?? 0]);
    state.sigMaps = null;

    if (!customSeries.find(s => s.key === key)) {
      const color = CUSTOM_COLORS[customSeries.length % CUSTOM_COLORS.length];
      customSeries.push({ key, file: null, color, yAxis: 0, custom: true });
    }
    active.add(key);

    renderSeriesPicker();
    render();
    const latest = rows[rows.length - 1].date;
    finish(`已載入 ${key}（${rows.length} 筆，至 ${latest}）`);
  } catch (err) {
    // Keep the error until the next load action overwrites it.
    finish(loadErrorText(key, err));
  } finally {
    finish(null); // any path that did not report (e.g. cancelled): never leave "loading…" behind
  }
}

// ── Tab module API ─────────────────────────────────────────────
export async function activate(context = {}) {
  const sources = new Map([...SERIES, ...TREND_EXTRA].filter(s => active.has(s.key))
    .map(s => s.high ? s.src : s).map(s => [s.key, s]));
  await Promise.all([...sources.values()].map(s => loadSeries(s, context)));
  if (context.signal?.aborted || (context.isCurrent && !context.isCurrent())) return;
  await new Promise(resolve => setTimeout(resolve, 50));
  if (context.signal?.aborted || (context.isCurrent && !context.isCurrent())) return;
  chart.resize();
  renderSeriesPicker();
  render();
}

export function onThemeChange(light) {
  chart.dispose();
  chart = echarts.init(chartEl, light ? null : "dark");
  // Re-attach event handlers
  chart.on("updateAxisPointer", evt => {
    try {
      const ts = evt?.axesInfo?.[0]?.value;
      if (typeof ts !== "number") return;
      renderSignalPanel(tsToLocalDate(ts));
    } catch (_) {}
  });
  chart.on("globalout", () => { if (state.sigMaps) renderSignalPanel(); });
  render();
}

export function resize() {
  chart?.resize();
  relayoutAxes();
}

export async function toggleTrendFpe() {
  trendFpeActive = !trendFpeActive;
  document.getElementById("trend-fpe-toggle")?.classList.toggle("active", trendFpeActive);
  if (trendFpeActive && !trendFpeData) {
    try {
      const j = await requestJSON("data/QQQ_valuation.json");
      if (!Array.isArray(j?.data) || !j.data.length) throw new Error("QQQ_valuation: missing data rows");
      trendFpeData = j.data.slice().sort((a, b) => a.date < b.date ? -1 : 1);
    } catch (e) {
      trendFpeActive = false;
      document.getElementById("trend-fpe-toggle")?.classList.remove("active");
      showLoadError("前瞻本益比", e);
      return;
    }
  }
  render();
}

// ── Wire trend-tab controls ────────────────────────────────────
// Single moving average: preset periods in a <select>, or a custom period.
function setMA(period) {
  maActive.clear();
  if (Number.isInteger(period) && period >= 2) maActive.add(period);
  const chartState = captureChartState(chart);
  render();
  restoreChartState(chart, chartState);
}

(function () {
  const select = document.getElementById("ma-select");
  const custom = document.getElementById("ma-custom");
  if (!select) return;
  const customPeriod = () => {
    const n = Number(custom?.value);
    return Number.isInteger(n) && n >= 2 && n <= 2000 ? n : null;
  };
  const applyCustom = () => { const n = customPeriod(); if (n) setMA(n); };
  select.addEventListener("change", () => {
    const v = select.value;
    if (custom) custom.hidden = v !== "custom";
    if (v === "custom") {
      const n = customPeriod();
      setMA(n);
      if (!n) custom?.focus();
      return;
    }
    setMA(v ? +v : null);
  });
  let maTimer = null;
  custom?.addEventListener("input", () => {
    clearTimeout(maTimer);
    maTimer = setTimeout(applyCustom, 300);
  });
  custom?.addEventListener("keydown", e => {
    if (e.key === "Enter") { clearTimeout(maTimer); applyCustom(); }
  });
})();

(function () {
  const input = document.getElementById("custom-ticker-input");
  const btn   = document.getElementById("custom-ticker-btn");
  if (!input || !btn) return;
  function submit() {
    const val = input.value.trim();
    if (!val) return;
    input.value = "";
    void loadCustomTicker(val);
  }
  btn.addEventListener("click", submit);
  input.addEventListener("keydown", e => { if (e.key === "Enter") submit(); });
})();

document.getElementById("fear-toggle")?.addEventListener("click", async () => {
  fearActive = !fearActive;
  document.getElementById("fear-toggle").classList.toggle("fear-on", fearActive);
  if (fearActive) {
    try { await Promise.all([ensureLoaded("F&G"), ensureLoaded("SPY")]); }
    catch (err) {
      fearActive = false;
      document.getElementById("fear-toggle").classList.remove("fear-on");
      showLoadError("F&G／SPY", err);
      return;
    }
  }
  render();
  renderFearPanel();
});

document.getElementById("dd-toggle")?.addEventListener("click", () => {
  ddZoneActive = !ddZoneActive;
  document.getElementById("dd-toggle").classList.toggle("active", ddZoneActive);
  render();
});

document.getElementById("sig-zone-toggle")?.addEventListener("click", () => {
  sigZoneActive = !sigZoneActive;
  document.getElementById("sig-zone-toggle").classList.toggle("active", sigZoneActive);
  render();
});

let fThreshTimer = null;
document.getElementById("fear-threshold")?.addEventListener("input", e => {
  clearTimeout(fThreshTimer);
  fThreshTimer = setTimeout(() => {
    const v = parseInt(e.target.value);
    if (!isNaN(v) && v >= 1 && v <= 99) {
      fearThreshold = v;
      render();
      if (fearActive) renderFearPanel();
    }
  }, 300);
});

chipPicker(document.getElementById("range-picker"), "range", v => {
  state.rangePreset = v;
  state.customFrom = ""; state.customTo = "";
  if (dateFrom) dateFrom.value = "";
  if (dateTo)   dateTo.value = "";
  render();
});

function onDateChange() {
  state.customFrom = dateFrom.value;
  state.customTo   = dateTo.value;
  if (state.customFrom || state.customTo)
    for (const c of document.querySelectorAll("#range-picker .chip"))
      c.classList.remove("active");
  render();
}
dateFrom?.addEventListener("change", onDateChange);
dateTo?.addEventListener("change", onDateChange);

if (dateTo) {
  // check_reuse: keep — new Date() 取今天的日期字串,共用層無對應 helper
  dateTo.value = new Date().toISOString().slice(0, 10);
  dateTo.max   = dateTo.value;
}

export function getCharts() { return chart ? [chart] : []; }
