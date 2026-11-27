// 15 年歷史 — 極端狀態儀表板的子頁面：儀表板 25 張卡同一批序列，改看近 15 年。
// 每個指標一張圖（捲到附近才畫），可縮放／拖曳；縱軸＝可見區間最高 +10%、最低 −10%，縮放時重算。
// 深連結：#tab=nonnormallong&focus=<序列 id 小寫、底線換 ->（儀表板大圖的「看 15 年歷史」按鈕用）。
// 資料：與儀表板同一份 context（nonnormal_history.js load），美股融資餘額另讀 data/liquidity.json（月資料）。
import { isLight, echartsBase, PALETTE } from '../utils/theme.js';
import { requestJSON } from '../utils/data.js';
import { preserveChartState } from '../utils/chartLifecycle.js';
import * as N from './nonnormal_calc.mjs';
import * as NH from './nonnormal_history.js';
import { CARD_GROUPS, TICKERS, REF_LINES, valueFmt } from './nonnormal.js';

const SPAN_DAYS = Math.round(15 * 365.25);
const byId = id => document.getElementById('nonnormallong-' + id);
const finite = v => typeof v === 'number' && Number.isFinite(v);
export const focusId = id => id.toLowerCase().replace(/_/g, '-');
const NONNEG = new Set(['count', 'days', 'ratio', 'score', 'usmargin']);

let built = false, loadedAt = 0, usMargin = null, observer = null;
const charts = new Map();   // id → echarts instance

function node(tag, text, attrs = {}) {
  const el = document.createElement(tag);
  if (text != null) el.textContent = text;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/** 某張卡的 15 年資料：{ dates, vals, fmt, refs, start }；沒資料回 null。 */
function seriesFor([id, , sigId, kind = 'px']) {
  const ctx = NH.getContext();
  if (id === 'US_MARGIN') {
    if (!usMargin?.length) return null;
    const last = usMargin.at(-1).date, from = new Date(Date.parse(last) - SPAN_DAYS * 86400000).toISOString().slice(0, 10);
    const rows = usMargin.filter(r => r.date >= from);
    return { dates: rows.map(r => r.date), vals: rows.map(r => r.debit / 1e6), fmt: v => (finite(v) ? v.toFixed(2) + ' 兆' : '—'), refs: [], kind };
  }
  const s = ctx?.s[id];
  if (!s?.dates?.length) return null;
  const q = N.quote(s, ctx.lastDate, { span: SPAN_DAYS, mas: [] });
  if (!q) return null;
  return { dates: q.dates, vals: q.close, fmt: valueFmt(kind, q.last), refs: REF_LINES[sigId] || REF_LINES[id] || [], kind };
}

/** 可見區間 [i0, i1] 的縱軸：最高 +10%、最低 −10%（非負指標下限不低於 0）。 */
export function yRange(vals, i0, i1, nonneg = false) {
  let lo = Infinity, hi = -Infinity;
  for (let i = Math.max(0, i0); i <= Math.min(vals.length - 1, i1); i++) if (finite(vals[i])) { lo = Math.min(lo, vals[i]); hi = Math.max(hi, vals[i]); }
  if (!finite(lo)) return {};
  const pad = v => Math.abs(v) * 0.1 || 1;
  let min = lo - pad(lo), max = hi + pad(hi);
  if (nonneg && lo >= 0) min = Math.max(0, min);
  return { min, max };
}

function draw(def) {
  const [id] = def, el = byId('chart-' + id);
  if (!el || charts.has(id)) return;
  const d = seriesFor(def);
  if (!d) { el.textContent = '尚無資料'; el.classList.add('nonnormallong-empty'); return; }
  const chart = echarts.init(el, isLight() ? null : 'dark');
  charts.set(id, chart);
  const nonneg = NONNEG.has(d.kind);
  const fitY = () => {
    const dz = chart.getOption().dataZoom?.[0] || {};
    const n = d.dates.length - 1;
    const i0 = finite(dz.startValue) ? dz.startValue : Math.round((dz.start ?? 0) / 100 * n);
    const i1 = finite(dz.endValue) ? dz.endValue : Math.round((dz.end ?? 100) / 100 * n);
    chart.setOption({ yAxis: yRange(d.vals, i0, i1, nonneg) });
  };
  chart.setOption(echartsBase({
    animation: false,
    grid: { left: 8, right: 16, top: 12, bottom: 44, containLabel: true },
    tooltip: { trigger: 'axis', valueFormatter: d.fmt },
    xAxis: { type: 'category', data: d.dates, boundaryGap: false, axisLabel: { color: PALETTE.muted, fontSize: 12, formatter: v => v.slice(0, 7) } },
    yAxis: { type: 'value', ...yRange(d.vals, 0, d.vals.length - 1, nonneg), axisLabel: { color: PALETTE.muted, fontSize: 12, formatter: d.fmt }, splitLine: { lineStyle: { color: PALETTE.grid } } },
    dataZoom: [{ type: 'slider', height: 20, bottom: 6 }, { type: 'inside' }],
    series: [{ name: def[1], type: 'line', data: d.vals, showSymbol: false, lineStyle: { width: 1.2, color: PALETTE.text }, itemStyle: { color: PALETTE.text }, areaStyle: { opacity: 0.06 },
      markLine: d.refs.length ? { silent: true, symbol: 'none', lineStyle: { type: 'dashed', color: '#ef4444' }, label: { color: PALETTE.muted, fontSize: 11 }, data: d.refs.map(v => ({ yAxis: v, label: { formatter: d.fmt(v) } })) } : undefined }],
  }), { notMerge: true });
  chart.on('datazoom', fitY);
  const start = d.dates[0], firstYear = new Date(Date.parse(d.dates.at(-1)) - SPAN_DAYS * 86400000).toISOString().slice(0, 10);
  const meta = byId('meta-' + id);
  if (meta) meta.textContent = `${start} 起` + (start > firstYear.slice(0, 7) + '-31' ? '（資料不到 15 年，從可取得的第一天開始）' : '') + `｜最新 ${d.dates.at(-1)}`;
}

function build() {
  const root = byId('list');
  const nav = byId('nav');
  root.replaceChildren(); nav.replaceChildren();
  observer?.disconnect();
  observer = new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) { const def = defs.get(e.target.dataset.id); if (def) draw(def); observer.unobserve(e.target); }
  }, { rootMargin: '400px 0px' });
  const defs = new Map();
  for (const g of CARD_GROUPS) {
    root.append(node('h3', g.title, { class: 'nonnormallong-group' }));
    for (const def of g.cards) {
      const [id, name] = def;
      defs.set(id, def);
      const box = node('section', null, { class: 'nonnormallong-item', 'data-nav-focus': focusId(id) });
      const head = node('div', null, { class: 'nonnormallong-item-head' });
      head.append(node('h4', name), TICKERS[id] ? node('small', TICKERS[id]) : '', node('span', '', { id: 'nonnormallong-meta-' + id, class: 'nonnormallong-meta' }));
      const chart = node('div', null, { id: 'nonnormallong-chart-' + id, class: 'nonnormallong-chart', role: 'img', 'aria-label': `${name}近 15 年走勢`, 'data-id': id });
      box.append(head, chart);
      root.append(box);
      observer.observe(chart);
      const a = node('a', name, { href: `#tab=nonnormallong&focus=${focusId(id)}`, class: 'chip' });
      nav.append(a);
    }
  }
  built = true;
}

export async function activate(context = {}) {
  if (built && Date.now() - loadedAt < 300_000) { resize(); return; }
  try {
    const [ok, liq] = await Promise.all([NH.load(context), requestJSON('data/liquidity.json', { signal: context.signal }).catch(() => null)]);
    if (ok === false || context.isCurrent?.() === false) return;
    usMargin = liq?.margin?.filter(r => finite(r.debit)) || null;
  } catch (e) {
    if (!context.signal?.aborted) byId('status').textContent = '載入失敗：' + (e.message || e);
    throw e;
  }
  loadedAt = Date.now();
  const miss = NH.missingFiles();
  byId('status').textContent = miss.length ? `部分資料載入失敗：${miss.join('、')}` : '';
  byId('asof').textContent = `資料至 ${NH.getContext().lastDate}`;
  for (const c of charts.values()) c.dispose();
  charts.clear();
  build();
}
export function getCharts() { return [...charts.values()]; }
export function resize() { getCharts().forEach(c => c.resize()); }
export function onThemeChange() {
  if (!built) return;
  return preserveChartState(getCharts, () => {
    const ids = [...charts.keys()];
    for (const c of charts.values()) c.dispose();
    charts.clear();
    const all = new Map(CARD_GROUPS.flatMap(g => g.cards).map(d => [d[0], d]));
    for (const id of ids) draw(all.get(id));
  });
}
