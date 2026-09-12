// VIX 十年季節性 tab — 8/1~12/31「日曆偏移量」對齊，比較近10年季節性均值 vs 今年實際
// 資料：data/VIX_early.json（1986-01-02~1999-12-31）+ data/VIX.json（2000-01-03~今天），前端合併。
//
// 方法（spec 2026-09-12 定案）：
//   offset(date) = date 距離 Y 年 8/1 的天數（0~152，8/1~12/31 共 153 天）
//   基準年份 = 去年往前推 10 個完整年份（動態算，非寫死）
//   forward-fill：用 lookupLE（"last entry where arr[i][0] <= date"）在該年序列上
//     取「當天或之前最近交易日」收盤價，補上週末/假日缺值
//   markLine：11/3 期中選舉參考線，offset 動態算（非寫死 94）
//
// 偏離：spec 文字寫「js/utils/math.js 的 lookupLE」，但 lookupLE 實際 export 在
// js/utils/dates.js（math.js 沒有這個函式）——已核對兩檔內容，此處改從正確位置 import。

import { echartsBase, isLight, PALETTE } from '../utils/theme.js';
import { fetchJSON } from '../utils/data.js';
import { lookupLE } from '../utils/dates.js';

const WINDOW_DAYS = 153; // 8/1~12/31：Aug(31-1=30 剩餘)+Sep30+Oct31+Nov30+Dec31 = 153
const NUM_BASE_YEARS = 10;

let chart = null;
let cache = null; // { baseYears, thisYear, seasonalAvg, thisYearActual, labels, electionOffset }

function pad2(n) { return String(n).padStart(2, '0'); }

// offset 0..152 -> "YYYY-MM-DD"（year 年 8/1 起算第 offset 天）
function offsetToDate(year, offset) {
  const d = new Date(Date.UTC(year, 7, 1));
  d.setUTCDate(d.getUTCDate() + offset);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

// 同一個 offset 轉回「MM/DD」顯示用（固定參考年份 refYear，只取月-日）
function offsetToLabel(refYear, offset) {
  return offsetToDate(refYear, offset).slice(5).replace('-', '/');
}

async function loadAll() {
  if (cache) return;
  const [early, recent] = await Promise.all([
    fetchJSON('data/VIX_early.json'),
    fetchJSON('data/VIX.json'),
  ]);
  const pairs = [...early, ...recent]
    .map(r => [r.date, r.close])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const today = new Date();
  const thisYear = today.getFullYear();
  const lastFullYear = thisYear - 1;
  const baseYears = [];
  for (let y = lastFullYear - NUM_BASE_YEARS + 1; y <= lastFullYear; y++) baseYears.push(y);

  // 每個基準年份：153 個 offset 的 forward-fill VIX 值
  const perYear = baseYears.map(y => {
    const arr = new Array(WINDOW_DAYS).fill(null);
    for (let d = 0; d < WINDOW_DAYS; d++) {
      const hit = lookupLE(pairs, offsetToDate(y, d));
      arr[d] = hit ? hit[1] : null;
    }
    return arr;
  });

  const seasonalAvg = new Array(WINDOW_DAYS).fill(null);
  for (let d = 0; d < WINDOW_DAYS; d++) {
    const vals = perYear.map(arr => arr[d]).filter(v => v != null);
    seasonalAvg[d] = vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2) : null;
  }

  // 今年實際：只算到今天，不 forward-fill 超過今天
  const todayStr = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;
  const thisYearActual = new Array(WINDOW_DAYS).fill(null);
  for (let d = 0; d < WINDOW_DAYS; d++) {
    const dateStr = offsetToDate(thisYear, d);
    if (dateStr > todayStr) break;
    const hit = lookupLE(pairs, dateStr);
    thisYearActual[d] = hit ? hit[1] : null;
  }

  const labels = Array.from({ length: WINDOW_DAYS }, (_, d) => offsetToLabel(thisYear, d));
  // 11/3 期中選舉的 offset：Aug1(refYear) -> Nov3(refYear) 天數差，動態算（跟閏年無關，8~11月不含2月）
  const electionOffset = Math.round((Date.UTC(thisYear, 10, 3) - Date.UTC(thisYear, 7, 1)) / 86400000);

  cache = { baseYears, thisYear, seasonalAvg, thisYearActual, labels, electionOffset };
}

function buildOption() {
  const { seasonalAvg, thisYearActual, labels, electionOffset } = cache;
  return echartsBase({
    tooltip: { trigger: 'axis' },
    legend: {
      data: ['十年季節性均值', '今年實際'],
      top: 4, textStyle: { color: PALETTE.text2, fontSize: 11 },
    },
    grid: { top: '16%' },
    xAxis: { data: labels },
    yAxis: { name: 'VIX' },
    series: [
      {
        name: '十年季節性均值', type: 'line', data: seasonalAvg,
        showSymbol: false, connectNulls: true,
        itemStyle: { color: PALETTE.muted }, lineStyle: { type: 'dashed', width: 1.5 },
        markLine: {
          silent: true, symbol: 'none',
          lineStyle: { color: PALETTE.border, type: 'dashed' },
          label: { color: PALETTE.muted, fontSize: 10, formatter: '11/3 期中選舉' },
          data: [{ xAxis: labels[electionOffset] }],
        },
      },
      {
        name: '今年實際', type: 'line', data: thisYearActual,
        showSymbol: false, connectNulls: true,
        itemStyle: { color: PALETTE.text }, lineStyle: { width: 2 },
      },
    ],
  });
}

function renderStatus() {
  const el = document.getElementById('vixseason-status');
  if (!el || !cache) return;
  const { baseYears, thisYear } = cache;
  el.textContent = `基準年份：${baseYears[0]}–${baseYears[baseYears.length - 1]}（10年）；今年：${thisYear}；` +
    `資料來源：data/VIX_early.json + data/VIX.json`;
}

export async function activate() {
  const host = document.getElementById('vixseason-chart');
  if (!host) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : 'dark');
  try {
    await loadAll();
    chart.setOption(buildOption(), { notMerge: true });
    renderStatus();
  } catch (e) {
    console.error('[vixseason] load failed', e);
    const s = document.getElementById('vixseason-status');
    if (s) s.textContent = '載入失敗：' + (e.message || e);
  }
}

export function onThemeChange(_light) {
  if (!chart || !cache) return;
  chart.setOption(buildOption(), { notMerge: true });
}

export function resize() {
  chart?.resize();
}
