// 外資板塊流向 tab
// A: 板塊指數（正規化至100）  B: 外資累積淨買超（萬張）  雙線 sparkline × 18 板塊

import { isLight, tc, mob } from '../utils/theme.js';

const KEYS = [
  "semiconductor","finance","e_components","telecom","computer",
  "shipping","steel","biotech","optoelectronics","construction",
  "tourism","food","plastics","oil_gas","digital_cloud","green_energy",
  "machinery","electronics",
];

const LABEL = {
  semiconductor:"半導體", finance:"金融保險", shipping:"航運", steel:"鋼鐵",
  biotech:"生技醫療", telecom:"通信網路", optoelectronics:"光電", computer:"電腦週邊",
  e_components:"電子零組件", construction:"建材營造", tourism:"觀光餐旅",
  food:"食品", plastics:"塑膠", oil_gas:"油電燃氣",
  digital_cloud:"數位雲端", green_energy:"綠能環保", machinery:"電機機械",
  electronics:"其他電子",
};

let flowData  = null;
let indexData = null;
let charts    = {};
let sortBy    = '1W';
let inited    = false;

async function loadAll() {
  if (flowData && indexData) return;
  const [fRes, iRes] = await Promise.all([
    fetch('data/tw_sector_flow.json',   { cache: 'no-cache' }),
    fetch('data/taiwan_sector_index.json', { cache: 'no-cache' }),
  ]);
  if (!fRes.ok) throw new Error(`tw_sector_flow.json: HTTP ${fRes.status}`);
  if (!iRes.ok) throw new Error(`taiwan_sector_index.json: HTTP ${iRes.status}`);
  flowData  = await fRes.json();
  indexData = await iRes.json();
}

function cutDate1Y() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  // check_reuse: keep — 本地 range cutoff 變體:preset key 集合/MAX 哨兵/未命中預設與 dates.presetStart、dates.cutoffDate 皆不同,換過去會改行為
  return d.toISOString().slice(0, 10);
}

function netLots(key, tradingDays) {
  const rows = flowData?.sectors?.[key];
  if (!rows?.length) return null;
  const recent = rows.slice(-tradingDays);
  return recent.reduce((s, r) => s + r[1], 0);
}

function fmt(v) {
  if (v == null) return '—';
  const k = Math.round(v / 10000);
  return (k >= 0 ? '+' : '') + k.toLocaleString() + '萬張';
}

function flowColor(v, light) {
  if (v == null) return light ? '#888' : '#8b949e';
  return v >= 0
    ? (light ? '#1a7f37' : '#3fb950')
    : (light ? '#cf222e' : '#f85149');
}

function buildCard(key, light) {
  const w1 = netLots(key, 5);
  const m1 = netLots(key, 21);
  const div = document.createElement('div');
  div.className = 'sf-card';
  div.innerHTML = `
    <div class="sf-card-title">${LABEL[key] || key}</div>
    <div class="sf-card-stats">
      <span style="color:${flowColor(w1,light)}">1W&nbsp;${fmt(w1)}</span>
      <span style="color:${flowColor(m1,light)}">1M&nbsp;${fmt(m1)}</span>
    </div>
    <div id="sf-chart-${key}" class="sf-chart-el"></div>
  `;
  return div;
}

function renderChart(key, light) {
  const el = document.getElementById(`sf-chart-${key}`);
  if (!el) return;

  const cut = cutDate1Y();
  const flowRows = (flowData?.sectors?.[key] ?? []).filter(r => r[0] >= cut);
  const idxRaw   = (indexData?.data?.[key]   ?? []).filter(r => r[0] >= cut);

  if (!flowRows.length && !idxRaw.length) return;

  const idxBase = idxRaw[0]?.[1] || 1;
  const idxNorm = idxRaw.map(([d, v]) => [d, +((v / idxBase) * 100).toFixed(2)]);

  let cum = 0;
  const cumFlow = flowRows.map(([d, v]) => { cum += v; return [d, cum]; });

  if (charts[key]) charts[key].dispose();
  const ec = echarts.init(el, light ? null : 'dark', { renderer: 'svg' });
  charts[key] = ec;

  const IDX_COLOR  = light ? '#1f6feb' : '#58a6ff';
  const FLOW_COLOR = light ? '#d45f00' : '#f0883e';

  ec.setOption({
    animation: false,
    grid: { top: 4, bottom: 18, left: 34, right: 36 },
    xAxis: {
      type: 'category', show: true, boundaryGap: false,
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { show: false },
    },
    yAxis: [
      {
        type: 'value', scale: true,
        axisLabel: { fontSize: 8, color: IDX_COLOR, formatter: v => v.toFixed(0) },
        splitLine: { lineStyle: { color: light ? '#e0e0e0' : '#30363d', type: 'dashed' } },
        axisLine: { show: false }, axisTick: { show: false },
      },
      {
        type: 'value', scale: true,
        axisLabel: {
          fontSize: 8, color: FLOW_COLOR,
          formatter: v => (v / 10000).toFixed(0),
        },
        splitLine: { show: false },
        axisLine: { show: false }, axisTick: { show: false },
      },
    ],
    series: [
      {
        name: '板塊指數',
        type: 'line', yAxisIndex: 0,
        data: idxNorm,
        symbol: 'none',
        lineStyle: { width: 1.5, color: IDX_COLOR },
        areaStyle: { opacity: 0.07, color: IDX_COLOR },
      },
      {
        name: '外資累積(萬張)',
        type: 'line', yAxisIndex: 1,
        data: cumFlow,
        symbol: 'none',
        lineStyle: { width: 1.5, color: FLOW_COLOR },
        markLine: cumFlow.length ? {
          symbol: 'none', silent: true,
          lineStyle: { type: 'dashed', color: '#888', width: 0.5, opacity: 0.6 },
          data: [{ yAxis: 0, yAxisIndex: 1 }],
        } : undefined,
      },
    ],
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: '#666', type: 'dashed' } },
      textStyle: { fontSize: 11 },
      formatter: params => {
        const date = params[0]?.axisValue ?? '';
        const lines = params.map(p => {
          if (p.seriesName === '板塊指數') {
            return `${p.marker}指數 ${p.value?.[1]?.toFixed(1) ?? '—'}`;
          }
          const lots = p.value?.[1];
          const v = lots != null ? (lots / 10000).toFixed(1) + '萬張' : '—';
          return `${p.marker}外資累積 ${v}`;
        });
        return `<div style="font-size:10px;color:#888">${date}</div>${lines.join('<br>')}`;
      },
    },
  });
}

function sortedKeys() {
  const days = sortBy === '1W' ? 5 : 21;
  const active = KEYS.filter(k => flowData?.sectors?.[k] || indexData?.data?.[k]);
  return [...active].sort((a, b) => (netLots(b, days) ?? -Infinity) - (netLots(a, days) ?? -Infinity));
}

function render(light) {
  const grid   = document.getElementById('sf-grid');
  const status = document.getElementById('sf-status');
  if (!grid) return;

  Object.values(charts).forEach(c => c?.dispose());
  charts = {};
  grid.innerHTML = '';

  const keys = sortedKeys();
  for (const key of keys) grid.appendChild(buildCard(key, light));
  for (const key of keys) renderChart(key, light);

  const updated = flowData?.updated ?? '';
  if (status && updated) status.textContent = `外資日頻（TWSE T86）+ 板塊指數 | 更新：${updated}`;
}

export function init() {
  if (inited) return;
  inited = true;

  document.getElementById('sf-sort-1w')?.addEventListener('click', () => {
    sortBy = '1W';
    document.getElementById('sf-sort-1w')?.classList.add('active');
    document.getElementById('sf-sort-1m')?.classList.remove('active');
    if (flowData && indexData) render(isLight());
  });
  document.getElementById('sf-sort-1m')?.addEventListener('click', () => {
    sortBy = '1M';
    document.getElementById('sf-sort-1m')?.classList.add('active');
    document.getElementById('sf-sort-1w')?.classList.remove('active');
    if (flowData && indexData) render(isLight());
  });

  loadAll()
    .then(() => render(isLight()))
    .catch(err => {
      const s = document.getElementById('sf-status');
      if (s) s.textContent = `載入失敗：${err.message}`;
    });
}

export function onThemeChange(light) {
  Object.values(charts).forEach(c => c?.dispose());
  charts = {};
  if (flowData && indexData) render(light);
}

export function resize() {
  Object.values(charts).forEach(c => c?.resize());
}
