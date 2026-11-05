// VIX 急升回測 — VIX 單日漲幅（盤中最高或收盤 vs 前收）落在自訂區間、或 VIX 水位進入自訂區間的那天之後，
// S&P 500／QQQ／SOXX／台股加權／0050 漲跌多少。
// 版面：一句話結論 → 參數（口徑、區間輸入與快選、標的、進場、冷卻、看幾天後）→ 三格共用時間軸（標的價格、VIX、單日漲幅）
//       → 事件後走勢（每筆淡線＋平均／中位數＋平常日子）→ 各天期平均 → 區間掃描（點長條改區間）→ 統計表、事件表、歷史前 10 名 → 口徑。
// 計算：js/tabs/vixspike_calc.mjs；資料：data/VIX_early.json（只取 1990–1999）＋ data/VIX.json，標的切換時才載入對應檔。
import { isLight, echartsBase, PALETTE, mob } from '../utils/theme.js';
import { requestJSON } from '../utils/data.js';
import { bindOnce, chipPicker } from '../utils/dom.js';
import { preserveChartState, captureChartState, restoreChartState } from '../utils/chartLifecycle.js';
import * as C from './vixspike_calc.mjs';

const byId = id => document.getElementById('vixspike-' + id);
const finite = v => typeof v === 'number' && Number.isFinite(v);
const RED = '#ef4444', GREEN = '#3fb950', ORANGE = '#f0883e', BLUE = '#58a6ff', PURPLE = '#a371f7';
const ASSETS = {
  SP500: { file: 'data/SP500.json', label: 'S&P 500', next: false },
  QQQ: { file: 'data/QQQ.json', label: '那斯達克 QQQ', next: false },
  SOXX: { file: 'data/SOXX.json', label: '費半 SOXX', next: false },
  TWII: { file: 'data/TWII.json', label: '台股加權', next: true },
  '0050': { file: 'data/0050.TW.json', label: '0050', next: true },
};
const MEASURE = { high: '盤中最高', close: '收盤' };
const PATH_MAX = 120;
const CHART_START = '2005-01-01';

let vix = null, loadedAt = 0, assetData = {};
let params = { ...C.DEFAULTS }, asset = 'SP500', horizon = 20, pathLen = 60;
let study = null, charts = {};

function node(tag, text, attrs = {}) {
  const el = document.createElement(tag);
  if (text != null) el.textContent = text;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}
const pct = (x, d = 1) => (finite(x) ? `${x > 0 ? '+' : ''}${(x * 100).toFixed(d)}%` : '—');
const pct0 = x => (finite(x) ? `${(x * 100).toFixed(0)}%` : '—');
const dirClass = x => (!finite(x) || Math.abs(x) < 5e-4 ? 'vixspike-flat' : x > 0 ? 'vixspike-up' : 'vixspike-down');
const signed = (x, d) => node('span', pct(x, d), { class: dirClass(x) });
const num = (x, d = 2) => (finite(x) ? x.toFixed(d) : '—');
// 單日漲幅用 %（參數是比例），水位用點數。
const isLevel = p => p.kind === 'level';
const U = p => (isLevel(p) ? 1 : 100);
const unit = p => (isLevel(p) ? '' : '%');
const fmtBound = (p, x) => `${Math.round(x * U(p))}${unit(p)}`;
const rangeText = p => (p.hi == null ? `≥ ${fmtBound(p, p.lo)}` : `${fmtBound(p, p.lo)} ～ ${fmtBound(p, p.hi)}`);
const bucketLabel = (p, [lo, hi]) => (hi == null ? `≥${fmtBound(p, lo)}` : `${Math.round(lo * U(p))}–${fmtBound(p, hi)}`);
const fmtVal = (p, x, d = 0) => (isLevel(p) ? num(x, 2) : pct(x, d));
const condText = p => (isLevel(p) ? `VIX ${MEASURE[p.measure]}進入 ${rangeText(p)}（前一天還不在區間）` : `VIX ${MEASURE[p.measure]}比前一天收盤漲 ${rangeText(p)}`);
// 一天的開高低收：開 x・高 x・低 x・收 x（收盤漲跌）・振幅（高低差÷前收）。
const maText = d => (d && finite(d.ma50) ? `50 日均線 ${num(d.ma50)}（收盤${d.close >= d.ma50 ? '高' : '低'}於均線 ${pct0abs(Math.abs(d.close / d.ma50 - 1))}）` : '');
const ohlcText = (d, dp = 2) => (d ? `開 ${num(d.open, dp)}・高 ${num(d.high, dp)}・低 ${num(d.low, dp)}・收 ${num(d.close, dp)}（${pct(d.ch)}）・振幅 ${pct0abs(d.amp)}` : '—');
const pct0abs = x => (finite(x) ? `${(x * 100).toFixed(1)}%` : '—');
const lagText = p => (ASSETS[asset].next ? (p.lag ? '隔天台股再下一個交易日收盤' : '隔天台股收盤') : (p.lag ? 'T+1 收盤' : '當天收盤'));

function table(id, headers, body) {
  const t = node('table'), thead = node('thead'), htr = node('tr'), tb = node('tbody');
  for (const h of headers) htr.append(node('th', h));
  thead.append(htr);
  for (const row of body) {
    const tr = node('tr');
    row.forEach((v, i) => {
      const cell = node(i === 0 ? 'th' : 'td');
      if (v instanceof Node) cell.append(v); else cell.textContent = v ?? '—';
      tr.append(cell);
    });
    tb.append(tr);
  }
  t.append(thead, tb);
  byId(id).replaceChildren(t);
}

// ── data ────────────────────────────────────────────────────────────────
async function loadVix(context) {
  const [early, recent] = await Promise.all([requestJSON('data/VIX_early.json', { signal: context.signal }),
    requestJSON('data/VIX.json', { signal: context.signal })]);
  if (context.signal?.aborted || context.isCurrent?.() === false) return false;
  vix = C.buildVix(early?.data, recent?.data);
  return true;
}
async function loadAsset(key, signal) {
  if (assetData[key]) return assetData[key];
  const j = await requestJSON(ASSETS[key].file, { signal });
  assetData[key] = C.buildAsset((j?.data ?? []).map(r => [r.date, r.close, r.open, r.high, r.low]));
  return assetData[key];
}

// ── 結論 ────────────────────────────────────────────────────────────────
function renderVerdict() {
  const p = study.params, st = study.stats[horizon], now = C.currentStatus(vix, study), a = assetData[asset];
  const used = study.events.filter(e => e.entry != null);
  const skipped = study.events.length - used.length;
  const share = now.rank ? `${(now.rank / now.rankN * 100).toFixed(1)}%` : null;
  const rare = !share ? '' : isLevel(p) ? `；1990 年起 VIX ${MEASURE[p.measure]} ≥ ${num(now.ch)} 的日子占 ${share}`
    : now.ch > 0 ? `；1990 年起單日${MEASURE[p.measure]}漲幅 ≥ 這天的只有 ${now.rank} 天（${share}）` : '';
  const where = isLevel(p) ? (now.inside ? `，<b class="vixspike-hit">在目前區間內${now.hit ? '（今天剛進入）' : ''}</b>` : '，不在目前區間')
    : (now.hit ? '，<b class="vixspike-hit">落在目前區間</b>' : '，不在目前區間');
  const vd = C.vixDay(vix, vix.dates.length - 1);
  const ad = C.assetDay(a, C.entryIndex(vix, a, vix.dates.length - 1, { lag: 0 }, ASSETS[asset].next));
  const lines = [`<b>最新 ${now.date}</b>：VIX ${ohlcText(vd)}${isLevel(p) ? '' : `；盤中最高比前收 ${pct(now.chHigh)}`}${maText(vd) ? `；${maText(vd)}` : ''}`
    + `${where}${rare}。`
    + (ad ? `<br>${ASSETS[asset].label}${ad.date !== now.date ? `（${ad.date}）` : ''}：${ohlcText(ad)}。` : '')];
  if (!used.length) {
    lines.push(`<b>歷史</b>：${condText(p)}，${ASSETS[asset].label}有資料的期間沒有事件。`);
  } else {
    lines.push(`<b>歷史</b>：${condText(p)}，1990 年起 <b>${used.length} 次</b>${skipped ? `（另 ${skipped} 次在 ${ASSETS[asset].label} 有資料前）` : ''}${st.n < 5 ? '，<b>不到 5 次，只是幾個個案</b>' : ''}。`
      + ` ${ASSETS[asset].label} ${horizon} 個交易日後平均 <b>${pct(st.mean)}</b>、中位數 ${pct(st.median)}、上漲機率 ${pct0(st.win)}`
      + `（平常日子平均 ${pct(st.base)}、上漲機率 ${pct0(st.baseWin)}）${st.n < used.length ? `；${used.length - st.n} 次還沒滿 ${horizon} 日` : ''}。`);
    if (st.n) {
      const d = st.excess, md = st.median - st.baseMedian, same = x => Math.abs(x) < 0.005;
      const verb = (x, unit = '') => (same(x) ? '差不多' : `${x > 0 ? '多' : '少'} ${(Math.abs(x) * 100).toFixed(1)} 個百分點${unit}`);
      lines.push(`<b>白話</b>：${horizon} 日後平均比平常日子${verb(d)}，中位數${verb(md)}，上漲機率 ${pct0(st.win)} 對 ${pct0(st.baseWin)}`
        + `${st.n < 10 ? `；只有 ${st.n} 筆，一兩次大漲大跌就會改變結論` : st.n < 30 ? `；${st.n} 筆不算多，平均容易被單一次拉動，中位數比較穩` : ''}。`);
    }
    const ev = used.at(-1), r = ev.ret[horizon];
    lines.push(`<b>上一次</b>：${ev.date}（${MEASURE[p.measure]} ${fmtVal(p, ev.ch)}），${r == null ? `還沒滿 ${horizon} 日，進場至今 ${pct(a.px.at(-1) / a.px[ev.entry] - 1)}` : `${horizon} 日後 ${pct(r)}`}。`);
  }
  byId('verdict').innerHTML = lines.map(l => `<div>${l}</div>`).join('');
  byId('asof').textContent = `VIX 資料到 ${vix.dates.at(-1)}（台北 06:00 更新前一天美股收盤）`;
}

// ── 圖 1：三格共用時間軸 ────────────────────────────────────────────────
/** 可見範圍的高低點往外留 10% 高低差，取整到好讀的刻度。side = -1 下緣、1 上緣。 */
function padRange({ min, max }, side) {
  const span = Math.max(max - min, Math.abs(max) * 0.01), pad = span * 0.1;
  const step = 10 ** Math.floor(Math.log10(span / 5));
  // 價格不會是負的：長期縮小看時下緣最低到 0。
  return side < 0 ? Math.max(0, Math.floor((min - pad) / step) * step) : Math.ceil((max + pad) / step) * step;
}
const PANES = [
  { key: 'px', top: 4, h: 34 },
  { key: 'vix', top: 45, h: 18 },
  { key: 'ch', top: 70, h: 18 },
];
function ensureChart(key) {
  if (charts[key]) return charts[key];
  const chart = charts[key] = echarts.init(byId(key + '-chart'), isLight() ? null : 'dark');
  // 區間掃描：點長條＝把區間設成那一組。
  if (key === 'scan') chart.on('click', e => { const [lo, hi] = C.bucketsOf(params.kind)[e.dataIndex] ?? []; if (lo != null) setRange(lo, hi); });
  return chart;
}
// 改參數重畫（notMerge）時保留使用者拉過的時間範圍與圖例開關。
function redraw(key, draw) {
  const keep = charts[key] ? captureChartState(charts[key]) : null;
  draw();
  if (keep) restoreChartState(charts[key], keep);
  return !keep;
}
function drawMain() {
  const chart = ensureChart('main'), a = assetData[asset], p = study.params, v = vix;
  const L = mob() ? 44 : 56, R = mob() ? 12 : 24, last = PANES.length - 1;
  // 標的價格對到 VIX 的日子：美股同一天；台股取該日（含）以前最後一個收盤，只用於畫圖。
  const pxOnV = [], idxOnV = [];
  let j = 0;
  for (const d of v.dates) {
    while (j < a.dates.length && a.dates[j] <= d) j++;
    const k = j && d >= a.dates[0] ? j - 1 : null;
    idxOnV.push(k); pxOnV.push(k == null ? null : a.px[k]);
  }
  const lvl = isLevel(p);
  const ch = (!lvl && p.measure === 'close' ? v.chClose : v.chHigh).map(x => (finite(x) ? +(x * 100).toFixed(1) : null));
  const evSet = new Set(study.events.map(e => e.i));
  // 單日漲幅模式：區間畫在第三格；水位模式：區間畫在第二格（VIX 盤中最高或收盤）。
  const hit = ch.map((x, i) => (!lvl && study.raw[i] ? x : null));
  const evOnly = ch.map((x, i) => (!lvl && evSet.has(i) ? x : null));
  const chTop = Math.max(120, Math.ceil((lvl ? 0 : p.lo) * 10) * 10 + 30);
  const vixLine = lvl && p.measure === 'high' ? v.high : v.close;
  const vixTop = Math.max(...vixLine.filter(finite));
  const band = (lo, hi, top, fmt) => ({
    markArea: { silent: true, itemStyle: { color: ORANGE, opacity: 0.12 }, data: [[{ yAxis: lo }, { yAxis: hi == null ? top : Math.min(hi, top) }]] },
    markLine: { silent: true, symbol: 'none', lineStyle: { type: 'dashed', color: ORANGE },
      label: { position: 'insideStartTop', color: ORANGE, fontSize: 11, backgroundColor: PALETTE.bg, padding: [1, 4] },
      data: [{ yAxis: lo, label: { formatter: `下限 ${fmt(lo)}` } }, ...(hi == null ? [] : [{ yAxis: hi, label: { formatter: `上限 ${fmt(hi)}` } }])] },
  });
  const names = [ASSETS[asset].label, `${lvl ? `VIX ${MEASURE[p.measure]}` : 'VIX 收盤'}　{ma|━ 50 日均線}`, `VIX 單日漲幅 %（${!lvl && p.measure === 'close' ? '收盤' : '盤中最高'} vs 前收）`];
  chart.setOption(echartsBase({
    animation: false,
    legend: { show: false },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'line' }, textStyle: { color: PALETTE.text, fontSize: 13 },
      formatter(items) {
        const i = items?.[0]?.dataIndex; if (i == null) return '';
        const ad = C.assetDay(a, idxOnV[i]), vd = C.vixDay(v, i);
        return [`<b>${v.dates[i]}</b>${evSet.has(i) ? `　<b style="color:${ORANGE}">事件日</b>` : study.raw[i] ? '　（符合，冷卻中）' : ''}`,
          `<b>VIX</b> ${ohlcText(vd)}`, `　盤中最高比前收 ${pct(vd.chHigh)}${maText(vd) ? `・${maText(vd)}` : ''}`,
          `<b>${ASSETS[asset].label}</b>${ad && ad.date !== v.dates[i] ? `（${ad.date}）` : ''} ${ohlcText(ad)}`].join('<br>');
      },
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: PANES.map(pn => ({ left: L, right: R, top: `${pn.top}%`, height: `${pn.h}%` })),
    xAxis: PANES.map((_, k) => ({ type: 'category', gridIndex: k, data: v.dates, boundaryGap: true, axisTick: { show: false },
      axisLine: { lineStyle: { color: PALETTE.muted } }, // 每年第一個交易日才標年份，擠的時候自動隱藏重疊的。
      axisLabel: { show: k === last, color: PALETTE.muted, fontSize: 12, hideOverlap: true, formatter: d => d.slice(0, 4),
        interval: i => i > 0 && v.dates[i].slice(0, 4) !== v.dates[i - 1].slice(0, 4) } })),
    yAxis: PANES.map((pn, k) => ({ type: 'value', gridIndex: k, name: names[k], nameLocation: 'end', nameGap: 6,
      nameTextStyle: { color: PALETTE.text, fontSize: 12, fontWeight: 600, align: 'left', padding: [0, 0, 0, -L + 4],
        rich: { ma: { color: PURPLE, fontSize: 12, fontWeight: 600 } } },
      scale: pn.key !== 'ch', splitNumber: pn.key === 'px' ? 4 : 3,
      // 價格格：跟著目前看的時間範圍，上下各留「高低差的 10%」，拉到一年也看得到起伏。
      ...(pn.key === 'px' ? { min: x => padRange(x, -1), max: x => padRange(x, 1) } : {}),
      // 漲幅格：上限 120%（或區間下限再高一點），少數極端值（2024-08-05 +181%）超出頂端，數值看 tooltip。
      ...(pn.key === 'ch' ? { min: -40, max: chTop } : {}),
      axisLabel: { color: PALETTE.muted, fontSize: 11, formatter: pn.key === 'ch' ? x => `${x}%` : undefined },
      splitLine: { lineStyle: { color: PALETTE.grid } } })),
    dataZoom: [{ type: 'inside', xAxisIndex: [0, 1, 2], filterMode: 'filter' },
      { type: 'slider', xAxisIndex: [0, 1, 2], height: 16, bottom: 6, filterMode: 'filter' }],
    series: [
      { id: 'px', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: pxOnV, showSymbol: false, sampling: 'lttb',
        lineStyle: { width: 1.3, color: PALETTE.text }, itemStyle: { color: PALETTE.text },
        markLine: { silent: true, symbol: 'none', label: { show: false },
          data: study.events.map(e => ({ xAxis: e.date, lineStyle: { type: 'solid', width: 1.5, color: ORANGE, opacity: 0.7 } })) },
        markPoint: { silent: true, symbol: 'pin', symbolSize: 24, itemStyle: { color: ORANGE }, label: { show: false },
          data: study.events.filter(e => pxOnV[e.i] != null).map(e => ({ coord: [e.date, pxOnV[e.i]] })) } },
      { id: 'vix', type: 'line', xAxisIndex: 1, yAxisIndex: 1, data: vixLine, showSymbol: false, sampling: 'lttb',
        lineStyle: { width: 1.1, color: BLUE }, itemStyle: { color: BLUE },
        ...(lvl ? band(p.lo, p.hi, vixTop, x => `${x}`) : {}) },
      // 50 日均線一律用收盤算（同 CNN Fear & Greed 的 VIX 圖）。
      { id: 'ma50', type: 'line', xAxisIndex: 1, yAxisIndex: 1, data: v.ma50.map(x => (finite(x) ? +x.toFixed(2) : null)), showSymbol: false,
        sampling: 'lttb', silent: true, lineStyle: { width: 1.6, color: PURPLE }, itemStyle: { color: PURPLE } },
      { id: 'ch', type: 'bar', xAxisIndex: 2, yAxisIndex: 2, data: ch, large: true, barGap: '-100%', itemStyle: { color: PALETTE.muted, opacity: 0.45 },
        ...(lvl ? {} : band(p.lo * 100, p.hi == null ? null : p.hi * 100, chTop, x => `${Math.round(x)}%`)) },
      { id: 'hit', type: 'bar', xAxisIndex: 2, yAxisIndex: 2, data: hit, large: true, itemStyle: { color: ORANGE, opacity: 0.55 } },
      { id: 'ev', type: 'bar', xAxisIndex: 2, yAxisIndex: 2, data: evOnly, large: true, itemStyle: { color: ORANGE } },
    ],
  }), { notMerge: true });
}
function drawMainKeep() {
  if (redraw('main', drawMain)) charts.main.dispatchAction({ type: 'dataZoom', startValue: vix.dates.find(d => d >= CHART_START), endValue: vix.dates.at(-1) });
}

// ── 圖 2：事件後走勢 ────────────────────────────────────────────────────
function drawPath() {
  const chart = ensureChart('path'), path = study.path, evs = study.events.filter(e => e.path);
  const xs = Array.from({ length: pathLen + 1 }, (_, k) => k);
  const toPct = arr => arr.slice(0, pathLen + 1).map(x => (finite(x) ? +(x * 100).toFixed(2) : null));
  const faint = evs.map(e => ({ name: e.date, type: 'line', data: toPct(e.path), showSymbol: false, silent: false,
    lineStyle: { width: 1, color: PALETTE.muted, opacity: 0.35 }, itemStyle: { color: PALETTE.muted },
    emphasis: { focus: 'series', lineStyle: { width: 2, opacity: 1, color: ORANGE } }, z: 1 }));
  chart.setOption(echartsBase({
    animation: false,
    grid: { left: mob() ? 44 : 56, right: mob() ? 12 : 24, top: 36, bottom: 40 },
    legend: { top: 0, data: ['平均', '中位數', '平常日子平均'], textStyle: { color: PALETTE.text, fontSize: 12 } },
    tooltip: {
      trigger: 'axis', textStyle: { color: PALETTE.text, fontSize: 13 },
      formatter(items) {
        const k = items?.[0]?.dataIndex; if (k == null) return '';
        return [`<b>進場後第 ${k} 個交易日</b>（${path.n[k]} 筆）`, `平均 ${pct(path.mean[k])}`, `中位數 ${pct(path.median[k])}`,
          `平常日子平均 ${pct(path.base[k])}`].join('<br>');
      },
    },
    xAxis: { type: 'category', data: xs, boundaryGap: false, name: '交易日', nameLocation: 'middle', nameGap: 26,
      nameTextStyle: { color: PALETTE.muted }, axisLabel: { color: PALETTE.muted, interval: pathLen <= 20 ? 1 : pathLen <= 60 ? 9 : 19 } },
    yAxis: { type: 'value', axisLabel: { color: PALETTE.muted, formatter: x => `${x}%` }, splitLine: { lineStyle: { color: PALETTE.grid } } },
    dataZoom: [],
    series: [...faint,
      { name: '平常日子平均', type: 'line', data: toPct(path.base), showSymbol: false, z: 3, lineStyle: { width: 2, type: 'dashed', color: PALETTE.text2 }, itemStyle: { color: PALETTE.text2 } },
      { name: '中位數', type: 'line', data: toPct(path.median), showSymbol: false, z: 4, lineStyle: { width: 2, color: BLUE }, itemStyle: { color: BLUE } },
      { name: '平均', type: 'line', data: toPct(path.mean), showSymbol: false, z: 5, lineStyle: { width: 3, color: ORANGE }, itemStyle: { color: ORANGE },
        markLine: { silent: true, symbol: 'none', label: { show: false }, lineStyle: { color: PALETTE.muted, type: 'solid', width: 1 }, data: [{ yAxis: 0 }] } }],
  }), { notMerge: true });
}

// ── 圖 3：各天期平均 vs 平常日子 ───────────────────────────────────────
function drawHorizons() {
  const chart = ensureChart('hz'), H = C.HORIZONS, st = study.stats;
  const val = f => H.map(h => (finite(f(st[h])) ? +(f(st[h]) * 100).toFixed(2) : null));
  const label = { show: true, position: 'top', color: PALETTE.text, fontSize: mob() ? 10 : 11, formatter: x => (x.value == null ? '' : `${x.value > 0 ? '+' : ''}${x.value.toFixed(1)}%`) };
  chart.setOption(echartsBase({
    animation: false,
    grid: { left: mob() ? 44 : 56, right: mob() ? 12 : 24, top: 40, bottom: 30 },
    legend: { top: 0, data: ['事件後平均', '平常日子平均'], textStyle: { color: PALETTE.text, fontSize: 12 } },
    tooltip: {
      trigger: 'axis', textStyle: { color: PALETTE.text, fontSize: 13 },
      formatter(items) {
        const h = H[items?.[0]?.dataIndex]; if (h == null) return '';
        const s = st[h];
        return [`<b>${h} 個交易日後</b>（${s.n} 筆）`, `事件後平均 ${pct(s.mean)}・中位數 ${pct(s.median)}・上漲機率 ${pct0(s.win)}`,
          `平常日子平均 ${pct(s.base)}・上漲機率 ${pct0(s.baseWin)}`].join('<br>');
      },
    },
    xAxis: { type: 'category', data: H.map(h => `${h} 日`), axisLabel: { color: PALETTE.muted } },
    yAxis: { type: 'value', axisLabel: { color: PALETTE.muted, formatter: x => `${x}%` }, splitLine: { lineStyle: { color: PALETTE.grid } } },
    dataZoom: [],
    series: [
      { name: '事件後平均', type: 'bar', data: val(s => s.mean), itemStyle: { color: ORANGE }, label, barMaxWidth: 36 },
      // 手機上兩組數字會疊在一起：平常日子只看長條高度，數字留在 tooltip。
      { name: '平常日子平均', type: 'bar', data: val(s => s.base), itemStyle: { color: PALETTE.muted }, label: { ...label, show: !mob() }, barMaxWidth: 36 },
    ],
  }), { notMerge: true });
}

// ── 圖 4：區間掃描 ─────────────────────────────────────────────────────
let scan = [];
function drawScan() {
  const chart = ensureChart('scan'), p = study.params, B = C.bucketsOf(p.kind);
  scan = C.bucketScan(vix, assetData[asset], p, { nextSession: ASSETS[asset].next, horizon });
  const overlaps = ([lo, hi]) => (p.hi == null || lo < p.hi) && (hi == null || hi > p.lo);
  const base = scan.find(b => finite(b.base))?.base;
  chart.setOption(echartsBase({
    animation: false,
    grid: { left: mob() ? 44 : 56, right: mob() ? 12 : 24, top: 36, bottom: 62 },
    legend: { show: false },
    tooltip: {
      trigger: 'axis', textStyle: { color: PALETTE.text, fontSize: 13 },
      formatter(items) {
        const b = scan[items?.[0]?.dataIndex]; if (!b) return '';
        return [`<b>VIX ${MEASURE[p.measure]}${isLevel(p) ? '進入' : '漲'} ${bucketLabel(p, [b.lo, b.hi])}</b>（${b.n} 筆）`, `${horizon} 日後平均 ${pct(b.mean)}・中位數 ${pct(b.median)}`,
          `上漲機率 ${pct0(b.win)}`, '點一下＝把區間設成這一組'].join('<br>');
      },
    },
    // 筆數放在 x 軸標籤（放長條上會和虛線疊在一起）；不到 5 筆加「樣本少」。
    xAxis: { type: 'category', data: B.map((b, k) => `${bucketLabel(p, b)}\n${scan[k].n} 筆${scan[k].n < 5 ? '・少' : ''}`),
      name: `VIX ${MEASURE[p.measure]}${isLevel(p) ? '水位（進入當天）' : '單日漲幅'}`, nameLocation: 'middle', nameGap: 44,
      nameTextStyle: { color: PALETTE.muted }, axisLabel: { color: PALETTE.muted, interval: 0, fontSize: mob() ? 10 : 12, lineHeight: 15 } },
    yAxis: { type: 'value', name: `${horizon} 日後平均（虛線＝平常日子 ${pct(base)}）`, nameTextStyle: { color: PALETTE.muted, align: 'left' }, axisLabel: { color: PALETTE.muted, formatter: x => `${x}%` },
      splitLine: { lineStyle: { color: PALETTE.grid } } },
    dataZoom: [],
    series: [{ type: 'bar', barMaxWidth: 44, cursor: 'pointer',
      // 不到 5 筆：斜線淡色＋「樣本少」，避免被當成可信的規律。
      data: scan.map((b, k) => {
        const on = overlaps(B[k]), few = b.n < 5;
        return { value: finite(b.mean) ? +(b.mean * 100).toFixed(2) : null,
          itemStyle: { color: on ? ORANGE : PALETTE.muted, opacity: few ? 0.35 : on ? 1 : 0.6,
            decal: few ? { symbol: 'rect', dashArrayX: [1, 0], dashArrayY: [2, 4], rotation: -Math.PI / 4, color: 'rgba(255,255,255,0.5)' } : undefined } };
      }),
      markLine: finite(base) ? { silent: true, symbol: 'none', lineStyle: { type: 'dashed', color: PALETTE.text2 }, label: { show: false },
        data: [{ yAxis: +(base * 100).toFixed(2) }] } : undefined }],
  }), { notMerge: true });
}

// ── 表 ──────────────────────────────────────────────────────────────────
function renderTables() {
  const H = C.HORIZONS, st = study.stats, p = study.params;
  const few = Math.max(...H.map(h => st[h].n)) < 5;
  const row = (label, f, fmt = signed) => [label, ...H.map(h => { const x = f(st[h]); return x == null ? '—' : fmt(x); })];
  table('stats', [`${ASSETS[asset].label}`, ...H.map(h => `${h} 日`)], [
    ['樣本數', ...H.map(h => `${st[h].n}${few ? '（太少）' : ''}`)],
    row('平均', s => s.mean), row('中位數', s => s.median), row('上漲機率', s => s.win, pct0),
    ...(few ? [] : [row('最好', s => s.max), row('最差', s => s.min)]),
    row('平常日子平均', s => s.base, x => pct(x)), row('平常日子上漲機率', s => s.baseWin, pct0), row('比平常日子多', s => s.excess),
  ]);
  const evs = study.events.filter(e => e.entry != null);
  byId('events-note').textContent = `${condText(p)}、冷卻 ${p.cooldown ? `${p.cooldown} 個交易日` : '無'}、${lagText(p)}進場：共 ${evs.length} 筆，新的在上。`;
  if (!evs.length) byId('events').replaceChildren(node('p', '目前條件下沒有事件。', { class: 'vixspike-note' }));
  else table('events', ['VIX 日期', '前收', '開盤', '最高（比前收）', '最低', '收盤（漲跌）', '盤中振幅', `${ASSETS[asset].label}當天`, '進場日',
    ...[1, 5, 20, 60, 120].map(h => `${h} 日`), '60 日內最大跌幅', '同一波（冷卻內併入）'],
    [...evs].reverse().map(e => [e.date, num(e.prev), num(e.open), `${num(e.high)}（${pct(e.chHigh, 0)}）`, num(e.low), `${num(e.close)}（${pct(e.chClose, 0)}）`,
      pct0abs(e.amp), e.day ? signed(e.day.ch) : '—', e.entryDate,
      ...[1, 5, 20, 60, 120].map(h => signed(e.ret[h])), e.mae60 == null ? '—' : signed(e.mae60), e.merged.length ? e.merged.join('、') : '—']));
  renderRecent();
  // 前 10 名在本頁的狀態：是事件／併入哪一筆／不在區間（或冷卻設定不同）。
  const host = new Map(study.events.flatMap(e => [[e.date, '事件'], ...e.merged.map(d => [d, `併入 ${e.date}`])]));
  const m = isLevel(p) ? 'high' : p.measure;
  table('top', ['排名', '日期', '前收', MEASURE[m], '單日漲幅', ...(isLevel(p) ? [] : ['目前設定下'])],
    C.extremes(vix, { measure: m }).map((r, k) => [`${k + 1}`, r.date, num(r.prev), num(r.level), pct(r.ch, 0), ...(isLevel(p) ? [] : [host.get(r.date) ?? '不在區間'])]));
}

// 最近 10 個交易日：VIX 與標的的開高低收、收盤漲跌、盤中振幅（台股取美股那天之後的台股交易日）。
function renderRecent() {
  const a = assetData[asset], next = ASSETS[asset].next, n = vix.dates.length;
  byId('recent-note').textContent = `振幅＝（最高 − 最低）÷ 前一天收盤。${next ? `${ASSETS[asset].label}取美股那天之後的第一個台股交易日（台北時間隔天）。` : ''}`;
  const rows = [];
  for (let i = n - 1; i >= Math.max(1, n - 10); i--) {
    const vd = C.vixDay(vix, i), ad = C.assetDay(a, C.entryIndex(vix, a, i, { lag: 0 }, next));
    rows.push([vd.date, num(vd.open), num(vd.high), num(vd.low), num(vd.close), signed(vd.ch), signed(vd.chHigh), pct0abs(vd.amp),
      ad ? (next ? `${ad.date.slice(5)}　${num(ad.close)}` : num(ad.close)) : '—', ad ? signed(ad.ch) : '—', ad ? pct0abs(ad.amp) : '—']);
  }
  table('recent', ['日期', 'VIX 開', '高', '低', '收', '收盤漲跌', '最高比前收', '振幅', `${ASSETS[asset].label} 收`, '漲跌', '振幅'], rows);
}

// ── 控制項 ──────────────────────────────────────────────────────────────
function setActive(id, attr, value) {
  byId(id).querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c.dataset[attr] === value));
}
function syncControls() {
  const p = params;
  setActive('kind', 'vixspikeKind', p.kind);
  setActive('measure', 'vixspikeMeasure', p.measure);
  const lvl = isLevel(p);
  byId('measure').querySelector('[data-vixspike-measure="high"]').textContent = lvl ? '盤中最高' : '盤中最高 vs 前收';
  byId('measure').querySelector('[data-vixspike-measure="close"]').textContent = lvl ? '收盤' : '收盤 vs 前收';
  byId('measure-label').textContent = lvl ? 'VIX 水位看' : 'VIX 漲幅看';
  byId('range-label').textContent = lvl ? 'VIX 水位區間（點）' : '單日漲幅區間（%）';
  byId('range-hint').textContent = lvl ? '每格 5 點；只算「進入區間」那天（前一天還不在區間）；選「無上限」＝以上都算'
    : '每格 5%；上限不含，選「無上限」＝以上都算';
  if (byId('lo').dataset.kind !== p.kind) fillSelects(p.kind);
  setActive('asset', 'vixspikeAsset', asset);
  setActive('lag', 'vixspikeLag', `${p.lag}`);
  setActive('cool', 'vixspikeCool', `${p.cooldown}`);
  setActive('horizon', 'vixspikeHorizon', `${horizon}`);
  setActive('pathlen', 'vixspikePathlen', `${pathLen}`);
  const loPct = Math.round(p.lo * U(p));
  byId('lo').value = `${loPct}`;
  byId('hi').value = p.hi == null ? '' : `${Math.round(p.hi * U(p))}`;
  // 上限只能選比下限高的格子。
  for (const o of byId('hi').options) o.disabled = o.value !== '' && Number(o.value) <= loPct;
  byId('lag').querySelector('[data-vixspike-lag="0"]').textContent = ASSETS[asset].next ? '隔天台股收盤' : '當天收盤';
  byId('lag').querySelector('[data-vixspike-lag="1"]').textContent = ASSETS[asset].next ? '再隔一天收盤' : '隔天收盤';
}
function recompute() {
  study = C.runStudy(vix, assetData[asset], params, { nextSession: ASSETS[asset].next, pathLen: PATH_MAX });
  syncControls(); renderVerdict(); drawMainKeep(); redraw('path', drawPath); redraw('hz', drawHorizons); redraw('scan', drawScan); renderTables();
}
function setRange(lo, hi) {
  params = { ...params, lo, hi: hi == null || hi <= lo ? null : hi };
  recompute();
}
// 下拉清單（每格 5）：單日漲幅 下限 0–150%、上限 5–200%；VIX 水位 下限 10–80、上限 15–90；上限都可選無上限。
const STEPS = {
  change: { lo: Array.from({ length: 31 }, (_, k) => k * 5), hi: Array.from({ length: 40 }, (_, k) => (k + 1) * 5) },
  level: { lo: Array.from({ length: 15 }, (_, k) => 10 + k * 5), hi: Array.from({ length: 16 }, (_, k) => 15 + k * 5) },
};
function fillSelects(kind) {
  const st = STEPS[kind], u = kind === 'level' ? '' : '%';
  byId('lo').replaceChildren(...st.lo.map(x => new Option(`${x}${u}`, `${x}`)));
  byId('hi').replaceChildren(new Option('無上限', ''), ...st.hi.map(x => new Option(`${x}${u}`, `${x}`)));
  byId('lo').dataset.kind = kind;
}
function onLoChange() {
  const p = params, u = U(p), lo = Number(byId('lo').value) / u;
  // 下限調到上限以上時，維持原本的區間寬度往上移（無上限就維持無上限）。
  let hi = p.hi == null ? null : p.hi > lo + 1e-9 ? p.hi : +(lo + Math.max(5 / u, p.hi - p.lo)).toFixed(2);
  if (hi != null && hi > STEPS[p.kind].hi.at(-1) / u) hi = null;
  setRange(lo, hi);
}
function onHiChange() {
  const v = byId('hi').value;
  setRange(params.lo, v === '' ? null : Number(v) / U(params));
}
function wire() {
  if (!bindOnce(byId('measure'))) return;
  chipPicker(byId('kind'), 'vixspike-kind', v => { if (v !== params.kind) { params = { ...params, kind: v, ...C.KIND_RANGE[v] }; recompute(); } });
  chipPicker(byId('measure'), 'vixspike-measure', v => { params = { ...params, measure: v }; recompute(); });
  chipPicker(byId('lag'), 'vixspike-lag', v => { params = { ...params, lag: Number(v) }; recompute(); });
  chipPicker(byId('cool'), 'vixspike-cool', v => { params = { ...params, cooldown: Number(v) }; recompute(); });
  chipPicker(byId('horizon'), 'vixspike-horizon', v => { horizon = Number(v); renderVerdict(); redraw('scan', drawScan); });
  chipPicker(byId('pathlen'), 'vixspike-pathlen', v => { pathLen = Number(v); redraw('path', drawPath); });
  chipPicker(byId('asset'), 'vixspike-asset', async v => {
    const prev = asset;
    byId('status').textContent = '載入中…';
    try { await loadAsset(v); asset = v; byId('status').textContent = ''; } catch (e) {
      asset = prev; byId('status').textContent = '標的載入失敗：' + (e.message || e);
    }
    recompute();
  });
  byId('lo').addEventListener('change', onLoChange);
  byId('hi').addEventListener('change', onHiChange);
}

// ── lifecycle ────────────────────────────────────────────────────────────
export async function activate(context = {}) {
  if (vix && Date.now() - loadedAt < 300_000) { resize(); return; }
  try {
    if ((await loadVix(context)) === false) return;
    await loadAsset(asset, context.signal);
    if (context.signal?.aborted || context.isCurrent?.() === false) return;
  } catch (e) {
    if (!context.signal?.aborted) byId('status').textContent = '載入失敗：' + (e.message || e);
    throw e;
  }
  loadedAt = Date.now();
  byId('status').textContent = '';
  wire(); recompute();
}
export function getCharts() { return Object.values(charts); }
export function resize() { for (const c of Object.values(charts)) c.resize(); }
export function onThemeChange() {
  if (!study) return;
  return preserveChartState(getCharts, () => {
    for (const c of Object.values(charts)) c.dispose();
    charts = {};
    drawMain(); drawPath(); drawHorizons(); drawScan();
  });
}
