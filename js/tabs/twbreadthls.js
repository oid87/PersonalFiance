// 台股多空家數 tab（近似版，非旺財紫線原版）。
// 逐檔判斷（上市普通股、原始收盤）：偏多＝收盤>MA20>MA60；偏空＝收盤<MA20<MA60；其餘中性。
// 資料：data/tw_breadth_ls.json（fetch_tw_breadth_ls.py，TWSE MI_INDEX 自算）、data/TWII.json。
// 百分位只描述當日數字在已收錄歷史中的相對位置，不代表未來走勢。

import { isLight, echartsBase, PALETTE, mob } from '../utils/theme.js';
import { chipPicker } from '../utils/dom.js';
import { requestJSON } from '../utils/data.js';
import { percentileRank } from '../utils/math.js';

const BULL = '#3fb950';
const BEAR = '#f85149';
const DIFF = '#58a6ff';
const $ = id => document.getElementById(`twbreadthls-${id}`);

let chart = null;
let raw = null;   // { rows, close: Map, updated, note }
let range = '3M';
const isNum = v => Number.isFinite(v);

async function loadAll(context = {}) {
  if (raw) return;
  const [b, t] = await Promise.all([
    requestJSON('data/tw_breadth_ls.json', { signal: context.signal }),
    requestJSON('data/TWII.json', { signal: context.signal }),
  ]);
  const rows = (b?.data ?? []).filter(r => typeof r?.date === 'string' && isNum(r.bull) && isNum(r.bear));
  if (!rows.length) throw new Error('多空家數資料不足');
  if (!Array.isArray(t?.data) || !t.data.some(r => isNum(r?.close))) throw new Error('加權指數資料格式不完整');
  if (context.signal?.aborted || context.isCurrent?.() === false) return;
  raw = { rows, close: new Map(t.data.filter(r => isNum(r?.close)).map(r => [r.date, r.close])), updated: b.updated, note: b.note };
}

function cutIndex(key) {
  const dates = raw.rows.map(r => r.date);
  if (key === 'MAX') return 0;
  const d = new Date(dates.at(-1) + 'T00:00:00');
  d.setMonth(d.getMonth() - ({ '1M': 1, '3M': 3, '6M': 6, '1Y': 12 }[key] ?? 3));
  const cut = d.toISOString().slice(0, 10);
  const i = dates.findIndex(x => x >= cut);
  return i < 0 ? 0 : i;
}

function setText(id, txt, color) {
  const el = $(id);
  if (!el) return;
  el.textContent = txt;
  if (color) el.style.color = color;
}

function updateCards() {
  const rows = raw.rows;
  const last = rows.at(-1);
  const bullSorted = rows.map(r => r.bull).sort((a, b) => a - b);
  const bearSorted = rows.map(r => r.bear).sort((a, b) => a - b);
  const pb = percentileRank(last.bull, bullSorted) * 100;
  const pr = percentileRank(last.bear, bearSorted) * 100;
  setText('bull', `${last.bull}`, BULL);
  setText('bear', `${last.bear}`, BEAR);
  setText('diff', `${last.bull - last.bear >= 0 ? '+' : ''}${last.bull - last.bear}`, last.bull - last.bear >= 0 ? BULL : BEAR);
  setText('pb', `PR ${pb.toFixed(0)}`, BULL);
  setText('pr', `PR ${pr.toFixed(0)}`, BEAR);
  setText('bull-sub', `${last.date} · 納入 ${last.n} 檔`);
  let state = '常態輪動區間';
  if (pr >= 90) state = '偏空家數歷史高檔';
  else if (pb >= 90) state = '偏多家數歷史高檔';
  else if (pr <= 10 && pb <= 10) state = '多空家數同步低檔';
  setText('state', state);
  setText('hist-note', `百分位以已收錄的 ${rows.length} 個交易日（${rows[0].date} 起）計算，樣本偏短。`);
}

function buildOption() {
  const a = cutIndex(range);
  const view = raw.rows.slice(a);
  const dates = view.map(r => r.date);
  const L = mob() ? 44 : 60, R = mob() ? 12 : 24;
  const axis = (gi, show) => ({
    type: 'category', gridIndex: gi, data: dates, boundaryGap: false, axisTick: { show: false },
    axisLine: { lineStyle: { color: PALETTE.muted } }, axisLabel: { color: PALETTE.muted, fontSize: 11, show }, splitLine: { show: false },
  });
  const yAx = (gi, name, extra = {}) => ({
    type: 'value', gridIndex: gi, name, scale: true, nameTextStyle: { color: PALETTE.muted, fontSize: 10 },
    axisLabel: { color: PALETTE.muted, fontSize: 11 }, splitLine: { lineStyle: { color: PALETTE.grid } }, ...extra,
  });
  return echartsBase({
    animation: false,
    legend: { top: 0, textStyle: { color: PALETTE.muted, fontSize: 11 }, data: ['加權指數', '偏多家數', '偏空家數', '多空差'] },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'cross' }, backgroundColor: PALETTE.bg, borderColor: PALETTE.border,
      textStyle: { color: PALETTE.text, fontSize: 12 },
      formatter(params) {
        const i = params?.[0]?.dataIndex;
        const r = view[i];
        if (!r) return '';
        const c = raw.close.get(r.date);
        return `<b>${r.date}</b><br>加權 ${isNum(c) ? c.toFixed(0) : '—'}<br>偏多 ${r.bull}｜偏空 ${r.bear}｜中性 ${r.neutral}<br>多空差 ${r.bull - r.bear >= 0 ? '+' : ''}${r.bull - r.bear}（納入 ${r.n} 檔）`;
      },
    },
    grid: [{ left: L, right: R, top: 34, height: '34%' }, { left: L, right: R, top: '54%', height: '32%' }],
    xAxis: [axis(0, false), axis(1, true)],
    yAxis: [yAx(0, '加權指數', { min: v => Math.floor(v.min / 1000) * 1000 }), yAx(1, '家數', { scale: false })],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1], filterMode: 'filter' },
      { type: 'slider', xAxisIndex: [0, 1], height: 16, bottom: 6, filterMode: 'filter' },
    ],
    series: [
      { name: '加權指數', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: view.map(r => raw.close.get(r.date) ?? null), showSymbol: false, connectNulls: true,
        lineStyle: { width: 1.4, color: PALETTE.text }, itemStyle: { color: PALETTE.text } },
      { name: '多空差', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: view.map(r => r.bull - r.bear),
        itemStyle: { color: DIFF, opacity: 0.45 } },
      { name: '偏多家數', type: 'line', xAxisIndex: 1, yAxisIndex: 1, data: view.map(r => r.bull), showSymbol: false,
        lineStyle: { width: 1.5, color: BULL }, itemStyle: { color: BULL } },
      { name: '偏空家數', type: 'line', xAxisIndex: 1, yAxisIndex: 1, data: view.map(r => r.bear), showSymbol: false,
        lineStyle: { width: 1.5, color: BEAR }, itemStyle: { color: BEAR } },
    ],
  });
}

export function render() {
  if (!chart || !raw) return;
  updateCards();
  chart.setOption(buildOption(), { notMerge: true });
  const st = $('status');
  if (st) st.textContent = `多空家數（近似版）· ${raw.rows.length} 個交易日 · 最新 ${raw.rows.at(-1).date} · 資料更新 ${raw.updated ?? '—'} · TWSE 上市普通股自算`;
}

export async function activate(context = {}) {
  const host = $('chart');
  if (!host) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : 'dark');
  chipPicker($('range'), 'twbreadthls-range', v => { range = v; render(); });
  try {
    await loadAll(context);
    await new Promise(r => requestAnimationFrame(r));
    if (context.signal?.aborted || context.isCurrent?.() === false) return;
    chart?.resize();
    render();
  } catch (e) {
    const s = $('status');
    if (s) s.textContent = '載入失敗：' + (e.message || e);
    console.error('[twbreadthls] load failed', e);
    throw e;
  }
}
export function onThemeChange(light) {
  if (!chart) return;
  chart.dispose();
  chart = echarts.init($('chart'), light ? null : 'dark');
  if (raw) render();
}
export function resize() { chart?.resize(); }
export function getCharts() { return chart ? [chart] : []; }
