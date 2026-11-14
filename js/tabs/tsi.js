// TSI 逆向訊號 — The Signal Investor 週線紫／綠／紅點的研究重建候選（非作者官方訊號）。
// 資料：data/tsi_weekly.json（scripts/compute_tsi_weekly.py 以凍結公式算好；前端不重算公式）。
// 版面：最新已完成週線狀態 → F1/F2、QQQ 開關 → NDX 週 K＋訊號點／Stochastic／MACD 三格同步圖 → 歷史事件表 → 作者訊號驗證 → 口徑。
import { isLight, echartsBase, PALETTE, mob } from '../utils/theme.js';
import { requestJSON } from '../utils/data.js';
import { bindOnce, chipPicker } from '../utils/dom.js';
import { preserveChartState } from '../utils/chartLifecycle.js';
import { KINDS, seriesTip, eventsOf, latestStatus, filterEvents, evidenceLabel, staleDays } from './tsi_calc.mjs';

const byId = id => document.getElementById('tsi-' + id);
const f2 = v => (typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 }) : '—');
let liveView = true;
let J = null, chart = null, model = 'F2', showQQQ = false, kind = 'all', period = 'all';

function node(tag, text, cls) {
  const el = document.createElement(tag);
  if (text != null) el.textContent = text;
  if (cls) el.className = cls;
  return el;
}

function renderNow() {
  const s = latestStatus(J.data), r = s.row, host = byId('now');
  host.replaceChildren();
  const card = (title, value, sub, lit) => {
    const c = node('div', null, 'tsi-stat' + (lit ? ' is-lit' : ''));
    c.append(node('span', title), node('b', value));
    if (sub) c.append(node('span', sub));
    host.append(c);
  };
  card('最新已完成週線', r.week, `收盤確認 ${r.last_day}`);
  card('NDX 週收盤', f2(r.c));
  card('Stochastic K / D', `${f2(r.k)} / ${f2(r.d)}`, r.k < 25 ? 'K 低於 25' : 'K 高於 25');
  card('MACD / Signal', `${f2(r.macd)} / ${f2(r.sig)}`, r.macd > r.sig ? 'MACD 在 Signal 之上' : 'MACD 在 Signal 之下');
  card('最近紫點', s.lastPurple || '—', null, r.purple);
  card('最近買進事件', s.lastBuy || '—', s.buyNow ? '本週有 BUY_EVENT' : '本週無 BUY_EVENT', s.buyNow);
  card('F2 續亮', s.contNow ? '續亮中' : '否', s.lastCont ? `最近續亮 ${s.lastCont}` : null, s.contNow);
  card('最近紅點', s.lastSell || '—', null, r.sell);
  byId('asof').textContent = `資料更新 ${J.updated.replace('T', ' ').slice(0, 16)} UTC` + (J.pending_week ? `｜${J.pending_week} 週尚未收盤，不列入` : '');
}

const NAMES = { purple: '紫點', buy: '綠點（買進事件）', cont: 'F2 續亮', sell: '紅點' };
const RATE_KEY = { purple: 'PURPLE', buy: 'BUY_EVENT', cont: 'F2_CONTINUATION', sell: 'SELL' };

const STATUS_TXT = {
  PROVISIONAL: '週線正在形成',
  DATA_PENDING: '理論上已收盤，但正式日線資料尚未完整',
  CONFIRMED: '當週最後交易日已正式收盤，且資料完整',
};

function renderLive() {
  const host = byId('live'), cw = J.current_week, last = J.data[J.data.length - 1];
  host.hidden = !liveView;
  host.replaceChildren();
  const p = t => { const el = node('p', null); el.style.margin = '2px 0'; if (typeof t === 'string') el.textContent = t; else el.append(...t); host.append(el); return el; };
  const badge = (txt, cls) => node('span', txt, 'tsi-badge ' + cls);
  const upd = (J.updated || '').replace('T', ' ').replace(/:\d\dZ$/, ' UTC');
  p(`最近資料日期：${J.data_through || last.last_day}｜資料最後更新：${upd || '—'}`);
  if (J.data_lag_days >= 2) p(`⚠ 資料日期停在 ${J.data_through}，交易所日曆上應已到 ${J.expected_through}（落後 ${J.data_lag_days} 個交易日），資料可能過期。`).classList.add('tsi-warn-line');
  if (staleDays(J.updated) > 4) p('⚠ 資料超過 4 天沒有更新成功，下方為最近一次成功的資料，可能已過期。').classList.add('tsi-warn-line');
  p([badge('CONFIRMED', 'tsi-badge-conf'), document.createTextNode(`最近已確認週線：${last.week} 週（${last.last_day} 收盤確認，${STATUS_TXT.CONFIRMED}）`)]);
  if (!cw) { p('目前沒有進行中的週線（上一週已收盤確認，新的一週還沒開始）。'); return; }
  const cls = cw.status === 'DATA_PENDING' ? 'tsi-badge-pend' : 'tsi-badge-prov';
  p([badge(cw.status, cls), document.createTextNode(`${cw.week} 週：${STATUS_TXT[cw.status] || ''}`)]);
  if (cw.missing_days?.length) p(`缺少日線：${cw.missing_days.join('、')}。資料補齊前不確認、不猜收盤值。`);
  if (!cw.steps?.length) { p('本週還沒有任何交易日收盤，沒有暫時訊號。'); return; }
  const st = cw.steps[cw.steps.length - 1];
  const on = Object.keys(NAMES).filter(k => st[k]);
  p(`本週第 ${cw.day_no} 個交易日（共 ${cw.trading_days_in_week ?? '—'} 天；${st.date} 收盤後）：K ${f2(st.k)}／D ${f2(st.d)}，MACD ${f2(st.macd)}／Signal ${f2(st.sig)}`);
  if (cw.data_incomplete) {
    p('⚠ 本週已取得的日線不完整，暫時週 K 的高低點可能有誤，以下暫時訊號只供參考，不對應歷史成立率。').classList.add('tsi-warn-line');
    for (const k of on) p(`暫時${NAMES[k]}（資料不足）：首次亮燈 ${cw.first_seen?.[k] || '—'}`);
    return;
  }
  if (!on.length) p('目前沒有暫時訊號。');
  for (const k of on) {
    const rate = (J.intrabar_confirm_rates || []).find(r => r.signal === RATE_KEY[k] && Number(r.day) === cw.day_no);
    const rt = rate ? `歷史統計：過去第 ${cw.day_no} 天亮著的週，最後週收盤成立 ${rate.n_final}/${rate.n_lit_on_day} 週（${Math.round(rate.confirm_rate * 100)}%，95% Wilson 區間 ${Math.round(rate.ci_lo * 100)}–${Math.round(rate.ci_hi * 100)}%）` : '（這一天沒有歷史統計）';
    p(`暫時${NAMES[k]}：首次亮燈 ${cw.first_seen?.[k] || '—'}。${rt}`);
  }
  p('暫時訊號＝這根未完成的週 K 目前符合條件，最後交易日收盤前仍可能消失，不會寫進下方歷史。歷史成立比例只是過去的統計，不是這週的預測機率。');
}

function buildOption() {
  const rows = J.data, light = isLight(), weeks = rows.map(r => r.week);
  const pts = k => rows.map(r => (r[k] && (k !== 'cont' || model === 'F2')
    ? (k === 'purple' || k === 'sell' ? r.h * 1.03 : r.l * 0.97) : null));
  const scatter = (k, symbol, extra = {}) => ({
    name: KINDS[k].label, type: 'scatter', data: pts(k), symbol, symbolSize: mob() ? 9 : 11, xAxisIndex: 0, yAxisIndex: 0,
    itemStyle: { color: KINDS[k].color, ...extra }, z: 5,
  });
  const series = [
    { name: 'NDX 週K', type: 'candlestick', data: rows.map(r => [r.o, r.c, r.l, r.h]), xAxisIndex: 0, yAxisIndex: 0,
      itemStyle: { color: '#ef4444', color0: '#3fb950', borderColor: '#ef4444', borderColor0: '#3fb950' } },
    scatter('purple', 'circle'),
    scatter('buy', 'triangle'),
    ...(model === 'F2' ? [{ ...scatter('cont', 'emptyCircle'), itemStyle: { color: KINDS.cont.color, borderWidth: 2 } }] : []),
    scatter('sell', 'pin'),
    { name: '%K', type: 'line', data: rows.map(r => r.k), xAxisIndex: 1, yAxisIndex: 2, showSymbol: false, lineStyle: { width: 1.4 }, itemStyle: { color: '#58a6ff' },
      markLine: { silent: true, symbol: 'none', data: [{ yAxis: 25 }], lineStyle: { color: '#a371f7', type: 'dashed' }, label: { formatter: '25' } } },
    { name: '%D', type: 'line', data: rows.map(r => r.d), xAxisIndex: 1, yAxisIndex: 2, showSymbol: false, lineStyle: { width: 1.2 }, itemStyle: { color: '#f0883e' } },
    { name: 'MACD', type: 'line', data: rows.map(r => r.macd), xAxisIndex: 2, yAxisIndex: 3, showSymbol: false, lineStyle: { width: 1.4 }, itemStyle: { color: '#58a6ff' } },
    { name: 'Signal', type: 'line', data: rows.map(r => r.sig), xAxisIndex: 2, yAxisIndex: 3, showSymbol: false, lineStyle: { width: 1.2 }, itemStyle: { color: '#f0883e' } },
    { name: 'Histogram', type: 'bar', data: rows.map(r => (r.macd == null || r.sig == null ? null : +(r.macd - r.sig).toFixed(2))), xAxisIndex: 2, yAxisIndex: 3,
      itemStyle: { color: p => (p.value >= 0 ? '#ef444499' : '#3fb95099') } },
  ];
  if (showQQQ) series.push({ name: 'QQQ 週收盤（對照）', type: 'line', data: rows.map(r => r.qqq?.[3] ?? null), xAxisIndex: 0, yAxisIndex: 1,
    showSymbol: false, lineStyle: { width: 1.2, type: 'dashed' }, itemStyle: { color: '#f778ba' } });
  const startIdx = Math.max(0, weeks.findIndex(w => w >= '2021-01-01'));
  const grids = mob() ? [['11%', '46%'], ['62%', '15%'], ['81%', '9%']] : [['8%', '48%'], ['60%', '17%'], ['80%', '9%']];
  const axisCommon = { type: 'category', data: weeks, boundaryGap: true, axisLine: { onZero: false } };
  const legendSel = chart?.getOption?.()?.legend?.[0]?.selected;
  return echartsBase({
    animation: false,
    legend: { top: 0, type: 'scroll', selected: legendSel, textStyle: { color: PALETTE.text },
      tooltip: { show: true, confine: true, extraCssText: 'max-width:280px;white-space:normal;', formatter: p => `<b>${p.name}</b><br>${seriesTip(p.name)}<br><span style="opacity:.7">點一下可開關</span>` } },
    tooltip: { trigger: 'axis', axisPointer: { type: 'cross', link: [{ xAxisIndex: 'all' }] }, confine: true, formatter: ps => tip(ps, rows) },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: grids.map(([top, h]) => ({ left: mob() ? 46 : 64, right: showQQQ ? (mob() ? 40 : 60) : 16, top, height: h })),
    xAxis: [0, 1, 2].map(i => ({ ...axisCommon, gridIndex: i, axisLabel: { show: i === 2, color: PALETTE.muted } })),
    yAxis: [
      { gridIndex: 0, scale: true, min: v => Math.floor(v.min * 0.95), max: v => Math.ceil(v.max * 1.05), axisLabel: { color: PALETTE.muted }, splitLine: { lineStyle: { color: light ? '#eee' : '#30363d' } } },
      { gridIndex: 0, scale: true, min: v => Math.floor(v.min * 0.95), max: v => Math.ceil(v.max * 1.05), show: showQQQ, position: 'right', splitLine: { show: false }, axisLabel: { color: '#f778ba' } },
      { gridIndex: 1, min: 0, max: 100, interval: 25, axisLabel: { color: PALETTE.muted }, splitLine: { show: false } },
      { gridIndex: 2, scale: true, axisLabel: { color: PALETTE.muted }, splitLine: { show: false } },
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1, 2], startValue: startIdx, endValue: weeks.length - 1 },
      { type: 'slider', xAxisIndex: [0, 1, 2], bottom: 4, height: 18, startValue: startIdx, endValue: weeks.length - 1 },
    ],
    series,
  });
}

function tip(ps, rows) {
  const r = rows[ps[0]?.dataIndex];
  if (!r) return '';
  const tags = [];
  if (r.purple) tags.push('紫點');
  if (r.buy) tags.push('綠點 BUY_EVENT');
  if (r.cont && model === 'F2') tags.push(`F2 續亮（STATE，源自 ${r.cont_of}）`);
  if (r.sell) tags.push('紅點 SELL');
  return [`<b>${r.week} 週</b>（收盤確認 ${r.last_day}）`,
    `NDX 開 ${f2(r.o)} 高 ${f2(r.h)} 低 ${f2(r.l)} 收 ${f2(r.c)}`,
    r.qqq ? `QQQ 收 ${f2(r.qqq[3])}` : '',
    `K ${f2(r.k)}／D ${f2(r.d)}　MACD ${f2(r.macd)}／Signal ${f2(r.sig)}`,
    tags.length ? `<b>${tags.join('、')}</b>` : '無訊號',
    `作者證據：${evidenceLabel(r)}`].filter(Boolean).join('<br>');
}

function renderEvents() {
  const ev = filterEvents(eventsOf(J.data, model), kind, period).reverse();
  const t = node('table');
  const head = t.createTHead().insertRow();
  ['日期（週一）', '訊號', '事件／續亮', 'NDX 週收盤', 'K / D', 'MACD / Signal', '模型', '作者證據'].forEach(h => head.append(node('th', h)));
  const body = t.createTBody();
  for (const e of ev) {
    const r = e.row, tr = body.insertRow();
    const sig = node('td');
    const dot = node('i', null, 'tsi-dot tsi-dot-' + e.kind);
    sig.append(dot, document.createTextNode(KINDS[e.kind].label));
    tr.append(node('td', e.week), sig, node('td', e.type === 'STATE' ? `續亮 STATE（源自 ${r.cont_of}）` : 'EVENT'),
      node('td', f2(r.c)), node('td', `${f2(r.k)} / ${f2(r.d)}`), node('td', `${f2(r.macd)} / ${f2(r.sig)}`),
      node('td', e.kind === 'cont' ? 'F2' : 'F1、F2'), node('td', evidenceLabel(r)));
  }
  byId('events').replaceChildren(t);
  byId('events-count').textContent = `${ev.length} 筆（${model}；續亮不計入買進事件。全期買進事件 ${J.counts.buy_event} 次）`;
}

function renderAuthor() {
  const t = node('table');
  const head = t.createTHead().insertRow();
  ['週', 'F1/F2 預測', '作者公開', '顯示週期', '計算週期', '可週線評分', '樣本', '狀態', '說明'].forEach(h => head.append(node('th', h)));
  const body = t.createTBody();
  for (const f of [...J.forward_tracking].reverse()) {
    const pred = [f.F1_purple === '1' && '紫', f.F1_buy_event === '1' && '綠', f.F2_buy_state_continuation === '1' && 'F2 續亮', f.F1_sell === '1' && '紅'].filter(Boolean).join('、') || '無';
    const eligible = f.weekly_scoring_eligible === 'true';
    let status = f.evaluation_status || 'UNKNOWN';
    if (!eligible && (status === 'MATCH' || status === 'MISS')) status = 'UNKNOWN';
    const tr = body.insertRow();
    tr.append(node('td', f.week), node('td', pred), node('td', f.author_published?.startsWith('YES') ? (f.author_signal || 'YES') : '未公開'),
      node('td', f.author_display_timeframe || '—'), node('td', f.author_calculation_timeframe || '—'), node('td', eligible ? '是' : '否'),
      node('td', f.in_sample_or_out_of_sample || '—'), node('td', status, 'tsi-st tsi-st-' + status.toLowerCase()), node('td', f.note || ''));
  }
  byId('author').replaceChildren(t);
  const oos = J.forward_tracking.filter(f => f.in_sample_or_out_of_sample === 'OUT_OF_SAMPLE' && f.weekly_scoring_eligible === 'true');
  byId('author-sum').textContent = `樣本外可評分週：${oos.length}（MATCH ${oos.filter(f => f.evaluation_status === 'MATCH').length}、MISS ${oos.filter(f => f.evaluation_status === 'MISS').length}）。證據來源：${J.evidence_source}。`;
}

function renderChart() {
  if (!chart) return;
  preserveChartState(() => [chart], () => chart.setOption(buildOption(), { notMerge: true }));
}

function bindControls() {
  if (!bindOnce(byId('controls'))) return;
  chipPicker(byId('model'), 'tsi-model', v => { model = v; renderChart(); renderEvents(); });
  chipPicker(byId('qqq'), 'tsi-qqq', v => { showQQQ = v === 'on'; renderChart(); });
  chipPicker(byId('kind'), 'tsi-kind', v => { kind = v; renderEvents(); });
  chipPicker(byId('view'), 'tsi-view', v => { liveView = v === 'live'; renderLive(); });
  chipPicker(byId('period'), 'tsi-period', v => { period = v; renderEvents(); });
}

export async function activate(context = {}) {
  const data = await requestJSON('data/tsi_weekly.json', { signal: context.signal });
  if (!Array.isArray(data?.data) || !data.data.length) throw new Error('TSI 週線資料不足');
  if (context.signal?.aborted || context.isCurrent?.() === false) return;
  J = data;
  bindControls();
  renderNow();
  renderLive();
  const host = byId('chart');
  if (!chart) chart = echarts.init(host, isLight() ? null : 'dark');
  chart.setOption(buildOption(), { notMerge: true });
  renderEvents();
  renderAuthor();
  byId('status').textContent = '';
}

export function onThemeChange() {
  if (!J) return;
  return preserveChartState(getCharts, () => {
    chart?.dispose();
    chart = echarts.init(byId('chart'), isLight() ? null : 'dark');
    chart.setOption(buildOption(), { notMerge: true });
  });
}
export function resize() { chart?.resize(); }
export function getCharts() { return chart ? [chart] : []; }
