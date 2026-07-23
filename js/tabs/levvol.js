// 波動率倍數 tab — 驗證「槓桿 ETF 已實現波動率 ≈ 倍數 × 標的」在各窗口是否穩定。
// 資料：完全複用 data/leverage.json（etfs[].real vs underlyings[etf.underlying].data），
// 不新增任何 fetch。前端算 log return 的 rolling std ratio，對照理論槓桿倍數。
import { isLight, tc, mob } from '../utils/theme.js';

const WINDOWS = [5, 21, 63, 126, 252];
const WINDOW_LABEL = { 5: '5日', 21: '21日(月)', 63: '63日(季)', 126: '126日(半年)', 252: '252日(年)' };
const LINE_COLORS = ['#58a6ff', '#3fb950', '#e3b341', '#f778ba', '#f85149'];

let chart = null;
let BUNDLE = null;
let loadPromise = null;
let curId = 'TQQQ';
let wired = false;

const $ = id => document.getElementById(id);

// ── data load ────────────────────────────────────────────────────────────
async function loadBundle() {
  if (BUNDLE) return BUNDLE;
  if (!loadPromise) loadPromise = fetch('data/leverage.json', { cache: 'no-cache' })
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  BUNDLE = await loadPromise;
  return BUNDLE;
}

// ── math helpers ─────────────────────────────────────────────────────────
function logReturns(pairs) {
  // pairs: [[date, price], ...] sorted ascending, aligned. Returns {dates, rets}
  const dates = [], rets = [];
  for (let i = 1; i < pairs.length; i++) {
    const p0 = pairs[i - 1][1], p1 = pairs[i][1];
    if (p0 > 0 && p1 > 0) { dates.push(pairs[i][0]); rets.push(Math.log(p1 / p0)); }
  }
  return { dates, rets };
}
function std(arr) {
  const n = arr.length;
  if (n === 0) return null;
  const m = arr.reduce((a, b) => a + b, 0) / n;
  const v = arr.reduce((a, b) => a + (b - m) * (b - m), 0) / n;
  return Math.sqrt(v);
}
function rollingRatio(etfRets, underRets, w) {
  // etfRets/underRets already date-aligned same length. Returns array length n with null before window fills.
  const n = etfRets.length, out = new Array(n).fill(null);
  for (let i = w - 1; i < n; i++) {
    const eSlice = etfRets.slice(i - w + 1, i + 1);
    const uSlice = underRets.slice(i - w + 1, i + 1);
    const sU = std(uSlice);
    out[i] = sU > 0 ? std(eSlice) / sU : null;
  }
  return out;
}
function median(sorted) {
  const n = sorted.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function percentile(sorted, p) {
  const n = sorted.length;
  if (n === 0) return null;
  const idx = p * (n - 1), lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }

// ── pair alignment + compute ─────────────────────────────────────────────
function innerJoinByDate(a, b) {
  // a, b: [[date, price], ...] sorted ascending. Returns aligned {aVals, bVals} in date order.
  const bMap = new Map(b);
  const aVals = [], bVals = [];
  for (const [d, v] of a) {
    if (bMap.has(d)) { aVals.push([d, v]); bVals.push([d, bMap.get(d)]); }
  }
  return { aVals, bVals };
}

function computePair(etf) {
  const under = BUNDLE.underlyings[etf.underlying];
  if (!under) return null;
  const { aVals: etfPairs, bVals: underPairs } = innerJoinByDate(etf.real, under.data);
  if (etfPairs.length < WINDOWS[WINDOWS.length - 1] + 5) return null;

  const { dates, rets: etfRets } = logReturns(etfPairs);
  const { rets: underRets } = logReturns(underPairs);
  // dates/etfRets/underRets are all aligned (same source pairs → same index).

  const dailyBaseline = (() => {
    const sU = std(underRets);
    return sU > 0 ? std(etfRets) / sU : null;
  })();

  const windows = WINDOWS.map(w => {
    const ratioArr = rollingRatio(etfRets, underRets, w);
    const clean = ratioArr.filter(v => v != null).sort((a, b) => a - b);
    return {
      w,
      series: dates.map((d, i) => [d, ratioArr[i]]),
      median: median(clean),
      mean: mean(clean),
      p5: percentile(clean, 0.05),
      p95: percentile(clean, 0.95),
      n: clean.length,
    };
  });

  return { dates, etfRets, underRets, dailyBaseline, windows, startDate: dates[0], endDate: dates[dates.length - 1] };
}

// ── controls ──────────────────────────────────────────────────────────
function buildPairSelect() {
  const sel = $('levvol-pair');
  if (!sel || sel.dataset.built) return;
  sel.dataset.built = '1';
  sel.innerHTML = BUNDLE.etfs.map(e =>
    `<option value="${e.id}" ${e.id === curId ? 'selected' : ''}>${e.id} / ${e.underlying} (${e.leverage}x)</option>`
  ).join('');
  sel.addEventListener('change', () => { curId = sel.value; render(); });
}

// ── rendering ─────────────────────────────────────────────────────────
function setStatus(t) { const el = $('levvol-status'); if (el) el.textContent = t; }

function renderTable(etf, r) {
  const host = $('levvol-table');
  if (!host) return;
  const fmt = v => v == null ? '—' : v.toFixed(3);
  let rows = r.windows.map(w => `<tr>
    <td>${WINDOW_LABEL[w.w]}</td>
    <td>${fmt(w.median)}</td>
    <td>${fmt(w.mean)}</td>
    <td>${fmt(w.p5)}</td>
    <td>${fmt(w.p95)}</td>
    <td>${etf.leverage.toFixed(1)}</td>
  </tr>`).join('');
  rows += `<tr style="border-top:2px solid var(--border)">
    <td>單日基準（全期）</td>
    <td colspan="4">${fmt(r.dailyBaseline)}</td>
    <td>${etf.leverage.toFixed(1)}</td>
  </tr>`;
  host.innerHTML = `<table class="info-table">
    <thead><tr><th>窗口</th><th>median</th><th>mean</th><th>p5</th><th>p95</th><th>理論值</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderChart(etf, r) {
  const axisClr = tc('#8b949e', '#57606a');
  const splitClr = tc('rgba(255,255,255,.06)', 'rgba(0,0,0,.07)');
  const tipBg = tc('#161b22', '#ffffff'), tipBd = tc('#30363d', '#d0d7de'), tipTx = tc('#e6edf3', '#1f2328');

  const series = r.windows.map((w, idx) => ({
    name: `w=${w.w}`, type: 'line', data: w.series,
    showSymbol: false, sampling: 'lttb', connectNulls: false,
    lineStyle: { width: 1.4, color: LINE_COLORS[idx % LINE_COLORS.length] },
    itemStyle: { color: LINE_COLORS[idx % LINE_COLORS.length] },
  }));
  if (series.length) {
    series[series.length - 1].markLine = {
      silent: true, symbol: 'none',
      lineStyle: { color: axisClr, type: 'dashed', width: 1.5 },
      label: { formatter: `理論值 ${etf.leverage}x`, color: axisClr, fontSize: 10, position: 'insideEndTop' },
      data: [{ yAxis: etf.leverage }],
    };
  }

  chart.setOption({
    backgroundColor: 'transparent', animation: false,
    grid: { top: 40, right: mob() ? 14 : 26, bottom: 44, left: mob() ? 44 : 56 },
    legend: { top: 4, textStyle: { color: tipTx, fontSize: 11 }, itemWidth: 16, itemHeight: 8 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: tipBg, borderColor: tipBd, textStyle: { color: tipTx, fontSize: 12 },
      formatter(params) {
        if (!params.length) return '';
        const ax = params[0].axisValue;
        const head = typeof ax === 'number' ? new Date(ax).toISOString().slice(0, 10) : ax;
        let html = `<div style="font-weight:600;margin-bottom:4px">${head}</div>`;
        for (const p of params) {
          const v = p.value && p.value[1];
          html += `<div>${p.marker}${p.seriesName}: <b>${v == null ? '—' : (+v).toFixed(3)}</b></div>`;
        }
        return html;
      },
    },
    xAxis: {
      type: 'time',
      axisLine: { lineStyle: { color: axisClr } }, axisTick: { show: false },
      axisLabel: { color: axisClr, fontSize: 11 }, splitLine: { show: false },
    },
    yAxis: {
      type: 'value', scale: true, name: '波動率比值（ETF / 標的）',
      nameTextStyle: { color: axisClr, fontSize: 10 },
      axisLine: { show: false },
      axisLabel: { color: axisClr, fontSize: 11 },
      splitLine: { lineStyle: { color: splitClr } },
    },
    dataZoom: [{ type: 'inside', filterMode: 'none' }],
    series,
  }, { notMerge: true });
}

function render() {
  if (!chart || !BUNDLE) return;
  const etf = BUNDLE.etfs.find(e => e.id === curId);
  if (!etf) return;
  const r = computePair(etf);
  if (!r) {
    setStatus(`${etf.id} 資料不足（重疊交易日 < ${WINDOWS[WINDOWS.length - 1] + 5} 天），無法計算`);
    chart.clear();
    $('levvol-table').innerHTML = '';
    return;
  }
  renderChart(etf, r);
  renderTable(etf, r);
  setStatus(`${etf.id} vs ${etf.underlying} · 理論槓桿 ${etf.leverage}x · 重疊交易日 ${r.dates.length.toLocaleString()} · ${r.startDate} → ${r.endDate}`);
}

// ── lifecycle (switcher API) ────────────────────────────────────────────
export async function init() {
  const host = $('levvol-chart');
  if (!host) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : 'dark');
  setTimeout(async () => {
    chart.resize();
    if (!BUNDLE) {
      setStatus('載入槓桿資料中…');
      try { await loadBundle(); } catch (e) { setStatus('載入失敗：' + e.message); console.error('[levvol] load failed', e); return; }
    }
    buildPairSelect();
    render();
  }, 50);
}
export function onThemeChange(light) {
  if (!chart) return;
  chart.dispose();
  chart = echarts.init($('levvol-chart'), light ? null : 'dark');
  if (BUNDLE) render();
}
export function resize() { chart && chart.resize(); }
