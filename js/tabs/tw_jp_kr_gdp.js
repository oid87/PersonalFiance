// js/tabs/tw_jp_kr_gdp.js — 台日韓GDP成長率對照(年頻)
//
// 分組長條圖:X軸為年份,每年三根並排柱子(台灣/日本/南韓的年度實質GDP成長率)。
// 資料來自 data/tw_jp_kr_gdp_growth.json(scripts/fetch_tw_jp_kr_gdp.py 產出,
// 台灣DGBAS官方年增率 + 日本/南韓FRED資料自算年增率)。
//
// ⚠️ 三國計算口徑不同(見 payload.note),不是同一種算法的並排比較——
// 台灣是官方直接發布的年增率,日本/南韓是自算/複合估算的近似值。
//
// 非 SERIES 時間序列資料(是 {year, tw, jp, kr} 陣列),且需要連 note 欄位一起
// 顯示給讀者看方法論揭露,故不用 utils/data.js 的 fetchJSON(它會把 j.data
// 解包成純陣列、丟掉 note),改用原生 fetch() 讀整份 payload。

import { isLight, echartsBase, PALETTE } from '../utils/theme.js';

const TAB_ID = 'tw_jp_kr_gdp';
let chart = null;
let payload = null; // { updated, note, data: [{year, tw, jp, kr}, ...] }

async function loadAll() {
  if (payload) return; // 首次切入才載入
  const res = await fetch('data/tw_jp_kr_gdp_growth.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`fetch tw_jp_kr_gdp_growth.json: HTTP ${res.status}`);
  payload = await res.json();
}

function buildOption() {
  const rows = (payload?.data ?? []).filter(r => r.year >= 2010);
  return echartsBase({
    legend: {
      top: 0,
      textStyle: { color: PALETTE.muted, fontSize: 12 },
    },
    grid: { top: '16%' },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      valueFormatter: (v) => (v == null ? '–' : `${v.toFixed(2)}%`),
    },
    xAxis: {
      type: 'category',
      data: rows.map(r => String(r.year)),
    },
    yAxis: {
      type: 'value',
      name: 'GDP成長率 (%)',
      nameTextStyle: { color: PALETTE.muted },
      axisLabel: { formatter: '{value}%' },
    },
    dataZoom: [
      { type: 'inside' },
      { type: 'slider', height: 18 },
    ],
    series: [
      {
        name: '台灣',
        type: 'bar',
        data: rows.map(r => r.tw ?? null),
        itemStyle: { color: PALETTE.text },
      },
      {
        name: '日本',
        type: 'bar',
        data: rows.map(r => r.jp ?? null),
        itemStyle: { color: PALETTE.muted },
      },
      {
        name: '南韓',
        type: 'bar',
        data: rows.map(r => r.kr ?? null),
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
