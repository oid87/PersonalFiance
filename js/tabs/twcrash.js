// 台股歷史股災 tab — TWII 全期間走勢 + 8 個歷史回撤區間標記
// 資料：data/TWII.json（1997-07-02 起），全前端計算，不另開 fetch。
//
// 8 個事件的高點/低點日期與指數，已用 data/TWII.json 實際資料核對過（[實測]，
// 2026-09-12 執行本次任務時 grep 確認皆為精確交易日，spec 表格數字與實際收盤價
// 差異僅在小數點四捨五入，例如 2008次貸風暴低點 spec 寫 4090、實際 4089.93）。

import { echartsBase, isLight, PALETTE } from '../utils/theme.js';
import { fetchJSON } from '../utils/data.js';

const CRASHES = [
  { name: '2000科技泡沫',     peakDate: '2000-02-17', peak: 10202, troughDate: '2001-10-03', trough: 3446,  pct: -66.2 },
  { name: '2008次貸風暴',     peakDate: '2007-10-29', peak: 9810,  troughDate: '2008-11-20', trough: 4090,  pct: -58.3 },
  { name: '2011歐債危機',     peakDate: '2011-01-28', peak: 9145,  troughDate: '2011-12-19', trough: 6633,  pct: -27.5 },
  { name: '2015人民幣/股災',  peakDate: '2015-04-27', peak: 9973,  troughDate: '2015-08-24', trough: 7410,  pct: -25.7 },
  { name: '2018中美貿易戰',   peakDate: '2018-01-23', peak: 11253, troughDate: '2019-01-04', trough: 9383,  pct: -16.6 },
  { name: '2020新冠疫情',     peakDate: '2020-01-14', peak: 12180, troughDate: '2020-03-19', trough: 8681,  pct: -28.7 },
  { name: '2022通膨+強升息',  peakDate: '2022-01-04', peak: 18526, troughDate: '2022-10-25', trough: 12666, pct: -31.6 },
  { name: '2025對等關稅',     peakDate: '2025-02-21', peak: 23730, troughDate: '2025-04-09', trough: 17392, pct: -26.7 },
];

let chart = null;
let cache = null; // { dates, closes }

async function loadAll() {
  if (cache) return;
  const rows = await fetchJSON('data/TWII.json');
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  cache = {
    dates: sorted.map(r => r.date),
    closes: sorted.map(r => r.close),
  };
}

function buildOption() {
  const { dates, closes } = cache;
  const areaData = CRASHES.map(c => [
    { name: `${c.name} ${c.pct}%`, xAxis: c.peakDate, itemStyle: { color: PALETTE.grid, opacity: 0.55 } },
    { xAxis: c.troughDate },
  ]);
  return echartsBase({
    tooltip: { trigger: 'axis' },
    grid: { top: '10%' },
    xAxis: { data: dates },
    yAxis: { type: 'log', name: 'TWII' },
    series: [
      {
        name: 'TWII', type: 'line', data: closes,
        showSymbol: false, itemStyle: { color: PALETTE.text }, lineStyle: { width: 1.2 },
        markArea: {
          silent: true,
          label: { show: true, position: 'insideTop', color: PALETTE.text2, fontSize: 10 },
          data: areaData,
        },
      },
    ],
  });
}

function renderNote() {
  const el = document.getElementById('twcrash-note');
  if (!el) return;
  el.textContent = '近 29 年（1997年至今）台股發生 8 次重大回撤，平均約 3–4 年一次；' +
    '長期回測「創新高」對個人投資年限的參考意義有限，應對照自己實際可用的投資年限判斷風險承受度，' +
    '而非假設自己有「100 年」可以等待均值回歸。';
}

export async function activate() {
  const host = document.getElementById('twcrash-chart');
  if (!host) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : 'dark');
  try {
    await loadAll();
    chart.setOption(buildOption(), { notMerge: true });
    renderNote();
  } catch (e) {
    console.error('[twcrash] load failed', e);
  }
}

export function onThemeChange(_light) {
  if (!chart || !cache) return;
  chart.setOption(buildOption(), { notMerge: true });
}

export function resize() {
  chart?.resize();
}
