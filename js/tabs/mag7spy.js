// 七巨頭相對強度 tab — MAGS(七巨頭 ETF) 相對 SPY(大盤) 的比值線
//   主圖：ratio = MAGS.close / SPY.close 時序線（log scale）
//   資料：js/state.js SERIES 註冊表既有的 MAGS/SPY(data/MAGS.json、data/SPY.json)，純前端算比值，免抓取腳本。
//   已知限制：MAGS 2023-04-11 才有資料，無法回溯更早期的七巨頭走勢；
//             比值為未還原息價格比（不含股息），方法論比照 js/tabs/relstrength.js。

import { loaded } from '../state.js';
import { isLight, tc, mob, PALETTE } from '../utils/theme.js';
import { cutoffDate } from '../utils/dates.js';
import { ensureLoaded } from '../utils/data.js';
import { chipPicker } from '../utils/dom.js';

const RATIO_COLOR = "#e3b341";

let chart = null;
let range = "MAX";
let ratioRows = null; // [{ date, ratio, mags, spy }]

// ── data align ────────────────────────────────────────────────────────
function buildRatioRows() {
  const magsRows = loaded['MAGS'] || [];
  const spyRows = loaded['SPY'] || [];
  const spyMap = new Map(spyRows.map(([date, close]) => [date, close]));
  ratioRows = magsRows
    .filter(([date]) => spyMap.has(date))
    .map(([date, magsClose]) => {
      const spyClose = spyMap.get(date);
      return { date, ratio: magsClose / spyClose, mags: magsClose, spy: spyClose };
    });
}

// ── cards ─────────────────────────────────────────────────────────────
function setText(id, txt, color) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = txt;
  if (color) el.style.color = color;
}

function updateCards() {
  if (!ratioRows || !ratioRows.length) return;
  const first = ratioRows[0];
  const last = ratioRows[ratioRows.length - 1];
  const pctChange = (last.ratio / first.ratio - 1) * 100;
  const col = pctChange >= 0 ? "#3fb950" : "#f85149";

  setText("mag7spy-current-val", last.ratio.toFixed(4), PALETTE.text);
  setText("mag7spy-current-sub", `${last.date} · MAGS / SPY（未還原息）`, "var(--muted)");
  setText("mag7spy-current-signal", `自 ${first.date} 以來 ${pctChange >= 0 ? "+" : ""}${pctChange.toFixed(1)}%`, col);
}

// ── chart render ──────────────────────────────────────────────────────
export function render() {
  if (!chart || !ratioRows?.length) return;

  const axisClr = PALETTE.muted;
  const gridClr = tc("rgba(48,54,61,0.5)", "rgba(208,215,222,0.4)");
  const tipBg   = PALETTE.bg;
  const tipBdr  = PALETTE.border;
  const textClr = PALETTE.text2;
  const isMob   = mob();

  updateCards();

  const cut  = cutoffDate(range);
  const view = ratioRows.filter(r => r.date >= cut);
  const dates = view.map(r => r.date);

  const status = document.getElementById("mag7spy-status");
  if (status) status.textContent =
    `MAGS/SPY 七巨頭相對強度 · ${dates.length} 個交易日（${range}）· 資料自 2023-04-11 起（未還原息）`;

  const L = mob() ? 44 : 56;
  const R = mob() ? 16 : 28;

  const ratioVals = view.map(r => r.ratio).filter(v => v != null && v > 0);
  const dataMin = Math.min(...ratioVals);
  const dataMax = Math.max(...ratioVals);
  const yMin = dataMin / 1.15;
  const yMax = dataMax * 1.15;

  const series = [{
    name: "MAGS/SPY 比值", type: "line", xAxisIndex: 0, yAxisIndex: 0,
    data: view.map(r => r.ratio != null ? +r.ratio.toFixed(6) : null),
    symbol: "none", connectNulls: true,
    itemStyle: { color: RATIO_COLOR },
    lineStyle: { color: RATIO_COLOR, width: 1.6 },
    z: 5,
  }];

  const axBase = {
    type: "category", data: dates, boundaryGap: false,
    axisLine: { lineStyle: { color: axisClr } }, axisTick: { show: false },
    splitLine: { show: false },
  };

  chart.setOption({
    backgroundColor: "transparent", animation: false,
    tooltip: {
      trigger: "axis", axisPointer: { type: "cross" },
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        const p = params[0];
        if (!p) return "";
        const row = view[p.dataIndex];
        if (!row) return "";
        return `<div style="font-weight:600;margin-bottom:4px">${row.date}</div>
          <div>MAGS: <b>${row.mags.toFixed(2)}</b></div>
          <div>SPY: <b>${row.spy.toFixed(2)}</b></div>
          <div>${p.marker}比值: <b>${row.ratio.toFixed(4)}</b></div>`;
      },
    },
    legend: {
      data: ["MAGS/SPY 比值"], top: 2, left: "center",
      textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr,
    },
    grid: [{ left: L, right: R, top: "14%", height: "76%" }],
    xAxis: [
      { ...axBase, gridIndex: 0, axisLabel: { color: axisClr, fontSize: 10, rotate: isMob ? 30 : 0 } },
    ],
    yAxis: [
      {
        gridIndex: 0, type: "log", min: yMin, max: yMax, name: "MAGS/SPY（log）",
        nameTextStyle: { color: axisClr, fontSize: 10 },
        axisLabel: { color: axisClr, fontSize: 11, formatter: v => v.toFixed(2) },
        axisLine: { show: false }, axisTick: { show: false },
        splitLine: { lineStyle: { color: gridClr } },
      },
    ],
    dataZoom: [{ type: "inside", xAxisIndex: [0], filterMode: "none" }],
    series,
  }, { notMerge: true });
}

// ── controls ──────────────────────────────────────────────────────────
function buildControls() {
  const rp = document.getElementById("mag7spy-range-picker");
  chipPicker(rp, "mag7spy-range", v => { range = v; render(); });
}

// ── lifecycle ─────────────────────────────────────────────────────────
export async function activate() {
  const host = document.getElementById("mag7spy-chart");
  if (!host) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : "dark");
  buildControls();
  try {
    await ensureLoaded('MAGS');
    await ensureLoaded('SPY');
    buildRatioRows();
    setTimeout(() => { chart?.resize(); render(); }, 50);
  } catch (e) {
    const s = document.getElementById("mag7spy-status");
    if (s) s.textContent = "載入失敗：" + (e.message || e);
    console.error("[mag7spy] load failed", e);
  }
}
export function onThemeChange(light) {
  if (!chart) return;
  chart.dispose();
  chart = echarts.init(document.getElementById("mag7spy-chart"), light ? null : "dark");
  if (ratioRows) render();
}
export function resize() { chart?.resize(); }
