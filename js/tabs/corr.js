import { SERIES, CORR_EXTRA, loaded } from '../state.js';
import { isLight, tc, PALETTE } from '../utils/theme.js';
import { loadSeries } from '../utils/data.js';
import { toArithReturns, pearsonCorr } from '../utils/math.js';
import { chipPicker } from '../utils/dom.js';

let corrChart  = null;
let corrPeriod = "1Y";

// Cell values need roughly 640px of chart width (13 columns at >= 11px text);
// narrower charts keep the cells clean and rely on the tooltip.
const CELL_LABEL_MIN_WIDTH = 640;
const showCellLabels = () => !!corrChart && corrChart.getWidth() >= CELL_LABEL_MIN_WIDTH;
// 12px as before; 11px (never below 10) when the chart is short, e.g. phone landscape.
const cellLabelSize = () => (corrChart && corrChart.getHeight() < 480 ? 11 : 12);

// The visualMap scale is fixed (identical in both page themes), so cell text must not follow
// the theme either. For each cell the text colour is whichever of black/white has the higher
// WCAG contrast against that cell's actual colour, computed from the same linear RGB
// interpolation between the scale stops that visualMap uses. Black and white cross at
// relative luminance ~0.179, so the worst case over any background is 4.58:1 (>= AA 4.5).
const CELL_SCALE = ["#1565c0", "#c8d8f0", "#f5f5f5", "#f5c0c0", "#c62828"]; // r = -1 ... +1
const CELL_TEXT_BLACK = "#000000";
const CELL_TEXT_WHITE = "#ffffff";
const hexToRgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const SCALE_RGB = CELL_SCALE.map(hexToRgb);

function cellRgb(r) {
  const t = (Math.max(-1, Math.min(1, r)) + 1) / 2 * (SCALE_RGB.length - 1);
  const i = Math.min(Math.floor(t), SCALE_RGB.length - 2), f = t - i;
  return SCALE_RGB[i].map((c, k) => c + (SCALE_RGB[i + 1][k] - c) * f);
}
function relativeLuminance([R, G, B]) {
  const lin = c => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(R) + 0.7152 * lin(G) + 0.0722 * lin(B);
}
// "k" = black text, "w" = white text
function cellTextTag(r) {
  const L = relativeLuminance(cellRgb(r));
  return (L + 0.05) / 0.05 >= 1.05 / (L + 0.05) ? "k" : "w";
}

function cellLabel() {
  const fontSize = cellLabelSize();
  return {
    show: showCellLabels(),
    fontSize,
    formatter: p => {
      const v = p.value?.[2];
      return v == null ? "{n|—}" : `{${cellTextTag(v)}|${v.toFixed(2)}}`;
    },
    // "n" (no value, no cell colour) sits on the page background, so it follows the theme.
    rich: { k: { color: CELL_TEXT_BLACK, fontSize }, w: { color: CELL_TEXT_WHITE, fontSize }, n: { color: PALETTE.text, fontSize } },
  };
}

export async function renderCorrTab(context = {}) {
  if (!corrChart) return;
  const statusEl = document.getElementById("corr-status");
  statusEl.textContent = "載入資料中…";

  try {
    await Promise.all([...SERIES, ...CORR_EXTRA].map(series => loadSeries(series, context)));
    if (context.signal?.aborted || (context.isCurrent && !context.isCurrent())) return;
  } catch (e) {
    statusEl.textContent = `載入失敗：${e.message}`;
    if (context.signal || context.isCurrent) throw e;
    return;
  }

  const d = new Date();
  if      (corrPeriod === "6M") d.setMonth(d.getMonth() - 6);
  else if (corrPeriod === "1Y") d.setFullYear(d.getFullYear() - 1);
  else if (corrPeriod === "2Y") d.setFullYear(d.getFullYear() - 2);
  else if (corrPeriod === "5Y") d.setFullYear(d.getFullYear() - 5);
  // check_reuse: keep — 本地 range cutoff 變體:preset key 集合/MAX 哨兵/未命中預設與 dates.presetStart、dates.cutoffDate 皆不同,換過去會改行為
  const fromDate = d.toISOString().slice(0, 10);

  // F&G is a 0–100 sentiment oscillator, not a price series — arithmetic
  // returns on a bounded index don't carry the same meaning as on prices.
  // CORR_EXTRA (TLT/DXY/US10Y) are appended after main SERIES for context.
  const allSeries = [...SERIES, ...CORR_EXTRA];
  const keys = allSeries.map(s => s.key).filter(k => loaded[k] && k !== "F&G");

  // Arithmetic returns per ticker, filtered to period
  const retMaps = {};
  for (const k of keys) {
    const rets = toArithReturns(loaded[k]).filter(r => r[0] >= fromDate);
    retMaps[k] = new Map(rets.map(r => [r[0], r[1]]));
  }

  // Intersection of trading dates across all tickers
  const dateSets = Object.values(retMaps).map(m => new Set(m.keys()));
  if (!dateSets.length) throw new Error("correlation: no price series");
  let common = dateSets[0];
  for (const s of dateSets.slice(1)) common = new Set([...common].filter(x => s.has(x)));
  const dates = [...common].sort();

  if (dates.length < 30) {
    corrChart.clear();
    statusEl.textContent = "共同交易日不足（< 30）"; return;
  }

  const aligned = {};
  for (const k of keys) aligned[k] = dates.map(dt => retMaps[k].get(dt) ?? NaN);

  const heatData = [];
  for (let i = 0; i < keys.length; i++) {
    for (let j = 0; j < keys.length; j++) {
      const r = pearsonCorr(aligned[keys[i]], aligned[keys[j]]);
      heatData.push([j, i, isNaN(r) ? null : +r.toFixed(3)]);
    }
  }

  const tipBg   = PALETTE.bg;
  const tipBdr  = PALETTE.border;
  const tipText = PALETTE.text;
  const axisClr = PALETTE.muted;

  corrChart.setOption({
    backgroundColor: "transparent",
    tooltip: {
      trigger: "item",
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: tipText },
      formatter: p => {
        const v = p.value?.[2];
        if (v == null) return "";
        return `<b>${keys[p.value[1]]} × ${keys[p.value[0]]}</b><br/>r = <b>${v.toFixed(3)}</b>`;
      },
    },
    visualMap: {
      min: -1, max: 1, orient: "horizontal", left: "center", bottom: 14,
      itemWidth: 12, itemHeight: 100,
      text: ["+1", "−1"], textStyle: { color: tipText, fontSize: 11 },
      inRange: { color: CELL_SCALE },
    },
    // containLabel keeps long row labels (US10Y, MAGS, SOXX) inside the canvas.
    grid: { top: 24, bottom: 72, left: 8, right: 20, containLabel: true },
    xAxis: {
      type: "category", data: keys, splitArea: { show: true },
      axisLine: { lineStyle: { color: axisClr } },
      axisLabel: { color: tipText, fontSize: 12 },
    },
    yAxis: {
      type: "category", data: keys, splitArea: { show: true },
      axisLine: { lineStyle: { color: axisClr } },
      axisLabel: { color: tipText, fontSize: 12 },
    },
    series: [{
      type: "heatmap",
      data: heatData,
      label: cellLabel(),
      emphasis: { itemStyle: { shadowBlur: 6, shadowColor: "rgba(0,0,0,.3)" } },
    }],
  }, { notMerge: true });

  statusEl.textContent =
    `日報酬率相關係數 · ${corrPeriod} · ${dates.length} 個共同交易日 · 對角線 = 完全正相關`;
}

export async function activate(context = {}) {
  const el = document.getElementById("corr-chart");
  if (!corrChart) {
    corrChart = echarts.init(el, isLight() ? null : "dark");
  }
  await new Promise(resolve => setTimeout(resolve, 50));
  if (context.signal?.aborted || (context.isCurrent && !context.isCurrent())) return;
  corrChart.resize();
  await renderCorrTab(context);
}

export function onThemeChange(light) {
  if (!corrChart) return;
  corrChart.dispose();
  corrChart = echarts.init(document.getElementById("corr-chart"), light ? null : "dark");
  return renderCorrTab();
}

export function resize() {
  if (!corrChart) return;
  // Shrink the previous canvas before reading the current layout viewport.
  corrChart.resize();
  corrChart.setOption({ series: [{ label: cellLabel() }] });
}

// Wire period picker once at module load
chipPicker(document.getElementById("corr-period-picker"), "corr-period", v => {
  corrPeriod = v;
  renderCorrTab();
});

export function getCharts() { return corrChart ? [corrChart] : []; }
