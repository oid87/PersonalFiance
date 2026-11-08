// 無主流日 — 每天盤面有沒有「主流族群」（帶量創 60 日新高、同產業 ≥ 3 檔）。描述性，不是買賣訊號。
// 計算：js/tabs/mainstream_calc.mjs；資料：data/tw_mainstream.json（scripts/fetch_tw_mainstream.py）＋ data/TWII.json。
import { isLight, echartsBase, PALETTE, mob } from '../utils/theme.js';
import { requestJSON } from '../utils/data.js';
import { chipPicker } from '../utils/dom.js';
import * as M from './mainstream_calc.mjs';

const $ = id => document.getElementById('mainstream-' + id);
const COLORS = ['#3fb950', '#d29922', '#ef4444'];
const RANGE = { '6M': 126, '1Y': 252, '3Y': 756, all: Infinity };
let judged = [], twii = new Map(), chart = null, range = '1Y', loaded = false;

function el(tag, text, cls) { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }

async function load(context = {}) {
  if (loaded) return;
  const [m, t] = await Promise.all([
    requestJSON('data/tw_mainstream.json', { signal: context.signal }),
    requestJSON('data/TWII.json', { signal: context.signal }),
  ]);
  if (!Array.isArray(m?.data) || !m.data.length) throw new Error('主流族群資料不足');
  judged = M.judgeAll(m.data);
  twii = new Map((t?.data || []).map(r => [r.date, r.close]));
  $('asof').textContent = `資料到 ${judged.at(-1).date}`;
  loaded = true;
}

function renderToday() {
  const d = judged.at(-1), box = $('today');
  box.replaceChildren();
  const badge = el('span', d.strong && d.level === 2 ? '強勢、無進場點' : M.LEVELS[d.level], 'mainstream-badge');
  badge.style.background = d.strong && d.level === 2 ? '#8b5cf6' : COLORS[d.level];
  const tier = M.COUNT_TIERS[d.tier];
  const items = [
    ['今天', badge],
    ['候選股', `${d.cands} 檔（${d.groups.length} 個主流族群）`],
    ['近 22 個交易日「完全沒有」', `${d.count} 次：${tier.text}`],
    ['連續完全沒有', d.streak ? `${d.streak} 天${d.streak3 ? '（已連續 3 天，規則原文對應融資 T+2 斷頭）' : ''}` : '0 天'],
    ['開盤即鎖漲停', `${d.lock} 檔`],
  ];
  const last = [...judged].reverse().find(x => x.turn);
  items.push(['最近一次轉折（完全沒有 → 有）', last ? last.date : '—']);
  for (const [k, v] of items) {
    const row = el('div', null, 'mainstream-kv');
    row.append(el('span', k, 'mainstream-k'));
    const val = el('span', null, 'mainstream-v'); typeof v === 'string' ? (val.textContent = v) : val.append(v);
    row.append(val); box.append(row);
  }
  const g = $('groups');
  g.replaceChildren();
  if (!d.groups.length) { g.append(el('p', '今天沒有主流族群。', 'mainstream-note')); return; }
  g.append(table(['產業', '檔數', '個股代號'], d.groups.map(x => [x.ind, String(x.n), x.codes.join('、')])));
}

function table(head, rows) {
  const t = el('table', null, 'mainstream-table'), h = el('tr');
  head.forEach(x => h.append(el('th', x)));
  t.append(el('thead')); t.tHead.append(h);
  const b = el('tbody');
  for (const r of rows) { const tr = el('tr'); for (const x of r) { const td = el('td'); x instanceof Node ? td.append(x) : (td.textContent = x); tr.append(td); } b.append(tr); }
  t.append(b);
  return t;
}

function renderRecent() {
  const rows = judged.slice(-30).reverse().map(d => {
    const s = el('span', d.strong && d.level === 2 ? '強勢無進場點' : M.LEVELS[d.level]);
    s.style.color = d.strong && d.level === 2 ? '#8b5cf6' : COLORS[d.level];
    return [d.date, s, String(d.cands), d.groups.map(g => `${g.ind} ${g.n}`).join('、') || '—', String(d.count), String(d.countNoGroup), d.turn ? '轉折' : d.streak3 ? `連 ${d.streak}` : ''];
  });
  $('recent').replaceChildren(table(['日期', '判定', '候選', '主流族群', '近22日完全沒有', '近22日沒有主流族群', '標記'], rows));
}

function renderChart() {
  if (typeof echarts === 'undefined') return;
  chart ??= echarts.init($('chart'), isLight() ? null : 'dark');
  const ds = judged.slice(-Math.min(judged.length, RANGE[range]));
  const dates = ds.map(d => d.date);
  const base = echartsBase();
  chart.setOption({
    ...base, animation: false,
    tooltip: { trigger: 'axis', formatter: ps => { const d = ds[ps[0].dataIndex]; return `${d.date}<br>加權 ${twii.get(d.date)?.toLocaleString() ?? '—'}<br>${M.LEVELS[d.level]}${d.strong ? '（鎖漲停多）' : ''}・候選 ${d.cands}<br>近 22 日完全沒有 ${d.count} 次・沒有主流族群 ${d.countNoGroup} 次`; } },
    grid: [{ top: 24, left: 56, right: 16, height: '48%' }, { top: '64%', left: 56, right: 16, bottom: mob() ? 48 : 40 }],
    xAxis: [{ type: 'category', data: dates, gridIndex: 0, axisLabel: { show: false } }, { type: 'category', data: dates, gridIndex: 1 }],
    yAxis: [{ type: 'value', scale: true, gridIndex: 0, splitLine: { lineStyle: { color: PALETTE.grid } } }, { type: 'value', gridIndex: 1, min: 0, max: 22, name: '近 22 日次數', splitLine: { lineStyle: { color: PALETTE.grid } } }],
    dataZoom: [{ type: 'inside', xAxisIndex: [0, 1] }],
    series: [
      { name: '加權', type: 'line', data: dates.map(d => twii.get(d) ?? null), showSymbol: false, lineStyle: { width: 1.4 }, color: PALETTE.text ?? '#888',
},
      { name: '完全沒有', type: 'scatter', data: ds.map(d => (d.none ? twii.get(d.date) ?? null : null)), symbolSize: 6, color: COLORS[2] },
      { name: '轉折', type: 'scatter', data: ds.map(d => (d.turn ? twii.get(d.date) ?? null : null)), symbol: 'triangle', symbolSize: 10, color: COLORS[0] },
      { name: '近 22 日完全沒有', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: ds.map(d => ({ value: d.count, itemStyle: { color: d.count >= 5 ? COLORS[2] : d.count >= 3 ? '#f97316' : d.count ? COLORS[1] : '#8b949e' } })), barCategoryGap: 0,
        markLine: { silent: true, symbol: 'none', lineStyle: { type: 'dashed' }, data: [{ yAxis: 3 }, { yAxis: 5 }] } },
      { name: '參考：沒有主流族群（含稍微有）', type: 'line', xAxisIndex: 1, yAxisIndex: 1, data: ds.map(d => d.countNoGroup), showSymbol: false, step: 'end', lineStyle: { width: 1.2 }, color: '#58a6ff' },
    ],
  }, true);
}

export function render() {
  if (!loaded) return;
  renderToday(); renderRecent(); renderChart();
}
export async function activate(context = {}) {
  const st = $('status');
  try {
    await load(context);
    if (context.signal?.aborted) return;
    st.textContent = '';
    chipPicker($('range'), 'mainstream-range', v => { range = v; renderChart(); });
    render();
  } catch (e) {
    if (context.signal?.aborted) return;
    st.textContent = `載入失敗：${e.message}`;
  }
}
export function onThemeChange() { chart?.dispose(); chart = null; renderChart(); }
export function resize() { chart?.resize(); }
export function getCharts() { return chart ? [chart] : []; }
