import { SECTOR_ETFS, SECTOR_LABEL, sectorLoaded } from '../state.js';
import { isLight, tc, mob } from '../utils/theme.js';

let sectorChart   = null;
let sectorSortCol = "1M";

const SECTOR_PERIODS = ["1W","1M","3M","6M","YTD","1Y"];
const SECTOR_DAYS    = { "1W": 5, "1M": 21, "3M": 63, "6M": 126, "1Y": 252 };

async function loadSectorData() {
  await Promise.all(SECTOR_ETFS.map(async etf => {
    if (sectorLoaded[etf]) return;
    const resp = await fetch(`data/${etf}.json`, { cache: "no-cache" });
    if (!resp.ok) throw new Error(`${etf}: HTTP ${resp.status}`);
    const j = await resp.json();
    sectorLoaded[etf] = (j.data || []).map(r => [r.date, r.close]);
  }));
}

function sectorReturn(data, nDays, ytd) {
  if (!data || data.length < 2) return null;
  const latest = data[data.length - 1][1];
  if (ytd) {
    const yearStart = data[data.length - 1][0].slice(0, 4) + "-01-01";
    const base = data.find(r => r[0] >= yearStart);
    return base ? (latest / base[1] - 1) * 100 : null;
  }
  if (data.length <= nDays) return null;
  const base = data[data.length - 1 - nDays][1];
  return base > 0 ? (latest / base - 1) * 100 : null;
}

export async function renderSectorTab() {
  if (!sectorChart) return;
  const statusEl = document.getElementById("sector-status");
  statusEl.textContent = "載入中…";
  try { await loadSectorData(); } catch(e) { statusEl.textContent = `載入失敗：${e.message}`; return; }

  // Compute returns for each ETF × period
  const returns = {};
  for (const etf of SECTOR_ETFS) {
    returns[etf] = {};
    for (const p of SECTOR_PERIODS) {
      returns[etf][p] = p === "YTD"
        ? sectorReturn(sectorLoaded[etf], 0, true)
        : sectorReturn(sectorLoaded[etf], SECTOR_DAYS[p], false);
    }
  }

  // Sort ETFs by selected column
  const sortedETFs = [...SECTOR_ETFS].sort((a, b) => {
    const va = returns[a][sectorSortCol] ?? -Infinity;
    const vb = returns[b][sectorSortCol] ?? -Infinity;
    return vb - va;
  });

  // ECharts heatmap: rows = periods, cols = ETFs (sorted)
  const heatData = [];
  for (let pi = 0; pi < SECTOR_PERIODS.length; pi++) {
    for (let ei = 0; ei < sortedETFs.length; ei++) {
      const v = returns[sortedETFs[ei]][SECTOR_PERIODS[pi]];
      heatData.push([ei, pi, v != null ? +v.toFixed(2) : null]);
    }
  }

  const maxAbs = heatData.reduce((m, d) => d[2] != null ? Math.max(m, Math.abs(d[2])) : m, 1);
  const tipBg   = tc("#161b22","#ffffff"), tipBdr = tc("#30363d","#d0d7de");
  const tipText = tc("#e6edf3","#1f2328"), axisClr = tc("#8b949e","#57606a");

  const xLabels = sortedETFs.map(e => mob() ? e : `${SECTOR_LABEL[e]}\n${e}`);

  sectorChart.setOption({
    backgroundColor: "transparent",
    tooltip: {
      trigger: "item", backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: tipText },
      formatter: p => {
        const v = p.value?.[2];
        const etf = sortedETFs[p.value?.[0]];
        const per = SECTOR_PERIODS[p.value?.[1]];
        if (v == null || !etf) return "";
        return `<b>${etf} ${SECTOR_LABEL[etf]}</b><br/>${per}: <b style="color:${v>=0?"#3fb950":"#f78166"}">${v>=0?"+":""}${v.toFixed(2)}%</b>`;
      },
    },
    visualMap: {
      min: -maxAbs, max: maxAbs, calculable: false,
      orient: "horizontal", left: "center", bottom: 10,
      itemWidth: 12, itemHeight: 120,
      text: ["+", "−"], textStyle: { color: tipText, fontSize: 11 },
      inRange: { color: ["#c62828","#ef9a9a","#f5f5f5","#a5d6a7","#1b5e20"] },
    },
    grid: { top: 16, bottom: 72, left: mob() ? 40 : 56, right: 16 },
    xAxis: {
      type: "category", data: xLabels, splitArea: { show: true },
      axisLine: { lineStyle: { color: axisClr } },
      axisLabel: { color: tipText, fontSize: 11, interval: 0 },
    },
    yAxis: {
      type: "category", data: SECTOR_PERIODS, splitArea: { show: true },
      axisLine: { lineStyle: { color: axisClr } },
      axisLabel: { color: tipText, fontSize: 12 },
    },
    series: [{
      type: "heatmap", data: heatData,
      label: {
        show: !mob(), fontSize: 11,
        formatter: p => p.value?.[2] != null ? (p.value[2] >= 0 ? "+" : "") + p.value[2].toFixed(1) + "%" : "—",
      },
      emphasis: { itemStyle: { shadowBlur: 6, shadowColor: "rgba(0,0,0,.3)" } },
    }],
  }, { notMerge: true });

  const latest = SECTOR_ETFS.map(e => sectorLoaded[e]?.at(-1)?.[0]).filter(Boolean).sort().at(-1) ?? "—";
  statusEl.textContent = `美股11大產業 ETF · 以${sectorSortCol}排序 · 資料截至 ${latest}`;
}

export function activate() {
  const el = document.getElementById("sector-chart");
  if (!sectorChart) {
    sectorChart = echarts.init(el, isLight() ? null : "dark");
  }
  setTimeout(() => { sectorChart.resize(); renderSectorTab(); }, 50);
}

export function onThemeChange(light) {
  if (!sectorChart) return;
  sectorChart.dispose();
  sectorChart = echarts.init(document.getElementById("sector-chart"), light ? null : "dark");
  renderSectorTab();
}

export function resize() {
  sectorChart?.resize();
}

document.getElementById("sector-sort-picker")?.addEventListener("click", e => {
  const t = e.target.closest(".chip[data-sector-col]");
  if (!t) return;
  sectorSortCol = t.dataset.sectorCol;
  for (const c of e.currentTarget.querySelectorAll(".chip"))
    c.classList.toggle("active", c === t);
  renderSectorTab();
});
