// QQQ 盤中急跌 × 恐慌背離回測（描述性研究，不是買賣訊號）。
// 引擎 js/tabs/qqqpanic_calc.mjs（與 scripts/research/backtest_qqq_panic.mjs 共用）；報告 docs/research/qqq-panic-divergence*.md。
// 主事件＝Low_T / Close_{T-1} − 1 ≤ 門檻；A/B 只用 VIX High 與 Fear & Greed；VXN 只作輔助。
import { isLight, echartsBase, PALETTE, mob } from '../utils/theme.js';
import { requestJSON } from '../utils/data.js';
import { bindOnce, chipPicker } from '../utils/dom.js';
import { preserveChartState } from '../utils/chartLifecycle.js';
import { infoButton, initInfoPopovers } from '../utils/info_popover.js';
import * as E from './qqqpanic_calc.mjs';

const byId = id => document.getElementById('qqqpanic-' + id);
const finite = v => typeof v === 'number' && Number.isFinite(v);
const f1 = v => (finite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(1)}` : '—');
const p0 = v => (finite(v) ? `${(v * 100).toFixed(0)}%` : '—');
const C = E.DEFAULTS;

const HELP = {
  ts: '上到下：QQQ 收盤與 125／150／300MA（事件點：紅三角＝B 極端恐慌、橘圓＝A1 前 60 日曾恐慌、藍圓＝A0 前 60 日未曾恐慌）；VIX High 與 VXN High（30／40 門檻）；Fear & Greed（15 門檻）；Low 相對 T-60～T-1 最高 High 的回撤。四格共用時間軸，縮放同步。',
  scatter: '每點是一個事件：x＝當日 Fear & Greed、y＝當日 VIX High；底色區為 B（F&G < 15 或 VIX High ≥ 30）。顏色＝60 日內相對事件日 Low 的額外跌幅（灰＝右設限，未滿 60 日）。點大小＝RVOL20。',
  dist: 'A0＝無極端恐慌且前 60 日也未曾恐慌；A1＝當天無極端恐慌、但前 60 日曾恐慌（已回落）；B＝當天極端恐慌。盒鬚為 P10／四分位／中位／P90，點為個別事件。右設限事件不納入。',
  path: '只作事後描述：A 事件「之後」是否升級成極端恐慌，是未來才知道的資訊，T 日的 A/B 分類不變，不能拿來模擬當天決策。',
  ab: '比例：點估計（件數/n）與 Wilson 95%；B − A 用 Newcombe 95%。中位數：percentile bootstrap 95%。年份區塊 bootstrap 以日曆年為重抽單位，處理同年事件與未來窗重疊，屬敏感度分析。區間包含 0 代表分不出差異。未去重逐筆樣本彼此重疊，只給點估計。',
  match: '特徵只用 T 日及以前：事前 60 日回撤、距 125／150MA、150MA 20 日斜率、RVOL20、VIX High、F&G、前 60 日是否已極端恐慌；權重全部為 1、事前固定。只從「目標日之前、60 日窗已完整」的事件中找，同一群組只留最近一筆。相似度不是未來發生機率。',
};
const METRIC_LABEL = { extra60: '60 日相對事件日 Low 額外跌幅 %', extra20: '20 日相對事件日 Low 額外跌幅 %', totalDD60: '60 日最大總回撤 %（相對事前高點）', ret20: '20 日報酬 %（T+1 開盤）', ret60: '60 日報酬 %（T+1 開盤）', mae60: '60 日最大不利 %（T+1 開盤）' };
const CLS_COLOR = { B: '#ef4444', A1: '#f0883e', A0: '#58a6ff', 'A?': '#8b949e', U: '#8b949e' };

let res = null, loadedAt = 0, charts = {}, thr = C.main, setKey = 'gv', rangeKey = 'all', metricKey = 'extra60', abCache = new Map();

function node(tag, text, attrs = {}) {
  const el = document.createElement(tag);
  if (text != null) el.textContent = text;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}
function table(id, headers, rows) {
  const t = node('table'), thead = node('thead'), htr = node('tr'), body = node('tbody');
  for (const h of headers) htr.append(node('th', h, { scope: 'col' }));
  thead.append(htr);
  if (!rows.length) rows = [['（沒有符合條件的事件）']];
  for (const row of rows) { const tr = node('tr'); row.forEach((v, i) => tr.append(node(i === 0 ? 'th' : 'td', v ?? '—'))); body.append(tr); }
  t.append(thead, body); byId(id).replaceChildren(t);
}
function card(title, value, sub) {
  const el = node('article', null, { class: 'ui-card' });
  el.append(node('h4', title), node('div', value, { class: 'qqqpanic-value' }), node('p', sub || '', { class: 'note-muted' }));
  return el;
}

// ── data ────────────────────────────────────────────────────────────────
async function load(context = {}) {
  const get = url => requestJSON(url, { signal: context.signal });
  const [q, vix, vxn, fg] = await Promise.all([get('data/QQQ.json'), get('data/VIX.json'), get('data/VXN.json'), get('data/fear_greed.json')]);
  const rows = (p, name) => { if (!Array.isArray(p?.data) || !p.data.length) throw new Error(`${name} 資料格式錯誤或為空`); return p.data; };
  const raw = { QQQ: rows(q, 'QQQ'), VIX: rows(vix, 'VIX'), VXN: rows(vxn, 'VXN'), FG: rows(fg, 'Fear & Greed') };
  if (context.signal?.aborted || context.isCurrent?.() === false) return false;
  res = E.run(raw, C);
  abCache = new Map();
  return true;
}
const R = () => res.byThr[thr];
function sample() {
  const r = R();
  if (setKey === 'gv') return { rows: r.reps.filter(x => x.volSurge), unit: 'group', label: `${thr}%｜爆量（RVOL20 ≥ ${C.volSurge}）｜20 日去重` };
  if (setKey === 'g') return { rows: r.reps, unit: 'group', label: `${thr}%｜不限量｜20 日去重` };
  return { rows: r.rows, unit: 'raw', label: `${thr}%｜不限量｜未去重逐筆（彼此重疊，不給區間）` };
}
const subOf = r => (r.panic === 'A' ? r.panicSub : r.panic);

// ── cards ───────────────────────────────────────────────────────────────
function renderCards() {
  const r = R(), s = sample(), F = res.F, last = F.endIdx;
  const latest = r.rows.at(-1);
  const below150 = F.c[last] < F.ma[150][last];
  byId('cards').replaceChildren(
    card(`${thr}% 原始事件`, `${r.rows.length}`, `A ${r.rows.filter(x => x.panic === 'A').length}／B ${r.rows.filter(x => x.panic === 'B').length}／未分類 ${r.rows.filter(x => x.panic === 'U').length}`),
    card('20 日去重群組', `${r.groups.length}`, `60 日冷卻敏感度 ${r.coolReps.length} 群；爆量群組 ${r.reps.filter(x => x.volSurge).length}`),
    card('目前樣本', `${s.rows.length}`, `${s.label}；右設限 ${s.rows.filter(x => !x.complete).length}`),
    card(`最新交易日 ${F.date[last]}`, `${F.c[last].toFixed(2)}`, `距 150MA ${f1((F.c[last] / F.ma[150][last] - 1) * 100)}%（${below150 ? '下方' : '上方'}）｜VIX H ${F.vixH[last] ?? '—'}｜F&G ${F.fg[last] ?? '缺'}${latest ? `｜最近事件 ${latest.date}（${subOf(latest)}）` : ''}`),
  );
  byId('asof').textContent = `研究期間 ${F.date[F.startIdx]} ～ ${F.date[F.endIdx]}；F&G 缺 ${countMissingFg()} 個交易日（不補值）。未來窗未滿 60 日的事件標「右設限」，不納入完整期統計。`;
}
function countMissingFg() { let n = 0; for (let i = res.F.startIdx; i <= res.F.endIdx; i++) if (res.F.fg[i] === null) n++; return n; }

// ── chart helpers ───────────────────────────────────────────────────────
function chart(key) {
  if (!charts[key]) charts[key] = echarts.init(byId(key), isLight() ? null : 'dark');
  return charts[key];
}
const tip = () => ({ backgroundColor: PALETTE.bg, borderColor: PALETTE.border, textStyle: { color: PALETTE.text, fontSize: 12 }, confine: true });

// 1. linked time series
const RANGE_IDS = ['all', ...E.PERIODS.map(p => p.id)];
function drawTS() {
  const F = res.F, i0 = Math.max(0, F.startIdx - 1), i1 = F.endIdx;
  const idx = []; for (let i = i0; i <= i1; i++) idx.push(i);
  const dates = idx.map(i => F.date[i]);
  const ev = R().rows, evAt = new Map(ev.map(r => [r.date, r]));
  const dd = idx.map(i => { let hi = null; for (let k = Math.max(0, i - 60); k < i; k++) if (finite(F.h[k]) && (hi === null || F.h[k] > hi)) hi = F.h[k]; return hi ? +((F.l[i] / hi - 1) * 100).toFixed(2) : null; });
  const L = mob() ? 44 : 60, Rr = mob() ? 12 : 24;
  const axis = (g, show) => ({ type: 'category', gridIndex: g, data: dates, boundaryGap: false, axisLine: { lineStyle: { color: PALETTE.muted } }, axisLabel: { color: PALETTE.muted, fontSize: 11, show }, axisTick: { show: false }, splitLine: { show: false } });
  const yAx = (g, name, extra = {}) => ({ type: 'value', gridIndex: g, name, nameTextStyle: { color: PALETTE.muted, fontSize: 10 }, axisLabel: { color: PALETTE.muted, fontSize: 10 }, splitLine: { lineStyle: { color: PALETTE.grid } }, ...extra });
  const line = (name, g, data, color, extra = {}) => ({ name, type: 'line', xAxisIndex: g, yAxisIndex: g, data, showSymbol: false, lineStyle: { width: 1, color }, itemStyle: { color }, ...extra });
  const marks = cls => ev.filter(r => subOf(r) === cls).map(r => [r.date, r.close]);
  const hline = (y, color) => ({ silent: true, symbol: 'none', lineStyle: { type: 'dashed', color }, label: { color: PALETTE.muted, fontSize: 10, formatter: String(y) }, data: [{ yAxis: y }] });
  const option = echartsBase({
    animation: false,
    legend: { top: 0, type: 'scroll', textStyle: { color: PALETTE.muted, fontSize: 11 } },
    tooltip: {
      ...tip(), trigger: 'axis', axisPointer: { type: 'cross' },
      formatter(params) {
        const k = params?.[0]?.dataIndex; if (k == null) return '';
        const i = idx[k], r = evAt.get(F.date[i]);
        const lines = [`<b>${F.date[i]}</b>｜QQQ ${F.c[i]?.toFixed(2)}｜Low/前收 ${f1(E.intradayDrop(F, i))}%`,
          `VIX H ${F.vixH[i] ?? '—'}｜VXN H ${F.vxnH[i] ?? '—'}｜F&G ${F.fg[i] ?? '缺'}｜距 150MA ${f1((F.c[i] / F.ma[150][i] - 1) * 100)}%`];
        if (r) lines.push(`<b style="color:${CLS_COLOR[subOf(r)]}">● ${thr}% 事件（${subOf(r)}）</b> 跳空 ${f1(r.gap)}%、開盤後 ${f1(r.sessionDrop)}%、RVOL ${finite(r.volRatio) ? r.volRatio.toFixed(2) : '—'}`,
          r.h[60] ? `60 日：額外跌幅 ${f1(r.h[60].extra)}%、總回撤 ${f1(r.h[60].totalDD)}%、報酬 ${f1(r.h[60].retOpen)}%` : `右設限（已觀察 ${r.avail} 日）`);
        return lines.join('<br>');
      },
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: [{ left: L, right: Rr, top: 34, height: '40%' }, { left: L, right: Rr, top: '52%', height: '14%' }, { left: L, right: Rr, top: '69%', height: '10%' }, { left: L, right: Rr, top: '82%', height: '9%' }],
    xAxis: [axis(0, false), axis(1, false), axis(2, false), axis(3, true)],
    yAxis: [yAx(0, '', { type: 'log', min: 'dataMin' }), yAx(1, 'VIX/VXN High'), yAx(2, 'F&G', { min: 0, max: 100 }), yAx(3, '回撤 %', { max: 0 })],
    dataZoom: [{ type: 'inside', xAxisIndex: [0, 1, 2, 3], filterMode: 'filter' }, { type: 'slider', xAxisIndex: [0, 1, 2, 3], height: 16, bottom: 4, filterMode: 'filter' }],
    series: [
      line('QQQ 收盤', 0, idx.map(i => F.c[i]), PALETTE.text, { id: 'qqq', lineStyle: { width: 1.2, color: PALETTE.text } }),
      line('125MA', 0, idx.map(i => F.ma[125][i] && +F.ma[125][i].toFixed(2)), '#a371f7'),
      line('150MA', 0, idx.map(i => F.ma[150][i] && +F.ma[150][i].toFixed(2)), '#e3b341'),
      line('300MA', 0, idx.map(i => F.ma[300][i] && +F.ma[300][i].toFixed(2)), '#8b949e', { lineStyle: { width: 1, type: 'dashed', color: '#8b949e' } }),
      { name: 'B 極端恐慌', type: 'scatter', xAxisIndex: 0, yAxisIndex: 0, data: marks('B'), symbol: 'triangle', symbolSize: 10, itemStyle: { color: CLS_COLOR.B }, z: 5 },
      { name: 'A1 前 60 日曾恐慌', type: 'scatter', xAxisIndex: 0, yAxisIndex: 0, data: marks('A1'), symbolSize: 9, itemStyle: { color: CLS_COLOR.A1 }, z: 5 },
      { name: 'A0 前 60 日未曾恐慌', type: 'scatter', xAxisIndex: 0, yAxisIndex: 0, data: marks('A0'), symbolSize: 9, itemStyle: { color: CLS_COLOR.A0 }, z: 5 },
      line('VIX High', 1, idx.map(i => F.vixH[i]), '#58a6ff', { markLine: hline(C.vixPanic, '#58a6ff') }),
      line('VXN High（輔助）', 1, idx.map(i => F.vxnH[i]), '#a371f7', { markLine: hline(C.vxnAux, '#a371f7') }),
      line('Fear & Greed', 2, idx.map(i => F.fg[i]), '#3fb950', { connectNulls: false, markLine: hline(C.fgPanic, '#3fb950') }),
      line('Low 相對 T-60～T-1 高點 %', 3, dd, '#ef4444', { areaStyle: { opacity: 0.15, color: '#ef4444' } }),
    ],
  });
  chart('ts').setOption(option, { notMerge: true });
  applyRange();
}
function applyRange() {
  const ch = charts.ts; if (!ch) return;
  const F = res.F, p = E.PERIODS.find(x => x.id === rangeKey);
  const first = F.date[Math.max(0, F.startIdx - 1)], lastD = F.date[F.endIdx];
  const startValue = p ? (F.date.find(d => d >= p.from) ?? first) : first;
  let endValue = lastD; if (p) for (let i = F.startIdx; i <= F.endIdx; i++) if (F.date[i] <= p.to) endValue = F.date[i];
  // 全站 zoom 下限為 1 年（js/utils/zoomFloor.js），短區間會被放寬；所以另以底色標出所選區間。
  ch.setOption({ series: [{ id: 'qqq', markArea: p ? { silent: true, itemStyle: { color: 'rgba(227,179,65,0.12)' }, label: { show: true, position: 'insideTop', color: PALETTE.muted, fontSize: 10 }, data: [[{ xAxis: startValue, name: p.label }, { xAxis: endValue }]] } : { data: [] } }] });
  ch.dispatchAction({ type: 'dataZoom', startValue, endValue });
}

// 2. panic scatter
const depthColor = r => (!r.h[60] ? '#8b949e' : r.h[60].extra <= -10 ? '#ef4444' : r.h[60].extra <= -5 ? '#f0883e' : '#3fb950');
function drawScatter() {
  const rows = sample().rows.filter(r => finite(r.vixHigh));
  const yMax = Math.ceil(Math.max(45, ...rows.map(r => r.vixHigh)) / 5) * 5;
  const buckets = [['額外跌 ≥10%', r => r.h[60] && r.h[60].extra <= -10], ['額外跌 5～10%', r => r.h[60] && r.h[60].extra > -10 && r.h[60].extra <= -5], ['額外跌 <5%', r => r.h[60] && r.h[60].extra > -5], ['右設限', r => !r.h[60]]];
  const fgMissing = rows.filter(r => !finite(r.fg));
  const pt = r => ({ value: [finite(r.fg) ? r.fg : -4, r.vixHigh], name: r.date, symbolSize: Math.max(6, Math.min(26, 4 + 6 * (r.volRatio || 1))), r,
    label: r.date >= '2026-01-01' ? { show: true, formatter: r.date.slice(2), color: PALETTE.text, fontSize: 10, position: 'right' } : undefined });
  const option = echartsBase({
    animation: false,
    legend: { top: 0, textStyle: { color: PALETTE.muted, fontSize: 11 } },
    tooltip: { ...tip(), trigger: 'item', formatter: p => { const r = p.data?.r; if (!r) return ''; return [`<b>${r.date}</b>（${subOf(r)}${r.isRep === false && sample().unit === 'raw' ? '，非群組代表' : ''}）`, `盤中 ${f1(r.dropLow)}%｜跳空 ${f1(r.gap)}%｜RVOL ${finite(r.volRatio) ? r.volRatio.toFixed(2) : '—'}`, `VIX H ${r.vixHigh}｜F&G ${r.fg ?? '缺（畫在 x=−4）'}｜VXN H ${r.vxnHigh ?? '—'}`, r.h[60] ? `60 日額外跌幅 ${f1(r.h[60].extra)}%｜總回撤 ${f1(r.h[60].totalDD)}%` : `右設限（已觀察 ${r.avail} 日）`].join('<br>'); } },
    grid: { left: mob() ? 44 : 56, right: 24, top: 40, bottom: 48 },
    xAxis: { type: 'value', name: 'Fear & Greed（當日）', nameLocation: 'middle', nameGap: 28, min: -8, max: 100, nameTextStyle: { color: PALETTE.muted } },
    yAxis: { type: 'value', name: 'VIX High（當日）', min: 10, max: yMax, nameTextStyle: { color: PALETTE.muted } },
    dataZoom: [],
    series: buckets.map(([name, fn], k) => ({
      name, type: 'scatter', data: rows.filter(fn).map(pt), itemStyle: { color: ['#ef4444', '#f0883e', '#3fb950', '#8b949e'][k], opacity: 0.85 },
      ...(k === 0 ? { markArea: { silent: true, itemStyle: { color: 'rgba(239,68,68,0.08)' }, data: [[{ xAxis: -8, yAxis: C.vixPanic }, { xAxis: 100, yAxis: yMax }], [{ xAxis: -8, yAxis: 10 }, { xAxis: C.fgPanic, yAxis: C.vixPanic }]] },
        markLine: { silent: true, symbol: 'none', lineStyle: { type: 'dashed', color: PALETTE.muted }, label: { color: PALETTE.muted, fontSize: 10 }, data: [{ xAxis: C.fgPanic, label: { formatter: 'F&G 15' } }, { yAxis: C.vixPanic, label: { formatter: 'VIX 30' } }] } } : {}),
    })),
  });
  chart('scatter').setOption(option, { notMerge: true });
  if (fgMissing.length) byId('status').dataset.fgNote = `${fgMissing.length} 個事件 F&G 缺值，畫在 x = −4。`;
}

// 3. distribution
const getMetric = (r, key) => E.metric(key)?.get(r);
function drawDist() {
  const rows = sample().rows.filter(r => r.complete);
  const groups = ['A0', 'A1', 'B'];
  const vals = groups.map(g => rows.filter(r => subOf(r) === g).map(r => getMetric(r, metricKey)).filter(finite).sort((a, b) => a - b));
  const box = vals.map(v => (v.length ? [E.quantile(v, 0.1), E.quantile(v, 0.25), E.quantile(v, 0.5), E.quantile(v, 0.75), E.quantile(v, 0.9)].map(x => +x.toFixed(2)) : []));
  const pts = groups.flatMap((g, k) => rows.filter(r => subOf(r) === g && finite(getMetric(r, metricKey))).map((r, j) => ({ value: [k + ((j % 7) - 3) * 0.04, +getMetric(r, metricKey).toFixed(2)], r })));
  const option = echartsBase({
    animation: false,
    tooltip: { ...tip(), trigger: 'item', formatter: p => (p.seriesType === 'boxplot' ? `${groups[p.dataIndex]}（n=${vals[p.dataIndex].length}）<br>P10 ${p.data[1]}｜Q1 ${p.data[2]}｜中位 ${p.data[3]}｜Q3 ${p.data[4]}｜P90 ${p.data[5]}` : p.data?.r ? `${p.data.r.date}（${subOf(p.data.r)}）：${p.data.value[1]}` : '') },
    grid: { left: mob() ? 48 : 60, right: 24, top: 30, bottom: 40 },
    xAxis: [{ type: 'category', data: groups.map((g, k) => `${g}（n=${vals[k].length}）`), axisLine: { onZero: false } }, { type: 'value', min: -0.5, max: 2.5, show: false, axisLine: { show: false, onZero: false } }],
    yAxis: { type: 'value', name: METRIC_LABEL[metricKey], nameTextStyle: { color: PALETTE.muted, fontSize: 10 }, axisLine: { onZero: false } },
    dataZoom: [],
    series: [
      { name: '分布', type: 'boxplot', data: box, itemStyle: { color: 'transparent', borderColor: PALETTE.muted } },
      { name: '事件', type: 'scatter', xAxisIndex: 1, data: pts, symbolSize: 7, itemStyle: { color: p => CLS_COLOR[subOf(p.data.r)], opacity: 0.8 } },
    ],
  });
  chart('dist').setOption(option, { notMerge: true });
}

// 4. A → B path
function drawPath() {
  const A = sample().rows.filter(r => r.panic === 'A');
  const paths = ['A→B ≤20日', 'A→B 21–60日', 'A 未升級', '右設限'];
  const depth = [['額外跌 ≥10%', r => r.h[60]?.deep10 === true, '#ef4444'], ['額外跌 5～10%', r => r.h[60]?.deep5 === true && r.h[60]?.deep10 === false, '#f0883e'], ['額外跌 <5%', r => r.h[60]?.deep5 === false, '#3fb950'], ['右設限', r => !r.h[60], '#8b949e']];
  const option = echartsBase({
    animation: false,
    legend: { top: 0, textStyle: { color: PALETTE.muted, fontSize: 11 } },
    tooltip: { ...tip(), trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: ps => { const p = ps[0]; const list = A.filter(r => r.path === paths[p.dataIndex]); return `<b>${paths[p.dataIndex]}</b>（${list.length} 件）<br>` + ps.map(x => `${x.seriesName}：${x.value}`).join('<br>') + `<br><span style="color:${PALETTE.muted}">${list.map(r => r.date).join('、')}</span>`; } },
    grid: { left: mob() ? 92 : 110, right: 24, top: 36, bottom: 30 },
    xAxis: { type: 'value', name: '件數', minInterval: 1 },
    yAxis: { type: 'category', data: paths, inverse: true },
    dataZoom: [],
    series: depth.map(([name, fn, color]) => ({ name, type: 'bar', stack: 'n', data: paths.map(p => A.filter(r => r.path === p && fn(r)).length), itemStyle: { color }, label: { show: true, formatter: p => (p.value ? p.value : ''), color: '#fff', fontSize: 11 } })),
  });
  chart('path').setOption(option, { notMerge: true });
  byId('path-note').textContent = `${sample().label}：A 組 ${A.length} 件。升級＝之後首次出現 VIX High ≥ 30 或 F&G < 15；額外跌幅＝60 日內最低 Low 相對事件日 Low。這張圖回答「當下沒有極端恐慌的急跌，之後恐慌會不會來、沒來時還會跌多深」，但升級與否是事後才知道的。`;
}

// ── tables ──────────────────────────────────────────────────────────────
function abFor() {
  const key = `${thr}|${setKey}`;
  if (!abCache.has(key)) {
    const s = sample();
    abCache.set(key, s.unit === 'group' ? E.compareAB(s.rows, C) : { A: E.describe(s.rows.filter(r => r.panic === 'A'), E.AB_KEYS), B: E.describe(s.rows.filter(r => r.panic === 'B'), E.AB_KEYS), diff: null, block: null });
  }
  return abCache.get(key);
}
function cellTxt(o, kind) {
  if (!o || !o.n) return '—（n=0）';
  if (kind === 'share') return `${p0(o.value)}（${o.count}/${o.n}）${o.wilson && finite(o.wilson.lo) ? ` W[${p0(o.wilson.lo)}, ${p0(o.wilson.hi)}]` : ''}`;
  return `${f1(o.value)}${o.ci && finite(o.ci.lo) ? ` [${f1(o.ci.lo)}, ${f1(o.ci.hi)}]` : ''}（n=${o.n}）`;
}
function renderAB() {
  const ab = abFor(), s = sample();
  const row = (key, tag) => {
    const M = E.metric(key), aOnly = E.A_ONLY_KEYS.has(key), d = ab.diff?.[key], bl = ab.block?.[key];
    const diff = aOnly ? '不適用' : !ab.diff ? '（逐筆不估）' : !d || !finite(d.est) ? '—' : M.kind === 'share' ? `${f1(d.est * 100)} pt [${f1(d.lo * 100)}, ${f1(d.hi * 100)}]` : `${f1(d.est)} [${f1(d.lo)}, ${f1(d.hi)}]`;
    const blk = aOnly || !bl || !finite(bl.lo) ? '—' : M.kind === 'share' ? `[${f1(bl.lo * 100)}, ${f1(bl.hi * 100)}] pt` : `[${f1(bl.lo)}, ${f1(bl.hi)}]`;
    return [`${tag}${M.label}`, cellTxt(ab.A.m[key], M.kind), aOnly ? `（持續性）${cellTxt(ab.B.m[key], M.kind)}` : cellTxt(ab.B.m[key], M.kind), diff, blk];
  };
  table('ab', ['指標', 'A 無極端恐慌', 'B 極端恐慌', 'B − A（Newcombe／bootstrap）', '年份區塊 bootstrap'],
    [...E.MAIN_KEYS.map(k => row(k, '【主】')), ...E.AUX_KEYS.map(k => row(k, '')), row('panicLater20', ''), row('panicLater60', '')]);
  byId('ab-note').textContent = `${s.label}：A ${ab.A.n}、B ${ab.B.n}。主要指標＝額外跌幅 ≥5%／≥10% 與首次跌破天數；「是否再破底」兩組都約九成，只作輔助。右設限事件不納入各 horizon。`;
}
function renderStrata() {
  const key = byId('strat').value || 'panicSub';
  const rows = setKey === 'r' ? R().rows : setKey === 'g' ? R().reps : R().reps.filter(r => r.volSurge);
  table('strata', ['分層', 'n', '20 日額外跌 ≥5%', '60 日額外跌 ≥10%', '60 日額外跌幅 中位', '60 日再破底', '60 日報酬 中位', '60 日 MAE 中位'],
    E.stratify(rows, key).map(x => [x.bucket, `${x.n}`, `${p0(x.m.deep5_20.value)}（${x.m.deep5_20.count ?? 0}/${x.m.deep5_20.n}）`, `${p0(x.m.deep10_60.value)}（${x.m.deep10_60.count ?? 0}/${x.m.deep10_60.n}）`, f1(x.m.extra60.value), `${p0(x.m.rebreak60.value)}（${x.m.rebreak60.n}）`, f1(x.m.ret60.value), f1(x.m.mae60.value)]));
}
let matchCache = null;
function renderMatch() {
  const main = res.byThr[C.main];
  if (!matchCache) matchCache = E.matchEvents(main.rows.filter(r => r.date >= C.focus.from && r.date <= C.focus.to), main.rows, C);
  const sel = byId('target');
  if (!sel.options.length) sel.replaceChildren(...matchCache.map((m, k) => { const o = node('option', `${m.target.date}（${m.target.panicSub}｜盤中 ${f1(m.target.dropLow)}%${m.target.complete ? '' : '｜右設限'}）`, { value: String(k) }); return o; }));
  const m = matchCache[+sel.value || 0];
  if (!m) { table('match', ['—'], []); return; }
  const a = m.rankOf('2022-01-05');
  table('match', ['名次', '歷史事件', '距離', '分類', '事前回撤', '距 150MA', '150MA 斜率', 'RVOL', 'VIX H', 'F&G', '前 60 日恐慌', '60 日額外跌幅', '60 日總回撤', '60 日報酬', '之後極端恐慌'],
    [...m.neighbors.map((x, k) => { const r = x.r; return [`${k + 1}`, r.date, x.d.toFixed(2), subOf(r), f1(r.eventDD), f1(r.ma[150].dist), f1(r.slope150), finite(r.volRatio) ? r.volRatio.toFixed(2) : '—', `${r.vixHigh}`, `${r.fg ?? '缺'}`, r.priorPanic === null ? '—' : r.priorPanic ? '是' : '否', f1(r.h[60]?.extra), f1(r.h[60]?.totalDD), f1(r.h[60]?.retOpen), r.post?.panicDays != null ? `+${r.post.panicDays} 日` : '無']; }),
      ['目標', m.target.date, '—', subOf(m.target), f1(m.target.eventDD), f1(m.target.ma[150].dist), f1(m.target.slope150), finite(m.target.volRatio) ? m.target.volRatio.toFixed(2) : '—', `${m.target.vixHigh}`, `${m.target.fg ?? '缺'}`, m.target.priorPanic === null ? '—' : m.target.priorPanic ? '是' : '否', m.target.h[60] ? f1(m.target.h[60].extra) : `右設限（${m.target.avail} 日）`, '—', '—', '—'],
      ['參照', `2022-01-05 群組${a ? `（以 ${a.date} 計）` : ''}`, a ? a.d.toFixed(2) : '—', a ? `第 ${a.rank}/${a.of} 名` : '不在池中', '', '', '', '', '', '', '', '', '', '', '']]);
}
let profCache = null;
function renderProfiles() {
  if (!profCache) profCache = E.PERIODS.map(p => ({ ...p, prof: E.periodProfile(res.F, p.from, p.to, res.runs) }));
  table('profiles', ['區間', '交易日', '區間報酬', '最大回撤（252 日高）', '收盤 < 150MA', '150MA 斜率', '觸 300MA 日', 'VIX H 最高／≥30 日', 'F&G 最低／中位', '−3% 事件（A/B）', '−2% 事件（A/B）', '60 日新低收盤'],
    profCache.map(({ label, prof: p }) => [label, `${p.days}`, f1(p.ret), f1(p.maxDD252), p0(p.belowMa150), f1(p.ma150Slope), `${p.touch300}`, `${p.vixHMax ?? '—'}／${p.vixPanicDays}`, `${p.fgMin ?? '—'}／${f1(p.fgMedian)}`, `${p.events[-3].raw}（${p.events[-3].A}/${p.events[-3].B}）`, `${p.events[-2].raw}（${p.events[-2].A}/${p.events[-2].B}）`, `${p.newLow60}`]));
  const sel = byId('period');
  if (!sel.options.length) { sel.replaceChildren(...E.PERIODS.map(p => node('option', p.label, { value: p.id }))); sel.value = '2026-06~10'; }
  renderPeriodEvents();
}
function renderPeriodEvents() {
  const p = E.PERIODS.find(x => x.id === byId('period').value) || E.PERIODS[0];
  const rows = res.byThr[-2].rows.filter(r => r.date >= p.from && r.date <= p.to);
  table('period-events', ['日期', '盤中', '跳空', '開盤後', '收盤', 'RVOL', 'VIX H', 'VXN H', 'F&G', '分類', '事前回撤', '20 日額外跌幅', '60 日額外跌幅', '之後極端恐慌', '150MA'],
    rows.map(r => [`${r.date}${r.dropLow <= -3 ? ' ●' : ''}`, f1(r.dropLow), f1(r.gap), f1(r.sessionDrop), f1(r.closeChg), finite(r.volRatio) ? r.volRatio.toFixed(2) : '—', `${r.vixHigh ?? '—'}`, `${r.vxnHigh ?? '—'}`, `${r.fg ?? '缺'}`, subOf(r), f1(r.eventDD),
      r.h[20] ? f1(r.h[20].extra) : '右設限', r.h[60] ? f1(r.h[60].extra) : `右設限（${r.avail} 日）`, r.post?.panicDate ? `${r.post.panicDate}（+${r.post.panicDays}）` : r.complete ? '60 日內無' : '右設限',
      r.ma[150].status === 'above' ? '上方' : r.ma[150].status === 'reclaimed' ? `下方→+${r.ma[150].reclaimDays} 日站回` : r.ma[150].status === 'not_within' ? '下方、60 日未站回' : '下方、右設限']));
}

// ── orchestration ───────────────────────────────────────────────────────
function renderSelection() {
  renderCards(); drawTS(); drawScatter(); drawDist(); drawPath(); renderAB(); renderStrata();
}
function renderAll() {
  try {
    renderSelection(); renderMatch(); renderProfiles();
    byId('status').textContent = `完成。${byId('status').dataset.fgNote || ''}`;
  } catch (e) { byId('status').textContent = '計算失敗：' + e.message; throw e; }
}
function safe(fn) { return (...a) => { try { fn(...a); } catch (e) { byId('status').textContent = '計算失敗：' + e.message; } }; }
function wire() {
  if (!bindOnce(byId('thr'))) return;
  byId('range').replaceChildren(...RANGE_IDS.map(id => node('span', id === 'all' ? '全部' : E.PERIODS.find(p => p.id === id).label, { class: 'chip' + (id === rangeKey ? ' active' : ''), 'data-qp-range': id })));
  chipPicker(byId('thr'), 'qp-thr', safe(v => { thr = +v; renderSelection(); }));
  chipPicker(byId('set'), 'qp-set', safe(v => { setKey = v; renderSelection(); }));
  chipPicker(byId('range'), 'qp-range', safe(v => { rangeKey = v; applyRange(); }));
  chipPicker(byId('metric'), 'qp-metric', safe(v => { metricKey = v; drawDist(); }));
  byId('strat').replaceChildren(...E.STRATA.map(s => node('option', s.label, { value: s.key })));
  byId('strat').value = 'panicSub';
  byId('strat').addEventListener('change', safe(renderStrata));
  byId('target').addEventListener('change', safe(renderMatch));
  byId('period').addEventListener('change', safe(renderPeriodEvents));
  for (const h of document.querySelectorAll('#tab-qqqpanic [data-qp-help]')) h.append(' ', infoButton(HELP[h.dataset.qpHelp], '說明'));
}

export async function activate(context = {}) {
  initInfoPopovers();
  if (res && Date.now() - loadedAt < 300_000) { resize(); return; }
  const fresh = await load(context);
  if (fresh === false) return;
  loadedAt = Date.now(); matchCache = null; profCache = null;
  wire();
  byId('status').textContent = '計算中…';
  renderAll();
}
export function getCharts() { return Object.values(charts).filter(Boolean); }
export function resize() { getCharts().forEach(c => c.resize()); }
export function onThemeChange() {
  if (!res) return;
  return preserveChartState(getCharts, () => { getCharts().forEach(c => c.dispose()); charts = {}; drawTS(); drawScatter(); drawDist(); drawPath(); });
}
