// js/tabs/sox_vs_tw_semi_pe.js — SOX(全球半導體) vs 台灣半導體籃子 前瞻本益比對照
//
// 跟既有的 js/tabs/semi_vs_spx_pe.js（SOXX vs SPY）是同一套「forward P/E 對照」
// 手法，但這裡比較的是「全球半導體代表(SOXX)」vs「台灣半導體代表(自建籃子)」，
// 不跟 SOXX vs SPY 併圖——因為 SOXX 有 2004 年至今的回補歷史，而台灣半導體籃子
// (data/tw_semi_valuation.json) 是全新資料源、從 2026-09-13 才開始每日累積，
// 兩者歷史深度差太多個量級，併圖會讓台灣那條線在時間軸上完全看不出東西，
// 所以另開一個 tab，時間軸只需要對齊「兩者都有資料」的較短窗格也不會失真。
//
// 主要對照線用 fpe_harmonic（加權調和平均，不受少數高PE小權重成分股扭曲，
// 是判斷「現在貴不貴」更準的數字——同一套教訓見 semi_vs_spx_pe.js 與
// scripts/fetch_soxx_valuation.py docstring）。fpe（加權算術平均）疊加畫成
// 虛線，只作歷史脈絡參考，不是判斷貴賤的主線。
//
// 資料來源：
//   data/SOXX_valuation.json      — scripts/fetch_soxx_valuation.py（回補至2004-10）
//   data/tw_semi_valuation.json   — scripts/fetch_tw_semi_valuation.py（自建市值加權
//                                    籃子：台積電2330/聯發科2454/日月光投控3711/
//                                    聯電2303/南亞科2408/創意3443/群聯8299/環球晶6488/
//                                    瑞昱2379/京元電子2449，權重詳見腳本 docstring）
// 兩份都是既有 SERIES 之外的獨立檔，直接用 utils/data.js 的 fetchJSON 讀
// { data: [...] } payload。

import { isLight, echartsBase, PALETTE } from '../utils/theme.js';
import { fetchJSON } from '../utils/data.js';

const TAB_ID = 'sox_vs_tw_semi_pe';
let chart = null;
let soxxRows = null;   // [{date, fpe, fpe_harmonic, tpe, src}]
let twSemiRows = null; // [{date, fpe, fpe_harmonic, coverage_pct, src}]

async function loadAll() {
  if (soxxRows && twSemiRows) return; // 首次切入才載入
  const [soxx, twSemi] = await Promise.all([
    fetchJSON('data/SOXX_valuation.json'),
    fetchJSON('data/tw_semi_valuation.json'),
  ]);
  soxxRows = soxx;
  twSemiRows = twSemi;
}

function toPoints(rows, field) {
  return (rows ?? [])
    .filter(r => r[field] != null)
    .map(r => [r.date, r[field]]);
}

function latestOf(rows, field) {
  const pts = toPoints(rows, field);
  return pts.length ? pts[pts.length - 1] : null;
}

function buildOption() {
  const soxxHarmonicPts = toPoints(soxxRows, 'fpe_harmonic');
  const twSemiHarmonicPts = toPoints(twSemiRows, 'fpe_harmonic');
  const soxxArithPts = toPoints(soxxRows, 'fpe');
  const twSemiArithPts = toPoints(twSemiRows, 'fpe');

  return echartsBase({
    legend: {
      top: 0,
      textStyle: { color: PALETTE.muted, fontSize: 12 },
    },
    grid: { top: '18%' },
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
        name: 'SOX 全球半導體 forward P/E(調和平均)',
        type: 'line',
        data: soxxHarmonicPts,
        showSymbol: true,
        symbolSize: 6,
        itemStyle: { color: '#22d3ee' },
        lineStyle: { width: 1.6 },
      },
      {
        name: '台灣半導體籃子 forward P/E(調和平均)',
        type: 'line',
        data: twSemiHarmonicPts,
        showSymbol: true,
        symbolSize: 6,
        itemStyle: { color: '#f0883e' },
        lineStyle: { width: 1.6 },
      },
      {
        name: 'SOX forward P/E(算術平均,歷史脈絡)',
        type: 'line',
        data: soxxArithPts,
        showSymbol: false,
        itemStyle: { color: '#22d3ee' },
        lineStyle: { width: 1, type: 'dashed', opacity: 0.5 },
      },
      {
        name: '台灣半導體籃子 forward P/E(算術平均,歷史脈絡)',
        type: 'line',
        data: twSemiArithPts,
        showSymbol: false,
        itemStyle: { color: '#f0883e' },
        lineStyle: { width: 1, type: 'dashed', opacity: 0.5 },
      },
    ],
  });
}

function renderNote() {
  const el = document.getElementById(`${TAB_ID}-latest`);
  if (!el) return;
  const soxxArith = latestOf(soxxRows, 'fpe');
  const twArith = latestOf(twSemiRows, 'fpe');
  const soxxH = latestOf(soxxRows, 'fpe_harmonic');
  const twH = latestOf(twSemiRows, 'fpe_harmonic');

  if (!soxxArith || !twArith) {
    el.textContent = '最新一筆資料讀取失敗。';
    return;
  }

  let text =
    `最新一筆(算術平均,歷史脈絡用) — SOX：${soxxArith[1].toFixed(2)}x（${soxxArith[0]}）` +
    `　｜　台灣半導體籃子：${twArith[1].toFixed(2)}x（${twArith[0]}）`;

  if (soxxH && twH) {
    const cheaper = twH[1] < soxxH[1] ? '台灣半導體比SOX便宜' : '台灣半導體比SOX貴';
    text +=
      `\n現在到底貴不貴,看這行更準(加權調和平均,不受少數高PE小權重個股扭曲) — ` +
      `SOX：${soxxH[1].toFixed(2)}x　｜　台灣半導體籃子：${twH[1].toFixed(2)}x → 目前${cheaper}`;
  }
  const cov = twSemiRows?.length ? twSemiRows[twSemiRows.length - 1].coverage_pct : null;
  if (cov != null) {
    text += `\n台灣半導體籃子當日資料覆蓋率：${cov.toFixed(1)}%（籃子總權重中，有NTM本益比估計值可用的比例）`;
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
