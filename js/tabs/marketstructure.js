import { isLight, echartsBase, PALETTE } from '../utils/theme.js';
import { tsToLocalDate } from '../utils/dates.js';
import { fetchJSON } from '../utils/data.js';

const TAB_ID = 'marketstructure';
const TIMEOUT_MS = 12000;
const SOURCES = {
  cftc: { url: 'data/cftc_positions.json', label: 'CFTC', staleDays: 15 },
  cboe: { url: 'data/cboe_putcall.json', label: 'Cboe', staleDays: 7 },
  liquidity: { url: 'data/liquidity.json', label: 'FINRA', staleDays: 75 },
  aaii: { url: 'data/aaii.json', label: 'AAII', staleDays: 15 },
  vix: { url: 'data/VIX.json', label: 'Yahoo Finance · ^VIX', staleDays: 7 },
  putcall: { url: 'data/putcall.json', label: 'OCC', staleDays: 7 },
  ici: { url: 'data/ici_flows.json', label: 'ICI', staleDays: 15 },
};

const state = Object.fromEntries(Object.keys(SOURCES).map(key => [key, { phase: 'idle', data: null }]));
let charts = { cot: null, options: null, risk: null };
let requestVersion = 0;
let listenersBound = false;
let selectedCot = 'sp500';
let selectedRisk = 'vix';

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function marginYoY(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const sorted = rows.filter(row => row && typeof row.date === 'string').slice().sort((a, b) => a.date.localeCompare(b.date));
  const latest = sorted.at(-1);
  if (!latest || !finite(latest.debit)) return null;
  const [year, month] = latest.date.split('-').map(Number);
  const target = `${year - 1}-${String(month).padStart(2, '0')}`;
  const previous = sorted.find(row => row.date.startsWith(target) && finite(row.debit));
  if (!previous || previous.debit === 0) return null;
  return (latest.debit / previous.debit - 1) * 100;
}

export function aaiiSpread(row) {
  return finite(row?.bull) && finite(row?.bear) ? Math.round((row.bull - row.bear) * 10) / 10 : null;
}

function latest(rows) {
  return Array.isArray(rows) && rows.length
    ? rows.filter(row => row && typeof row.date === 'string').slice().sort((a, b) => a.date.localeCompare(b.date)).at(-1)
    : null;
}

function fmt(value, digits = 1) {
  return finite(value) ? value.toLocaleString('zh-TW', { maximumFractionDigits: digits, minimumFractionDigits: digits }) : '—';
}

function fmtInt(value) {
  return finite(value) ? Math.round(value).toLocaleString('zh-TW') : '—';
}

function ageDays(date) {
  if (!date) return Infinity;
  const time = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(time) ? Math.floor((Date.now() - time) / 86400000) : Infinity;
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function setSourceStatus(key, date, payloadStatus = 'ok', error = null) {
  const el = document.getElementById(`marketstructure-${key}-status`);
  if (!el) return;
  el.className = 'ms-source-status';
  if (state[key].phase === 'loading') {
    el.textContent = `${SOURCES[key].label} 載入中…`;
    el.classList.add('is-loading');
    return;
  }
  if (key === 'ici' && payloadStatus === 'unavailable') {
    el.textContent = '尚未接入自動更新：官方來源目前限制存取。';
    el.classList.add('is-error');
    return;
  }
  if (state[key].phase === 'error' || payloadStatus === 'unavailable') {
    el.textContent = `資料暫時無法取得；可按上方「重新整理」重試${error ? '。來源回報錯誤。' : ''}`;
    el.classList.add('is-error');
    return;
  }
  const observationStale = ageDays(date) > SOURCES[key].staleDays;
  const sourceStale = state[key].phase === 'stale' || payloadStatus === 'stale';
  const notes = [];
  if (sourceStale) notes.push('來源更新失敗，保留既有資料');
  if (observationStale) notes.push('觀測日期已超過更新門檻');
  el.textContent = `${SOURCES[key].label} · 資料日 ${date || '—'}${notes.length ? ` · ${notes.join('；')}` : ''}`;
  if (sourceStale || observationStale) el.classList.add('is-stale');
}

function renderMetricList(hostId, metrics) {
  const host = document.getElementById(hostId);
  if (!host) return;
  host.replaceChildren();
  for (const [label, value] of metrics) {
    const item = document.createElement('div');
    item.className = 'ms-metric';
    const name = document.createElement('span');
    name.className = 'ms-metric-label';
    name.textContent = label;
    const number = document.createElement('strong');
    number.textContent = value;
    item.append(name, number);
    host.append(item);
  }
}

function renderCftc() {
  const payload = state.cftc.data;
  const instruments = Array.isArray(payload?.instruments) ? payload.instruments : [];
  const host = document.getElementById('marketstructure-cftc-table');
  if (host) {
    host.replaceChildren();
    for (const instrument of instruments) {
      const row = latest(instrument.rows);
      if (!row) continue;
      const article = document.createElement('article');
      article.className = 'ms-cot-row';
      const heading = document.createElement('h4');
      heading.textContent = instrument.label || instrument.name || instrument.id || '—';
      const values = document.createElement('div');
      values.className = 'ms-cot-values';
      const entries = [
        ['槓桿資金淨部位', fmtInt(row.lev_net)],
        ['多 / 空', `${fmtInt(row.lev_long)} / ${fmtInt(row.lev_short)}`],
        ['3 年部位區間位置', finite(row.cot_index_3y) ? `${fmt(row.cot_index_3y, 1)}` : '—'],
        ['資料日', row.date || '—'],
      ];
      for (const [label, value] of entries) {
        const span = document.createElement('span');
        span.textContent = `${label}：${value}`;
        values.append(span);
      }
      article.append(heading, values);
      host.append(article);
    }
  }
  const dates = instruments.map(item => latest(item.rows)?.date).filter(Boolean).sort();
  setSourceStatus('cftc', dates.at(-1) || payload?.updated, instruments.length ? payload?.status : 'unavailable', payload?.error);
  renderCotChart();
}

function renderCboe() {
  const payload = state.cboe.data;
  const row = latest(payload?.rows);
  renderMetricList('marketstructure-cboe-metrics', [
    ['Cboe 股票選擇權 P/C', fmt(row?.equity_pc, 2)],
    ['Cboe SPX + SPXW P/C', fmt(row?.spx_pc, 2)],
  ]);
  setSourceStatus('cboe', row?.date || payload?.updated, row && finite(row.equity_pc) && finite(row.spx_pc) ? payload?.status : 'unavailable', payload?.error);
  renderOptionsChart();
}

function renderMargin() {
  const payload = state.liquidity.data;
  const row = latest(payload?.margin);
  const yoy = marginYoY(payload?.margin);
  renderMetricList('marketstructure-margin-metrics', [
    ['融資餘額（兆美元）', finite(row?.debit) ? `$${fmt(row.debit / 1e6, 2)} 兆` : '—'],
    ['年增率', finite(yoy) ? `${yoy >= 0 ? '+' : ''}${fmt(yoy, 1)}%` : '—'],
  ]);
  setSourceStatus('liquidity', row?.date, finite(row?.debit) ? 'ok' : 'unavailable');
  renderRiskChart();
}

function renderAaii() {
  const row = latest(state.aaii.data);
  const spread = aaiiSpread(row);
  renderMetricList('marketstructure-aaii-metrics', [
    ['看多', finite(row?.bull) ? `${fmt(row.bull, 1)}%` : '—'],
    ['中立', finite(row?.neutral) ? `${fmt(row.neutral, 1)}%` : '—'],
    ['看空', finite(row?.bear) ? `${fmt(row.bear, 1)}%` : '—'],
    ['多空差', finite(spread) ? `${spread >= 0 ? '+' : ''}${fmt(spread, 1)} 個百分點` : '—'],
  ]);
  setSourceStatus('aaii', row?.date, row && finite(row.bull) && finite(row.neutral) && finite(row.bear) ? 'ok' : 'unavailable');
  renderRiskChart();
}

function renderVix() {
  const row = latest(state.vix.data);
  renderMetricList('marketstructure-vix-metrics', [['VIX 收盤', fmt(row?.close, 2)]]);
  setSourceStatus('vix', row?.date, finite(row?.close) ? 'ok' : 'unavailable');
  renderRiskChart();
}

function renderOcc() {
  const payload = state.putcall.data;
  const row = latest(payload?.equity);
  renderMetricList('marketstructure-occ-metrics', [['OCC 股票選擇權 P/C（輔助）', fmt(row?.pc, 2)]]);
  setSourceStatus('putcall', row?.date, finite(row?.pc) ? 'ok' : 'unavailable');
}

function renderIci() {
  const payload = state.ici.data;
  const row = latest(payload?.rows);
  if (payload?.status === 'ok' || payload?.status === 'stale') {
    renderMetricList('marketstructure-ici-metrics', [
      ['共同基金股票淨流量', finite(row?.equity) ? `$${fmtInt(row.equity)} 百萬` : '—'],
      ['範圍', '共同基金（mutual funds）'],
    ]);
  } else {
    renderMetricList('marketstructure-ici-metrics', [['ICI 共同基金流量', '本期未納入']]);
  }
  setSourceStatus('ici', row?.date || payload?.updated, payload?.status, payload?.error);
}

const renderers = { cftc: renderCftc, cboe: renderCboe, liquidity: renderMargin, aaii: renderAaii, vix: renderVix, putcall: renderOcc, ici: renderIci };

function tooltipDate(params) {
  const first = Array.isArray(params) ? params[0] : params;
  const date = tsToLocalDate(first?.axisValue);
  const lines = (Array.isArray(params) ? params : [params]).map(item => `${item.marker}${item.seriesName}：${finite(item.value?.[1]) ? item.value[1].toLocaleString('zh-TW', { maximumFractionDigits: 2 }) : '—'}`);
  return [date, ...lines].join('<br>');
}

function timeOption(series, yName) {
  return echartsBase({
    animationDuration: 250,
    tooltip: { trigger: 'axis', formatter: tooltipDate },
    grid: { left: 64, right: 24, top: 36, bottom: 62 },
    xAxis: { type: 'time' },
    yAxis: { type: 'value', name: yName, nameTextStyle: { color: PALETTE.muted } },
    dataZoom: [
      { type: 'inside', filterMode: 'none' },
      { type: 'slider', height: 20, bottom: 14, borderColor: PALETTE.border, textStyle: { color: PALETTE.muted } },
    ],
    series,
  });
}

function chartFor(key, hostId) {
  const host = document.getElementById(hostId);
  if (!host) return null;
  if (!charts[key]) charts[key] = echarts.init(host, isLight() ? null : 'dark');
  return charts[key];
}

function showChartUnavailable(chart, message = '資料暫時無法取得') {
  if (!chart) return;
  chart.clear();
  chart.setOption({
    backgroundColor: 'transparent',
    graphic: {
      type: 'text',
      left: 'center',
      top: 'middle',
      style: { text: message, fill: PALETTE.muted, fontSize: 13 },
    },
  }, { notMerge: true });
}

function renderCotChart() {
  const chart = chartFor('cot', 'marketstructure-cot-chart');
  const instrument = state.cftc.data?.instruments?.find(item => item.id === selectedCot);
  if (!chart) return;
  document.querySelectorAll('[data-ms-cot]').forEach(button => button.classList.toggle('active', button.dataset.msCot === selectedCot));
  if (!instrument || !Array.isArray(instrument.rows) || !instrument.rows.length) {
    showChartUnavailable(chart, `${selectedCot === 'sp500' ? 'S&P 500' : selectedCot === 'nasdaq100' ? 'Nasdaq-100' : 'Russell 2000'} 暫無資料`);
    return;
  }
  const safeName = {
    sp500: 'S&P 500',
    nasdaq100: 'Nasdaq-100',
    russell2000: 'Russell 2000',
  }[instrument.id] || 'CFTC';
  chart.setOption(timeOption([{
    name: `${safeName} 槓桿資金淨部位`,
    type: 'line', showSymbol: false,
    data: (instrument.rows || []).filter(row => finite(row.lev_net)).map(row => [row.date, row.lev_net]),
    itemStyle: { color: '#58a6ff' }, lineStyle: { width: 2 },
  }], '口數'), { notMerge: true });
}

function renderOptionsChart() {
  const chart = chartFor('options', 'marketstructure-options-chart');
  const rows = state.cboe.data?.rows;
  if (!chart) return;
  if (!Array.isArray(rows) || !rows.some(row => finite(row.equity_pc) || finite(row.spx_pc))) {
    showChartUnavailable(chart);
    return;
  }
  chart.setOption(timeOption([
    { name: 'Cboe 股票選擇權', type: 'line', showSymbol: false, data: rows.filter(r => finite(r.equity_pc)).map(r => [r.date, r.equity_pc]), itemStyle: { color: '#3fb950' }, lineStyle: { width: 2 } },
    { name: 'Cboe SPX + SPXW', type: 'line', showSymbol: false, data: rows.filter(r => finite(r.spx_pc)).map(r => [r.date, r.spx_pc]), itemStyle: { color: '#d29922' }, lineStyle: { width: 2 } },
  ], 'Put / Call'), { notMerge: true });
}

function riskSeries() {
  if (selectedRisk === 'margin') {
    return { name: 'FINRA 融資餘額（兆美元）', rows: state.liquidity.data?.margin, value: row => finite(row.debit) ? row.debit / 1e6 : null, color: '#a371f7', unit: '兆美元' };
  }
  if (selectedRisk === 'aaii') {
    return { name: 'AAII 多空差', rows: state.aaii.data, value: aaiiSpread, color: '#f0883e', unit: '百分點' };
  }
  return { name: 'VIX 收盤', rows: state.vix.data, value: row => row.close, color: '#f85149', unit: '點' };
}

function renderRiskChart() {
  const chart = chartFor('risk', 'marketstructure-risk-chart');
  const selected = riskSeries();
  if (!chart) return;
  document.querySelectorAll('[data-ms-risk]').forEach(button => button.classList.toggle('active', button.dataset.msRisk === selectedRisk));
  if (!Array.isArray(selected.rows) || !selected.rows.some(row => finite(selected.value(row)))) {
    showChartUnavailable(chart);
    return;
  }
  chart.setOption(timeOption([{
    name: selected.name, type: 'line', showSymbol: false,
    data: selected.rows.map(row => [row.date, selected.value(row)]).filter(point => finite(point[1])),
    itemStyle: { color: selected.color }, lineStyle: { width: 2 }, areaStyle: { opacity: 0.08 },
  }], selected.unit), { notMerge: true });
}

function isUsableDataset(key, data) {
  if (key === 'cftc') {
    return ['sp500', 'nasdaq100', 'russell2000'].every(id => {
      const row = latest(data?.instruments?.find(item => item.id === id)?.rows);
      return row && finite(row.lev_long) && finite(row.lev_short) && finite(row.lev_net);
    });
  }
  if (key === 'cboe') {
    const row = latest(data?.rows);
    return row && finite(row.equity_pc) && finite(row.spx_pc);
  }
  if (key === 'liquidity') return finite(latest(data?.margin)?.debit);
  if (key === 'aaii') {
    const row = latest(data);
    return row && finite(row.bull) && finite(row.neutral) && finite(row.bear);
  }
  if (key === 'vix') return finite(latest(data)?.close);
  if (key === 'putcall') return finite(latest(data?.equity)?.pc);
  return key === 'ici' && data && typeof data === 'object';
}

async function fetchWithTimeout(url) {
  let timer;
  try {
    return await Promise.race([
      fetchJSON(url),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function loadDataset(key, version) {
  const previous = state[key].data;
  state[key] = { phase: 'loading', data: previous };
  setSourceStatus(key);
  try {
    const data = await fetchWithTimeout(SOURCES[key].url);
    if (version !== requestVersion) return;
    if (!isUsableDataset(key, data)) throw new Error('invalid or empty payload');
    state[key] = { phase: 'ready', data };
  } catch (error) {
    if (version !== requestVersion) return;
    state[key] = isUsableDataset(key, previous)
      ? { phase: 'stale', data: previous }
      : { phase: 'error', data: null };
    console.error(`[${TAB_ID}] ${key} load failed`, error);
  }
  if (version === requestVersion) renderers[key]();
}

async function loadAll() {
  const version = ++requestVersion;
  setText('marketstructure-overall-status', '正在更新各資料區塊…');
  const results = await Promise.allSettled(Object.keys(SOURCES).map(key => loadDataset(key, version)));
  if (version !== requestVersion) return;
  const items = Object.values(state);
  const unavailable = items.filter(item => item.phase === 'error' || item.data?.status === 'unavailable').length;
  const stale = items.filter(item => item.phase === 'stale' || item.data?.status === 'stale').length;
  const notes = [];
  if (unavailable) notes.push(`${unavailable} 個資料區塊暫時無法取得`);
  if (stale) notes.push(`${stale} 個資料區塊沿用既有資料`);
  setText('marketstructure-overall-status', notes.length ? `${notes.join('；')}。其餘區塊已更新。` : '各資料區塊已更新。');
  void results;
}

function bindListeners() {
  if (listenersBound) return;
  listenersBound = true;
  document.getElementById('marketstructure-retry')?.addEventListener('click', loadAll);
  document.querySelectorAll('[data-ms-cot]').forEach(button => button.addEventListener('click', () => {
    selectedCot = button.dataset.msCot;
    renderCotChart();
  }));
  document.querySelectorAll('[data-ms-risk]').forEach(button => button.addEventListener('click', () => {
    selectedRisk = button.dataset.msRisk;
    renderRiskChart();
  }));
}

export async function activate() {
  if (!document.getElementById('tab-marketstructure')) return;
  bindListeners();
  if (Object.values(state).some(item => item.phase === 'ready')) {
    resize();
    return;
  }
  await loadAll();
}

export function onThemeChange(_light) {
  for (const chart of Object.values(charts)) chart?.dispose();
  charts = { cot: null, options: null, risk: null };
  renderCotChart();
  renderOptionsChart();
  renderRiskChart();
}

export function resize() {
  Object.values(charts).forEach(chart => chart?.resize());
}
