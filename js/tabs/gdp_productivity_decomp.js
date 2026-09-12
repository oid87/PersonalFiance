// js/tabs/gdp_productivity_decomp.js — 美國GDP/生產力/勞動力貢獻度拆解
//
// 分組長條圖:X軸為四個時期,每個時期三根並排柱子(GDP成長率/生產力成長率/
// 勞動力成長率的年化成長率 CAGR)。資料來自 data/us_gdp_productivity_decomp.json
// (scripts/fetch_gdp_productivity.py 產出,FRED GDPC1/OPHNFB/CLF16OV)。
//
// 非 SERIES 時間序列資料(是四筆彙總後的 CAGR),不走 loadSeries/ensureLoaded,
// 直接用 utils/data.js 的 fetchJSON 讀整份 payload。

import { isLight, echartsBase, PALETTE } from '../utils/theme.js';
import { fetchJSON } from '../utils/data.js';

const TAB_ID = 'gdp_productivity_decomp';
let chart = null;
let payload = null; // { updated, note, periods }

async function loadAll() {
  if (payload) return; // 首次切入才載入
  payload = await fetchJSON('data/us_gdp_productivity_decomp.json');
}

function buildOption() {
  const periods = payload?.periods ?? [];
  return echartsBase({
    legend: {
      top: 0,
      textStyle: { color: PALETTE.muted, fontSize: 12 },
    },
    grid: { top: '18%' },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      valueFormatter: (v) => (v == null ? '–' : `${v.toFixed(2)}%`),
    },
    xAxis: {
      type: 'category',
      data: periods.map(p => p.period),
    },
    yAxis: {
      type: 'value',
      name: '年化成長率 CAGR (%)',
      nameTextStyle: { color: PALETTE.muted },
      axisLabel: { formatter: '{value}%' },
    },
    dataZoom: [],
    series: [
      {
        name: 'GDP 成長率',
        type: 'bar',
        data: periods.map(p => p.gdp_cagr),
        itemStyle: { color: PALETTE.text },
      },
      {
        name: '生產力成長率',
        type: 'bar',
        data: periods.map(p => p.productivity_cagr),
        itemStyle: { color: PALETTE.muted },
      },
      {
        name: '勞動力成長率',
        type: 'bar',
        data: periods.map(p => p.labor_force_cagr),
        itemStyle: { color: PALETTE.border },
      },
    ],
  });
}

function renderNote() {
  const el = document.getElementById(`${TAB_ID}-note`);
  if (el && payload?.note) el.textContent = payload.note;
}

// ── lifecycle ────────────────────────────────────────────────────────────
export async function activate() {
  const host = document.getElementById(`${TAB_ID}-chart`);
  if (!host) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : 'dark');
  try {
    await loadAll();
    chart.setOption(buildOption(), { notMerge: true });
    renderNote();
  } catch (e) {
    console.error(`[${TAB_ID}] load failed`, e);
  }
}

export function onThemeChange(_light) {
  if (!chart) return;
  chart.setOption(buildOption(), { notMerge: true });
}

export function resize() {
  chart?.resize();
}
