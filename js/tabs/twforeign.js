// 外資買賣超 tab — 台股現貨外資（上市＋上櫃）每日買賣超、近 5/10/20 日累計、強度歷史百分位、警戒事件研究。
// 資料：data/tw_foreign_net.json（fetch_tw_foreign_net.py，FinMind 三大法人買賣金額統計）、data/TWII.json。
// 計算：js/tabs/twforeign_calc.mjs（純函式，測試於 twforeign_calc.test.mjs）。
// 研究工具：警戒 ≠ 買賣訊號；百分位只描述相對位置，不代表未來走勢。

import { isLight, echartsBase, PALETTE, mob } from '../utils/theme.js';
import { chipPicker } from '../utils/dom.js';
import { requestJSON } from '../utils/data.js';
import { buildForeign, summarizeEvents } from './twforeign_calc.mjs';

const POS = '#3fb950';
const NEG = '#f85149';
const LINES = { 5: '#a371f7', 10: '#58a6ff', 20: '#e3b341' };
const $ = id => document.getElementById(`twforeign-${id}`);

let chart = null;
let raw = null;     // { foreign, twii }
let model = null;
let range = '6M';
let thr = 5;
const isNum = v => Number.isFinite(v);
const fmtYi = v => (isNum(v) ? `${v >= 0 ? '+' : ''}${v.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}億` : '—');
const clr = v => (v >= 0 ? POS : NEG);

async function loadAll(context = {}) {
  if (raw) return;
  const [f, t] = await Promise.all([
    requestJSON('data/tw_foreign_net.json', { signal: context.signal }),
    requestJSON('data/TWII.json', { signal: context.signal }),
  ]);
  if (!Array.isArray(f?.data) || !f.data.some(r => isNum(r?.foreign_net_yi))) throw new Error('外資買賣超資料格式不完整');
  if (!Array.isArray(t?.data) || !t.data.some(r => isNum(r?.close))) throw new Error('加權指數資料格式不完整');
  if (context.signal?.aborted || context.isCurrent?.() === false) return;
  raw = { foreign: f.data, twii: t.data, updated: f.updated };
}

function recompute() {
  model = buildForeign(raw.foreign, raw.twii, { thr, cooldown: 20, horizon: 20 });
}

function cutIndex(key) {
  const dates = model.dates;
  if (key === 'MAX') return 0;
  const d = new Date(dates.at(-1) + 'T00:00:00');
  d.setMonth(d.getMonth() - ({ '6M': 6, '1Y': 12, '3Y': 36 }[key] ?? 6));
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
  const last = model.dates.length - 1;
  for (const n of [5, 10, 20]) {
    const v = model.sums[n][last];
    setText(`s${n}`, fmtYi(v), isNum(v) ? clr(v) : undefined);
  }
  const p = model.pct20[last];
  setText('p20', isNum(p) ? `${p.toFixed(1)}%` : '—');
  setText('p20-sub', isNum(p) ? '越低＝近 20 日賣超相對越重（近 5 年窗）' : '歷史樣本不足');
  const hi = Math.max(...model.close.slice(-252));
  const dd = (model.close[last] / hi - 1) * 100;
  setText('dd', `${dd.toFixed(2)}%`, dd < -10 ? NEG : undefined);
  const lastAlert = model.alerts.at(-1);
  const box = $('alert');
  if (!box) return;
  if (lastAlert == null) { box.textContent = `尚無警戒事件（5 日累計百分位 ≤ ${thr}%）。`; return; }
  const ev = model.events.at(-1);
  const ago = last - lastAlert;
  box.textContent = `最近一次警戒：${model.dates[lastAlert]}（${ago} 個交易日前）。警戒後 20 日最大跌幅：` +
    (ev.mature ? `${ev.maxDrop.toFixed(2)}%` : ev.days > 0 ? `尚未成熟（目前 ${ev.maxDrop.toFixed(2)}%，已過 ${ev.days} 日）` : '尚未成熟（警戒日為最新資料日，無後續資料）');
}

function renderTable() {
  const host = $('events');
  if (!host) return;
  const s = summarizeEvents(model.events);
  const rows = model.events.slice().reverse().slice(0, 12).map(e => {
    const f = v => (isNum(v) ? `${v.toFixed(2)}%` : '—');
    return `<tr><td>${model.dates[e.idx]}</td><td>${f(e.maxDrop)}${e.mature ? '' : '（未成熟）'}</td><td>${f(e.ret)}${e.mature ? '' : '（未成熟）'}</td></tr>`;
  }).join('');
  const f = v => (isNum(v) ? `${v.toFixed(2)}%` : '—');
  host.innerHTML =
    `<div class="text-muted-sm" style="margin:6px 0">警戒 = 外資 5 日累計買賣超的歷史百分位 ≤ ${thr}%（近 5 年窗，只用當日以前資料）；` +
    `同一波 20 個交易日內只計第一天。共 ${s.n} 次、已成熟 ${s.nMature} 次；` +
    `成熟事件中位數：20 日最大跌幅 ${f(s.medianMaxDrop)}、20 日報酬 ${f(s.medianRet)}、報酬為正占 ${isNum(s.winRate) ? s.winRate.toFixed(0) + '%' : '—'}。` +
    `樣本少、不同事件常屬同一段行情，僅供參考。</div>` +
    `<div class="table-scroll" tabindex="0" role="region" aria-label="警戒事件表"><table class="info-table"><thead><tr><th>警戒日</th><th>後 20 日最大跌幅</th><th>後 20 日報酬</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function buildOption() {
  const a = cutIndex(range);
  const dates = model.dates.slice(a);
  const sl = arr => arr.slice(a);
  const L = mob() ? 52 : 64, R = mob() ? 52 : 64;
  const alertPts = model.alerts.filter(i => i >= a).map(i => [model.dates[i], model.close[i]]);
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
    legend: { top: 0, textStyle: { color: PALETTE.muted, fontSize: 11 }, data: ['加權指數', '警戒日', '外資當日買賣超', '5日累計', '10日累計', '20日累計'] },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'cross' }, backgroundColor: PALETTE.bg, borderColor: PALETTE.border,
      textStyle: { color: PALETTE.text, fontSize: 12 },
      formatter(params) {
        const i = params?.[0]?.dataIndex;
        if (i == null) return '';
        const k = a + i;
        const alert = model.alerts.includes(k) ? ' 🔔警戒' : '';
        return `<b>${model.dates[k]}</b>${alert}<br>加權 ${model.close[k].toFixed(0)}<br>當日 ${fmtYi(model.net[k])}<br>` +
          `5日 ${fmtYi(model.sums[5][k])}｜10日 ${fmtYi(model.sums[10][k])}｜20日 ${fmtYi(model.sums[20][k])}` +
          (isNum(model.pct5[k]) ? `<br>5日強度百分位 ${model.pct5[k].toFixed(1)}%` : '');
      },
    },
    grid: [{ left: L, right: R, top: 34, height: '36%' }, { left: L, right: R, top: '56%', height: '30%' }],
    xAxis: [axis(0, false), axis(1, true)],
    yAxis: [yAx(0, '加權指數', { min: v => Math.floor(v.min / 1000) * 1000 }), yAx(1, '當日(億)', { scale: false }),
      yAx(1, '累計(億)', { scale: false, position: 'right', splitLine: { show: false } })],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1], filterMode: 'filter' },
      { type: 'slider', xAxisIndex: [0, 1], height: 16, bottom: 6, filterMode: 'filter' },
    ],
    series: [
      { name: '加權指數', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: sl(model.close), showSymbol: false, lineStyle: { width: 1.4, color: PALETTE.text }, itemStyle: { color: PALETTE.text } },
      { name: '警戒日', type: 'scatter', xAxisIndex: 0, yAxisIndex: 0, data: alertPts, symbol: 'triangle', symbolSize: 11, itemStyle: { color: NEG }, z: 5 },
      { name: '外資當日買賣超', type: 'bar', xAxisIndex: 1, yAxisIndex: 1,
        data: sl(model.net).map(v => ({ value: v, itemStyle: { color: clr(v), opacity: 0.75 } })) },
      ...[5, 10, 20].map(n => ({
        name: `${n}日累計`, type: 'line', xAxisIndex: 1, yAxisIndex: 2, data: sl(model.sums[n]), showSymbol: false,
        lineStyle: { width: 1.3, color: LINES[n] }, itemStyle: { color: LINES[n] },
      })),
    ],
  });
}

export function render() {
  if (!chart || !raw) return;
  recompute();
  updateCards();
  renderTable();
  chart.setOption(buildOption(), { notMerge: true });
  const st = $('status');
  if (st) st.textContent = `外資現貨買賣超 · ${model.dates.length} 個交易日 · 最新 ${model.dates.at(-1)} · 資料更新 ${raw.updated ?? '—'} · FinMind／TWSE 三大法人`;
}

function buildControls() {
  chipPicker($('range'), 'twforeign-range', v => { range = v; render(); });
  chipPicker($('thr'), 'twforeign-thr', v => { thr = Number(v); render(); });
}

export async function activate(context = {}) {
  const host = $('chart');
  if (!host) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : 'dark');
  buildControls();
  try {
    await loadAll(context);
    await new Promise(r => requestAnimationFrame(r));
    if (context.signal?.aborted || context.isCurrent?.() === false) return;
    chart?.resize();
    render();
  } catch (e) {
    const s = $('status');
    if (s) s.textContent = '載入失敗：' + (e.message || e);
    console.error('[twforeign] load failed', e);
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
