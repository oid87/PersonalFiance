// VIX-SKEW 序列背離警報 tab
// 三面板：① SPY 指數化走勢 ② VIX（左Y）+ SKEW（右Y）雙軸 ③ 背離分數柱狀圖
// 信號：序列式（同步上升→VIX回落/SKEW維持），標記在圖上並列出回測結果
// 歷史覆蓋：1993年起（SKEW 起始點）
// 另加兩面板：④ VIX 期限結構（VIX/VIX3M ts_ratio，backwardation=恐慌，2006起）
//            ⑤ 美股 Total Put/Call Ratio（OCC+CBOE 拼接，2006起）

import { isLight, tc, mob, PALETTE } from '../utils/theme.js';
import { requestJSON, clearRequestCache } from '../utils/data.js';
import { rangeStart as calcRangeStart, mainChartModel, termStructureModel, putCallModel, complacencyModel } from './vixskew_calc.mjs';

let chart   = null;
let tsChart = null;
let pcChart = null;
let cxChart = null;
let vsData  = null;
let pcData  = null;
let vsRange = "5Y";
let controlsBound = false;

// ── public ───────────────────────────────────────────────────────────────────

export async function init(context = {}) {
  const status = document.getElementById("vs-status");
  if (vsData && pcData) { if (context.signal?.aborted || context.isCurrent?.() === false) return; renderAll(); return; }
  status.textContent = "載入中…";
  try {
    const next = await requestJSON("data/vix_skew.json", { signal: context.signal });
    if (!Array.isArray(next?.history) || !next.history.length || !Array.isArray(next?.signals)) {
      clearRequestCache("data/vix_skew.json"); throw new Error("VIX-SKEW: missing required history/signals");
    }
    if (context.signal?.aborted || context.isCurrent?.() === false) throw new DOMException("Activation expired", "AbortError");
    vsData = next;

    if (!controlsBound) {
      controlsBound = true;
      document.querySelectorAll("[data-vs-range]").forEach(el =>
      el.addEventListener("click", () => {
        vsRange = el.dataset.vsRange;
        document.querySelectorAll("[data-vs-range]")
          .forEach(e => e.classList.toggle("active", e.dataset.vsRange === vsRange));
        renderChart();
        renderTSChart();
        renderPCChart();
      }));
    }

    renderAll();
    status.textContent =
      `VIX-SKEW · ${vsData.history.length} 個交易日 · ${vsData.signals.length} 次序列信號 · 更新至 ${vsData.updated}`;
  } catch (err) {
    status.textContent = `載入失敗：${err.message}`;
    console.error("[vixskew]", err);
    throw err;
  }

  const tsStatus = document.getElementById("vts-status");
  const pcStatus = document.getElementById("pc-status");
  try {
    const nextPc = await requestJSON("data/putcall.json", { signal: context.signal });
    if (!Array.isArray(nextPc?.total) || !nextPc.total.length || !Array.isArray(nextPc?.equity)) {
      clearRequestCache("data/putcall.json"); throw new Error("Put/Call: missing rows");
    }
    if (context.signal?.aborted || context.isCurrent?.() === false) throw new DOMException("Activation expired", "AbortError");
    pcData = nextPc;
    renderPCChart();
    if (pcStatus)
      pcStatus.textContent =
        `美股 Put/Call · ${pcData.total.length} 個交易日 · 更新至 ${pcData.updated}`;
  } catch (err) {
    if (context.signal?.aborted || context.isCurrent?.() === false) throw err;
    if (pcStatus) pcStatus.textContent = `載入失敗：${err.message}`;
    console.error("[vixskew:putcall]", err);
  }

  if (vsData) {
    renderTSChart();
    const tsRows = (vsData.term_structure || []);
    if (tsStatus)
      tsStatus.textContent = tsRows.length
        ? `VIX 期限結構 · ${tsRows.length} 個交易日 · 更新至 ${vsData.updated}`
        : "無期限結構資料";
  }
}

export function onThemeChange() {
  if (chart)   { chart.dispose();   chart   = null; if (vsData) renderChart(); }
  if (tsChart) { tsChart.dispose(); tsChart = null; if (vsData) renderTSChart(); }
  if (pcChart) { pcChart.dispose(); pcChart = null; if (pcData) renderPCChart(); }
  if (cxChart) { cxChart.dispose(); cxChart = null; if (vsData) renderComplacency(); }
}

export function resize() { chart?.resize(); tsChart?.resize(); pcChart?.resize(); cxChart?.resize(); }
export function getCharts() { return [chart, tsChart, pcChart, cxChart].filter(Boolean); }

// ── render helpers ────────────────────────────────────────────────────────────

function renderAll() {
  renderCards();
  renderChart();
  renderTable();
  renderTSChart();
  renderPCChart();
  renderComplacency();
}

function rangeStart(key) {
  // check_reuse: keep — 本地 range cutoff 變體:all 哨兵及預設年數與 dates.presetStart、dates.cutoffDate 不同。
  return calcRangeStart(key, new Date());
}

function retColor(v) {
  if (v == null) return "var(--muted)";
  if (v >  5) return "#3fb950";
  if (v >  0) return "#7ee787";
  if (v > -5) return "#f0883e";
  return "#f85149";
}

// ── cards ─────────────────────────────────────────────────────────────────────

function renderCards() {
  const el = document.getElementById("vs-cards");
  if (!el || !vsData) return;
  const c = vsData.current;

  const seqClr  = c.full_alert ? "#f85149" : c.seq_alert ? "#f0883e" : "#3fb950";
  const seqLbl  = c.full_alert ? "🚨 完整警報" : c.seq_alert ? "⚠️ 已觸發" : "✅ 正常";
  const brdStr  = c.breadth_above200 != null ? `${c.breadth_above200}%` : "—";
  const brdClr  = c.breadth_weak ? "#f85149" : "#3fb950";
  const skewAll = c.skew_pct_all != null ? `全史 p${c.skew_pct_all.toFixed(0)}` : "";

  el.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(${mob()?2:4},1fr);gap:8px;margin-bottom:10px">
      <div class="breadth-card">
        <div class="bc-label">VIX</div>
        <div class="bc-main"><span class="bc-pct" style="color:#f0883e">${c.vix}</span></div>
        <div class="bc-count">2Y 百分位 ${c.vix_pct_2y}%</div>
        <div class="bc-signal" style="color:var(--muted)">距峰值 ${c.vix_from_peak}%</div>
      </div>
      <div class="breadth-card">
        <div class="bc-label">SKEW（尾部避險）</div>
        <div class="bc-main"><span class="bc-pct" style="color:#17a2b8">${c.skew}</span></div>
        <div class="bc-count">${skewAll}</div>
        <div class="bc-signal" style="color:var(--muted)">距峰值 ${c.skew_from_peak}%</div>
      </div>
      <div class="breadth-card">
        <div class="bc-label">序列背離訊號</div>
        <div class="bc-main"><span class="bc-pct" style="font-size:1.1rem;color:${seqClr}">${seqLbl}</span></div>
        <div class="bc-count">VIX↓${Math.abs(c.vix_from_peak)}% · SKEW 維持</div>
        <div class="bc-signal" style="color:var(--muted)">背離分數 ${c.div_score}</div>
      </div>
      <div class="breadth-card">
        <div class="bc-label">市寬（>200MA）</div>
        <div class="bc-main"><span class="bc-pct" style="color:${brdClr}">${brdStr}</span></div>
        <div class="bc-count">趨勢：${c.bear_trend ? "⚠️ SPY < 200MA" : "✅ SPY > 200MA"}</div>
        <div class="bc-signal" style="color:${c.full_alert?'#f85149':c.seq_alert?'#f0883e':'var(--muted)'}">
          ${c.full_alert ? "完整警報觸發" : c.seq_alert ? "減倉觀察期" : "目前安全區"}
        </div>
      </div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;font-size:12px;align-items:center">
      <span style="color:var(--muted)">條件核查：</span>
      ${chip(c.seq_alert,    "①序列背離")}
      ${chip(c.bear_trend,   "②趨勢反轉（SPY<200MA）")}
      ${chip(c.breadth_weak, "③市寬<50%")}
      <span style="margin-left:4px;padding:3px 10px;border-radius:4px;background:var(--card-bg);border:1px solid ${c.full_alert?'#f85149':'var(--border)'};color:${c.full_alert?'#f85149':'var(--muted)'}">
        ${c.full_alert ? "🚨 完整警報（①②同時）" : "完整警報未達"}
      </span>
    </div>`;
}

function chip(on, label) {
  return `<span style="padding:3px 10px;border-radius:4px;background:var(--card-bg);border:1px solid var(--border)">
    ${on ? "✅" : "❌"} ${label}</span>`;
}

// ── chart ─────────────────────────────────────────────────────────────────────

function renderChart() {
  if (!vsData) return;

  const model = mainChartModel(vsData.history, vsData.signals, rangeStart(vsRange));
  if (!model) return;
  const { rows, dates, spyData, vixData, skewData, divData,
    sigSpy, sigVix, vixMax, skMin, skMax } = model;

  const axisClr = PALETTE.muted;
  const gridClr = tc("rgba(255,255,255,0.06)", "rgba(0,0,0,0.06)");
  const tipBg   = PALETTE.bg;
  const tipBdr  = PALETTE.border;
  const tipText = PALETTE.text;
  const isMob   = mob();
  const lp = "7%", rp = "9%";

  const axBase = {
    type: "category", data: dates, boundaryGap: false,
    axisLine:  { lineStyle: { color: gridClr } },
    axisTick:  { show: false },
    splitLine: { lineStyle: { color: gridClr, type: "dashed" } },
  };

  const opt = {
    backgroundColor: "transparent",
    animation: false,
    // Must be declared at option root, not just inside tooltip.axisPointer — otherwise
    // the 3 grids' crosshairs don't actually link despite xAxisIndex:"all" below.
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    grid: [
      { top: "2%",  left: lp, right: rp, height: "33%" },  // SPY
      { top: "41%", left: lp, right: rp, height: "28%" },  // VIX+SKEW
      { top: "76%", left: lp, right: rp, height: "13%" },  // div_score
    ],
    xAxis: [
      { ...axBase, gridIndex: 0, axisLabel: { show: false } },
      { ...axBase, gridIndex: 1, axisLabel: { show: false } },
      { ...axBase, gridIndex: 2, axisLabel: { color: axisClr, fontSize: 10, rotate: isMob ? 30 : 0 } },
    ],
    yAxis: [
      // SPY %
      { gridIndex: 0,
        axisLabel: { color: axisClr, fontSize: 10, formatter: v => v + "%" },
        splitLine: { lineStyle: { color: gridClr, type: "dashed" } },
        axisLine: { show: false }, axisTick: { show: false } },
      // VIX (left of grid 1)
      { gridIndex: 1, min: 0, max: vixMax,
        axisLabel: { color: "#f0883e", fontSize: 10 },
        splitLine: { lineStyle: { color: gridClr, type: "dashed" } },
        axisLine: { show: false }, axisTick: { show: false } },
      // SKEW (right of grid 1)
      { gridIndex: 1, position: "right", min: skMin, max: skMax,
        axisLabel: { color: "#17a2b8", fontSize: 10 },
        splitLine: { show: false },
        axisLine: { show: false }, axisTick: { show: false } },
      // div_score
      { gridIndex: 2,
        axisLabel: { color: axisClr, fontSize: 10 },
        splitLine: { lineStyle: { color: gridClr, type: "dashed" } },
        axisLine: { show: false }, axisTick: { show: false } },
    ],
    series: [
      // ① SPY normalised
      { name: "SPY",
        type: "line", xAxisIndex: 0, yAxisIndex: 0,
        data: spyData, symbol: "none",
        lineStyle: { color: "#58a6ff", width: 1.5 },
        areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [{ offset: 0, color: "rgba(88,166,255,0.2)" }, { offset: 1, color: "transparent" }] } } },
      // ② VIX
      { name: "VIX",
        type: "line", xAxisIndex: 1, yAxisIndex: 1,
        data: vixData, symbol: "none",
        lineStyle: { color: "#f0883e", width: 1.2 } },
      // ③ SKEW
      { name: "SKEW",
        type: "line", xAxisIndex: 1, yAxisIndex: 2,
        data: skewData, symbol: "none",
        lineStyle: { color: "#17a2b8", width: 1.2 } },
      // ④ div_score bars
      { name: "背離分數",
        type: "bar", xAxisIndex: 2, yAxisIndex: 3,
        data: divData,
        barWidth: rows.length > 1500 ? 1 : 2 },
      // threshold line on div_score grid
      { name: "_thr", type: "line", data: [], xAxisIndex: 2, yAxisIndex: 3,
        markLine: { silent: true, symbol: "none",
          lineStyle: { color: "#f85149", type: "dashed", width: 1 },
          label: { formatter: "門檻40", color: "#f85149", fontSize: 9 },
          data: [{ yAxis: 40 }] } },
      // ⑤ Signal triangles on SPY grid
      { name: "信號",
        type: "scatter", xAxisIndex: 0, yAxisIndex: 0,
        data: sigSpy, z: 10,
        symbol: "triangle", symbolSize: 12, symbolRotate: 180,
        itemStyle: { color: "#f85149", borderColor: "#fff", borderWidth: 1 } },
      // ⑥ Signal triangles on VIX grid (same dates, VIX y-values)
      { name: "_sig2",
        type: "scatter", xAxisIndex: 1, yAxisIndex: 1,
        data: sigVix, z: 10,
        symbol: "triangle", symbolSize: 10, symbolRotate: 180,
        itemStyle: { color: "#f85149", borderColor: "#fff", borderWidth: 1 },
        tooltip: { show: false } },
    ],
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "cross", link: [{ xAxisIndex: "all" }] },
      backgroundColor: tipBg, borderColor: tipBdr,
      textStyle: { color: tipText, fontSize: 12 },
      formatter(params) {
        const d = params[0]?.axisValue || "";
        const map = {};
        for (const p of params) {
          if (p.seriesName && !p.seriesName.startsWith("_"))
            map[p.seriesName] = p.value instanceof Array ? p.value[1] : p.value;
        }
        let s = `<b>${d}</b>`;
        if (map["SPY"]    != null) s += `<br>SPY：${map["SPY"] > 0 ? "+" : ""}${map["SPY"]}%`;
        if (map["VIX"]    != null) s += `<br><span style="color:#f0883e">VIX：${map["VIX"]}</span>`;
        if (map["SKEW"]   != null) s += `<br><span style="color:#17a2b8">SKEW：${map["SKEW"]}</span>`;
        if (map["背離分數"] != null) s += `<br>背離分數：${map["背離分數"]}`;
        // Check if this date has a signal
        const sig = vsData.signals.find(sg => sg.date === d);
        if (sig) s += `<br><span style="color:#f85149">⚠️ 序列信號 | 3M後 ${sig.ret_63d != null ? (sig.ret_63d > 0 ? "+" : "") + sig.ret_63d + "%" : "—"}</span>`;
        return s;
      },
    },
    dataZoom: [
      { type: "inside", xAxisIndex: [0, 1, 2], filterMode: "none" },
      { type: "slider",  xAxisIndex: [0, 1, 2], filterMode: "none",
        bottom: 0, height: 22,
        borderColor: gridClr,
        fillerColor: tc("rgba(80,80,80,0.3)", "rgba(200,200,200,0.3)"),
        handleStyle: { color: axisClr },
        textStyle: { color: axisClr, fontSize: 10 } },
    ],
    legend: {
      right: 0, top: 2, itemWidth: 16, itemHeight: 2,
      textStyle: { color: axisClr, fontSize: 11 },
      data: [
        { name: "SPY",     icon: "line",   itemStyle: { color: "#58a6ff" } },
        { name: "VIX",     icon: "line",   itemStyle: { color: "#f0883e" } },
        { name: "SKEW",    icon: "line",   itemStyle: { color: "#17a2b8" } },
        { name: "背離分數", icon: "square", itemStyle: { color: "#f0883e" } },
        { name: "信號",    icon: "pin",    itemStyle: { color: "#f85149" } },
      ],
    },
  };

  if (!chart) {
    chart = echarts.init(
      document.getElementById("vs-chart"),
      isLight() ? null : "dark",
    );
  }
  chart.setOption(opt, { notMerge: true });
}

// ── VIX 期限結構（VIX / VIX3M ts_ratio）────────────────────────────────────────

function renderTSChart() {
  const el = document.getElementById("vts-chart");
  if (!el || !vsData) return;
  const rows = (vsData.term_structure || []).filter(r => r.date >= rangeStart(vsRange));
  if (rows.length < 10) { el.innerHTML = ""; return; }

  const { dates, vixData, v3mData, tsData, backAreas } = termStructureModel(rows);

  const axisClr = PALETTE.muted;
  const gridClr = tc("rgba(255,255,255,0.06)", "rgba(0,0,0,0.06)");
  const tipBg   = PALETTE.bg;
  const tipBdr  = PALETTE.border;
  const tipText = PALETTE.text;
  const isMob   = mob();

  const opt = {
    backgroundColor: "transparent",
    animation: false,
    grid: { top: "12%", left: "7%", right: "9%", bottom: isMob ? "20%" : "14%" },
    xAxis: {
      type: "category", data: dates, boundaryGap: false,
      axisLine: { lineStyle: { color: gridClr } }, axisTick: { show: false },
      axisLabel: { color: axisClr, fontSize: 10, rotate: isMob ? 30 : 0 },
      splitLine: { lineStyle: { color: gridClr, type: "dashed" } },
    },
    yAxis: [
      { name: "VIX 水準", nameTextStyle: { color: axisClr, fontSize: 10 },
        axisLabel: { color: axisClr, fontSize: 10 },
        splitLine: { lineStyle: { color: gridClr, type: "dashed" } },
        axisLine: { show: false }, axisTick: { show: false } },
      { position: "right", axisLabel: { color: "#f0883e", fontSize: 10 },
        splitLine: { show: false }, axisLine: { show: false }, axisTick: { show: false } },
    ],
    series: [
      { name: "VIX",   type: "line", yAxisIndex: 0, data: vixData, symbol: "none",
        lineStyle: { color: "#58a6ff", width: 1.2 } },
      { name: "VIX3M", type: "line", yAxisIndex: 0, data: v3mData, symbol: "none",
        lineStyle: { color: "#8b949e", width: 1.2 } },
      { name: "ts_ratio", type: "line", yAxisIndex: 1, data: tsData, symbol: "none",
        lineStyle: { color: "#f0883e", width: 1.5 },
        markLine: { silent: true, symbol: "none",
          lineStyle: { color: "#f85149", type: "dashed", width: 1 },
          label: { formatter: "1.0（backwardation 門檻）", color: "#f85149", fontSize: 9, position: "insideEndTop" },
          data: [{ yAxis: 1.0 }] },
        markArea: { silent: true,
          itemStyle: { color: "rgba(248,81,73,0.10)" },
          data: backAreas } },
    ],
    tooltip: {
      trigger: "axis",
      backgroundColor: tipBg, borderColor: tipBdr,
      textStyle: { color: tipText, fontSize: 12 },
      formatter(params) {
        const d = params[0]?.axisValue || "";
        const map = {};
        for (const p of params) map[p.seriesName] = p.value;
        let s = `<b>${d}</b>`;
        if (map["VIX"]      != null) s += `<br><span style="color:#58a6ff">VIX：${map["VIX"]}</span>`;
        if (map["VIX3M"]    != null) s += `<br><span style="color:#8b949e">VIX3M：${map["VIX3M"]}</span>`;
        if (map["ts_ratio"] != null) {
          const back = map["ts_ratio"] > 1;
          s += `<br><span style="color:${back ? "#f85149" : "#3fb950"}">ts_ratio：${map["ts_ratio"]}${back ? "（backwardation⚠️）" : ""}</span>`;
        }
        return s;
      },
    },
    legend: {
      right: 0, top: 2, itemWidth: 16, itemHeight: 2,
      textStyle: { color: axisClr, fontSize: 11 },
    },
  };

  if (!tsChart) tsChart = echarts.init(el, isLight() ? null : "dark");
  tsChart.setOption(opt, { notMerge: true });
}

// ── 美股 Total Put/Call Ratio ────────────────────────────────────────────────


function renderPCChart() {
  const el = document.getElementById("pc-chart");
  if (!el || !pcData || !pcData.total || !pcData.total.length) return;

  const { rows, dates, pcVals, ma20, p10, p90 } = putCallModel(pcData.total, rangeStart(vsRange));
  if (rows.length < 10) { el.innerHTML = ""; return; }

  const axisClr = PALETTE.muted;
  const gridClr = tc("rgba(255,255,255,0.06)", "rgba(0,0,0,0.06)");
  const tipBg   = PALETTE.bg;
  const tipBdr  = PALETTE.border;
  const tipText = PALETTE.text;
  const isMob   = mob();

  const opt = {
    backgroundColor: "transparent",
    animation: false,
    grid: { top: "12%", left: "7%", right: "5%", bottom: isMob ? "20%" : "14%" },
    xAxis: {
      type: "category", data: dates, boundaryGap: false,
      axisLine: { lineStyle: { color: gridClr } }, axisTick: { show: false },
      axisLabel: { color: axisClr, fontSize: 10, rotate: isMob ? 30 : 0 },
      splitLine: { lineStyle: { color: gridClr, type: "dashed" } },
    },
    yAxis: {
      name: "Put/Call Ratio", nameTextStyle: { color: axisClr, fontSize: 10 },
      axisLabel: { color: axisClr, fontSize: 10 },
      splitLine: { lineStyle: { color: gridClr, type: "dashed" } },
      axisLine: { show: false }, axisTick: { show: false },
    },
    series: [
      { name: "P/C 日值", type: "line", data: pcVals, symbol: "none",
        lineStyle: { color: PALETTE.border, width: 1 } },
      { name: "P/C 20日均", type: "line", data: ma20, symbol: "none",
        lineStyle: { color: "#58a6ff", width: 2 },
        markLine: { silent: true, symbol: "none",
          lineStyle: { color: "#3fb950", type: "dashed", width: 1 },
          label: { color: "#3fb950", fontSize: 9, position: "insideEndTop" },
          data: [
            p10 != null ? { yAxis: +p10.toFixed(2), label: { formatter: `全樣本P10：${p10.toFixed(2)}` } } : null,
            p90 != null ? { yAxis: +p90.toFixed(2), label: { formatter: `全樣本P90：${p90.toFixed(2)}` } } : null,
          ].filter(Boolean) } },
    ],
    tooltip: {
      trigger: "axis",
      backgroundColor: tipBg, borderColor: tipBdr,
      textStyle: { color: tipText, fontSize: 12 },
      formatter(params) {
        const d = params[0]?.axisValue || "";
        const map = {};
        for (const p of params) map[p.seriesName] = p.value;
        let s = `<b>${d}</b>`;
        if (map["P/C 日值"]   != null) s += `<br>P/C 日值：${map["P/C 日值"]}`;
        if (map["P/C 20日均"] != null) s += `<br><span style="color:#58a6ff">P/C 20日均：${map["P/C 20日均"]}</span>`;
        return s;
      },
    },
    legend: {
      right: 0, top: 2, itemWidth: 16, itemHeight: 2,
      textStyle: { color: axisClr, fontSize: 11 },
    },
  };

  if (!pcChart) pcChart = echarts.init(el, isLight() ? null : "dark");
  pcChart.setOption(opt, { notMerge: true });
}

// ── ⑥ 低SKEW裸奔回測（index-level CBOE SKEW 反指標檢定）────────────────────────
// ground truth: Financial_work/skew_complacency.py（lab.rolling_pct_rank / dedupe_signals / fwd_ret 同慣例）

const CX_WINDOW        = 504;  // 2年滾動視窗（交易日），與 python ROLL_WIN 一致
const CX_MIN_PERIODS   = 120;  // 與 python MIN_PER 一致
const CX_PCT_THRESHOLD = 10;   // 2年滾動百分位 <=10 視為「最不避險/最樂觀」
const CX_GAP_DAYS      = 30;   // 訊號去重間距（曆日）
const CX_HORIZONS      = [21, 63, 126]; // 1M / 3M / 6M 交易日

// trailing 2年滾動百分位：只看 [i-window+1 .. i]（含 i），不用未來資料。
// 定義 = count(窗口內 <= 當前值) / 窗口內筆數 * 100 —— 簡化版
// pandas `rolling.rank(pct=True)*100`（未做 tie 平均排名，spec 允許此簡化）。

function renderComplacency() {
  const el     = document.getElementById("cx-chart");
  const status = document.getElementById("cx-status");
  if (!el || !vsData) return;

  const model = complacencyModel(vsData.history, {
    window: CX_WINDOW, minPeriods: CX_MIN_PERIODS, pctThreshold: CX_PCT_THRESHOLD,
    gapDays: CX_GAP_DAYS, horizons: CX_HORIZONS,
  });
  if (!model) { if (status) status.textContent = "資料不足"; return; }
  const { sigIdx, result, curSk, curPctFull } = model;

  console.log("[vixskew:complacency] n_signals=" + sigIdx.length,
    JSON.stringify(Object.fromEntries(CX_HORIZONS.map(td => [td, result[td]]))),
    "cur_skew=" + curSk, "cur_pct_full=" + curPctFull.toFixed(1));

  if (status) {
    status.textContent =
      `低SKEW裸奔回測 · ${sigIdx.length} 次訊號 · 現值 SKEW=${curSk.toFixed(1)} 全史第${curPctFull.toFixed(0)}百分位（非低，與病毒圖方向相反）`;
  }

  const axisClr = PALETTE.muted;
  const gridClr = tc("rgba(255,255,255,0.06)", "rgba(0,0,0,0.06)");
  const tipBg   = PALETTE.bg;
  const tipBdr  = PALETTE.border;
  const tipText = PALETTE.text;

  const horizonLabel = { 21: "1M", 63: "3M", 126: "6M" };
  const cats = CX_HORIZONS.map(td => horizonLabel[td]);
  const toBar = (stat) => ({
    value: stat.mean != null ? +stat.mean.toFixed(2) : 0,
    n: stat.n, median: stat.median, winrate: stat.winrate,
  });
  const sigData  = CX_HORIZONS.map(td => toBar(result[td].signal));
  const baseData = CX_HORIZONS.map(td => toBar(result[td].baseline));

  const opt = {
    backgroundColor: "transparent",
    animation: false,
    grid: { top: "14%", left: "8%", right: "5%", bottom: "10%" },
    xAxis: {
      type: "category", data: cats,
      axisLine: { lineStyle: { color: gridClr } }, axisTick: { show: false },
      axisLabel: { color: axisClr, fontSize: 11 },
    },
    yAxis: {
      name: "平均前向報酬 %", nameTextStyle: { color: axisClr, fontSize: 10 },
      axisLabel: { color: axisClr, fontSize: 10, formatter: v => v + "%" },
      splitLine: { lineStyle: { color: gridClr, type: "dashed" } },
      axisLine: { show: false }, axisTick: { show: false },
    },
    series: [
      { name: "低SKEW訊號組", type: "bar", data: sigData,
        itemStyle: { color: "#f778ba" } },
      { name: "全樣本基準",   type: "bar", data: baseData,
        itemStyle: { color: "#58a6ff" } },
    ],
    tooltip: {
      trigger: "axis",
      backgroundColor: tipBg, borderColor: tipBdr,
      textStyle: { color: tipText, fontSize: 12 },
      formatter(params) {
        const d = params[0]?.axisValue || "";
        let s = `<b>${d}</b>`;
        for (const p of params) {
          const v = p.data;
          const medStr = v.median != null ? (v.median > 0 ? "+" : "") + v.median.toFixed(2) + "%" : "—";
          const winStr = v.winrate != null ? v.winrate.toFixed(1) + "%" : "—";
          s += `<br><span style="color:${p.color}">${p.seriesName}</span>：` +
            `mean ${v.value > 0 ? "+" : ""}${v.value}%　n=${v.n}　median ${medStr}　勝率 ${winStr}`;
        }
        return s;
      },
    },
    legend: {
      right: 0, top: 2, itemWidth: 16, itemHeight: 10,
      textStyle: { color: axisClr, fontSize: 11 },
    },
  };

  if (!cxChart) cxChart = echarts.init(el, isLight() ? null : "dark");
  cxChart.setOption(opt, { notMerge: true });
}

// ── signal table ──────────────────────────────────────────────────────────────

function renderTable() {
  const el = document.getElementById("vs-signal-table");
  if (!el || !vsData) return;
  const sigs = [...vsData.signals].reverse();

  const rc = (v) => {
    if (v == null) return `<td style="color:var(--muted);text-align:right">—</td>`;
    const s = (v > 0 ? "+" : "") + v + "%";
    return `<td style="color:${retColor(v)};text-align:right">${s}</td>`;
  };

  const rows = sigs.map(s => `
    <tr>
      <td>${s.date}</td>
      <td style="color:#f0883e;text-align:right">${s.vix}</td>
      <td style="color:#17a2b8;text-align:right">${s.skew}</td>
      <td style="text-align:right;color:${s.vix_drop < -25 ? "#3fb950" : "var(--muted)"}">${s.vix_drop}%</td>
      <td style="text-align:right;color:${s.skew_hold > -3 ? "#17a2b8" : "var(--muted)"}">${s.skew_hold}%</td>
      <td style="text-align:center">${s.bear_trend ? "<span style='color:#f85149'>⚠️ 是</span>" : "否"}</td>
      <td style="text-align:center">${s.above200 != null ? s.above200 + "%" : "—"}</td>
      ${rc(s.ret_10d)} ${rc(s.ret_21d)} ${rc(s.ret_42d)} ${rc(s.ret_63d)}
    </tr>`).join("");

  el.innerHTML = `
    <div class="info-panel" style="margin-top:16px">
      <div class="info-panel-header"><i class="chevron">▶</i> 歷史序列信號事件（共 ${sigs.length} 次 · 最新在上）</div>
      <div class="info-panel-body" style="overflow-x:auto">
        <p style="font-size:12px;color:var(--muted);margin:0 0 8px">
          回測定義：VIX 在 25日內曾上漲 &gt;25% 且 SKEW 同步上漲 &gt;5%（同步上升），
          隨後 VIX 從峰值回落 &gt;15% 而 SKEW 仍在峰值 5% 以內（背離）。
          信號間距 ≥ 40 個交易日，1993–今 共偵測 ${sigs.length} 次。
        </p>
        <table class="fp-table" style="font-size:12px;min-width:720px">
          <thead><tr>
            <th>日期</th><th style="text-align:right">VIX</th><th style="text-align:right">SKEW</th>
            <th style="text-align:right">VIX距峰</th><th style="text-align:right">SKEW距峰</th>
            <th style="text-align:center">趨勢反轉</th><th style="text-align:center">市寬&gt;200</th>
            <th style="text-align:right">10日後</th><th style="text-align:right">1M後</th>
            <th style="text-align:right">6週後</th><th style="text-align:right">3M後</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}
