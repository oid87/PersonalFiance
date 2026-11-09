// 台股底部區域 — 加權＋無觀察類股＋0050 成分股均線廣度（20／50／200 日線）＋台指 VIX，用區域顯示同時成立幾個。描述性，不是買賣訊號。
// 計算：js/tabs/twzone_calc.mjs（門檻同 noobs_calc.mjs）；資料：TWII.json、tw_daily_stats.json、tw50_ma_breadth.json、twvix.json（期交所，2026-08 起累積）。
import { isLight, echartsBase, PALETTE, mob } from '../utils/theme.js';
import { requestJSON } from '../utils/data.js';
import { chipPicker } from '../utils/dom.js';
import * as H from './nonnormalhist_calc.mjs';
import * as N from './noobs_calc.mjs';
import * as Z from './twzone_calc.mjs';

const $ = id => document.getElementById('twzone-' + id);
const finite = v => typeof v === 'number' && Number.isFinite(v);
const RED = '#ef4444';
const SIG_COLOR = { obs: '#ef4444', b20: '#f59e0b', b50: '#8b5cf6', b200: '#0ea5e9' };
const ZONE_ALPHA = [0, 0.12, 0.22, 0.32, 0.45];
const RANGE = { '1Y': 1, '3Y': 3, '10Y': 10 };
let days = [], srcLast = {}, rv = new Map(), vix = new Map(), vixRows = [], range = '10Y', chart = null, loaded = false;

function el(tag, text, cls) { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
const priceRows = d => (d?.data || []).filter(r => typeof r?.date === 'string' && finite(r.close) && r.close > 0)
  .map(r => ({ date: r.date, close: r.close })).sort((a, b) => (a.date < b.date ? -1 : 1));

async function load(context) {
  if (loaded) return;
  const [tw, daily, br, tv] = await Promise.all(['data/TWII.json', 'data/tw_daily_stats.json', 'data/tw50_ma_breadth.json', 'data/twvix.json']
    .map(f => requestJSON(f, { signal: context.signal }).catch(e => { if (context.signal?.aborted) throw e; return null; })));
  const px = priceRows(tw);
  if (!px.length || !daily?.data?.length || !br?.data?.length) throw new Error('加權、每日統計或廣度資料不足');
  const src = { obs: H.dailyRows(daily.data), br: br.data.filter(r => typeof r?.date === 'string').sort((a, b) => (a.date < b.date ? -1 : 1)) };
  const start = N.startDate(px.at(-1).date, 10);
  const all = Z.align(px.filter(p => p.date >= '2013-01-01'), src);
  days = all.filter(d => d.date >= start);
  // 卡片用各資料自己的最新一天（加權收盤可能比廣度晚一天更新）
  srcLast = Object.fromEntries(Z.KEYS.map(k => [k, [...N.indicator(k, src)].reverse().find(r => finite(r.v))]));
  rv = new Map(Z.realizedVol(px).map(r => [r.date, r.rv]));
  vixRows = (tv?.data || []).filter(r => typeof r?.date === 'string' && finite(r.close)).sort((a, b) => (a.date < b.date ? -1 : 1));
  vix = new Map(vixRows.map(r => [r.date, r.close]));
  $('asof').textContent = `加權 ${px.at(-1).date}・廣度 ${src.br.at(-1).date}・台指 VIX ${vixRows.at(-1)?.date ?? '—'}`;
  loaded = true;
}

function card(label, value, sub, on, color) {
  const c = el('div', null, 'twzone-card' + (on ? ' on' : ''));
  if (on) c.style.borderColor = color;
  c.append(el('span', label, 'twzone-k'));
  const v = el('span', value, 'twzone-v'); if (on) v.style.color = color;
  c.append(v, el('span', sub, 'twzone-sub'));
  return c;
}

function renderCards() {
  const box = $('cards'); box.replaceChildren();
  // 各訊號最近一個有值的日子
  let n = 0;
  for (const k of Z.KEYS) {
    const d = srcLast[k], s = N.SIGNALS[k];
    if (d?.hit) n += 1;
    const val = d ? (s.unit === '%' ? `${d.v.toFixed(0)}%` : `${d.v} ${s.unit}`) : '—';
    box.append(card(Z.LABELS[k], val, `門檻 ${s.dir} ${s.th}${s.unit === '%' ? '%' : ` ${s.unit}`}・${d?.date ?? '—'}`, d?.hit, SIG_COLOR[k]));
  }
  const lv = vixRows.at(-1), pv = vixRows.at(-2);
  const dv = lv && pv ? lv.close - pv.close : null;
  box.append(card('台指 VIX', lv ? lv.close.toFixed(2) : '—', lv ? `${dv != null ? (dv >= 0 ? '+' : '') + dv.toFixed(2) + '・' : ''}${lv.date}` : '尚無資料', lv && lv.close >= 30, RED));
  const last = days.at(-1);
  box.append(card('同時成立', `${n} / 4`, last ? `加權 ${Math.round(last.close).toLocaleString()}（${last.date}）` : '—', n >= 2, RED));
}

function renderChart() {
  if (typeof echarts === 'undefined' || !days.length) return;
  chart ??= echarts.init($('chart'), isLight() ? null : 'dark');
  const start = N.startDate(days.at(-1).date, RANGE[range]);
  const ds = days.filter(d => d.date >= start), dates = ds.map(d => d.date);
  const zs = Z.zones(ds).map(z => [{ xAxis: z.from, itemStyle: { color: `rgba(239,68,68,${ZONE_ALPHA[z.max]})` } }, { xAxis: z.to }]);
  const strip = [];
  Z.KEYS.forEach((k, row) => ds.forEach((d, i) => { if (d.hits[k]) strip.push({ value: [i, row], itemStyle: { color: SIG_COLOR[k] } }); }));
  const m = mob(), L = m ? 44 : 56;
  const grids = [
    { top: 28, left: L, right: 14, height: '36%' },
    { top: '44%', left: L, right: 14, height: '10%' },
    { top: '58%', left: L, right: 14, height: '17%' },
    { top: '79%', left: L, right: 14, bottom: m ? 44 : 36 },
  ];
  const xa = i => ({ type: 'category', data: dates, gridIndex: i, boundaryGap: false, axisLabel: { show: i === 3 }, axisTick: { show: i === 3 } });
  const grid = { lineStyle: { color: PALETTE.grid } };
  chart.setOption({
    ...echartsBase(), animation: false,
    legend: { top: 0, data: ['20 日線', '50 日線', '200 日線', '台指 VIX', '加權 20 日波動'], textStyle: { fontSize: m ? 10 : 12 }, itemWidth: 14 },
    tooltip: { trigger: 'axis', axisPointer: { type: 'line' }, formatter: ps => {
      const d = ds[ps[0].dataIndex];
      const on = Z.KEYS.filter(k => d.hits[k]).map(k => Z.LABELS[k]);
      const f = x => (x == null ? '—' : x.toFixed(0) + '%');
      return `${d.date}<br>加權 ${Math.round(d.close).toLocaleString()}<br>無觀察 ${d.v.obs ?? '—'} 天・廣度 20/50/200：${f(d.v.b20)} / ${f(d.v.b50)} / ${f(d.v.b200)}`
        + `<br>台指 VIX ${vix.get(d.date)?.toFixed(2) ?? '—'}・20 日波動 ${rv.get(d.date)?.toFixed(1) ?? '—'}%<br>成立：${on.join('、') || '無'}`;
    } },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: grids,
    xAxis: [0, 1, 2, 3].map(xa),
    yAxis: [
      { type: range === '10Y' ? 'log' : 'value', gridIndex: 0, scale: true, min: v => Math.floor(v.min * 0.97), max: v => Math.ceil(v.max * 1.03), splitNumber: 3, splitLine: grid, axisLabel: { showMinLabel: false, showMaxLabel: false, formatter: v => (m && v >= 10000 ? (v / 10000).toFixed(1) + '萬' : Math.round(v).toLocaleString()) } },
      { type: 'category', gridIndex: 1, data: Z.KEYS.map(k => ({ obs: '無觀察', b20: '20MA', b50: '50MA', b200: '200MA' })[k]), inverse: true, axisLabel: { fontSize: 10 }, axisTick: { show: false }, splitLine: { show: false } },
      { type: 'value', gridIndex: 2, min: 0, max: 100, interval: 50, splitLine: grid, axisLabel: { formatter: '{value}%' } },
      { type: 'value', gridIndex: 3, min: 0, splitLine: grid, splitNumber: 2 },
    ],
    dataZoom: [{ type: 'inside', xAxisIndex: [0, 1, 2, 3] }],
    series: [
      { name: '加權', type: 'line', data: ds.map(d => d.close), showSymbol: false, lineStyle: { width: 1.3 }, color: PALETTE.text ?? '#888',
        markArea: { silent: true, data: zs } },
      { name: '成立', type: 'scatter', xAxisIndex: 1, yAxisIndex: 1, symbol: 'rect', symbolSize: [Math.max(1, 900 / ds.length), 9], data: strip, silent: true },
      ...[['b20', '20 日線'], ['b50', '50 日線'], ['b200', '200 日線']].map(([k, name]) => ({ name, type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: ds.map(d => d.v[k]), showSymbol: false, lineStyle: { width: 1 }, color: SIG_COLOR[k],
        markLine: { silent: true, symbol: 'none', label: { show: false }, lineStyle: { type: 'dashed', color: SIG_COLOR[k], opacity: 0.7 }, data: [{ yAxis: N.SIGNALS[k].th }] } })),
      { name: '加權 20 日波動', type: 'line', xAxisIndex: 3, yAxisIndex: 3, data: dates.map(d => rv.get(d) ?? null), showSymbol: false, lineStyle: { width: 1 }, color: '#94a3b8' },
      { name: '台指 VIX', type: 'line', xAxisIndex: 3, yAxisIndex: 3, data: dates.map(d => vix.get(d) ?? null), showSymbol: false, lineStyle: { width: 1.6 }, color: RED },
    ],
  }, true);
}

export function render() { if (!loaded) return; renderCards(); renderChart(); }
export async function activate(context = {}) {
  const st = $('status');
  try {
    await load(context);
    if (context.signal?.aborted) return;
    st.textContent = '';
    chipPicker($('range'), 'twzone-range', v => { range = v; renderChart(); });
    render();
  } catch (e) {
    if (context.signal?.aborted) return;
    st.textContent = `載入失敗：${e.message}`;
    throw e;
  }
}
export function onThemeChange() { chart?.dispose(); chart = null; renderChart(); }
export function resize() { chart?.resize(); }
export function getCharts() { return chart ? [chart] : []; }
