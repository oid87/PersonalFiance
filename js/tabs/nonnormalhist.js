// 過往觀察 — 極端狀態儀表板的子頁面：用同一套規則回看 2013 起的跌停家數與無觀察類股（回測用，描述性）。
// 版面：區間 chip → 三層圖（加權＋訊號日、跌停家數、近 22 日無觀察天數）→ 歷次訊號（觸發條件 chip、摘要、明細）→ 每年統計。
// 計算：js/tabs/nonnormalhist_calc.mjs；資料：data/tw_daily_stats.json（scripts/fetch_tw_daily_stats.py）＋ data/TWII.json。
import { isLight, echartsBase, PALETTE, mob } from '../utils/theme.js';
import { requestJSON } from '../utils/data.js';
import { bindOnce, chipPicker } from '../utils/dom.js';
import { preserveChartState } from '../utils/chartLifecycle.js';
import { NO_OBS } from './nonnormal_calc.mjs';
import * as H from './nonnormalhist_calc.mjs';

const byId = id => document.getElementById('nonnormalhist-' + id);
const finite = v => typeof v === 'number' && Number.isFinite(v);
const RED = '#ef4444', GREEN = '#3fb950';
// 區間：[起, 迄]（含），null＝不限
const RANGES = { old: ['2013-01-01', '2019-12-31'], new: ['2020-01-01', null], all: [null, null] };

let rows = [], tw = [], loadedAt = 0, chart = null, rangeKey = 'old', trigger = 'obs3';

function node(tag, text, attrs = {}) {
  const el = document.createElement(tag);
  if (text != null) el.textContent = text;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}
const pct = (x, d = 1) => (finite(x) ? `${x > 0 ? '+' : ''}${(x * 100).toFixed(d)}%` : '—');
const dirClass = x => (!finite(x) || x === 0 ? 'nonnormalhist-flat' : x > 0 ? 'nonnormalhist-up' : 'nonnormalhist-down');
const inRange = d => { const [a, b] = RANGES[rangeKey]; return (!a || d >= a) && (!b || d <= b); };

function table(id, headers, body) {
  const t = node('table'), thead = node('thead'), htr = node('tr'), tb = node('tbody');
  for (const h of headers) htr.append(node('th', h));
  thead.append(htr);
  for (const row of body) {
    const tr = node('tr');
    row.forEach((v, i) => { const cell = node(i === 0 ? 'th' : 'td'); if (v instanceof Node) cell.append(v); else cell.textContent = v ?? '—'; tr.append(cell); });
    tb.append(tr);
  }
  t.append(thead, tb);
  byId(id).replaceChildren(t);
}
const signedCell = x => node('span', pct(x), { class: dirClass(x) });

// ── data ────────────────────────────────────────────────────────────────
async function load(context) {
  const [daily, twii] = await Promise.all(['data/tw_daily_stats.json', 'data/TWII.json'].map(f => requestJSON(f, { signal: context.signal })));
  if (context.signal?.aborted || context.isCurrent?.() === false) return false;
  rows = H.dailyRows(daily?.data);
  if (!rows.length) throw new Error('沒有台股每日統計資料');
  const first = rows[0].date;
  tw = (twii?.data || []).filter(r => typeof r?.date === 'string' && finite(r.close) && r.close > 0 && r.date >= '2012-01-01')
    .map(r => ({ date: r.date, close: r.close })).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!tw.length) throw new Error('沒有加權指數資料');
  byId('asof').textContent = `資料 ${first} ～ ${rows.at(-1).date}`;
  return true;
}

// ── chart ───────────────────────────────────────────────────────────────
function drawChart() {
  if (!chart) chart = echarts.init(byId('chart'), isLight() ? null : 'dark');
  const dates = rows.map(r => r.date);
  const twAt = new Map(tw.map(r => [r.date, r.close]));
  const close = dates.map(d => twAt.get(d) ?? null);
  const L = mob() ? 52 : 64, R = mob() ? 10 : 24;
  const axis = (gridIndex, show) => ({ type: 'category', gridIndex, data: dates, boundaryGap: true, axisTick: { show: false },
    axisLine: { lineStyle: { color: PALETTE.muted } }, axisLabel: { show, color: PALETTE.muted, fontSize: 12, formatter: d => d.slice(0, 7) } });
  const yAxis = (gridIndex, name, extra = {}) => ({ type: 'value', gridIndex, name, nameTextStyle: { color: PALETTE.muted, fontSize: 11 },
    axisLabel: { color: PALETTE.muted, fontSize: 12 }, splitLine: { lineStyle: { color: PALETTE.grid } }, ...extra });
  const flagged = rows.map((r, i) => (r.flag === 1 && finite(close[i]) ? [i, close[i]] : null)).filter(Boolean);
  const ref = (vals, color) => ({ silent: true, symbol: 'none', label: { color: PALETTE.muted, fontSize: 11, formatter: '{c}' }, lineStyle: { type: 'dashed', color }, data: vals.map(v => ({ yAxis: v })) });
  chart.setOption(echartsBase({
    animation: false,
    legend: { show: false },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'line' }, backgroundColor: PALETTE.bg, borderColor: PALETTE.border, textStyle: { color: PALETTE.text, fontSize: 13 },
      formatter(params) {
        const i = params?.[0]?.dataIndex, r = rows[i]; if (!r) return '';
        return [`<b>${r.date}</b>｜加權 ${finite(close[i]) ? close[i].toFixed(0) : '—'}`,
          `跌停 ${r.limitDown ?? '—'} 家`, `近 22 日無觀察 ${r.noObs ?? '—'} 天${r.flag === 1 ? '（今天無觀察）' : ''}`,
          `0050 成分股：今天 ${r.obs50 ?? '—'} 檔、近 22 日 ${r.tw50 ?? '—'} 次`].join('<br>');
      },
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: [{ left: L, right: R, top: 18, height: '33%' }, { left: L, right: R, top: '42%', height: '13%' }, { left: L, right: R, top: '61%', height: '11%' }, { left: L, right: R, top: '78%', height: '11%' }],
    xAxis: [axis(0, false), axis(1, false), axis(2, false), axis(3, true)],
    yAxis: [yAxis(0, '加權', { scale: true }), yAxis(1, '跌停家數', { min: 0 }), yAxis(2, '全市場：無觀察天數', { min: 0, minInterval: 1 }),
      yAxis(3, '0050：觀察股次數', { min: 0, minInterval: 1 })],
    dataZoom: [{ type: 'inside', xAxisIndex: [0, 1, 2, 3], filterMode: 'filter' }, { type: 'slider', xAxisIndex: [0, 1, 2, 3], height: 16, bottom: 6, filterMode: 'filter' }],
    series: [
      { id: 'twii', name: '加權指數', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: close, showSymbol: false, connectNulls: true, lineStyle: { width: 1.2, color: PALETTE.text }, itemStyle: { color: PALETTE.text },
        markLine: { silent: true, symbol: 'none', lineStyle: { type: 'dashed', color: RED, opacity: 0.6 }, label: { show: false }, data: [] } },
      { name: '無觀察日', type: 'scatter', xAxisIndex: 0, yAxisIndex: 0, data: flagged, symbolSize: 5, itemStyle: { color: RED }, tooltip: { show: false } },
      { name: '跌停家數', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, barCategoryGap: '0%', large: true,
        data: rows.map(r => ({ value: r.limitDown, itemStyle: { color: finite(r.limitDown) && r.limitDown >= NO_OBS.limitDownExtreme ? RED : PALETTE.muted } })),
        markLine: ref([NO_OBS.limitDownExtreme], RED) },
      { name: '近 22 日無觀察天數', type: 'line', step: 'end', xAxisIndex: 2, yAxisIndex: 2, data: rows.map(r => r.noObs), showSymbol: false,
        lineStyle: { width: 1.2, color: '#f0883e' }, itemStyle: { color: '#f0883e' }, areaStyle: { opacity: 0.15 }, markLine: ref([NO_OBS.start, 5], RED) },
      { name: '0050 近 22 日觀察股次數', type: 'line', step: 'end', xAxisIndex: 3, yAxisIndex: 3, data: rows.map(r => r.tw50), showSymbol: false,
        lineStyle: { width: 1.2, color: '#58a6ff' }, itemStyle: { color: '#58a6ff' }, areaStyle: { opacity: 0.12 }, markLine: ref([H.TW50_LOW], RED) },
    ],
  }), { notMerge: true });
  applyRange();
}
function applyRange() {
  if (!chart || !rows.length) return;
  const dates = rows.map(r => r.date), [a, b] = RANGES[rangeKey];
  const start = a ? dates.find(d => d >= a) : dates[0], end = b ? dates.findLast(d => d <= b) : dates.at(-1);
  chart.dispatchAction({ type: 'dataZoom', startValue: start ?? dates[0], endValue: end ?? dates.at(-1) });
}
function markEpisodes(list) {
  if (!chart) return;
  chart.setOption({ series: [{ id: 'twii', markLine: { data: list.map(e => ({ xAxis: e.date })) } }] });
}

// ── tables ──────────────────────────────────────────────────────────────
function renderEpisodes() {
  const all = H.episodes(rows, tw, trigger), list = all.filter(e => inRange(e.date));
  markEpisodes(all);
  const s = H.summarize(list);
  const sum = byId('summary');
  sum.replaceChildren();
  if (!list.length) { sum.append(node('p', `這段期間沒有出現「${H.TRIGGERS[trigger].label}」。`, { class: 'nonnormalhist-note' })); byId('table').replaceChildren(); return; }
  const box = node('div', null, { class: 'nonnormalhist-stats' });
  box.append(node('div', null, { class: 'nonnormalhist-stat' }));
  box.lastChild.append(node('b', `${list.length} 次`), node('span', '訊號次數'));
  for (const h of H.HORIZONS) {
    const x = s[h], el = node('div', null, { class: 'nonnormalhist-stat' });
    el.append(node('b', pct(x.median), { class: dirClass(x.median) }), node('span', `+${h} 日中位數・上漲 ${x.n ? `${Math.round(x.up * x.n)}/${x.n}` : '—'}`));
    box.append(el);
  }
  sum.append(box);
  table('table', ['訊號日', '加權', '距一年高點', '之後 60 日最低', ...H.HORIZONS.map(h => `+${h} 日`), '最多無觀察', '跌停最多'],
    [...list].reverse().map(e => [e.date, finite(e.close) ? e.close.toFixed(0) : '—', signedCell(e.fromHigh), signedCell(e.low60),
      ...H.HORIZONS.map(h => signedCell(e.ret[h])), finite(e.peakNoObs) ? `${e.peakNoObs} 天` : '—', finite(e.maxLimitDown) ? `${e.maxLimitDown} 家` : '—']));
}
function renderYearly() {
  table('yearly', ['年', '交易日', '全市場無觀察天數', `0050 近 22 日 ≤ ${H.TW50_LOW} 次的天數`, `跌停 ≥ ${NO_OBS.limitDownExtreme} 家天數`, '單日跌停最多'],
    H.yearly(rows).filter(y => inRange(`${y.year}-06-30`) || rangeKey === 'all').reverse()
      .map(y => [y.year, y.days, y.noObs, y.tw50Days, y.ldDays, finite(y.maxLimitDown) ? `${y.maxLimitDown} 家` : '—']));
}
function renderAll() { drawChart(); renderEpisodes(); renderYearly(); }

function wire() {
  if (!bindOnce(byId('range'))) return;
  chipPicker(byId('range'), 'nonnormalhist-range', key => { rangeKey = key; applyRange(); renderEpisodes(); renderYearly(); });
  chipPicker(byId('trigger'), 'nonnormalhist-trigger', key => { trigger = key; renderEpisodes(); });
}

export async function activate(context = {}) {
  if (rows.length && Date.now() - loadedAt < 300_000) { resize(); return; }
  try {
    const fresh = await load(context);
    if (fresh === false) return;
  } catch (e) {
    if (!context.signal?.aborted) byId('status').textContent = '載入失敗：' + (e.message || e);
    throw e;
  }
  loadedAt = Date.now();
  byId('status').textContent = '';
  wire(); renderAll();
}
export function getCharts() { return chart ? [chart] : []; }
export function resize() { chart?.resize(); }
export function onThemeChange() {
  if (!rows.length) return;
  return preserveChartState(getCharts, () => { chart?.dispose(); chart = null; drawChart(); markEpisodes(H.episodes(rows, tw, trigger)); });
}
