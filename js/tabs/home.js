// 主儀表板（預設首頁）：關鍵指標速覽＋各分支入口。各分支頁由這裡點進去（#tab=<id>）。
// 急跌事件卡沿用 js/tabs/qqqpanic_calc.mjs（正式研究口徑），與「QQQ恐慌背離回測」頁數字一致。
import { isLight, echartsBase, PALETTE, mob } from '../utils/theme.js';
import { requestJSON } from '../utils/data.js';
import { preserveChartState } from '../utils/chartLifecycle.js';
import { CATEGORIES } from '../navigation-catalog.mjs';
import * as E from './qqqpanic_calc.mjs';

const byId = id => document.getElementById('home-' + id);
const finite = v => typeof v === 'number' && Number.isFinite(v);
const sg = (v, d = 1) => (finite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(d)}` : 'N/A');
const num = (v, d = 2) => (finite(v) ? v.toFixed(d) : 'N/A');
const NEW_TABS = new Set(['qqqpanic']);
const CLS_COLOR = { B: '#ef4444', A: '#d4a017', U: '#8b949e' };

let res = null, latest = null, chart = null, loadedAt = 0;

function node(tag, text, attrs = {}) {
  const el = document.createElement(tag);
  if (text != null) el.textContent = text;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}
function card({ title, value, sub, note, tab, tone }) {
  const a = node('a', null, { class: 'ui-card home-card' + (tone ? ' home-' + tone : ''), href: '#tab=' + tab });
  a.append(node('h4', title), node('div', value, { class: 'home-value' }), node('p', sub || '', { class: 'home-sub' }), node('p', (note ? note + '　' : '') + '→ 進入分頁', { class: 'note-muted' }));
  return a;
}

async function load(context = {}) {
  const get = url => requestJSON(url, { signal: context.signal });
  const [q, vix, vxn, fg] = await Promise.all([get('data/QQQ.json'), get('data/VIX.json'), get('data/VXN.json'), get('data/fear_greed.json')]);
  const rows = (p, name) => { if (!Array.isArray(p?.data) || !p.data.length) throw new Error(`${name} 資料格式錯誤或為空`); return p.data; };
  const raw = { QQQ: rows(q, 'QQQ'), VIX: rows(vix, 'VIX'), VXN: rows(vxn, 'VXN'), FG: rows(fg, 'Fear & Greed') };
  if (context.signal?.aborted || context.isCurrent?.() === false) return false;
  const cfg = E.configure({ end: raw.QQQ.at(-1).date });   // 首頁看最新資料；事件定義仍是正式口徑
  const F = E.buildFrame(raw, cfg);
  res = { F, cfg, R: E.runThreshold(F, E.DEFAULTS.main, cfg), fgRating: fg.data.at(-1)?.rating ?? null };
  return true;
}

function renderCards() {
  const { F, R, fgRating } = res, i = F.endIdx, d = F.date[i];
  const dist = p => (finite(F.ma[p][i]) ? (F.c[i] / F.ma[p][i] - 1) * 100 : null);
  const chg = (F.c[i] / F.c[i - 1] - 1) * 100;
  const ev = R.rows.at(-1), sub = ev ? (ev.panic === 'A' ? ev.panicSub : ev.panic) : null;
  const daysAgo = ev ? F.endIdx - ev.idx : null;
  const vixHot = finite(F.vixH[i]) && F.vixH[i] >= E.DEFAULTS.vixPanic, fgHot = finite(F.fg[i]) && F.fg[i] < E.DEFAULTS.fgPanic;
  latest = ev;
  byId('cards').replaceChildren(
    card({ title: 'QQQ', value: `${num(F.c[i])}（${sg(chg, 2)}%）`, sub: `距 125MA ${sg(dist(125))}%｜150MA ${sg(dist(150))}%｜300MA ${sg(dist(300))}%`, note: dist(150) < 0 ? '收盤在 150MA 下方' : '收盤在 150MA 上方', tab: 'trend', tone: dist(150) < 0 ? 'warn' : '' }),
    card({ title: 'VIX', value: `${num(F.vixC[i])}`, sub: `當日 High ${num(F.vixH[i])}（極端門檻 ${E.DEFAULTS.vixPanic}）`, note: vixHot ? '已達極端門檻' : '', tab: 'vix_term', tone: vixHot ? 'hot' : '' }),
    card({ title: 'VXN（Nasdaq 波動）', value: `${num(F.vxnC[i])}`, sub: `當日 High ${num(F.vxnH[i])}｜輔助門檻 ${E.DEFAULTS.vxnAux}`, tab: 'vxnvix' }),
    card({ title: 'Fear & Greed', value: finite(F.fg[i]) ? `${num(F.fg[i], 1)}` : 'N/A', sub: `${fgRating ?? ''}｜極端恐懼門檻 < ${E.DEFAULTS.fgPanic}`, note: fgHot ? '已達極端恐懼' : '', tab: 'sentiment', tone: fgHot ? 'hot' : '' }),
    card({ title: 'QQQ 盤中急跌（≤ −3%）', value: ev ? `${ev.date}（${sub}）` : '研究期間無', sub: ev ? `${daysAgo === 0 ? '最新交易日' : daysAgo + ' 個交易日前'}｜盤中 ${sg(ev.dropLow, 2)}%｜RVOL ${num(ev.volRatio)}｜VIX H ${num(ev.vixHigh)}｜F&G ${num(ev.fg, 1)}` : '',
      note: ev ? (ev.panic === 'A' ? '急跌但未極端恐慌' : ev.panic === 'B' ? '伴隨極端恐慌' : '缺 F&G') : '', tab: 'qqqpanic', tone: ev && daysAgo <= 20 ? 'warn' : '' }),
  );
  const stale = (Date.now() - Date.parse(d)) / 86400000 > 5;
  byId('asof').textContent = `最新交易日 ${d}${stale ? '（⚠ 資料可能過期）' : ''}｜卡片與小圖皆可點進對應分頁。描述性資訊，不是買賣訊號。`;
}

function drawChart() {
  const { F, R } = res, i1 = F.endIdx, i0 = Math.max(0, i1 - 251), idx = [];
  for (let k = i0; k <= i1; k++) idx.push(k);
  const dates = idx.map(k => F.date[k]);
  const evs = R.rows.filter(r => r.idx >= i0);
  if (!chart || chart.isDisposed?.()) chart = echarts.init(byId('chart'), isLight() ? null : 'dark');
  chart.setOption(echartsBase({
    animation: false,
    legend: { top: 0, textStyle: { color: PALETTE.muted, fontSize: 11 } },
    tooltip: { trigger: 'axis', confine: true },
    grid: { left: mob() ? 46 : 56, right: mob() ? 40 : 50, top: mob() ? 58 : 32, bottom: 30 },
    xAxis: { type: 'category', data: dates, boundaryGap: false },
    yAxis: [{ type: 'value', scale: true, name: 'QQQ', nameTextStyle: { color: '#f778ba', fontSize: 10 } }, { type: 'value', min: 0, max: 100, name: 'F&G', position: 'right', splitLine: { show: false }, nameTextStyle: { color: '#e3b341', fontSize: 10 } }],
    dataZoom: [],
    series: [
      { name: 'QQQ 收盤', type: 'line', data: idx.map(k => F.c[k]), showSymbol: false, lineStyle: { color: '#f778ba', width: 1.5 }, itemStyle: { color: '#f778ba' } },
      { name: '150MA', type: 'line', data: idx.map(k => (finite(F.ma[150][k]) ? +F.ma[150][k].toFixed(2) : null)), showSymbol: false, lineStyle: { color: '#58a6ff', width: 1, type: 'dashed' }, itemStyle: { color: '#58a6ff' } },
      { name: 'Fear & Greed', type: 'line', yAxisIndex: 1, data: idx.map(k => F.fg[k]), showSymbol: false, lineStyle: { color: '#e3b341', width: 1 }, itemStyle: { color: '#e3b341' } },
      { name: '盤中 −3% 事件', type: 'scatter', data: evs.map(r => ({ value: [r.date, r.low], itemStyle: { color: CLS_COLOR[r.panic] } })), symbol: 'triangle', symbolRotate: 180, symbolSize: 9, itemStyle: { color: CLS_COLOR.A } },
    ],
  }), { notMerge: true });
  if (!chart.__homeWired) { chart.__homeWired = true; chart.getZr().on('click', () => { location.hash = '#tab=qqqpanic'; }); }
}

function renderBranches() {
  if (byId('branches').childElementCount) return;
  byId('branches').replaceChildren(...CATEGORIES.map(cat => {
    const tabs = cat.tabs.filter(t => t.id !== 'home');
    const box = node('section', null, { class: 'ui-card home-branch', 'aria-label': cat.label });
    const list = node('div', null, { class: 'home-links' });
    for (const t of tabs) {
      const a = node('a', t.label, { class: 'chip', href: '#tab=' + t.id });
      if (NEW_TABS.has(t.id)) a.append(node('span', '新', { class: 'home-new' }));
      list.append(a);
    }
    box.append(node('h4', `${cat.label}（${tabs.length}）`), list);
    return box;
  }));
}

export async function activate(context = {}) {
  renderBranches();
  if (res && Date.now() - loadedAt < 300_000) { resize(); return; }
  const fresh = await load(context);
  if (fresh === false) return;
  loadedAt = Date.now();
  try { renderCards(); drawChart(); } catch (e) { byId('asof').textContent = '計算失敗：' + e.message; throw e; }
}
export function getCharts() { return chart && !chart.isDisposed?.() ? [chart] : []; }
export function resize() { chart?.resize(); }
export function onThemeChange() {
  if (!res) return;
  return preserveChartState(getCharts, () => { chart?.dispose(); chart = null; drawChart(); });
}
// 測試用
export function _latestEvent() { return latest ? { date: latest.date, panic: latest.panic } : null; }
