// 資金雷達 tab — 仿 Prospero.Ai 五軸雷達，用可回測、無未來函數的免費代理指標重建：
//   暗池買盤(FINRA short volume ratio) / 空單壓力(FINRA short interest days-to-cover) /
//   期權情緒(equity Put/Call) / 技術面(MA/MACD/RSI 合成) / 尾部風險(CBOE SKEW)。
// 純計算層在 flowradar_calc.mjs（無 DOM/ECharts 依賴，可獨立測試）；本檔只負責
// 資料載入、chip 控制與 ECharts 繪圖。
// ⚠️ 這是代理指標，不是 Prospero 的原始數值；FINRA short volume ≠ 空單餘額；
// P/C 與 SKEW 是全市場指標，不分 SPY/QQQ。

import { isLight, mob, PALETTE } from '../utils/theme.js';
import { chipPicker } from '../utils/dom.js';
import { fetchJSON } from '../utils/data.js';
import { buildAxes, svrRaw, shortPressureRaw, optionsRaw, skewRaw } from './flowradar_calc.mjs';

const AXIS_ORDER = ['darkpool', 'short', 'options', 'technical', 'skew'];

const AXIS_DEFS = {
  darkpool:   { label: '暗池買盤', host: 'fr-chart-darkpool',  rawLabel: 'SVR',  rawFmt: v => v.toFixed(3), color: '#3fb950' },
  short:      { label: '空單壓力', host: 'fr-chart-short',     rawLabel: 'DTC',  rawFmt: v => v.toFixed(2), color: '#f0883e' },
  options:    { label: '期權情緒', host: 'fr-chart-options',   rawLabel: 'P/C',  rawFmt: v => v.toFixed(3), color: '#e3b341' },
  technical:  { label: '技術面',   host: 'fr-chart-technical', rawLabel: null,   rawFmt: null,              color: '#58a6ff' },
  skew:       { label: '尾部風險', host: 'fr-chart-skew',      rawLabel: 'SKEW', rawFmt: v => v.toFixed(1), color: '#f85149' },
};

const RADAR_LOOKBACK_DAYS = 20; // 「20 個交易日前」的比較多邊形

let symbol = 'SPY';
let range = '3M';

let radarChart = null;
const lineCharts = {}; // key -> echarts instance

let raw = null;      // 載入的原始資料（跨 symbol 共用）
const bySymbol = {}; // symbol -> { dates, axes, rawSeries, prices }

// ── data load ────────────────────────────────────────────────────────────
async function loadAll() {
  if (raw) return;
  const [spyRows, qqqRows, svRows, siRows, pcPayload, skewPayload] = await Promise.all([
    fetchJSON('data/SPY.json'),
    fetchJSON('data/QQQ.json'),
    fetchJSON('data/finra_shortvol.json'),
    fetchJSON('data/finra_short_interest.json'),
    fetchJSON('data/putcall.json'),
    fetchJSON('data/vix_skew.json'),
  ]);
  raw = {
    priceRows: {
      SPY: spyRows.map(r => [r.date, r.close]),
      QQQ: qqqRows.map(r => [r.date, r.close]),
    },
    svRows,
    siRows,
    pcRows: pcPayload.equity ?? [],
    skewRows: skewPayload.history ?? [],
    lastDates: {
      darkpool: svRows.length ? svRows[svRows.length - 1].date : null,
      short: siRows.length ? siRows[siRows.length - 1].date : null,
      options: (pcPayload.equity ?? []).length ? pcPayload.equity[pcPayload.equity.length - 1].date : null,
      skew: (skewPayload.history ?? []).length ? skewPayload.history[skewPayload.history.length - 1].d : null,
    },
  };
}

function computeSymbol(sym) {
  if (bySymbol[sym]) return bySymbol[sym];
  const priceRows = raw.priceRows[sym];
  const { dates, axes } = buildAxes({
    symbol: sym,
    priceRows,
    svRows: raw.svRows,
    siRows: raw.siRows,
    pcRows: raw.pcRows,
    skewRows: raw.skewRows,
  });
  const rawSeries = {
    darkpool: svrRaw(dates, raw.svRows, sym),
    short: shortPressureRaw(dates, raw.siRows, sym),
    options: optionsRaw(dates, raw.pcRows),
    skew: skewRaw(dates, raw.skewRows),
  };
  const priceMap = new Map(priceRows);
  const prices = dates.map(d => priceMap.get(d) ?? null);
  bySymbol[sym] = { dates, axes, rawSeries, prices };
  return bySymbol[sym];
}

// ── range cutoff ─────────────────────────────────────────────────────────
// 本 tab 的 range key 集合(3M/1Y/3Y)與 dates.presetStart(6M/1Y/1Y6M/…)、
// dates.cutoffDate(1Y/3Y/5Y/10Y/MAX)皆不同(3M 兩邊都沒有)，故不重用、自己寫
// 一個小的(同 js/tabs/vixskew.js 的 rangeStart 慣例：check_reuse: keep)。
function rangeCutoff(key) {
  const d = new Date();
  if (key === '3M') d.setMonth(d.getMonth() - 3);
  else if (key === '1Y') d.setFullYear(d.getFullYear() - 1);
  else d.setFullYear(d.getFullYear() - 3); // '3Y'（也是未命中時的預設）
  // check_reuse: keep — 本地 range cutoff 變體(3M/1Y/3Y 與 dates.presetStart/cutoffDate 的 key 集合皆不同，換過去會改行為，同 vixskew.js 的 rangeStart 慣例)
  return d.toISOString().slice(0, 10);
}

function fmtScore(v) {
  return v == null ? '–' : v.toFixed(0);
}

// ── radar ────────────────────────────────────────────────────────────────
function renderRadar(cur) {
  if (!radarChart) return;
  const n = cur.dates.length;
  const latestIdx = n - 1;
  const prevIdx = Math.max(0, n - 1 - RADAR_LOOKBACK_DAYS);

  const indicator = AXIS_ORDER.map(k => ({
    name: `${AXIS_DEFS[k].label}\n${fmtScore(cur.axes[k][latestIdx])}`,
    max: 100,
  }));

  const latestValues = AXIS_ORDER.map(k => cur.axes[k][latestIdx] ?? 0);
  const prevValues = AXIS_ORDER.map(k => cur.axes[k][prevIdx] ?? 0);

  radarChart.setOption({
    backgroundColor: 'transparent',
    tooltip: {
      backgroundColor: PALETTE.bg, borderColor: PALETTE.border,
      textStyle: { color: PALETTE.text, fontSize: 12 },
    },
    legend: {
      data: ['最新', `${RADAR_LOOKBACK_DAYS}個交易日前`], top: 0, left: 'center',
      textStyle: { color: PALETTE.text2, fontSize: 11 }, inactiveColor: PALETTE.muted,
    },
    radar: {
      indicator,
      radius: mob() ? '55%' : '65%',
      splitNumber: 4,
      axisName: { color: PALETTE.text2, fontSize: 11 },
      splitLine: { lineStyle: { color: PALETTE.grid } },
      splitArea: { areaStyle: { color: ['transparent', 'transparent'] } },
      axisLine: { lineStyle: { color: PALETTE.border } },
    },
    series: [{
      type: 'radar',
      data: [
        {
          name: '最新', value: latestValues,
          areaStyle: { color: '#58a6ff', opacity: 0.22 },
          lineStyle: { color: '#58a6ff', width: 2 },
          itemStyle: { color: '#58a6ff' },
        },
        {
          name: `${RADAR_LOOKBACK_DAYS}個交易日前`, value: prevValues,
          areaStyle: { opacity: 0 },
          lineStyle: { color: PALETTE.muted, width: 1.5, type: 'dashed' },
          itemStyle: { color: PALETTE.muted },
        },
      ],
    }],
  }, { notMerge: true });
}

function renderDatesLine() {
  const el = document.getElementById('fr-dates');
  if (!el || !raw) return;
  const parts = [
    `暗池 ${raw.lastDates.darkpool ?? '—'}`,
    `空單 ${raw.lastDates.short ?? '—'}`,
    `期權 ${raw.lastDates.options ?? '—'}`,
    `技術面 ${bySymbol[symbol]?.dates.at(-1) ?? '—'}`,
    `SKEW ${raw.lastDates.skew ?? '—'}`,
  ];
  el.textContent = `各軸最新資料日期 — ${parts.join(' · ')}`;
}

// ── 五張時序圖(分數 vs 價格雙軸) ───────────────────────────────────────────
function viewIndices(dates) {
  const cut = rangeCutoff(range);
  const idx = [];
  for (let i = 0; i < dates.length; i++) if (dates[i] >= cut) idx.push(i);
  return idx;
}

function buildAxisChartOption(key, cur, viewIdx) {
  const def = AXIS_DEFS[key];
  const viewDates = viewIdx.map(i => cur.dates[i]);
  const scoreArr = viewIdx.map(i => cur.axes[key][i]);
  const priceArr = viewIdx.map(i => cur.prices[i]);
  const rawArr = def.rawLabel ? viewIdx.map(i => cur.rawSeries[key][i]) : null;

  return {
    backgroundColor: 'transparent', animation: false,
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'cross' },
      backgroundColor: PALETTE.bg, borderColor: PALETTE.border,
      textStyle: { color: PALETTE.text, fontSize: 12 },
      formatter(params) {
        const d = params[0]?.axisValue ?? '';
        const i = params[0]?.dataIndex;
        let html = `<div style="font-weight:600;margin-bottom:4px">${d}</div>`;
        for (const p of params) {
          if (p.value == null) continue;
          html += `<div>${p.marker}${p.seriesName}: <b>${(+p.value).toFixed(p.seriesName === symbol ? 2 : 1)}</b></div>`;
        }
        if (rawArr && i != null && rawArr[i] != null) {
          html += `<div style="color:${PALETTE.muted}">${def.rawLabel} ${def.rawFmt(rawArr[i])}</div>`;
        }
        return html;
      },
    },
    legend: {
      data: [def.label, symbol], top: 2, left: 'center',
      textStyle: { color: PALETTE.text2, fontSize: 11 }, inactiveColor: PALETTE.muted,
    },
    grid: { left: mob() ? 44 : 56, right: mob() ? 44 : 56, top: '16%', bottom: '14%' },
    xAxis: {
      type: 'category', data: viewDates, boundaryGap: false,
      axisLine: { lineStyle: { color: PALETTE.muted } }, axisTick: { show: false },
      axisLabel: { color: PALETTE.muted, fontSize: 11 },
      splitLine: { show: false },
    },
    yAxis: [
      {
        type: 'value', name: '分數', min: 0, max: 100, position: 'left',
        nameTextStyle: { color: PALETTE.muted, fontSize: 10 },
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: PALETTE.muted, fontSize: 11 },
        splitLine: { lineStyle: { color: PALETTE.grid } },
      },
      {
        type: 'value', name: symbol, position: 'right', scale: true,
        nameTextStyle: { color: PALETTE.muted, fontSize: 10 },
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: PALETTE.muted, fontSize: 11 },
        splitLine: { show: false },
      },
    ],
    dataZoom: [{ type: 'inside', filterMode: 'none' }],
    series: [
      {
        name: def.label, type: 'line', data: scoreArr, symbol: 'none',
        connectNulls: false, yAxisIndex: 0,
        itemStyle: { color: def.color }, lineStyle: { color: def.color, width: 2 },
      },
      {
        name: symbol, type: 'line', data: priceArr, symbol: 'none',
        connectNulls: true, yAxisIndex: 1,
        itemStyle: { color: PALETTE.muted }, lineStyle: { color: PALETTE.muted, width: 1, opacity: 0.7 },
      },
    ],
  };
}

function renderLineCharts(cur) {
  const viewIdx = viewIndices(cur.dates);
  for (const key of AXIS_ORDER) {
    const chart = lineCharts[key];
    if (!chart) continue;
    chart.setOption(buildAxisChartOption(key, cur, viewIdx), { notMerge: true });
  }
}

function renderAll() {
  const cur = computeSymbol(symbol);
  renderRadar(cur);
  renderLineCharts(cur);
  renderDatesLine();
}

function buildControls() {
  const sp = document.getElementById('fr-symbol-picker');
  chipPicker(sp, 'fr-symbol', v => { symbol = v; renderAll(); });
  const rp = document.getElementById('fr-range-picker');
  chipPicker(rp, 'fr-range', v => { range = v; renderLineCharts(computeSymbol(symbol)); });
}

// ── lifecycle ────────────────────────────────────────────────────────────
export async function activate() {
  const radarHost = document.getElementById('fr-radar-chart');
  if (!radarHost) return; // 正常情況下只有 flowradar tab 被掛載時才有這個 host
  if (!radarChart) radarChart = echarts.init(radarHost, isLight() ? null : 'dark');
  for (const key of AXIS_ORDER) {
    const host = document.getElementById(AXIS_DEFS[key].host);
    if (host && !lineCharts[key]) lineCharts[key] = echarts.init(host, isLight() ? null : 'dark');
  }
  buildControls();

  const status = document.getElementById('fr-status');
  try {
    await loadAll();
    renderAll();
    if (status) status.textContent = `資金雷達 · ${symbol} · ${bySymbol[symbol].dates.length} 個交易日`;
  } catch (e) {
    if (status) status.textContent = '載入失敗：' + (e.message || e);
    console.error('[flowradar] load failed', e);
  }
}

export function onThemeChange(light) {
  if (!radarChart) return;
  radarChart.dispose();
  radarChart = echarts.init(document.getElementById('fr-radar-chart'), light ? null : 'dark');
  for (const key of AXIS_ORDER) {
    const host = document.getElementById(AXIS_DEFS[key].host);
    if (!host) continue;
    lineCharts[key]?.dispose();
    lineCharts[key] = echarts.init(host, light ? null : 'dark');
  }
  if (raw) renderAll();
}

export function resize() {
  radarChart?.resize();
  for (const key of AXIS_ORDER) lineCharts[key]?.resize();
}
