// 共振歷史與水溫走勢 — 「過往觀察」子頁的上半部（2026-10-26 從極端狀態儀表板搬來，主頁只留現況）。
// 資料與規則和儀表板相同（nonnormal_calc.mjs 的同一份 context、同樣的每週評估）；兩張圖都捲到附近才畫。
// tempNowNodes() 也給主頁用（加權「現在」的水溫一行字）；pctTxt／ARROW 兩頁共用。
import { isLight, echartsBase, PALETTE, mob } from '../utils/theme.js';
import { requestJSON } from '../utils/data.js';
import { bindOnce, chipPicker } from '../utils/dom.js';
import { infoButton } from '../utils/info_popover.js';
import * as N from './nonnormal_calc.mjs';

const byId = id => document.getElementById('nonnormalhist-' + id);
const finite = v => typeof v === 'number' && Number.isFinite(v);
export const LEVEL_COLORS = ['#3fb950', '#e3b341', '#f0883e', '#ef4444'];
export const ARROW = x => (x > 0 ? '↑' : x < 0 ? '↓' : '→');
export const pctTxt = (x, d = 0) => (finite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%` : '—');
const pp = x => `${(Math.abs(x) * 100).toFixed(1)} 個百分點`;
const REQUIRED = ['TWII', 'SPX', 'VIX'];
const TEMP_HELP = '每週一筆（各市場該週最後一個交易日）。上：實線＝價格，橘色虛線＝10 月線（最近 10 個月的月底收盤平均，這個月用最新收盤代替，所以月中只會小幅移動、換月時才明顯跳一格；可以當 40 週線看：2003 起加權、S&P 500、韓股兩者平均只差約 0.7%，±3% 分區約 96% 的日子相同），底色＝當週水溫。中：價格離 10 月線多少 %。紅色虛線＝過熱線、藍色虛線＝極冷線，用該市場「當時以前」的歷史分位算，所以會隨時間移動；灰帶＝±3% 盤整。站到線外還要三條均線同方向才算過熱／極冷，所以線外側的顏色和上方底色偶爾不一致。下：六個市場的水溫，看是不是一起變冷。上方按鈕切換市場與期間，也可以拖拉下方滑桿。';

let ctx = null, weeks = [], missing = [], loadedAt = 0, charts = [null, null], rangeKey = '3y';   // charts[0] 共振歷史、[1] 水溫走勢

function node(tag, text, attrs = {}) {
  const el = document.createElement(tag);
  if (text != null) el.textContent = text;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}
function chartOption(i, option) {
  charts[i].setOption(echartsBase(option), { notMerge: true });
  charts[i].resize();
}

// ── data（與儀表板同一批檔案；requestJSON 有 5 分鐘快取，從主頁過來不會重抓）────────
/** 載入並建好 context。回傳 false＝已被切走；選用檔缺少時列在 missingFiles()。 */
export async function load(context = {}) {
  if (ctx && Date.now() - loadedAt < 300_000) return true;
  const bad = [];
  const files = [...N.SERIES.map(s => [s.id, s.file]), ...Object.entries(N.EXTRA_FILES)];
  const got = await Promise.all(files.map(async ([key, file]) => {
    try { return [key, (await requestJSON('data/' + file, { signal: context.signal }))?.data || []]; } catch (e) {
      if (context.signal?.aborted || REQUIRED.includes(key)) throw e;
      bad.push(file); return [key, []];
    }
  }));
  if (context.signal?.aborted || context.isCurrent?.() === false) return false;
  const next = N.buildContext(Object.fromEntries(got));
  if (!next.lastDate) throw new Error('沒有可用的加權／S&P 500 資料');
  ctx = next; missing = bad; loadedAt = Date.now(); tempHist = null;
  weeks = N.history(ctx, '2007-08-03');
  return true;
}
export const missingFiles = () => missing;

// 兩張圖都在頁面中段：第一次捲到附近（前後 400px）才畫
const watchers = new Map();
function whenVisible(id, draw) {
  if (watchers.has(id)) return;
  if (typeof IntersectionObserver !== 'function') { draw(); return; }
  const io = new IntersectionObserver(entries => {
    if (!entries.some(e => e.isIntersecting) || !ctx) return;
    io.disconnect(); watchers.delete(id);
    try { draw(); } catch (err) { byId('status').textContent = '計算失敗：' + err.message; }
  }, { rootMargin: '400px 0px' });
  watchers.set(id, io); io.observe(byId(id));
}

// ── 共振歷史 ────────────────────────────────────────────────────────────
const RANGES = { '1y': 52, '3y': 156, '5y': 260, '2013': '2013-06-07', all: null };
let twClose = [], lastFit = null;   // lastFit：上次套用的 y 範圍與 x 刻度間距，沒變就不重畫
/** 共振歷史的 x 軸每季一格（第一季標年份、其他標 Q2／Q3／Q4，並畫分隔線）。可見範圍太長放不下時，改成每半年或每年一格（step＝幾季一格）。 */
function quarterAxis(show, step) {
  const q = d => (+d.slice(5, 7) + 2) / 3;
  const at = i => {
    const d = weeks[i]?.date, p = weeks[i - 1]?.date;
    return !!d && !!p && d.slice(5, 7) !== p.slice(5, 7) && [1, 4, 7, 10].includes(+d.slice(5, 7)) && (q(d) - 1) % Math.min(step, 4) === 0 && (step <= 4 || +d.slice(0, 4) % (step / 4) === 0);
  };
  return {
    axisLabel: { color: PALETTE.muted, fontSize: 12, show, interval: at, formatter: d => (step >= 4 || q(d) === 1 ? d.slice(0, 4) : `Q${q(d)}`) },
    splitLine: { show: !show, interval: at, lineStyle: { color: PALETTE.grid, type: 'dashed' } },
  };
}
function chart() {
  if (!charts[0]) { charts[0] = echarts.init(byId('res-chart'), isLight() ? null : 'dark'); charts[0].on('datazoom', fitIndexAxis); }
  return charts[0];
}
function drawChart() {
  const dates = weeks.map(w => w.date), tw = ctx.s.TWII;
  twClose = dates.map(d => { const f = N.at(tw, d); return f && !f.stale ? f.close : null; });
  const heat = [];
  weeks.forEach((w, x) => w.signals.forEach((s, y) => heat.push([x, y, s.state === 'on' ? 1 : s.state === 'off' ? 0 : -1])));
  const L = mob() ? 62 : 76, R = mob() ? 10 : 24;
  const axis = (gridIndex, show) => ({ type: 'category', gridIndex, data: dates, boundaryGap: true, axisLine: { lineStyle: { color: PALETTE.muted } },
    axisTick: { show: false }, ...quarterAxis(show, 1) });
  const yAxis = (gridIndex, name, extra = {}) => ({ type: 'value', gridIndex, name, nameTextStyle: { color: PALETTE.muted, fontSize: 11 }, axisLabel: { color: PALETTE.muted, fontSize: 12 }, splitLine: { lineStyle: { color: PALETTE.grid } }, ...extra });
  const caseMarks = N.CASES.map(c => ({ xAxis: dates.find(d => d >= c.event), label: { formatter: c.id, color: PALETTE.muted, fontSize: 11 } })).filter(m => m.xAxis);
  const option = echartsBase({
    animation: false,
    legend: { show: false },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'line' }, backgroundColor: PALETTE.bg, borderColor: PALETTE.border, textStyle: { color: PALETTE.text, fontSize: 13 },
      formatter(params) {
        const i = params?.[0]?.dataIndex, w = weeks[i]; if (!w) return '';
        const lit = w.signals.filter(s => s.state === 'on').map(s => N.SIGNALS.find(d => d.id === s.id).short);
        return [`<b>${w.date}</b>｜加權 ${finite(twClose[i]) ? twClose[i].toFixed(0) : '—'}`,
          `<b style="color:${LEVEL_COLORS[w.level]}">${N.LEVELS[w.level].label}</b> ${w.count}/${w.available}`, lit.join('、') || '—'].join('<br>');
      },
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: [{ left: L, right: R, top: 16, height: '30%' }, { left: L, right: R, top: '38%', height: '14%' }, { left: L, right: R, top: '56%', height: '34%' }],
    xAxis: [axis(0, false), axis(1, false), axis(2, true)],
    // 加權的範圍與刻度由 fitIndexAxis() 依可見區間設定；刻度用 markLine 畫，axis 本身不標
    yAxis: [yAxis(0, '加權', { min: v => v.min * 0.9, max: v => v.max * 1.1, axisLabel: { show: false }, splitLine: { show: false } }),
      yAxis(1, '亮燈數', { min: 0, max: N.SIGNALS.length, interval: 2 }),
      { type: 'category', gridIndex: 2, data: N.SIGNALS.map(s => s.short), inverse: true, axisLabel: { color: PALETTE.muted, fontSize: mob() ? 11 : 12 }, axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false } }],
    visualMap: { show: false, type: 'piecewise', seriesIndex: 2, dimension: 2, pieces: [{ value: 1, color: '#ef4444' }, { value: 0, color: PALETTE.grid }, { value: -1, color: 'rgba(128,128,128,0.08)' }] },
    dataZoom: [{ type: 'inside', xAxisIndex: [0, 1, 2], filterMode: 'filter' }, { type: 'slider', xAxisIndex: [0, 1, 2], height: 16, bottom: 6, filterMode: 'filter' }],
    series: [
      { name: '加權指數', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: twClose, showSymbol: false, connectNulls: true, lineStyle: { width: 1.2, color: PALETTE.text }, itemStyle: { color: PALETTE.text },
        markLine: { silent: true, symbol: 'none', lineStyle: { type: 'dashed', color: PALETTE.muted }, data: caseMarks } },
      { name: '亮燈數', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, barCategoryGap: '10%', data: weeks.map(w => ({ value: w.count, itemStyle: { color: LEVEL_COLORS[w.level] } })) },
      { name: '各訊號', type: 'heatmap', xAxisIndex: 2, yAxisIndex: 2, data: heat, itemStyle: { borderColor: PALETTE.cellBorder, borderWidth: 0.3 }, emphasis: { disabled: true } },
      { id: 'twii-ticks', name: '加權刻度', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: [], silent: true, markLine: { silent: true, symbol: 'none', animation: false, z: 1, data: [] } },   // markLine 預設 z 5 會蓋在線上
    ],
  });
  chart().setOption(option, { notMerge: true });
  lastFit = null;
  applyRange();
}
function applyRange() {
  const ch = charts[0]; if (!ch || !weeks.length) return;
  const dates = weeks.map(w => w.date), key = RANGES[rangeKey];
  const start = typeof key === 'number' ? dates[Math.max(0, dates.length - key)] : key ? dates.find(x => x >= key) : dates[0];
  ch.dispatchAction({ type: 'dataZoom', startValue: start, endValue: dates.at(-1) });
  fitIndexAxis();
}
/** 加權的 y 軸跟著可見區間：最低 −10%～最高 +10%；刻度只標在可見的最低～最高之間（0／20／40／60／80／100%）。 */
function fitIndexAxis() {
  const ch = charts[0]; if (!ch || !twClose.length) return;
  const z = ch.getOption().dataZoom?.[0] || {}, idx = v => (typeof v === 'number' ? v : weeks.findIndex(w => w.date === v));
  const a = Math.max(0, idx(z.startValue ?? 0)), b = Math.min(twClose.length - 1, idx(z.endValue ?? twClose.length - 1));
  let lo = Infinity, hi = -Infinity;
  for (let i = a; i <= b; i++) if (finite(twClose[i])) { lo = Math.min(lo, twClose[i]); hi = Math.max(hi, twClose[i]); }
  if (!(hi > lo)) return;
  const ticks = [0, 1, 2, 3, 4, 5].map(k => lo + ((hi - lo) * k) / 5);
  const width = ch.getWidth() - (mob() ? 72 : 100), label = mob() ? 30 : 44;   // 每格至少要放得下「2024」
  const step = [1, 2, 4, 8, 16].find(k => width / ((b - a + 1) / 13 / k) >= label) || 16;
  // 拖拉 slider 時每一格都會觸發 datazoom；可見的最高／最低與刻度間距常常沒變，這時不重畫（省一次整張圖的重繪）
  const prev = lastFit;
  if (prev && prev.lo === lo && prev.hi === hi && prev.step === step) return;
  lastFit = { lo, hi, step };
  ch.setOption({
    ...(prev?.step === step ? {} : { xAxis: [0, 1, 2].map(i => quarterAxis(i === 2, step)) }),
    ...(prev && prev.lo === lo && prev.hi === hi ? {} : { yAxis: [{ min: lo * 0.9, max: hi * 1.1 }], series: [{ id: 'twii-ticks', markLine: { data: ticks.map(v => ({ yAxis: v, lineStyle: { type: 'solid', width: 1, color: PALETTE.grid },
      label: { position: 'start', formatter: Math.round(v).toLocaleString('en-US'), color: PALETTE.muted, fontSize: mob() ? 11 : 12 } })) } }] }),
  });
}

// ── 水溫走勢 ────────────────────────────────────────────────────────────
const ZONE_COLORS = ['#ef4444', '#f0883e', '#8b949e', '#58a6ff', '#1f6feb'];
const NO_DATA = 'rgba(128,128,128,0.22)';   // 熱度條上還沒有足夠歷史的格子（與 .nonnormal-zone--na 同色）   // 與 .nonnormal-zone--* 同色
const TEMP_RANGES = { '3y': 156, '5y': 260, '10y': 520, all: null };
const NEAR = N.STANCE.nearGap * 100;   // 盤整帶 ±3%
let tempHist = null, tempMarket = 'TWII', tempRange = '5y';
const tempHistory = () => (tempHist?.ctx === ctx ? tempHist : (tempHist = { ctx, ...N.temperatureHistory(ctx) }));
const tempMarketOf = h => h.markets.find(x => x.id === tempMarket) || h.markets[0];
function drawTemp(keepWindow = false) {
  const h = tempHistory();
  if (!h.dates.length) return;
  const prev = keepWindow && charts[1] ? charts[1].getOption()?.dataZoom?.[0] : null;   // 切換市場時保留目前看的期間
  if (!charts[1]) charts[1] = echarts.init(byId('temp-chart'), isLight() ? null : 'dark');
  const m = tempMarketOf(h), rows = m.rows, num = (r, k, f = 1) => (r && finite(r[k]) ? +(r[k] * f).toFixed(2) : null);
  const lastI = rows.findLastIndex(Boolean), lastR = rows[lastI];
  const L = mob() ? 62 : 76, R = mob() ? 10 : 24;   // 左邊要放得下熱度條的「▶ 那斯達克」
  const axis = (gridIndex, show) => ({ type: 'category', gridIndex, data: h.dates, boundaryGap: true, axisTick: { show: false },
    axisLine: { lineStyle: { color: PALETTE.muted } }, axisLabel: { show, color: PALETTE.muted, fontSize: 12, formatter: d => d.slice(0, 7) }, splitLine: { show: false } });
  const yAxis = (gridIndex, extra = {}) => ({ type: 'value', gridIndex, scale: true, axisLabel: { color: PALETTE.muted, fontSize: 12 }, splitLine: { lineStyle: { color: PALETTE.grid } }, ...extra });
  const zoneOf = r => (r ? N.ZONES[r.zone] : null);
  const heat = [];
  h.markets.forEach((mk, y) => mk.rows.forEach((r, x) => heat.push([x, y, r ? r.zone : -1])));
  chartOption(1, {
    animation: false,
    legend: { top: 0, right: R, itemWidth: 22, textStyle: { color: PALETTE.muted, fontSize: 12 }, data: [m.label, '10 月線（虛線）', '過熱線', '極冷線'] },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'line' }, backgroundColor: PALETTE.bg, borderColor: PALETTE.border, textStyle: { color: PALETTE.text, fontSize: 13 },
      formatter(params) {
        const i = params?.[0]?.dataIndex, r = rows[i];
        if (i == null) return '';
        const head = r ? `<b>${h.dates[i]}</b>｜${m.label}${r.carried ? `（休市，沿用 ${r.date}）` : ''} ${r.close.toLocaleString('en-US', { maximumFractionDigits: 2 })}・10 月線 ${r.ma10m.toLocaleString('en-US', { maximumFractionDigits: 0 })}・離 ${pctTxt(r.gap, 1)}（過熱線 ${pctTxt(r.hot, 0)}／極冷線 ${pctTxt(r.cold, 0)}）`
          : `<b>${h.dates[i]}</b>｜${m.label} 無資料`;
        const all = h.markets.map(mk => { const z = zoneOf(mk.rows[i]); return `${mk.label} <b style="color:${z ? ZONE_COLORS[mk.rows[i].zone] : PALETTE.muted}">${z ? z.label : '資料不足'}</b>`; });
        return [head, all.join('　')].join('<br>');
      },
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: [{ left: L, right: R, top: 30, height: '38%' }, { left: L, right: R, top: '50%', height: '22%' }, { left: L, right: R, top: '76%', height: '14%' }],
    xAxis: [axis(0, false), axis(1, false), axis(2, true)],
    yAxis: [yAxis(0, { name: m.label, nameTextStyle: { color: PALETTE.muted, fontSize: 11 } }),
      { type: 'value', gridIndex: 0, min: 0, max: 1, show: false },
      yAxis(1, { scale: false, name: '離 10 月線', nameTextStyle: { color: PALETTE.muted, fontSize: 11 }, axisLabel: { color: PALETTE.muted, fontSize: 12, formatter: v => `${v}%` },
        min: v => Math.floor(v.min) - 2, max: v => Math.ceil(v.max) + 2 }),
      { type: 'category', gridIndex: 2, data: h.markets.map(mk => mk.label), inverse: true, axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false },
        axisLabel: { interval: 0, color: PALETTE.muted, fontSize: mob() ? 11 : 12, formatter: v => (v === m.label ? `▶ ${v}` : v) } }],
    visualMap: { show: false, type: 'piecewise', seriesIndex: 4, dimension: 2, pieces: [...ZONE_COLORS.map((color, value) => ({ value, color })), { value: -1, color: NO_DATA }] },
    dataZoom: [{ type: 'inside', xAxisIndex: [0, 1, 2], filterMode: 'filter' }, { type: 'slider', xAxisIndex: [0, 1, 2], height: 16, bottom: 6, filterMode: 'filter' }],
    series: [
      { name: '水溫底色', type: 'bar', xAxisIndex: 0, yAxisIndex: 1, silent: true, barCategoryGap: 0, z: 0, tooltip: { show: false },
        data: rows.map(r => (r ? { value: 1, itemStyle: { color: ZONE_COLORS[r.zone], opacity: 0.22 } } : null)) },
      { name: m.label, type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: rows.map(r => num(r, 'close')), showSymbol: false, lineStyle: { width: 1.3, color: PALETTE.text }, itemStyle: { color: PALETTE.text } },
      { name: '10 月線（虛線）', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: rows.map(r => num(r, 'ma10m')), showSymbol: false, lineStyle: { width: 1.2, type: 'dashed', color: '#d29922' }, itemStyle: { color: '#d29922' } },
      { name: '離 10 月線', type: 'line', xAxisIndex: 1, yAxisIndex: 2, data: rows.map(r => num(r, 'gap', 100)), showSymbol: false, lineStyle: { width: 1.3, color: PALETTE.text }, itemStyle: { color: PALETTE.text },
        markArea: { silent: true, data: [[{ yAxis: -NEAR, itemStyle: { color: ZONE_COLORS[2], opacity: 0.16 } }, { yAxis: NEAR }]] },
        markLine: { silent: true, symbol: 'none', lineStyle: { type: 'dotted', width: 1, color: PALETTE.muted },
          data: [{ yAxis: NEAR, label: { formatter: `±${NEAR}% 盤整`, position: 'insideStartTop', color: PALETTE.muted, fontSize: 11 } }, { yAxis: -NEAR, label: { show: false } }] },
        // 最新一週：圓點＋「現在」標籤，顏色＝目前水溫
        markPoint: lastR ? { silent: true, symbol: 'circle', symbolSize: 9, animation: false, data: [{ coord: [lastI, +(lastR.gap * 100).toFixed(2)], itemStyle: { color: ZONE_COLORS[lastR.zone], borderColor: PALETTE.bg, borderWidth: 1.5 },
          label: { show: true, position: 'left', formatter: `現在 ${pctTxt(lastR.gap, 1)}`, color: PALETTE.text, fontSize: 12, fontWeight: 600 } }] } : undefined },
      { name: '各市場水溫', type: 'heatmap', xAxisIndex: 2, yAxisIndex: 3, data: heat, itemStyle: { borderWidth: 0 }, emphasis: { disabled: true } },
      // 過熱線／極冷線：該市場「當時以前」離 10 月線的歷史分位，會隨時間變動；線外側上色
      { name: '過熱線', type: 'line', xAxisIndex: 1, yAxisIndex: 2, data: rows.map(r => num(r, 'hot', 100)), showSymbol: false, z: 1,
        lineStyle: { width: 1.2, type: 'dashed', color: ZONE_COLORS[0] }, itemStyle: { color: ZONE_COLORS[0] }, areaStyle: { origin: 'end', color: ZONE_COLORS[0], opacity: 0.12 } },
      { name: '極冷線', type: 'line', xAxisIndex: 1, yAxisIndex: 2, data: rows.map(r => num(r, 'cold', 100)), showSymbol: false, z: 1,
        lineStyle: { width: 1.2, type: 'dashed', color: ZONE_COLORS[4] }, itemStyle: { color: ZONE_COLORS[4] }, areaStyle: { origin: 'start', color: ZONE_COLORS[4], opacity: 0.12 } },
    ],
  });
  if (prev && prev.startValue != null) charts[1].dispatchAction({ type: 'dataZoom', startValue: prev.startValue, endValue: prev.endValue });
  else applyTempRange();
}
function applyTempRange() {
  const ch = charts[1], h = tempHist;
  if (!ch || !h?.dates.length) return;
  const first = Math.max(0, tempMarketOf(h).rows.findIndex(Boolean)), key = TEMP_RANGES[tempRange];
  const start = key ? Math.max(first, h.dates.length - key) : first;
  ch.dispatchAction({ type: 'dataZoom', startValue: start, endValue: h.dates.length - 1 });
}
/** 圖上方一行：所選市場「現在」在哪一區、離過熱線／極冷線還差多少、三條均線方向（過熱、極冷要三條同方向）。 */
/** 一行字：某個市場「現在」在哪一區、離過熱線／極冷線還差多少、三條均線方向（過熱、極冷要三條同方向）。
 *  與水溫表格同一天、同一算法；主頁（加權）與子頁（所選市場）共用。 */
export function tempNowNodes(context, date, marketId) {
  const [id, label] = N.STANCE.markets.find(([x]) => x === marketId) || N.STANCE.markets[0];
  const r = N.temperature(context.s[id], date);
  if (!r || r.stale) return [`${label}：${r?.stale ? `資料停在 ${r.date}` : '資料不足'}`];
  const z = N.ZONES[r.zone], dirTxt = ['日', '週', '月'].map((k, i) => k + ARROW([r.dir.d, r.dir.w, r.dir.m][i])).join(' ');
  const toHot = r.zone === 0 ? '已在過熱區' : r.gap >= r.hot ? `已站上過熱線（${pctTxt(r.hot, 0)}），但三條均線沒有都上揚` : `距過熱線（${pctTxt(r.hot, 0)}）還差 ${pp(r.hot - r.gap)}`;
  const toCold = r.zone === 4 ? '已在極冷區' : r.gap <= r.cold ? `已跌破極冷線（${pctTxt(r.cold, 0)}），但三條均線沒有都下彎` : `距極冷線（${pctTxt(r.cold, 0)}）還有 ${pp(r.gap - r.cold)}`;
  return [`${label} 現在（${r.date}）：`, node('span', z.label, { class: `nonnormal-zone nonnormal-zone--${z.id}`, title: z.desc }),
    '　離 10 月線 ', node('b', pctTxt(r.gap, 1)), `｜${toHot}｜${toCold}｜均線 ${dirTxt}`];
}
const renderTempNow = () => byId('temp-now').replaceChildren(...tempNowNodes(ctx, weeks.at(-1).date, tempMarket));
function renderTempLegend() {
  byId('temp-legend').replaceChildren(...N.ZONES.map(z => node('span', z.label, { class: `nonnormal-zone nonnormal-zone--${z.id}`, title: z.desc })),
    node('span', '資料不足', { class: 'nonnormal-zone nonnormal-zone--na', title: '還沒有足夠的歷史：10 月線要 10 個月，過熱線／極冷線要約 3 年（櫃買 2017-02、S&P 500（VOO）2014-06 起才有）' }));
}


/** 畫上半部：已畫過的圖直接重畫，沒畫過的等捲到附近。 */
export function render() {
  wire();
  renderTempLegend(); renderTempNow();
  if (charts[0]) drawChart(); else whenVisible('res-chart', drawChart);
  if (charts[1]) drawTemp(true); else whenVisible('temp-chart', () => drawTemp());
}
function wire() {
  if (!bindOnce(byId('res-range'))) return;
  chipPicker(byId('res-range'), 'nonnormalhist-res', key => { rangeKey = key; applyRange(); });
  chipPicker(byId('temp-market'), 'nonnormalhist-temp-market', key => { tempMarket = key; if (!ctx) return; renderTempNow(); if (charts[1]) drawTemp(true); });
  chipPicker(byId('temp-range'), 'nonnormalhist-temp-range', key => { tempRange = key; applyTempRange(); });
  byId('temp-title').append(' ', infoButton(TEMP_HELP, '說明：水溫走勢'));
}
export function getCharts() { return charts.filter(Boolean); }
/** 換主題：把已經畫過的圖重建（沒畫過的維持等捲到才畫）。給子頁的 preserveChartState 包起來用。 */
export function redrawForTheme() {
  const had = charts.map(Boolean);
  charts.forEach(c => c?.dispose()); charts = [null, null];
  if (had[0]) drawChart();
  if (had[1]) drawTemp();
}
