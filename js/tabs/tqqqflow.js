// TQQQ 大額資金流入回測 — TQQQ 單日淨流入很大的那天之後，QQQ／QLD／TQQQ 的 5–60 日報酬、最大不利跌幅、
// 相對無訊號日的超額報酬。
// 版面：最新狀態四格 → 參數（門檻／回撤／冷卻／進場／一鍵設定）→ TQQQ 淨值＋每日淨流入＋QQQ 回撤圖
//       → 事件明細與統計（資產、期間 chip）→ 三檔比較 → 門檻敏感度 → 口徑與限制。
// 計算：js/tabs/tqqqflow_calc.mjs；資料：data/proshares_flows.json（scripts/fetch_proshares_flows.py）＋ data/QQQ.json。
import { loaded } from '../state.js';
import { isLight, echartsBase, PALETTE, mob } from '../utils/theme.js';
import { ensureLoaded, requestJSON } from '../utils/data.js';
import { bindOnce, chipPicker } from '../utils/dom.js';
import { preserveChartState } from '../utils/chartLifecycle.js';
import * as C from './tqqqflow_calc.mjs';

const byId = id => document.getElementById('tqqqflow-' + id);
const finite = v => typeof v === 'number' && Number.isFinite(v);
const RED = '#ef4444', GREEN = '#3fb950';
const GROUP_LABEL = { all: '全期', is: '樣本內 2010–2020', oos: '樣本外 2021 起' };
const CHART_START = '2021-01-01';

let series = null, meta = null, loadedAt = 0, chart = null, study = null;
let params = { ...C.DEFAULTS }, asset = 'TQQQ', group = 'all';

function node(tag, text, attrs = {}) {
  const el = document.createElement(tag);
  if (text != null) el.textContent = text;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}
const pct = (x, d = 1) => (finite(x) ? `${x > 0 ? '+' : ''}${(x * 100).toFixed(d)}%` : '—');
const yi = x => (finite(x) ? `${(x / 1e8).toFixed(1)} 億` : '—');
const dirClass = x => (!finite(x) || Math.abs(x) < 5e-4 ? 'tqqqflow-flat' : x > 0 ? 'tqqqflow-up' : 'tqqqflow-down');
const signed = (x, d) => node('span', pct(x, d), { class: dirClass(x) });

function table(id, headers, body, { sepRows = [] } = {}) {
  const t = node('table'), thead = node('thead'), htr = node('tr'), tb = node('tbody');
  for (const h of headers) htr.append(node('th', h));
  thead.append(htr);
  body.forEach((row, r) => {
    const tr = node('tr');
    if (sepRows.includes(r)) tr.className = 'tqqqflow-sep';
    row.forEach((v, i) => {
      const cell = node(i === 0 ? 'th' : 'td');
      if (v instanceof Node) cell.append(v); else cell.textContent = v ?? '—';
      tr.append(cell);
    });
    tb.append(tr);
  });
  t.append(thead, tb);
  byId(id).replaceChildren(t);
  return t;
}

const thrText = p => (p.thrMode === 'pct' ? `前日規模 ${(p.thr * 100).toFixed(0)}%` : `${(p.thr / 1e8).toFixed(0)} 億美元`);
const ddText = p => (p.ddMin > 0 ? `QQQ 距 52 週高點 ≥ ${(p.ddMin * 100).toFixed(0)}%` : '不限回撤');
const lagText = p => (p.lag === 0 ? 'T 收盤進場（對照用）' : `T+${p.lag} 收盤進場`);
const sameParams = (a, b) => ['thrMode', 'thr', 'ddMin', 'cooldown', 'lag'].every(k => a[k] === b[k]);

// ── data ────────────────────────────────────────────────────────────────
async function load(context) {
  const [flows] = await Promise.all([requestJSON('data/proshares_flows.json', { signal: context.signal }), ensureLoaded('QQQ', context)]);
  if (context.signal?.aborted || context.isCurrent?.() === false) return false;
  series = C.buildSeries(flows, loaded.QQQ);
  meta = flows;
  byId('asof').textContent = `資料 ${series.dates[0]} ～ ${series.dates.at(-1)}`;
  const ck = flows.etfiq_check;
  byId('etfiq').textContent = ck ? `ETFIQ 至 ${ck.as_of}：${ck.within_10k_usd}／${ck.n} 天差距小於 1 萬美元` : '本次未取得 ETFIQ 對帳';
  return true;
}

// ── 最新狀態 ─────────────────────────────────────────────────────────────
function renderNow() {
  const st = C.currentStatus(series, study), p = study.params;
  const card = (title, value, sub, lit) => {
    const el = node('div', null, { class: 'tqqqflow-stat' + (lit ? ' is-lit' : '') });
    el.append(node('span', title), node('b', value), node('span', sub));
    return el;
  };
  const ev = st.lastEvent;
  let since = '—';
  if (ev?.entry != null) {
    const px = asset === 'QQQ' ? series.qqq : asset === 'QLD' ? series.qld : series.tqqq;
    since = `進場後 ${asset} ${pct(px.at(-1) / px[ev.entry] - 1)}`;
  }
  byId('now').replaceChildren(
    card(`最新淨流入（${st.date}）`, `${yi(st.flow)}美元`, `占前日規模 ${pct(st.pct)}・門檻 ${thrText(p)}`, st.flowHit),
    card('QQQ 距 52 週高點', pct(st.dd), p.ddMin > 0 ? `門檻 −${(p.ddMin * 100).toFixed(0)}%` : '不限回撤', p.ddMin > 0 && st.ddHit),
    card('今天是否觸發', st.signal ? (st.cooldownLeft > 0 && ev && ev.i !== series.dates.length - 1 ? '符合（冷卻中）' : '觸發') : '未觸發',
      `資金流 ${st.flowHit ? '✓' : '✗'}・回撤 ${p.ddMin > 0 ? (st.ddHit ? '✓' : '✗') : '不限'}${st.cooldownLeft > 0 ? `・冷卻剩 ${st.cooldownLeft} 日` : ''}`, st.signal),
    card('上次事件', ev ? ev.date : '無', ev ? `${st.sessionsSince} 個交易日前・${since}` : '目前條件下沒有事件', false),
  );
}

// ── 圖 ──────────────────────────────────────────────────────────────────
function drawChart() {
  const host = byId('chart');
  if (!chart) chart = echarts.init(host, isLight() ? null : 'dark');
  const s = series, L = mob() ? 46 : 60, R = mob() ? 46 : 64;
  const axis = (gridIndex, show) => ({ type: 'category', gridIndex, data: s.dates, boundaryGap: true, axisTick: { show: false },
    axisLine: { lineStyle: { color: PALETTE.muted } }, axisLabel: { show, color: PALETTE.muted, fontSize: 12, formatter: d => d.slice(0, 7) } });
  const yAxis = (gridIndex, name, extra = {}) => ({ type: 'value', gridIndex, name, nameTextStyle: { color: PALETTE.muted, fontSize: 11 },
    axisLabel: { color: PALETTE.muted, fontSize: 12 }, splitLine: { lineStyle: { color: PALETTE.grid } }, ...extra });
  const flowYi = s.flow.map(v => +(v / 1e8).toFixed(2));
  chart.setOption(echartsBase({
    animation: false,
    legend: { show: false },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'line' }, backgroundColor: PALETTE.bg, borderColor: PALETTE.border, textStyle: { color: PALETTE.text, fontSize: 13 },
      formatter(items) {
        const i = items?.[0]?.dataIndex; if (i == null) return '';
        return [`<b>${s.dates[i]}</b>`, `TQQQ 淨值 ${s.tqqq[i].toFixed(2)}`,
          `淨流入 ${yi(s.flow[i])}美元（${pct(s.pct[i])}）`, `QQQ 距 52 週高點 ${pct(s.dd[i])}`].join('<br>');
      },
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: [{ left: L, right: R, top: 26, height: '56%' }, { left: L, right: R, top: '72%', height: '16%' }],
    xAxis: [axis(0, false), axis(1, true)],
    yAxis: [yAxis(0, 'TQQQ 淨值', { scale: true }), yAxis(0, '淨流入（億美元）', { splitLine: { show: false } }),
      yAxis(1, 'QQQ 回撤 %', { max: 0, axisLabel: { color: PALETTE.muted, fontSize: 12, formatter: v => `${v}` } })],
    dataZoom: [{ type: 'inside', xAxisIndex: [0, 1], filterMode: 'filter' }, { type: 'slider', xAxisIndex: [0, 1], height: 16, bottom: 6, filterMode: 'filter' }],
    series: [
      { id: 'in', name: '淨流入', type: 'bar', xAxisIndex: 0, yAxisIndex: 1, large: true, barGap: '-100%', data: flowYi.map(v => (v > 0 ? v : null)), itemStyle: { color: RED, opacity: 0.55 },
        markLine: { silent: true, symbol: 'none', label: { color: PALETTE.muted, fontSize: 11, formatter: '{c} 億' }, lineStyle: { type: 'dashed', color: RED }, data: [] } },
      { id: 'out', name: '淨流出', type: 'bar', xAxisIndex: 0, yAxisIndex: 1, large: true, data: flowYi.map(v => (v < 0 ? v : null)), itemStyle: { color: GREEN, opacity: 0.55 } },
      { id: 'nav', name: 'TQQQ 淨值', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: s.tqqq, showSymbol: false, lineStyle: { width: 1.4, color: PALETTE.text }, itemStyle: { color: PALETTE.text }, z: 3,
        markLine: { silent: true, symbol: 'none', lineStyle: { type: 'solid', color: '#f0883e', opacity: 0.7 }, label: { show: false }, data: [] } },
      { id: 'dd', name: 'QQQ 距 52 週高點', type: 'line', xAxisIndex: 1, yAxisIndex: 2, data: s.dd.map(v => +(v * 100).toFixed(2)), showSymbol: false,
        lineStyle: { width: 1.1, color: '#58a6ff' }, itemStyle: { color: '#58a6ff' }, areaStyle: { opacity: 0.12 },
        markLine: { silent: true, symbol: 'none', label: { color: PALETTE.muted, fontSize: 11, formatter: '{c}%' }, lineStyle: { type: 'dashed', color: RED }, data: [] } },
    ],
  }), { notMerge: true });
  chart.dispatchAction({ type: 'dataZoom', startValue: s.dates.find(d => d >= CHART_START), endValue: s.dates.at(-1) });
}
function markChart() {
  if (!chart) return;
  const p = study.params;
  chart.setOption({ series: [
    { id: 'in', markLine: { data: p.thrMode === 'usd' ? [{ yAxis: +(p.thr / 1e8).toFixed(1) }] : [] } },
    { id: 'nav', markLine: { data: study.events.map(e => ({ xAxis: e.date })) } },
    { id: 'dd', markLine: { data: p.ddMin > 0 ? [{ yAxis: -p.ddMin * 100 }] : [] } },
  ] });
}

// ── 表 ──────────────────────────────────────────────────────────────────
function renderTables() {
  const p = study.params, H = C.HORIZONS;
  const evs = study.events.filter(e => group === 'all' || e.group === group);
  const isN = study.events.filter(e => e.group === 'is').length, oosN = study.events.length - isN;
  const pending = study.events.filter(e => e.ret[asset][60] == null).length;
  byId('summary-note').textContent = `條件：單日淨流入 ≥ ${thrText(p)}・${ddText(p)}・冷卻 ${p.cooldown ? `${p.cooldown} 個交易日` : '無'}・${lagText(p)}。`
    + `共 ${study.events.length} 筆（樣本內 ${isN}、樣本外 ${oosN}）${pending ? `，${pending} 筆還沒滿 60 日` : ''}。`
    + (evs.length && evs.length < 5 ? ' 這個期間不到 5 筆，平均數只是幾個個案。' : '');

  if (!evs.length) {
    byId('events').replaceChildren(node('p', `${GROUP_LABEL[group]}在目前條件下沒有事件。`, { class: 'tqqqflow-note' }));
    byId('summary').replaceChildren();
  } else {
    table('events', ['流量日 T', '進場日', '淨流入', '占規模', 'QQQ 回撤', ...H.map(h => `${h} 日`), '60 日最大不利'],
      [...evs].reverse().map(e => {
        const date = node('span', e.date);
        if (e.overlap) date.append(node('span', '重疊', { class: 'tqqqflow-tag', title: '和前一筆事件相隔不到 60 個交易日' }));
        return [date, e.entryDate ?? '待公布', yi(e.flow), pct(e.pct), pct(e.dd), ...H.map(h => signed(e.ret[asset][h])),
          e.mae[asset][60] == null ? '—' : signed(e.mae[asset][60])];
      }));
    const st = study.stats[group][asset], row = (label, f, fmt = signed) => [label, ...H.map(h => { const v = f(st[h]); return v == null ? '—' : fmt(v); })];
    const plain = v => pct(v);
    const rows = [
      ['樣本數', ...H.map(h => `${st[h].n}`)],
      row('平均', x => x.mean), row('中位數', x => x.median), row('最大', x => x.max), row('最小', x => x.min),
      row('勝率', x => x.win, v => `${(v * 100).toFixed(0)}%`),
      row('平均最大不利', x => x.maeMean), row('最差最大不利', x => x.maeWorst),
      row('無訊號日平均', x => x.base, plain), row('超額（對無訊號日）', x => x.excess),
    ];
    if (p.ddMin > 0) rows.push(row('同回撤、流入未達門檻日平均', x => x.ddBase, plain), row('超額（對同回撤日）', x => x.ddExcess));
    table('summary', [`${asset}・${GROUP_LABEL[group]}`, ...H.map(h => `${h} 日`)], rows, { sepRows: [1, 6, 8] });
  }

  const cmp = C.ASSETS.map(a => {
    const st = study.stats[group][a];
    return [a, `${st[20].n}`, signed(st[20].mean), signed(st[20].excess), signed(st[60].mean), signed(st[60].excess),
      finite(st[60].win) ? `${(st[60].win * 100).toFixed(0)}%` : '—', signed(st[60].maeMean)];
  });
  table('compare', [GROUP_LABEL[group], '事件數', '20 日平均', '20 日超額', '60 日平均', '60 日超額', '60 日勝率', '60 日平均最大不利'], cmp);
}

function renderSens() {
  const p = study.params, DDS = [0, 0.05, 0.10, 0.15];
  const grid = C.sensitivity(series, p, { asset, horizon: 20, dds: DDS });
  const t = table('sens', [`${asset} 20 日`, ...DDS.map(d => (d ? `回撤 ≥ ${d * 100}%` : '不限回撤'))],
    grid.map(r => [thrText(r), ...r.cells.map(c => {
      const el = node('span');
      el.append(node('span', `${c.n} 筆 `, { class: 'tqqqflow-dim' }), signed(c.excess));
      return el;
    })]));
  grid.forEach((r, ri) => r.cells.forEach((c, ci) => {
    if (r.thrMode === p.thrMode && r.thr === p.thr && c.ddMin === p.ddMin) t.tBodies[0].rows[ri].cells[ci + 1].classList.add('tqqqflow-cur');
  }));
}

// ── 控制項 ──────────────────────────────────────────────────────────────
function setActive(id, attr, value) {
  byId(id).querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c.dataset[attr] === value));
}
function syncChips() {
  setActive('thr', 'tqqqflowThr', `${params.thrMode}:${params.thrMode === 'pct' ? params.thr : `${params.thr / 1e8}e8`}`);
  setActive('dd', 'tqqqflowDd', `${params.ddMin}`);
  setActive('cool', 'tqqqflowCool', `${params.cooldown}`);
  setActive('lag', 'tqqqflowLag', `${params.lag}`);
  setActive('preset', 'tqqqflowPreset', sameParams(params, C.DEFAULTS) ? 'spec' : sameParams(params, C.CHART_PRESET) ? 'chart' : '');
}
function recompute() {
  study = C.runStudy(series, params);
  syncChips(); renderNow(); markChart(); renderTables(); renderSens();
}
function wire() {
  if (!bindOnce(byId('thr'))) return;
  chipPicker(byId('thr'), 'tqqqflow-thr', v => { const [m, x] = v.split(':'); params = { ...params, thrMode: m, thr: Number(x) }; recompute(); });
  chipPicker(byId('dd'), 'tqqqflow-dd', v => { params = { ...params, ddMin: Number(v) }; recompute(); });
  chipPicker(byId('cool'), 'tqqqflow-cool', v => { params = { ...params, cooldown: Number(v) }; recompute(); });
  chipPicker(byId('lag'), 'tqqqflow-lag', v => { params = { ...params, lag: Number(v) }; recompute(); });
  chipPicker(byId('preset'), 'tqqqflow-preset', v => { params = { ...(v === 'chart' ? C.CHART_PRESET : C.DEFAULTS) }; recompute(); });
  chipPicker(byId('asset'), 'tqqqflow-asset', v => { asset = v; renderNow(); renderTables(); renderSens(); });
  chipPicker(byId('group'), 'tqqqflow-group', v => { group = v; renderTables(); });
}

// ── lifecycle ────────────────────────────────────────────────────────────
export async function activate(context = {}) {
  if (series && Date.now() - loadedAt < 300_000) { resize(); return; }
  try {
    if ((await load(context)) === false) return;
  } catch (e) {
    if (!context.signal?.aborted) byId('status').textContent = '載入失敗：' + (e.message || e);
    throw e;
  }
  loadedAt = Date.now();
  byId('status').textContent = '';
  wire(); drawChart(); recompute();
}
export function getCharts() { return chart ? [chart] : []; }
export function resize() { chart?.resize(); }
export function onThemeChange() {
  if (!series) return;
  return preserveChartState(getCharts, () => { chart?.dispose(); chart = null; drawChart(); markChart(); });
}
