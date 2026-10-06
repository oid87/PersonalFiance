// VIX 期限結構 tab — VIX9D/VIX/VIX3M/VIX6M 四天期 + ts_ratio(=VIX/VIX3M)
//   上格：四條天期線；下格：ts_ratio + 1.0 參考線（backwardation 門檻）
//   資料：data/vix_term.json（fetch_vix_term.py 抓 CBOE 官方每日收盤，免 key）

import { isLight, tc, mob, PALETTE } from '../utils/theme.js';
import { requestJSON, clearRequestCache } from '../utils/data.js';
import { cutoffDate } from '../utils/dates.js';
import { chipPicker } from '../utils/dom.js';

const LINES = [
  { key: "vix9d", name: "VIX9D",  color: "#8b949e" },
  { key: "vix",   name: "VIX",    color: "#58a6ff" },
  { key: "vix3m", name: "VIX3M",  color: "#e3b341" },
  { key: "vix6m", name: "VIX6M",  color: "#3fb950" },
];
const TS_COLOR = "#f0883e";

let chart = null;
let range = "3Y";
let rows  = null;
const validDate = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

async function loadAll(context = {}) {
  if (rows) return;
  const url = "data/vix_term.json";
  try {
    const j = await requestJSON(url, { signal: context.signal });
    if (!(Array.isArray(j?.data) && j.data.length > 0)) throw new Error("vix_term: missing required data");
    const keys = ["vix9d", "vix", "vix3m", "vix6m", "ts_ratio"];
    for (const row of j.data) {
      if (!row || !validDate(row.date) || keys.some(key => row[key] != null &&
          (typeof row[key] !== "number" || !Number.isFinite(row[key])))) {
        throw new Error("vix_term: invalid date or term value");
      }
    }
    const nextRows = j.data.filter(row => row.vix != null).map(row => ({ ...row }));
    if (!nextRows.length) throw new Error("vix_term: no usable rows");
    if (context.signal?.aborted || context.isCurrent?.() === false) throw new DOMException("Activation expired", "AbortError");
    rows = nextRows;
  } catch (error) {
    clearRequestCache(url);
    throw error;
  }
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
  const tsRow = lastNonNull("ts_ratio");
  if (tsRow) {
    const v = tsRow.ts_ratio;
    const back = v > 1;
    const clr = back ? "#f85149" : "#3fb950";
    setText("vixterm-ratio-val", v.toFixed(3), clr);
    setText("vixterm-ratio-sub", `${tsRow.date} · VIX / VIX3M`, "var(--muted)");
    setText("vixterm-ratio-signal", back ? "近月恐慌溢價" : "正常期限結構", clr);

    setText("vixterm-struct-val", back ? "Backwardation" : "Contango", clr);
    setText("vixterm-struct-sub", back ? "近月 VIX > 3個月 VIX3M" : "近月 VIX < 3個月 VIX3M", "var(--muted)");
    setText("vixterm-struct-signal", back ? "backwardation 近月恐慌" : "contango 正常", clr);
  }

  const vixRow = lastNonNull("vix");
  if (vixRow) {
    let sig, clr;
    const v = vixRow.vix;
    if      (v > 30) { sig = "高度恐慌"; clr = "#f85149"; }
    else if (v > 20) { sig = "偏緊張";   clr = "#f0883e"; }
    else if (v > 15) { sig = "正常區間"; clr = "#3fb950"; }
    else              { sig = "低波動 · 極度平靜"; clr = "#58a6ff"; }
    setText("vixterm-vix-val", v.toFixed(2), PALETTE.text);
    setText("vixterm-vix-sub", `${vixRow.date} · CBOE VIX（30日）`, "var(--muted)");
    setText("vixterm-vix-signal", sig, clr);
  }
}

// ── chart render ──────────────────────────────────────────────────────
export function render() {
  if (!chart || !rows?.length) return;

  const axisClr = PALETTE.muted;
  const gridClr = tc("rgba(48,54,61,0.5)", "rgba(208,215,222,0.4)");
  const tipBg   = PALETTE.bg;
  const tipBdr  = PALETTE.border;
  const textClr = PALETTE.text2;
  const isMob   = mob();

  updateCards();

  const cut  = cutoffDate(range);
  const view = rows.filter(r => r.date >= cut);
  const dates = view.map(r => r.date);

  const status = document.getElementById("vixterm-status");
  if (status) status.textContent =
    `VIX 期限結構 · ${dates.length} 個交易日（${range}）· 資料 CBOE VIX9D/VIX/VIX3M/VIX6M`;

  const L = mob() ? 40 : 52;
  const R = mob() ? 16 : 28;

  // backwardation 區間（ts_ratio > 1）視覺強調
  const backAreas = [];
  let segStart = null;
  for (let i = 0; i < view.length; i++) {
    const on = view[i].ts_ratio != null && view[i].ts_ratio > 1;
    if (on && segStart === null) segStart = dates[i];
    if (!on && segStart !== null) {
      backAreas.push([{ xAxis: segStart }, { xAxis: dates[i - 1] }]);
      segStart = null;
    }
  }
  if (segStart !== null) backAreas.push([{ xAxis: segStart }, { xAxis: dates[dates.length - 1] }]);

  const series = [];
  for (const ln of LINES) {
    series.push({
      name: ln.name, type: "line", xAxisIndex: 0, yAxisIndex: 0,
      data: view.map(r => r[ln.key] != null ? +r[ln.key].toFixed(2) : null),
      symbol: "none", connectNulls: true,
      itemStyle: { color: ln.color },
      lineStyle: { color: ln.color, width: ln.key === "vix" ? 2 : 1.3 },
      z: ln.key === "vix" ? 5 : 3,
    });
  }

  series.push({
    name: "ts_ratio", type: "line", xAxisIndex: 1, yAxisIndex: 1,
    data: view.map(r => r.ts_ratio != null ? +r.ts_ratio.toFixed(3) : null),
    symbol: "none", connectNulls: true,
    itemStyle: { color: TS_COLOR },
    lineStyle: { color: TS_COLOR, width: 1.8 },
    z: 5,
    markLine: {
      silent: true, symbol: "none",
      lineStyle: { color: "#f85149", type: "dashed", width: 1 },
      label: { formatter: "1.0（backwardation 門檻）", color: "#f85149", fontSize: 9, position: "insideEndTop" },
      data: [{ yAxis: 1.0 }],
    },
    markArea: {
      silent: true,
      itemStyle: { color: "rgba(248,81,73,0.10)" },
      data: backAreas,
    },
  });

  const axBase = {
    type: "category", data: dates, boundaryGap: false,
    axisLine: { lineStyle: { color: axisClr } }, axisTick: { show: false },
    splitLine: { show: false },
  };

  chart.setOption({
    backgroundColor: "transparent", animation: false,
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    tooltip: {
      trigger: "axis", axisPointer: { type: "cross", link: [{ xAxisIndex: "all" }] },
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        const d = params[0]?.axisValue ?? "";
        let html = `<div style="font-weight:600;margin-bottom:4px">${d}</div>`;
        for (const p of params) {
          if (p.value == null) continue;
          html += `<div>${p.marker}${p.seriesName}: <b>${(+p.value).toFixed(2)}</b></div>`;
        }
        return html;
      },
    },
    legend: {
      data: [...LINES.map(l => l.name), "ts_ratio"], top: 2, left: "center",
      textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr,
    },
    grid: [
      { left: L, right: R, top: "12%", height: "52%" },
      { left: L, right: R, top: "70%", height: "20%" },
    ],
    xAxis: [
      { ...axBase, gridIndex: 0, axisLabel: { show: false } },
      { ...axBase, gridIndex: 1, axisLabel: { color: axisClr, fontSize: 10, rotate: isMob ? 30 : 0 } },
    ],
    yAxis: [
      {
        gridIndex: 0, type: "value", scale: true, name: "VIX",
        nameTextStyle: { color: axisClr, fontSize: 10 },
        axisLabel: { color: axisClr, fontSize: 11 },
        axisLine: { show: false }, axisTick: { show: false },
        splitLine: { lineStyle: { color: gridClr } },
      },
      {
        gridIndex: 1, type: "value", scale: true, name: "ts_ratio",
        nameTextStyle: { color: axisClr, fontSize: 10 },
        axisLabel: { color: axisClr, fontSize: 10 },
        axisLine: { show: false }, axisTick: { show: false },
        splitLine: { lineStyle: { color: gridClr } },
      },
    ],
    dataZoom: [{ type: "inside", xAxisIndex: [0, 1], filterMode: "none" }],
    series,
  }, { notMerge: true });
}

// ── controls ──────────────────────────────────────────────────────────
function buildControls() {
  const rp = document.getElementById("vixterm-range-picker");
  chipPicker(rp, "vixterm-range", v => { range = v; render(); });
}

// ── lifecycle ─────────────────────────────────────────────────────────
export async function activate(context = {}) {
  const host = document.getElementById("vixterm-chart");
  if (!host) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : "dark");
  buildControls();
  try {
    await loadAll(context);
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (context.signal?.aborted || context.isCurrent?.() === false) throw new DOMException("Activation expired", "AbortError");
    chart?.resize(); render();
  } catch (e) {
    rows = null;
    clearRequestCache("data/vix_term.json");
    const s = document.getElementById("vixterm-status");
    if (s) s.textContent = "載入失敗：" + (e.message || e);
    console.error("[vix_term] load failed", e);
    throw e;
  }
}
export function onThemeChange(light) {
  if (!chart) return;
  chart.dispose();
  chart = echarts.init(document.getElementById("vixterm-chart"), light ? null : "dark");
  if (rows) render();
}
export function resize() { chart?.resize(); }

export function getCharts() { return [chart].filter(Boolean); }
