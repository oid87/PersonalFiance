// TQQQ 大額資金流入回測 — TQQQ 單日淨流入很大的那天之後，QQQ／QLD／TQQQ 的 5–60 日報酬、最大不利跌幅、
// 相對無訊號日的超額報酬。
// 版面：最新狀態卡（流入、回撤、恐懼貪婪、VIX、VXN、是否觸發、上次事件）→ 參數（門檻／回撤／冷卻／進場／情緒與波動開關／一鍵設定）→ TQQQ 淨值＋每日淨流入＋QQQ 回撤圖
//       → 事件明細與統計（資產、期間 chip）→ 三檔比較 → 門檻敏感度 → 口徑與限制。
// 計算：js/tabs/tqqqflow_calc.mjs；資料：data/proshares_flows.json（scripts/fetch_proshares_flows.py）＋ data/QQQ.json，
//       開關用 data/fear_greed.json、VIX.json、VXN.json（選用：載不到時對應開關停用）。
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
// 情緒／波動開關：k → [狀態卡標題, 比較方向, 小數位]
const FILTERS = { fg: ['CNN 恐懼貪婪', '≤', 0], vix: ['VIX 收盤', '≥', 1], vxn: ['VXN 收盤', '≥', 1] };
const switchOf = k => document.querySelector(`#tab-tqqqflow [data-tqqqflow-switch="${k}"]`);
const LIMIT = k => (k === 'fg' ? 'fgMax' : `${k}Min`);
let missing = [];

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
const sameParams = (a, b) => C.PARAM_KEYS.every(k => a[k] === b[k]);
const filterText = p => Object.entries(FILTERS).filter(([k]) => p[`${k}On`]).map(([k, [name, op]]) => `${name} ${op} ${p[LIMIT(k)]}`).join('・');
const num = (x, d) => (finite(x) ? x.toFixed(d) : '—');

// ── data ────────────────────────────────────────────────────────────────
async function load(context) {
  const optional = ['data/fear_greed.json', 'data/VIX.json', 'data/VXN.json'];
  const [flows, , ...extra] = await Promise.all([requestJSON('data/proshares_flows.json', { signal: context.signal }), ensureLoaded('QQQ', context),
    ...optional.map(f => requestJSON(f, { signal: context.signal }).catch(e => { if (context.signal?.aborted) throw e; return null; }))]);
  if (context.signal?.aborted || context.isCurrent?.() === false) return false;
  const rows = (j, field) => (j?.data ?? []).filter(r => finite(r?.[field])).map(r => [r.date, r[field]]);
  const [fg, vix, vxn] = [rows(extra[0], 'value'), rows(extra[1], 'close'), rows(extra[2], 'close')];
  missing = Object.keys(FILTERS).filter((k, i) => ![fg, vix, vxn][i].length);
  series = C.buildSeries(flows, loaded.QQQ, { fg, vix, vxn });
  meta = flows;
  byId('asof').textContent = `資料 ${series.dates[0]} ～ ${series.dates.at(-1)}`;
  const ck = flows.etfiq_check;
  byId('etfiq').textContent = ck ? `ETFIQ 至 ${ck.as_of}：${ck.within_10k_usd}／${ck.n} 天差距小於 1 萬美元` : '本次未取得 ETFIQ 對帳';
  return true;
}

// ── 最新狀態 ─────────────────────────────────────────────────────────────
function renderNow() {
  const st = C.currentStatus(series, study), p = study.params;
  // tag：達標／未達／未啟用（只有「今天是否觸發」那張用紅框）。
  const TAG = { ok: ['達標', 'is-ok'], no: ['未達', 'is-no'], off: ['未啟用', 'is-off'] };
  const card = (title, value, sub, tag = null, lit = false) => {
    const el = node('div', null, { class: 'tqqqflow-stat' + (lit ? ' is-lit' : '') });
    const head = node('span', title);
    if (tag) head.append(node('em', TAG[tag][0], { class: `tqqqflow-state ${TAG[tag][1]}` }));
    el.append(head, node('b', value, String(value).length > 12 ? { class: 'is-compact' } : {}), node('span', sub));
    return el;
  };
  const tagOf = (on, hit) => (!on ? 'off' : hit ? 'ok' : 'no');
  const ev = st.lastEvent;
  let since = '—';
  if (ev?.entry != null) {
    const px = asset === 'QQQ' ? series.qqq : asset === 'QLD' ? series.qld : series.tqqq;
    since = `進場至今 ${asset} ${pct(px.at(-1) / px[ev.entry] - 1)}`;
  }
  const mark = ok => (ok ? '✓' : '✗');
  const checks = [`資金流 ${mark(st.flowHit)}`, p.ddMin > 0 ? `回撤 ${mark(st.ddHit)}` : null,
    ...Object.keys(FILTERS).filter(k => p[`${k}On`]).map(k => `${k === 'fg' ? '恐懼貪婪' : k.toUpperCase()} ${mark(st[`${k}Hit`])}`)].filter(Boolean);
  byId('now').replaceChildren(
    card('今天是否觸發', st.signal ? (st.cooldownLeft > 0 && ev && ev.i !== series.dates.length - 1 ? '符合（冷卻中）' : '觸發') : '未觸發',
      `${checks.join('・')}${st.cooldownLeft > 0 ? `・冷卻剩 ${st.cooldownLeft} 日` : ''}`, null, st.signal),
    card(`最新淨流入（${st.date}）`, `${yi(st.flow)}美元`, `條件 ≥ ${thrText(p)}・占前日規模 ${pct(st.pct)}`, tagOf(true, st.flowHit)),
    card('QQQ 距 52 週高點', pct(st.dd), p.ddMin > 0 ? `條件 ≤ −${(p.ddMin * 100).toFixed(0)}%` : '不限回撤', tagOf(p.ddMin > 0, st.ddHit)),
    // 已啟用的情緒／波動條件各一張卡；沒啟用的合併成一張小卡，只列數值。
    ...Object.entries(FILTERS).filter(([k]) => p[`${k}On`]).map(([k, [name, op, d]]) => card(name, num(st[k], d),
      missing.includes(k) ? '資料載入失敗' : `條件 ${op} ${p[LIMIT(k)]}`, tagOf(true, st[`${k}Hit`]))),
    ...(Object.keys(FILTERS).some(k => !p[`${k}On`]) ? [card('情緒與波動', Object.entries(FILTERS).filter(([k]) => !p[`${k}On`])
      .map(([k, [name, , d]]) => `${name.replace(' 收盤', '').replace('CNN ', '')} ${num(st[k], d)}`).join('・'), '下方開關打開才列入條件', 'off')] : []),
    card('上次事件', ev ? ev.date : '無', ev ? `${st.sessionsSince} 個交易日前・${since}` : '目前條件下沒有事件'),
  );
}

// ── 圖 ──────────────────────────────────────────────────────────────────
// 五格共用時間軸：TQQQ 淨值 → 每日淨流入 → QQQ 回撤 → CNN 恐懼貪婪 → VIX／VXN。
// 橘色直線＝事件日（貫穿五格）；紅虛線＝開著的門檻，灰虛線＝關著的門檻。
const PANES = [
  { key: 'nav', name: 'TQQQ 淨值', top: 3, h: 24 },
  { key: 'flow', name: '每日淨流入（億美元）', top: 32, h: 13 },
  { key: 'dd', name: 'QQQ 距 52 週高點 %', top: 50, h: 10 },
  { key: 'fg', name: 'CNN 恐懼貪婪', top: 65, h: 10 },
  { key: 'vol', name: 'VIX（橘）／VXN（紫）', top: 80, h: 10 },
];
const VIX_C = '#f0883e', VXN_C = '#a371f7', EVENT_C = '#f0883e';
function drawChart() {
  const host = byId('chart');
  if (!chart) chart = echarts.init(host, isLight() ? null : 'dark');
  const s = series, L = mob() ? 40 : 52, R = mob() ? 12 : 24, last = PANES.length - 1;
  const fixed = v => (finite(v) ? +v.toFixed(2) : null);
  const flowYi = s.flow.map(v => +(v / 1e8).toFixed(2));
  const line = (id, pane, data, color, extra = {}) => ({ id, type: 'line', xAxisIndex: pane, yAxisIndex: pane, data, showSymbol: false,
    connectNulls: false, lineStyle: { width: 1.2, color }, itemStyle: { color }, ...extra });
  chart.setOption(echartsBase({
    animation: false,
    legend: { show: false },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'line' }, backgroundColor: PALETTE.bg, borderColor: PALETTE.border, textStyle: { color: PALETTE.text, fontSize: 13 },
      formatter(items) {
        const i = items?.[0]?.dataIndex; if (i == null) return '';
        const ev = study?.events.find(e => e.i === i);
        return [`<b>${s.dates[i]}</b>${ev ? '　<b style="color:#f0883e">事件日</b>' : ''}`, `TQQQ 淨值 ${s.tqqq[i].toFixed(2)}`,
          `淨流入 ${yi(s.flow[i])}美元（占規模 ${pct(s.pct[i])}）`, `QQQ 距 52 週高點 ${pct(s.dd[i])}`,
          `恐懼貪婪 ${num(s.fg[i], 0)}・VIX ${num(s.vix[i], 1)}・VXN ${num(s.vxn[i], 1)}`].join('<br>');
      },
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: PANES.map(p => ({ left: L, right: R, top: `${p.top}%`, height: `${p.h}%` })),
    xAxis: PANES.map((p, k) => ({ type: 'category', gridIndex: k, data: s.dates, boundaryGap: true, axisTick: { show: false },
      axisLine: { lineStyle: { color: PALETTE.muted } }, axisLabel: { show: k === last, color: PALETTE.muted, fontSize: 12, formatter: d => d.slice(0, 7) } })),
    yAxis: PANES.map((p, k) => ({ type: 'value', gridIndex: k, name: p.name, nameLocation: 'end', nameGap: 6,
      nameTextStyle: { color: PALETTE.text, fontSize: 12, fontWeight: 600, align: 'left', padding: [0, 0, 0, -L + 4] },
      scale: p.key === 'nav' || p.key === 'vol', splitNumber: p.key === 'nav' ? 4 : 2,
      ...(p.key === 'fg' ? { min: 0, max: 100 } : p.key === 'dd' ? { max: 0 } : {}),
      axisLabel: { color: PALETTE.muted, fontSize: 11 }, splitLine: { lineStyle: { color: PALETTE.grid } } })),
    dataZoom: [{ type: 'inside', xAxisIndex: PANES.map((_, k) => k), filterMode: 'filter' },
      { type: 'slider', xAxisIndex: PANES.map((_, k) => k), height: 16, bottom: 6, filterMode: 'filter' }],
    series: [
      line('nav', 0, s.tqqq, PALETTE.text, { lineStyle: { width: 1.4, color: PALETTE.text } }),
      { id: 'in', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, large: true, barGap: '-100%', data: flowYi.map(v => (v > 0 ? v : null)), itemStyle: { color: RED } },
      { id: 'out', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, large: true, data: flowYi.map(v => (v < 0 ? v : null)), itemStyle: { color: GREEN } },
      line('dd', 2, s.dd.map(v => fixed(v * 100)), '#58a6ff', { areaStyle: { opacity: 0.12 } }),
      line('fg', 3, s.fg.map(fixed), '#e3b341'),
      line('vix', 4, s.vix.map(fixed), VIX_C),
      line('vxn', 4, s.vxn.map(fixed), VXN_C),
    ],
  }), { notMerge: true });
  chart.dispatchAction({ type: 'dataZoom', startValue: s.dates.find(d => d >= CHART_START), endValue: s.dates.at(-1) });
}
// 門檻線：開著＝紅色虛線＋「開」，關著＝灰色虛線＋「關」。
function thresholdLine(value, on, text, color = RED, position = 'insideStartTop') {
  return { yAxis: value, lineStyle: { type: 'dashed', width: on ? 1.5 : 1, color: on ? color : PALETTE.muted, opacity: on ? 1 : 0.6 },
    label: { show: on || !mob(), position, color: on ? color : PALETTE.muted, fontSize: 11, backgroundColor: PALETTE.bg, padding: [1, 4],
      formatter: `${text}${on ? '（開）' : '（關）'}` } };
}
function markChart() {
  if (!chart) return;
  const p = study.params;
  const evLines = study.events.map(e => ({ xAxis: e.date, label: { show: false }, lineStyle: { type: 'solid', width: 2, color: EVENT_C, opacity: 0.8 } }));
  const merge = (thr, evs = true) => ({ silent: true, symbol: 'none', data: [...(evs ? evLines : []), ...thr] });
  chart.setOption({ series: [
    { id: 'nav', markLine: merge([]),
      markPoint: { silent: true, symbol: 'pin', symbolSize: 26, itemStyle: { color: EVENT_C }, label: { show: false },
        data: study.events.map(e => ({ coord: [e.date, series.tqqq[e.i]] })) } },
    { id: 'in', markLine: merge(p.thrMode === 'usd' ? [thresholdLine(+(p.thr / 1e8).toFixed(1), true, `門檻 ${(p.thr / 1e8).toFixed(0)} 億`)] : []) },
    { id: 'dd', markLine: merge(p.ddMin > 0 ? [thresholdLine(-p.ddMin * 100, true, `門檻 −${(p.ddMin * 100).toFixed(0)}%`)] : []) },
    { id: 'fg', markLine: merge([thresholdLine(p.fgMax, p.fgOn, `≤ ${p.fgMax}`)]) },
    { id: 'vix', markLine: merge([thresholdLine(p.vixMin, p.vixOn, `VIX ≥ ${p.vixMin}`, VIX_C, 'insideStartBottom')]) },
    { id: 'vxn', markLine: merge([thresholdLine(p.vxnMin, p.vxnOn, `VXN ≥ ${p.vxnMin}`, VXN_C, 'insideEndTop')], false) },
  ] });
}

// ── 表 ──────────────────────────────────────────────────────────────────
function renderTables() {
  const p = study.params, H = C.HORIZONS;
  const evs = study.events.filter(e => group === 'all' || e.group === group);
  const isN = study.events.filter(e => e.group === 'is').length, oosN = study.events.length - isN;
  const pending = study.events.filter(e => e.ret[asset][60] == null).length;
  byId('summary-note').textContent = `條件：單日淨流入 ≥ ${thrText(p)}・${ddText(p)}${filterText(p) ? `・${filterText(p)}` : ''}・冷卻 ${p.cooldown ? `${p.cooldown} 個交易日` : '無'}・${lagText(p)}。`
    + `共 ${study.events.length} 筆（樣本內 ${isN}、樣本外 ${oosN}）${pending ? `，${pending} 筆還沒滿 60 日` : ''}。`
    + (evs.length && evs.length < 5 ? ' 這個期間不到 5 筆，平均數只是幾個個案。' : '')
    + ' 紅＝上漲、綠＝下跌。「平常日子」＝沒有訊號的所有交易日；「同條件」＝回撤／情緒條件也成立、只差流入沒到門檻的日子。';

  if (!evs.length) {
    byId('events').replaceChildren(node('p', `${GROUP_LABEL[group]}在目前條件下沒有事件。`, { class: 'tqqqflow-note' }));
    byId('summary').replaceChildren();
  } else {
    table('events', ['流量日 T', '進場日', '淨流入', '占規模', 'QQQ 回撤', '恐懼貪婪', 'VIX', 'VXN', ...H.map(h => `${h} 日`), '60 日內最大跌幅'],
      [...evs].reverse().map(e => {
        const date = node('span', e.date);
        if (e.overlap) date.append(node('span', '重疊', { class: 'tqqqflow-tag', title: '和前一筆事件相隔不到 60 個交易日' }));
        return [date, e.entryDate ?? '待公布', yi(e.flow), pct(e.pct), pct(e.dd), num(e.fg, 0), num(e.vix, 1), num(e.vxn, 1), ...H.map(h => signed(e.ret[asset][h])),
          e.mae[asset][60] == null ? '—' : signed(e.mae[asset][60])];
      }));
    const st = study.stats[group][asset], row = (label, f, fmt = signed) => [label, ...H.map(h => { const v = f(st[h]); return v == null ? '—' : fmt(v); })];
    const plain = v => pct(v);
    // 不到 5 筆時中位數／最大／最小就是上表的個別數字，省略。
    const few = Math.max(...H.map(h => st[h].n)) < 5;
    const rows = [['樣本數', ...H.map(h => `${st[h].n}${few ? '（太少）' : ''}`)], row('平均', x => x.mean),
      ...(few ? [] : [row('中位數', x => x.median), row('最大', x => x.max), row('最小', x => x.min)]),
      row('勝率', x => x.win, v => `${(v * 100).toFixed(0)}%`)];
    const sep = [1, rows.length];
    rows.push(row('平均最大跌幅', x => x.maeMean), row('最差最大跌幅', x => x.maeWorst));
    sep.push(rows.length);
    rows.push(row('平常日子平均', x => x.base, plain), row('超額（比平常日子）', x => x.excess));
    if (C.hasMarketFilter(p)) rows.push(row('同條件、流入未達平均', x => x.mktBase, plain), row('超額（比同條件日子）', x => x.mktExcess));
    table('summary', [`${asset}・${GROUP_LABEL[group]}`, ...H.map(h => `${h} 日`)], rows, { sepRows: sep });
  }

  const cmp = C.ASSETS.map(a => {
    const st = study.stats[group][a];
    return [a, `${st[20].n}`, signed(st[20].mean), signed(st[20].excess), signed(st[60].mean), signed(st[60].excess),
      finite(st[60].win) ? `${(st[60].win * 100).toFixed(0)}%` : '—', signed(st[60].maeMean)];
  });
  table('compare', [GROUP_LABEL[group], '事件數', '20 日平均', '20 日超額', '60 日平均', '60 日超額', '60 日勝率', '60 日平均最大跌幅'], cmp);
}

const DDS = [0, 0.05, 0.10, 0.15];
function renderSens() {
  const p = study.params;
  const grid = C.sensitivity(series, p, { asset, horizon: 20, dds: DDS });
  const t = table('sens', [`${asset} 20 日超額`, ...DDS.map(d => (d ? `回撤 ≥ ${d * 100}%` : '不限回撤'))],
    grid.map(r => [thrText(r), ...r.cells.map(c => {
      const el = node('span');
      el.append(node('span', `${c.n} 筆 `, { class: 'tqqqflow-dim' }), signed(c.excess));
      return el;
    })]));
  grid.forEach((r, ri) => r.cells.forEach((c, ci) => {
    if (r.thrMode === p.thrMode && r.thr === p.thr && c.ddMin === p.ddMin) t.tBodies[0].rows[ri].cells[ci + 1].classList.add('tqqqflow-cur');
  }));
  return grid;
}

// 頂部一句話結論：目前條件幾筆、有沒有統計意義、放寬門檻後還成不成立、今天狀態。
function renderVerdict(grid) {
  const p = study.params, st = study.stats.all[asset][20], n = study.events.length, now = C.currentStatus(series, study);
  const parts = [`歷史上 <b>${n} 筆</b>${n < 5 ? '（太少，僅參考）' : ''}`];
  if (st.n) parts.push(`${asset} 20 日平均 ${pct(st.mean)}、超額 ${pct(st.excess)}`);
  const col = DDS.indexOf(p.ddMin);
  const wide = grid.filter(r => !(r.thrMode === p.thrMode && r.thr === p.thr) && (r.thr === 5e8 || r.thrMode === 'pct'))
    .map(r => ({ r, c: col >= 0 ? r.cells[col] : null })).filter(x => x.c && x.c.n > n);
  if (wide.length) parts.push(`放寬門檻、樣本較多時：${wide.map(({ r, c }) => `${thrText(r)} ${c.n} 筆、超額 ${pct(c.excess)}`).join('；')}`);
  const fails = [!now.flowHit && `流入（${yi(now.flow)}，門檻 ${thrText(p)}）`, p.ddMin > 0 && !now.ddHit && `回撤（${pct(now.dd)}，門檻 −${(p.ddMin * 100).toFixed(0)}%）`,
    ...Object.entries(FILTERS).filter(([k]) => p[`${k}On`] && !now[`${k}Hit`]).map(([k, [name, op, d]]) => `${name}（${num(now[k], d)}，門檻 ${op} ${p[LIMIT(k)]}）`)].filter(Boolean);
  byId('verdict').innerHTML = `<div><b>今天 ${now.date}</b>：${now.signal ? '<b>觸發</b>' : `未觸發${fails.length ? `，差在${fails.join('、')}` : ''}`}。</div>`
    + `<div><b>歷史</b>（${ddText(p)}${filterText(p) ? `・${filterText(p)}` : ''}）：${parts.join('；')}。</div>`;
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
  for (const k of Object.keys(FILTERS)) {
    const on = params[`${k}On`], sw = switchOf(k);
    setActive(k, `tqqqflow${k[0].toUpperCase()}${k.slice(1)}`, `${params[LIMIT(k)]}`);
    sw.setAttribute('aria-checked', String(on)); sw.textContent = on ? '開' : '關'; sw.disabled = missing.includes(k);
    sw.closest('.tqqqflow-filter').classList.toggle('is-off', !on);
  }
  setActive('preset', 'tqqqflowPreset', sameParams(params, C.DEFAULTS) ? 'spec' : sameParams(params, C.CHART_PRESET) ? 'chart' : '');
}
function recompute() {
  study = C.runStudy(series, params);
  syncChips(); renderNow(); markChart(); renderTables(); renderVerdict(renderSens());
}
function wire() {
  if (!bindOnce(byId('thr'))) return;
  chipPicker(byId('thr'), 'tqqqflow-thr', v => { const [m, x] = v.split(':'); params = { ...params, thrMode: m, thr: Number(x) }; recompute(); });
  chipPicker(byId('dd'), 'tqqqflow-dd', v => { params = { ...params, ddMin: Number(v) }; recompute(); });
  chipPicker(byId('cool'), 'tqqqflow-cool', v => { params = { ...params, cooldown: Number(v) }; recompute(); });
  chipPicker(byId('lag'), 'tqqqflow-lag', v => { params = { ...params, lag: Number(v) }; recompute(); });
  for (const k of Object.keys(FILTERS)) {
    // 點門檻 chip 視同打開這個條件；開關按鈕只切換開／關，保留選過的門檻。
    chipPicker(byId(k), `tqqqflow-${k}`, v => { if (missing.includes(k)) return; params = { ...params, [`${k}On`]: true, [LIMIT(k)]: Number(v) }; recompute(); });
    switchOf(k).addEventListener('click', () => { params = { ...params, [`${k}On`]: !params[`${k}On`] }; recompute(); });
  }
  chipPicker(byId('preset'), 'tqqqflow-preset', v => { params = { ...(v === 'chart' ? C.CHART_PRESET : C.DEFAULTS) }; recompute(); });
  chipPicker(byId('asset'), 'tqqqflow-asset', v => { asset = v; renderNow(); renderTables(); renderVerdict(renderSens()); });
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
  byId('status').textContent = missing.length ? `部分資料載入失敗：${missing.map(k => FILTERS[k][0]).join('、')}（對應開關停用）` : '';
  wire(); drawChart(); recompute();
}
export function getCharts() { return chart ? [chart] : []; }
export function resize() { chart?.resize(); }
export function onThemeChange() {
  if (!series) return;
  return preserveChartState(getCharts, () => { chart?.dispose(); chart = null; drawChart(); markChart(); });
}
