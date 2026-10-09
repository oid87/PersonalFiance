import {
  SERIES, CUSTOM_COLORS, customSeries, active, maActive,
  loaded, loadedHLC, loadedVol, state,
} from '../state.js';
import { tc, mob, PALETTE } from '../utils/theme.js';
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
export function render() {
  const series = [];
  const axisClr  = PALETTE.muted;
  const gridClr  = PALETTE.grid;
  const tipBg    = PALETTE.bg;
  const tipBdr   = PALETTE.border;
  const tipText  = PALETTE.text;

  const isMob = mob();
  const yAxisDef = [
    { id: "price", name: "USD Price", position: "left",
      min: v => Math.floor(v.min * 0.9), max: v => Math.ceil(v.max * 1.1),
      axisLine: { lineStyle: { color: axisClr } },
      splitLine: { lineStyle: { color: gridClr } } },
    { id: "vix",  name: "VIX/VXN",  position: "right",
      min: v => Math.floor(v.min * 0.9), max: v => Math.ceil(v.max * 1.1),
      axisLine: { lineStyle: { color: "#f0883e" } }, splitLine: { show: false } },
    { id: "fg",   name: "F&G",  position: "right", offset: isMob ? 35 : 55, min: 0, max: 100,
      axisLine: { lineStyle: { color: "#e3b341" } }, splitLine: { show: false } },
    { id: "tw",   name: "TWD",  position: "left",  offset: isMob ? 45 : 70,
      min: v => Math.floor(v.min * 0.9), max: v => Math.ceil(v.max * 1.1),
      axisLine: { lineStyle: { color: "#3fb950" } }, splitLine: { show: false } },
    { id: "btc",  name: "BTC",  position: "right", offset: isMob ? 65 : 110,
      min: v => Math.floor(v.min * 0.9), max: v => Math.ceil(v.max * 1.1),
      axisLine: { lineStyle: { color: "#f7931a" } }, splitLine: { show: false } },
  ];

  const fpeYIdx = trendFpeActive && trendFpeData ? yAxisDef.length : -1;
  if (fpeYIdx >= 0) {
    yAxisDef.push({ id:"fpe", name:"FPE", position:"right", offset: isMob ? 95 : 150,
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
    grid: { left: isMob ? 75 : 115, right: isMob ? 100 : 160, top: 44, bottom: 56 },
    xAxis: {
      type: "time",
      axisLine: { lineStyle: { color: axisClr } },
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
        catch (err) { document.getElementById("status").textContent = `載入失敗：${err.message}`; return; }
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
        catch (err) { document.getElementById("status").textContent = `載入失敗：${err.message}`; return; }
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

async function loadCustomTicker(rawSymbol) {
  const key = rawSymbol.trim().toUpperCase();
  if (!key) return;
  const extra = TREND_EXTRA.find(s => s.key === key);
  if (extra) {
    try { await loadSeries(extra.high ? extra.src : extra); } catch (err) {
      document.getElementById("status").textContent = `⚠ 無法載入 ${key}：${err.message}`;
      return;
    }
  }
  if (extra || SERIES.find(s => s.key === key) || customSeries.find(s => s.key === key)) {
    active.add(key);
    renderSeriesPicker();
    render();
    return;
  }

  const status = document.getElementById("status");
  status.textContent = `載入 ${key} 中…`;

  try {
    let j;
    try {
      j = await requestJSON(`data/${key}.json`);
    } catch (error) {
      if (!/HTTP 404/.test(error.message)) throw error;
      j = await requestJSON(`/api/stock?ticker=${encodeURIComponent(key)}`);
    }
    if (!Array.isArray(j?.data)) throw new Error("無資料");

    const rows = (j.data || []).filter(r => r.close != null);
    if (!rows.length) throw new Error("無資料");

    loaded[key]    = rows.map(r => [r.date, r.close]);
    loadedHLC[key] = rows.map(r => [r.date, r.high, r.low, r.close]);
    loadedVol[key] = rows.map(r => [r.date, r.volume ?? 0]);
    state.sigMaps = null;

    const color = CUSTOM_COLORS[customSeries.length % CUSTOM_COLORS.length];
    customSeries.push({ key, file: null, color, yAxis: 0, custom: true });
    active.add(key);

    renderSeriesPicker();
    render();
    const latest = rows[rows.length - 1].date;
    status.textContent = `已載入 ${key}（${rows.length} 筆，至 ${latest}）`;
  } catch (err) {
    status.textContent = `⚠ 無法載入 ${key}：${err.message}`;
    setTimeout(() => { status.textContent = ""; }, 5000);
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
      document.getElementById("status").textContent = `前瞻本益比暫無資料：${e.message}`;
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
      document.getElementById("status").textContent = `載入失敗：${err.message}`;
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
