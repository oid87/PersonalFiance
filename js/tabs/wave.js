// 波浪理論 tab — 四大指數（台股/QQQ/SPY/SOXX）標準化對照線圖 + 靜態知識表格
// 資料：直接 fetch data/TWII.json + QQQ/SPY/SOXX.json（無需新 fetch 腳本）
// 標準化基準：各指數 2022/10 月內最低收盤 = 100（Wave II 底部）

import { isLight, tc } from '../utils/theme.js';

const TICKERS = [
  { file: 'data/TWII.json', key: 'TWII', label: '台股 TAIEX', color: '#E9A810', width: 2,   ltype: 'solid'  },
  { file: 'data/QQQ.json',  key: 'QQQ',  label: 'QQQ',        color: '#3fb950', width: 1.5, ltype: [6, 3]   },
  { file: 'data/SPY.json',  key: 'SPY',  label: 'SPY',        color: '#58a6ff', width: 1.5, ltype: 'dashed' },
  { file: 'data/SOXX.json', key: 'SOXX', label: 'SOXX 半導體', color: '#a371f7', width: 2,   ltype: 'solid'  },
];

const WAVE_III_DATE = '2024-07-14';
const WAVE_IV_DATE  = '2025-04-20';

let chart = null;
let rawData = {};   // key → [{date, close}]
let wRange = '4Y';
let ready = false;

// ── 公開介面 ─────────────────────────────────────────────────────────
export async function init() {
  if (ready) { render(isLight()); return; }
  const status = document.getElementById('wave-status');
  if (status) status.textContent = '載入中…';
  try {
    const jsons = await Promise.all(TICKERS.map(t => fetch(t.file).then(r => r.json())));
    TICKERS.forEach((t, i) => {
      rawData[t.key] = (jsons[i].data || []).filter(r => r.close > 0);
    });
    setupControls();
    render(isLight());
    updateCards();
    ready = true;
    if (status) status.textContent =
      `更新至 ${jsons[0].updated || ''} ｜ 標準化基準：各指數 2022/10 低點 = 100`;
  } catch (err) {
    if (status) status.textContent = `載入失敗：${err.message}`;
  }
}

export function onThemeChange(light) { if (ready) render(light); }
export function resize() { chart?.resize(); }

// ── 控制 ──────────────────────────────────────────────────────────────
function setupControls() {
  document.querySelectorAll('#wave-range-picker .chip').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#wave-range-picker .chip')
        .forEach(b => b.classList.toggle('active', b === btn));
      wRange = btn.dataset.range;
      render(isLight());
    });
  });
}

// ── 標準化 ────────────────────────────────────────────────────────────
function getOct22Base(data) {
  const seg = data.filter(d => d.date >= '2022-10-01' && d.date <= '2022-11-30');
  if (!seg.length) return null;
  return Math.min(...seg.map(d => d.close));
}

function cutoffDate() {
  if (wRange === 'MAX') return '2022-01-01';
  const d = new Date();
  const y = { '2Y': -2, '4Y': -4 }[wRange] ?? -4;
  d.setFullYear(d.getFullYear() + y);
  return d.toISOString().slice(0, 10);
}

// ── ECharts 線圖 ──────────────────────────────────────────────────────
function render(light) {
  const el = document.getElementById('wave-chart');
  if (!el || !Object.keys(rawData).length) return;
  if (chart) { chart.dispose(); chart = null; }
  chart = echarts.init(el, light ? null : 'dark');

  const from = cutoffDate();
  const axisClr = tc('#768390', '#636e7b');
  const gridClr = tc('rgba(0,0,0,0.04)', 'rgba(255,255,255,0.05)');

  const series = [];
  for (const t of TICKERS) {
    const data = rawData[t.key];
    if (!data?.length) continue;
    const base = getOct22Base(data);
    if (!base) continue;
    const pts = data
      .filter(d => d.date >= from)
      .map(d => [d.date, +(d.close / base * 100).toFixed(2)]);

    series.push({
      name: t.label,
      type: 'line',
      data: pts,
      smooth: 0.15,
      symbol: 'none',
      lineStyle: { color: t.color, width: t.width, type: t.ltype },
      itemStyle: { color: t.color },
      ...(t.key === 'TWII' ? {
        markLine: {
          silent: true,
          symbol: ['none', 'none'],
          data: [
            { xAxis: WAVE_III_DATE, name: 'Wave III 頂',
              lineStyle: { color: '#E9A810', type: 'dashed', width: 1.5 },
              label: { show: true, formatter: '③頂\n2024/07', position: 'insideStartTop', fontSize: 10, color: '#E9A810', backgroundColor: 'transparent' } },
            { xAxis: WAVE_IV_DATE, name: 'Wave IV 底',
              lineStyle: { color: '#f85149', type: 'dashed', width: 1.5 },
              label: { show: true, formatter: '④底\n2025/04', position: 'insideStartTop', fontSize: 10, color: '#f85149', backgroundColor: 'transparent' } },
          ],
        },
        markArea: {
          silent: true,
          data: [[
            { yAxis: 368, itemStyle: { color: 'rgba(233,168,16,0.07)', borderWidth: 0 } },
            { yAxis: 422 }
          ]],
          label: { show: true, position: 'insideTopRight', formatter: '台股目標\n47k–54k', fontSize: 9, color: '#E9A810' },
        },
      } : {}),
    });
  }

  chart.setOption({
    tooltip: {
      trigger: 'axis',
      formatter: params => {
        let s = `<b>${params[0].axisValue}</b><br/>`;
        params.forEach(p => {
          const v = p.value?.[1];
          if (v != null)
            s += `<span style="color:${p.color}">●</span> ${p.seriesName}: <b>${(+v).toFixed(1)}</b><br/>`;
        });
        return s;
      },
    },
    legend: { show: false },
    grid: { top: 28, right: 28, bottom: 52, left: 60 },
    xAxis: {
      type: 'time',
      axisLabel: { fontSize: 11, color: axisClr },
      axisLine:  { lineStyle: { color: axisClr } },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      name: '基準 = 100',
      nameTextStyle: { fontSize: 10, color: axisClr },
      min: v => Math.floor(v.min * 0.96 / 10) * 10,
      axisLabel: { fontSize: 11, color: axisClr },
      splitLine: { lineStyle: { color: gridClr } },
    },
    series,
    dataZoom: [
      { type: 'inside', xAxisIndex: 0 },
      {
        type: 'slider', xAxisIndex: 0, height: 18, bottom: 6,
        fillerColor: 'rgba(128,128,128,0.1)', borderColor: 'transparent',
        handleStyle: { color: '#888' }, textStyle: { fontSize: 10, color: axisClr },
      },
    ],
  });
}

// ── 摘要卡片 ─────────────────────────────────────────────────────────
function updateCards() {
  for (const t of TICKERS) {
    const data = rawData[t.key];
    if (!data?.length) continue;
    const base = getOct22Base(data);
    const last = data[data.length - 1];
    if (!base || !last) continue;

    const norm = last.close / base * 100;
    const pct  = (norm - 100).toFixed(0);
    const absStr = t.key === 'TWII'
      ? Math.round(last.close).toLocaleString()
      : `$${Math.round(last.close)}`;

    const el = document.getElementById(`wave-card-${t.key.toLowerCase()}`);
    if (!el) continue;
    el.querySelector('.wc-pct').textContent  = `+${pct}%`;
    el.querySelector('.wc-abs').textContent  = absStr;
    el.querySelector('.wc-date').textContent = last.date;
    el.querySelector('.wc-norm').textContent = `(${norm.toFixed(1)})`;
  }
}
