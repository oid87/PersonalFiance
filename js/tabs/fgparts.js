// fgparts.js — CNN 恐懼貪婪七分項 × S&P 500：上格價格（指數／SPY／VOO＋可調均線），下格 0–100 分數（CNN 總分、估算總分、七分項可個別開關）。
// 2020-08 前的分項讀數來自 data/fear_greed_proxy.json（免費資料重建），之後用 CNN 原始讀數。
import { isLight, echartsBase, PALETTE, mob } from '../utils/theme.js';
import { requestJSON } from '../utils/data.js';
import { bindOnce, chipPicker } from '../utils/dom.js';
import { tsToLocalDate } from '../utils/dates.js';
import { preserveChartState } from '../utils/chartLifecycle.js';
import { PARTS, ELI5, PRICE_SOURCES, DISPLAY_FROM, buildParts, compareWithCnn, mergeProxy, officialSnapshot, priceWithMA, zoneOf } from './fgparts_calc.mjs';

const PRICE_FILES = { SPX: 'data/SP500.json', SPY: 'data/SPY.json', VOO: 'data/VOO.json' };

const COLORS = { momentum: '#e8590c', strength: '#2f9e44', breadth: '#1c7ed6', putcall: '#ae3ec9', junk: '#c2255c', vix: '#f08c00', safehaven: '#0c8599' };
const on = new Set(['momentum', 'vix']);
let chart = null, model = null, src = 'SPX', maN = 125;
const prices = {};

const $ = id => document.getElementById(id);
const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');

async function loadAll(context) {
  const [comp, fg, proxy, ...px] = await Promise.all([
    requestJSON('data/fear_greed_components.json', { signal: context.signal }),
    requestJSON('data/fear_greed.json', { signal: context.signal }),
    requestJSON('data/fear_greed_proxy.json', { signal: context.signal }).catch(() => null),
    ...Object.values(PRICE_FILES).map(f => requestJSON(f, { signal: context.signal })),
  ]);
  if (!comp?.data?.length) throw new Error('恐懼貪婪分項資料不足');
  Object.keys(PRICE_FILES).forEach((k, i) => { prices[k] = px[i]?.data ?? []; });
  const all = buildParts(mergeProxy(proxy?.data ?? [], comp.data));
  const i0 = Math.max(0, all.dates.findIndex(d => d >= DISPLAY_FROM));
  const cut = a => a.slice(i0);
  const built = { dates: cut(all.dates), composite: cut(all.composite),
    parts: Object.fromEntries(PARTS.map(p => [p.id, { raw: cut(all.parts[p.id].raw), score: cut(all.parts[p.id].score) }])) };
  const cnnStart = comp.data.reduce((m, r) => (!m || r.date < m ? r.date : m), null);
  const fgRows = fg?.data ?? [];
  const split = (lo, hi) => { const keep = built.dates.map(d => d >= lo && d < hi);
    return compareWithCnn(built.dates.filter((_, i) => keep[i]), built.composite.filter((_, i) => keep[i]), fgRows); };
  model = { ...built, fg: fgRows.filter(r => r.date >= built.dates[0]), snap: officialSnapshot(comp.scores?.at(-1)),
    cnnStart, proxyUntil: proxy?.proxy_until ?? null, latest: comp.data.at(-1),
    fit: split(cnnStart, '9999'), fitProxy: proxy ? split('0000', cnnStart) : null };
}

function renderToggles() {
  const host = $('fgparts-toggles');
  host.innerHTML = PARTS.map(p => `<button type="button" class="chip${on.has(p.id) ? ' active' : ''}" data-part="${p.id}" aria-pressed="${on.has(p.id)}" title="${p.note}"><i style="background:${COLORS[p.id]}"></i>${p.label}</button>`).join('')
    + '<button type="button" class="chip" data-part="__all">全開</button><button type="button" class="chip" data-part="__none">全關</button>';
  if (!bindOnce(host)) return;
  host.addEventListener('click', e => {
    const id = e.target.closest('button[data-part]')?.dataset.part;
    if (!id) return;
    if (id === '__all') PARTS.forEach(p => on.add(p.id));
    else if (id === '__none') on.clear();
    else on.has(id) ? on.delete(id) : on.add(id);
    renderToggles();
    redraw();
  });
}

function redraw() { preserveChartState(getCharts, () => chart?.setOption(buildOption(), { notMerge: true })); }

function bindControls() {
  chipPicker($('fgparts-src'), 'fg-src', v => { src = v; redraw(); });
  const input = $('fgparts-ma-input');
  const setMa = n => { maN = Math.min(400, Math.max(5, Math.round(n) || 125)); input.value = maN;
    $('fgparts-ma').querySelectorAll('.chip').forEach(c => c.classList.toggle('active', +c.dataset.fgMa === maN)); redraw(); };
  chipPicker($('fgparts-ma'), 'fg-ma', v => setMa(+v));
  if (bindOnce(input)) input.addEventListener('change', () => setMa(+input.value));
}

function renderText() {
  const s = model.snap;
  $('fgparts-asof').textContent = `資料至 ${model.dates.at(-1)}`;
  $('fgparts-status').textContent = '點按鈕開關分項。均線只改上圖顯示，股市動能分數照 CNN 定義固定用 125 日。';
  const f = (x, label) => (x ? `${label} ${x.n} 個交易日：相關 ${fmt(x.corr, 2)}、平均差 ${fmt(x.mae)} 分` : '');
  $('fgparts-fit').textContent = [f(model.fit, `${model.cnnStart} 起（CNN 原始讀數）`), f(model.fitProxy, '2011 年起到此之前（重建讀數）')].filter(Boolean).join('；') || '（重疊資料不足）';
  $('fgparts-eli5-list').innerHTML = PARTS.map(p => { const e = ELI5[p.id];
    return `<div class="fgparts-eli5-item"><h4><i style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${COLORS[p.id]}"></i> ${p.label}</h4>
      <p><b>白話</b>：${e.like}</p><p><b>怎麼看</b>：${e.how}</p><p><b>例子</b>：${e.eg}</p>${e.more ? `<details class="fgparts-more"><summary>什麼是 Put／Call？買方、賣方差在哪？</summary>${e.more}</details>` : ''}
      <p><b>今天（${model.latest.date}）</b>：${e.today(model.latest)}${model.snap ? `，CNN 給 ${fmt(model.snap.items.find(i => i.id === p.id)?.score)} 分（${zoneOf(model.snap.items.find(i => i.id === p.id)?.score)}）` : ''}。</p></div>`; }).join('');
  $('fgparts-today').innerHTML = !s ? '<p class="note-muted">尚無分項分數快照。</p>' : `
    <table><thead><tr><th>分項</th><th class="num">分數</th><th>區間</th></tr></thead><tbody>
    ${s.items.map(i => `<tr><td><i style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${COLORS[i.id]}"></i> ${i.label}</td><td class="num">${fmt(i.score)}</td><td>${zoneOf(i.score)}</td></tr>`).join('')}
    <tr><td><b>七項等權平均</b></td><td class="num"><b>${fmt(s.mean)}</b></td><td>${zoneOf(s.mean)}</td></tr>
    <tr><td>CNN 公布總分</td><td class="num">${fmt(s.composite)}</td><td>${zoneOf(s.composite)}</td></tr>
    </tbody></table>
    <p class="note-muted">${s.date} 快照。平均與公布總分若差 1 分內，多半是兩者取值時間不同或捨入。</p>`;
}

function buildOption() {
  const m = model, small = mob();
  const pair = arr => m.dates.map((d, i) => [d, arr[i]]);
  const pr = priceWithMA(prices[src], maN, m.dates[0]);
  const pname = PRICE_SOURCES[src], maName = `${maN} 日均線`;
  const line = (name, data, color, extra = {}) => ({ name, type: 'line', data, showSymbol: false, xAxisIndex: 1, yAxisIndex: 1, lineStyle: { width: 1.3, color }, itemStyle: { color }, ...extra });
  const series = [
    { name: pname, type: 'line', data: pr.dates.map((d, i) => [d, pr.close[i]]), showSymbol: false, lineStyle: { width: 1.5, color: PALETTE.text }, itemStyle: { color: PALETTE.text },
      markArea: m.proxyUntil ? { silent: true, label: { show: !small, color: PALETTE.muted, position: 'insideTopLeft', fontSize: 11 }, data: [[{ name: '分項為重建讀數', xAxis: m.dates[0], itemStyle: { color: 'rgba(128,128,128,.08)' } }, { xAxis: m.proxyUntil }]] } : undefined },
    { name: maName, type: 'line', data: pr.dates.map((d, i) => [d, pr.ma[i]]), showSymbol: false, lineStyle: { width: 1.2, type: 'dashed', color: '#e8590c' }, itemStyle: { color: '#e8590c' } },
    line('CNN 總分', m.fg.map(r => [r.date, r.value]), PALETTE.text, { lineStyle: { width: 2, color: PALETTE.text },
      markArea: { silent: true, data: [[{ yAxis: 0, itemStyle: { color: 'rgba(224,49,49,.08)' } }, { yAxis: 25 }], [{ yAxis: 75, itemStyle: { color: 'rgba(47,158,68,.08)' } }, { yAxis: 100 }]] } }),
    line('估算總分', pair(m.composite), PALETTE.muted, { lineStyle: { width: 1.5, type: 'dashed', color: PALETTE.muted } }),
    ...PARTS.filter(p => on.has(p.id)).map(p => line(p.label, pair(m.parts[p.id].score), COLORS[p.id])),
  ];
  const twoYears = m.dates[Math.max(0, m.dates.length - 504)];
  // 兩格共用同一 x 範圍，否則各自依資料端點縮放，十字線上下對不齊
  const xMin = m.dates[0], xMax = [m.dates.at(-1), pr.dates.at(-1), m.fg.at(-1)?.date].filter(Boolean).sort().at(-1);
  return echartsBase({
    animation: false,
    legend: { top: 0, textStyle: { color: PALETTE.muted, fontSize: small ? 11 : 12 }, data: [maName, 'CNN 總分', '估算總分'] },
    grid: [{ left: small ? 44 : 60, right: 12, top: 34, height: '30%' }, { left: small ? 44 : 60, right: 12, top: '46%', bottom: 64 }],
    xAxis: [0, 1].map(i => ({ type: 'time', gridIndex: i, min: xMin, max: xMax, axisLabel: { show: i === 1, color: PALETTE.muted }, axisLine: { lineStyle: { color: PALETTE.border } } })),
    yAxis: [
      { type: 'value', gridIndex: 0, scale: true, name: small ? '' : pname, nameTextStyle: { color: PALETTE.muted }, axisLabel: { color: PALETTE.muted }, splitLine: { lineStyle: { color: PALETTE.grid } } },
      { type: 'value', gridIndex: 1, min: 0, max: 100, interval: 25, name: '0–100 分', nameTextStyle: { color: PALETTE.muted }, axisLabel: { color: PALETTE.muted }, splitLine: { lineStyle: { color: PALETTE.grid } } },
    ],
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    tooltip: { trigger: 'axis', confine: true, axisPointer: { type: 'line' },
      formatter: ps => {
        const d = tsToLocalDate(ps[0].axisValue);
        return `<b>${d}</b><br>` + ps.filter(p => Number.isFinite(p.value?.[1])).map(p => `${p.marker}${p.seriesName}${p.seriesIndex > 3 ? ' 分數' : ''}：${fmt(p.value[1], p.seriesIndex < 2 ? (src === 'SPX' ? 0 : 2) : 1)}`).join('<br>');
      } },
    dataZoom: [{ type: 'inside', xAxisIndex: [0, 1], startValue: twoYears, filterMode: 'weakFilter' },
      { type: 'slider', xAxisIndex: [0, 1], startValue: twoYears, bottom: 8, height: 22, filterMode: 'weakFilter' }],
    series,
  });
}

export async function activate(context = {}) {
  const host = $('fgparts-chart');
  if (!host) return;
  try {
    await loadAll(context);
    if (context.signal?.aborted || context.isCurrent?.() === false) return;
    if (!chart) chart = echarts.init(host, isLight() ? null : 'dark');
    renderToggles();
    bindControls();
    renderText();
    chart.setOption(buildOption(), { notMerge: true });
  } catch (e) {
    $('fgparts-status').textContent = '載入失敗：' + (e.message || e);
    throw e;
  }
}

export function onThemeChange() { if (chart && model) chart.setOption(buildOption(), { notMerge: true }); }
export function resize() { chart?.resize(); }
export function getCharts() { return chart ? [chart] : []; }
