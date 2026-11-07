// 外資賣超與空單 tab — 加權指數、外資現貨賣出金額／淨買賣超、外資台指期淨部位，上下三格共用 x 軸。
// 資料：data/TWII.json、data/tw_foreign_net.json、data/taiwan_fut_inst.json（2018-06 起）。
// 百分位只描述相對位置（近 1 年約 252 個交易日），不代表未來走勢。

import { isLight, echartsBase, PALETTE, mob } from '../utils/theme.js';
import { chipPicker } from '../utils/dom.js';
import { requestJSON } from '../utils/data.js';
import { percentileRank } from '../utils/math.js';

const POS = '#3fb950';
const NEG = '#f85149';
const WIN = 252;
const $ = id => document.getElementById(`twforeignshort-${id}`);
const isNum = v => Number.isFinite(v);

let chart = null;
let raw = null;
let model = null;
let mode = 'sell';

async function loadAll(context = {}) {
  if (raw) return;
  const [f, t, o] = await Promise.all([
    requestJSON('data/tw_foreign_net.json', { signal: context.signal }),
    requestJSON('data/TWII.json', { signal: context.signal }),
    requestJSON('data/taiwan_fut_inst.json', { signal: context.signal }),
  ]);
  if (!Array.isArray(f?.data) || !f.data.some(r => isNum(r?.foreign_sell_yi))) throw new Error('外資買賣超資料格式不完整');
  if (!Array.isArray(t?.data) || !t.data.some(r => isNum(r?.close))) throw new Error('加權指數資料格式不完整');
  if (!Array.isArray(o?.data) || !o.data.some(r => isNum(r?.foreign_net))) throw new Error('外資台指期資料格式不完整');
  if (context.signal?.aborted || context.isCurrent?.() === false) return;
  raw = { f: f.data, t: t.data, o: o.data };
}

function build() {
  const fm = new Map(raw.f.map(r => [r.date, r]));
  const tm = new Map(raw.t.map(r => [r.date, r]));
  const rows = raw.o.filter(r => isNum(r.foreign_net)).sort((a, b) => (a.date < b.date ? -1 : 1));
  const dates = rows.map(r => r.date);
  const num = v => (isNum(v) ? v : null);
  model = {
    dates,
    close: dates.map(d => num(tm.get(d)?.close)),
    sell: dates.map(d => num(fm.get(d)?.foreign_sell_yi)),
    net: dates.map(d => num(fm.get(d)?.foreign_net_yi)),
    fut: rows.map(r => r.foreign_net),
  };
}

// 取該序列最後一筆有值的位置，與其近 1 年百分位（0–100）
function lastPct(arr) {
  let i = arr.length - 1;
  while (i >= 0 && arr[i] == null) i--;
  if (i < 0) return { i: -1, v: null, p: null };
  const win = arr.slice(Math.max(0, i - WIN + 1), i + 1).filter(isNum).sort((a, b) => a - b);
  const p = win.length >= 30 ? percentileRank(arr[i], win) * 100 : null;
  return { i, v: arr[i], p };
}

function setText(id, txt, color) {
  const el = $(id);
  if (!el) return;
  el.textContent = txt;
  el.style.color = color || '';
}

const fmtP = p => (isNum(p) ? `近 1 年第 ${p.toFixed(0)} 百分位` : '樣本不足');

function updateCards() {
  const n = model.dates.length - 1;
  setText('date', model.dates[n] ?? '—');
  const s = lastPct(model.sell);
  setText('sell', isNum(s.v) ? `${s.v.toLocaleString('en-US', { maximumFractionDigits: 0 })} 億` : '—');
  setText('sell-sub', s.i >= 0 ? `${model.dates[s.i]} · ${fmtP(s.p)}（越高＝賣得越多）` : '—');
  const o = lastPct(model.fut);
  setText('fut', isNum(o.v) ? `${o.v >= 0 ? '+' : ''}${o.v.toLocaleString('en-US')} 口` : '—', isNum(o.v) ? (o.v < 0 ? NEG : POS) : '');
  setText('fut-sub', o.i >= 0 ? `${o.v < 0 ? '淨空單' : '淨多單'} · ${fmtP(o.p)}（越低＝越偏空）` : '—');
  const c = lastPct(model.close);
  setText('close', isNum(c.v) ? c.v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—');
  setText('close-sub', c.i >= 0 ? `${model.dates[c.i]} · 加權指數收盤` : '—');
}

function buildOption() {
  const { dates } = model;
  const L = mob() ? 52 : 64, R = mob() ? 16 : 40;
  const axis = (gi, show) => ({
    type: 'category', gridIndex: gi, data: dates, boundaryGap: true, axisTick: { show: false },
    axisLine: { lineStyle: { color: PALETTE.muted } }, axisLabel: { color: PALETTE.muted, fontSize: 11, show },
    splitLine: { show: false }, axisPointer: { show: true },
  });
  const yAx = (gi, name, extra = {}) => ({
    type: 'value', gridIndex: gi, name, scale: true, nameGap: 8, nameTextStyle: { color: PALETTE.muted, fontSize: 10, align: 'left' },
    axisLabel: { color: PALETTE.muted, fontSize: 11 }, splitLine: { lineStyle: { color: PALETTE.grid } }, ...extra,
  });
  const isSell = mode === 'sell';
  const mid = isSell
    ? { name: '外資賣出金額', data: model.sell.map(v => ({ value: v, itemStyle: { color: NEG, opacity: 0.75 } })) }
    : { name: '外資淨買賣超', data: model.net.map(v => ({ value: v, itemStyle: { color: isNum(v) && v < 0 ? NEG : POS, opacity: 0.75 } })) };
  return echartsBase({
    animation: false,
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'cross' }, backgroundColor: PALETTE.bg, borderColor: PALETTE.border,
      textStyle: { color: PALETTE.text, fontSize: 12 },
      formatter(params) {
        const i = params?.[0]?.dataIndex;
        if (i == null) return '';
        const f = (v, u, d = 0) => (isNum(v) ? `${v.toLocaleString('en-US', { maximumFractionDigits: d })}${u}` : '—');
        return `<b>${dates[i]}</b><br>加權收盤 ${f(model.close[i], '')}<br>外資賣出 ${f(model.sell[i], ' 億')}<br>` +
          `外資淨買賣超 ${f(model.net[i], ' 億', 1)}<br>台指期淨部位 ${f(model.fut[i], ' 口')}`;
      },
    },
    grid: [
      { left: L, right: R, top: 22, height: '20%' },
      { left: L, right: R, top: '36%', height: '20%' },
      { left: L, right: R, top: '64%', height: '20%' },
    ],
    xAxis: [axis(0, false), axis(1, false), axis(2, true)],
    yAxis: [
      yAx(0, '① 加權指數收盤', { min: v => Math.floor(v.min / 1000) * 1000 }),
      yAx(1, isSell ? '② 外資賣出金額（億）' : '② 外資淨買賣超（億）', { scale: false }),
      yAx(2, '③ 外資台指期淨部位（負＝淨空單，口）', { scale: false }),
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1, 2], filterMode: 'none', startValue: dates[Math.max(0, dates.length - 500)], endValue: dates[dates.length - 1] },
      { type: 'slider', xAxisIndex: [0, 1, 2], height: 16, bottom: 6, filterMode: 'none' },
    ],
    series: [
      { name: '加權指數', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: model.close, showSymbol: false, connectNulls: true,
        lineStyle: { width: 1.4, color: PALETTE.text }, itemStyle: { color: PALETTE.text } },
      { name: mid.name, type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: mid.data },
      { name: '外資台指期淨部位', type: 'bar', xAxisIndex: 2, yAxisIndex: 2,
        data: model.fut.map(v => ({ value: v, itemStyle: { color: v < 0 ? NEG : POS, opacity: 0.75 } })) },
    ],
  });
}

export function render() {
  if (!chart || !raw) return;
  build();
  updateCards();
  chart.setOption(buildOption(), { notMerge: true });
  const st = $('status');
  if (st) st.textContent = `${model.dates.length} 個交易日 · 最新 ${model.dates.at(-1)} · FinMind／TWSE／TAIFEX（期貨資料 2018-06 起）`;
}

export async function activate(context = {}) {
  const host = $('chart');
  if (!host) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : 'dark');
  chipPicker($('mode'), 'twforeignshort-mode', v => { mode = v; render(); });
  try {
    await loadAll(context);
    await new Promise(r => requestAnimationFrame(r));
    if (context.signal?.aborted || context.isCurrent?.() === false) return;
    chart?.resize();
    render();
  } catch (e) {
    const s = $('status');
    if (s) s.textContent = '載入失敗：' + (e.message || e);
    console.error('[twforeignshort] load failed', e);
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
