// 融資熱度 tab — FINRA 融資餘額 YoY% vs S&P500（Margin Debt Expansion/Contraction Indicator）
//   左軸：S&P500（對數）  右軸：Margin Debt YoY%（紅/綠警戒帶標示過熱/投降區）
//   資料：data/liquidity.json（margin[]，含 finra_margin_early.json 回補至 1997）+ data/SP500.json

import { isLight, tc, mob } from '../utils/theme.js';

let chart = null;
let forcedChart = null;
let rows  = null;  // [{date, spx, yoy, debit}]

// ── data load ────────────────────────────────────────────────────────
async function loadAll() {
  if (rows) return;
  const [liqRes, spxRes] = await Promise.all([
    fetch('data/liquidity.json', { cache: 'no-cache' }),
    fetch('data/SP500.json', { cache: 'no-cache' }),
  ]);
  if (!liqRes.ok) throw new Error(`liquidity.json: HTTP ${liqRes.status}`);
  if (!spxRes.ok) throw new Error(`SP500.json: HTTP ${spxRes.status}`);
  const liq = await liqRes.json();
  const spx = await spxRes.json();

  const margin = liq.margin ?? [];
  const debitByDate = new Map(margin.map(r => [r.date, r.debit]));

  // S&P500 daily → last close per YYYY-MM
  const spxByMonth = new Map();
  for (const r of (spx.data ?? [])) {
    spxByMonth.set(r.date.slice(0, 7), r.close);
  }

  const out = [];
  for (let i = 0; i < margin.length; i++) {
    const cur = margin[i];
    if (i < 12) continue;
    const prevDebit = margin[i - 12]?.debit;
    if (cur.debit == null || prevDebit == null) continue;
    const yoy = (cur.debit / prevDebit - 1) * 100;
    const ym = cur.date.slice(0, 7);
    const spxClose = spxByMonth.get(ym);
    if (spxClose == null) continue;
    out.push({ date: cur.date, spx: spxClose, yoy, debit: cur.debit });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  rows = out;
}

// ── chart render ──────────────────────────────────────────────────────
export function render() {
  if (!chart || !rows) return;

  const axisClr = tc('#8b949e', '#57606a');
  const gridClr = tc('rgba(48,54,61,0.5)', 'rgba(208,215,222,0.4)');
  const tipBg   = tc('#161b22', '#ffffff');
  const tipBdr  = tc('#30363d', '#d0d7de');
  const textClr = tc('#c9d1d9', '#24292f');
  const spxClr  = tc('#e6edf3', '#1f2937');
  const yoyClr  = '#f85149';

  const status = document.getElementById('marginheat-status');
  if (status) status.textContent =
    `融資熱度：FINRA Margin Debt YoY% vs S&P500 · ${rows.length} 個月（${rows[0]?.date ?? ''} ~ ${rows[rows.length - 1]?.date ?? ''}）`;

  const dates   = rows.map(r => r.date);
  const spxData = rows.map(r => +r.spx.toFixed(2));
  const yoyData = rows.map(r => +r.yoy.toFixed(2));

  const L = mob() ? 40 : 52, R = mob() ? 48 : 62;

  const yAxis = [
    {
      type: 'log', scale: true,
      name: 'S&P500', nameTextStyle: { color: spxClr, fontSize: 10 },
      axisLabel: { color: axisClr, fontSize: 11 },
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: gridClr } },
    },
    {
      type: 'value', scale: true, position: 'right',
      name: 'Margin YoY%', nameTextStyle: { color: yoyClr, fontSize: 10 },
      axisLine: { lineStyle: { color: yoyClr } },
      axisLabel: { color: yoyClr, fontSize: 10, formatter: v => v + '%' },
      splitLine: { show: false },
    },
  ];

  const yoyMarkArea = {
    silent: true,
    itemStyle: {},
    data: [
      [{ yAxis: 30, itemStyle: { color: 'rgba(248,81,73,0.12)' } }, { yAxis: 40 }],
      [{ yAxis: -40, itemStyle: { color: 'rgba(63,185,80,0.12)' } }, { yAxis: -20 }],
    ],
    label: { show: false },
  };

  const zeroMarkLine = {
    silent: true, symbol: 'none',
    lineStyle: { color: tc('#8b949e', '#57606a'), type: 'dashed', width: 1 },
    data: [{ yAxis: 0 }],
  };

  const series = [
    {
      name: 'S&P500', type: 'line', data: spxData,
      symbol: 'none', z: 2,
      itemStyle: { color: spxClr }, lineStyle: { color: spxClr, width: 1.3 },
      yAxisIndex: 0,
    },
    {
      name: 'Margin YoY%', type: 'line', data: yoyData,
      symbol: 'none', z: 5,
      itemStyle: { color: yoyClr }, lineStyle: { color: yoyClr, width: 2 },
      markArea: yoyMarkArea, markLine: zeroMarkLine,
      yAxisIndex: 1,
    },
  ];

  chart.setOption({
    backgroundColor: 'transparent', animation: false,
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'cross' },
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        const d = params[0]?.axisValue ?? '';
        let html = `<div style="font-weight:600;margin-bottom:4px">${d}</div>`;
        for (const p of params) {
          if (p.value == null) continue;
          const v = p.seriesName === 'S&P500' ? Math.round(+p.value).toLocaleString() : (+p.value).toFixed(1) + '%';
          html += `<div>${p.marker}${p.seriesName}: <b>${v}</b></div>`;
        }
        return html;
      },
    },
    legend: {
      data: ['S&P500', 'Margin YoY%'], top: 2, left: 'center',
      textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr,
    },
    grid: { left: L, right: R, top: '10%', bottom: '12%' },
    xAxis: {
      type: 'category', data: dates, boundaryGap: false,
      axisLine: { lineStyle: { color: axisClr } }, axisTick: { show: false },
      axisLabel: { color: axisClr, fontSize: 11 },
      splitLine: { show: false },
    },
    yAxis,
    dataZoom: [{ type: 'inside', filterMode: 'none' }],
    series,
  }, { notMerge: true });

  renderForced();
}

// 韓式「融資水位 × 指數背離」— 美股版:FINRA Margin Debt 絕對水位($兆) 疊 S&P500
//   美股無「已實現斷頭金額/維持率」免費源,故只有上格(水位背離),無斷頭壓力下格。
//   卡片=近18個月 S&P500 波段高點起,指數跌幅 vs 融資餘額降幅(融資月頻且落後約2個月)。
function renderForced() {
  const cardEl = document.getElementById('marginheat-forced-card');
  const host = document.getElementById('marginheat-forced-chart');
  if (!cardEl || !host || !rows || !rows.length) return;

  const axisClr = tc('#8b949e', '#57606a');
  const gridClr = tc('rgba(48,54,61,0.5)', 'rgba(208,215,222,0.4)');
  const tipBg = tc('#161b22', '#ffffff'), tipBdr = tc('#30363d', '#d0d7de');
  const textClr = tc('#c9d1d9', '#24292f');
  const spxClr = tc('#e6edf3', '#1f2937');
  const debtClr = '#e3b341';

  // 卡片:近 18 個月 S&P500 波段高點 → 指數 vs 融資餘額自高點降幅
  const win = rows.slice(-18);
  let pk = 0;
  for (let i = 1; i < win.length; i++) if (win[i].spx > win[pk].spx) pk = i;
  const peak = win[pk], now = rows.at(-1);
  const spxDrop = (now.spx / peak.spx - 1) * 100;
  const debtDrop = (now.debit / peak.debit - 1) * 100;
  const dirty = spxDrop <= -8 && debtDrop > spxDrop / 2;
  const dropSpan = v => `<span style="color:${v >= 0 ? '#f85149' : '#3fb950'};font-weight:700">${v >= 0 ? '+' : ''}${v.toFixed(1)}%</span>`;
  cardEl.innerHTML =
    `<span style="color:var(--muted);font-size:12px">自波段高 ${peak.date.slice(0, 7)} 起</span>
     <span style="font-size:13px;margin-left:10px">S&P500 ${dropSpan(spxDrop)}</span>
     <span style="color:var(--muted)">·</span>
     <span style="font-size:13px">Margin Debt ${dropSpan(debtDrop)}</span>
     <span style="color:var(--muted)">·</span>
     <span style="font-size:13px">最新 <b style="color:${debtClr}">$${(now.debit / 1e6).toFixed(2)} 兆</b> (${now.date.slice(0, 7)})</span>
     <span style="margin-left:12px;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;
       background:${dirty ? 'rgba(248,81,73,0.15)' : 'rgba(63,185,80,0.15)'};
       color:${dirty ? '#f85149' : '#3fb950'}">
       ${dirty ? '⚠ 指數跌、融資未降 → 槓桿未出清' : '融資隨指數同步'}</span>`;

  if (!forcedChart) forcedChart = echarts.init(host, isLight() ? null : 'dark');
  const dates = rows.map(r => r.date);
  const debtT = rows.map(r => +(r.debit / 1e6).toFixed(3));   // $兆
  const spxData = rows.map(r => +r.spx.toFixed(2));
  const L = mob() ? 46 : 58, R = mob() ? 46 : 60;

  forcedChart.setOption({
    backgroundColor: 'transparent', animation: false,
    tooltip: { trigger: 'axis', axisPointer: { type: 'cross' },
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        let html = `<div style="font-weight:600;margin-bottom:4px">${params[0]?.axisValue ?? ''}</div>`;
        for (const p of params) {
          if (p.value == null) continue;
          const v = p.seriesName === 'S&P500' ? Math.round(+p.value).toLocaleString() : '$' + (+p.value).toFixed(2) + ' 兆';
          html += `<div>${p.marker}${p.seriesName}: <b>${v}</b></div>`;
        }
        return html;
      } },
    legend: { data: ['Margin Debt', 'S&P500'], top: 2, left: 'center',
      textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr },
    grid: { left: L, right: R, top: '12%', bottom: '10%' },
    xAxis: { type: 'category', data: dates, boundaryGap: false,
      axisLine: { lineStyle: { color: axisClr } }, axisTick: { show: false },
      axisLabel: { color: axisClr, fontSize: 11 }, splitLine: { show: false } },
    yAxis: [
      { type: 'value', scale: true, name: '融資$兆', nameTextStyle: { color: debtClr, fontSize: 10 },
        axisLabel: { color: debtClr, fontSize: 10 }, axisLine: { show: false }, axisTick: { show: false },
        splitLine: { lineStyle: { color: gridClr } } },
      { type: 'log', scale: true, position: 'right', name: 'S&P500', nameTextStyle: { color: spxClr, fontSize: 10 },
        axisLabel: { color: axisClr, fontSize: 10 }, splitLine: { show: false } },
    ],
    dataZoom: [{ type: 'inside', filterMode: 'none' }],
    series: [
      { name: 'Margin Debt', type: 'line', data: debtT, symbol: 'none', z: 3, yAxisIndex: 0,
        itemStyle: { color: debtClr }, lineStyle: { color: debtClr, width: 1.8 },
        areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [{ offset: 0, color: 'rgba(227,179,65,0.22)' }, { offset: 1, color: 'rgba(227,179,65,0.02)' }] } },
        markLine: { silent: true, symbol: 'none', data: [
          { xAxis: peak.date, lineStyle: { color: axisClr, type: 'dashed', width: 1 },
            label: { show: !mob(), formatter: '波段高', color: axisClr, fontSize: 10, position: 'insideEndTop' } },
        ] } },
      { name: 'S&P500', type: 'line', data: spxData, symbol: 'none', z: 2, yAxisIndex: 1,
        itemStyle: { color: spxClr }, lineStyle: { color: spxClr, width: 1.3 } },
    ],
  }, { notMerge: true });
}

// ── lifecycle ─────────────────────────────────────────────────────────
export async function activate() {
  const host = document.getElementById('marginheat-chart');
  if (!host) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : 'dark');
  try {
    await loadAll();
    setTimeout(() => { chart?.resize(); render(); }, 50);
  } catch (e) {
    const s = document.getElementById('marginheat-status');
    if (s) s.textContent = '載入失敗：' + (e.message || e);
    console.error('[marginheat] load failed', e);
  }
}
export function onThemeChange(light) {
  if (!chart) return;
  chart.dispose();
  chart = echarts.init(document.getElementById('marginheat-chart'), light ? null : 'dark');
  if (forcedChart) { forcedChart.dispose(); forcedChart = null; }
  if (rows) render();
}
export function resize() { chart?.resize(); forcedChart?.resize(); }
