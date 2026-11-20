import { isLight, mob, PALETTE, echartsBase } from '../utils/theme.js';
import { bindOnce, chipPicker } from '../utils/dom.js';
import { buildBreadthContext, getBreadthDenominator } from './breadthSignals.mjs';
import { requestJSON, clearRequestCache } from '../utils/data.js';

const UNIVERSE_CONFIG = {
  SP500: { dataFile: 'data/breadth.json', histFile: 'data/breadth_sp500_hist20.json', overlayFile: 'data/VOO.json', overlayName: 'VOO', label: 'S&P 500' },
  NDX: { dataFile: 'data/breadth_ndx.json', overlayFile: 'data/QQQ.json', overlayName: 'QQQ', label: 'Nasdaq-100' },
  XLG: { dataFile: 'data/breadth_xlg.json', overlayFile: 'data/XLG.json', overlayName: 'XLG', label: '市值前50代理股票群' },
  TW50: { dataFile: 'data/breadth_tw50.json', overlayFile: 'data/0050.TW.json', overlayName: '0050', label: '台灣50' },
};
const cache = new Map();
const overlays = { VIX: { file: 'data/VIX.json', active: false, rows: null, error: null }, 'F&G': { file: 'data/fear_greed.json', active: false, rows: null, error: null }, RSP: { file: 'data/RSP.json', active: false, rows: null, error: null } };
let universe = 'SP500', maWindow = 20, range = '3Y', requestSequence = 0;
let loaded = null, breadthChart = null, chartDates = [];
const el = id => document.getElementById(id);
const number = (value, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : '—';
const percent = value => Number.isFinite(value) ? `${number(value)}%` : '—';
const context = () => loaded?.contexts[maWindow];
const cfg = () => UNIVERSE_CONFIG[universe];

function breadthSignal(pct, is200) {
  if (pct == null) return { label: "—", color: "var(--muted)" };
  if (is200) {
    if (pct >= 70) return { label: "長期多頭確認", color: "#3fb950" };
    if (pct >= 55) return { label: "偏多格局",     color: "#7ee787" };
    if (pct >= 35) return { label: "整理格局",     color: "#f0883e" };
    if (pct >= 20) return { label: "偏空格局",     color: "#f0883e" };
    return                { label: "長期空頭警戒", color: "#f85149" };
  }
  if (pct >= 75) return { label: "強勢多頭", color: "#3fb950" };
  if (pct >= 55) return { label: "多方主導", color: "#7ee787" };
  if (pct >= 35) return { label: "多空拉鋸", color: "#e3b341" };
  if (pct >= 20) return { label: "空方壓力", color: "#f0883e" };
  return               { label: "弱勢超賣", color: "#f85149" };
}

function breadthBearSignal(pct) {
  if (pct == null) return { label: "—", color: "var(--muted)" };
  if (pct < 15) return { label: "健康",         color: "#3fb950" };
  if (pct < 30) return { label: "局部修正",     color: "#e3b341" };
  if (pct < 50) return { label: "廣泛修正",     color: "#f0883e" };
  return              { label: "系統性熊市徵兆", color: "#f85149" };
}

function breadthMomentumSignal(diff) {
  if (diff == null) return { label: "—", color: "var(--muted)" };
  if (diff <= -5) return { label: "波峰顯著降低（動能轉弱）", color: "#f85149" };
  if (diff <= -1) return { label: "波峰略降",                 color: "#f0883e" };
  return                { label: "波峰持平／走高",             color: "#3fb950" };
}


async function readData(file, context = {}) {
  const json = await requestJSON(file, { signal: context.signal });
  if (context.signal?.aborted || (context.isCurrent && !context.isCurrent())) return null;
  try {
    validateData(file, json);
  } catch (error) {
    clearRequestCache(file);
    throw error;
  }
  return json;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().startsWith(value + 'T');
}

function validateData(file, payload) {
  const rows = payload?.data;
  if (!Array.isArray(rows) || !rows.length) throw new Error(`${file} 資料為空或格式錯誤`);
  const breadth = /\/breadth(?:_\w+)?\.json$/.test(file);
  const fieldNames = breadth
    ? ['above20_count','above20_total','above20_pct','above50_count','above50_total','above50_pct','above200_count','above200_total','above200_pct','new_hi_count','new_lo_count','hl_total','bear_count','bear_pct','bear_total','total']
    : [file.includes('fear_greed') ? 'value' : 'close'];
  let usable = 0;
  rows.forEach((row, index) => {
    if (!validDate(row?.date)) throw new Error(`${file} 第 ${index + 1} 列日期錯誤`);
    for (const field of fieldNames) {
      const value = row[field];
      if (value != null && (typeof value !== 'number' || !Number.isFinite(value)))
        throw new Error(`${file} 第 ${index + 1} 列 ${field} 型別錯誤`);
    }
    if (breadth ? [20, 50, 200].some(window => Number.isFinite(row[`above${window}_pct`]))
      : Number.isFinite(row[fieldNames[0]])) usable++;
  });
  if (usable < 2) throw new Error(`${file} 可用資料不足`);
}

function clearView() {
  loaded = null;
  breadthChart?.clear();
  el('breadth-regime').textContent = '資料不足';
  document.querySelectorAll('#breadth-top .bc-pct, #breadth-top .bc-count, #breadth-top .bc-signal').forEach(node => { node.textContent = '—'; });
}

async function selectUniverse(next, context = {}) {
  universe = next;
  const sequence = ++requestSequence;
  clearView();
  el('breadth-status').textContent = `${cfg().label} 載入中…`;
  el('breadth-retry').hidden = true;
  try {
    if (!cache.has(next)) {
      const config = UNIVERSE_CONFIG[next];
      const [data, pricesJson, hist] = await Promise.all([readData(config.dataFile, context), readData(config.overlayFile, context),
        config.histFile ? requestJSON(config.histFile, { signal: context.signal }).catch(() => null) : null]);
      // 20MA 回補：breadth.json 2019-11 起，之前用研究資料的 point-in-time 自算值（只有 above20_pct）
      if (hist?.data?.length) { const first = data.data[0].date; data.data = [...hist.data.filter(r => r.date < first), ...data.data]; data.histUntil = first; }
      if (sequence !== requestSequence || context.signal?.aborted || (context.isCurrent && !context.isCurrent())) return;
      const prices = pricesJson.data;
      const contexts = Object.fromEntries([20, 50, 200].map(window => [window, buildBreadthContext(data.data, prices, window)]));
      if (context.signal?.aborted || (context.isCurrent && !context.isCurrent())) return;
      cache.set(next, { data, prices, contexts });
    }
    if (sequence !== requestSequence || context.signal?.aborted || (context.isCurrent && !context.isCurrent())) return;
    loaded = cache.get(next);
    refreshView();
    el('tab-breadth')?.querySelector('.tab-load-error')?.remove();
  } catch (error) {
    if (sequence !== requestSequence || context.signal?.aborted || (context.isCurrent && !context.isCurrent())) return;
    clearView();
    el('breadth-status').textContent = `${cfg().label} 載入失敗：${error.message}`;
    el('breadth-retry').hidden = false;
    if (context.signal || context.isCurrent) throw error;
  }
}

function cutoff(key, date) {
  if (key === 'MAX' || !date) return null;
  const result = new Date(`${date}T00:00:00Z`);
  result.setUTCFullYear(result.getUTCFullYear() - parseInt(key));
  // check_reuse: keep — cutoff anchored to latestBreadthDate with UTC calendar-year subtraction; dates presets anchor to today and change study eligibility.
  return result.toISOString().slice(0, 10);
}

function refreshStatus() {
  if (!loaded) return;
  const c = context();
  const overlayStatus = Object.entries(overlays).filter(([, o]) => o.active).map(([name, o]) => `${name}：${o.error ? '載入失敗（再點兩次重試）' : o.rows ? o.rows.at(-1).date : '載入中'}`).join(' · ');
  el('breadth-status').textContent = `${cfg().label}／${cfg().overlayName} · 卡片廣度日期 ${c.latestBreadthDate} · ETF最後日期 ${c.latestPriceDate} · 共同可用日期 ${c.commonDate ?? '—'}。兩者可能不同步。${loaded.data.histUntil && maWindow === 20 ? ` 20MA 在 ${loaded.data.histUntil} 前是研究資料回補（歷史成分股覆蓋 66–84%，弱勢期可能偏高）。` : ''}${overlayStatus}`;
}

function refreshView() {
  if (!loaded) return;
  const c = context(), latest = loaded.data.data.at(-1);
  for (const window of [20, 50, 200]) {
    const pct = latest[`above${window}_pct`], denominator = getBreadthDenominator(latest, window);
    el(`bc-${window}-pct`).textContent = number(pct, 1);
    el(`bc-${window}-count`).textContent = denominator === null ? '分母未記錄' : `${latest[`above${window}_count`] ?? '—'} / ${denominator}`;
    const signal = breadthSignal(pct, window === 200);
    el(`bc-${window}-signal`).textContent = signal.label; el(`bc-${window}-signal`).style.color = signal.color;
  }
  el('bc-bear-pct').textContent = number(latest.bear_pct, 1);
  el('bc-bear-count').textContent = `${latest.bear_count ?? '—'} / ${latest.bear_total ?? '—'}`;
  const bear = breadthBearSignal(latest.bear_pct);
  el('bc-bear-signal').textContent = bear.label; el('bc-bear-signal').style.color = bear.color;
  const mom = c.momentum, momentumSignal = breadthMomentumSignal(mom?.diff);
  el('bc-mom-pct').textContent = number(mom?.peakNow, 1);
  el('bc-mom-count').textContent = `前90交易日完整窗口高點 ${percent(mom?.peakPrior)}`;
  el('bc-mom-signal').textContent = momentumSignal.label; el('bc-mom-signal').style.color = momentumSignal.color;
  el('bc-hl-count').textContent = `${latest.new_hi_count ?? '—'} / ${latest.new_lo_count ?? '—'}`;
  el('bc-hl-pct').textContent = latest.hl_total > 0 && Number.isFinite(latest.new_hi_count) && Number.isFinite(latest.new_lo_count) ? `${percent(latest.new_hi_count / latest.hl_total * 100)} / ${percent(latest.new_lo_count / latest.hl_total * 100)} · n=${latest.hl_total}` : '分母未記錄';
  el('bc-hl-signal').textContent = `共同日期最近30交易日觸發 ${c.hindenburgRecentCount} 次（簡化版）`;
  const current = c.current;
  if (current?.ma == null || current.pct == null || current.close == null) el('breadth-regime').textContent = '現況對照：資料不足';
  else {
    const strongPrice = current.close > current.ma, strongBreadth = current.pct >= 50;
    const label = current.close === current.ma ? `價格持平、廣度${strongBreadth ? '較強' : '較弱'}` : strongPrice ? strongBreadth ? '價格與廣度均強' : '價格強、廣度弱' : strongBreadth ? '價格弱、廣度較強' : '價格與廣度均弱';
    el('breadth-regime').textContent = `${current.date} · ${cfg().overlayName} ${number(current.close)}／${maWindow}MA ${number(current.ma)}（${current.close === current.ma ? '持平' : strongPrice ? '上方' : '下方'}） · 廣度 ${percent(current.pct)}（${strongBreadth ? '多數 ≥50%' : '未達多數50%'}） · ${label}`;
  }
  refreshStatus(); renderBreadthChart();
}


export function renderBreadthChart() {
  if (!loaded) return;
  if (!breadthChart) {
    breadthChart = echarts.init(el('breadth-chart'), isLight() ? null : 'dark');
    breadthChart.on('datazoom', () => alignRsp());
  }
  const c = context();
  const sessions = c.sessions.filter(s => s.date >= loaded.data.data[0].date && s.date <= c.commonDate);
  const dates = sessions.map(s => s.date);
  chartDates = dates;
  const line = (name, data, axis, color, extra = {}) => ({ name, type: 'line', data, yAxisIndex: axis, symbol: 'none', connectNulls: false, itemStyle: { color }, lineStyle: { color, width: 1.6 }, ...extra });
  const fg = overlays['F&G'], rsp = overlays.RSP;
  const fgMap = fg.active && fg.rows ? new Map(fg.rows.map(r => [r.date, r.value])) : null;
  const vix = overlays.VIX, vixMap = vix.active && vix.rows ? new Map(vix.rows.map(r => [r.date, r.close])) : null;
  const start = cutoff(range, c.latestBreadthDate);
  const startIdx = start ? Math.max(0, dates.findIndex(d => d >= start)) : 0;
  const thresholds = [[15,'投降','#f85149'],[25,'恐懼','#f0883e'],[50,'',null],[75,'貪婪',null],[85,'狂熱',null]];
  breadthChart.setOption(echartsBase({
    grid: { top: 28, bottom: 64, left: mob() ? 44 : 56, right: mob() ? 52 : 68 },
    legend: { top: 0, data: [cfg().overlayName, ...(rsp.active ? ['RSP 等權'] : []), `${maWindow}日均線以上`, ...(fgMap ? ['F&G'] : []), ...(vixMap ? ['VIX'] : [])] },
    tooltip: { trigger: 'axis', confine: true, formatter(params) {
      const entries = Array.isArray(params) ? params : [params];
      let html = `<b>${entries[0]?.axisValue ?? ''}</b>`;
      for (const p of entries) {
        if (!Number.isFinite(p.value)) continue;
        const pct = p.seriesName.includes('均線以上');
        const raw = p.seriesName === 'RSP 等權' ? rspRaw.get(entries[0].axisValue) : null;
        html += `<div>${p.marker}${p.seriesName}: ${number(raw ?? p.value, pct || p.seriesName === 'F&G' || p.seriesName === 'VIX' ? 1 : 2)}${pct ? '%' : ''}</div>`;
      }
      return html;
    } },
    dataZoom: [{ type: 'inside', startValue: startIdx, endValue: dates.length - 1 }, { type: 'slider', height: 22, bottom: 8, startValue: startIdx, endValue: dates.length - 1 }],
    xAxis: { data: dates, boundaryGap: false },
    yAxis: [
      { type: 'value', min: 0, max: 100, axisLabel: { color: PALETTE.muted, formatter: '{value}%' }, splitLine: { lineStyle: { color: PALETTE.grid } } },
      { type: 'value', position: 'right', axisLabel: { color: PALETTE.muted }, splitLine: { show: false },
        min: v => Math.floor(v.min * 0.9), max: v => Math.ceil(v.max * 1.1) },
    ],
    series: [
      line(cfg().overlayName, sessions.map(s => s.close), 1, '#a371f7'),
      ...(rsp.active ? [line('RSP 等權', dates.map(() => null), 1, '#3fb950')] : []),
      line(`${maWindow}日均線以上`, sessions.map(s => s.pct), 0, '#58a6ff', { markLine: { silent: true, symbol: 'none', data: thresholds.map(([yAxis, tag, color]) => ({ yAxis, label: { formatter: tag ? `${yAxis}% ${tag}` : `${yAxis}%` }, ...(color ? { lineStyle: { color, type: 'dashed', width: 1.4 } } : {}) })) } }),
      ...(fgMap ? [line('F&G', dates.map(d => fgMap.get(d) ?? null), 0, '#e3b341', { lineStyle: { color: '#e3b341', width: 1.2, opacity: 0.85 } })] : []),
      ...(vixMap ? [line('VIX', dates.map(d => vixMap.get(d) ?? null), 0, '#f85149', { lineStyle: { color: '#f85149', width: 1.2, opacity: 0.85 } })] : []),
    ],
  }), { notMerge: true });
  alignRsp();
}

// RSP 跟 VOO 價位不同：以目前可見區間第一天對齊 VOO，拖拉縮放後重新對齊
let rspRaw = new Map();
function alignRsp() {
  const rsp = overlays.RSP;
  if (!breadthChart || !loaded || !rsp.active || !rsp.rows) return;
  rspRaw = new Map(rsp.rows.map(r => [r.date, r.close]));
  const zoom = breadthChart.getOption().dataZoom?.[0] ?? {};
  const from = Number.isFinite(zoom.startValue) ? zoom.startValue : 0;
  const price = new Map(context().sessions.map(s => [s.date, s.close]));
  const base = chartDates.slice(from).find(d => rspRaw.get(d) && price.get(d));
  const k = base ? price.get(base) / rspRaw.get(base) : null;
  breadthChart.setOption({ series: [{ name: 'RSP 等權', data: chartDates.map(d => k && rspRaw.get(d) ? +(rspRaw.get(d) * k).toFixed(2) : null) }] });
}

async function toggleOverlay(name, button) {
  const overlay = overlays[name]; overlay.active = !overlay.active;
  button.classList.toggle('active', overlay.active);
  if (overlay.active && !overlay.rows) {
    overlay.error = null; refreshStatus();
    try { overlay.rows = (await readData(overlay.file)).data; }
    catch (error) { overlay.error = error.message; }
  }
  refreshStatus(); renderBreadthChart();
}

export async function init(context = {}) {
  chipPicker(el('breadth-universe-picker'), 'breadth-universe', value => selectUniverse(value));
  chipPicker(el('breadth-ma-picker'), 'breadth-ma', value => { maWindow = +value; refreshView(); });
  chipPicker(el('breadth-range-picker'), 'breadth-range', value => { range = value; renderBreadthChart(); });
  for (const [name, id] of [['VIX','breadth-vix-toggle'],['F&G','breadth-fg-toggle'],['RSP','breadth-rsp-toggle']]) if (bindOnce(el(id))) el(id).addEventListener('click', () => toggleOverlay(name, el(id)));
  if (bindOnce(el('breadth-retry'))) el('breadth-retry').addEventListener('click', () => selectUniverse(universe));
  if (loaded) { refreshView(); resize(); return; }
  await selectUniverse(universe, context);
  for (const [name, id] of [['VIX','breadth-vix-toggle'],['F&G','breadth-fg-toggle'],['RSP','breadth-rsp-toggle']]) if (!overlays[name].active && el(id)) toggleOverlay(name, el(id));
}

export function onThemeChange() {
  breadthChart?.dispose(); breadthChart = null;
  if (loaded) renderBreadthChart();
}
export function resize() { breadthChart?.resize(); }
