// 融資峰值 tab — FINRA Margin Debt YoY% 峰值/高檔 vs SPX(^GSPC)/QQQ 後續表現
//   以固定規則回顧融資 YoY 高檔／峰值後的價格表現，非可交易訊號。
//   資料：data/liquidity.json（margin[]）+ data/SP500.json + data/QQQ.json，全現成 JSON，不另開 fetch。
//
// Methodology and fixed reference window: docs/marginpeak-methodology.md.

import { isLight, tc, mob, PALETTE } from '../utils/theme.js';
import { HORIZONS, COLS, detectSignalA, detectSignalB, computeSignalRow, groupMedians, groupCounts, computeBaseline, buildEventStudyPure, EVENT_STUDY_WINDOW_TD, BASELINE_VERSION, BASELINE_START_MONTH, BASELINE_END_MONTH } from './marginpeak_calc.mjs';


let chart = null;
let state = null; // { dates, yoyData, absData, spxData, qqqData, sigA, sigB, medA, medB, curYoy, curDate }
let idxSel = 'QQQ';   // 顯示哪個指數（SPX / QQQ，一次一個）
let marginMode = 'yoy'; // 紅線意義：'yoy' = Margin Debt YoY%；'abs' = 融資餘額絕對值($B)
let viewMode = 'table'; // 'table' = 現有中位數對拍表格＋雙軸圖；'eventstudy' = 融資見頂事件研究 percentile band


// ── data load ────────────────────────────────────────────────────────
async function loadAll() {
  if (state) return;
  const [liqRes, spxRes, qqqRes] = await Promise.all([
    fetch('data/liquidity.json', { cache: 'no-cache' }),
    fetch('data/SP500.json', { cache: 'no-cache' }),
    fetch('data/QQQ.json', { cache: 'no-cache' }),
  ]);
  if (!liqRes.ok) throw new Error(`liquidity.json: HTTP ${liqRes.status}`);
  if (!spxRes.ok) throw new Error(`SP500.json: HTTP ${spxRes.status}`);
  if (!qqqRes.ok) throw new Error(`QQQ.json: HTTP ${qqqRes.status}`);
  const liq = await liqRes.json();
  const spx = await spxRes.json();
  const qqq = await qqqRes.json();

  const margin = liq.margin ?? [];
  const spxSeries = (spx.data ?? []).map(r => ({ date: r.date, close: r.close })).sort((a, b) => a.date < b.date ? -1 : 1);
  const qqqSeries = (qqq.data ?? []).map(r => ({ date: r.date, close: r.close })).sort((a, b) => a.date < b.date ? -1 : 1);

  // margin YoY%（逐月，i<12 略過）
  const yoySeries = [];
  for (let i = 12; i < margin.length; i++) {
    const cur = margin[i], prev = margin[i - 12];
    if (cur.debit == null || prev.debit == null) continue;
    yoySeries.push({ date: cur.date, yoy: (cur.debit / prev.debit - 1) * 100 });
  }

  const sigARaw = detectSignalA(yoySeries);
  const sigBRaw = detectSignalB(yoySeries);
  const sigA = sigARaw.map(s => computeSignalRow(s, spxSeries, qqqSeries));
  const sigB = sigBRaw.map(s => computeSignalRow(s, spxSeries, qqqSeries));

  // 主圖：月頻 SPX/QQQ（月內最後交易日收盤）對齊 yoySeries 的月份
  const spxByMonth = new Map();
  for (const r of spxSeries) spxByMonth.set(r.date.slice(0, 7), r.close);
  const qqqByMonth = new Map();
  for (const r of qqqSeries) qqqByMonth.set(r.date.slice(0, 7), r.close);

  // margin debit 絕對值（$B；原始資料單位為 $M，/1000）對齊 yoySeries 月份
  const debitByMonth = new Map();
  for (const r of margin) if (r.debit != null) debitByMonth.set(r.date.slice(0, 7), r.debit / 1000);

  const dates = yoySeries.map(r => r.date);
  const yoyData = yoySeries.map(r => +r.yoy.toFixed(2));
  const absData = dates.map(d => { const v = debitByMonth.get(d.slice(0, 7)); return v == null ? null : +v.toFixed(1); });
  const spxData = dates.map(d => spxByMonth.get(d.slice(0, 7)) ?? null);
  const qqqData = dates.map(d => qqqByMonth.get(d.slice(0, 7)) ?? null);

  const last = yoySeries[yoySeries.length - 1];

  state = {
    dates, yoyData, absData, spxData, qqqData,
    sigA, sigB,
    sigADates: sigARaw.map(s => s.date),
    sigBDates: sigBRaw.map(s => s.date),
    // 事件研究模式用：完整每日序列（非月頻近似），可對齊到真實交易日
    spxDaily: spxSeries, qqqDaily: qqqSeries,
    medA: groupMedians(sigA), medB: groupMedians(sigB),
    countA: groupCounts(sigA), countB: groupCounts(sigB),
    baseline: computeBaseline(spxSeries, qqqSeries),
    curYoy: last?.yoy ?? null, curDate: last?.date ?? null,
  };
}

function buildEventStudy(idxKey) { return buildEventStudyPure(idxKey, state); }

// ── table ────────────────────────────────────────────────────────────
function fmtPct(v) {
  if (v == null) return '<span style="color:var(--muted)">N/A</span>';
  const cls = v >= 0 ? 'pos' : 'neg';
  return `<span class="${cls}">${v >= 0 ? '+' : ''}${v.toFixed(1)}%</span>`;
}
function rowHtml(r) {
  return `<tr><td>${r.signal}</td><td>${r.yoy.toFixed(1)}%</td>` +
    COLS.map(k => `<td>${fmtPct(r[k])}</td>`).join('') + `</tr>`;
}
function medianRowHtml(med, counts, label) {
  return `<tr style="border-top:2px solid var(--border);font-weight:600"><td colspan="2">${label}</td>` +
    COLS.map(k => `<td>${fmtPct(med[k])}<small style="display:block">事件 n=${counts[k]}</small></td>`).join('') + `</tr>`;
}
function baselineRowHtml() {
  const { medians, counts, months } = state.baseline;
  return `<tr style="color:var(--muted)"><td colspan="2">基準中位報酬<br>${BASELINE_START_MONTH}～${BASELINE_END_MONTH}（${months} 個候選月）</td>` +
    COLS.map(k => `<td>${fmtPct(medians[k])}<small style="display:block">基準 n=${counts[k]}</small></td>`).join('') + `</tr>`;
}

function renderTable() {
  const host = document.getElementById('marginpeak-table');
  if (!host || !state) return;
  const head = `<thead><tr><th>事件月</th><th>YoY%</th>` +
    COLS.map(k => {
      const [asset, horizon] = k.split('_');
      return `<th title="${horizon}：月底 anchor 後 +${HORIZONS[horizon]} 個價格觀測；並非曆月報酬。raw close，不含股息。">${asset} ${horizon}</th>`;
    }).join('') + `</tr></thead>`;

  const bodyA = state.sigA.map(rowHtml).join('') + medianRowHtml(state.medA, state.countA, '事件中位報酬') + baselineRowHtml();
  const bodyB = state.sigB.map(rowHtml).join('') + medianRowHtml(state.medB, state.countB, '事件中位報酬') + baselineRowHtml();

  const methods = document.getElementById('marginpeak-methodology');
  if (methods) methods.innerHTML = `
    <p style="margin:8px 0;color:var(--muted)">描述性歷史研究，以事件月月底以前最後一筆可用價格為 anchor；使用 SPX（^GSPC）／QQQ raw close，報酬不含股息。1／3／6／12m 代表 +21／63／126／252 個價格觀測，並非曆月報酬。</p>
    <p style="margin:8px 0;color:var(--muted)">基準中位報酬不是上漲機率。固定參考 anchor window ${BASELINE_START_MONTH}～${BASELINE_END_MONTH}，版本 ${BASELINE_VERSION}，不自動滾動，未宣稱經過最佳化；未來價格可超過此窗口。基準 n 與事件 n 分別計算，各資產／horizon 排除無 anchor 或未完成期間的結果，不補值、不推估。</p>
    <p style="margin:8px 0;color:var(--muted)">價格資料截至 SPX ${state.spxDaily.at(-1)?.date ?? 'N/A'}／QQQ ${state.qqqDaily.at(-1)?.date ?? 'N/A'}。事件樣本使用可用融資歷史，不限於基準窗口；以下列出各群實際事件月份。樣本可能重疊，n 不代表獨立實驗次數。</p>
    <p style="margin:8px 0;color:var(--muted)">A：融資 YoY &gt;50%，距上次入選 &gt;365 曆日；非真正穿越判斷。B：YoY &gt;30%，且為前後6筆 YoY 觀測最高；同值峰值可重複入選。</p>
    <p style="margin:4px 0;color:var(--muted)">B 是 retrospective／ex-post 事後研究：需未來 6 筆 YoY 觀測才能辨識，連續月資料約 6 個月，實際可用時間還取決於資料發布。anchor 保留峰值月，不是確認月；不得視為峰值月當時可交易訊號。</p>
  `;
  host.innerHTML = `
    <h4 style="margin:12px 0 4px">事件A・融資 YoY &gt;50%</h4>
    <table class="info-table">${head}<tbody>${bodyA}</tbody></table>
    <h4 style="margin:16px 0 4px">事件B・局部峰值（&gt;30%）</h4>
    <table class="info-table">${head}<tbody>${bodyB}</tbody></table>
  `;
}

// ── chart render ──────────────────────────────────────────────────────
function render() {
  if (!chart || !state) return;
  toggleViewDom();
  if (viewMode === 'eventstudy') renderEventStudyChart();
  else renderTableChart();
}

function renderTableChart() {
  const axisClr = PALETTE.muted;
  const gridClr = tc('rgba(48,54,61,0.5)', 'rgba(208,215,222,0.4)');
  const tipBg   = PALETTE.bg;
  const tipBdr  = PALETTE.border;
  const textClr = PALETTE.text2;
  const spxClr  = PALETTE.text;
  const qqqClr  = '#58a6ff';
  const yoyClr  = '#f85149';

  const idxClr = idxSel === 'QQQ' ? qqqClr : spxClr;
  const idxData = idxSel === 'QQQ' ? state.qqqData : state.spxData;
  const isAbs = marginMode === 'abs';
  const marginData = isAbs ? state.absData : state.yoyData;
  const marginName = isAbs ? '融資餘額 ($B)' : 'Margin YoY%';
  const curAbs = [...state.absData].reverse().find(v => v != null);

  const status = document.getElementById('marginpeak-status');
  if (status) status.textContent =
    `融資峰值：FINRA Margin Debt ${isAbs ? '餘額($B)' : 'YoY%'} vs ${idxSel} · ${state.dates.length} 個月（${state.dates[0] ?? ''} ~ ${state.dates[state.dates.length - 1] ?? ''}）` +
    (isAbs
      ? (curAbs != null ? ` · 現值(${state.curDate?.slice(0, 7)}) 餘額 = $${curAbs.toLocaleString()}B` : '')
      : (state.curYoy != null ? ` · 現值(${state.curDate?.slice(0, 7)}) YoY = ${state.curYoy.toFixed(1)}%` : ''));

  const yoyMax = Math.max(60, ...state.yoyData.filter(v => v != null));
  const L = mob() ? 40 : 52, R = mob() ? 48 : 62;

  const yAxis = [
    {
      type: 'log', scale: true,
      name: idxSel, nameTextStyle: { color: idxClr, fontSize: 10 },
      axisLabel: { color: axisClr, fontSize: 11 },
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: gridClr } },
    },
    {
      type: 'value', scale: true, position: 'right',
      name: marginName, nameTextStyle: { color: yoyClr, fontSize: 10 },
      axisLine: { lineStyle: { color: yoyClr } },
      axisLabel: { color: yoyClr, fontSize: 10, formatter: v => isAbs ? '$' + v : v + '%' },
      splitLine: { show: false },
    },
  ];

  // YoY 模式才有 50% 門檻標註與訊號A豎線；餘額模式不畫（絕對值無門檻語義）
  const yoyMarkArea = {
    silent: true,
    data: [[{ yAxis: 50, itemStyle: { color: 'rgba(248,81,73,0.14)' } }, { yAxis: yoyMax + 10 }]],
    label: { show: false },
  };
  const fiftyMarkLine = {
    silent: true, symbol: 'none',
    lineStyle: { color: yoyClr, type: 'dashed', width: 1 },
    label: { formatter: '50%', color: yoyClr, fontSize: 10 },
    data: [{ yAxis: 50 }],
  };
  const sigAMarkLine = {
    silent: true, symbol: 'none',
    lineStyle: { color: '#e3b341', type: 'dashed', width: 1.5 },
    label: { formatter: 'A', color: '#e3b341', fontSize: 10, position: 'insideEndTop' },
    data: state.sigADates.map(d => ({ xAxis: d })),
  };

  const marginSeries = {
    name: marginName, type: 'line', data: marginData,
    symbol: 'none', z: 5,
    itemStyle: { color: yoyClr }, lineStyle: { color: yoyClr, width: 2 },
    yAxisIndex: 1,
  };
  if (!isAbs) {
    marginSeries.markArea = yoyMarkArea;
    marginSeries.markLine = { ...fiftyMarkLine, data: [...fiftyMarkLine.data, ...sigAMarkLine.data] };
  }

  const series = [
    {
      name: idxSel, type: 'line', data: idxData,
      symbol: 'none', z: 3, connectNulls: true,
      itemStyle: { color: idxClr }, lineStyle: { color: idxClr, width: 1.3 },
      yAxisIndex: 0,
    },
    marginSeries,
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
          let v;
          if (p.seriesName === 'Margin YoY%') v = (+p.value).toFixed(1) + '%';
          else if (p.seriesName === '融資餘額 ($B)') v = '$' + Math.round(+p.value).toLocaleString() + 'B';
          else v = Math.round(+p.value).toLocaleString();
          html += `<div>${p.marker}${p.seriesName}: <b>${v}</b></div>`;
        }
        return html;
      },
    },
    legend: {
      data: [idxSel, marginName], top: 2, left: 'center',
      textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr,
    },
    grid: { left: L, right: R, top: '12%', bottom: '12%' },
    xAxis: {
      type: 'category', data: state.dates, boundaryGap: false,
      axisLine: { lineStyle: { color: axisClr } }, axisTick: { show: false },
      axisLabel: { color: axisClr, fontSize: 11 },
      splitLine: { show: false },
    },
    yAxis,
    dataZoom: [{ type: 'inside', filterMode: 'none' }],
    series,
  }, { notMerge: true });

  renderTable();
}

// ── event study chart（融資見頂事件研究：rebase=100 + 25/75 percentile band）──
function renderEventStudyChart() {
  const axisClr = PALETTE.muted;
  const tipBg   = PALETTE.bg;
  const tipBdr  = PALETTE.border;
  const textClr = PALETTE.text2;
  const idxClr  = idxSel === 'QQQ' ? '#58a6ff' : PALETTE.text;
  const bandClr = '#e3b341';

  const { meanArr, p25Arr, p75Arr, counts, n } = buildEventStudy(idxSel);
  const xData = meanArr.map((_, i) => i);
  // Expose every t, including all-null tails where ECharts may omit a tooltip.
  const countRanges = [];
  for (let i = 0; i < counts.length; i++) {
    const last = countRanges.at(-1);
    if (last && last.n === counts[i]) last.end = i;
    else countRanges.push({ start: i, end: i, n: counts[i] });
  }
  const countText = countRanges.map(r => `t=${r.start}${r.end === r.start ? '' : '～' + r.end}：n=${r.n}`).join('；');

  const status = document.getElementById('marginpeak-status');
  if (status) status.textContent =
    `融資峰值事件研究：${idxSel} 事件後走勢分佈（rebase=100）· 基於 ${state.sigBDates.length} 次局部峰值事件 / ${n} 次可建立 t=0 路徑（完整期間樣本數見 hover）`;

  const note = document.getElementById('marginpeak-eventstudy-note');
  if (note) note.textContent =
    `以融資 YoY 局部峰值（前後6筆 YoY 觀測最高且 >30%）的 ${state.sigBDates.length} 次事件為 t=0（峰值月），` +
    `對齊峰值月月底以前最後一筆可用價格，往後最多 ${EVENT_STUDY_WINDOW_TD} 個價格觀測的 ${idxSel} raw close rebase 成 100；` +
    `畫出 Mean／25th／75th percentile。每個相對觀測的事件 n 見 hover，未完成尾段不補值。` +
    `這是 retrospective／ex-post 事後研究，需未來 6 筆 YoY 觀測才能辨識，實際可用時間取決於發布，不能視為峰值月可交易訊號；事件不限於固定基準窗口。` +
    `逐觀測事件樣本數：${countText}。n=0 時統計為 N/A。`;

  chart.setOption({
    backgroundColor: 'transparent', animation: false,
    tooltip: {
      trigger: 'axis',
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        const d = params[0]?.axisValue ?? '';
        let html = `<div style="font-weight:600;margin-bottom:4px">第 ${d} 個價格觀測</div><div>事件 n=${counts[+d] ?? 0}</div><div>t=0 為峰值月月底 anchor；非曆月 horizon</div>`;
        for (const p of params) {
          if (p.value == null) continue;
          html += `<div>${p.marker}${p.seriesName}: <b>${(+p.value).toFixed(1)}</b></div>`;
        }
        return html;
      },
    },
    legend: {
      data: ['25th Percentile', 'Mean', '75th Percentile'], top: 2, left: 'center',
      textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr,
    },
    grid: { left: mob() ? 40 : 52, right: mob() ? 16 : 24, top: '14%', bottom: '14%' },
    xAxis: {
      type: 'category', data: xData, boundaryGap: false,
      name: '事件後第 N 個交易日', nameLocation: 'middle', nameGap: 28,
      nameTextStyle: { color: axisClr, fontSize: 11 },
      axisLine: { lineStyle: { color: axisClr } }, axisTick: { show: false },
      axisLabel: { color: axisClr, fontSize: 11 },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value', scale: true,
      name: 'Rebased 指數（事件當下=100）', nameTextStyle: { color: axisClr, fontSize: 10 },
      axisLabel: { color: axisClr, fontSize: 11 },
      splitLine: { lineStyle: { color: tc('rgba(48,54,61,0.5)', 'rgba(208,215,222,0.4)') } },
    },
    series: [
      {
        name: '25th Percentile', type: 'line', data: p25Arr,
        symbol: 'none', z: 2, connectNulls: true,
        lineStyle: { color: bandClr, width: 1, type: 'dashed' },
        areaStyle: { color: 'rgba(227,179,65,0.12)' },
      },
      {
        name: '75th Percentile', type: 'line', data: p75Arr,
        symbol: 'none', z: 2, connectNulls: true,
        lineStyle: { color: bandClr, width: 1, type: 'dashed' },
        areaStyle: { color: 'rgba(227,179,65,0.12)' },
      },
      {
        name: 'Mean', type: 'line', data: meanArr,
        symbol: 'none', z: 4, connectNulls: true,
        lineStyle: { color: idxClr, width: 2 },
      },
    ],
  }, { notMerge: true });
}

// 依 viewMode 切換 DOM 顯示：表格模式顯示對拍表格，事件研究模式顯示樣本數說明文字
function toggleViewDom() {
  const tableWrap = document.getElementById('marginpeak-table')?.parentElement;
  const note = document.getElementById('marginpeak-eventstudy-note');
  const methods = document.getElementById('marginpeak-methodology');
  if (methods) methods.style.display = viewMode === 'eventstudy' ? 'none' : '';
  if (tableWrap) tableWrap.style.display = viewMode === 'eventstudy' ? 'none' : '';
  if (note) note.style.display = viewMode === 'eventstudy' ? '' : 'none';
}

// ── lifecycle ─────────────────────────────────────────────────────────
function syncChips() {
  document.getElementById('marginpeak-idx-spx')?.classList.toggle('active', idxSel === 'SPX');
  document.getElementById('marginpeak-idx-qqq')?.classList.toggle('active', idxSel === 'QQQ');
  document.getElementById('marginpeak-mode-yoy')?.classList.toggle('active', marginMode === 'yoy');
  document.getElementById('marginpeak-mode-abs')?.classList.toggle('active', marginMode === 'abs');
  document.getElementById('marginpeak-view-table')?.classList.toggle('active', viewMode === 'table');
  document.getElementById('marginpeak-view-eventstudy')?.classList.toggle('active', viewMode === 'eventstudy');
}
let wired = false;
function wireControls() {
  if (wired) return;
  wired = true;
  for (const el of document.querySelectorAll('#tab-marginpeak .chip[data-idx]')) {
    el.addEventListener('click', () => { idxSel = el.dataset.idx; syncChips(); render(); });
  }
  for (const el of document.querySelectorAll('#tab-marginpeak .chip[data-mode]')) {
    el.addEventListener('click', () => { marginMode = el.dataset.mode; syncChips(); render(); });
  }
  for (const el of document.querySelectorAll('#tab-marginpeak .chip[data-view]')) {
    el.addEventListener('click', () => { viewMode = el.dataset.view; syncChips(); render(); });
  }
}

// index.html 本次不動；「事件研究」檢視模式的切換 chip 與樣本數說明文字用 JS 動態插入既有 DOM。
let viewUIInjected = false;
function ensureViewModeUI() {
  if (viewUIInjected) return;
  viewUIInjected = true;
  const controlsRow = document.getElementById('marginpeak-mode-abs')?.parentElement;
  if (controlsRow) {
    controlsRow.insertAdjacentHTML('beforeend',
      `<span style="color:var(--muted);font-size:12px;margin-left:8px">檢視</span>
       <span id="marginpeak-view-table" class="chip active" data-view="table">表格</span>
       <span id="marginpeak-view-eventstudy" class="chip" data-view="eventstudy">事件研究</span>`);
  }
  const tableWrap = document.getElementById('marginpeak-table')?.parentElement;
  if (tableWrap && !document.getElementById('marginpeak-methodology')) {
    tableWrap.insertAdjacentHTML('beforebegin', '<div id="marginpeak-methodology" style="padding:8px 16px;line-height:1.6"></div>');
  }
  const chartHost = document.getElementById('marginpeak-chart');
  if (chartHost && !document.getElementById('marginpeak-eventstudy-note')) {
    chartHost.insertAdjacentHTML('afterend',
      `<div id="marginpeak-eventstudy-note" style="padding:8px 16px;color:var(--muted);font-size:12px;display:none"></div>`);
  }
}

export async function activate() {
  const host = document.getElementById('marginpeak-chart');
  if (!host) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : 'dark');
  ensureViewModeUI();
  wireControls();
  syncChips();
  try {
    await loadAll();
    setTimeout(() => { chart?.resize(); render(); }, 50);
  } catch (e) {
    const s = document.getElementById('marginpeak-status');
    if (s) s.textContent = '載入失敗：' + (e.message || e);
    console.error('[marginpeak] load failed', e);
  }
}
export function onThemeChange(light) {
  if (!chart) return;
  chart.dispose();
  chart = echarts.init(document.getElementById('marginpeak-chart'), light ? null : 'dark');
  if (state) render();
}
export function resize() { chart?.resize(); }
export { render };
