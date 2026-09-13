// js/tabs/semi_vs_spx_pe.js — 半導體(SOXX) vs 大盤(SPY) 前瞻本益比對照
//
// 兩條 forward P/E 線各自從自己實際涵蓋的起點畫起(SOXX 2004-10 起、SPY 2007-08
// 起,不裁齊),疊加 NBER 衰退期灰底(data/USREC.json)。資料來源:
//   data/SOXX_valuation.json / data/SPY_valuation.json — scripts/backfill_etf_valuation.py
//   data/USREC.json — scripts/fetch_usrec.py (FRED USREC)
// 三份都是既有 SERIES 之外的獨立檔,不走 loadSeries/ensureLoaded,直接用
// utils/data.js 的 fetchJSON 讀 { data: [...] } payload。

import { isLight, echartsBase, PALETTE } from '../utils/theme.js';
import { fetchJSON } from '../utils/data.js';

const TAB_ID = 'semi_vs_spx_pe';
let chart = null;
let soxxRows = null;   // [{date, fpe, tpe, src}]
let spyRows = null;    // [{date, fpe, tpe, src}]
let recAreas = null;   // [[startDate, endDate], ...]

// 兩檔資料涵蓋範圍的較早起點,USREC 衰退區間只取這之後的,避免畫出資料涵蓋不到的灰底
const SINCE_DATE = '2004-10-01';

async function loadAll() {
  if (soxxRows && spyRows && recAreas) return; // 首次切入才載入
  const [soxx, spy, usrec] = await Promise.all([
    fetchJSON('data/SOXX_valuation.json'),
    fetchJSON('data/SPY_valuation.json'),
    fetchJSON('data/USREC.json'),
  ]);
  soxxRows = soxx;
  spyRows = spy;
  recAreas = computeRecessionIntervals(usrec, SINCE_DATE);
}

// USREC 是月頻 0/1 序列,轉成連續衰退區間 [startDate, endDate]
function computeRecessionIntervals(rows, sinceDate) {
  const intervals = [];
  let start = null;
  let prevDate = null;
  for (const r of rows) {
    if (r.date < sinceDate) continue;
    if (r.usrec === 1 && start === null) start = r.date;
    if (r.usrec === 0 && start !== null) {
      intervals.push([start, prevDate]);
      start = null;
    }
    prevDate = r.date;
  }
  if (start !== null) intervals.push([start, prevDate]);
  return intervals;
}

function toPoints(rows) {
  return (rows ?? [])
    .filter(r => r.fpe != null)
    .map(r => [r.date, r.fpe]);
}

function latestOf(rows) {
  const pts = toPoints(rows);
  return pts.length ? pts[pts.length - 1] : null;
}

// fpe_harmonic 只從 2026-09-13 起才有(見 fetch_soxx/spy_valuation.py),
// 找最後一筆有這個欄位的記錄,而不是強制用陣列最後一筆(可能還沒跑今日更新)
function latestHarmonicOf(rows) {
  const withHarmonic = (rows ?? []).filter(r => r.fpe_harmonic != null);
  if (!withHarmonic.length) return null;
  const r = withHarmonic[withHarmonic.length - 1];
  return [r.date, r.fpe_harmonic];
}

function buildOption() {
  const soxxPts = toPoints(soxxRows);
  const spyPts = toPoints(spyRows);
  const areaData = (recAreas ?? []).map(([s, e]) => [
    { xAxis: s, itemStyle: { color: PALETTE.grid, opacity: 0.5 } },
    { xAxis: e },
  ]);

  return echartsBase({
    legend: {
      top: 0,
      textStyle: { color: PALETTE.muted, fontSize: 12 },
    },
    grid: { top: '16%' },
    tooltip: {
      trigger: 'axis',
      valueFormatter: (v) => (v == null ? '–' : `${(+v).toFixed(2)}x`),
    },
    xAxis: { type: 'time' },
    yAxis: {
      type: 'value',
      name: 'Forward P/E (x)',
      nameTextStyle: { color: PALETTE.muted },
      axisLabel: { formatter: '{value}x' },
    },
    series: [
      {
        name: 'SOXX 半導體 forward P/E',
        type: 'line',
        data: soxxPts,
        showSymbol: false,
        itemStyle: { color: '#22d3ee' },
        lineStyle: { width: 1.4 },
        markArea: {
          silent: true,
          itemStyle: { color: PALETTE.grid, opacity: 0.5 },
          label: { show: false },
          data: areaData,
        },
      },
      {
        name: 'SPY 大盤 forward P/E',
        type: 'line',
        data: spyPts,
        showSymbol: false,
        itemStyle: { color: '#f0883e' },
        lineStyle: { width: 1.4 },
      },
    ],
  });
}

function renderNote() {
  const el = document.getElementById(`${TAB_ID}-latest`);
  if (!el) return;
  const soxxLatest = latestOf(soxxRows);
  const spyLatest = latestOf(spyRows);
  if (!soxxLatest || !spyLatest) {
    el.textContent = '最新一筆資料讀取失敗。';
    return;
  }
  const soxxH = latestHarmonicOf(soxxRows);
  const spyH = latestHarmonicOf(spyRows);
  let text =
    `最新一筆(圖上線,加權算術平均) — SOXX 半導體 forward P/E：${soxxLatest[1].toFixed(2)}x（${soxxLatest[0]}）` +
    `　｜　SPY 大盤 forward P/E：${spyLatest[1].toFixed(2)}x（${spyLatest[0]}）`;
  if (soxxH && spyH) {
    const cheaper = soxxH[1] < spyH[1] ? '半導體比大盤便宜' : '半導體比大盤貴';
    text +=
      `\n現在到底貴不貴,看這行更準(加權調和平均,不受少數高PE小權重個股扭曲) — ` +
      `SOXX：${soxxH[1].toFixed(2)}x　｜　SPY：${spyH[1].toFixed(2)}x → 目前${cheaper}`;
  }
  el.textContent = text;
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
  if (!chart || !soxxRows) return;
  chart.setOption(buildOption(), { notMerge: true });
}

export function resize() {
  chart?.resize();
}
