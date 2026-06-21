// 波浪理論 tab — 四大指數（台股/QQQ/SPY/SOXX）標準化對照線圖 + 靜態知識表格
// 資料：直接 fetch data/TWII.json + QQQ/SPY/SOXX.json（無需新 fetch 腳本）
// 標準化基準：各指數 2022/10 月內最低收盤 = 100（Wave II 底部）

import { isLight, tc } from '../utils/theme.js';

const TICKERS = [
  { file: 'data/TWII.json', key: 'TWII', label: '台股 TAIEX', color: '#E9A810', width: 2,   ltype: 'solid'  },
  { file: 'data/QQQ.json',  key: 'QQQ',  label: 'QQQ',        color: '#3fb950', width: 1.5, ltype: [6, 3]   },
  { file: 'data/SPY.json',  key: 'SPY',  label: 'SPY',        color: '#58a6ff', width: 1.5, ltype: 'dashed' },
  { file: 'data/SOXX.json', key: 'SOXX', label: 'SOXX 半導體', color: '#a371f7', width: 2,   ltype: 'solid'  },
];

const WAVE_III_DATE = '2024-07-14';
const WAVE_IV_DATE  = '2025-04-20';

let chart = null;
let rawData = {};   // key → [{date, close}]
let wRange = '4Y';
let ready = false;

// ── 公開介面 ─────────────────────────────────────────────────────────
export async function init() {
  if (ready) { render(isLight()); return; }
  const status = document.getElementById('wave-status');
  if (status) status.textContent = '載入中…';
  try {
    const jsons = await Promise.all(TICKERS.map(t => fetch(t.file).then(r => r.json())));
    TICKERS.forEach((t, i) => {
      rawData[t.key] = (jsons[i].data || []).filter(r => r.close > 0);
    });
    setupControls();
    setupInteractors();
    render(isLight());
    updateCards();
    const lastTWII = rawData['TWII']?.at(-1);
    if (lastTWII) {
      const cur = document.getElementById('wave-calc-cur');
      if (cur) cur.value = Math.round(lastTWII.close);
    }
    updateWaveCalc();
    ready = true;
    if (status) status.textContent =
      `更新至 ${jsons[0].updated || ''} ｜ 標準化基準：各指數 2022/10 低點 = 100`;
  } catch (err) {
    if (status) status.textContent = `載入失敗：${err.message}`;
  }
}

export function onThemeChange(light) { if (ready) render(light); }
export function resize() { chart?.resize(); }

// ── 控制 ──────────────────────────────────────────────────────────────
function setupControls() {
  document.querySelectorAll('#wave-range-picker .chip').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#wave-range-picker .chip')
        .forEach(b => b.classList.toggle('active', b === btn));
      wRange = btn.dataset.range;
      render(isLight());
    });
  });
}

// ── 標準化 ────────────────────────────────────────────────────────────
function getOct22Base(data) {
  const seg = data.filter(d => d.date >= '2022-10-01' && d.date <= '2022-11-30');
  if (!seg.length) return null;
  return Math.min(...seg.map(d => d.close));
}

function cutoffDate() {
  if (wRange === 'MAX') return '2022-01-01';
  const d = new Date();
  const y = { '2Y': -2, '4Y': -4 }[wRange] ?? -4;
  d.setFullYear(d.getFullYear() + y);
  return d.toISOString().slice(0, 10);
}

// ── ECharts 線圖 ──────────────────────────────────────────────────────
function render(light) {
  const el = document.getElementById('wave-chart');
  if (!el || !Object.keys(rawData).length) return;
  if (chart) { chart.dispose(); chart = null; }
  chart = echarts.init(el, light ? null : 'dark');

  const from = cutoffDate();
  const axisClr = tc('#768390', '#636e7b');
  const gridClr = tc('rgba(0,0,0,0.04)', 'rgba(255,255,255,0.05)');

  const series = [];
  for (const t of TICKERS) {
    const data = rawData[t.key];
    if (!data?.length) continue;
    const base = getOct22Base(data);
    if (!base) continue;
    const pts = data
      .filter(d => d.date >= from)
      .map(d => [d.date, +(d.close / base * 100).toFixed(2)]);

    series.push({
      name: t.label,
      type: 'line',
      data: pts,
      smooth: 0.15,
      symbol: 'none',
      lineStyle: { color: t.color, width: t.width, type: t.ltype },
      itemStyle: { color: t.color },
      ...(t.key === 'TWII' ? {
        markLine: {
          silent: true,
          symbol: ['none', 'none'],
          data: [
            { xAxis: WAVE_III_DATE, name: 'Wave III 頂',
              lineStyle: { color: '#E9A810', type: 'dashed', width: 1.5 },
              label: { show: true, formatter: '③頂\n2024/07', position: 'insideStartTop', fontSize: 10, color: '#E9A810', backgroundColor: 'transparent' } },
            { xAxis: WAVE_IV_DATE, name: 'Wave IV 底',
              lineStyle: { color: '#f85149', type: 'dashed', width: 1.5 },
              label: { show: true, formatter: '④底\n2025/04', position: 'insideStartTop', fontSize: 10, color: '#f85149', backgroundColor: 'transparent' } },
          ],
        },
        markArea: {
          silent: true,
          data: [[
            { yAxis: 368, itemStyle: { color: 'rgba(233,168,16,0.07)', borderWidth: 0 } },
            { yAxis: 422 }
          ]],
          label: { show: true, position: 'insideTopRight', formatter: '台股目標\n47k–54k', fontSize: 9, color: '#E9A810' },
        },
      } : {}),
    });
  }

  chart.setOption({
    tooltip: {
      trigger: 'axis',
      formatter: params => {
        let s = `<b>${params[0].axisValue}</b><br/>`;
        params.forEach(p => {
          const v = p.value?.[1];
          if (v != null)
            s += `<span style="color:${p.color}">●</span> ${p.seriesName}: <b>${(+v).toFixed(1)}</b><br/>`;
        });
        return s;
      },
    },
    legend: { show: false },
    grid: { top: 28, right: 28, bottom: 52, left: 60 },
    xAxis: {
      type: 'time',
      axisLabel: { fontSize: 11, color: axisClr },
      axisLine:  { lineStyle: { color: axisClr } },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      name: '基準 = 100',
      nameTextStyle: { fontSize: 10, color: axisClr },
      min: v => Math.floor(v.min * 0.96 / 10) * 10,
      axisLabel: { fontSize: 11, color: axisClr },
      splitLine: { lineStyle: { color: gridClr } },
    },
    series,
    dataZoom: [
      { type: 'inside', xAxisIndex: 0 },
      {
        type: 'slider', xAxisIndex: 0, height: 18, bottom: 6,
        fillerColor: 'rgba(128,128,128,0.1)', borderColor: 'transparent',
        handleStyle: { color: '#888' }, textStyle: { fontSize: 10, color: axisClr },
      },
    ],
  });
}

// ── 摘要卡片 ─────────────────────────────────────────────────────────
function updateCards() {
  for (const t of TICKERS) {
    const data = rawData[t.key];
    if (!data?.length) continue;
    const base = getOct22Base(data);
    const last = data[data.length - 1];
    if (!base || !last) continue;

    const norm = last.close / base * 100;
    const pct  = (norm - 100).toFixed(0);
    const absStr = t.key === 'TWII'
      ? Math.round(last.close).toLocaleString()
      : `$${Math.round(last.close)}`;

    const el = document.getElementById(`wave-card-${t.key.toLowerCase()}`);
    if (!el) continue;
    el.querySelector('.wc-pct').textContent  = `+${pct}%`;
    el.querySelector('.wc-abs').textContent  = absStr;
    el.querySelector('.wc-date').textContent = last.date;
    el.querySelector('.wc-norm').textContent = `(${norm.toFixed(1)})`;
  }
}

// ── 互動元件 ──────────────────────────────────────────────────────────
function setupInteractors() {
  const priceInput = document.getElementById('tsmc-price-input');
  if (priceInput) {
    highlightTsmcCells(+priceInput.value);
    priceInput.addEventListener('input', () => highlightTsmcCells(+priceInput.value));
  }
  ['wave-calc-w2', 'wave-calc-w3', 'wave-calc-w4', 'wave-calc-cur'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', updateWaveCalc);
  });
  ['wave-m1b-vol', 'wave-m1b-m1b'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', updateM1bGauge);
  });
  updateM1bGauge();
}

function highlightTsmcCells(price) {
  document.querySelectorAll('.tpe-cell').forEach(cell => {
    const val = +cell.dataset.val;
    const diff = (val - price) / price;
    cell.style.background = '';
    cell.style.color = '';
    cell.style.fontWeight = cell.dataset.origWeight || '';
    cell.style.outline = '';
    if (diff < -0.01) {
      cell.style.background = 'rgba(63,185,80,0.14)';
      cell.style.color = '#3fb950';
    } else if (Math.abs(diff) <= 0.06) {
      cell.style.background = 'rgba(233,168,16,0.28)';
      cell.style.fontWeight = '700';
      cell.style.outline = '2px solid rgba(233,168,16,0.65)';
    } else if (diff <= 0.15) {
      cell.style.background = 'rgba(240,136,62,0.12)';
      cell.style.color = '#f0883e';
    }
  });
}

function updateWaveCalc() {
  const w2  = +document.getElementById('wave-calc-w2')?.value  || 0;
  const w3  = +document.getElementById('wave-calc-w3')?.value  || 0;
  const w4  = +document.getElementById('wave-calc-w4')?.value  || 0;
  const cur = +document.getElementById('wave-calc-cur')?.value || 0;
  const tbody = document.getElementById('wave-calc-tbody');
  if (!tbody || !w2 || !w3 || !w4) return;
  const w1len = w3 - w2;
  const lenEl = document.getElementById('wave-calc-w1len');
  if (lenEl) lenEl.textContent = `Wave I 幅度（W3 − W2）：${w1len.toLocaleString()} 點`;
  const FIBS = [
    [1.618, '1.618×'], [2.0, '2.000×'], [2.618, '2.618×'],
    [3.0, '3.000×'],   [3.618, '3.618×'], [4.236, '4.236×'],
  ];
  tbody.innerHTML = FIBS.map(([r, lbl]) => {
    const tgt    = Math.round(w4 + w1len * r);
    const d      = cur ? ((tgt - cur) / cur * 100) : null;
    const passed = cur > 0 && tgt < cur * 0.99;
    const near   = cur > 0 && !passed && d !== null && d <= 8;
    const bg     = passed ? 'rgba(63,185,80,0.07)' : near ? 'rgba(233,168,16,0.10)' : '';
    const status = passed ? '<span style="color:#3fb950">✓ 已超越</span>'
                 : near   ? '<span style="color:#E9A810">◉ 接近</span>'
                 :          '<span style="color:var(--muted)">○ 前方</span>';
    const dStr   = d !== null
      ? `<span style="color:${passed ? '#3fb950' : '#f0883e'}">${passed || d < 0 ? '' : '+'}${d.toFixed(1)}%</span>`
      : '—';
    return `<tr style="background:${bg}">
      <td style="font-family:monospace;font-size:12px">${lbl}</td>
      <td><b>${tgt.toLocaleString()}</b></td>
      <td>${dStr}</td>
      <td>${status}</td>
    </tr>`;
  }).join('');
}

function updateM1bGauge() {
  const vol = +document.getElementById('wave-m1b-vol')?.value || 0;
  const m1b = +document.getElementById('wave-m1b-m1b')?.value || 1;
  // vol 億, m1b 兆 → ratio% = vol億 / (m1b兆 × 100)
  const ratio    = vol / (m1b * 100);
  const pctPeak  = ratio / 10 * 100;
  const ratioEl  = document.getElementById('wave-m1b-ratio');
  const fillEl   = document.getElementById('wave-m1b-gauge-fill');
  const pctEl    = document.getElementById('wave-m1b-peak-pct');
  if (ratioEl)  ratioEl.textContent  = `${ratio.toFixed(2)}%`;
  if (fillEl) {
    const w = Math.min(pctPeak, 100);
    fillEl.style.width      = `${w}%`;
    fillEl.style.background = w < 25 ? '#3fb950' : w < 55 ? '#E9A810' : w < 80 ? '#f0883e' : '#f85149';
  }
  if (pctEl) pctEl.textContent = `佔 1990 年峰值（10%）的 ${pctPeak.toFixed(1)}%`;
}
