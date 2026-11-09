// 無觀察類股回測 — 加權／0050＋無觀察類股或 0050 成分股均線廣度，近 10 年：訊號後持有 20／60／120 日 vs 任意一天買進。描述性，不是買賣訊號。
// 計算：js/tabs/noobs_calc.mjs；資料：tw_daily_stats.json、tw50_ma_breadth.json（scripts/fetch_tw50_ma_breadth.py）、TWII／0050.TW.json。
import { isLight, echartsBase, PALETTE, mob } from '../utils/theme.js';
import { requestJSON } from '../utils/data.js';
import { chipPicker } from '../utils/dom.js';
import * as H from './nonnormalhist_calc.mjs';
import * as N from './noobs_calc.mjs';

const $ = id => document.getElementById('noobs-' + id);
const finite = v => typeof v === 'number' && Number.isFinite(v);
const RED = '#ef4444', GREEN = '#3fb950';
const VERDICT = { better: ['較好', RED], worse: ['較差', GREEN], same: ['差不多', '#8b949e'], na: ['樣本不足', '#8b949e'] };
let src = { obs: [], br: [] }, px = {}, from = '', res = {}, price = 'tw', signal = 'obs', chart = null, loaded = false;

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
  const pk = Object.keys(N.PRICES);
  const [daily, br, ...ps] = await Promise.all(['data/tw_daily_stats.json', 'data/tw50_ma_breadth.json', ...pk.map(k => `data/${N.PRICES[k].file}.json`)]
    .map(f => requestJSON(f, { signal: context.signal })));
  src = { obs: H.dailyRows(daily?.data), br: (br?.data || []).filter(r => typeof r?.date === 'string').sort((a, b) => (a.date < b.date ? -1 : 1)) };
  if (!src.obs.length) throw new Error('沒有台股每日統計資料');
  pk.forEach((k, i) => { px[k] = priceRows(ps[i]); });
  from = N.startDate(src.obs.at(-1).date);
  for (const s of Object.keys(N.SIGNALS)) for (const k of pk) res[`${s}|${k}`] = px[k].length ? N.analyze(s, src, px[k], from) : null;
  $('asof').textContent = `${from} ～ ${src.obs.at(-1).date}`;
  loaded = true;
}

const lastInd = key => [...N.indicator(key, src)].reverse().find(x => finite(x.v));
const fmtV = (s, v) => `${Number.isInteger(v) ? v : v.toFixed(1)}${s.unit === '%' ? '%' : ` ${s.unit}`}`;

function renderOverview() {
  const rows = Object.entries(N.SIGNALS).map(([k, s]) => {
    const a = res[`${k}|tw`], b = res[`${k}|tw50`], now = lastInd(k);
    const cur = el('span', now ? `${fmtV(s, now.v)}${now.hit ? '・成立' : ''}` : '—');
    if (now?.hit) { cur.style.color = RED; cur.style.fontWeight = '600'; }
    return [s.label, `${a?.all.length ?? '—'}`, `${pp(a?.sAll[120].median)} / ${pp(a?.base[120].median)}`, a ? badge(a.vAll) : '—',
      `${pp(b?.sAll[120].median)} / ${pp(b?.base[120].median)}`, b ? badge(b.vAll) : '—', cur];
  });
  $('overview').replaceChildren(table(['訊號', '次數', '加權 120 日 %（訊號／基準）', '加權', '0050 120 日 %（訊號／基準）', '0050', '現在'], rows));
  const good = Object.keys(N.SIGNALS).filter(k => res[`${k}|tw`]?.vAll.level === 'better' && res[`${k}|tw50`]?.vAll.level === 'better').map(k => N.SIGNALS[k].short);
  const on = Object.keys(N.SIGNALS).filter(k => lastInd(k)?.hit).map(k => N.SIGNALS[k].short);
  $('conclusion').textContent = `近 10 年，加權和 0050 都比任意一天買進好的訊號：${good.join('、') || '無'}。`
    + `無觀察類股（全市場）出現太頻繁，單獨看和隨便買差不多；改用 0050 成分股或均線廣度，訊號比較集中在大跌之後。`
    + `現在成立的：${on.join('、') || '無'}。`;
}

function renderToday() {
  const s = N.SIGNALS[signal], r = res[`${signal}|${price}`], box = $('today');
  box.replaceChildren();
  if (!r) { box.append(el('p', '沒有資料。', 'noobs-note')); return; }
  const last = lastInd(signal), lastEp = r.all.at(-1), p = px[price], c = p.at(-1);
  const high = Math.max(...p.slice(-250).map(x => x.close));
  const items = [
    ['現在', last ? (last.hit ? '條件成立中' : '條件未成立') : '—', last?.hit ? RED : null],
    [s.ind, last ? `${fmtV(s, last.v)}（門檻 ${s.dir} ${s.th}，${last.date}）` : '—'],
    [`${N.PRICES[price].label}距一年高點`, `${pct(c.close / high - 1)}（${c.date}）`],
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
  const sg = N.SIGNALS[signal], pl = N.PRICES[price].label, r = res[`${signal}|${price}`];
  chart ??= echarts.init($('chart'), isLight() ? null : 'dark');
  if (!r) { chart.clear(); return; }
  const p = px[price].filter(x => x.date >= from), dates = p.map(x => x.date);
  const ind = new Map(N.indicator(signal, src).map(x => [x.date, x]));
  const areas = r.all.map(e => [{ xAxis: e.twDate ?? e.date }, { xAxis: e.end && e.end <= dates.at(-1) ? e.end : dates.at(-1) }]);
  const mark = new Set(r.all.map(e => e.twDate));
  chart.setOption({
    ...echartsBase(), animation: false,
    tooltip: { trigger: 'axis', formatter: ps => { const d = dates[ps[0].dataIndex], v = ind.get(d); return `${d}<br>${pl} ${p[ps[0].dataIndex].close.toLocaleString()}<br>${sg.ind} ${finite(v?.v) ? fmtV(sg, v.v) : '—'}${mark.has(d) ? '<br><b>訊號第一天</b>' : ''}`; } },
    grid: [{ top: 24, left: 56, right: 16, height: '52%' }, { top: '68%', left: 56, right: 16, bottom: mob() ? 48 : 40 }],
    xAxis: [{ type: 'category', data: dates, gridIndex: 0, axisLabel: { show: false } }, { type: 'category', data: dates, gridIndex: 1 }],
    yAxis: [{ type: 'log', gridIndex: 0, min: v => v.min * 0.95, max: v => v.max * 1.05, splitLine: { lineStyle: { color: PALETTE.grid } }, axisLabel: { formatter: v => Math.round(v).toLocaleString() } },
      { type: 'value', gridIndex: 1, min: 0, max: sg.unit === '%' ? 100 : null, name: sg.ind, nameTextStyle: { align: 'left' }, splitLine: { lineStyle: { color: PALETTE.grid } } }],
    dataZoom: [{ type: 'inside', xAxisIndex: [0, 1] }],
    series: [
      { name: pl, type: 'line', data: p.map(x => x.close), showSymbol: false, lineStyle: { width: 1.3 }, color: PALETTE.text ?? '#888',
        markArea: { silent: true, itemStyle: { color: 'rgba(239,68,68,0.15)' }, data: areas } },
      { name: '訊號第一天', type: 'scatter', data: p.map(x => (mark.has(x.date) ? x.close : null)), symbolSize: 8, color: RED },
      { name: sg.ind, type: 'line', xAxisIndex: 1, yAxisIndex: 1, data: dates.map(d => ind.get(d)?.v ?? null), showSymbol: false, step: 'end', lineStyle: { width: 1 }, color: '#58a6ff',
        areaStyle: { opacity: 0.15 }, markLine: { silent: true, symbol: 'none', lineStyle: { type: 'dashed', color: RED }, label: { formatter: `門檻 ${sg.th}`, position: 'insideEndTop' }, data: [{ yAxis: sg.th }] } },
    ],
  }, true);
  $('chart-note').textContent = `上：${pl}（對數刻度），紅色區塊＝訊號期間（條件成立到消失滿 20 個交易日），紅點＝訊號第一天。下：${sg.ind}，虛線＝門檻（${sg.dir} ${sg.th} 算成立）。`;
}

function renderCompare() {
  const r = res[`${signal}|${price}`];
  if (!r) { $('compare').replaceChildren(); return; }
  const rows = [];
  const add = (name, s) => N.HORIZONS.forEach(h => rows.push([h === 20 ? name : '', `+${h} 日`, `${s[h].n}`, signed(s[h].median), signed(s[h].mean), finite(s[h].up) ? `${Math.round(s[h].up * 100)}%` : '—', signed(s[h].worst)]));
  add('全部訊號', r.sAll); add('跌深版', r.sDeep); add('任意一天', r.base);
  $('compare').replaceChildren(table(['', '持有', '樣本', '中位數', '平均', '上漲比例', '最差'], rows));
}

function renderEpisodes() {
  const r = res[`${signal}|${price}`];
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
    chipPicker($('price'), 'noobs-price', v => { price = v; renderMarket(); });
    chipPicker($('signal'), 'noobs-signal', v => { signal = v; renderMarket(); });
    render();
  } catch (e) {
    if (context.signal?.aborted) return;
    st.textContent = `載入失敗：${e.message}`;
  }
}
export function onThemeChange() { chart?.dispose(); chart = null; renderChart(); }
export function resize() { chart?.resize(); }
export function getCharts() { return chart ? [chart] : []; }
