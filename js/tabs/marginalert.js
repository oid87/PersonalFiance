// 融資去槓桿警報 — 可互動的歷史回測。
// 引擎：js/tabs/marginalert_calc.mjs（純函式；與 scripts/backtest_margin_delever.mjs 共用同一份）。
// 資料：data/TWII.json、data/taiwan_margin_total.json（必要）；data/taiwan_margin_ratio_mm.json、
//       data/taiwan_margin_ratio.json（選用，重建維持率；缺少時只停用規則 B，明示 partial）。
// 這是研究／風險警示工具：不修改任何正式交易條件，警報 ≠ 買入訊號，融資減少 ≠ 斷頭。

import { echartsBase, isLight, PALETTE, mob } from '../utils/theme.js';
import { requestJSON } from '../utils/data.js';
import { tooltipPosition } from '../utils/tooltip.js';
import { preserveChartState } from '../utils/chartLifecycle.js';
import {
  DEFAULTS, CASES, runFullBacktest, mergeRatio, singleDayFlags, evaluateFlags, GATES, median, fearAnalysis, clampFear,
} from './marginalert_calc.mjs';

const TAB_ID = 'marginalert';
const $ = id => document.getElementById(`${TAB_ID}-${id}`);

let chart = null;
let raw = null;        // { twii, margin, ratio, ratioInfo, partial }
let res = null;        // runFullBacktest 結果
let sel = null;        // 目前選擇門檻×閘門的事件評估
let fear = null;       // 恐懼貪婪 × 目前警報 的對照（無 F&G 資料時為 null）
let ui = { fg: true, fearThr: 15, th: 3, gate: 0, caseId: 'A', lookback: 120, entry: 'nextOpen', cooldown: 10, minIdxDrop: 1, start: DEFAULTS.start, end: null };
let wired = false;

// ── 格式化 ───────────────────────────────────────────────────────────
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const f = (x, d = 1) => (isNum(x) ? x.toFixed(d) : '—');
const sg = (x, d = 1) => (isNum(x) ? (x > 0 ? '+' : '') + x.toFixed(d) : '—');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const tbl = (head, rows, cls = '') =>
  `<div class="table-scroll" tabindex="0" role="region" aria-label="回測表格"><table class="info-table ${cls}"><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${
    rows.map(r => `<tr>${r.map(c => `<td>${c ?? ''}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const fwd = (fw, h) => { const s = fw?.[h]; return s && s.n ? `${sg(s.retMedian)} / ${sg(s.retMean)}` : '—'; };
const neg = (x, d = 1) => (isNum(x) ? `-${x.toFixed(d)}%` : '—');

// ── 載入 ─────────────────────────────────────────────────────────────
function usableRows(payload, keys, label) {
  const rows = payload?.data;
  if (!Array.isArray(rows) || !rows.some(r => typeof r?.date === 'string' && keys.every(k => Number.isFinite(r[k])))) {
    throw new Error(`${label} 資料格式不完整`);
  }
  return rows;
}

async function loadAll(context = {}) {
  if (raw) return;
  const [tw, mg] = await Promise.all([
    requestJSON('data/TWII.json', { signal: context.signal }),
    requestJSON('data/taiwan_margin_total.json', { signal: context.signal }),
  ]);
  const twii = usableRows(tw, ['open', 'high', 'low', 'close'], '加權指數');
  const margin = usableRows(mg, ['margin_money'], '上市融資餘額');
  let mm = [], rc = [], partial = null;
  try {
    const [a, b] = await Promise.all([
      requestJSON('data/taiwan_margin_ratio_mm.json', { signal: context.signal }),
      requestJSON('data/taiwan_margin_ratio.json', { signal: context.signal }),
    ]);
    mm = Array.isArray(a?.data) ? a.data : [];
    rc = Array.isArray(b?.data) ? b.data : [];
  } catch (e) {
    if (context.signal?.aborted) throw e;
    partial = '重建維持率資料載入失敗：規則 B 停用（不估算）';
  }
  let fearGreed = [];
  try {
    const g = await requestJSON('data/fear_greed.json', { signal: context.signal });
    fearGreed = Array.isArray(g?.data) ? g.data : [];
    if (!fearGreed.length) throw new Error('empty');
  } catch (e) {
    if (context.signal?.aborted) throw e;
    partial = (partial ? partial + '；' : '') + '恐懼貪婪資料載入失敗：F&G 圖層與區間停用';
  }
  if (context.signal?.aborted || context.isCurrent?.() === false) return;
  const merged = mergeRatio(mm, rc);
  if (!merged.rows.length && !partial) partial = '無維持率資料：規則 B 停用（不估算）';
  const lastDate = margin.reduce((m, r) => (r.date > m ? r.date : m), '');
  raw = { twii, margin, ratio: merged.rows, fearGreed, ratioInfo: merged, partial, lastDate, marginUpdated: mg.updated, source: mg.source };
  ui.end = lastDate;
}

// ── 回測 ─────────────────────────────────────────────────────────────
function currentCfg() {
  const ths = [...new Set([2, 3, 4, 5, ui.th])].sort((a, b) => a - b);
  return { fearThr: ui.fearThr, start: ui.start, end: ui.end, lookback: ui.lookback, entry: ui.entry, cooldown: ui.cooldown, minIdxDrop: ui.minIdxDrop, thresholds: ths };
}
function recompute() {
  res = runFullBacktest({ twii: raw.twii, margin: raw.margin, ratio: raw.ratio, fearGreed: raw.fearGreed }, currentCfg());
  deriveSelection();
}
function deriveSelection() {
  const { ds, cfg } = res;
  const flags = singleDayFlags(ds, ui.th).filter(i => ds.days[i].dd >= ui.gate);
  sel = { flags, ...evaluateFlags(ds, flags, cfg) };
  fear = raw.fearGreed?.length ? fearAnalysis(ds, ui.fearThr, flags, cfg) : null;
}

// ── 圖 ───────────────────────────────────────────────────────────────
// F&G < thr 的連續區段 → markArea 的 [start,end] 對
function fearSegments(days, thr) {
  const segs = [];
  let start = null, prev = null;
  for (const d of days) {
    if (isNum(d.fg) && d.fg < thr) { if (start === null) start = d.date; prev = d.date; }
    else if (start !== null) { segs.push([start, prev]); start = null; }
  }
  if (start !== null) segs.push([start, prev]);
  return segs;
}

function buildOption() {
  const { ds } = res;
  const days = ds.days;
  const showFg = ui.fg && !!raw.fearGreed?.length;
  const fearAreas = showFg ? fearSegments(days, ui.fearThr).map(([a, b]) => [{ xAxis: a, itemStyle: { color: 'rgba(163,113,247,0.22)' } }, { xAxis: b }]) : [];
  const dates = days.map(d => d.date);
  const firstSet = new Set(sel.events.map(e => e.startIdx));
  const first = sel.events.map(e => [e.date, days[e.startIdx].close]);
  const rest = sel.flags.filter(i => !firstSet.has(i)).map(i => [days[i].date, days[i].close]);
  const areaData = CASES.filter(c => dates.some(d => d >= c.from && d <= c.to)).map(c => [
    { name: c.id === 'A' || c.id === 'B' ? `Case ${c.id}` : c.id === 'S1' ? '2020/3' : '2025/4', xAxis: nearest(dates, c.from), itemStyle: { color: PALETTE.grid, opacity: 0.6 } },
    { xAxis: nearest(dates, c.to) },
  ]);
  const barColor = v => (isNum(v) && v <= -ui.th ? '#ef4444' : isNum(v) && v < 0 ? '#e3b341' : '#3fb950');
  const axis = (gridIndex, show) => ({
    type: 'category', gridIndex, data: dates, boundaryGap: false,
    axisLine: { lineStyle: { color: PALETTE.muted } }, axisLabel: { color: PALETTE.muted, fontSize: 11, show },
    axisTick: { show: false }, splitLine: { show: false },
  });
  const yAxis = (gridIndex, name, extra = {}) => ({
    type: 'value', gridIndex, name, scale: true, nameTextStyle: { color: PALETTE.muted, fontSize: 10 },
    axisLabel: { color: PALETTE.muted, fontSize: 11 }, splitLine: { lineStyle: { color: PALETTE.grid } }, ...extra,
  });
  const L = mob() ? 44 : 60, Rr = mob() ? 12 : 24;
  return echartsBase({
    animation: false,
    legend: { top: 0, textStyle: { color: PALETTE.muted, fontSize: 11 }, data: ['加權指數', `警報首日(≤-${ui.th}%)`, '同波續發日', '融資餘額(億)', '融資單日%', ...(showFg ? ['恐懼貪婪'] : [])] },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'cross' }, backgroundColor: PALETTE.bg, borderColor: PALETTE.border, textStyle: { color: PALETTE.text, fontSize: 12 },
      formatter(params) {
        const i = params?.[0]?.dataIndex;
        const d = days[i];
        if (!d) return '';
        const fired = isNum(d.m[1]) && d.m[1] <= -ui.th;
        return `<b>${d.date}</b>${fired ? ' 🔔' : ''}<br>加權 ${f(d.close, 0)}（${sg(d.x[1], 2)}%）｜距${res.cfg.lookback}日高 -${f(d.dd)}%<br>` +
          `融資 ${f(d.margin, 0)} 億｜單日 ${sg(d.m[1], 2)}%（${sg(d.dm1, 0)} 億）<br>3日 ${sg(d.m[3])}%｜5日 ${sg(d.m[5])}%｜維持率(重建) ${f(d.ratio, 1)}` +
          (d.r4 ? `<br>四週高點 ${f(d.r4.high, 1)}（${d.r4.date}）→ 現在 ${f(d.ratio, 1)}：${sg(d.r4.diff, 1)} 點` : '') +
          (isNum(d.fg) ? `<br>恐懼貪婪 ${f(d.fg, 1)}${d.fg < ui.fearThr ? `（< ${ui.fearThr} 恐懼區）` : ''}` : '');
      },
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: showFg ? [
      { left: L, right: Rr, top: 34, height: '34%' },
      { left: L, right: Rr, top: '50%', height: '12%' },
      { left: L, right: Rr, top: '65%', height: '10%' },
      { left: L, right: Rr, top: '78%', height: '10%' },
    ] : [
      { left: L, right: Rr, top: 34, height: '46%' },
      { left: L, right: Rr, top: '58%', height: '16%' },
      { left: L, right: Rr, top: '78%', height: '12%' },
    ],
    xAxis: showFg ? [axis(0, false), axis(1, false), axis(2, false), axis(3, true)] : [axis(0, false), axis(1, false), axis(2, true)],
    yAxis: [yAxis(0, '加權指數', { min: 'dataMin' }), yAxis(1, '融資(億)', { min: 'dataMin' }), yAxis(2, '單日%', { scale: false }),
      ...(showFg ? [yAxis(3, '恐懼貪婪', { scale: false, min: 0, max: 100 })] : [])],
    dataZoom: [
      { type: 'inside', xAxisIndex: showFg ? [0, 1, 2, 3] : [0, 1, 2], filterMode: 'filter' },
      { type: 'slider', xAxisIndex: showFg ? [0, 1, 2, 3] : [0, 1, 2], height: 16, bottom: 6, filterMode: 'filter' },
    ],
    series: [
      { name: '加權指數', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: days.map(d => d.close), showSymbol: false,
        lineStyle: { width: 1.3, color: PALETTE.text }, itemStyle: { color: PALETTE.text },
        markArea: { silent: true, label: { color: PALETTE.muted, fontSize: 10 }, data: [...areaData, ...fearAreas] } },
      { name: `警報首日(≤-${ui.th}%)`, type: 'scatter', xAxisIndex: 0, yAxisIndex: 0, data: first, symbol: 'triangle', symbolSize: 12, itemStyle: { color: '#ef4444' }, z: 5 },
      { name: '同波續發日', type: 'scatter', xAxisIndex: 0, yAxisIndex: 0, data: rest, symbol: 'circle', symbolSize: 6, itemStyle: { color: '#e3b341' }, z: 4 },
      { name: '融資餘額(億)', type: 'line', xAxisIndex: 1, yAxisIndex: 1, data: days.map(d => d.margin), showSymbol: false, lineStyle: { width: 1.2, color: '#58a6ff' }, itemStyle: { color: '#58a6ff' },
        markArea: { silent: true, data: fearAreas } },
      { name: '融資單日%', type: 'bar', xAxisIndex: 2, yAxisIndex: 2, data: days.map(d => ({ value: isNum(d.m[1]) ? +d.m[1].toFixed(3) : null, itemStyle: { color: barColor(d.m[1]) } })),
        markLine: { silent: true, symbol: 'none', label: { formatter: `-${ui.th}%`, color: PALETTE.muted, fontSize: 10 }, lineStyle: { color: '#ef4444', type: 'dashed' }, data: [{ yAxis: -ui.th }] },
        markArea: { silent: true, data: fearAreas } },
      ...(showFg ? [{ name: '恐懼貪婪', type: 'line', xAxisIndex: 3, yAxisIndex: 3, data: days.map(d => (isNum(d.fg) ? d.fg : null)), showSymbol: false, connectNulls: false,
        lineStyle: { width: 1.2, color: '#a371f7' }, itemStyle: { color: '#a371f7' },
        markLine: { silent: true, symbol: 'none', label: { formatter: `<${ui.fearThr}`, color: PALETTE.muted, fontSize: 10 }, lineStyle: { color: '#a371f7', type: 'dashed' }, data: [{ yAxis: ui.fearThr }] },
        markArea: { silent: true, data: fearAreas } }] : []),
    ],
  });
}
// 點個案 chip 時把圖放大到該個案前後各約 15 個交易日
function zoomToCase() {
  const cs = res?.cases.find(c => c.id === ui.caseId);
  if (!cs || !chart) return;
  const dates = res.ds.days.map(d => d.date);
  const a = Math.max(0, dates.indexOf(nearest(dates, cs.from)) - 15);
  const b = Math.min(dates.length - 1, dates.indexOf(nearest(dates, cs.to)) + 15);
  chart.dispatchAction({ type: 'dataZoom', startValue: a, endValue: b });
}
function nearest(dates, d) {
  const hit = dates.find(x => x >= d);
  return hit ?? dates.at(-1);
}

function fearCard(ds) {
  const card = (v, sub) => `<div class="lev-card" style="min-width:220px"><div class="lc-sub">恐懼貪婪指數（CNN）</div><div class="lc-val">${v}</div><div class="lc-sub">${sub}</div></div>`;
  if (!fear) return card('—', '無 F&G 資料');
  const last = [...ds.days].reverse().find(d => isNum(d.fg));
  const lift = isNum(fear.lift) ? `lift ${f(fear.lift, 1)}` : 'lift —';
  return card(last ? `${f(last.fg, 1)}${last.fg < ui.fearThr ? ' 😨' : ''}` : '—',
    `${last ? esc(last.date) : ''}｜<${ui.fearThr} 共 ${fear.fearDays} 日（${f(fear.fearShare)}%）｜${lift}`);
}

function ratioCard(ds) {
  const d = ds.days.at(-1);
  const card = (v, sub) => `<div class="lev-card" style="min-width:220px"><div class="lc-sub">融資維持率（重建）｜四週內高點 → 現在</div><div class="lc-val">${v}</div><div class="lc-sub">${sub}</div></div>`;
  if (!d?.r4) return card('—', '無維持率資料');
  return card(`${sg(d.r4.diff, 1)} 點`, `高點 ${f(d.r4.high, 1)}（${esc(d.r4.date)}）→ 現在 ${f(d.ratio, 1)}（${esc(d.date)}）`);
}

// ── 卡片 ─────────────────────────────────────────────────────────────
function renderSummary() {
  const { ds } = res;
  const evs = sel.events;
  const f20 = sel.forward[20], f60 = sel.forward[60];
  const card = (k, v, s = '') => `<div class="lev-card" style="min-width:132px"><div class="lc-sub">${esc(k)}</div><div class="lc-val">${v}</div><div class="lc-sub">${s}</div></div>`;
  const ddMed = median(evs.map(e => e.day.dd));
  $('summary').innerHTML = [
    card('觸發日 / 獨立事件', `${sel.flagDays} / ${evs.length}`, `連續≥2日事件 ${sel.clusters2plus}｜冷卻 ${res.cfg.cooldown} 日`),
    card('事件首日回撤(中位)', neg(ddMed), `${res.cfg.lookback} 日高點（當時已知）`),
    card('20日報酬 中位/均', fwd(sel.forward, 20), `n=${f20?.n ?? 0}｜隔日${res.cfg.entry === 'nextOpen' ? '開盤' : '收盤'}進場`),
    card('60日報酬 中位/均', fwd(sel.forward, 60), `n=${f60?.n ?? 0}`),
    card('20日內再破警報日低點', f20?.n ? `${f(f20.breakLowPct, 0)}%` : '—', `20日最大回撤中位 ${neg(f20 ? -f20.mddMedian : null)}`),
    ratioCard(ds),
    fearCard(ds),
    card('基準：所有日 20日中位', sg(res.baseline.all.forward[20].retMedian) + '%', `回撤≥10%的日子 ${sg(res.baseline.dd10.forward[20].retMedian)}%`),
  ].join('');
  $('status').textContent = `${ds.days[0]?.date}～${ds.days.at(-1)?.date}｜${ds.days.length} 個訊號日｜資料更新 ${raw.marginUpdated ?? '—'}${raw.partial ? `｜⚠ ${raw.partial}` : ''}`;
}

// ── 表格 ─────────────────────────────────────────────────────────────
function tableEvents() {
  const rows = sel.events.map(e => {
    const h = e.fwd?.h;
    const cell = k => (h?.[k] ? sg(h[k].ret) : '—');
    return [e.date, `${f(e.day.m[1], 2)}%`, `${sg(e.day.x[1], 2)}%`, neg(e.day.dd), e.triggerDays, cell(5), cell(10), cell(20), cell(60),
      h?.[20] ? f(h[20].mdd) + '%' : '—', h?.[20] ? (h[20].breakLow ? '是' : '否') : '—'];
  });
  const sum = res.cfg.horizons.map(k => { const s = sel.forward[k]; return [`${k} 日`, s.n, sg(s.retMean) + '%', sg(s.retMedian) + '%', f(s.winRate, 0) + '%', f(s.mddMedian) + '%', f(s.mddWorst) + '%', f(s.rallyMedian) + '%', f(s.breakLowPct, 0) + '%', f(s.daysToLowMedian, 0)]; });
  return tbl(['持有', 'n', '報酬均值', '報酬中位', '勝率', '最大回撤中位', '最差回撤', '最大反彈中位', '再破警報日低點', '最低點距警報日(日)'], sum) +
    tbl(['事件首日', '融資%', '當日指數%', '回撤', '連續日', '5日%', '10日%', '20日%', '60日%', '20日最大回撤', '20日內再破低'], rows);
}
function tableAnnual() {
  const ths = res.cfg.thresholds;
  return tbl(['年', '交易日', ...ths.map(t => `≥${t}% 日/事件/多日`), '最大單日減幅', '當日指數', '當日回撤'],
    res.annual.map(a => [a.year, a.tradingDays, ...ths.map(t => `${a.byTh[t].days}/${a.byTh[t].events}/${a.byTh[t].multiDay}`),
      a.maxDrop ? `${f(a.maxDrop.pct, 2)}%（${a.maxDrop.date}）` : '—', a.maxDrop ? `${sg(a.maxDrop.idx1, 2)}%` : '—', a.maxDrop ? neg(a.maxDrop.dd) : '—'])) +
    `<p class="text-muted-sm">門檻是巢狀的：-5% 同時算進 2/3/4/5。「事件」＝相隔超過 ${res.cfg.cooldown} 個交易日才算新事件；「多日」＝該事件連續觸發≥2 日。</p>`;
}
function tableThresholds() {
  const ths = res.cfg.thresholds;
  const head = ['訊號', '觸發日', '獨立事件', '首日回撤中位', '5日', '10日', '20日', '60日', '60日最大回撤中位', '20日再破低'];
  const row = (name, v) => [name, v.flagDays ?? v.n, v.events?.length ?? '—', v.ddFirstEventMedian !== undefined ? neg(v.ddFirstEventMedian) : '—',
    fwd(v.forward, 5), fwd(v.forward, 10), fwd(v.forward, 20), fwd(v.forward, 60), f(v.forward[60].mddMedian) + '%', v.forward[20].n ? f(v.forward[20].breakLowPct, 0) + '%' : '—'];
  const main = tbl(head, [...ths.map(t => row(`單日≤-${t}%`, res.thresholds[t])),
    row('基準：所有日', res.baseline.all), row('基準：回撤≥10%', res.baseline.dd10), row('基準：回撤≥15%', res.baseline.dd15)]);
  const gate = tbl(['融資', '回撤閘門', '觸發日', '獨立事件', '波段命中', '距低點中位(日)', '剩餘跌幅中位', '20日 中/均', '60日最大回撤中位', '20日再破低'],
    res.gated.map(g => [`≤-${g.th}%`, g.gate ? `≥${g.gate}%` : '無', g.flagDays, g.events, `${g.waveHit}/${g.waveTotal}`, f(g.leadMedian, 0), sg(g.remainingMedian) + '%', fwd(g.forward, 20), f(g.forward[60].mddMedian) + '%', g.forward[20].n ? f(g.forward[20].breakLowPct, 0) + '%' : '—']));
  return `<p class="text-muted-sm">報酬欄＝中位 / 均值（%）。基準＝所有（或回撤≥N%的）訊號日用同一進場規則。</p>${main}<h4>融資減幅 × 指數回撤閘門（${GATES.join('/')}%）</h4>${gate}`;
}
function tableBands() {
  const b = res.bands120;   // 欄位名沿用；實際回撤用 cfg.lookback
  return `<p class="text-muted-sm">回撤＝收盤相對過去 ${res.cfg.lookback} 日最高收盤（含當日，不用未來資料）。各欄為該區間內「發生」的比例；「之後60日再下跌」只用於事後描述。</p>` +
    tbl(['回撤區間', '交易日', '≤-2%', '≤-3%', '≤-4%', '連2日≤-2%', '3日≤-5%', '5日≤-8%', '之後60日再下跌(中位)', '距低點(日,中位)'],
      b.map(r => [r.label, r.n, ...[r.p2, r.p3, r.p4, r.consec2, r.m3_5, r.m5_8].map(v => f(v) + '%'), f(r.remainMedian) + '%', f(r.daysToLowMedian, 0)])) +
    `<h4>客觀下跌波段</h4>` + tbl(['波段高點', '進入(回撤≥10%)', '波段低點', '結束(<5%)', '最大回撤'],
      res.waves.map(w => [w.peakDate, w.startDate, w.lowDate, w.endDate + (w.open ? '（未結束）' : ''), neg(w.maxDd)]));
}
function tableWindows() {
  const rd = res.rd[res.cfg.minIdxDrop] ?? res.rd[1];
  return tbl(['窗口', '門檻', '觸發日', '獨立事件', '首日回撤中位', '5日', '10日', '20日', '60日', '60日最大回撤中位', '20日再破低'],
    res.windows.map(w => [`${w.N}日`, `≤-${w.th}%`, w.flagDays, w.events, neg(w.ddFirstEventMedian), fwd(w.forward, 5), fwd(w.forward, 10), fwd(w.forward, 20), fwd(w.forward, 60), f(w.forward[60].mddMedian) + '%', w.forward[20].n ? f(w.forward[20].breakLowPct, 0) + '%' : '—'])) +
    `<h4>R／D（指數跌幅下限 ${res.cfg.minIdxDrop}%）</h4><p class="text-muted-sm">R=|融資變動|/|指數變動|；D=|融資|-|指數|（百分點）。指數上漲而融資下降＝「反彈中的去槓桿」，另列、不套 R。指數跌幅不足下限的日子不算（R 會失真）。</p>` +
    tbl(['窗口', '有效下跌樣本', 'R中位', 'D中位', 'R≥1', 'R≥1.5', 'R≥2', '反彈中去槓桿(日)', '20日中位：全部/R≥1/R≥1.5/反彈中'],
      res.cfg.windows.map(N => { const v = rd[N]; return [`${N}日`, v.validFall, f(v.RMedian, 2), f(v.DMedian, 2), v.R_ge1, v.R_ge15, v.R_ge2, v.rebound, [v.fwd20_all, v.fwd20_R1, v.fwd20_R15, v.fwd20_rebound].map(x => sg(x)).join(' / ')]; }));
}
function tableRules() {
  const mk = rs => tbl(['變體(C 條件)', '候選日', '獨立事件', '重複度(日/事)', '波段命中', '首次觸發距低點(日,中位)', '剩餘跌幅中位', '首次觸發回撤中位', '20日 中/均', '60日最大回撤中位', '20日再破低'],
    rs.map(r => [esc(r.label), r.flagDays, r.events, f(r.dupRatio, 1), `${r.waveHit}/${r.waveTotal}`, f(r.leadMedian, 0), sg(r.remainingMedian) + '%', f(r.ddAtFirstMedian) + '%', fwd(r.forward, 20), f(r.forward[60].mddMedian) + '%', r.forward[20].n ? f(r.forward[20].breakLowPct, 0) + '%' : '—']));
  const noB = raw.ratio.length === 0;
  return `<p class="text-muted-sm">A＝${res.cfg.lookback}日高點回撤≥${res.cfg.ruleDd}%；B＝<b>重建</b>維持率自${res.cfg.lookback}日高點降≥${res.cfg.ruleRatioDrop}個百分點（TWSE 逐檔重建、非官方）；C＝依列。≥2 項才列入。${noB ? '<b>無維持率資料，B 不成立（不估算）。</b>' : ''}</p>` +
    `<h4>2/3 規則（含重建 B）</h4>${mk(res.rules2of3)}<h4>僅 A∧C（不依賴重建維持率）</h4>${mk(res.rulesAC)}`;
}
function tableCase() {
  const cs = res.cases.find(c => c.id === ui.caseId) ?? res.cases[0];
  if (!cs) return '<p>此區間無個案資料（調整回測區間）。</p>';
  const first = obj => [2, 3, 4, 5].map(t => { const v = obj[t]; return v ? [`≥${t}%`, v.date, f(v.m1, 2) + '%', sg(v.idx1, 2) + '%', neg(v.dd), v.tdBeforeLow, sg(v.closeToLowPct) + '%'] : [`≥${t}%`, '未觸發', '', '', '', '', '']; });
  const h = ['警報', '首次日期', '當日融資', '當日指數', '回撤', '距區間低點(日)', '警報日收盤→低點'];
  const cv = cs.converge;
  return `<p><b>${esc(cs.label)}</b>（${cs.from}～${cs.to}）：${res.cfg.lookback}日高點 ${cs.peak.date} ${f(cs.peak.close, 0)} → 區間最低收盤 ${cs.low.date} ${f(cs.low.close, 0)}（${neg(cs.low.dd)}）；融資 ${cs.marginHigh.date} ${f(cs.marginHigh.v, 0)} → ${cs.marginLow.date} ${f(cs.marginLow.v, 0)} 億（${f(cs.marginPeakToLowPct)}%）` +
    `${cs.lowDateMatchesHint === null ? '' : cs.lowDateMatchesHint ? `；指定低點 ${cs.lowHint} 與資料一致` : `；<b>指定低點 ${cs.lowHint} 與資料不一致（資料低點 ${cs.low.date}）</b>`}。${cs.main ? '' : '（壓力測試，不作門檻設計依據）'}</p>` +
    tbl(h, first(cs.first)) +
    (Object.keys(cs.firstSincePeak).length ? `<p class="text-muted-sm">窗口起點晚於波段高點 ${cs.peak.date}：自高點起算的首次警報——</p>${tbl(h, first(cs.firstSincePeak))}` : '') +
    (cv ? `<p class="text-muted-sm">-3% 首次警報前後 5 日指數日跌幅：前 均值 ${sg(cv.beforeMean, 2)}%／≤-2% 共 ${cv.beforeDown2} 日；後 均值 ${sg(cv.afterMean, 2)}%／≤-2% 共 ${cv.afterDown2} 日（n=${cv.afterN}）。</p>` : '') +
    `<details class="ui-details"><summary>逐日明細</summary>${tbl(['日期', '收盤', '指數%', '回撤', '融資億', '融資%', '融資Δ億', '3日%', '5日%', '維持率(重建)', '四週高點(日期)', '距高點(點)'],
      cs.rows.map(r => [r.date, f(r.close, 0), sg(r.x1, 2), f(r.dd), f(r.margin, 0), sg(r.m1, 2), sg(r.dm1, 0), sg(r.m3), sg(r.m5), f(r.ratio, 1), r.r4 ? `${f(r.r4.high, 1)}（${r.r4.date.slice(5)}）` : '—', r.r4 ? sg(r.r4.diff, 1) : '—']))}</details>`;
}
function tableFear() {
  if (!fear) return '<p>無恐懼貪婪資料。</p>';
  const rows = [5, 10, 15, 20, 25].map(t => ({ t, a: fearAnalysis(res.ds, t, sel.flags, res.cfg) }));
  return `<p class="text-muted-sm">F&G &lt; ${ui.fearThr} 視為恐懼區（紫色陰影，可用上方滑桿調 5～25）；警報＝目前選的單日融資門檻（≤-${ui.th}%${ui.gate ? `、回撤≥${ui.gate}%` : ''}）。「相對」＝恐懼日裡警報發生率是否高於非恐懼日（lift&gt;1）。注意：警報多集中在少數幾波，lift 會被少數事件放大；F&G 是美股情緒指數（CNN），2011 年起。</p>` +
    tbl(['F&G <', '恐懼日', '占比', 'P(警報|恐懼)', 'P(警報|非恐懼)', 'lift', '警報日在恐懼區', '事件首日已在恐懼區(含前5日)', '事件首日 F&G 中位'],
      rows.map(({ t, a }) => [`<b>${t === ui.fearThr ? '▶ ' : ''}&lt;${t}</b>`, a.fearDays, f(a.fearShare) + '%', f(a.pAlarmGivenFear) + '%', f(a.pAlarmGivenNot) + '%', f(a.lift, 1),
        `${a.alarmDaysInFear}/${a.alarmDays}（${f(a.pFearGivenAlarm, 0)}%）`, `${a.eventsNearFear}/${a.eventsKnown}`, f(a.fgMedianAtEvent, 1)])) +
    `<h4>逐波段：F&G 最低點／首次進恐懼區 vs 波段低點與首次警報（交易日；正＝早於波段低點）</h4>` +
    tbl(['波段(高點→低點)', '最大回撤', 'F&G 最低(日期)', '最低日距低點', '首次進恐懼區', '距低點', '首次警報', '距低點', '波段內恐懼日', '波段內警報日'],
      fear.waves.map(w => [`${w.peakDate}→${w.lowDate}`, neg(w.maxDd), w.fgMin === null ? '—' : `${f(w.fgMin, 1)}（${w.fgMinDate}）`, w.fgMinToLowTd === null ? '—' : -w.fgMinToLowTd,
        w.firstFearDate ?? '未進入', w.firstFearToLowTd ?? '—', w.firstAlarmDate ?? '未觸發', w.firstAlarmToLowTd ?? '—', w.fearDaysInWave, w.alarmDaysInWave]));
}
function renderTables() {
  $('t-fear').innerHTML = tableFear();
  $('t-events').innerHTML = tableEvents();
  $('t-annual').innerHTML = tableAnnual();
  $('t-thresholds').innerHTML = tableThresholds();
  $('t-bands').innerHTML = tableBands();
  $('t-windows').innerHTML = tableWindows();
  $('t-rules').innerHTML = tableRules();
  $('t-case').innerHTML = tableCase();
  $('sources').innerHTML = sourcesHtml();
}
function sourcesHtml() {
  const g = res.gaps, ri = raw.ratioInfo;
  return `<ul><li>TAIEX：data/TWII.json（${esc(g.twiiRange.join('～'))}，不含股息的收盤指數）。</li>
    <li>上市融資餘額（億元）：${esc(raw.source ?? 'FinMind 大盤融資餘額')}（${esc(g.marginRange.join('～'))}）；與 TWSE MI_MARGN 彙總數逐日交叉比對差異 0（見報告 A）。</li>
    <li>融資維持率：TWSE MI_MARGN×MI_INDEX <b>逐檔重建</b>（上市 only、含 ETF，與券商整戶口徑不同、偏高），${esc(g.ratioRange.join('～'))}，兩個重建檔重疊 ${ri.overlap} 日最大差 ${ri.maxAbsDiff}。僅作規則 B 參考，非官方公布值。</li>
    <li>缺口：成交量／金額沒有可靠資料（TWII volume 恆為 0），未使用；TWII 缺 ${esc(g.marginOnly.join(', ') || '無')}，不補值、該日不當訊號日。</li>
    <li>上市與上櫃不混用；N 日窗各自回推 N 個交易日；警報用收盤後資料，進場最早為隔日（${res.cfg.entry === 'nextOpen' ? '開盤' : '收盤'}）。</li>
    <li>重現：<code>node scripts/backtest_margin_delever.mjs --out docs/research/margin-delever-alert-backtest.md</code>；引擎 <code>js/tabs/marginalert_calc.mjs</code>，測試 <code>npm test</code>。</li></ul>`;
}

// ── 控制 ─────────────────────────────────────────────────────────────
function syncChips() {
  const val = (id, v) => { const el = $(id); if (el) el.value = String(v); };
  const preset = [2, 3, 4, 5].includes(ui.th);
  val('th-select', preset ? ui.th : 'custom');
  const ti = $('th-input'); if (ti) { ti.style.display = preset ? 'none' : ''; ti.value = ui.th; }
  val('gate-select', ui.gate); val('fg-select', ui.fg ? 'on' : 'off'); val('lb-select', ui.lookback);
  val('entry-select', ui.entry); val('mind-select', ui.minIdxDrop); val('case-select', ui.caseId);
  val('fear-range', ui.fearThr);
  const fv = $('fear-val'); if (fv) fv.textContent = ui.fearThr;
  val('cooldown', ui.cooldown); val('start', ui.start); val('end', ui.end);
  const line = $('params-line');
  if (line) line.textContent = `融資≤-${ui.th}%｜閘門${ui.gate ? `≥${ui.gate}%` : '無'}｜F&G ${ui.fg ? `顯示 <${ui.fearThr}` : '隱藏'}｜${ui.lookback}日高點｜隔日${ui.entry === 'nextOpen' ? '開盤' : '收盤'}｜冷卻${ui.cooldown}日｜${ui.start}～${ui.end}`;
}
function draw() {
  renderSummary();
  renderTables();
  return preserveChartState(getCharts, () => { chart.setOption(buildOption(), { notMerge: true }); });
}
function readInputs() {
  if ($('th-select').value === 'custom') {
    const th = Number($('th-input').value);
    if (Number.isFinite(th) && th >= 0.5 && th <= 20) ui.th = Math.round(th * 10) / 10;
  }
  const cd = Math.round(Number($('cooldown').value));
  if (Number.isFinite(cd) && cd >= 0 && cd <= 60) ui.cooldown = cd;
  const s = $('start').value, e = $('end').value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) ui.start = s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(e)) ui.end = e;
  if (ui.start > ui.end) [ui.start, ui.end] = [ui.end, ui.start];
}
function rerun(fromInputs = true) {
  if (fromInputs) readInputs();
  syncChips();
  const t0 = performance.now();
  recompute();
  draw();
  $('timing').textContent = `重跑 ${Math.round(performance.now() - t0)} ms`;
}
// ⓘ 說明：點一下顯示、再點一下（或點別處／Esc）關閉；同時只開一個
let pop = null, popBtn = null;
function closeInfo() {
  if (popBtn) { popBtn.setAttribute('aria-expanded', 'false'); popBtn.removeAttribute('aria-describedby'); }
  if (pop) pop.hidden = true;
  popBtn = null;
}
function placeInfo() {
  if (!pop || !popBtn) return;
  if (!popBtn.isConnected || popBtn.offsetParent === null) { closeInfo(); return; }
  const pos = tooltipPosition(popBtn.getBoundingClientRect(), { width: pop.offsetWidth, height: pop.offsetHeight }, { width: innerWidth, height: innerHeight });
  if (!pos) { closeInfo(); return; }
  pop.style.left = `${pos.left}px`; pop.style.top = `${pos.top}px`;
}
function toggleInfo(btn) {
  if (popBtn === btn) { closeInfo(); return; }
  closeInfo();
  if (!pop) {
    pop = document.createElement('div');
    pop.className = 'ma-pop'; pop.id = `${TAB_ID}-pop`; pop.setAttribute('role', 'tooltip'); pop.hidden = true;
    document.body.append(pop);
  }
  popBtn = btn;
  pop.textContent = btn.dataset.info || '';
  pop.hidden = false;
  btn.setAttribute('aria-expanded', 'true'); btn.setAttribute('aria-describedby', pop.id);
  placeInfo();
}
function wireInfo() {
  document.addEventListener('click', e => {
    const btn = e.target.closest?.('.ma-info');
    if (btn && btn.closest(`#tab-${TAB_ID}`)) { e.preventDefault(); toggleInfo(btn); return; }
    if (popBtn && !pop.contains(e.target)) closeInfo();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeInfo(); });
  window.addEventListener('resize', placeInfo);
  window.addEventListener('scroll', placeInfo, true);
  window.addEventListener('hashchange', closeInfo);
}

function wire() {
  if (wired) return;
  wired = true;
  wireInfo();
  const on = (id, fn) => $(id)?.addEventListener('change', fn);
  on('fg-select', e => { ui.fg = e.target.value === 'on'; syncChips(); draw(); });
  $('fear-range')?.addEventListener('input', e => { ui.fearThr = clampFear(e.target.value); recompute(); syncChips(); draw(); });
  on('th-select', e => {
    if (e.target.value === 'custom') { $('th-input').style.display = ''; $('th-input').focus(); return; }
    ui.th = Number(e.target.value); rerun(false);
  });
  on('gate-select', e => { ui.gate = Number(e.target.value); deriveSelection(); syncChips(); draw(); });
  on('lb-select', e => { ui.lookback = Number(e.target.value); rerun(false); });
  on('entry-select', e => { ui.entry = e.target.value; rerun(false); });
  on('mind-select', e => { ui.minIdxDrop = Number(e.target.value); rerun(false); });
  on('case-select', e => { ui.caseId = e.target.value; $('t-case').innerHTML = tableCase(); zoomToCase(); });
  $('run')?.addEventListener('click', () => rerun(true));
  $('reset')?.addEventListener('click', () => {
    ui = { fg: true, fearThr: 15, th: 3, gate: 0, caseId: 'A', lookback: 120, entry: 'nextOpen', cooldown: 10, minIdxDrop: 1, start: DEFAULTS.start, end: raw.lastDate };
    rerun(false);
  });
  for (const id of ['th-input', 'cooldown', 'start', 'end']) on(id, () => rerun(true));
}

// ── lifecycle ────────────────────────────────────────────────────────
export async function activate(context = {}) {
  const host = $('chart');
  if (!host) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : 'dark');
  try {
    await loadAll(context);
    if (context.signal?.aborted || context.isCurrent?.() === false) return;
    wire();
    syncChips();
    if (!res) recompute();
    await draw();
    chart.resize();
  } catch (e) {
    console.error(`[${TAB_ID}] load failed`, e);
    const s = $('status');
    if (s) s.textContent = '載入失敗：' + (e.message || e);
    throw e;
  }
}
export function onThemeChange(light) {
  closeInfo();
  if (!chart) return;
  const host = $('chart');
  chart.dispose();
  chart = echarts.init(host, light ? null : 'dark');
  if (res) chart.setOption(buildOption(), { notMerge: true });
}
export function resize() { chart?.resize(); }
export function getCharts() { return chart ? [chart] : []; }
