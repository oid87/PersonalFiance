// QQQ 短線籌碼雷達 tab — QQQ 專用六軸雷達＋「向上突破／向下跌破」歷史條件命中率。
// 純計算在 qqqradar_calc.mjs（前四軸重用 flowradar_calc.mjs）；本檔只負責載入、控制項與繪圖。
// ⚠️ 代理指標，不是 Prospero 原始數值；命中率是 point-in-time 歷史統計，不是預測。

import { isLight, mob, PALETTE } from '../utils/theme.js';
import { chipPicker } from '../utils/dom.js';
import { requestJSON, clearRequestCache } from '../utils/data.js';
import { presetStart, cutoffDate } from '../utils/dates.js';
import {
  AXIS_KEYS, HORIZONS, SHORT_STALE_DAYS, shiftToPublication, buildQqqAxes, forwardOutcomes, pointInTimeRates, bucketTable, bucketOf,
  vxnRaw, breadthRaw,
} from './qqqradar_calc.mjs';
import { svrRaw, shortPressureRaw, optionsRaw } from './flowradar_calc.mjs';

const AXIS_DEFS = {
  offex:     { label: '場外空賣比', rawLabel: 'SVR(5日均)', rawFmt: v => v.toFixed(3), color: '#3fb950' },
  short:     { label: '空單壓力',   rawLabel: 'DTC',        rawFmt: v => v.toFixed(2), color: '#f0883e' },
  options:   { label: '期權情緒',   rawLabel: 'P/C(5日均)', rawFmt: v => v.toFixed(3), color: '#e3b341' },
  technical: { label: '技術面',     rawLabel: null,         rawFmt: null,              color: '#58a6ff' },
  vxn:       { label: '科技波動',   rawLabel: 'VXN',        rawFmt: v => v.toFixed(2), color: '#f85149' },
  breadth:   { label: 'NDX廣度',    rawLabel: '>MA20 %',    rawFmt: v => v.toFixed(1), color: '#a371f7' },
  composite: { label: '綜合分數',   rawLabel: null,         rawFmt: null,              color: '#d2a8ff' },
};
const UP_COLOR = '#3fb950';
const DOWN_COLOR = '#f85149';
const RADAR_LOOKBACK_DAYS = 20;
const PATHS = ['data/QQQ.json', 'data/finra_shortvol.json', 'data/finra_short_interest.json',
  'data/putcall.json', 'data/VXN.json', 'data/breadth_ndx.json'];

let horizonKey = '10D';
let range = '1Y';
let axisKey = 'composite';

let radarChart = null;
let breakoutChart = null;
let axisChart = null;

let model = null;          // { dates, rows, axes, composite, raw, lastDates }
const outcomeCache = {};   // horizonKey -> { rates, table }

// ── data ─────────────────────────────────────────────────────────────────
const hasRows = (rows, field) => Array.isArray(rows) && rows.some(r => typeof r?.date === 'string' && Number.isFinite(r[field]));

async function loadAll(context = {}) {
  if (model) return;
  const [qqq, sv, si, pc, vxn, br] = await Promise.all(PATHS.map(path => requestJSON(path, { signal: context.signal })));
  if (!hasRows(qqq?.data, 'close') || !hasRows(sv?.data, 'QQQ_sv') || !hasRows(si?.data, 'QQQ_dtc') ||
      !hasRows(pc?.equity, 'pc') || !hasRows(vxn?.data, 'close') || !hasRows(br?.data, 'above20_pct')) {
    PATHS.forEach(clearRequestCache);
    throw new Error('QQQ 短線雷達：必要資料缺漏');
  }
  if (context.signal?.aborted || context.isCurrent?.() === false) throw new DOMException('Activation expired', 'AbortError');
  const built = buildQqqAxes({
    ohlc: qqq.data, svRows: sv.data, siRows: si.data, pcRows: pc.equity, vxnRows: vxn.data, breadthRows: br.data,
  });
  const { dates } = built;
  const last = rows => rows.filter(r => typeof r?.date === 'string').at(-1)?.date ?? '—';
  model = {
    ...built,
    raw: {
      offex: svrRaw(dates, sv.data, 'QQQ'),
      short: shortPressureRaw(dates, shiftToPublication(si.data), 'QQQ', { staleDays: SHORT_STALE_DAYS }),
      options: optionsRaw(dates, pc.equity),
      vxn: vxnRaw(dates, vxn.data),
      breadth: breadthRaw(dates, br.data),
    },
    lastDates: {
      offex: last(sv.data), short: `${last(si.data)}(結算)`, options: last(pc.equity),
      technical: dates.at(-1), vxn: last(vxn.data), breadth: last(br.data),
    },
  };
}

function outcomesFor(key) {
  if (outcomeCache[key]) return outcomeCache[key];
  const { horizon, threshold } = HORIZONS[key];
  const outcomes = forwardOutcomes(model.rows, horizon, threshold);
  outcomeCache[key] = {
    rates: pointInTimeRates(model.composite, outcomes, horizon),
    table: bucketTable(model.composite, outcomes),
  };
  return outcomeCache[key];
}

function rangeStart(key) {
  return key === '6M' || key === '1Y' ? presetStart(key) : cutoffDate(key);
}

function viewIndices() {
  const cut = rangeStart(range);
  const first = model.composite.findIndex(v => v != null);
  const out = [];
  for (let i = Math.max(0, first); i < model.dates.length; i++) if (model.dates[i] >= cut) out.push(i);
  return out;
}

const fmt = (v, d = 0) => v == null ? '–' : (+v).toFixed(d);
const horizonText = key => `${HORIZONS[key].horizon}日 ±${HORIZONS[key].threshold * 100}%`;

// ── cards ────────────────────────────────────────────────────────────────
function lastIndexWith(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return i;
  return -1;
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function renderCards() {
  const { rates, table } = outcomesFor(horizonKey);
  const i = lastIndexWith(model.composite);
  const comp = i >= 0 ? model.composite[i] : null;
  setText('qr-comp-val', fmt(comp));
  const b = bucketOf(comp);
  setText('qr-comp-sub', b != null ? `${model.dates[i]} · 分組 ${table.buckets[b].lo}–${table.buckets[b].hi}` : '六軸資料不齊');
  setText('qr-up-label', `向上突破 ${horizonText(horizonKey)}`);
  setText('qr-down-label', `向下跌破 ${horizonText(horizonKey)}`);
  const n = i >= 0 ? rates.samples[i] : 0;
  setText('qr-up-val', fmt(i >= 0 ? rates.upRate[i] : null, 1));
  setText('qr-down-val', fmt(i >= 0 ? rates.downRate[i] : null, 1));
  const baseUp = table.base.upRate, baseDown = table.base.downRate;
  setText('qr-up-sub', `同組歷史 n=${n} · 全樣本平均(事後) ${fmt(baseUp, 1)}%`);
  setText('qr-down-sub', `同組歷史 n=${n} · 全樣本平均(事後) ${fmt(baseDown, 1)}%`);
}

function renderDatesLine() {
  const ld = model.lastDates;
  setText('qr-dates', '各軸最新資料日期：' + AXIS_KEYS.map(k => `${AXIS_DEFS[k].label} ${ld[k]}`).join(' · '));
}

// ── radar ────────────────────────────────────────────────────────────────
function renderRadar() {
  if (!radarChart) return;
  const i = lastIndexWith(model.composite);
  const latestIdx = i >= 0 ? i : model.dates.length - 1;
  const prevIdx = Math.max(0, latestIdx - RADAR_LOOKBACK_DAYS);
  const values = idx => AXIS_KEYS.map(k => model.axes[k][idx] ?? 0);
  const prevName = `${RADAR_LOOKBACK_DAYS}個交易日前`;
  radarChart.setOption({
    backgroundColor: 'transparent',
    tooltip: { backgroundColor: PALETTE.bg, borderColor: PALETTE.border, textStyle: { color: PALETTE.text, fontSize: 12 } },
    legend: {
      data: [model.dates[latestIdx], prevName], top: 0, left: 'center',
      textStyle: { color: PALETTE.text2, fontSize: 11 }, inactiveColor: PALETTE.muted,
    },
    radar: {
      indicator: AXIS_KEYS.map(k => ({ name: `${AXIS_DEFS[k].label}\n${fmt(model.axes[k][latestIdx])}`, max: 100 })),
      radius: mob() ? '55%' : '65%', splitNumber: 4,
      axisName: { color: PALETTE.text2, fontSize: 11 },
      splitLine: { lineStyle: { color: PALETTE.grid } },
      splitArea: { areaStyle: { color: ['transparent', 'transparent'] } },
      axisLine: { lineStyle: { color: PALETTE.border } },
    },
    series: [{
      type: 'radar',
      data: [
        { name: model.dates[latestIdx], value: values(latestIdx),
          areaStyle: { color: '#d2a8ff', opacity: 0.25 }, lineStyle: { color: '#d2a8ff', width: 2 }, itemStyle: { color: '#d2a8ff' } },
        { name: prevName, value: values(prevIdx),
          areaStyle: { opacity: 0 }, lineStyle: { color: PALETTE.muted, width: 1.5, type: 'dashed' }, itemStyle: { color: PALETTE.muted } },
      ],
    }],
  }, { notMerge: true });
}

// ── time-series charts ───────────────────────────────────────────────────
function baseLineOption(viewDates, leftSuffix, leftRange, legendData) {
  return {
    backgroundColor: 'transparent', animation: false,
    legend: { data: legendData, top: 2, left: 'center', textStyle: { color: PALETTE.text2, fontSize: 11 }, inactiveColor: PALETTE.muted },
    grid: { left: mob() ? 40 : 52, right: mob() ? 40 : 52, top: mob() ? 52 : 36, bottom: 36 },
    xAxis: {
      type: 'category', data: viewDates, boundaryGap: false,
      axisLine: { lineStyle: { color: PALETTE.muted } }, axisTick: { show: false },
      axisLabel: { color: PALETTE.muted, fontSize: 11 }, splitLine: { show: false },
    },
    yAxis: [
      { type: 'value', ...leftRange, position: 'left', axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: PALETTE.muted, fontSize: 11, formatter: `{value}${leftSuffix}` },
        splitLine: { lineStyle: { color: PALETTE.grid } } },
      { type: 'value', position: 'right', scale: true, axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: PALETTE.muted, fontSize: 11 }, splitLine: { show: false } },
    ],
    dataZoom: [{ type: 'inside', filterMode: 'none' }],
  };
}

function priceSeries(view) {
  return {
    name: 'QQQ', type: 'line', yAxisIndex: 1, symbol: 'none', connectNulls: true,
    data: view.map(i => model.rows[i].close),
    itemStyle: { color: PALETTE.muted }, lineStyle: { color: PALETTE.muted, width: 1, opacity: 0.8 },
  };
}

function tooltip(formatter) {
  return {
    trigger: 'axis', axisPointer: { type: 'cross' },
    backgroundColor: PALETTE.bg, borderColor: PALETTE.border, textStyle: { color: PALETTE.text, fontSize: 12 }, formatter,
  };
}

function renderBreakoutChart() {
  if (!breakoutChart) return;
  const view = viewIndices();
  const { rates } = outcomesFor(horizonKey);
  const upName = `向上突破 ${horizonText(horizonKey)}`;
  const downName = `向下跌破 ${horizonText(horizonKey)}`;
  const opt = baseLineOption(view.map(i => model.dates[i]), '%', { min: 0, max: 100 }, [upName, downName, 'QQQ']);
  opt.tooltip = tooltip(params => {
    const idx = view[params[0]?.dataIndex];
    let html = `<div style="font-weight:600;margin-bottom:4px">${params[0]?.axisValue ?? ''}</div>`;
    for (const p of params) if (p.value != null) html += `<div>${p.marker}${p.seriesName}: <b>${(+p.value).toFixed(p.seriesName === 'QQQ' ? 2 : 1)}</b></div>`;
    if (idx != null) html += `<div style="color:${PALETTE.muted}">綜合分數 ${fmt(model.composite[idx])} · 同組 n=${rates.samples[idx]}</div>`;
    return html;
  });
  opt.series = [
    { name: upName, type: 'line', yAxisIndex: 0, symbol: 'none', data: view.map(i => rates.upRate[i]),
      itemStyle: { color: UP_COLOR }, lineStyle: { color: UP_COLOR, width: 2 } },
    { name: downName, type: 'line', yAxisIndex: 0, symbol: 'none', data: view.map(i => rates.downRate[i]),
      itemStyle: { color: DOWN_COLOR }, lineStyle: { color: DOWN_COLOR, width: 2 } },
    priceSeries(view),
  ];
  breakoutChart.setOption(opt, { notMerge: true });
}

function renderAxisChart() {
  if (!axisChart) return;
  const view = viewIndices();
  const def = AXIS_DEFS[axisKey];
  const scores = axisKey === 'composite' ? model.composite : model.axes[axisKey];
  const raw = model.raw[axisKey];
  const opt = baseLineOption(view.map(i => model.dates[i]), '', { min: 0, max: 100 }, [def.label, 'QQQ']);
  opt.tooltip = tooltip(params => {
    const idx = view[params[0]?.dataIndex];
    let html = `<div style="font-weight:600;margin-bottom:4px">${params[0]?.axisValue ?? ''}</div>`;
    for (const p of params) if (p.value != null) html += `<div>${p.marker}${p.seriesName}: <b>${(+p.value).toFixed(p.seriesName === 'QQQ' ? 2 : 1)}</b></div>`;
    if (def.rawLabel && raw && idx != null && raw[idx] != null) html += `<div style="color:${PALETTE.muted}">${def.rawLabel} ${def.rawFmt(raw[idx])}</div>`;
    return html;
  });
  opt.series = [
    { name: def.label, type: 'line', yAxisIndex: 0, symbol: 'none', connectNulls: false, data: view.map(i => scores[i]),
      itemStyle: { color: def.color }, lineStyle: { color: def.color, width: 2 } },
    priceSeries(view),
  ];
  axisChart.setOption(opt, { notMerge: true });
}

// ── bucket table ─────────────────────────────────────────────────────────
function renderTable() {
  const host = document.getElementById('qr-bucket-table');
  if (!host) return;
  const { table } = outcomesFor(horizonKey);
  const cur = bucketOf(model.composite[lastIndexWith(model.composite)] ?? null);
  const row = (label, x, active) => `<tr${active ? ' style="font-weight:700"' : ''}><td>${label}${active ? ' ◀ 目前' : ''}</td>` +
    `<td>${x.n}</td><td>${fmt(x.upRate, 1)}%</td><td>${fmt(x.downRate, 1)}%</td></tr>`;
  host.innerHTML = `<table class="info-table"><caption class="note-muted" style="text-align:left;padding:4px 0">` +
    `綜合分數分組 × ${horizonText(horizonKey)} 全樣本命中率（含已完結樣本，事後統計表）</caption>` +
    `<thead><tr><th>綜合分數</th><th>n</th><th>向上突破</th><th>向下跌破</th></tr></thead><tbody>` +
    table.buckets.map((b, k) => row(`${b.lo}–${b.hi}`, b, k === cur)).join('') +
    row('全樣本基準', table.base, false) + '</tbody></table>';
}

function renderAll() {
  renderCards();
  renderDatesLine();
  renderRadar();
  renderBreakoutChart();
  renderAxisChart();
  renderTable();
}

function buildControls() {
  chipPicker(document.getElementById('qr-horizon-picker'), 'qr-horizon', v => {
    horizonKey = v;
    if (!model) return;
    renderCards(); renderBreakoutChart(); renderTable();
  });
  chipPicker(document.getElementById('qr-range-picker'), 'qr-range', v => {
    range = v;
    if (!model) return;
    renderBreakoutChart(); renderAxisChart();
  });
  chipPicker(document.getElementById('qr-axis-picker'), 'qr-axis', v => {
    axisKey = v;
    if (model) renderAxisChart();
  });
}

function initCharts(light) {
  const theme = light ? null : 'dark';
  const init = id => {
    const host = document.getElementById(id);
    return host ? echarts.init(host, theme) : null;
  };
  radarChart = init('qr-radar-chart');
  breakoutChart = init('qr-breakout-chart');
  axisChart = init('qr-axis-chart');
}

// ── lifecycle ────────────────────────────────────────────────────────────
export async function activate(context = {}) {
  if (!document.getElementById('qr-radar-chart')) return;
  if (!radarChart) initCharts(isLight());
  buildControls();
  const status = document.getElementById('qr-status');
  try {
    await loadAll(context);
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (context.signal?.aborted || context.isCurrent?.() === false) throw new DOMException('Activation expired', 'AbortError');
    resize();
    renderAll();
    const first = model.dates[model.composite.findIndex(v => v != null)];
    if (status) status.textContent = `QQQ 短線雷達 · 綜合分數自 ${first} 起 · 資料至 ${model.dates.at(-1)}`;
  } catch (e) {
    if (status) status.textContent = '載入失敗：' + (e.message || e);
    console.error('[qqqradar] load failed', e);
    throw e;
  }
}

export function onThemeChange(light) {
  if (!radarChart) return;
  getCharts().forEach(c => c.dispose());
  initCharts(light);
  if (model) renderAll();
}

export function resize() {
  getCharts().forEach(c => c.resize());
}

export function getCharts() { return [radarChart, breakoutChart, axisChart].filter(Boolean); }
