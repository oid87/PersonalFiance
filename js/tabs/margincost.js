// js/tabs/margincost.js — 美國融資成本 tab
//   上圖(mc-chart, 2 stacked grids, 同一 echarts instance):
//     Grid 0: SOFR/EFFR/IORB/FFR(DFF,長期代理) 四線(%) + FINRA 融資餘額右軸(monthly,$T)
//     Grid 1: SOFR−IORB 利差(bp,柱狀,零軸) + SOFR99−SOFR 尾端壓力(bp,線,若有值)
//       ⚠️ spec 原文「若 sofr99 有值,疊一條線」——sofr99 本身是 % 利率、跟 bp 軸單位不合,
//       此處疊的是 (sofr99-sofr)*100 的尾端壓力**利差**(bp),與下圖既有的利差軸同單位、
//       語意也對齊 js/tabs/usdliq.js 的 L5 Repo/抵押品層(「SOFR99−SOFR」尾端擠壓判讀)。
//   下圖(mc-dd-chart + mc-dd-table): 回撤分箱(expanding-max drawdown) × FFR 中位數對照
//     ⚠️ 同期相關,非因果,非交易訊號;n<60 天標「樣本不足」。回撤一律用「截至當日為止」的
//     歷史最高點(expanding max),不用全期最大值,避免未來函數。
//     ⚠️ 2026-08 主 session 複核後改:深回撤分箱(-20~-30%/<-30%)的中位數容易被少數低利率
//     復甦年(如 2003-2005、2009-2010)主導,不是「崩盤當下」——每個分箱已拆成「下跌中」
//     (比 20 個交易日前更深) vs「修復中」(更淺)兩組中位數,並列出年份分布(前6大)供核對。
//     事件數改用「回撤波段」定義(從歷史高點起算到收復為止,波段內觸及過該分箱即計 1 次),
//     不用天數區段計數(舊版會把邊界抖動的天數誤算成幾十個事件,嚴重高估獨立性)。
//
// 資料: data/margin_cost.json(FRED SOFR/EFFR/IORB/SOFR99/DFF,日頻,1990起,fetch_margin_cost.py)
//       data/liquidity.json(margin[],FINRA融資餘額,月頻,重用既有,不另抓)
//       data/SP500.json / QQQ.json / SOXX.json / VOO.json(收盤價,重用既有,不另抓)

import { isLight, mob, PALETTE, echartsBase } from '../utils/theme.js';
import { cutoffDate } from '../utils/dates.js';
import { percentile } from '../utils/math.js';

const SOFR_COLOR   = '#58a6ff';
const EFFR_COLOR   = '#3fb950';
const IORB_COLOR   = '#e3b341';
const FFR_COLOR    = '#8b949e';
const MARGIN_COLOR = '#f778ba';
const SPREAD_UP    = '#f0883e';
const SPREAD_DOWN  = '#3fb950';
const TAIL_COLOR   = '#d2a8ff';

const DD_INDEX_FILES = {
  SP500: { file: 'data/SP500.json', label: '^GSPC' },
  QQQ:   { file: 'data/QQQ.json',   label: 'QQQ' },
  SOXX:  { file: 'data/SOXX.json',  label: 'SOXX' },
  VOO:   { file: 'data/VOO.json',   label: 'VOO' },
};

// 回撤分箱邊界(dd 為負值或 0,dd = close/expanding-max − 1)
const BUCKETS = [
  { key: 'b0', label: '0 ~ -5%',    test: dd => dd <= 0     && dd > -0.05 },
  { key: 'b1', label: '-5 ~ -10%',  test: dd => dd <= -0.05 && dd > -0.10 },
  { key: 'b2', label: '-10 ~ -20%', test: dd => dd <= -0.10 && dd > -0.20 },
  { key: 'b3', label: '-20 ~ -30%', test: dd => dd <= -0.20 && dd > -0.30 },
  { key: 'b4', label: '< -30%',     test: dd => dd <= -0.30 },
];
const BUCKET_COLORS = ['#3fb950', '#e3b341', '#f0883e', '#f85149', '#a40e26'];
const MIN_SAMPLE = 60; // 天數低於此視為樣本不足
const LOOKBACK_DAYS = 20; // 「下跌中 vs 修復中」判定用的交易日回看窗(比 20 個交易日前更深/更淺)
const DOWN_COLOR = '#f85149';
const UP_COLOR = '#58a6ff';

let chartRate = null;
let chartDD   = null;
let range = '3Y';
let ddIndex = 'SP500';

let mcData = null;         // margin_cost.json 的 data[]
let marginByMonth = null;  // Map("YYYY-MM" -> $T)
const idxCache = {};       // { SP500: [[date,close],...], ... }

// ── data load ────────────────────────────────────────────────────────────
async function loadAll() {
  if (mcData) return;
  const [mcRes, liqRes] = await Promise.all([
    fetch('data/margin_cost.json', { cache: 'no-cache' }),
    fetch('data/liquidity.json', { cache: 'no-cache' }),
  ]);
  if (!mcRes.ok) throw new Error(`margin_cost.json: HTTP ${mcRes.status}`);
  if (!liqRes.ok) throw new Error(`liquidity.json: HTTP ${liqRes.status}`);
  const mcJson = await mcRes.json();
  const liqJson = await liqRes.json();
  mcData = mcJson.data ?? [];
  marginByMonth = new Map();
  for (const r of (liqJson.margin ?? [])) {
    if (r.debit != null) marginByMonth.set(r.date.slice(0, 7), r.debit / 1e6); // USD millions → $T
  }
}

async function loadIndex(key) {
  if (idxCache[key]) return idxCache[key];
  const meta = DD_INDEX_FILES[key];
  const r = await fetch(meta.file, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${meta.file}: HTTP ${r.status}`);
  const j = await r.json();
  const rows = (j.data ?? []).map(x => [x.date, x.close]); // ascending, per data/*.json convention
  idxCache[key] = rows;
  return rows;
}

// ── ① 上圖:利率走廊 + FINRA 融資餘額 / 利差 ──────────────────────────
function renderRateChart() {
  if (!chartRate || !mcData) return;
  const isMob = mob();
  const cut = cutoffDate(range);
  const view = mcData.filter(r => r.date >= cut);
  const dates = view.map(r => r.date);

  const marginData = view.map(r => {
    const v = marginByMonth.get(r.date.slice(0, 7));
    return v != null ? +v.toFixed(3) : null;
  });
  const spreadData = view.map(r => r.sofr_iorb_spread != null ? +r.sofr_iorb_spread.toFixed(1) : null);
  const tailData = view.map(r => (r.sofr99 != null && r.sofr != null) ? +((r.sofr99 - r.sofr) * 100).toFixed(1) : null);
  const hasTail = tailData.some(v => v != null);

  const status = document.getElementById('mc-status');
  if (status) status.textContent =
    `融資成本走廊 · ${dates.length} 天（${range}）· SOFR/EFFR/IORB/SOFR99 為日頻(各自起點不同)，`
    + `FFR(DFF) 日頻回溯至 1954，FINRA 融資餘額為月頻且落後約兩週公布`;

  const L = isMob ? 44 : 58;
  const R = isMob ? 44 : 58;

  const option = echartsBase({
    animation: false,
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross', link: [{ xAxisIndex: 'all' }] },
      formatter(params) {
        if (!params.length) return '';
        const d = params[0]?.axisValue ?? '';
        let html = `<div style="font-weight:600;margin-bottom:4px">${d}</div>`;
        for (const p of params) {
          if (p.value == null) continue;
          if (p.seriesName.startsWith('FINRA')) {
            html += `<div>${p.marker}${p.seriesName}: <b>$${(+p.value).toFixed(2)}兆</b></div>`;
          } else if (p.seriesName.includes('bp')) {
            html += `<div>${p.marker}${p.seriesName}: <b>${(+p.value).toFixed(1)}bp</b></div>`;
          } else {
            html += `<div>${p.marker}${p.seriesName}: <b>${(+p.value).toFixed(2)}%</b></div>`;
          }
        }
        return html;
      },
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    legend: [
      { data: ['SOFR', 'EFFR', 'IORB', 'FFR(DFF,長期)', 'FINRA 融資餘額（右軸,月頻）'], top: 2, left: 'center',
        textStyle: { color: PALETTE.text2, fontSize: 11 }, inactiveColor: PALETTE.muted },
      { data: ['SOFR−IORB利差(bp)', ...(hasTail ? ['SOFR99−SOFR尾端壓力(bp)'] : [])], top: '58%', left: 'center',
        textStyle: { color: PALETTE.text2, fontSize: 11 }, inactiveColor: PALETTE.muted },
    ],
    grid: [
      { left: L, right: R, top: '10%', height: '42%' },
      { left: L, right: R, top: '64%', height: '26%' },
    ],
    xAxis: [
      { gridIndex: 0, type: 'category', data: dates, boundaryGap: false,
        axisLabel: { show: false }, axisLine: { lineStyle: { color: PALETTE.muted } },
        axisTick: { show: false }, splitLine: { show: false } },
      { gridIndex: 1, type: 'category', data: dates, boundaryGap: false,
        axisLabel: { color: PALETTE.muted, fontSize: 11, rotate: isMob ? 30 : 0 },
        axisLine: { lineStyle: { color: PALETTE.muted } },
        axisTick: { show: false }, splitLine: { show: false } },
    ],
    yAxis: [
      { gridIndex: 0, type: 'value', scale: true, name: '利率 %',
        nameTextStyle: { color: PALETTE.muted, fontSize: 10 },
        axisLabel: { color: PALETTE.muted, fontSize: 11, formatter: v => v.toFixed(1) + '%' },
        axisLine: { show: false }, axisTick: { show: false },
        splitLine: { lineStyle: { color: PALETTE.grid } } },
      { gridIndex: 0, type: 'value', scale: true, position: 'right', name: '融資餘額 $T',
        nameTextStyle: { color: MARGIN_COLOR, fontSize: 10 },
        axisLabel: { color: MARGIN_COLOR, fontSize: 11, formatter: v => v.toFixed(1) + 'T' },
        axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false } },
      { gridIndex: 1, type: 'value', scale: true, name: 'bp',
        nameTextStyle: { color: PALETTE.muted, fontSize: 10 },
        axisLabel: { color: PALETTE.muted, fontSize: 11 },
        axisLine: { show: false }, axisTick: { show: false },
        splitLine: { lineStyle: { color: PALETTE.grid } } },
    ],
    dataZoom: [{ type: 'inside', xAxisIndex: [0, 1], filterMode: 'none' }],
    series: [
      { name: 'SOFR', type: 'line', xAxisIndex: 0, yAxisIndex: 0,
        data: view.map(r => r.sofr ?? null), symbol: 'none', connectNulls: false,
        itemStyle: { color: SOFR_COLOR }, lineStyle: { color: SOFR_COLOR, width: 1.6 }, z: 5 },
      { name: 'EFFR', type: 'line', xAxisIndex: 0, yAxisIndex: 0,
        data: view.map(r => r.effr ?? null), symbol: 'none', connectNulls: false,
        itemStyle: { color: EFFR_COLOR }, lineStyle: { color: EFFR_COLOR, width: 1.4 }, z: 4 },
      { name: 'IORB', type: 'line', xAxisIndex: 0, yAxisIndex: 0,
        data: view.map(r => r.iorb ?? null), symbol: 'none', connectNulls: false,
        itemStyle: { color: IORB_COLOR }, lineStyle: { color: IORB_COLOR, width: 1.4 }, z: 4 },
      { name: 'FFR(DFF,長期)', type: 'line', xAxisIndex: 0, yAxisIndex: 0,
        data: view.map(r => r.ffr ?? null), symbol: 'none', connectNulls: false,
        itemStyle: { color: FFR_COLOR }, lineStyle: { color: FFR_COLOR, width: 1.1, type: 'dashed' }, z: 2 },
      { name: 'FINRA 融資餘額（右軸,月頻）', type: 'line', xAxisIndex: 0, yAxisIndex: 1,
        data: marginData, symbol: 'none', connectNulls: true, step: 'end',
        itemStyle: { color: MARGIN_COLOR }, lineStyle: { color: MARGIN_COLOR, width: 1.6, opacity: 0.85 }, z: 3 },
      { name: 'SOFR−IORB利差(bp)', type: 'bar', xAxisIndex: 1, yAxisIndex: 2,
        data: spreadData,
        itemStyle: { color: p => (p.value >= 0 ? SPREAD_UP : SPREAD_DOWN) }, z: 3 },
      ...(hasTail ? [{
        name: 'SOFR99−SOFR尾端壓力(bp)', type: 'line', xAxisIndex: 1, yAxisIndex: 2,
        data: tailData, symbol: 'none', connectNulls: false,
        itemStyle: { color: TAIL_COLOR }, lineStyle: { color: TAIL_COLOR, width: 1.4 }, z: 5,
      }] : []),
    ],
  });

  chartRate.setOption(option, { notMerge: true });
}

// ── ② 回撤分箱 × FFR 中位數 ───────────────────────────────────────────
// 回撤 = 收盤 / 「截至當日為止」的歷史最高收盤價 − 1(expanding max,只用當下已知資料;
// 嚴禁用 rows 的全期最大值 —— 那會把未來的高點洩漏進今天的回撤讀數)。
function computeDrawdownSeries(rows) {
  let peak = -Infinity;
  const out = [];
  for (const [date, close] of rows) {
    if (close == null) { out.push([date, null]); continue; }
    if (close > peak) peak = close; // peak 只用「這一列及之前」看過的收盤價
    out.push([date, peak > 0 ? close / peak - 1 : null]);
  }
  return out;
}

// 回撤波段(episode)= 從某個歷史高點起算,直到指數「收復該高點」為止(dd 回到 0)。
// 波段內只要曾經觸及某分箱(不管來回穿越邊界幾次、待了幾天),該分箱事件數就 +1 —— 這是
// 2026-08 主 session 複核後改的定義:舊版用「連續同分箱天數區段」計事件數,會把單一段
// 熊市裡因回撤在邊界抖動而反覆穿越同一分箱的天數誤算成幾十個「事件」,嚴重高估獨立性。
function computeEpisodes(ddSeries) {
  const episodes = [];
  let episodeStart = null;
  let touched = new Set();
  for (let i = 0; i < ddSeries.length; i++) {
    const [date, dd] = ddSeries[i];
    if (dd == null) continue;
    if (dd >= 0) {
      if (episodeStart != null) {
        episodes.push({ start: episodeStart, end: date, ongoing: false, buckets: touched });
        episodeStart = null;
        touched = new Set();
      }
    } else {
      if (episodeStart == null) episodeStart = i > 0 ? ddSeries[i - 1][0] : date; // 波段起點 = 前一筆「收在高點」的日期
      const bucket = BUCKETS.find(b => b.test(dd));
      if (bucket) touched.add(bucket.key);
    }
  }
  if (episodeStart != null) {
    episodes.push({ start: episodeStart, end: ddSeries[ddSeries.length - 1][0], ongoing: true, buckets: touched });
  }
  return episodes;
}

// ⚠️ 2026-08 主 session 複核後改:單一中位數會把「崩盤下跌中」跟「低利率復甦期」混在一起
// (例:-20~-30%/<-30% 分箱的大宗天數其實落在 2003-2005、2009-2010 這類復甦年,不是崩盤當下)。
// 故同一分箱拆成「下跌中」(比 LOOKBACK_DAYS 個交易日前更深) vs「修復中」(更淺)兩組,
// 各自給 n 與中位數;另外列出年份分布(前 6 大)供使用者自行核對中位數被哪幾年決定。
function computeDrawdownStats(rows, ffrMap, ffrMinDate) {
  const ddSeries = computeDrawdownSeries(rows);
  const episodes = computeEpisodes(ddSeries);
  // 事件計數/起訖只看跟分析窗口(ffr 資料起點)有交集的波段 —— 波段可能起於窗口之前
  // (仍照實顯示真實起點),但已經在窗口開始前完全收復的波段不計入。
  const displayEpisodes = episodes.filter(e => e.end >= ffrMinDate);

  const acc = {};
  for (const b of BUCKETS) acc[b.key] = { all: [], down: [], up: [], years: new Map() };
  const overallValues = [];

  for (let i = 0; i < ddSeries.length; i++) {
    const [date, dd] = ddSeries[i];
    if (dd == null || date < ffrMinDate) continue;
    const ffr = ffrMap.get(date);
    if (ffr == null) continue;
    const bucket = BUCKETS.find(b => b.test(dd));
    if (!bucket) continue;

    acc[bucket.key].all.push(ffr);
    overallValues.push(ffr);
    const year = date.slice(0, 4);
    acc[bucket.key].years.set(year, (acc[bucket.key].years.get(year) || 0) + 1);

    if (i >= LOOKBACK_DAYS && ddSeries[i - LOOKBACK_DAYS][1] != null) {
      const ddPrev = ddSeries[i - LOOKBACK_DAYS][1];
      if (dd < ddPrev) acc[bucket.key].down.push(ffr); // 比 20 個交易日前更深 → 下跌中
      else acc[bucket.key].up.push(ffr);               // 比 20 個交易日前更淺(或相同) → 修復中
    }
  }

  const overallSorted = overallValues.slice().sort((a, b) => a - b);
  const overallMedian = percentile(overallSorted, 0.5);

  const buckets = BUCKETS.map((b, i) => {
    const a = acc[b.key];
    const sortedAll = a.all.slice().sort((x, y) => x - y);
    const sortedDown = a.down.slice().sort((x, y) => x - y);
    const sortedUp = a.up.slice().sort((x, y) => x - y);
    const median = percentile(sortedAll, 0.5);
    const downMedian = percentile(sortedDown, 0.5);
    const upMedian = percentile(sortedUp, 0.5);
    const diffPp = (median != null && overallMedian != null) ? +(median - overallMedian).toFixed(3) : null;
    const topYears = [...a.years.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6);
    const bucketEpisodes = displayEpisodes
      .filter(e => e.buckets.has(b.key))
      .map(e => ({ start: e.start.slice(0, 7), end: e.ongoing ? '至今' : e.end.slice(0, 7) }));
    return {
      key: b.key, label: b.label, color: BUCKET_COLORS[i],
      n: sortedAll.length, median, diffPp,
      downN: sortedDown.length, downMedian,
      upN: sortedUp.length, upMedian,
      insufficient: sortedAll.length < MIN_SAMPLE,
      topYears, episodes: bucketEpisodes,
    };
  });

  return { buckets, overallMedian, overallN: overallValues.length };
}

function renderDDChart(stats) {
  if (!chartDD) return;
  const option = echartsBase({
    animation: false,
    tooltip: {
      trigger: 'axis',
      formatter(params) {
        const idx = params[0]?.dataIndex;
        if (idx == null) return '';
        const b = stats.buckets[idx];
        let html = `<div style="font-weight:600;margin-bottom:4px">${b.label}</div>`;
        html += `<div>下跌中: <b>${b.downMedian != null ? b.downMedian.toFixed(2) + '%' : '—'}</b>（n=${b.downN}）</div>`;
        html += `<div>修復中: <b>${b.upMedian != null ? b.upMedian.toFixed(2) + '%' : '—'}</b>（n=${b.upN}）</div>`;
        html += `<div>全分箱中位數: ${b.median != null ? b.median.toFixed(2) + '%' : '—'}（n=${b.n}${b.insufficient ? ' ⚠不足' : ''}）</div>`;
        html += `<div>波段事件數(高點→收復): ${b.episodes.length} 段</div>`;
        return html;
      },
    },
    legend: {
      data: ['下跌中中位數', '修復中中位數'], top: 2, left: 'center',
      textStyle: { color: PALETTE.text2, fontSize: 11 }, inactiveColor: PALETTE.muted,
    },
    grid: { left: mob() ? 44 : 58, right: mob() ? 16 : 24, top: '18%', bottom: '14%' },
    xAxis: {
      type: 'category', data: stats.buckets.map(b => b.label),
      axisLabel: { color: PALETTE.muted, fontSize: 11 },
      axisLine: { lineStyle: { color: PALETTE.muted } }, axisTick: { show: false }, splitLine: { show: false },
    },
    yAxis: {
      type: 'value', scale: true, name: 'FFR 中位數 %',
      nameTextStyle: { color: PALETTE.muted, fontSize: 10 },
      axisLabel: { color: PALETTE.muted, fontSize: 11, formatter: v => v.toFixed(1) + '%' },
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: PALETTE.grid } },
    },
    dataZoom: [],
    series: [
      {
        name: '下跌中中位數', type: 'bar',
        data: stats.buckets.map(b => b.downMedian),
        itemStyle: { color: DOWN_COLOR, opacity: 0.85 },
      },
      {
        name: '修復中中位數', type: 'bar',
        data: stats.buckets.map(b => b.upMedian),
        itemStyle: { color: UP_COLOR, opacity: 0.85 },
        markLine: stats.overallMedian != null ? {
          silent: true, symbol: 'none',
          lineStyle: { color: PALETTE.text, type: 'dashed', width: 1 },
          label: { formatter: `全期中位數 ${stats.overallMedian.toFixed(2)}%`, color: PALETTE.text, fontSize: 9 },
          data: [{ yAxis: stats.overallMedian }],
        } : undefined,
      },
    ],
  });
  chartDD.setOption(option, { notMerge: true });
}

function renderDDTable(stats) {
  const host = document.getElementById('mc-dd-table');
  if (!host) return;
  const cards = stats.buckets.map(b => {
    const yearsStr = b.topYears.length ? b.topYears.map(([y, c]) => `${y}:${c}`).join(', ') : '—';
    const episodesStr = b.episodes.length ? b.episodes.map(e => `${e.start}~${e.end}`).join('；') : '（無)';
    const diffColor = b.diffPp == null ? 'inherit' : (b.diffPp >= 0 ? '#f85149' : '#3fb950');
    return `
      <div class="breadth-card" style="min-width:260px;flex:1 1 260px;border-left:4px solid ${b.color};padding-left:10px">
        <div class="bc-label" style="margin-bottom:2px">${b.label}${b.insufficient ? ' ⚠樣本不足(n<60)' : ''}</div>
        <div class="bc-count">全分箱 n=${b.n} · 中位數 ${b.median != null ? b.median.toFixed(2) + '%' : '—'}
          ${b.diffPp != null ? `<span style="color:${diffColor}">（vs全期 ${b.diffPp >= 0 ? '+' : ''}${b.diffPp.toFixed(2)}pp）</span>` : ''}</div>
        <div class="bc-count" style="margin-top:4px;color:${DOWN_COLOR}">下跌中 n=${b.downN} · 中位數 ${b.downMedian != null ? b.downMedian.toFixed(2) + '%' : '—'}</div>
        <div class="bc-count" style="color:${UP_COLOR}">修復中 n=${b.upN} · 中位數 ${b.upMedian != null ? b.upMedian.toFixed(2) + '%' : '—'}</div>
        <div class="bc-count" style="margin-top:4px">年份分布(前6大)：${yearsStr}</div>
        <div class="bc-count" style="margin-top:4px">波段事件數(高點→收復)：${b.episodes.length} 段 — ${episodesStr}</div>
      </div>`;
  }).join('');
  host.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:10px">${cards}</div>`;
}

async function renderDrawdownSection() {
  const rows = await loadIndex(ddIndex);
  const ffrMap = new Map(mcData.map(r => [r.date, r.ffr]));
  const ffrMinDate = mcData.length ? mcData[0].date : '1990-01-01';
  const stats = computeDrawdownStats(rows, ffrMap, ffrMinDate);
  renderDDChart(stats);
  renderDDTable(stats);
  const s = document.getElementById('mc-dd-status');
  if (s) {
    const meta = DD_INDEX_FILES[ddIndex];
    s.textContent = `基準：${meta.label} · 回撤＝收盤 / 截至當日 expanding max − 1（無未來函數）· `
      + `全期 FFR 樣本 n=${stats.overallN} 天 · 全期中位數 ${stats.overallMedian != null ? stats.overallMedian.toFixed(2) + '%' : '—'}`
      + ' · 深回撤分箱的中位數常由少數低利率復甦年驅動，見下方下跌中/修復中拆分與年份分布，同期相關，非因果，非交易訊號';
  }
}

// ── controls ──────────────────────────────────────────────────────────
function buildControls() {
  const rp = document.getElementById('mc-range-picker');
  if (rp && !rp.dataset.built) {
    rp.dataset.built = '1';
    rp.addEventListener('click', e => {
      const t = e.target.closest('.chip[data-mc-range]');
      if (!t) return;
      range = t.dataset.mcRange;
      rp.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c === t));
      renderRateChart();
    });
  }
  const dp = document.getElementById('mc-dd-index-picker');
  if (dp && !dp.dataset.built) {
    dp.dataset.built = '1';
    dp.addEventListener('click', e => {
      const t = e.target.closest('.chip[data-mc-dd-index]');
      if (!t) return;
      ddIndex = t.dataset.mcDdIndex;
      dp.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c === t));
      renderDrawdownSection().catch(e2 => {
        const s = document.getElementById('mc-dd-status');
        if (s) s.textContent = '載入失敗：' + (e2.message || e2);
        console.error('[margincost] drawdown load failed', e2);
      });
    });
  }
}

// ── lifecycle ─────────────────────────────────────────────────────────
export async function activate() {
  const h1 = document.getElementById('mc-chart');
  const h2 = document.getElementById('mc-dd-chart');
  if (!h1 || !h2) return;
  if (!chartRate) chartRate = echarts.init(h1, isLight() ? null : 'dark');
  if (!chartDD) chartDD = echarts.init(h2, isLight() ? null : 'dark');
  buildControls();
  try {
    await loadAll();
    setTimeout(() => {
      chartRate?.resize(); chartDD?.resize();
      renderRateChart();
      renderDrawdownSection().catch(e2 => {
        const s = document.getElementById('mc-dd-status');
        if (s) s.textContent = '載入失敗：' + (e2.message || e2);
        console.error('[margincost] drawdown load failed', e2);
      });
    }, 50);
  } catch (e) {
    const s = document.getElementById('mc-status');
    if (s) s.textContent = '載入失敗：' + (e.message || e);
    console.error('[margincost] load failed', e);
  }
}

export function onThemeChange(light) {
  if (chartRate) {
    chartRate.dispose();
    chartRate = echarts.init(document.getElementById('mc-chart'), light ? null : 'dark');
  }
  if (chartDD) {
    chartDD.dispose();
    chartDD = echarts.init(document.getElementById('mc-dd-chart'), light ? null : 'dark');
  }
  if (mcData) {
    renderRateChart();
    renderDrawdownSection().catch(() => {});
  }
}

export function resize() {
  chartRate?.resize();
  chartDD?.resize();
}
