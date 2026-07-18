// 融資熱度 tab — FINRA 融資餘額 YoY% vs S&P500（Margin Debt Expansion/Contraction Indicator）
//   左軸：S&P500（對數）  右軸：Margin Debt YoY%（紅/綠警戒帶標示過熱/投降區）
//   資料：data/liquidity.json（margin[]，含 finra_margin_early.json 回補至 1997）+ data/SP500.json

import { isLight, tc, mob, PALETTE } from '../utils/theme.js';

let chart = null;
let forcedChart = null;
let rows  = null;  // [{date, spx, yoy, debit}]

// ── 子圖 A/B 專用 state ──────────────────────────────────────────────────
let freecreditChart = null;
let freecreditRows  = null;  // [{date, ratio}] — 只從 margin 首個非 null 月份起算
let unwindChart  = null;
let unwindMarket = 'us';     // 'us' | 'tw'
let usDebitSeries = null;    // [{date, value}] — FINRA margin debt，月頻，全史（不要求 spx 對齊）
let twMarginSeries = null;   // [{date, value}] — 台股融資餘額（億元），日頻，lazy load
let domInjected = false;

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

  // 子圖 A：debit / (cash + margin free credit)。
  // 早期 FINRA 回補史料（1997 起）margin 欄位是 null（未分列融資帳戶餘額），
  // 只有 cash。禁止把缺值的 margin 欄位當成零來補——那會讓分母憑空變大、製造假崖。
  // 定案：主線只從 margin 首個非 null 的月份起算，之前的月份直接不畫。
  freecreditRows = margin
    .filter(r => r.margin != null && r.cash != null && r.debit != null)
    .map(r => ({ date: r.date, ratio: r.debit / (r.cash + r.margin) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // 子圖 B（美股）：FINRA margin debt 全史，不要求與 S&P500 對齊。
  usDebitSeries = margin
    .filter(r => r.debit != null)
    .map(r => ({ date: r.date, value: r.debit }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// 台股融資餘額（taiwan_margin_total.json）— lazy load，只在切到 TW 時抓。
async function ensureTwMargin() {
  if (twMarginSeries) return twMarginSeries;
  const r = await fetch('data/taiwan_margin_total.json', { cache: 'no-cache' });
  if (!r.ok) throw new Error(`taiwan_margin_total.json: HTTP ${r.status}`);
  const j = await r.json();
  twMarginSeries = (j.data ?? [])
    .filter(d => d.margin_money != null)
    .map(d => ({ date: d.date, value: d.margin_money }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return twMarginSeries;
}

// ── chart render ──────────────────────────────────────────────────────
export function render() {
  if (!chart || !rows) return;

  const axisClr = PALETTE.muted;
  const gridClr = tc('rgba(48,54,61,0.5)', 'rgba(208,215,222,0.4)');
  const tipBg   = PALETTE.bg;
  const tipBdr  = PALETTE.border;
  const textClr = PALETTE.text2;
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
    lineStyle: { color: PALETTE.muted, type: 'dashed', width: 1 },
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

  const axisClr = PALETTE.muted;
  const gridClr = tc('rgba(48,54,61,0.5)', 'rgba(208,215,222,0.4)');
  const tipBg = PALETTE.bg, tipBdr = PALETTE.border;
  const textClr = PALETTE.text2;
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

// ── 百分位 rank（binary search，同 bullbear.js percentileRank 手法）──────
function percentileOf(val, sortedAsc) {
  if (!sortedAsc.length) return null;
  let lo = 0, hi = sortedAsc.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedAsc[mid] < val) lo = mid + 1; else hi = mid;
  }
  return (lo / sortedAsc.length) * 100;
}

// 動態插入子圖 A/B 的 DOM（index.html 不得改動，故在此以 JS 建立節點；
// 沿用既有 .breadth-card / .chip 樣式，避免新增 CSS）。冪等：只插入一次。
function ensureExtraDom() {
  if (domInjected) return;
  const tableWrap = document.getElementById('marginheat-table')?.closest('div');
  if (!tableWrap) return;
  tableWrap.insertAdjacentHTML('beforebegin', `
    <div style="padding:0 16px;margin-top:18px">
      <div class="aaii-table-title" style="margin-bottom:8px;display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px">
        <span>融資 / 現金緩衝比 — debit ÷ (cash + margin free credit)</span>
        <span id="marginheat-freecredit-pct" style="font-size:13px"></span>
      </div>
      <div id="marginheat-freecredit-note" style="color:var(--muted);font-size:12px;margin-bottom:6px"></div>
      <div id="marginheat-freecredit-chart" style="width:100%;height:320px"></div>
      <p style="color:var(--muted);font-size:12px;margin-top:6px">
        分子＝FINRA margin debt，分母＝現金帳戶＋融資帳戶的 free credit 合計。比值越高＝散戶手上現金緩衝越薄、越危險。
      </p>
    </div>
    <div style="padding:0 16px;margin-top:18px">
      <div class="aaii-table-title" style="margin-bottom:8px;display:flex;align-items:center;gap:10px">
        <span>出清進度狀態機 — 本輪加了多少、吐回多少</span>
        <span id="marginheat-unwind-toggle" style="display:flex;gap:4px">
          <span class="chip active" data-unwind-mkt="us">美股</span>
          <span class="chip" data-unwind-mkt="tw">台股</span>
        </span>
      </div>
      <div id="marginheat-unwind-summary" style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:8px"></div>
      <div id="marginheat-unwind-chart" style="width:100%;height:320px"></div>
      <p style="color:var(--muted);font-size:12px;margin-top:6px">
        窗口：台股近 750 個交易日／美股近 36 個月。base＝窗口起點到峰值間的最低點（本輪加槓桿起點）、peak＝窗口內最高點、current＝最新一筆。
        出清進度% = (peak − current) / (peak − base) × 100，clamp 到 0–100。
        <b>只顯示當前狀態的單一數字與標記線，不畫「出清進度」的歷史時間序列</b>——peak/base 是用整個窗口 argmax/argmin 回頭取的，
        若逐日回推畫成序列，每個歷史點都會用到當時實際上還不知道的未來峰值，構成前視偏誤（look-ahead bias）。
        ⚠️ 台股融資餘額過去數年基本單邊上升，base 容易卡在窗口起點而非真正的循環低點——窗口拉長會不斷找到更早更低的 base，
        故台股「出清進度%」僅供近期局部參考，不代表本輪多年加槓桿週期的真實去化程度。
      </p>
    </div>
  `);
  domInjected = true;

  document.getElementById('marginheat-unwind-toggle')?.addEventListener('click', (e) => {
    const t = e.target.closest('.chip[data-unwind-mkt]');
    if (!t) return;
    unwindMarket = t.dataset.unwindMkt;
    for (const c of e.currentTarget.querySelectorAll('.chip')) c.classList.toggle('active', c === t);
    renderUnwind();
  });
}

// ── 子圖 A：融資 / 現金緩衝比 ────────────────────────────────────────────
function renderFreeCredit() {
  if (!freecreditChart || !freecreditRows || !freecreditRows.length) return;

  const axisClr = PALETTE.muted;
  const gridClr = tc('rgba(48,54,61,0.5)', 'rgba(208,215,222,0.4)');
  const tipBg   = PALETTE.bg;
  const tipBdr  = PALETTE.border;
  const textClr = PALETTE.text2;
  const ratioClr = '#e3b341';

  const dates = freecreditRows.map(r => r.date);
  const vals  = freecreditRows.map(r => +r.ratio.toFixed(3));

  // 5年滾動百分位：trailing 60 個月（含當月），無未來函數。
  const win = freecreditRows.slice(-60).map(r => r.ratio);
  const sortedWin = win.slice().sort((a, b) => a - b);
  const current = freecreditRows[freecreditRows.length - 1].ratio;
  const pct = percentileOf(current, sortedWin);

  const startYm = freecreditRows[0].date.slice(0, 7);
  const noteEl = document.getElementById('marginheat-freecredit-note');
  if (noteEl) noteEl.textContent =
    `free credit 合計自 ${startYm} 起完整（早期 FINRA 未分列融資帳戶餘額，故之前月份不畫）`;
  const allTimeMax = Math.max(...freecreditRows.map(r => r.ratio));
  const isAllTimeHigh = current >= allTimeMax;
  const pctEl = document.getElementById('marginheat-freecredit-pct');
  if (pctEl) pctEl.innerHTML = pct == null ? '—' :
    `5年百分位 <b style="color:${ratioClr}">${pct.toFixed(0)}</b>` +
    (isAllTimeHigh ? ` · <b style="color:${ratioClr}">全史最高</b>（自${startYm}起）` : '') +
    ` · 越高＝現金緩衝越薄`;

  freecreditChart.setOption({
    backgroundColor: 'transparent', animation: false,
    tooltip: {
      trigger: 'axis',
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        const p = params[0];
        if (!p || p.value == null) return '';
        return `<div style="font-weight:600;margin-bottom:4px">${p.axisValue}</div>`
          + `<div>${p.marker}debit/(cash+margin): <b>${(+p.value).toFixed(2)}</b></div>`;
      },
    },
    grid: { left: mob() ? 44 : 56, right: mob() ? 16 : 24, top: '8%', bottom: '12%' },
    xAxis: {
      type: 'category', data: dates, boundaryGap: false,
      axisLine: { lineStyle: { color: axisClr } }, axisTick: { show: false },
      axisLabel: { color: axisClr, fontSize: 11 }, splitLine: { show: false },
    },
    yAxis: {
      type: 'value', scale: true, name: '比值', nameTextStyle: { color: ratioClr, fontSize: 10 },
      axisLabel: { color: axisClr, fontSize: 11 }, axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: gridClr } },
    },
    dataZoom: [{ type: 'inside', filterMode: 'none' }],
    series: [{
      name: 'debit/(cash+margin)', type: 'line', data: vals, symbol: 'none', z: 3,
      itemStyle: { color: ratioClr }, lineStyle: { color: ratioClr, width: 1.8 },
      areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
        colorStops: [{ offset: 0, color: 'rgba(227,179,65,0.20)' }, { offset: 1, color: 'rgba(227,179,65,0.02)' }] } },
    }],
  }, { notMerge: true });
}

// ── 子圖 B：出清進度狀態機（TW/US 可切換）───────────────────────────────
// 前視偏誤警告：peak_idx/base_idx 是用整個回看窗口的 argmax/argmin 求出的，
// 只計算並顯示「當前狀態」的單一數字與標記線；絕不逐日回推畫成歷史序列——
// 那會讓每個歷史點都用到當時還不知道的未來峰值，是典型的 look-ahead bias。
function computeUnwindState(series, lookback) {
  if (!series || series.length < 2) return null;
  const win = series.slice(-lookback);
  let peakIdx = 0;
  for (let i = 1; i < win.length; i++) if (win[i].value > win[peakIdx].value) peakIdx = i;
  let baseIdx = 0;
  for (let i = 1; i <= peakIdx; i++) if (win[i].value < win[baseIdx].value) baseIdx = i;
  const peak = win[peakIdx], base = win[baseIdx], current = win[win.length - 1];
  const denom = peak.value - base.value;
  const stillLeveraging = current.value >= peak.value;
  let progress = 0;
  if (!stillLeveraging && denom > 0) {
    progress = Math.max(0, Math.min(100, ((peak.value - current.value) / denom) * 100));
  }
  return { win, peak, base, current, progress, stillLeveraging };
}

async function renderUnwind() {
  const chartHost   = document.getElementById('marginheat-unwind-chart');
  const summaryHost = document.getElementById('marginheat-unwind-summary');
  if (!chartHost || !summaryHost) return;
  if (!unwindChart) unwindChart = echarts.init(chartHost, isLight() ? null : 'dark');

  let series, lookback, label, fmtVal;
  if (unwindMarket === 'us') {
    series = usDebitSeries;
    lookback = 36;
    label = '美股 FINRA Margin Debt';
    fmtVal = v => '$' + (v / 1e6).toFixed(2) + ' 兆';
  } else {
    try {
      series = await ensureTwMargin();
    } catch (e) {
      summaryHost.innerHTML = `<span style="color:#f85149">台股融資資料載入失敗：${e.message || e}</span>`;
      console.error('[marginheat] tw margin load failed', e);
      return;
    }
    lookback = 750;
    label = '台股融資餘額';
    fmtVal = v => (v / 1e4).toFixed(2) + ' 兆元';  // margin_money 單位億元，/1e4 = 兆元
  }

  const st = computeUnwindState(series, lookback);
  if (!st) { summaryHost.innerHTML = '<span style="color:var(--muted)">資料不足</span>'; return; }

  const axisClr = PALETTE.muted;
  const gridClr = tc('rgba(48,54,61,0.5)', 'rgba(208,215,222,0.4)');
  const tipBg   = PALETTE.bg;
  const tipBdr  = PALETTE.border;
  const textClr = PALETTE.text2;
  const lineClr = '#58a6ff', peakClr = '#f85149', baseClr = '#3fb950', curClr = '#e3b341';

  const dates = st.win.map(r => r.date);
  const vals  = st.win.map(r => +r.value.toFixed(3));

  const progressColor = st.stillLeveraging ? '#f85149'
    : (st.progress >= 66 ? '#3fb950' : st.progress >= 33 ? '#e3b341' : '#f85149');
  const statusText = st.stillLeveraging
    ? '仍在加槓桿，尚未進入去化'
    : `本輪加槓桿已回吐 ${st.progress.toFixed(0)}%`;

  summaryHost.innerHTML =
    `<div class="breadth-card"><div class="bc-label">出清進度</div><div class="bc-main"><span class="bc-pct" style="color:${progressColor}">${st.progress.toFixed(0)}%</span></div><div class="bc-signal" style="color:${progressColor}">${statusText}</div></div>`
    + `<div class="breadth-card"><div class="bc-label">剩餘超額</div><div class="bc-main"><span class="bc-pct">${(100 - st.progress).toFixed(0)}%</span></div><div class="bc-count">尚未回吐的加槓桿量佔比</div></div>`
    + `<div class="breadth-card"><div class="bc-label">base / peak / current</div>`
    + `<div class="bc-count" style="color:${baseClr}">base ${st.base.date.slice(0, 7)} = ${fmtVal(st.base.value)}</div>`
    + `<div class="bc-count" style="color:${peakClr}">peak ${st.peak.date.slice(0, 7)} = ${fmtVal(st.peak.value)}</div>`
    + `<div class="bc-count" style="color:${curClr}">current ${st.current.date.slice(0, 7)} = ${fmtVal(st.current.value)}</div>`
    + `</div>`;

  unwindChart.setOption({
    backgroundColor: 'transparent', animation: false,
    tooltip: {
      trigger: 'axis',
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        const p = params[0];
        if (!p || p.value == null) return '';
        return `<div style="font-weight:600;margin-bottom:4px">${p.axisValue}</div>`
          + `<div>${p.marker}${label}: <b>${fmtVal(+p.value)}</b></div>`;
      },
    },
    grid: { left: mob() ? 44 : 56, right: mob() ? 16 : 24, top: '10%', bottom: '12%' },
    xAxis: {
      type: 'category', data: dates, boundaryGap: false,
      axisLine: { lineStyle: { color: axisClr } }, axisTick: { show: false },
      axisLabel: { color: axisClr, fontSize: 11 }, splitLine: { show: false },
    },
    yAxis: {
      type: 'value', scale: true,
      axisLabel: { color: axisClr, fontSize: 11 }, axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: gridClr } },
    },
    dataZoom: [{ type: 'inside', filterMode: 'none' }],
    series: [{
      name: label, type: 'line', data: vals, symbol: 'none', z: 3,
      itemStyle: { color: lineClr }, lineStyle: { color: lineClr, width: 1.8 },
      markLine: {
        silent: true, symbol: 'none',
        data: [
          { yAxis: st.base.value, lineStyle: { color: baseClr, type: 'dashed', width: 1 },
            label: { show: true, formatter: `base ${fmtVal(st.base.value)}`, color: baseClr, fontSize: 10, position: 'insideStartTop' } },
          { yAxis: st.peak.value, lineStyle: { color: peakClr, type: 'dashed', width: 1 },
            label: { show: true, formatter: `peak ${fmtVal(st.peak.value)}`, color: peakClr, fontSize: 10, position: 'insideStartBottom' } },
          { yAxis: st.current.value, lineStyle: { color: curClr, type: 'dashed', width: 1 },
            label: { show: true, formatter: `current ${fmtVal(st.current.value)}`, color: curClr, fontSize: 10, position: 'insideEndTop' } },
        ],
      },
    }],
  }, { notMerge: true });
}

// ── lifecycle ─────────────────────────────────────────────────────────
export async function activate() {
  const host = document.getElementById('marginheat-chart');
  if (!host) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : 'dark');
  ensureExtraDom();
  try {
    await loadAll();
    setTimeout(() => {
      chart?.resize();
      render();
      const fcHost = document.getElementById('marginheat-freecredit-chart');
      if (fcHost && !freecreditChart) freecreditChart = echarts.init(fcHost, isLight() ? null : 'dark');
      renderFreeCredit();
      freecreditChart?.resize();
      renderUnwind().then(() => unwindChart?.resize());
    }, 50);
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
  if (freecreditChart) { freecreditChart.dispose(); freecreditChart = null; }
  if (unwindChart) { unwindChart.dispose(); unwindChart = null; }
  if (rows) render();
  const fcHost = document.getElementById('marginheat-freecredit-chart');
  if (fcHost && freecreditRows) {
    freecreditChart = echarts.init(fcHost, light ? null : 'dark');
    renderFreeCredit();
  }
  const unwindHost = document.getElementById('marginheat-unwind-chart');
  if (unwindHost && (usDebitSeries || twMarginSeries)) {
    unwindChart = echarts.init(unwindHost, light ? null : 'dark');
    renderUnwind();
  }
}
export function resize() { chart?.resize(); forcedChart?.resize(); freecreditChart?.resize(); unwindChart?.resize(); }
