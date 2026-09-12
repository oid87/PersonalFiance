// 選舉週期季節性 tab — 三合一（子圖 A/B/C），全部只用 data/SP500.json（1987-01-02 起）。
// 資料來源：投影片講座提到的季節性/事件研究圖表，這裡用公開歷史價格自算重現。
//
// 子圖 A：9月/11月 vs 其他月份 — 固定樣本窗口 2001-2025（25個完整年份，寫死不 drift）月內累積報酬路徑
// 子圖 B：期中選舉年 vs 全樣本 — Aug~隔年Feb 各月已實現波動率中位數（分組長條）
// 子圖 C：四年總統任期週期 rebase=100 percentile band（僅 9 個完整週期，1988-11 起）+ 當前週期對照
//
// 三個子圖用三個獨立 <div> + 三個 echarts instance（而非同一 tab 內再切換），
// 理由：三張圖的計算邏輯彼此獨立、樣本窗口不同，攤開一次看比切換更容易對照三張投影片原圖。

import { echartsBase, isLight, PALETTE } from '../utils/theme.js';
import { fetchJSON } from '../utils/data.js';
import { std, percentile } from '../utils/math.js';

// ── 子圖 A 常數 ──────────────────────────────────────────────────────────
const MONTHLY_START_YEAR = 2001;
const MONTHLY_END_YEAR = 2025; // 固定窗口，投影片原圖抓的是固定 25 年，不用「今年往前25年」

// ── 子圖 B 常數 ──────────────────────────────────────────────────────────
const MID_TERM_YEARS = [1990, 1994, 1998, 2002, 2006, 2010, 2014, 2018, 2022];
const FULL_SAMPLE_START = 1987;
const FULL_SAMPLE_END = 2025;
// Aug~Dec 屬選舉年當年；Jan/Feb 屬選舉「後」隔年 —— yearOffset 標記這個位移
const MONTH_ORDER = [
  { label: 'Aug', m: 8, yearOffset: 0 },
  { label: 'Sep', m: 9, yearOffset: 0 },
  { label: 'Oct', m: 10, yearOffset: 0 },
  { label: 'Nov', m: 11, yearOffset: 0 },
  { label: 'Dec', m: 12, yearOffset: 0 },
  { label: 'Jan', m: 1, yearOffset: 1 },
  { label: 'Feb', m: 2, yearOffset: 1 },
];

// ── 子圖 C 常數 ──────────────────────────────────────────────────────────
const CYCLE_STARTS = [
  '1988-11-01', '1992-11-01', '1996-11-01', '2000-11-01', '2004-11-01',
  '2008-11-01', '2012-11-01', '2016-11-01', '2020-11-01',
];
const CURRENT_CYCLE_START = '2024-11-01';

let chartA = null, chartB = null, chartC = null;
let cache = null; // { monthly, vol, cycle }

function pad2(n) { return String(n).padStart(2, '0'); }
function median(vals) {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  return percentile(s, 0.5);
}

// ── 子圖 A：月內累積報酬路徑 ──────────────────────────────────────────
function computeMonthlyPaths(rows) {
  const buckets = { 9: [], 11: [], other: [] };
  for (let y = MONTHLY_START_YEAR; y <= MONTHLY_END_YEAR; y++) {
    for (let m = 1; m <= 12; m++) {
      const prefix = `${y}-${pad2(m)}`;
      const monthRows = rows.filter(r => r.date.startsWith(prefix));
      if (!monthRows.length) continue;
      const base = monthRows[0].close;
      const key = m === 9 ? 9 : m === 11 ? 11 : 'other';
      monthRows.forEach((r, n) => {
        const pct = (r.close / base - 1) * 100;
        (buckets[key][n] ??= []).push(pct);
      });
    }
  }
  const avg = arr => arr.map(vals => (vals && vals.length)
    ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(3)
    : null);
  return { sept: avg(buckets[9]), nov: avg(buckets[11]), other: avg(buckets.other) };
}

// ── 子圖 B：已實現波動率 ────────────────────────────────────────────────
function buildLogReturns(rows) {
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const p0 = rows[i - 1].close, p1 = rows[i].close;
    if (p0 > 0 && p1 > 0) out.push({ date: rows[i].date, ret: Math.log(p1 / p0) });
  }
  return out;
}

function realizedVolForYearMonth(logRets, y, m) {
  const prefix = `${y}-${pad2(m)}`;
  const vals = logRets.filter(r => r.date.startsWith(prefix)).map(r => r.ret);
  if (vals.length < 2) return null;
  const s = std(vals, 0);
  return s == null ? null : s * Math.sqrt(252) * 100;
}

function computeVolTable(rows) {
  const logRets = buildLogReturns(rows);
  const fullMedian = [], midMedian = [];
  for (const { m } of MONTH_ORDER) {
    const fullVals = [];
    for (let y = FULL_SAMPLE_START; y <= FULL_SAMPLE_END; y++) {
      const v = realizedVolForYearMonth(logRets, y, m);
      if (v != null) fullVals.push(v);
    }
    fullMedian.push(median(fullVals));
  }
  for (const { m, yearOffset } of MONTH_ORDER) {
    const midVals = [];
    for (const ey of MID_TERM_YEARS) {
      const v = realizedVolForYearMonth(logRets, ey + yearOffset, m);
      if (v != null) midVals.push(v);
    }
    midMedian.push(median(midVals));
  }
  return { fullMedian, midMedian };
}

// ── 子圖 C：四年總統任期週期 ────────────────────────────────────────────
// Binary search: 第一筆 date >= dateStr 的 row index（跟 dates.lookupLE 相反方向 —
// lookupLE 是「<= date 最後一筆」，這裡週期起點要找「起點當天或之後最近交易日」）
function findFirstOnOrAfter(rows, dateStr) {
  let lo = 0, hi = rows.length - 1, res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].date >= dateStr) { res = mid; hi = mid - 1; } else lo = mid + 1;
  }
  return res;
}

function computeCyclePaths(rows) {
  const allStarts = [...CYCLE_STARTS, CURRENT_CYCLE_START]; // 10 個邊界 -> 9 個完整週期 + 1 個進行中週期
  const anchorIdxs = allStarts.map(d => findFirstOnOrAfter(rows, d));

  const paths = [];
  for (let c = 0; c < CYCLE_STARTS.length; c++) {
    const startIdx = anchorIdxs[c], endIdx = anchorIdxs[c + 1];
    if (startIdx < 0 || endIdx < 0) continue;
    const base = rows[startIdx].close;
    const path = [];
    for (let i = startIdx; i < endIdx; i++) path.push((rows[i].close / base) * 100);
    paths.push(path);
  }

  const maxLen = Math.max(0, ...paths.map(p => p.length));
  const p25 = [], p50 = [], p75 = [];
  for (let i = 0; i < maxLen; i++) {
    const vals = paths.map(p => p[i]).filter(v => v != null).sort((a, b) => a - b);
    if (!vals.length) { p25.push(null); p50.push(null); p75.push(null); continue; }
    p25.push(+percentile(vals, 0.25).toFixed(2));
    p50.push(+percentile(vals, 0.5).toFixed(2));
    p75.push(+percentile(vals, 0.75).toFixed(2));
  }

  // 當前週期（2024-11-01 至今），不納入 percentile 計算，只疊加對照
  const curStartIdx = anchorIdxs[anchorIdxs.length - 1];
  const current = [];
  if (curStartIdx >= 0) {
    const base = rows[curStartIdx].close;
    for (let i = curStartIdx; i < rows.length; i++) current.push(+((rows[i].close / base) * 100).toFixed(2));
  }

  return { p25, p50, p75, current, maxLen, n: paths.length };
}

// ── data load ────────────────────────────────────────────────────────────
async function loadAll() {
  if (cache) return;
  const rows = await fetchJSON('data/SP500.json');
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  cache = {
    monthly: computeMonthlyPaths(sorted),
    vol: computeVolTable(sorted),
    cycle: computeCyclePaths(sorted),
  };
}

// ── option builders ───────────────────────────────────────────────────────
function buildOptionA() {
  const { sept, nov, other } = cache.monthly;
  const maxLen = Math.max(sept.length, nov.length, other.length);
  const pad = arr => { const out = arr.slice(); while (out.length < maxLen) out.push(null); return out; };
  const cats = Array.from({ length: maxLen }, (_, i) => `${i}`);
  return echartsBase({
    tooltip: { trigger: 'axis' },
    legend: { data: ['9月', '11月', '其他月份平均'], top: 4, textStyle: { color: PALETTE.text2, fontSize: 11 } },
    grid: { top: '18%' },
    xAxis: { data: cats, name: '月內第N個交易日', nameLocation: 'middle', nameGap: 26 },
    yAxis: { name: '累積報酬%' },
    series: [
      {
        name: '9月', type: 'line', data: pad(sept), showSymbol: false,
        itemStyle: { color: PALETTE.text }, lineStyle: { width: 2 },
      },
      {
        name: '11月', type: 'line', data: pad(nov), showSymbol: false,
        itemStyle: { color: PALETTE.text2 }, lineStyle: { width: 2, type: 'dotted' },
      },
      {
        name: '其他月份平均', type: 'line', data: pad(other), showSymbol: false,
        itemStyle: { color: PALETTE.muted }, lineStyle: { width: 1.5, type: 'dashed' },
        markLine: {
          silent: true, symbol: 'none',
          lineStyle: { color: PALETTE.border },
          label: { show: false },
          data: [{ yAxis: 0 }],
        },
      },
    ],
  });
}

function buildOptionB() {
  const { fullMedian, midMedian } = cache.vol;
  const cats = MONTH_ORDER.map(x => x.label);
  return echartsBase({
    tooltip: { trigger: 'axis' },
    legend: { data: ['期中選舉年中位數', '全樣本中位數'], top: 4, textStyle: { color: PALETTE.text2, fontSize: 11 } },
    grid: { top: '18%' },
    xAxis: { type: 'category', data: cats },
    yAxis: { name: '已實現波動率(年化%)' },
    series: [
      {
        name: '期中選舉年中位數', type: 'bar',
        data: midMedian.map(v => v == null ? null : +v.toFixed(2)),
        itemStyle: { color: PALETTE.text },
      },
      {
        name: '全樣本中位數', type: 'bar',
        data: fullMedian.map(v => v == null ? null : +v.toFixed(2)),
        itemStyle: { color: PALETTE.muted },
      },
    ],
  });
}

function buildOptionC() {
  const { p25, p50, p75, current, maxLen } = cache.cycle;
  const cats = Array.from({ length: maxLen }, (_, i) => `${i}`);
  const curPadded = cats.map((_, i) => (i < current.length ? current[i] : null));
  return echartsBase({
    tooltip: { trigger: 'axis' },
    legend: {
      data: ['75th', '中位數(50th)', '25th', '當前週期(2024-11起)'],
      top: 4, textStyle: { color: PALETTE.text2, fontSize: 11 },
    },
    grid: { top: '18%' },
    xAxis: { data: cats, name: '週期內第N個交易日', nameLocation: 'middle', nameGap: 26 },
    yAxis: { name: 'Rebased=100' },
    series: [
      {
        name: '75th', type: 'line', data: p75, showSymbol: false,
        itemStyle: { color: PALETTE.muted }, lineStyle: { type: 'dashed', width: 1 },
      },
      {
        name: '中位數(50th)', type: 'line', data: p50, showSymbol: false,
        itemStyle: { color: PALETTE.text }, lineStyle: { width: 2 },
      },
      {
        name: '25th', type: 'line', data: p25, showSymbol: false,
        itemStyle: { color: PALETTE.muted }, lineStyle: { type: 'dashed', width: 1 },
      },
      {
        name: '當前週期(2024-11起)', type: 'line', data: curPadded, showSymbol: false,
        itemStyle: { color: PALETTE.text2 }, lineStyle: { width: 2, type: 'dotted' },
      },
    ],
  });
}

function renderNote() {
  const el = document.getElementById('elecseason-note-c');
  if (!el || !cache) return;
  el.textContent = `樣本僅 ${cache.cycle.n} 個完整週期（1988年11月起，受限於 SP500.json 資料起始於 1987年），` +
    `與市場上常見「1928年以來」的統計樣本數不同，僅供參考。`;
}

function renderAll() {
  if (!cache) return;
  chartA?.setOption(buildOptionA(), { notMerge: true });
  chartB?.setOption(buildOptionB(), { notMerge: true });
  chartC?.setOption(buildOptionC(), { notMerge: true });
  renderNote();
}

// ── lifecycle ──────────────────────────────────────────────────────────
export async function activate() {
  const hostA = document.getElementById('elecseason-chart-a');
  const hostB = document.getElementById('elecseason-chart-b');
  const hostC = document.getElementById('elecseason-chart-c');
  if (!hostA || !hostB || !hostC) return;
  const darkTheme = isLight() ? null : 'dark';
  if (!chartA) chartA = echarts.init(hostA, darkTheme);
  if (!chartB) chartB = echarts.init(hostB, darkTheme);
  if (!chartC) chartC = echarts.init(hostC, darkTheme);
  try {
    await loadAll();
    renderAll();
  } catch (e) {
    console.error('[elecseason] load failed', e);
  }
}

export function onThemeChange(_light) {
  renderAll();
}

export function resize() {
  chartA?.resize();
  chartB?.resize();
  chartC?.resize();
}
