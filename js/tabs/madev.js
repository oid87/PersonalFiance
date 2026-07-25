// 乖離率 tab — 任意 MA 週期的乖離率 +（正/負門檻）區間高亮
//   資料：直接讀 data/{QQQ,VOO,SOXX,0050.TW}.json 收盤價，前端即時計算，無另開 fetch 腳本。
//   乖離率 = (close / MA - 1) * 100，rolling 右對齊，無未來函數。
//   ⚠️ MA 一律用「全歷史」算完再依時間範圍裁切，切到短區間也不會有暖身缺口。
//   ⚠️ data/*.json 是未還原息收盤價（同 kelly tab 的已知落差），乖離率與還原息版本會有小幅差異。
//   圖表鐵則：下格 y 軸依「顯示區間」實際 min/max + padding，不固定窗口，避免把線裁出畫面。

import { isLight, tc, PALETTE } from '../utils/theme.js';
import { computeMA } from '../utils/math.js';

const RANGE_DAYS = { '1Y': 365, '3Y': 365 * 3, '5Y': 365 * 5, '10Y': 365 * 10, 'MAX': null };

const POS_CLR = '#f85149';
const NEG_CLR = '#3fb950';

let chart = null;
const cache = {};           // ticker -> [{date, close}]
let ticker = 'QQQ';
let maPeriod = 200;
let posThr = 15;
let negThr = -15;
let showMA = true;
let range = '5Y';
let computed = null;

// ── data ──────────────────────────────────────────────────────────────
async function loadData(t) {
  if (cache[t]) return cache[t];
  const resp = await fetch(`data/${t}.json`, { cache: 'no-cache' });
  if (!resp.ok) throw new Error(`${t}.json: HTTP ${resp.status}`);
  const j = await resp.json();
  cache[t] = (j.data || []).map(r => ({ date: r.date, close: r.close }));
  return cache[t];
}

// ── compute ───────────────────────────────────────────────────────────
// MA 用全歷史算，再依 range 裁切顯示區間（切短區間不會有暖身缺口）
function compute(bars) {
  const pairs = bars.map(b => [b.date, b.close]);
  const maByDate = new Map(computeMA(pairs, maPeriod));

  const cutoff = RANGE_DAYS[range] == null ? null
    : new Date(Date.now() - RANGE_DAYS[range] * 86400000).toISOString().slice(0, 10);
  const view = cutoff == null ? bars : bars.filter(b => b.date >= cutoff);

  const dates = view.map(b => b.date);
  const closes = view.map(b => b.close);
  const ma = view.map(b => maByDate.get(b.date) ?? null);
  const dev = view.map((b, i) => (ma[i] != null ? (b.close / ma[i] - 1) * 100 : null));

  return { dates, closes, ma, dev, ...segStats(dates, dev) };
}

// 連續區間掃描：dev >= posThr / dev <= negThr
function findSegments(dates, dev, test) {
  const segs = [];
  let start = null, prev = null;
  for (let i = 0; i < dev.length; i++) {
    const v = dev[i];
    if (v == null) continue;
    if (test(v)) { if (start == null) start = i; }
    else if (start != null) { segs.push({ s: start, e: prev, days: prev - start + 1 }); start = null; }
    prev = i;
  }
  if (start != null) segs.push({ s: start, e: prev, days: prev - start + 1 });
  return segs.map(g => ({ ...g, from: dates[g.s], to: dates[g.e] }));
}

function segStats(dates, dev) {
  const posSegs = findSegments(dates, dev, v => v >= posThr);
  const negSegs = findSegments(dates, dev, v => v <= negThr);
  const valid = dev.filter(v => v != null);
  const sorted = [...valid].sort((a, b) => a - b);
  const pct = p => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))] : null);
  return {
    posSegs, negSegs, nValid: valid.length,
    posDays: posSegs.reduce((a, g) => a + g.days, 0),
    negDays: negSegs.reduce((a, g) => a + g.days, 0),
    p10: pct(0.10), p50: pct(0.50), p90: pct(0.90),
    lo: sorted.length ? sorted[0] : null, hi: sorted.length ? sorted[sorted.length - 1] : null,
  };
}

// ── badges ────────────────────────────────────────────────────────────
function setText(id, txt, color) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = txt;
  if (color) el.style.color = color;
}
const fmt = v => (v == null ? 'N/A' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);

function updateBadges(r) {
  let lastIdx = -1;
  for (let i = r.dev.length - 1; i >= 0; i--) if (r.dev[i] != null) { lastIdx = i; break; }
  const now = lastIdx >= 0 ? r.dev[lastIdx] : null;

  setText('madev-now-val', fmt(now), now == null ? PALETTE.text : (now >= posThr ? POS_CLR : now <= negThr ? NEG_CLR : PALETTE.text));
  setText('madev-now-sub', lastIdx >= 0
    ? `${r.dates[lastIdx]}｜收 ${r.closes[lastIdx].toFixed(2)}｜MA${maPeriod} ${r.ma[lastIdx].toFixed(2)}` : '—', 'var(--muted)');

  const share = (d) => (r.nValid ? (d / r.nValid * 100).toFixed(1) : '0.0');
  const lastSeg = segs => (segs.length ? segs[segs.length - 1] : null);

  const ps = lastSeg(r.posSegs);
  setText('madev-pos-val', `${r.posSegs.length} 段`, POS_CLR);
  setText('madev-pos-sub', `≥ ${fmt(posThr)}｜共 ${r.posDays} 天（${share(r.posDays)}%）` +
    (ps ? `｜最近 ${ps.from}~${ps.to}` : ''), 'var(--muted)');

  const ns = lastSeg(r.negSegs);
  setText('madev-neg-val', `${r.negSegs.length} 段`, NEG_CLR);
  setText('madev-neg-sub', `≤ ${fmt(negThr)}｜共 ${r.negDays} 天（${share(r.negDays)}%）` +
    (ns ? `｜最近 ${ns.from}~${ns.to}` : ''), 'var(--muted)');

  setText('madev-dist-val', `${fmt(r.p10)} / ${fmt(r.p50)} / ${fmt(r.p90)}`, PALETTE.text);
  setText('madev-dist-sub', `p10 / 中位 / p90｜區間 ${fmt(r.lo)} ~ ${fmt(r.hi)}`, 'var(--muted)');

  const status = document.getElementById('madev-status');
  if (status) status.textContent = r.dates.length
    ? `${ticker} · MA${maPeriod} · ${r.dates.length} 根日K（${r.dates[0]} ~ ${r.dates[r.dates.length - 1]}）· ` +
      `有效乖離 ${r.nValid} 天 · 正乖離 ${r.posSegs.length} 段 / 負乖離 ${r.negSegs.length} 段`
    : `${ticker} · MA${maPeriod} · 此時間範圍無資料`;
}

// ── render ────────────────────────────────────────────────────────────
function render(r) {
  if (!chart) return;
  const axisClr = PALETTE.muted;
  const gridClr = tc('rgba(48,54,61,0.5)', 'rgba(208,215,222,0.4)');
  const textClr = PALETTE.text2;

  const dates = r.dates;
  const grid = [
    { left: 64, right: 30, top: '8%', height: '44%' },
    { left: 64, right: 30, top: '60%', height: '28%' },
  ];
  const xAxis = grid.map((_, i) => ({
    gridIndex: i, type: 'category', data: dates, boundaryGap: false,
    axisLine: { lineStyle: { color: axisClr } }, axisTick: { show: false },
    axisLabel: { show: i === 1, color: axisClr, fontSize: 11 }, splitLine: { show: false },
  }));

  // 下格 y 軸依顯示區間實際範圍 + 5% padding（門檻線也納入），確保門檻與線都在畫面內
  const cand = [r.lo, r.hi, posThr, negThr, 0].filter(v => v != null);
  const dLo = Math.min(...cand), dHi = Math.max(...cand);
  const padY = Math.max(1, (dHi - dLo) * 0.08);

  const yAxis = [
    { gridIndex: 0, scale: true, name: `${ticker} 收盤`, nameTextStyle: { color: axisClr, fontSize: 10 },
      axisLabel: { color: axisClr, fontSize: 11 },
      axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: gridClr } } },
    { gridIndex: 1, min: +(dLo - padY).toFixed(2), max: +(dHi + padY).toFixed(2),
      name: `MA${maPeriod} 乖離%`, nameTextStyle: { color: axisClr, fontSize: 10 },
      axisLabel: { color: axisClr, fontSize: 11, formatter: v => v + '%' },
      axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: gridClr } } },
  ];

  // 區間高亮：兩格同步（上格看價格位置、下格看乖離大小）
  const areasFor = (segs, color) => ({
    silent: true, itemStyle: { color },
    data: segs.map(g => ([{ xAxis: dates[g.s] }, { xAxis: dates[g.e] }])),
  });
  const posArea = areasFor(r.posSegs, 'rgba(248,81,73,0.16)');
  const negArea = areasFor(r.negSegs, 'rgba(63,185,80,0.16)');
  const mergeAreas = (a, b) => ({
    silent: true,
    data: [...a.data.map(d => [{ ...d[0], itemStyle: a.itemStyle }, d[1]]),
           ...b.data.map(d => [{ ...d[0], itemStyle: b.itemStyle }, d[1]])],
  });

  const priceSeries = {
    name: ticker, type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: r.closes,
    showSymbol: false, connectNulls: false, z: 5,
    itemStyle: { color: '#58a6ff' }, lineStyle: { color: '#58a6ff', width: 1.4 },
    markArea: mergeAreas(posArea, negArea),
  };
  const maSeries = {
    name: `MA${maPeriod}`, type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: r.ma,
    showSymbol: false, connectNulls: false, z: 4,
    itemStyle: { color: '#e3830a' }, lineStyle: { color: '#e3830a', width: 1.6 },
  };
  const devSeries = {
    name: '乖離%', type: 'line', xAxisIndex: 1, yAxisIndex: 1, data: r.dev,
    showSymbol: false, connectNulls: false, z: 5,
    itemStyle: { color: '#bc8cff' }, lineStyle: { color: '#bc8cff', width: 1.3 },
    markLine: {
      silent: true, symbol: 'none',
      data: [
        { yAxis: 0, lineStyle: { color: axisClr, type: 'dashed', width: 1, opacity: 0.6 },
          label: { formatter: '0', color: axisClr, fontSize: 9, position: 'insideEndTop' } },
        { yAxis: posThr, lineStyle: { color: POS_CLR, type: 'solid', width: 1.2 },
          label: { formatter: `正乖離 ${fmt(posThr)}`, color: POS_CLR, fontSize: 10, position: 'insideEndTop' } },
        { yAxis: negThr, lineStyle: { color: NEG_CLR, type: 'solid', width: 1.2 },
          label: { formatter: `負乖離 ${fmt(negThr)}`, color: NEG_CLR, fontSize: 10, position: 'insideEndBottom' } },
      ],
    },
    markArea: mergeAreas(posArea, negArea),
  };

  chart.setOption({
    backgroundColor: 'transparent', animation: false,
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'cross', link: [{ xAxisIndex: 'all' }] },
      backgroundColor: PALETTE.bg, borderColor: PALETTE.border, textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        const d = params[0]?.axisValue ?? '';
        let html = `<div style="font-weight:600;margin-bottom:4px">${d}</div>`;
        for (const p of params) {
          if (p.value == null) continue;
          const v = p.seriesName === '乖離%' ? fmt(+p.value) : (+p.value).toFixed(2);
          html += `<div>${p.marker}${p.seriesName}: <b>${v}</b></div>`;
        }
        return html;
      },
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid, xAxis, yAxis,
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1], filterMode: 'none' },
      { type: 'slider', xAxisIndex: [0, 1], height: 16, bottom: 4 },
    ],
    legend: [{
      data: [ticker, `MA${maPeriod}`, '乖離%'],
      selected: { [`MA${maPeriod}`]: showMA },
      top: 2, left: 'center', textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr,
    }],
    series: [priceSeries, maSeries, devSeries],
  }, { notMerge: true });
}

// ── controls ──────────────────────────────────────────────────────────
function pickGroup(host, sel, cb) {
  host.querySelectorAll(sel).forEach(c => c.addEventListener('click', () => {
    host.querySelectorAll(sel).forEach(e => e.classList.remove('active'));
    c.classList.add('active');
    cb(c);
  }));
}

function syncMaPreset() {
  document.querySelectorAll('#madev-ma-preset .chip').forEach(c =>
    c.classList.toggle('active', +c.dataset.madevMa === maPeriod));
}

function buildControls() {
  const host = document.getElementById('tab-madev');
  if (!host || host.dataset.built) return;
  host.dataset.built = '1';

  pickGroup(host, '#madev-ticker-picker .chip', c => { ticker = c.dataset.madevTicker; refresh(); });
  pickGroup(host, '#madev-range-picker .chip', c => { range = c.dataset.madevRange; refresh(); });

  const maInput = document.getElementById('madev-ma');
  host.querySelectorAll('#madev-ma-preset .chip').forEach(c => c.addEventListener('click', () => {
    maPeriod = +c.dataset.madevMa;
    maInput.value = maPeriod;
    syncMaPreset();
    refresh();
  }));
  maInput.addEventListener('change', () => {
    const v = Math.round(+maInput.value);
    if (!Number.isFinite(v) || v < 2 || v > 1000) { maInput.value = maPeriod; return; }
    maPeriod = v; maInput.value = v; syncMaPreset(); refresh();
  });

  const posInput = document.getElementById('madev-pos');
  const negInput = document.getElementById('madev-neg');
  posInput.addEventListener('change', () => {
    const v = +posInput.value;
    if (!Number.isFinite(v)) { posInput.value = posThr; return; }
    posThr = v; refresh();
  });
  negInput.addEventListener('change', () => {
    const v = +negInput.value;
    if (!Number.isFinite(v)) { negInput.value = negThr; return; }
    negThr = v; refresh();
  });

  document.getElementById('madev-show-ma').addEventListener('click', e => {
    showMA = !showMA;
    e.currentTarget.classList.toggle('active', showMA);
    if (computed) render(computed);
  });
}

async function refresh() {
  const status = document.getElementById('madev-status');
  try {
    const bars = await loadData(ticker);
    computed = compute(bars);
    render(computed);
    updateBadges(computed);
  } catch (e) {
    if (status) status.textContent = `載入失敗：${e.message}`;
    console.error('[madev] load failed', e);
  }
}

// ── lifecycle ─────────────────────────────────────────────────────────
export async function activate() {
  const host = document.getElementById('madev-chart');
  if (!host) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : 'dark');
  else chart.resize();
  buildControls();
  if (computed) { render(computed); updateBadges(computed); return; }
  await refresh();
}
export function onThemeChange(light) {
  if (!chart) return;
  chart.dispose();
  chart = echarts.init(document.getElementById('madev-chart'), light ? null : 'dark');
  if (computed) { render(computed); updateBadges(computed); }
}
export function resize() { chart?.resize(); }
