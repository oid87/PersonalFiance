import { initAdvancedPanel, advancedThemeChange, resizeAdvancedPanel } from './breadthAdvancedPanel.js';
import { isLight, mob, PALETTE, echartsBase } from '../utils/theme.js';
import { bindOnce, chipPicker } from '../utils/dom.js';
import { buildBreadthContext, getBreadthDenominator } from './breadthSignals.mjs';
import { evaluateEventStudy, HORIZONS } from '../utils/eventStudy.mjs';

const UNIVERSE_CONFIG = {
  SP500: { dataFile: 'data/breadth.json', overlayFile: 'data/SPY.json', overlayName: 'SPY', label: 'S&P 500' },
  NDX: { dataFile: 'data/breadth_ndx.json', overlayFile: 'data/QQQ.json', overlayName: 'QQQ', label: 'Nasdaq-100' },
  XLG: { dataFile: 'data/breadth_xlg.json', overlayFile: 'data/XLG.json', overlayName: 'XLG', label: '市值前50代理股票群' },
  TW50: { dataFile: 'data/breadth_tw50.json', overlayFile: 'data/0050.TW.json', overlayName: '0050', label: '台灣50' },
};
const cache = new Map();
const overlays = { VIX: { file: 'data/VIX.json', active: false, rows: null, error: null }, 'F&G': { file: 'data/fear_greed.json', active: false, rows: null, error: null } };
let universe = 'SP500', maWindow = 50, range = '2Y', requestSequence = 0;
let loaded = null, breadthChart = null, studyChart = null, study = null, selectedDate = null;
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


async function readData(file) {
  const response = await fetch(file, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${file} HTTP ${response.status}`);
  const json = await response.json();
  if (!Array.isArray(json.data) || !json.data.length) throw new Error(`${file} 資料為空或格式錯誤`);
  return json;
}

function clearView() {
  loaded = null; study = null; selectedDate = null;
  breadthChart?.clear(); studyChart?.clear();
  el('breadth-regime').textContent = '資料不足';
  el('breadth-study-status').textContent = '等待股票群資料';
  el('breadth-study-table').replaceChildren(); el('breadth-study-events').replaceChildren();
  el('breadth-study-selection').textContent = '';
  document.querySelectorAll('#breadth-top .bc-pct, #breadth-top .bc-count, #breadth-top .bc-signal').forEach(node => { node.textContent = '—'; });
}

async function selectUniverse(next) {
  universe = next;
  const sequence = ++requestSequence;
  clearView();
  el('breadth-status').textContent = `${cfg().label} 載入中…`;
  el('breadth-retry').hidden = true;
  try {
    if (!cache.has(next)) {
      const config = UNIVERSE_CONFIG[next];
      const [data, pricesJson] = await Promise.all([readData(config.dataFile), readData(config.overlayFile)]);
      const prices = pricesJson.data;
      const contexts = Object.fromEntries([20, 50, 200].map(window => [window, buildBreadthContext(data.data, prices, window)]));
      cache.set(next, { data, prices, contexts });
    }
    if (sequence !== requestSequence) return;
    loaded = cache.get(next);
    refreshView();
  } catch (error) {
    if (sequence !== requestSequence) return;
    clearView();
    el('breadth-status').textContent = `${cfg().label} 載入失敗：${error.message}`;
    el('breadth-retry').hidden = false;
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
  el('breadth-status').textContent = `${cfg().label}／${cfg().overlayName} · 卡片廣度日期 ${c.latestBreadthDate} · ETF最後日期 ${c.latestPriceDate} · 共同可用日期 ${c.commonDate ?? '—'}。兩者可能不同步。${overlayStatus}`;
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
  refreshStatus(); renderStudy();
}

function renderStudy() {
  if (!loaded) return;
  const c = context(), horizon = +el('breadth-study-horizon').value;
  study = evaluateEventStudy({ prices: loaded.prices, events: c.signals[el('breadth-study-signal').value], eligibleDates: c.eligibleDates, horizons: HORIZONS, from: cutoff(el('breadth-study-range').value, c.latestBreadthDate), pathHorizon: horizon });
  if (!study.events.some(event => event.date === selectedDate)) selectedDate = null;
  const stats = study.stats.find(row => row.horizon === horizon);
  el('breadth-study-status').textContent = `原始事件 ${study.rawN}／20交易日冷卻後 ${study.keptN} · ${horizon}交易日有效 n=${stats.n} · 排除：未完成 ${stats.excluded.incomplete}、缺價 ${stats.excluded.missingPrice} · 重疊對數 ${stats.overlapPairs}/${stats.possiblePairs}。${stats.n < 10 ? '小樣本（n<10），結果可能不穩定。' : ''}資料軸為ETF有記錄的交易日，非完整交易所日曆。`;
  const headings = ['交易日','有效n','平均報酬','中位報酬','上漲率','基準有效n','基準平均','基準中位','基準上漲率','平均報酬差（pp）','平均訊號日起最大虧損','最差訊號日起最大虧損','平均期間最大回撤','最差期間最大回撤'];
  el('breadth-study-table').innerHTML = `<thead><tr>${headings.map(text => `<th>${text}</th>`).join('')}</tr></thead><tbody>${study.stats.map(s => `<tr data-horizon="${s.horizon}"><td>${s.horizon}</td><td>${s.n}</td>${[s.mean,s.median,s.winRate].map(value => `<td>${percent(value)}</td>`).join('')}<td>${s.baseline.n}</td>${[s.baseline.mean,s.baseline.median,s.baseline.winRate].map(value => `<td>${percent(value)}</td>`).join('')}<td>${s.mean == null || s.baseline.mean == null ? '—' : number(s.mean - s.baseline.mean)}</td>${[s.meanMaxLoss,s.worstMaxLoss,s.meanMdd,s.worstMdd].map(value => `<td>${percent(value)}</td>`).join('')}</tr>`).join('')}</tbody>`;
  el('breadth-study-events').innerHTML = `<thead><tr><th>訊號日期／選取</th><th>廣度</th><th>前日廣度</th><th>ETF收盤／均線</th><th>${horizon}交易日報酬</th><th>訊號日起最大虧損</th><th>期間最大回撤</th><th>完成狀態</th></tr></thead><tbody>${[...study.events].reverse().map(event => {
    const outcome = event.outcomes[horizon];
    return `<tr><td><button type="button" data-event-date="${event.date}" aria-pressed="${selectedDate === event.date}">${event.date}</button></td><td>${percent(event.pct)}</td><td>${percent(event.previousPct)}</td><td>${number(event.close)} / ${number(event.ma)}</td><td>${percent(outcome.forwardReturnPct)}</td><td>${percent(outcome.maxLossPct)}</td><td>${percent(outcome.mddPct)}</td><td>${outcome.status === 'complete' ? '已完成' : outcome.status === 'incomplete' ? '未完成' : '缺價'}${outcome.exitDate ? ` · ${outcome.exitDate}` : ''}</td></tr>`;
  }).join('')}</tbody>`;
  if (!study.events.length) el('breadth-study-events').innerHTML += '<caption>此條件與範圍無保留事件</caption>';
  renderStudyChart(); renderBreadthChart();
}

function renderStudyChart() {
  if (!study) return;
  if (!studyChart) studyChart = echarts.init(el('breadth-study-chart'), isLight() ? null : 'dark');
  const paths = study.paths, individual = paths.individual.find(path => path.date === selectedDate);
  el('breadth-study-selection').textContent = individual ? `選取 ${individual.date}：${individual.complete ? '完整路徑' : '未完成或缺價，缺口後不補線'}；訊號日=100` : '點選下方事件日期查看個別路徑。';
  studyChart.setOption(echartsBase({
    title: { text: `固定完整樣本 n=${paths.n} · ${paths.horizon}交易日`, textStyle: { color: PALETTE.text, fontSize: 13 } },
    tooltip: { confine: true },
    graphic: paths.n ? [] : [{ type: 'text', left: 'center', top: '45%', style: { text: '無完整事件可計算分位帶', fill: PALETTE.muted } }],
    grid: { top: 44, bottom: 58 },
    xAxis: { data: paths.points.map(point => point.offset), name: '交易日', nameLocation: 'middle', nameGap: 30 }, yAxis: { scale: true, name: '訊號日=100' },
    series: [
      { name: 'P25底', type: 'line', stack: 'band', data: paths.points.map(p => p.p25), symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { opacity: 0 }, tooltip: { show: false } },
      { name: 'P25–P75帶寬', type: 'line', stack: 'band', data: paths.points.map(p => p.p75 == null ? null : p.p75-p.p25), symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { color: '#58a6ff', opacity: 0.18 }, tooltip: { show: false } },
      { name: '中位數', type: 'line', data: paths.points.map(p => p.median), symbol: 'none', lineStyle: { color: '#58a6ff', width: 2 } },
      ...(individual ? [{ name: `${individual.date}${individual.complete ? '' : '（未完成／缺價）'}`, type: 'line', data: individual.values, connectNulls: false, symbol: 'none', lineStyle: { color: '#f0883e', width: 2 } }] : []),
    ],
  }), { notMerge: true });
}

export function renderBreadthChart() {
  if (!loaded) return;
  if (!breadthChart) breadthChart = echarts.init(el('breadth-chart'), isLight() ? null : 'dark');
  const c = context(), start = cutoff(range, c.latestBreadthDate);
  const sessions = c.sessions.filter(s => s.date >= loaded.data.data[0].date && s.date <= c.commonDate && (!start || s.date >= start));
  const dates = sessions.map(s => s.date), dateSet = new Set(dates);
  const priceMap = new Map(sessions.map(s => [s.date,s.close]));
  const line = (name, data, axis, color, extra = {}) => ({ name, type: 'line', data, yAxisIndex: axis, symbol: 'none', connectNulls: false, lineStyle: { color, width: 1.7 }, ...extra });
  const marker = (name, eventDates, symbol, color) => ({ name, type: 'scatter', data: eventDates.filter(d => dateSet.has(d)).map(d => [d, priceMap.get(d)]), yAxisIndex: 1, symbol, symbolSize: 16, itemStyle: { color } });
  const overlaySeries = Object.entries(overlays).filter(([, o]) => o.active && o.rows).map(([name, o]) => {
    const values = new Map(o.rows.map(row => [row.date, row.close ?? row.value]));
    return line(name, dates.map(date => values.get(date) ?? null), 2, name === 'VIX' ? '#f0883e' : '#e3b341');
  });
  breadthChart.setOption(echartsBase({
    dataZoom: [], grid: { top: 28, bottom: 36, left: mob() ? 44 : 56, right: mob() ? 52 : 68 },
    tooltip: { confine: true, formatter(params) {
      const entries = Array.isArray(params) ? params : [params];
      const date = entries[0]?.axisValue ?? entries[0]?.value?.[0];
      const session = sessions.find(s => s.date === date);
      let html = `<b>${date ?? ''}</b>`;
      for (const p of entries) {
        const value = Array.isArray(p.value) ? p.value[1] : p.value;
        if (!Number.isFinite(value)) continue;
        html += `<div>${p.marker}${p.seriesName}: ${number(value, 2)}${p.seriesIndex === 2 || p.seriesIndex === 3 ? '%' : ''}</div>`;
      }
      if (session?.row) for (const window of [20,50,200]) {
        const denominator = getBreadthDenominator(session.row, window);
        html += `<div>${window}MA: ${session.row[`above${window}_count`] ?? '—'} / ${denominator ?? '分母未記錄'}</div>`;
      }
      return html;
    } },
    xAxis: { data: dates, boundaryGap: false },
    yAxis: [
      { type: 'value', min: 0, max: 100, axisLabel: { color: PALETTE.muted, formatter: '{value}%' }, splitLine: { lineStyle: { color: PALETTE.grid } } },
      { type: 'value', position: 'right', scale: true, axisLabel: { color: PALETTE.muted }, splitLine: { show: false } },
      { type: 'value', position: 'right', axisLabel: { show: false }, splitLine: { show: false } },
    ],
    series: [line(cfg().overlayName, sessions.map(s => s.close), 1, '#a371f7'),
      line(`${cfg().overlayName} ${maWindow}MA`, sessions.map(s => s.ma), 1, '#d2a8ff', { lineStyle: { color: '#d2a8ff', type: 'dashed' } }),
      line(`${maWindow}日均線以上`, sessions.map(s => s.pct), 0, '#58a6ff', { markLine: { silent: true, symbol: 'none', data: [15,25,50,75,85].map(yAxis => ({ yAxis, label: { formatter: `${yAxis}%` } })) } }),
      line('90交易日完整滾動高點', dates.map(date => c.peakByDate[date]), 0, '#8b949e'),
      ...overlaySeries, marker('興登堡觸發（簡化版）', c.hindenburgDates, 'pin', '#f85149'),
      marker('研究保留訊號', study?.events.map(e => e.date) ?? [], 'triangle', '#e3b341')],
  }), { notMerge: true });
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

export async function init() {
  initAdvancedPanel();
  chipPicker(el('breadth-universe-picker'), 'breadth-universe', value => selectUniverse(value));
  chipPicker(el('breadth-ma-picker'), 'breadth-ma', value => { maWindow = +value; refreshView(); });
  chipPicker(el('breadth-range-picker'), 'breadth-range', value => { range = value; renderBreadthChart(); });
  for (const id of ['breadth-study-signal','breadth-study-range','breadth-study-horizon']) if (bindOnce(el(id))) el(id).addEventListener('change', renderStudy);
  if (bindOnce(el('breadth-study-events'))) el('breadth-study-events').addEventListener('click', event => {
    const button = event.target.closest('button[data-event-date]');
    if (!button) return;
    selectedDate = button.dataset.eventDate;
    el('breadth-study-events').querySelectorAll('button').forEach(node => node.setAttribute('aria-pressed', String(node === button)));
    renderStudyChart();
  });
  for (const [name, id] of [['VIX','breadth-vix-toggle'],['F&G','breadth-fg-toggle']]) if (bindOnce(el(id))) el(id).addEventListener('click', () => toggleOverlay(name, el(id)));
  if (bindOnce(el('breadth-retry'))) el('breadth-retry').addEventListener('click', () => selectUniverse(universe));
  if (loaded) { refreshView(); resize(); return; }
  await selectUniverse(universe);
}

export function onThemeChange(light) {
  advancedThemeChange();
  for (const chart of [breadthChart,studyChart]) chart?.dispose();
  breadthChart = null; studyChart = null;
  if (loaded) { renderBreadthChart(); renderStudyChart(); }
}
export function resize() { breadthChart?.resize(); studyChart?.resize(); resizeAdvancedPanel(); }
