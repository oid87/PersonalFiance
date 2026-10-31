// QQQ 盤中急跌 × 恐慌背離（歷史分析，不是買賣訊號）。
// 規格：圖 1＝QQQ（粉紅）× F&G（橘）雙軸＋事件色帶／Low 標記＋共用時間軸的 VIX/VXN High；
//       圖 2＝事件日 F&G × VIX High 四象限散點。兩圖與事件詳情、清單雙向定位；所有參數真的重算事件集。
// 引擎 js/tabs/qqqpanic_calc.mjs 與 scripts/research/backtest_qqq_panic.mjs 共用；預設參數＝研究正式口徑。
import { isLight, echartsBase, PALETTE, mob } from '../utils/theme.js';
import { requestJSON } from '../utils/data.js';
import { bindOnce, chipPicker } from '../utils/dom.js';
import { preserveChartState } from '../utils/chartLifecycle.js';
import { infoButton, initInfoPopovers } from '../utils/info_popover.js';
import * as E from './qqqpanic_calc.mjs';

const byId = id => document.getElementById('qqqpanic-' + id);
const finite = v => typeof v === 'number' && Number.isFinite(v);
const f1 = v => (finite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(1)}` : 'N/A');
const f2 = v => (finite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(2)}` : 'N/A');
const num = (v, d = 2) => (finite(v) ? v.toFixed(d) : 'N/A');
const p0 = v => (finite(v) ? `${(v * 100).toFixed(0)}%` : 'N/A');
const D = E.DEFAULTS;
const QQQ_COLOR = '#f778ba', FG_COLOR = '#e3b341', VIX_COLOR = '#f0883e', VXN_COLOR = '#8b949e';
const CLS = {
  B: { label: 'B 極端恐慌（T 日）', color: '#ef4444', band: 'rgba(239,68,68,0.22)', symbol: 'triangle' },
  A: { label: 'A 急跌但未極端恐慌', color: '#d4a017', band: 'rgba(227,179,65,0.26)', symbol: 'circle' },
  U: { label: '未分類（缺 F&G）', color: '#8b949e', band: 'rgba(139,148,158,0.25)', symbol: 'rect' },
};
const DEPTH = [
  { key: 'deep10', label: '額外跌 ≥10%', color: '#ef4444', test: x => x.extra <= -10 },
  { key: 'deep5', label: '額外跌 5～10%', color: '#f0883e', test: x => x.extra <= -5 && x.extra > -10 },
  { key: 'shallow', label: '額外跌 <5%', color: '#3fb950', test: x => x.extra > -5 },
];

const HELP = {
  ts: '上方：QQQ 收盤（粉紅，左軸）與 Fear & Greed（橘，右軸 0–100）。事件由盤中 Low 觸發，所以每個事件在 Low 位置畫倒三角；垂直色帶只依 T 日資訊上色：紅＝B、琥珀＝A、灰＝缺 F&G 未分類。之後是否升級成恐慌（A→B）是未來資訊，只在事件詳情顯示，不會回頭改色。F&G 右軸淺色水平帶是「每日 F&G 低於門檻」，不是事件。下方：VIX High（橘）與 VXN High（灰，僅輔助），虛線為門檻。兩格共用時間軸與縮放；全站縮放下限為 1 年。',
  scatter: '每個點＝目前顯示模式下的一個事件日。X＝當日 F&G、Y＝當日 VIX High；虛線為目前門檻，四區：左上雙重恐慌、右上僅 VIX、左下僅 F&G、右下＝A（急跌但未極端恐慌）。顏色＝事後觀察窗內相對事件日 Low 的額外跌幅；灰色空心＝右設限（觀察不足），不代表沒再跌。形狀：圓＝A、三角＝B。F&G 缺值的事件不畫（不捏造座標），另列於下方。可用右上角工具框選，列出框內事件；點選任一點會讓圖 1 跳到該日並開啟詳情。',
  ab: '研究口徑：同門檻的所有事件先以 20 日錨定分群、取每群第一筆，再要求首筆 RVOL20 ≥ 目前門檻（「不限」則不要求）。比例只用完整觀察窗：點估計（件數/n）與 Wilson 95%；B − A 用 Newcombe 95%；中位數用 bootstrap；年份區塊 bootstrap 為敏感度。指標固定看 20／60 日；事後窗選 20 日時 60 日指標為空。',
  dist: 'A0＝當日未極端恐慌、前窗也未曾；A1＝當日未極端恐慌、但前窗曾經；B＝當日極端恐慌。只納入事後窗完整的事件。',
  path: '只作事後描述：A 事件之後是否升級成極端恐慌是未來才知道的資訊，T 日分類不變，不能拿來模擬當天決策。',
  match: '固定研究基準（−3%、預設門檻）。特徵只用 T 日及以前，權重全為 1、事前固定；只從目標日之前、60 日窗完整的事件中找，同群組只留一筆。相似度不是未來發生機率。',
  ma: '固定研究基準。一般跌破＝前一日收盤 ≥ MA、當日收盤 < MA、RVOL20 ≥ 1.5；嚴格首次跌破另要求前 20 日收盤都在 MA 上方。訊號 T 日收盤後才成立；額外跌幅以 Close_T 為基準；各指標獨立。「不要求 RVOL」是敏感度：2022 年初的跌破量能未達 1.5 倍。',
};
const RANGES = [
  { id: '1Y', label: '1Y' }, { id: '5Y', label: '5Y' }, { id: 'MAX', label: 'MAX' },
  { id: '2015-08', label: '2015/8', from: '2015-07-15', to: '2015-10-15' },
  { id: '2016-01', label: '2016/1', from: '2015-12-15', to: '2016-03-15' },
  { id: '2022', label: '2022', from: '2022-01-01', to: '2022-12-31' },
  { id: '2024-08', label: '2024/8', from: '2024-07-01', to: '2024-09-30' },
  { id: '2026-06~10', label: '2026/6–10', from: '2026-06-01', to: '2026-10-30' },
];

const P = { thr: D.main, dropDef: 'low', rvol: D.volSurge, vix: D.vixPanic, fg: D.fgPanic, vxn: D.vxnAux, pre: D.preWin, post: D.postWin, mode: 'all', layer: 'both', volLine: 'high', size: 'rvol', range: 'MAX', metric: 'extra', ma: 150 };
let res = null, loadedAt = 0, charts = {}, cur = null, selected = null, statToken = 0, cache = {};

// ── helpers ─────────────────────────────────────────────────────────────
function node(tag, text, attrs = {}) {
  const el = document.createElement(tag);
  if (text != null) el.textContent = text;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}
function table(host, headers, rows, { onRow, rowKey } = {}) {
  const t = node('table'), thead = node('thead'), htr = node('tr'), body = node('tbody');
  for (const h of headers) htr.append(node('th', h, { scope: 'col' }));
  thead.append(htr);
  if (!rows.length) rows = [['（沒有符合條件的事件）']];
  rows.forEach((row, k) => {
    const tr = node('tr');
    row.forEach((v, i) => tr.append(node(i === 0 ? 'th' : 'td', v ?? 'N/A')));
    if (onRow && rowKey?.[k]) { tr.dataset.date = rowKey[k]; tr.tabIndex = 0; tr.addEventListener('click', () => onRow(rowKey[k])); tr.addEventListener('keydown', e => { if (e.key === 'Enter') onRow(rowKey[k]); }); }
    body.append(tr);
  });
  t.append(thead, body);
  (typeof host === 'string' ? byId(host) : host).replaceChildren(t);
}
function card(title, value, sub) {
  const el = node('article', null, { class: 'ui-card' });
  el.append(node('h4', title), node('div', value, { class: 'qqqpanic-value' }), node('p', sub || '', { class: 'note-muted' }));
  return el;
}
function chart(key, host = byId(key)) {
  if (!charts[key] || charts[key].isDisposed?.()) charts[key] = echarts.init(host, isLight() ? null : 'dark');
  return charts[key];
}
const tip = () => ({ backgroundColor: PALETTE.bg, borderColor: PALETTE.border, textStyle: { color: PALETTE.text, fontSize: 12 }, confine: true });
const H = () => P.post;                                  // 事後觀察窗的 horizon
const hz = r => r.h[H()];
const depthOf = r => (hz(r) ? DEPTH.find(d => d.test(hz(r))) : null);

// ── data / compute ──────────────────────────────────────────────────────
async function load(context = {}) {
  const get = url => requestJSON(url, { signal: context.signal });
  const [q, vix, vxn, fg] = await Promise.all([get('data/QQQ.json'), get('data/VIX.json'), get('data/VXN.json'), get('data/fear_greed.json')]);
  const rows = (p, name) => { if (!Array.isArray(p?.data) || !p.data.length) throw new Error(`${name} 資料格式錯誤或為空`); return p.data; };
  const raw = { QQQ: rows(q, 'QQQ'), VIX: rows(vix, 'VIX'), VXN: rows(vxn, 'VXN'), FG: rows(fg, 'Fear & Greed') };
  if (context.signal?.aborted || context.isCurrent?.() === false) return false;
  res = E.run(raw, D);
  cache = {};
  return true;
}
function compute() {
  const cfg = E.configure({ dropDef: P.dropDef, volSurge: P.rvol, vixPanic: P.vix, fgPanic: P.fg, vxnAux: P.vxn, preWin: P.pre, postWin: P.post });
  const R = E.runThreshold(res.F, P.thr, cfg);
  const passVol = r => P.rvol === 0 || (finite(r.volRatio) && r.volRatio >= P.rvol);
  const rvolRows = R.rows.filter(passVol);
  const rvolGroups = E.groupEvents(rvolRows.map(r => r.idx), cfg.groupWin).length;   // 「符合 RVOL」：先過濾爆量，再分群
  const shown = P.mode === 'all' ? R.rows : P.mode === 'rvol' ? rvolRows : R.reps;      // 「群組首筆」：先以跌幅事件分群，再取首筆
  const stats = R.reps.filter(passVol);                                                  // 研究口徑：先分群取首筆，再要求首筆爆量
  cur = { cfg, R, shown, stats, rvolRows, rvolGroups, byDate: new Map(R.rows.map(r => [r.date, r])), formal: E.isFormal(cfg, P.thr) };
  if (selected && !cur.byDate.has(selected)) selected = null;
}
const clsOf = r => r.panic;
const subOf = r => (r.panic === 'A' ? r.panicSub : r.panic);

// ── summary / exploration banner ────────────────────────────────────────
function renderSummary() {
  const { R, shown, stats, rvolRows, rvolGroups, cfg } = cur, F = res.F;
  const ex = byId('explore');
  if (cur.formal) ex.hidden = true;
  else {
    const diff = [];
    if (P.thr !== D.main) diff.push(`門檻 ${-P.thr}%`);
    if (P.dropDef !== 'low') diff.push(E.DROP_DEFS[P.dropDef].label);
    if (P.rvol !== D.volSurge) diff.push(`RVOL ${P.rvol || '不限'}`);
    if (P.vix !== D.vixPanic) diff.push(`VIX High ≥ ${P.vix}`);
    if (P.fg !== D.fgPanic) diff.push(`F&G < ${P.fg}`);
    if (P.pre !== D.preWin) diff.push(`事前 ${P.pre} 日`);
    if (P.post !== D.postWin) diff.push(`事後 ${P.post} 日`);
    ex.hidden = false;
    ex.textContent = `探索設定：與正式研究基準（盤中 −3%、RVOL20 ≥ 1.5、VIX High ≥ 30 或 F&G < 15、事前／事後 60 日）不同（${diff.join('、')}）。以下數字不等同研究報告。`;
  }
  const complete = shown.filter(r => r.complete), cens = shown.length - complete.length;
  const cnt = k => shown.filter(r => r.panic === k).length;
  const share = (rows, h, key) => { const v = rows.filter(r => r.h[h]); const k = v.filter(r => r.h[h][key]).length; return v.length ? `${k}/${v.length}（${p0(k / v.length)}）` : 'N/A'; };
  const modeLabel = { all: '所有事件（未去重）', rvol: `符合 RVOL ≥ ${P.rvol || '不限'}：先過濾爆量、再分群`, first: '20 日群組首筆：先以跌幅事件分群、再取首筆' }[P.mode];
  const last = F.endIdx;
  byId('summary').replaceChildren(
    card('目前顯示事件', `${shown.length}`, `${modeLabel}｜A ${cnt('A')}／B ${cnt('B')}／未分類 ${cnt('U')}`),
    card('觀察窗', `完整 ${complete.length}｜右設限 ${cens}`, `事後 ${P.post} 日；右設限事件不納入完整期比例`),
    card(`事後 ${H()} 日額外跌幅`, `≥5%：${share(shown, H(), 'deep5')}`, `≥10%：${share(shown, H(), 'deep10')}（只算完整窗）${H() !== 20 ? `｜20 日 ≥5%：${share(shown, 20, 'deep5')}` : ''}`),
    card('樣本數對照', `${R.rows.length} 筆`, `未去重 ${R.rows.length}｜20 日群組 ${R.groups.length}｜符合 RVOL ${rvolRows.length} 筆 → ${rvolGroups} 群｜研究口徑 ${stats.length} 群`),
    card(`最新 ${F.date[last]}`, `${F.c[last].toFixed(2)}`, `距 150MA ${f1((F.c[last] / F.ma[150][last] - 1) * 100)}%｜VIX H ${num(F.vixH[last])}｜F&G ${num(F.fg[last])}`),
  );
  const fgMiss = []; for (let i = F.startIdx; i <= F.endIdx; i++) if (F.fg[i] === null) fgMiss.push(F.date[i]);
  byId('asof').textContent = `資料 ${F.date[F.startIdx]} ～ ${F.date[F.endIdx]}；事件定義：${E.DROP_DEFS[P.dropDef].label} ≤ −${-P.thr}%。F&G 缺 ${fgMiss.length} 個交易日（${fgMiss[0] ?? ''}～${fgMiss.at(-1) ?? ''}），顯示 N/A、不補值。`;
}

// ── 圖 1：時間序列 ──────────────────────────────────────────────────────
function eventTooltip(r) {
  const m = p => (r.ma[p] ? `${f1(r.ma[p].dist)}%` : 'N/A');
  return [`<b style="color:${CLS[clsOf(r)].color}">● ${r.date} 急跌事件（${subOf(r)}${r.vxnAux ? '｜VXN 輔助 ≥ ' + P.vxn : ''}）</b>`,
    `O ${num(r.open)}　H ${num(r.high)}　L ${num(r.low)}　C ${num(r.close)}｜昨收 ${num(r.prevClose)}`,
    `盤中最低 ${f2(r.dropLow)}%｜日內振幅 ${f2(r.hlRange)}%｜跳空 ${f2(r.gap)}%｜收盤 ${f2(r.closeChg)}%｜RVOL20 ${num(r.volRatio)}`,
    `VIX H/C ${num(r.vixHigh)}/${num(r.vixClose)}｜VXN H/C ${num(r.vxnHigh)}/${num(r.vxnClose)}｜F&G ${num(r.fg)}`,
    `距 125/150/300MA ${m(125)}／${m(150)}／${m(300)}｜事前 ${P.pre} 日高點回撤 ${f1(r.eventDD)}%`,
    `完整觀察 ${r.avail}／${P.post} 日${r.complete ? '' : '（右設限）'}｜點選看詳情`].join('<br>');
}
function drawTS() {
  const F = res.F, i0 = Math.max(0, F.startIdx - 40), i1 = F.endIdx, idx = [];
  for (let i = i0; i <= i1; i++) idx.push(i);
  const dates = idx.map(i => F.date[i]), pos = new Map(dates.map((d, k) => [d, k]));
  const shown = cur.shown, evAt = new Map(shown.map(r => [r.date, r]));
  const L = mob() ? 46 : 60, R = mob() ? 40 : 56;
  const axis = (g, show) => ({ type: 'category', gridIndex: g, data: dates, boundaryGap: false, axisLine: { lineStyle: { color: PALETTE.muted } }, axisLabel: { color: PALETTE.muted, fontSize: 11, show }, axisTick: { show: false }, splitLine: { show: false } });
  const showBand = P.layer !== 'mark', showMark = P.layer !== 'band';
  const bands = showBand ? shown.map(r => { const k = pos.get(r.date); return [{ xAxis: r.date, itemStyle: { color: CLS[clsOf(r)].band } }, { xAxis: dates[Math.min(k + 1, dates.length - 1)] }]; }) : [];
  const marks = cls => (showMark ? shown.filter(r => clsOf(r) === cls).map(r => ({ value: [r.date, r.low], date: r.date, itemStyle: r.vxnAux ? { borderColor: '#a371f7', borderWidth: 2 } : undefined })) : []);
  const sel = selected && evAt.has(selected) ? cur.byDate.get(selected) : null;
  const thrLine = (y, color, label) => ({ silent: true, symbol: 'none', lineStyle: { type: 'dashed', color }, label: { color, fontSize: 10, formatter: label }, data: [{ yAxis: y }] });
  const series = [
    { id: 'qqq', name: 'QQQ 收盤', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: idx.map(i => F.c[i]), showSymbol: false, lineStyle: { width: 1.5, color: QQQ_COLOR }, itemStyle: { color: QQQ_COLOR }, z: 3,
      markArea: { silent: false, data: bands } },
    { id: 'fg', name: 'Fear & Greed', type: 'line', xAxisIndex: 0, yAxisIndex: 1, data: idx.map(i => F.fg[i]), showSymbol: false, connectNulls: false, lineStyle: { width: 1.2, color: FG_COLOR }, itemStyle: { color: FG_COLOR }, z: 2,
      markArea: { silent: true, itemStyle: { color: 'rgba(227,179,65,0.08)' }, data: [[{ yAxis: 0 }, { yAxis: P.fg }]] } },
    ...['B', 'A', 'U'].map(c => ({ id: 'mark' + c, name: CLS[c].label, type: 'scatter', xAxisIndex: 0, yAxisIndex: 0, data: marks(c), symbol: 'triangle', symbolRotate: 180, symbolSize: 9, itemStyle: { color: CLS[c].color }, z: 5 })),
    { id: 'sel', name: '選取事件', type: 'scatter', xAxisIndex: 0, yAxisIndex: 0, data: sel ? [{ value: [sel.date, sel.low], date: sel.date }] : [], symbolSize: 22, itemStyle: { color: 'transparent', borderColor: PALETTE.text, borderWidth: 2 }, z: 6,
      markLine: sel ? { silent: true, symbol: 'none', lineStyle: { color: PALETTE.text, type: 'solid', width: 1 }, label: { formatter: sel.date, color: PALETTE.text, fontSize: 10 }, data: [{ xAxis: sel.date }] } : { data: [] } },
    { id: 'period', name: '__period', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: [], silent: true, markArea: { data: [] } },
    { id: 'vixH', name: 'VIX High', type: 'line', xAxisIndex: 1, yAxisIndex: 2, data: idx.map(i => F.vixH[i]), showSymbol: false, lineStyle: { width: 1, color: VIX_COLOR }, itemStyle: { color: VIX_COLOR }, markLine: thrLine(P.vix, VIX_COLOR, `VIX ${P.vix}`) },
    { id: 'vxnH', name: 'VXN High（輔助）', type: 'line', xAxisIndex: 1, yAxisIndex: 2, data: idx.map(i => F.vxnH[i]), showSymbol: false, lineStyle: { width: 1, color: VXN_COLOR, type: 'dotted' }, itemStyle: { color: VXN_COLOR }, markLine: thrLine(P.vxn, VXN_COLOR, `VXN ${P.vxn}`) },
  ];
  if (P.volLine === 'both') series.push(
    { id: 'vixC', name: 'VIX Close', type: 'line', xAxisIndex: 1, yAxisIndex: 2, data: idx.map(i => F.vixC[i]), showSymbol: false, lineStyle: { width: 1, color: VIX_COLOR, opacity: 0.5 }, itemStyle: { color: VIX_COLOR } },
    { id: 'vxnC', name: 'VXN Close', type: 'line', xAxisIndex: 1, yAxisIndex: 2, data: idx.map(i => F.vxnC[i]), showSymbol: false, lineStyle: { width: 1, color: VXN_COLOR, opacity: 0.5 }, itemStyle: { color: VXN_COLOR } });
  const option = echartsBase({
    animation: false,
    legend: { top: 0, type: 'scroll', textStyle: { color: PALETTE.muted, fontSize: 11 }, data: series.filter(s => !s.name.startsWith('__') && s.id !== 'sel').map(s => s.name) },
    tooltip: {
      ...tip(), trigger: 'axis', axisPointer: { type: 'cross' },
      formatter(params) {
        const k = params?.[0]?.dataIndex; if (k == null) return '';
        const i = idx[k], r = evAt.get(F.date[i]);
        const base = `<b>${F.date[i]}</b>｜QQQ ${num(F.c[i])}｜F&G ${num(F.fg[i])}｜VIX H/C ${num(F.vixH[i])}/${num(F.vixC[i])}｜VXN H/C ${num(F.vxnH[i])}/${num(F.vxnC[i])}`;
        return r ? base + '<br>' + eventTooltip(r) : base;
      },
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: [{ left: L, right: R, top: 36, height: '56%' }, { left: L, right: R, top: '70%', height: '18%' }],
    xAxis: [axis(0, false), axis(1, true)],
    yAxis: [
      { type: 'value', gridIndex: 0, scale: true, name: 'QQQ', nameTextStyle: { color: QQQ_COLOR, fontSize: 10 }, axisLabel: { color: PALETTE.muted, fontSize: 10 }, splitLine: { lineStyle: { color: PALETTE.grid } }, axisLine: { show: true, lineStyle: { color: QQQ_COLOR } } },
      { type: 'value', gridIndex: 0, min: 0, max: 100, position: 'right', name: 'F&G', nameTextStyle: { color: FG_COLOR, fontSize: 10 }, axisLabel: { color: PALETTE.muted, fontSize: 10 }, splitLine: { show: false }, axisLine: { show: true, lineStyle: { color: FG_COLOR } } },
      { type: 'value', gridIndex: 1, scale: true, name: 'VIX/VXN', nameTextStyle: { color: PALETTE.muted, fontSize: 10 }, axisLabel: { color: PALETTE.muted, fontSize: 10 }, splitLine: { lineStyle: { color: PALETTE.grid } } },
    ],
    dataZoom: [{ type: 'inside', xAxisIndex: [0, 1], filterMode: 'filter' }, { type: 'slider', xAxisIndex: [0, 1], height: 18, bottom: 4, filterMode: 'filter' }],
    series,
  });
  const ch = chart('ts');
  const prevZoom = ch.getOption?.()?.dataZoom?.[0];
  ch.setOption(option, { notMerge: true });
  if (!ch.__qpWired) {
    ch.__qpWired = true;
    ch.on('click', p => { const d = p.data?.date ?? (p.componentType === 'markArea' ? p.data?.coord?.[0]?.[0] ?? p.data?.xAxis : null); if (d && cur.byDate.has(d)) selectEvent(d, { from: 'ts' }); });
  }
  if (prevZoom && finite(prevZoom.start) && !cache.rangeDirty) ch.dispatchAction({ type: 'dataZoom', start: prevZoom.start, end: prevZoom.end });
  else applyRange();
}
function applyRange() {
  const ch = charts.ts; if (!ch) return;
  cache.rangeDirty = false;
  const F = res.F, first = F.date[Math.max(0, F.startIdx - 40)], lastD = F.date[F.endIdx];
  const R = RANGES.find(r => r.id === P.range);
  let from = first, to = lastD, band = null;
  if (P.range === 'custom') { from = byId('from').value || first; to = byId('to').value || lastD; band = [from, to, '自選區間']; }
  else if (R?.from) { from = R.from; to = R.to; band = [R.from, R.to, R.label]; }
  else if (P.range === '1Y' || P.range === '5Y') { const d = new Date(lastD); d.setFullYear(d.getFullYear() - (P.range === '1Y' ? 1 : 5)); from = d.toISOString().slice(0, 10); }
  const snap = (d, up) => { let best = null; for (let i = Math.max(0, F.startIdx - 40); i <= F.endIdx; i++) { if (up ? F.date[i] >= d : F.date[i] <= d) { best = F.date[i]; if (up) break; } } return best ?? (up ? lastD : first); };
  const sv = snap(from, true), ev = snap(to, false);
  // 全站 zoom 下限 1 年（js/utils/zoomFloor.js）：短區間會被放寬，所以另以底色標出所選區間
  ch.setOption({ series: [{ id: 'period', markArea: band ? { silent: true, itemStyle: { color: 'rgba(88,166,255,0.08)' }, label: { show: true, position: 'insideTop', color: PALETTE.muted, fontSize: 10 }, data: [[{ xAxis: sv, name: band[2] }, { xAxis: ev }]] } : { data: [] } }] });
  ch.dispatchAction({ type: 'dataZoom', startValue: sv, endValue: ev });
}

// ── 圖 2：F&G × VIX High ────────────────────────────────────────────────
function drawScatter() {
  const all = cur.shown, plotted = all.filter(r => finite(r.fg) && finite(r.vixHigh)), missing = all.filter(r => !finite(r.fg));
  const yMax = Math.ceil(Math.max(45, P.vix + 10, ...plotted.map(r => r.vixHigh)) / 5) * 5;
  const size = r => (P.size === 'fixed' ? 10 : Math.max(6, Math.min(22, 4 + 6 * Math.sqrt(Math.max(0.1, r.volRatio || 1)))));
  const item = r => ({ value: [r.fg, r.vixHigh], date: r.date, symbol: CLS[clsOf(r)].symbol, symbolSize: size(r),
    label: r.date >= '2026-01-01' ? { show: true, formatter: r.date.slice(2), color: PALETTE.text, fontSize: 10, position: 'right' } : undefined });
  const zone = (x0, y0, x1, y1, name, color) => [{ xAxis: x0, yAxis: y0, name, itemStyle: { color } }, { xAxis: x1, yAxis: y1 }];
  const sel = selected ? plotted.find(r => r.date === selected) : null;
  const series = [
    ...DEPTH.map((d, k) => ({ id: d.key, name: `${d.label}（事後 ${H()} 日）`, type: 'scatter', data: plotted.filter(r => hz(r) && d.test(hz(r))).map(item), itemStyle: { color: d.color, opacity: 0.85 },
      ...(k === 0 ? { markArea: { silent: true, label: { color: PALETTE.muted, fontSize: 11, position: 'insideTopLeft' }, data: [
        zone(0, P.vix, P.fg, yMax, '雙重恐慌', 'rgba(239,68,68,0.10)'), zone(P.fg, P.vix, 100, yMax, '僅 VIX 恐慌', 'rgba(239,68,68,0.06)'),
        zone(0, 10, P.fg, P.vix, '僅 F&G 恐慌', 'rgba(239,68,68,0.06)'), zone(P.fg, 10, 100, P.vix, 'A：急跌但未極端恐慌', 'rgba(227,179,65,0.06)')] },
      markLine: { silent: true, symbol: 'none', lineStyle: { type: 'dashed', color: PALETTE.muted }, label: { color: PALETTE.muted, fontSize: 10 }, data: [{ xAxis: P.fg, label: { formatter: `F&G ${P.fg}` } }, { yAxis: P.vix, label: { formatter: `VIX ${P.vix}`, position: 'insideEndTop' } }] } } : {}),
    })),
    { id: 'cens', name: '右設限／觀察不足', type: 'scatter', data: plotted.filter(r => !hz(r)).map(item), itemStyle: { color: 'transparent', borderColor: '#8b949e', borderWidth: 1.5 } },
    { id: 'sel', name: '選取事件', type: 'scatter', data: sel ? [{ value: [sel.fg, sel.vixHigh], date: sel.date }] : [], symbolSize: 28, itemStyle: { color: 'transparent', borderColor: PALETTE.text, borderWidth: 2 }, z: 10, silent: true },
  ];
  const option = echartsBase({
    animation: false,
    legend: { top: 0, textStyle: { color: PALETTE.muted, fontSize: 11 }, data: series.filter(s => s.id !== 'sel').map(s => s.name) },
    tooltip: { ...tip(), trigger: 'item', formatter: p => { const r = cur.byDate.get(p.data?.date); if (!r) return ''; const x = hz(r); return eventTooltip(r) + (x ? `<br>事後 ${H()} 日：額外跌幅 ${f1(x.extra)}%、${x.rebreak ? '有' : '未'}再破 Low_T、報酬 ${f1(x.retOpen)}%` : `<br>事後 ${H()} 日：右設限（已觀察 ${r.avail} 日），結果未知`); } },
    toolbox: { right: 8, top: 22, feature: { brush: { type: ['rect', 'clear'], title: { rect: '框選事件', clear: '清除框選' } } }, iconStyle: { borderColor: PALETTE.muted } },
    brush: { toolbox: ['rect', 'clear'], xAxisIndex: 0, seriesIndex: [0, 1, 2, 3], throttleType: 'debounce', throttleDelay: 200 },
    grid: { left: mob() ? 44 : 56, right: 24, top: 56, bottom: 48 },
    xAxis: { type: 'value', name: 'Fear & Greed（事件日）', nameLocation: 'middle', nameGap: 28, min: 0, max: 100, nameTextStyle: { color: PALETTE.muted } },
    yAxis: { type: 'value', name: 'VIX High（事件日）', min: 10, max: yMax, nameTextStyle: { color: PALETTE.muted } },
    dataZoom: [],
    series,
  });
  const ch = chart('scatter');
  ch.setOption(option, { notMerge: true });
  if (!ch.__qpWired) {
    ch.__qpWired = true;
    ch.on('click', p => { const d = p.data?.date; if (d) selectEvent(d, { from: 'scatter' }); });
    ch.on('brushSelected', e => renderBrush(e));
  }
  const inA = plotted.filter(r => r.panic === 'A').length, inB = plotted.filter(r => r.panic === 'B').length, cens = plotted.filter(r => !hz(r)).length;
  const done = plotted.filter(r => r.h[H()]), done20 = plotted.filter(r => r.h[20]);
  const c = (rows, h, k) => rows.filter(r => r.h[h][k]).length;
  byId('scatter-note').textContent = `圖中 ${plotted.length} 點（A ${inA}／B ${inB}；右設限 ${cens}）。可計算樣本：20 日 ${done20.length}（≥5% ${c(done20, 20, 'deep5')}、≥10% ${c(done20, 20, 'deep10')}）；${H()} 日 ${done.length}（≥5% ${c(done, H(), 'deep5')}、≥10% ${c(done, H(), 'deep10')}）。形狀：圓＝A、三角＝B；紫框（圖 1）＝VXN High ≥ ${P.vxn}，僅輔助。`
    + (missing.length ? ` 缺 F&G 不畫：${missing.length} 件（${missing.map(r => `${r.date} ${r.panic === 'B' ? 'B（VIX High ≥ ' + P.vix + '）' : '未分類'}`).join('、')}）。` : ' 目前沒有缺 F&G 的事件。');
}
function renderBrush(e) {
  const ch = charts.scatter; if (!ch) return;
  const opt = ch.getOption(), picked = [];
  for (const b of e.batch || []) for (const s of b.selected || []) {
    const ser = opt.series[s.seriesIndex]; if (!ser || ser.id === 'sel') continue;
    for (const k of s.dataIndex) { const d = ser.data[k]?.date; const r = cur.byDate.get(d); if (r) picked.push(r); }
  }
  if (!picked.length) { byId('brush').replaceChildren(); return; }
  picked.sort((a, b) => (a.date < b.date ? -1 : 1));
  table('brush', ['框選事件', '分類', '盤中', 'RVOL', 'VIX H', 'F&G', `事後 ${H()} 日額外跌幅`], picked.map(r => [r.date, subOf(r), f2(r.dropLow), num(r.volRatio), num(r.vixHigh), num(r.fg), hz(r) ? f1(hz(r).extra) : '右設限']), { onRow: d => selectEvent(d, { from: 'list' }), rowKey: picked.map(r => r.date) });
}

// ── 事件詳情 ────────────────────────────────────────────────────────────
function selectEvent(date, { from } = {}) {
  selected = date;
  renderDetail();
  drawScatterSelection(); drawTSSelection();
  if (from !== 'ts') {   // 主圖跳到該日期（全站縮放下限仍為 1 年）
    const F = res.F, i = F.index.get(date);
    if (charts.ts && i != null) charts.ts.dispatchAction({ type: 'dataZoom', startValue: F.date[Math.max(F.startIdx - 40, i - 130)], endValue: F.date[Math.min(F.endIdx, i + 130)] });
  }
  for (const tr of document.querySelectorAll('#tab-qqqpanic tr.qqqpanic-sel')) tr.classList.remove('qqqpanic-sel');
  for (const tr of document.querySelectorAll(`#tab-qqqpanic tr[data-date="${date}"]`)) tr.classList.add('qqqpanic-sel');
}
function drawTSSelection() {
  const ch = charts.ts, r = selected && cur.byDate.get(selected); if (!ch) return;
  ch.setOption({ series: [{ id: 'sel', data: r ? [{ value: [r.date, r.low], date: r.date }] : [], markLine: r ? { silent: true, symbol: 'none', lineStyle: { color: PALETTE.text, width: 1 }, label: { formatter: r.date, color: PALETTE.text, fontSize: 10 }, data: [{ xAxis: r.date }] } : { data: [] } }] });
}
function drawScatterSelection() {
  const ch = charts.scatter, r = selected && cur.byDate.get(selected); if (!ch) return;
  ch.setOption({ series: [{ id: 'sel', data: r && finite(r.fg) ? [{ value: [r.fg, r.vixHigh], date: r.date }] : [] }] });
}
function renderDetail() {
  const host = byId('detail'), r = selected && cur.byDate.get(selected);
  if (!r) { host.replaceChildren(node('h3', '事件詳情'), node('p', '點選圖 1 的事件標記／色帶、圖 2 的點，或下方事件清單任一列。', { class: 'note-muted' })); return; }
  const kv = (k, v) => { const d = node('div'); d.append(node('span', k + '：', { class: 'note-muted' }), node('span', v)); return d; };
  const grid = node('div', null, { class: 'qqqpanic-detail-grid' });
  const ma = p => (r.ma[p]?.value ? `${f1(r.ma[p].dist)}%（${{ above: '在上方', reclaimed: `下方→+${r.ma[p].reclaimDays} 日站回`, not_within: `下方、${P.post} 日內未站回`, censored: '下方、右設限', unavailable: 'N/A' }[r.ma[p].status] ?? r.ma[p].status}）` : 'N/A');
  grid.append(
    kv('日期', `${r.date}（${r.groupId}，群內第 ${r.groupRank} 筆）`), kv('分類（T 日）', `${subOf(r)}｜${{ none: '未觸及門檻', 'VIX only': '僅 VIX', 'FG only': '僅 F&G', 'VIX+FG': 'VIX＋F&G', missing: '缺 F&G' }[r.panicDetail] ?? r.panicDetail}${r.vxnAux ? `｜VXN High ≥ ${P.vxn}（輔助）` : ''}`),
    kv('OHLC', `${num(r.open)} / ${num(r.high)} / ${num(r.low)} / ${num(r.close)}`), kv('昨收／成交量', `${num(r.prevClose)}／${finite(r.volume) ? r.volume.toLocaleString() : 'N/A'}`),
    kv('盤中最低跌幅', `${f2(r.dropLow)}%`), kv('跳空／開盤後', `${f2(r.gap)}%／${f2(r.sessionDrop)}%`),
    kv('日內振幅（不代表先高後低）', `${f2(r.hlRange)}%`), kv('收盤漲跌', `${f2(r.closeChg)}%`),
    kv('RVOL20', `${num(r.volRatio)}（前 252 日百分位 ${num(r.rvolPct, 0)}）`), kv('VIX High／Close', `${num(r.vixHigh)}／${num(r.vixClose)}`),
    kv('VXN High／Close', `${num(r.vxnHigh)}／${num(r.vxnClose)}`), kv('Fear & Greed', num(r.fg)),
    kv('距 125MA', ma(125)), kv('距 150MA', ma(150)), kv('距 300MA', ma(300)),
    kv(`事前 ${P.pre} 日最高 High`, `${num(r.preHigh)}（${r.preHighDate ?? 'N/A'}）`), kv('事件日 Low／波段回撤', `${num(r.low)}／${f1(r.eventDD)}%`),
    kv(`前 ${P.pre} 日極端恐慌`, r.priorPanic === null ? 'N/A' : r.priorPanic ? '曾經（A1 條件）' : '未曾（A0 條件）'),
    kv('完整觀察日數', `${r.avail}／${P.post}${r.complete ? '' : '（右設限：未來結果未知）'}`),
  );
  const rows = E.configure({ postWin: P.post }).horizons.map(h => {
    const x = r.h[h];
    return x ? [`T+${h}`, `${num(x.minLow)}（${x.minLowDate}）`, `${f1(x.extra)}%`, x.rebreak ? '是' : '否', x.deep5 ? '是' : '否', x.deep10 ? '是' : '否', `${f1(x.retOpen)}%`, `${f1(x.retClose)}%`, `${f1(x.maeOpen)}%`]
      : [`T+${h}`, '右設限', '—', '—', '—', '—', '—', '—', '—'];
  });
  const tblHost = node('div', null, { class: 'table-scroll' });
  table(tblHost, ['觀察窗', '未來最低 Low', '額外跌幅', '再破 Low_T', '≥5%', '≥10%', '報酬（T+1 開）', '報酬（T 收）', 'MAE（T+1 開）'], rows);
  const after = r.panic === 'A' ? `事後路徑（未來資訊，不影響 T 日分類）：${r.path}${r.post?.panicDate ? `，首次極端恐慌 ${r.post.panicDate}（+${r.post.panicDays} 日）` : ''}；首次再破 Low_T：${r.firstRebreakDate ?? (r.complete ? '窗內未發生' : '尚未發生（右設限）')}`
    : `首次再破 Low_T：${r.firstRebreakDate ?? (r.complete ? '窗內未發生' : '尚未發生（右設限）')}`;
  const mini = node('div', null, { class: 'qqqpanic-mini', role: 'img', 'aria-label': `${r.date} 前 ${P.pre} 日至後 ${P.post} 日的 QQQ 走勢` });
  host.replaceChildren(node('h3', `事件詳情：${r.date}`), grid, tblHost, node('p', after, { class: 'note-muted' }), mini);
  drawMini(mini, r);
}
function drawMini(el, r) {
  const F = res.F, i = r.idx, a = Math.max(0, i - P.pre), b = i + r.avail;
  const dates = [], close = [], low = [];
  for (let k = a; k <= b; k++) { dates.push(F.date[k]); close.push(F.c[k]); low.push(F.l[k]); }
  const missing = P.post - r.avail;
  for (let k = 1; k <= missing; k++) { dates.push(`T+${r.avail + k}`); close.push(null); low.push(null); }
  charts.mini?.dispose?.();
  charts.mini = echarts.init(el, isLight() ? null : 'dark');
  charts.mini.setOption(echartsBase({
    animation: false,
    legend: { top: 0, textStyle: { color: PALETTE.muted, fontSize: 11 } },
    tooltip: { ...tip(), trigger: 'axis' },
    grid: { left: 52, right: 16, top: 30, bottom: 30 },
    xAxis: { type: 'category', data: dates, boundaryGap: false, axisLabel: { color: PALETTE.muted, fontSize: 10 } },
    yAxis: { type: 'value', scale: true, axisLabel: { color: PALETTE.muted, fontSize: 10 } },
    dataZoom: [],
    series: [
      { name: 'QQQ 收盤', type: 'line', data: close, showSymbol: false, lineStyle: { color: QQQ_COLOR, width: 1.5 }, itemStyle: { color: QQQ_COLOR },
        markLine: { silent: true, symbol: 'none', label: { fontSize: 10, color: PALETTE.muted }, data: [
          { xAxis: r.date, lineStyle: { color: PALETTE.text }, label: { formatter: 'T' } },
          ...(finite(r.preHigh) ? [{ yAxis: r.preHigh, lineStyle: { color: '#3fb950', type: 'dashed' }, label: { formatter: `事前高 ${r.preHigh}` } }] : []),
          { yAxis: r.low, lineStyle: { color: '#ef4444', type: 'dashed' }, label: { formatter: `Low_T ${r.low}` } }] },
        markArea: { silent: true, data: [
          [{ xAxis: dates[0], name: `T−${i - a}～T−1`, itemStyle: { color: 'rgba(139,148,158,0.08)' } }, { xAxis: r.date }],
          ...(missing > 0 ? [[{ xAxis: dates[dates.length - missing], name: `觀察期不足（已觀察 ${r.avail}／${P.post} 日）`, itemStyle: { color: 'rgba(139,148,158,0.18)' }, label: { color: PALETTE.text, fontSize: 11, position: 'inside' } }, { xAxis: dates.at(-1) }]] : [])] } },
      { name: '每日 Low', type: 'line', data: low, showSymbol: false, lineStyle: { color: '#ef4444', width: 1, type: 'dotted' }, itemStyle: { color: '#ef4444' } },
    ],
  }), { notMerge: true });
}

// ── 事件清單／CSV ───────────────────────────────────────────────────────
function renderList() {
  const rows = cur.shown;
  table('list', ['日期', '分類', '群組', '盤中', '收盤', 'RVOL', 'VIX H/C', 'VXN H/C', 'F&G', '距 150MA', '事前回撤', `事後 ${H()} 日額外跌幅`, '觀察日數'],
    rows.map(r => [r.date, subOf(r) + (r.vxnAux ? '＊' : ''), `${r.groupId}${r.isRep ? '（首）' : ''}`, f2(r.dropLow), f2(r.closeChg), num(r.volRatio), `${num(r.vixHigh)}/${num(r.vixClose)}`, `${num(r.vxnHigh)}/${num(r.vxnClose)}`, num(r.fg), f1(r.ma[150]?.dist), f1(r.eventDD),
      hz(r) ? f1(hz(r).extra) : '右設限', `${r.avail}${r.complete ? '' : '（右設限）'}`]), { onRow: d => selectEvent(d, { from: 'list' }), rowKey: rows.map(r => r.date) });
  if (selected) for (const tr of document.querySelectorAll(`#qqqpanic-list tr[data-date="${selected}"]`)) tr.classList.add('qqqpanic-sel');
}
function exportCSV() {
  const h = H(), cols = ['event_date', 'prev_close', 'open', 'high', 'low', 'close', 'volume', 'rvol20', 'drop_pct', 'gap_pct', 'session_drop_pct', 'intraday_range_pct', 'close_chg_pct', 'vix_high', 'vix_close', 'vxn_high', 'vxn_close', 'fg', 'category', 'category_sub', 'vxn_aux',
    'group_id', 'is_group_first', 'pre_high', 'event_drawdown_pct', 'ma150_dist_pct', 'future_coverage_days', 'censored', `extra_drop_${h}_pct`, `deep5_${h}`, `deep10_${h}`, `rebreak_${h}`, `ret_${h}_open_pct`, 'params'];
  const v = x => (x === null || x === undefined ? '' : typeof x === 'boolean' ? (x ? 1 : 0) : typeof x === 'number' ? +x.toFixed(4) : x);
  const params = `thr=${P.thr};def=${P.dropDef};rvol=${P.rvol};vix=${P.vix};fg=${P.fg};vxn=${P.vxn};pre=${P.pre};post=${P.post};mode=${P.mode}`;
  const lines = [cols.join(','), ...cur.shown.map(r => { const x = r.h[h]; return [r.date, r.prevClose, r.open, r.high, r.low, r.close, r.volume, r.volRatio, E.DROP_DEFS[P.dropDef].fn(res.F, r.idx), r.gap, r.sessionDrop, r.hlRange, r.closeChg, r.vixHigh, r.vixClose, r.vxnHigh, r.vxnClose, r.fg, r.panic, subOf(r), r.vxnAux,
    r.groupId, r.isRep, r.preHigh, r.eventDD, r.ma[150]?.dist, r.avail, !r.complete, x?.extra, x?.deep5, x?.deep10, x?.rebreak, x?.retOpen, params].map(v).map(s => (/[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : s)).join(','); })];
  const blob = new Blob(['﻿' + lines.join('\n') + '\n'], { type: 'text/csv;charset=utf-8' }), a = node('a', null, { href: URL.createObjectURL(blob), download: `qqq-panic-events_${P.thr}_${P.mode}.csv` });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ── 統計（延後計算：bootstrap 較慢）──────────────────────────────────────
function cellTxt(o, kind) {
  if (!o || !o.n) return '—（n=0）';
  if (kind === 'share') return `${p0(o.value)}（${o.count}/${o.n}）${o.wilson && finite(o.wilson.lo) ? ` W[${p0(o.wilson.lo)}, ${p0(o.wilson.hi)}]` : ''}`;
  return `${f1(o.value)}${o.ci && finite(o.ci.lo) ? ` [${f1(o.ci.lo)}, ${f1(o.ci.hi)}]` : ''}（n=${o.n}）`;
}
function renderStats() {
  const token = ++statToken;
  byId('ab').replaceChildren(node('p', '計算中…（bootstrap）', { class: 'note-muted' }));
  setTimeout(() => {
    if (token !== statToken || !cur) return;
    try {
      const key = JSON.stringify({ ...P, layer: 0, volLine: 0, size: 0, range: 0, metric: 0, ma: 0, mode: 0 });
      const ab = cache[key] ??= E.compareAB(cur.stats, cur.cfg);
      const row = (k, tag) => {
        const M = E.metric(k), aOnly = E.A_ONLY_KEYS.has(k), d = ab.diff?.[k], bl = ab.block?.[k];
        const diff = aOnly ? '不適用' : !d || !finite(d.est) ? '—' : M.kind === 'share' ? `${f1(d.est * 100)} pt [${f1(d.lo * 100)}, ${f1(d.hi * 100)}]` : `${f1(d.est)} [${f1(d.lo)}, ${f1(d.hi)}]`;
        const blk = aOnly || !bl || !finite(bl.lo) ? '—' : M.kind === 'share' ? `[${f1(bl.lo * 100)}, ${f1(bl.hi * 100)}] pt` : `[${f1(bl.lo)}, ${f1(bl.hi)}]`;
        return [`${tag}${M.label}`, cellTxt(ab.A.m[k], M.kind), aOnly ? `（持續性）${cellTxt(ab.B.m[k], M.kind)}` : cellTxt(ab.B.m[k], M.kind), diff, blk];
      };
      table('ab', ['指標', 'A 未極端恐慌', 'B 極端恐慌', 'B − A（Newcombe／bootstrap）', '年份區塊 bootstrap'], [...E.MAIN_KEYS.map(k => row(k, '【主】')), ...E.AUX_KEYS.map(k => row(k, '')), row('panicLater20', ''), row('panicLater60', '')]);
      const cens = cur.stats.filter(r => !r.complete).length;
      byId('ab-note').textContent = `研究口徑樣本 n=${cur.stats.length}（A ${ab.A.n}、B ${ab.B.n}、未分類 ${ab.U}；完整窗 ${cur.stats.length - cens}、右設限 ${cens}）。${cur.formal ? '目前為正式研究基準，數字應與研究報告一致。' : '探索設定，數字不等同研究報告。'}`;
      drawDist(); drawPath(); renderStrata();
    } catch (e) { byId('ab').replaceChildren(node('p', '計算失敗：' + e.message)); }
  }, 30);
}
const METRIC = { extra: ['額外跌幅 %', x => x.extra], totalDD: ['總回撤 %（相對事前高點）', x => x.totalDD], ret: ['報酬 %（T+1 開盤）', x => x.retOpen], mae: ['MAE %（T+1 開盤）', x => x.maeOpen] };
function drawDist() {
  const rows = cur.stats.filter(r => r.complete && hz(r)), groups = ['A0', 'A1', 'B'], [label, get] = METRIC[P.metric];
  const vals = groups.map(g => rows.filter(r => subOf(r) === g).map(r => get(hz(r))).filter(finite).sort((a, b) => a - b));
  const box = vals.map(v => (v.length ? [0.1, 0.25, 0.5, 0.75, 0.9].map(q => +E.quantile(v, q).toFixed(2)) : []));
  const pts = groups.flatMap((g, k) => rows.filter(r => subOf(r) === g).map((r, j) => ({ value: [k + ((j % 7) - 3) * 0.04, +get(hz(r)).toFixed(2)], date: r.date })));
  const ch = chart('dist');
  ch.setOption(echartsBase({
    animation: false,
    tooltip: { ...tip(), trigger: 'item', formatter: p => (p.seriesType === 'boxplot' ? `${groups[p.dataIndex]}（n=${vals[p.dataIndex].length}）<br>P10 ${p.data[1]}｜Q1 ${p.data[2]}｜中位 ${p.data[3]}｜Q3 ${p.data[4]}｜P90 ${p.data[5]}` : `${p.data.date}：${p.data.value[1]}`) },
    grid: { left: mob() ? 48 : 60, right: 24, top: 30, bottom: 40 },
    xAxis: [{ type: 'category', data: groups.map((g, k) => `${g}（n=${vals[k].length}）`), axisLine: { onZero: false } }, { type: 'value', min: -0.5, max: 2.5, show: false, axisLine: { show: false, onZero: false } }],
    yAxis: { type: 'value', name: `事後 ${H()} 日${label}`, nameTextStyle: { color: PALETTE.muted, fontSize: 10 }, axisLine: { onZero: false } },
    dataZoom: [],
    series: [
      { name: '分布', type: 'boxplot', data: box, itemStyle: { color: 'transparent', borderColor: PALETTE.muted } },
      { name: '事件', type: 'scatter', xAxisIndex: 1, data: pts, symbolSize: 7, itemStyle: { color: p => (subOf(cur.byDate.get(p.data.date)) === 'B' ? CLS.B.color : subOf(cur.byDate.get(p.data.date)) === 'A1' ? '#f0883e' : '#58a6ff'), opacity: 0.8 } },
    ],
  }), { notMerge: true });
  if (!ch.__qpWired) { ch.__qpWired = true; ch.on('click', p => { if (p.data?.date) selectEvent(p.data.date, { from: 'dist' }); }); }
}
function drawPath() {
  const A = cur.stats.filter(r => r.panic === 'A'), w = H();
  const paths = [`A→B ≤${Math.min(20, w)}日`, ...(w > 20 ? [`A→B 21–${w}日`] : []), 'A 未升級', '右設限'];
  const depth = [...DEPTH.map(d => [d.label, r => !!hz(r) && d.test(hz(r)), d.color]), ['右設限', r => !hz(r), '#8b949e']];
  chart('path').setOption(echartsBase({
    animation: false,
    legend: { top: 0, textStyle: { color: PALETTE.muted, fontSize: 11 } },
    tooltip: { ...tip(), trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: ps => { const p = ps[0]; const list = A.filter(r => r.path === paths[p.dataIndex]); return `<b>${paths[p.dataIndex]}</b>（${list.length} 件）<br>` + ps.map(x => `${x.seriesName}：${x.value}`).join('<br>') + `<br>${list.map(r => r.date).join('、')}`; } },
    grid: { left: mob() ? 96 : 116, right: 24, top: 36, bottom: 30 },
    xAxis: { type: 'value', name: '件數', minInterval: 1 },
    yAxis: { type: 'category', data: paths, inverse: true },
    dataZoom: [],
    series: depth.map(([name, fn, color]) => ({ name, type: 'bar', stack: 'n', data: paths.map(p => A.filter(r => r.path === p && fn(r)).length), itemStyle: { color }, label: { show: true, formatter: p => (p.value ? p.value : ''), color: '#fff', fontSize: 11 } })),
  }), { notMerge: true });
  byId('path-note').textContent = `研究口徑 A 組 ${A.length} 件。升級＝之後首次出現 VIX High ≥ ${P.vix} 或 F&G < ${P.fg}；額外跌幅＝事後 ${w} 日內最低 Low 相對事件日 Low。升級與否是事後才知道的。`;
}
function renderStrata() {
  const key = byId('strat').value || 'panicSub';
  table('strata', ['分層', 'n', '20 日額外跌 ≥5%', '60 日額外跌 ≥10%', '60 日額外跌幅 中位', '60 日再破底', '60 日報酬 中位', '60 日 MAE 中位'],
    E.stratify(cur.stats, key).map(x => [x.bucket, `${x.n}`, `${p0(x.m.deep5_20.value)}（${x.m.deep5_20.count ?? 0}/${x.m.deep5_20.n}）`, `${p0(x.m.deep10_60.value)}（${x.m.deep10_60.count ?? 0}/${x.m.deep10_60.n}）`, f1(x.m.extra60.value), `${p0(x.m.rebreak60.value)}（${x.m.rebreak60.n}）`, f1(x.m.ret60.value), f1(x.m.mae60.value)]));
}

// ── 固定研究基準的區段 ──────────────────────────────────────────────────
function renderFixed() {
  const main = res.byThr[D.main];
  cache.match ??= E.matchEvents(main.rows.filter(r => r.date >= D.focus.from && r.date <= D.focus.to), main.rows, D);
  const sel = byId('target');
  if (!sel.options.length) sel.replaceChildren(...cache.match.map((m, k) => node('option', `${m.target.date}（${m.target.panicSub}｜盤中 ${f1(m.target.dropLow)}%${m.target.complete ? '' : '｜右設限'}）`, { value: String(k) })));
  renderMatch();
  cache.prof ??= E.PERIODS.map(p => ({ ...p, prof: E.periodProfile(res.F, p.from, p.to, res.runs) }));
  table('profiles', ['區間', '交易日', '區間報酬', '最大回撤（252 日高）', '收盤 < 150MA', '150MA 斜率', '觸 300MA 日', 'VIX H 最高／≥30 日', 'F&G 最低／中位', '−3% 事件（A/B）', '−2% 事件（A/B）', '60 日新低收盤'],
    cache.prof.map(({ label, prof: p }) => [label, `${p.days}`, f1(p.ret), f1(p.maxDD252), p0(p.belowMa150), f1(p.ma150Slope), `${p.touch300}`, `${p.vixHMax ?? 'N/A'}／${p.vixPanicDays}`, `${p.fgMin ?? 'N/A'}／${f1(p.fgMedian)}`, `${p.events[-3].raw}（${p.events[-3].A}/${p.events[-3].B}）`, `${p.events[-2].raw}（${p.events[-2].A}/${p.events[-2].B}）`, `${p.newLow60}`]));
  const ps = byId('period');
  if (!ps.options.length) { ps.replaceChildren(...E.PERIODS.map(p => node('option', p.label, { value: p.id }))); ps.value = '2026-06~10'; }
  renderPeriodEvents(); renderMA();
}
function renderMatch() {
  const m = cache.match[+byId('target').value || 0];
  if (!m) { table('match', ['—'], []); return; }
  const a = m.rankOf('2022-01-05'), t = m.target;
  table('match', ['名次', '歷史事件', '距離', '分類', '事前回撤', '距 150MA', '150MA 斜率', 'RVOL', 'VIX H', 'F&G', '前 60 日恐慌', '60 日額外跌幅', '60 日總回撤', '60 日報酬', '之後極端恐慌'],
    [...m.neighbors.map((x, k) => { const r = x.r; return [`${k + 1}`, r.date, x.d.toFixed(2), subOf(r), f1(r.eventDD), f1(r.ma[150].dist), f1(r.slope150), num(r.volRatio), num(r.vixHigh), num(r.fg), r.priorPanic === null ? 'N/A' : r.priorPanic ? '是' : '否', f1(r.h[60]?.extra), f1(r.h[60]?.totalDD), f1(r.h[60]?.retOpen), r.post?.panicDays != null ? `+${r.post.panicDays} 日` : '無']; }),
      ['目標', t.date, '—', subOf(t), f1(t.eventDD), f1(t.ma[150].dist), f1(t.slope150), num(t.volRatio), num(t.vixHigh), num(t.fg), t.priorPanic === null ? 'N/A' : t.priorPanic ? '是' : '否', t.h[60] ? f1(t.h[60].extra) : `右設限（${t.avail} 日）`, '—', '—', '—'],
      ['參照', `2022-01-05 群組${a ? `（以 ${a.date} 計）` : ''}`, a ? a.d.toFixed(2) : '—', a ? `第 ${a.rank}/${a.of} 名` : '不在池中', '', '', '', '', '', '', '', '', '', '', '']]);
}
function renderPeriodEvents() {
  const p = E.PERIODS.find(x => x.id === byId('period').value) || E.PERIODS[0];
  const rows = res.byThr[-2].rows.filter(r => r.date >= p.from && r.date <= p.to);
  table('period-events', ['日期', '盤中', '跳空', '開盤後', '收盤', 'RVOL', 'VIX H', 'VXN H', 'F&G', '分類', '事前回撤', '20 日額外跌幅', '60 日額外跌幅', '之後極端恐慌', '150MA'],
    rows.map(r => [`${r.date}${r.dropLow <= -3 ? ' ●' : ''}`, f1(r.dropLow), f1(r.gap), f1(r.sessionDrop), f1(r.closeChg), num(r.volRatio), num(r.vixHigh), num(r.vxnHigh), num(r.fg), subOf(r), f1(r.eventDD),
      r.h[20] ? f1(r.h[20].extra) : '右設限', r.h[60] ? f1(r.h[60].extra) : `右設限（${r.avail} 日）`, r.post?.panicDate ? `${r.post.panicDate}（+${r.post.panicDays}）` : r.complete ? '60 日內無' : '右設限',
      r.ma[150].status === 'above' ? '上方' : r.ma[150].status === 'reclaimed' ? `下方→+${r.ma[150].reclaimDays} 日站回` : r.ma[150].status === 'not_within' ? '下方、60 日未站回' : '下方、右設限']));
}
function renderMA() {
  if (!cache.ma) {
    const by = Object.fromEntries(E.MA_BREAK.mas.map(p => [p, E.maBreakEvents(res.F, p)]));
    const noVol = Object.fromEntries(E.MA_BREAK.mas.map(p => [p, E.maBreakEvents(res.F, p, { ...E.MA_BREAK, rvol: 0 })]));
    cache.ma = { by, noVol, base: E.baselineRates(res.F) };
  }
  const rows = cache.ma.by[P.ma], ok = rows.filter(r => !r.alreadyDeep), nv = cache.ma.noVol[P.ma].filter(r => !r.alreadyDeep && r.isRep), b = cache.ma.base;
  byId('ma-base').textContent = `基準（研究期間每個交易日）：60 日內額外跌 ≥10% ${p0(b.deep10_60.value)}；120 日內首次進入 −20% ${p0(b.deep120.value)}。事件日已在 −20% 中而另列：${rows.filter(r => r.alreadyDeep).map(r => r.date).join('、') || '無'}。`;
  const sets = [['一般跌破（主樣本）', ok], ['嚴格首次跌破', ok.filter(r => r.strict)], ['× A 未極端恐慌', ok.filter(r => r.panic === 'A')], ['× B 極端恐慌', ok.filter(r => r.panic === 'B')],
    ['不要求 RVOL｜20 日去重（敏感度）', nv], ['不要求 RVOL × A（敏感度）', nv.filter(r => r.panic === 'A')], ['不要求 RVOL × B（敏感度）', nv.filter(r => r.panic === 'B')]];
  const cellMA = (o, kind) => (!o || !o.n ? '—' : kind === 'share' ? `${p0(o.value)}（${o.count}/${o.n}）` : `${f1(o.value)}（n=${o.n}）`);
  table('ma-stats', ['樣本', 'n', ...E.MA_METRICS.map(m => m.label)], sets.map(([label, rs]) => { const d = E.describeMA(rs); return [label, `${d.n}`, ...E.MA_METRICS.map(m => cellMA(d.m[m.key], m.kind))]; }));
  const st = (s, days) => (s === 'yes' ? `是（+${days}）` : s === 'no' ? '否' : s === 'already' ? '已在其中' : '右設限');
  table('ma-events', ['日期', '嚴格首次', '分類', 'RVOL', '距 MA', 'VIX H', 'F&G', '20 日站回', '20 日 ×1.025', '60 日低於 MA ≥70%', '60／120 日額外跌幅', '120 日進入 −20%'],
    rows.map(r => [r.date, r.strict ? '是' : '否', r.panic, num(r.rvol), f1(r.dist), num(r.vixHigh), num(r.fg), st(r.reclaim20, r.reclaimDays), st(r.confirm20, r.confirmDays), r.below70 === null ? '右設限' : r.below70 ? '是' : '否', `${f1(r.extra60)}／${f1(r.extra120)}`, st(r.deep120, r.deepDays)]));
}

// ── orchestration ───────────────────────────────────────────────────────
function recompute() {
  compute();
  renderSummary(); drawTS(); drawScatter(); renderList(); renderDetail(); byId('brush').replaceChildren();
  renderStats();
  byId('status').textContent = `完成：${cur.shown.length} 個事件（${{ all: '所有事件', rvol: '符合 RVOL', first: '20 日群組首筆' }[P.mode]}）。`;
}
function safe(fn) { return (...a) => { try { fn(...a); } catch (e) { byId('status').textContent = '計算失敗：' + e.message; console.error('[qqqpanic]', e); } }; }
function wire() {
  if (!bindOnce(byId('thr'))) return;
  byId('range').replaceChildren(...RANGES.map(r => node('span', r.label, { class: 'chip' + (r.id === P.range ? ' active' : ''), 'data-qp-range': r.id })));
  const pick = (id, attr, apply, after = recompute) => chipPicker(byId(id), attr, safe(v => { apply(v); after(); }), { onlyMatching: true });
  pick('thr', 'qp-thr', v => { P.thr = +v; byId('thr-custom').value = ''; });
  byId('thr-custom').addEventListener('change', safe(e => { const v = parseFloat(e.target.value); if (!(v > 0 && v <= 20)) return; P.thr = -v; for (const c of byId('thr').querySelectorAll('.chip')) c.classList.remove('active'); recompute(); }));
  pick('def', 'qp-def', v => { P.dropDef = v; });
  pick('rvol', 'qp-rvol', v => { P.rvol = +v; });
  pick('vix', 'qp-vix', v => { P.vix = +v; });
  pick('fg', 'qp-fg', v => { P.fg = +v; });
  pick('vxn', 'qp-vxn', v => { P.vxn = +v; });
  pick('pre', 'qp-pre', v => { P.pre = +v; });
  pick('post', 'qp-post', v => { P.post = +v; });
  pick('mode', 'qp-mode', v => { P.mode = v; });
  pick('layer', 'qp-layer', v => { P.layer = v; }, () => drawTS());
  pick('volline', 'qp-volline', v => { P.volLine = v; }, () => drawTS());
  pick('size', 'qp-size', v => { P.size = v; }, () => drawScatter());
  pick('range', 'qp-range', v => { P.range = v; cache.rangeDirty = true; }, () => applyRange());
  for (const id of ['from', 'to']) byId(id).addEventListener('change', safe(() => { P.range = 'custom'; for (const c of byId('range').querySelectorAll('.chip')) c.classList.remove('active'); applyRange(); }));
  pick('metric', 'qp-metric', v => { P.metric = v; }, () => drawDist());
  pick('ma', 'qp-ma', v => { P.ma = +v; }, () => renderMA());
  byId('csv').addEventListener('click', safe(exportCSV));
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
  loadedAt = Date.now();
  wire();
  const F = res.F;
  byId('from').min = byId('to').min = F.date[F.startIdx]; byId('from').max = byId('to').max = F.date[F.endIdx];
  byId('status').textContent = '計算中…';
  recompute();
  renderFixed();
}
// 測試／驗收用：目前事件集與分類（不改變狀態）
export function _state() { return cur ? { params: { ...P }, shown: cur.shown.map(r => ({ date: r.date, panic: r.panic, sub: subOf(r), rvol: r.volRatio })), formal: cur.formal, selected } : null; }
export function getCharts() { return Object.entries(charts).filter(([k, c]) => k !== 'mini' && c && !c.isDisposed?.()).map(([, c]) => c); }
export function resize() { Object.values(charts).forEach(c => c && !c.isDisposed?.() && c.resize()); }
export function onThemeChange() {
  if (!res) return;
  return preserveChartState(getCharts, () => { Object.values(charts).forEach(c => c?.dispose?.()); charts = {}; drawTS(); drawScatter(); renderDetail(); if (cur) { drawDist(); drawPath(); } });
}
