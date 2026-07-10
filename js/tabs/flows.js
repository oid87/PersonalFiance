// 資金脈衝 tab — weekly signed dollar volume (proxy for ETF fund flows)
//   SOXX+SMH (半導體), QQQ (科技), 0050.TW (台灣50)
//   bar chart: volume × close × weekly return sign
//   optional overlays: CNN Fear & Greed (weekly avg) + VIX (weekly close)
//   資料：data/flows.json + data/fear_greed.json + data/VIX.json

import { isLight, tc, mob } from '../utils/theme.js';

const TICKERS = [
  { key: 'semi', label: '半導體 (SOXX+SMH)', unit: '$', color: '#1a3a6b', colorDark: '#3987e5' },
  { key: 'qqq',  label: 'QQQ (Nasdaq-100)',   unit: '$', color: '#0f6e56', colorDark: '#1baf7a' },
  { key: 'tw50', label: '0050.TW (台灣50)',   unit: 'NT$', color: '#854f0b', colorDark: '#eda100' },
];

const FG_COLOR  = '#3fb950';
const VIX_COLOR = '#f85149';

let chart = null;
let activeTicker = 'semi';
let range = 'MAX';
let showFG = false;
let showVIX = false;
let rawData = null;
let fgWeekly = null;   // Map<date, avgFG>
let vixWeekly = null;  // Map<date, closeVIX>

// ── QQQ 板塊資金流向榜（sub-view）───────────────────────────────────────
const SECTOR_WINDOWS = { '1d': '當日', '5d': '5 日', '20d': '20 日' };
let view = 'timeseries';       // 'timeseries' | 'sector'
let sectorWindow = '1d';
let sectorData = null;
let sectorLoadPromise = null;

async function loadAll() {
  if (rawData) return;
  const r = await fetch('data/flows.json', { cache: 'no-cache' });
  if (!r.ok) throw new Error(`flows.json: HTTP ${r.status}`);
  rawData = await r.json();

  const [fgRes, vixRes] = await Promise.all([
    fetch('data/fear_greed.json', { cache: 'no-cache' }).catch(() => null),
    fetch('data/VIX.json', { cache: 'no-cache' }).catch(() => null),
  ]);

  if (fgRes?.ok) {
    const fgJson = await fgRes.json();
    fgWeekly = dailyToWeeklyAvg(fgJson.data ?? [], 'value');
  }
  if (vixRes?.ok) {
    const vixJson = await vixRes.json();
    vixWeekly = dailyToWeeklyLast(vixJson.data ?? [], 'close');
  }
}

function dailyToWeeklyAvg(rows, field) {
  const buckets = new Map();
  for (const r of rows) {
    const wk = weekKey(r.date);
    if (!wk) continue;
    if (!buckets.has(wk)) buckets.set(wk, []);
    buckets.get(wk).push(r[field]);
  }
  const result = new Map();
  for (const [wk, vals] of buckets) {
    result.set(wk, vals.reduce((a, b) => a + b, 0) / vals.length);
  }
  return result;
}

function dailyToWeeklyLast(rows, field) {
  const buckets = new Map();
  for (const r of rows) {
    const wk = weekKey(r.date);
    if (!wk) continue;
    buckets.set(wk, r[field]);
  }
  return buckets;
}

function weekKey(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return null;
  const day = d.getDay();
  const diff = day === 0 ? 0 : 7 - day;
  d.setDate(d.getDate() + diff);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${dd}`;
}

function cutoffDate(key) {
  if (key === 'MAX') return '0000-00-00';
  const d = new Date();
  const yrs = { '3Y': 3, '5Y': 5, '10Y': 10 }[key] ?? 10;
  d.setFullYear(d.getFullYear() - yrs);
  return d.toISOString().slice(0, 10);
}

function setText(id, txt, color) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = txt;
  if (color) el.style.color = color;
}

function updateCards(rows) {
  const last = rows[rows.length - 1];
  const ticker = TICKERS.find(t => t.key === activeTicker);
  const unit = ticker.unit;

  const v = last.flow;
  const clr = v >= 0 ? '#3fb950' : '#f85149';
  setText('flows-cur-val', (v >= 0 ? '+' : '') + v.toFixed(1) + 'B', clr);
  setText('flows-cur-sub', `${last.date}（${unit} billions）`, 'var(--muted)');
  setText('flows-cur-signal', v >= 0 ? '週正向成交動能' : '週負向成交動能', clr);

  const absVals = rows.map(r => Math.abs(r.flow)).sort((a, b) => a - b);
  const absLast = Math.abs(v);
  const rank = absVals.filter(x => x <= absLast).length;
  const pct = ((rank / absVals.length) * 100).toFixed(0);
  const extreme = parseInt(pct) >= 95;
  const eClr = extreme ? '#f85149' : tc('#c9d1d9', '#24292f');
  setText('flows-rank-val', `${pct}%`, eClr);
  setText('flows-rank-sub', `|${v.toFixed(1)}B| 在 ${rows.length} 週中的百分位`, 'var(--muted)');
  setText('flows-rank-signal', extreme ? '極端值 — 群體擁擠訊號' : '歷史常態範圍', eClr);

  let maxRow = rows[0];
  for (const r of rows) { if (r.flow > maxRow.flow) maxRow = r; }
  setText('flows-max-val', '+' + maxRow.flow.toFixed(1) + 'B', '#58a6ff');
  setText('flows-max-sub', `${maxRow.date}（歷史最大正向週）`, 'var(--muted)');
  const ratio = (v / maxRow.flow * 100).toFixed(0);
  setText('flows-max-signal', `本週 = 歷史峰值的 ${ratio}%`, 'var(--muted)');
}

function render() {
  if (!chart || !rawData) return;

  const ticker = TICKERS.find(t => t.key === activeTicker);
  const allRows = rawData[activeTicker] ?? [];
  const cut = cutoffDate(range);
  const rows = allRows.filter(r => r.date >= cut);

  if (!rows.length) return;

  updateCards(rows);

  const axisClr = tc('#8b949e', '#57606a');
  const gridClr = tc('rgba(48,54,61,0.5)', 'rgba(208,215,222,0.4)');
  const tipBg   = tc('#161b22', '#ffffff');
  const tipBdr  = tc('#30363d', '#d0d7de');
  const textClr = tc('#c9d1d9', '#24292f');
  const barClr  = isLight() ? ticker.color : ticker.colorDark;

  const dates = rows.map(r => r.date);
  const flows = rows.map(r => r.flow);

  let maxIdx = 0, minIdx = 0;
  for (let i = 0; i < flows.length; i++) {
    if (flows[i] > flows[maxIdx]) maxIdx = i;
    if (flows[i] < flows[minIdx]) minIdx = i;
  }

  const bgColors = flows.map((v, i) => {
    if (i === maxIdx) return '#e24b4a';
    if (i === minIdx) return '#f0883e';
    return barClr;
  });

  const unit = ticker.unit;
  const L = mob() ? 40 : 52;
  const hasRight = showFG || showVIX;
  const R = hasRight ? (mob() ? 48 : 62) : (mob() ? 16 : 28);

  const status = document.getElementById('flows-status');
  if (status) status.textContent =
    `${ticker.label} 週頻簽名成交量 · ${rows.length} 週（${range}）· 紅＝歷史最大正向 · 橘＝歷史最大負向`;

  // ── y axes ──
  const yAxis = [
    {
      type: 'value', scale: true,
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: {
        color: axisClr, fontSize: 11,
        formatter: v => v === 0 ? '0' : (v > 0 ? '' : '(') + Math.abs(v).toFixed(0) + (v < 0 ? ')' : ''),
      },
      splitLine: { lineStyle: { color: gridClr } },
      name: `${unit} billions`,
      nameTextStyle: { color: axisClr, fontSize: 10 },
    },
  ];

  if (hasRight) {
    const rName = (showFG && showVIX) ? 'F&G / VIX' : showFG ? 'F&G' : 'VIX';
    yAxis.push({
      type: 'value', position: 'right',
      min: 0,
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: axisClr, fontSize: 10 },
      splitLine: { show: false },
      name: rName,
      nameTextStyle: { color: axisClr, fontSize: 10 },
    });
  }

  // ── series ──
  const series = [{
    name: 'Flow', type: 'bar',
    data: flows, yAxisIndex: 0, z: 1,
    itemStyle: { color: (p) => bgColors[p.dataIndex] },
    barMaxWidth: 4,
    markLine: {
      silent: true, symbol: 'none',
      data: [{ yAxis: 0, lineStyle: { color: axisClr, width: 1 }, label: { show: false } }],
    },
    markPoint: {
      symbol: 'diamond', symbolSize: 10,
      data: [{
        coord: [dates[maxIdx], flows[maxIdx]],
        itemStyle: { color: '#e24b4a' },
        label: {
          show: true, position: 'top', distance: 8,
          formatter: `Week of\n${dates[maxIdx]?.substring(5)}`,
          color: textClr, fontSize: 10, fontWeight: 500, lineHeight: 14,
        },
      }],
    },
  }];

  const legendData = [];

  if (showFG && fgWeekly) {
    const fgData = dates.map(d => fgWeekly.has(d) ? +fgWeekly.get(d).toFixed(1) : null);
    legendData.push('F&G');
    series.push({
      name: 'F&G', type: 'line', data: fgData,
      yAxisIndex: 1, z: 3,
      symbol: 'none', connectNulls: true,
      itemStyle: { color: FG_COLOR },
      lineStyle: { color: FG_COLOR, width: 1.5, opacity: 0.85 },
    });
  }

  if (showVIX && vixWeekly) {
    const vixData = dates.map(d => vixWeekly.has(d) ? +vixWeekly.get(d).toFixed(1) : null);
    legendData.push('VIX');
    series.push({
      name: 'VIX', type: 'line', data: vixData,
      yAxisIndex: 1, z: 3,
      symbol: 'none', connectNulls: true,
      itemStyle: { color: VIX_COLOR },
      lineStyle: { color: VIX_COLOR, width: 1.5, opacity: 0.85 },
    });
  }

  chart.setOption({
    backgroundColor: 'transparent',
    animation: false,
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      backgroundColor: tipBg, borderColor: tipBdr,
      textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        const d = params[0]?.axisValue ?? '';
        let html = `<div style="font-weight:600;margin-bottom:4px">Week of ${d}</div>`;
        for (const p of params) {
          if (p.value == null) continue;
          if (p.seriesName === 'Flow') {
            const v = p.value;
            html += `<div>${p.marker}${(v >= 0 ? '+' : '') + v.toFixed(2)} ${unit}B</div>`;
          } else {
            html += `<div>${p.marker}${p.seriesName}: <b>${(+p.value).toFixed(1)}</b></div>`;
          }
        }
        return html;
      },
    },
    legend: legendData.length ? {
      data: legendData, top: 4, left: 'center',
      textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr,
    } : { show: false },
    grid: { left: L, right: R, top: 40, bottom: '12%' },
    xAxis: {
      type: 'category', data: dates, boundaryGap: true,
      axisLine: { lineStyle: { color: axisClr } },
      axisTick: { show: false },
      axisLabel: {
        color: axisClr, fontSize: 11, showMaxLabel: true,
        formatter(val) {
          const m = val.substring(5, 7);
          if (m === '01' && parseInt(val.substring(8, 10)) <= 7) return val.substring(0, 4);
          return '';
        },
      },
      splitLine: { show: false },
    },
    yAxis,
    dataZoom: [{ type: 'inside', filterMode: 'none' }],
    series,
  }, { notMerge: true });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

async function loadSectorData() {
  if (sectorData) return;
  if (!sectorLoadPromise) {
    sectorLoadPromise = fetch('data/qqq_sector_flows.json', { cache: 'no-cache' })
      .then(r => {
        if (!r.ok) throw new Error(`qqq_sector_flows.json: HTTP ${r.status}`);
        return r.json();
      })
      .then(j => { sectorData = j; });
  }
  await sectorLoadPromise;
}

function renderSectorRank() {
  const host = document.getElementById('flows-sector-rank');
  if (!host) return;

  if (!sectorData) { host.innerHTML = ''; return; }

  const rows = sectorData.windows?.[sectorWindow] ?? [];
  const status = document.getElementById('flows-sector-status');
  const note = document.getElementById('flows-sector-note');
  if (note) note.textContent = sectorData.note ?? '';

  if (!rows.length) {
    host.innerHTML = `<div class="status">此視窗無資料</div>`;
    if (status) status.textContent = '—';
    return;
  }

  const maxAbs = Math.max(...rows.map(r => Math.abs(r.flow)), 1e-9);
  const textClr  = tc('#c9d1d9', '#24292f');
  const trackBg  = tc('rgba(255,255,255,0.05)', 'rgba(0,0,0,0.05)');
  const posColor = tc('#f85149', '#cf222e');  // 紅＝淨流入
  const negColor = tc('#3fb950', '#1a7f37');  // 綠＝淨流出
  const labelW = mob() ? 92 : 168;
  const valW   = mob() ? 56 : 68;

  host.innerHTML = rows.map(r => {
    const pct = Math.max(1, Math.min(100, Math.abs(r.flow) / maxAbs * 100));
    const isPos = r.flow >= 0;
    const barColor = isPos ? posColor : negColor;
    const sign = isPos ? '+' : '';
    const label = `${r.group}（${r.count}）`;
    return `
      <div style="display:flex;align-items:center;gap:8px;margin:3px 0;font-size:12px;line-height:16px">
        <div style="width:${labelW}px;flex:0 0 auto;color:${textClr};text-align:right;
                    overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
             title="${escapeHtml(r.group)} · ${r.count} 檔 · ${r.days} 個淨流入日">${escapeHtml(label)}</div>
        <div style="flex:1 1 auto;position:relative;height:15px;background:${trackBg};border-radius:2px;overflow:hidden">
          <div style="position:absolute;top:0;bottom:0;left:0;width:${pct}%;background:${barColor};border-radius:2px"></div>
        </div>
        <div style="width:${valW}px;flex:0 0 auto;color:${barColor};font-weight:600;text-align:right">${sign}${r.flow.toFixed(1)}B</div>
      </div>`;
  }).join('');

  if (status) {
    const winLabel = SECTOR_WINDOWS[sectorWindow] ?? sectorWindow;
    status.textContent =
      `${winLabel}窗 · ${rows.length} 組 · 成分覆蓋 ${sectorData.coverage?.mapped ?? '?'}/${sectorData.coverage?.total ?? '?'} 檔 · 更新於 ${sectorData.updated ?? ''} · 數字＝${winLabel}窗淨流入天數/組內檔數`;
  }
}

function applyView() {
  const tsHost = document.getElementById('flows-timeseries-view');
  const secHost = document.getElementById('flows-sector-view');
  if (tsHost) tsHost.hidden = view !== 'timeseries';
  if (secHost) secHost.hidden = view !== 'sector';
  if (view === 'timeseries') {
    setTimeout(() => { chart?.resize(); }, 30);
  } else {
    loadSectorData()
      .then(renderSectorRank)
      .catch(e => {
        const status = document.getElementById('flows-sector-status');
        if (status) status.textContent = '載入失敗：' + (e.message || e);
        console.error('[flows] sector load failed', e);
      });
  }
}

function buildControls() {
  const sw = document.getElementById('flows-ticker-picker');
  if (sw && !sw.dataset.built) {
    sw.dataset.built = '1';
    sw.addEventListener('click', e => {
      const t = e.target.closest('.chip[data-flows-ticker]');
      if (!t) return;
      activeTicker = t.dataset.flowsTicker;
      sw.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c === t));
      render();
    });
  }
  const rp = document.getElementById('flows-range-picker');
  if (rp && !rp.dataset.built) {
    rp.dataset.built = '1';
    rp.addEventListener('click', e => {
      const t = e.target.closest('.chip[data-flows-range]');
      if (!t) return;
      range = t.dataset.flowsRange;
      rp.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c === t));
      render();
    });
  }
  const fgBtn = document.getElementById('flows-fg-toggle');
  if (fgBtn && !fgBtn.dataset.built) {
    fgBtn.dataset.built = '1';
    fgBtn.addEventListener('click', () => {
      showFG = !showFG;
      fgBtn.classList.toggle('active', showFG);
      render();
    });
  }
  const vixBtn = document.getElementById('flows-vix-toggle');
  if (vixBtn && !vixBtn.dataset.built) {
    vixBtn.dataset.built = '1';
    vixBtn.addEventListener('click', () => {
      showVIX = !showVIX;
      vixBtn.classList.toggle('active', showVIX);
      render();
    });
  }

  const vp = document.getElementById('flows-view-picker');
  if (vp && !vp.dataset.built) {
    vp.dataset.built = '1';
    vp.addEventListener('click', e => {
      const t = e.target.closest('.chip[data-flows-view]');
      if (!t) return;
      view = t.dataset.flowsView;
      vp.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c === t));
      applyView();
    });
  }
  const swp = document.getElementById('flows-sector-window-picker');
  if (swp && !swp.dataset.built) {
    swp.dataset.built = '1';
    swp.addEventListener('click', e => {
      const t = e.target.closest('.chip[data-flows-sector-window]');
      if (!t) return;
      sectorWindow = t.dataset.flowsSectorWindow;
      swp.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c === t));
      renderSectorRank();
    });
  }
}

// ── lifecycle ─────────────────────────────────────────────────────────
export async function activate() {
  const host = document.getElementById('flows-chart');
  if (!host) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : 'dark');
  buildControls();
  applyView();
  try {
    await loadAll();
    setTimeout(() => { chart?.resize(); render(); }, 50);
  } catch (e) {
    const s = document.getElementById('flows-status');
    if (s) s.textContent = '載入失敗：' + (e.message || e);
    console.error('[flows] load failed', e);
  }
}
export function onThemeChange(light) {
  if (chart) {
    chart.dispose();
    chart = echarts.init(document.getElementById('flows-chart'), light ? null : 'dark');
    if (rawData) render();
  }
  if (view === 'sector' && sectorData) renderSectorRank();
}
export function resize() { chart?.resize(); }
