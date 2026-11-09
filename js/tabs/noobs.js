// 無觀察類股回測 — 指數＋無觀察類股，近 10 年：訊號後持有 20／60／120 日 vs 任意一天買進。描述性，不是買賣訊號。
// 計算：js/tabs/noobs_calc.mjs（訊號規則沿用 nonnormalhist_calc.mjs）；資料：tw_daily_stats.json、us_obs_stats.json、TWII／0050.TW／QQQ／VOO／SOXX.json。
import { isLight, echartsBase, PALETTE, mob } from '../utils/theme.js';
import { requestJSON } from '../utils/data.js';
import { chipPicker } from '../utils/dom.js';
import * as H from './nonnormalhist_calc.mjs';
import * as N from './noobs_calc.mjs';

const $ = id => document.getElementById('noobs-' + id);
const finite = v => typeof v === 'number' && Number.isFinite(v);
const RED = '#ef4444', GREEN = '#3fb950';
const VERDICT = { better: ['較好', RED], worse: ['較差', GREEN], same: ['差不多', '#8b949e'], na: ['樣本不足', '#8b949e'] };
let twRows = [], usRows = [], px = {}, from = '', res = {}, market = 'tw', chart = null, loaded = false;

function el(tag, text, cls) { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
const pct = (x, d = 1) => (finite(x) ? `${x > 0 ? '+' : ''}${(x * 100).toFixed(d)}%` : '—');
const signed = x => el('span', pct(x), !finite(x) || x === 0 ? '' : x > 0 ? 'noobs-up' : 'noobs-down');
const pp = x => (finite(x) ? `${x > 0 ? '+' : ''}${(x * 100).toFixed(1)}` : '—');
function badge(v) {
  const [t, c] = VERDICT[v.level];
  const b = el('span', v.few && v.level !== 'na' ? `${t}（樣本少）` : t, 'noobs-badge');
  b.style.background = c;
  return b;
}
function table(head, rows) {
  const t = el('table', null, 'noobs-table'), h = el('tr');
  head.forEach(x => h.append(el('th', x)));
  t.append(el('thead')); t.tHead.append(h);
  const b = el('tbody');
  for (const r of rows) { const tr = el('tr'); r.forEach((x, i) => { const td = el(i ? 'td' : 'th'); x instanceof Node ? td.append(x) : (td.textContent = x ?? '—'); tr.append(td); }); b.append(tr); }
  t.append(b);
  return t;
}
const priceRows = d => (d?.data || []).filter(r => typeof r?.date === 'string' && finite(r.close) && r.close > 0)
  .map(r => ({ date: r.date, close: r.close })).sort((a, b) => (a.date < b.date ? -1 : 1));

async function load(context) {
  if (loaded) return;
  const names = [...new Set(Object.values(N.MARKETS).map(m => m.price))];
  const [daily, us, ...ps] = await Promise.all(['data/tw_daily_stats.json', 'data/us_obs_stats.json', ...names.map(n => `data/${n}.json`)]
    .map(f => requestJSON(f, { signal: context.signal })));
  twRows = H.dailyRows(daily?.data);
  usRows = H.usRows(us?.data);
  if (!twRows.length) throw new Error('沒有台股每日統計資料');
  names.forEach((n, i) => { px[n] = priceRows(ps[i]); });
  from = N.startDate(twRows.at(-1).date);
  for (const k of Object.keys(N.MARKETS)) {
    const p = px[N.MARKETS[k].price];
    res[k] = p?.length ? N.analyze(k, twRows, usRows, p, from) : null;
  }
  $('asof').textContent = `${from} ～ 台股 ${twRows.at(-1).date}・美股 ${usRows.at(-1)?.date ?? '—'}`;
  loaded = true;
}

function renderOverview() {
  const rows = Object.entries(N.MARKETS).map(([k, m]) => {
    const r = res[k];
    if (!r) return [m.label, '—', '—', '—', '—', '—', '—'];
    return [m.label, `${r.all.length}`, `${pp(r.sAll[60].median)} / ${pp(r.base[60].median)}`, `${pp(r.sAll[120].median)} / ${pp(r.base[120].median)}`, badge(r.vAll),
      `${r.deep.length}`, badge(r.vDeep)];
  });
  $('overview').replaceChildren(table(['市場', '訊號次數', '60 日中位數 %（訊號／基準）', '120 日中位數 %（訊號／基準）', '判定', '跌深版次數', '跌深版判定'], rows));
  const good = Object.keys(N.MARKETS).filter(k => res[k]?.vAll.level === 'better').map(k => N.MARKETS[k].label);
  const goodDeep = Object.keys(N.MARKETS).filter(k => res[k]?.vDeep.level === 'better').map(k => N.MARKETS[k].label);
  const tw = res.tw;
  $('conclusion').textContent = `近 10 年：${good.length ? good.join('、') + ' 的訊號後報酬比任意一天買進好' : '沒有市場的訊號明顯勝過基準'}`
    + `${tw ? `；加權（全市場版）${VERDICT[tw.vAll.level][0]}，加上「距一年高點 ≥ 10%」之後${VERDICT[tw.vDeep.level][0]}` : ''}`
    + `。跌深版較好的市場：${goodDeep.join('、') || '無'}。成分股版本（0050、美股）比全市場版本更少出現、也更集中在大跌之後。`;
}

function renderToday() {
  const m = N.MARKETS[market], r = res[market], box = $('today');
  box.replaceChildren();
  if (!r) { box.append(el('p', '這個市場沒有資料。', 'noobs-note')); return; }
  const ind = N.indicator(market, twRows, usRows), last = [...ind].reverse().find(x => finite(x.v));
  const lastEp = r.all.at(-1), p = px[m.price], c = p.at(-1);
  const high = Math.max(...p.slice(-250).map(x => x.close));
  const items = [
    ['現在', last ? (last.hit ? '條件成立中' : '條件未成立') : '—', last?.hit ? RED : null],
    [m.ind, last ? `${Number.isInteger(last.v) ? last.v : last.v.toFixed(1)}（門檻 ${m.dir} ${m.th}，${last.date}）` : '—'],
    ['距一年高點', `${pct(c.close / high - 1)}（${c.date}）`],
    ['最近一次訊號', lastEp ? `${lastEp.date}（當時距高點 ${pct(lastEp.fromHigh)}）` : '—'],
  ];
  for (const [k, v, color] of items) {
    const row = el('div', null, 'noobs-kv');
    row.append(el('span', k, 'noobs-k'));
    const val = el('span', v, 'noobs-v'); if (color) { val.style.color = color; val.style.fontWeight = '600'; }
    row.append(val); box.append(row);
  }
}

function renderChart() {
  if (typeof echarts === 'undefined') return;
  const m = N.MARKETS[market], r = res[market];
  chart ??= echarts.init($('chart'), isLight() ? null : 'dark');
  if (!r) { chart.clear(); return; }
  const p = px[m.price].filter(x => x.date >= from), dates = p.map(x => x.date);
  const ind = new Map(N.indicator(market, twRows, usRows).map(x => [x.date, x]));
  const areas = r.all.map(e => [{ xAxis: e.twDate ?? e.date }, { xAxis: e.end && e.end <= dates.at(-1) ? e.end : dates.at(-1) }]);
  const mark = new Set(r.all.map(e => e.twDate));
  chart.setOption({
    ...echartsBase(), animation: false,
    tooltip: { trigger: 'axis', formatter: ps => { const d = dates[ps[0].dataIndex], v = ind.get(d); return `${d}<br>${m.label} ${p[ps[0].dataIndex].close.toLocaleString()}<br>${m.ind} ${finite(v?.v) ? (Number.isInteger(v.v) ? v.v : v.v.toFixed(1)) : '—'}${mark.has(d) ? '<br><b>訊號第一天</b>' : ''}`; } },
    grid: [{ top: 24, left: 56, right: 16, height: '52%' }, { top: '68%', left: 56, right: 16, bottom: mob() ? 48 : 40 }],
    xAxis: [{ type: 'category', data: dates, gridIndex: 0, axisLabel: { show: false } }, { type: 'category', data: dates, gridIndex: 1 }],
    yAxis: [{ type: 'log', gridIndex: 0, min: v => v.min * 0.95, max: v => v.max * 1.05, splitLine: { lineStyle: { color: PALETTE.grid } }, axisLabel: { formatter: v => Math.round(v).toLocaleString() } },
      { type: 'value', gridIndex: 1, min: 0, name: m.ind.replace(/（.*）/, ''), nameTextStyle: { align: 'left' }, splitLine: { lineStyle: { color: PALETTE.grid } } }],
    dataZoom: [{ type: 'inside', xAxisIndex: [0, 1] }],
    series: [
      { name: m.label, type: 'line', data: p.map(x => x.close), showSymbol: false, lineStyle: { width: 1.3 }, color: PALETTE.text ?? '#888',
        markArea: { silent: true, itemStyle: { color: 'rgba(239,68,68,0.15)' }, data: areas } },
      { name: '訊號第一天', type: 'scatter', data: p.map(x => (mark.has(x.date) ? x.close : null)), symbolSize: 8, color: RED },
      { name: m.ind, type: 'line', xAxisIndex: 1, yAxisIndex: 1, data: dates.map(d => ind.get(d)?.v ?? null), showSymbol: false, step: 'end', lineStyle: { width: 1 }, color: '#58a6ff',
        areaStyle: { opacity: 0.15 }, markLine: { silent: true, symbol: 'none', lineStyle: { type: 'dashed', color: RED }, label: { formatter: `門檻 ${m.th}`, position: 'insideEndTop' }, data: [{ yAxis: m.th }] } },
    ],
  }, true);
  $('chart-note').textContent = `上：${m.label}（對數刻度），紅色區塊＝訊號期間（條件成立到消失滿 20 個交易日），紅點＝訊號第一天。下：${m.ind}，虛線＝門檻（${m.dir} ${m.th} 算成立）。`;
}

function renderCompare() {
  const r = res[market];
  if (!r) { $('compare').replaceChildren(); return; }
  const rows = [];
  const add = (name, s) => N.HORIZONS.forEach(h => rows.push([h === 20 ? name : '', `+${h} 日`, `${s[h].n}`, signed(s[h].median), signed(s[h].mean), finite(s[h].up) ? `${Math.round(s[h].up * 100)}%` : '—', signed(s[h].worst)]));
  add('全部訊號', r.sAll); add('跌深版', r.sDeep); add('任意一天', r.base);
  $('compare').replaceChildren(table(['', '持有', '樣本', '中位數', '平均', '上漲比例', '最差'], rows));
}

function renderEpisodes() {
  const r = res[market];
  if (!r) { $('episodes').replaceChildren(); return; }
  const rows = [...r.all].reverse().map(e => [e.date, signed(e.fromHigh), signed(e.low60), ...N.HORIZONS.map(h => signed(e.ret[h])), e.fromHigh <= N.DEEP ? '跌深' : '']);
  $('episodes').replaceChildren(table(['訊號第一天', '當時距一年高點', '之後 60 日最低', '+20 日', '+60 日', '+120 日', ''], rows));
}

function renderMarket() { renderToday(); renderChart(); renderCompare(); renderEpisodes(); }
export function render() { if (!loaded) return; renderOverview(); renderMarket(); }
export async function activate(context = {}) {
  const st = $('status');
  try {
    await load(context);
    if (context.signal?.aborted) return;
    st.textContent = '';
    chipPicker($('market'), 'noobs-market', v => { market = v; renderMarket(); });
    render();
  } catch (e) {
    if (context.signal?.aborted) return;
    st.textContent = `載入失敗：${e.message}`;
  }
}
export function onThemeChange() { chart?.dispose(); chart = null; renderChart(); }
export function resize() { chart?.resize(); }
export function getCharts() { return chart ? [chart] : []; }
