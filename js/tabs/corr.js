import { SERIES, CORR_EXTRA, loaded } from '../state.js';
import { isLight, tc, mob, PALETTE } from '../utils/theme.js';
import { loadSeries } from '../utils/data.js';
import { toArithReturns, pearsonCorr } from '../utils/math.js';

let corrChart  = null;
let corrPeriod = "1Y";

export async function renderCorrTab() {
  if (!corrChart) return;
  const statusEl = document.getElementById("corr-status");
  statusEl.textContent = "載入資料中…";

  try {
    await Promise.all([...SERIES, ...CORR_EXTRA].map(loadSeries));
  } catch (e) {
    statusEl.textContent = `載入失敗：${e.message}`; return;
  }

  const d = new Date();
  if      (corrPeriod === "6M") d.setMonth(d.getMonth() - 6);
  else if (corrPeriod === "1Y") d.setFullYear(d.getFullYear() - 1);
  else if (corrPeriod === "2Y") d.setFullYear(d.getFullYear() - 2);
  else if (corrPeriod === "5Y") d.setFullYear(d.getFullYear() - 5);
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
      inRange: { color: ["#1565c0", "#c8d8f0", "#f5f5f5", "#f5c0c0", "#c62828"] },
    },
    grid: { top: 24, bottom: 72, left: mob() ? 40 : 56, right: 20 },
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
      label: {
        show: true,
        fontSize: 12,
        formatter: p => p.value?.[2] != null ? p.value[2].toFixed(2) : "—",
      },
      emphasis: { itemStyle: { shadowBlur: 6, shadowColor: "rgba(0,0,0,.3)" } },
    }],
  }, { notMerge: true });

  statusEl.textContent =
    `日報酬率相關係數 · ${corrPeriod} · ${dates.length} 個共同交易日 · 對角線 = 完全正相關`;
}

export function activate() {
  const el = document.getElementById("corr-chart");
  if (!corrChart) {
    corrChart = echarts.init(el, isLight() ? null : "dark");
  }
  setTimeout(() => { corrChart.resize(); renderCorrTab(); }, 50);
}

export function onThemeChange(light) {
  if (!corrChart) return;
  corrChart.dispose();
  corrChart = echarts.init(document.getElementById("corr-chart"), light ? null : "dark");
  renderCorrTab();
}

export function resize() {
  corrChart?.resize();
}

// Wire period picker once at module load
document.getElementById("corr-period-picker")?.addEventListener("click", e => {
  const t = e.target.closest(".chip[data-corr-period]");
  if (!t) return;
  corrPeriod = t.dataset.corrPeriod;
  for (const c of e.currentTarget.querySelectorAll(".chip"))
    c.classList.toggle("active", c === t);
  renderCorrTab();
});
