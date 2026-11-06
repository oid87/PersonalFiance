// fgparts.js — CNN 恐懼貪婪七分項 × S&P 500：上格 S&P 500，下格 0–100 分數（CNN 總分、估算總分、七分項可個別開關）。
import { isLight, echartsBase, PALETTE, mob } from '../utils/theme.js';
import { requestJSON } from '../utils/data.js';
import { bindOnce } from '../utils/dom.js';
import { tsToLocalDate } from '../utils/dates.js';
import { preserveChartState } from '../utils/chartLifecycle.js';
import { PARTS, buildParts, compareWithCnn, officialSnapshot, zoneOf } from './fgparts_calc.mjs';

const COLORS = { momentum: '#e8590c', strength: '#2f9e44', breadth: '#1c7ed6', putcall: '#ae3ec9', junk: '#c2255c', vix: '#f08c00', safehaven: '#0c8599' };
const on = new Set(['momentum', 'vix']);
let chart = null, model = null;

const $ = id => document.getElementById(id);
const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');

async function loadAll(context) {
  const [comp, fg] = await Promise.all([
    requestJSON('data/fear_greed_components.json', { signal: context.signal }),
    requestJSON('data/fear_greed.json', { signal: context.signal }),
  ]);
  if (!comp?.data?.length) throw new Error('恐懼貪婪分項資料不足');
  const built = buildParts(comp.data);
  const start = built.dates[0];
  model = { ...built, fg: (fg?.data ?? []).filter(r => r.date >= start), snap: officialSnapshot(comp.scores?.at(-1)),
    fit: compareWithCnn(built.dates, built.composite, fg?.data ?? []) };
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
    preserveChartState(getCharts, () => chart?.setOption(buildOption(), { notMerge: true }));
  });
}

function renderText() {
  const s = model.snap;
  $('fgparts-asof').textContent = `資料至 ${model.dates.at(-1)}`;
  $('fgparts-status').textContent = '點上方按鈕開關分項；分項曲線為本頁重建的近似分數。';
  $('fgparts-fit').textContent = model.fit
    ? `2020 年起 ${model.fit.n} 個交易日：相關係數 ${fmt(model.fit.corr, 2)}、平均差 ${fmt(model.fit.mae)} 分`
    : '（重疊資料不足）';
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
  const sp = pair(m.parts.momentum.raw);
  const line = (name, data, color, extra = {}) => ({ name, type: 'line', data, showSymbol: false, xAxisIndex: 1, yAxisIndex: 1, lineStyle: { width: 1.3, color }, itemStyle: { color }, ...extra });
  const series = [
    { name: 'S&P 500', type: 'line', data: sp, showSymbol: false, lineStyle: { width: 1.5, color: PALETTE.text }, itemStyle: { color: PALETTE.text } },
    line('CNN 總分', m.fg.map(r => [r.date, r.value]), PALETTE.text, { lineStyle: { width: 2, color: PALETTE.text },
      markArea: { silent: true, data: [[{ yAxis: 0, itemStyle: { color: 'rgba(224,49,49,.08)' } }, { yAxis: 25 }], [{ yAxis: 75, itemStyle: { color: 'rgba(47,158,68,.08)' } }, { yAxis: 100 }]] } }),
    line('估算總分', pair(m.composite), PALETTE.muted, { lineStyle: { width: 1.5, type: 'dashed', color: PALETTE.muted } }),
    ...PARTS.filter(p => on.has(p.id)).map(p => line(p.label, pair(m.parts[p.id].score), COLORS[p.id])),
  ];
  const twoYears = m.dates[Math.max(0, m.dates.length - 504)];
  return echartsBase({
    animation: false,
    legend: { top: 0, textStyle: { color: PALETTE.muted, fontSize: small ? 11 : 12 }, data: ['CNN 總分', '估算總分'] },
    grid: [{ left: small ? 44 : 60, right: 12, top: 34, height: '30%' }, { left: small ? 44 : 60, right: 12, top: '46%', bottom: 64 }],
    xAxis: [0, 1].map(i => ({ type: 'time', gridIndex: i, axisLabel: { show: i === 1, color: PALETTE.muted }, axisLine: { lineStyle: { color: PALETTE.border } } })),
    yAxis: [
      { type: 'value', gridIndex: 0, scale: true, name: 'S&P 500', nameTextStyle: { color: PALETTE.muted }, axisLabel: { color: PALETTE.muted }, splitLine: { lineStyle: { color: PALETTE.grid } } },
      { type: 'value', gridIndex: 1, min: 0, max: 100, interval: 25, name: '0–100 分', nameTextStyle: { color: PALETTE.muted }, axisLabel: { color: PALETTE.muted }, splitLine: { lineStyle: { color: PALETTE.grid } } },
    ],
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    tooltip: { trigger: 'axis', confine: true, axisPointer: { type: 'line' },
      formatter: ps => {
        const d = tsToLocalDate(ps[0].axisValue);
        return `<b>${d}</b><br>` + ps.filter(p => Number.isFinite(p.value?.[1])).map(p => `${p.marker}${p.seriesName}：${fmt(p.value[1], p.seriesName === 'S&P 500' ? 0 : 1)}`).join('<br>');
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
