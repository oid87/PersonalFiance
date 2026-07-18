// 融資峰值 tab — FINRA Margin Debt YoY% 峰值/高檔 vs SPX(^GSPC)/QQQ 後續表現
//   命題（Tom Lee/Fundstrat）：margin debt YoY >50% 或 YoY 見頂 → S&P500 consolidate；
//   本 tab 對照 SPX 與 QQQ 反應是否不同（QQQ 短中期先噴、12m 才回吐）。
//   資料：data/liquidity.json（margin[]）+ data/SP500.json + data/QQQ.json，全現成 JSON，不另開 fetch。
//
// 對拍基準（沙盒 python: ../Financial_work/margin_yoy_spy_qqq.py，已人工複核）：
//   訊號A(>50%首破)中位數 SPX 1m/3m/6m/12m = 1.0/2.0/-1.0/-10.1；QQQ = 3.4/11.2/9.0/-4.8
//   訊號B(局部峰值>30%)中位數 SPX = -2.5/-0.1/-1.0/11.4；QQQ = -0.7/-0.4/5.1/11.7
//   基率（1999-04~2025-06 全樣本月中位數，hardcode 不在 JS 重算）：
//     SPX 1m/3m/6m/12m ≈ 1.2/2.8/5.2/10.8；QQQ ≈ 1.5/4.9/8.7/17.2

import { isLight, tc, mob, PALETTE } from '../utils/theme.js';

const HORIZONS = { '1m': 21, '3m': 63, '6m': 126, '12m': 252 };
const BASELINE = {
  SPX: { '1m': 1.2, '3m': 2.8, '6m': 5.2, '12m': 10.8 },
  QQQ: { '1m': 1.5, '3m': 4.9, '6m': 8.7, '12m': 17.2 },
};

let chart = null;
let state = null; // { dates, yoyData, absData, spxData, qqqData, sigA, sigB, medA, medB, curYoy, curDate }
let idxSel = 'QQQ';   // 顯示哪個指數（SPX / QQQ，一次一個）
let marginMode = 'yoy'; // 紅線意義：'yoy' = Margin Debt YoY%；'abs' = 融資餘額絕對值($B)

// ── date helpers ─────────────────────────────────────────────────────
// margin 日期是 'YYYY-MM-01'；python 用 PeriodIndex('M').to_timestamp('M') 取月底當 anchor，
// 這裡對齊同一邏輯：月底 = 該月最後一天。
function monthEnd(dateStr) {
  const y = +dateStr.slice(0, 4), m = +dateStr.slice(5, 7);
  // check_reuse: keep — UTC 建構的時間戳轉日期鍵,slice 與建構端同為 UTC 故自洽;tsToLocalDate 是給 ECharts 本地午夜 axisValue 用的,換過去反而會差一天
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  return (new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000;
}

// ── forward return（貼齊 ≤ 月底最近交易日為錨，往後 td 個交易日）──────
// 對拍 lab.fwd_ret：anchor = 最近 ≤ dt 的交易日；future 取 anchor 之後第 td 個交易日。
function findAnchorIdx(series, targetDate) {
  let lo = 0, hi = series.length - 1, res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].date <= targetDate) { res = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return res;
}
function fwdRet(series, anchorIdx, td) {
  if (anchorIdx < 0) return null;
  const targetIdx = anchorIdx + td;
  if (targetIdx >= series.length) return null;
  return +(((series[targetIdx].close / series[anchorIdx].close) - 1) * 100).toFixed(2);
}

function median(vals) {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  const m = s.length;
  return m % 2 ? s[(m - 1) / 2] : (s[m / 2 - 1] + s[m / 2]) / 2;
}

// ── signal detection（對拍 margin_yoy_spy_qqq.py sig50 / peaks）──────
function detectSignalA(yoySeries) {
  const out = [];
  let lastDate = null;
  for (const r of yoySeries) {
    if (r.yoy > 50) {
      if (!lastDate || daysBetween(lastDate, r.date) > 365) {
        out.push(r);
        lastDate = r.date;
      }
    }
  }
  return out;
}
// 對拍注意：python 在「含前12個月NaN的完整月序列」上跑 range(6, len(yoy)-6)，
// NaN 被 pandas max() 自動忽略；yoySeries（本檔）已經把前12個月NaN砍掉，
// 所以邊界要往前clip到0而非再退6格，否則會漏掉序列開頭附近的訊號（例：1998-04）。
function detectSignalB(yoySeries) {
  const out = [];
  const n = yoySeries.length;
  for (let i = 0; i <= n - 7; i++) {
    const v = yoySeries[i].yoy;
    if (v == null || v <= 30) continue;
    let windowMax = -Infinity;
    for (let j = Math.max(0, i - 6); j <= i + 6; j++) windowMax = Math.max(windowMax, yoySeries[j].yoy);
    if (v === windowMax) out.push(yoySeries[i]);
  }
  return out;
}

function computeSignalRow(sig, spxSeries, qqqSeries) {
  const anchor = monthEnd(sig.date);
  const spxIdx = findAnchorIdx(spxSeries, anchor);
  const qqqIdx = findAnchorIdx(qqqSeries, anchor);
  const row = { signal: sig.date.slice(0, 7), yoy: +sig.yoy.toFixed(1) };
  for (const [hk, td] of Object.entries(HORIZONS)) {
    row[`SPX_${hk}`] = fwdRet(spxSeries, spxIdx, td);
    row[`QQQ_${hk}`] = fwdRet(qqqSeries, qqqIdx, td);
  }
  return row;
}

const COLS = ['SPX_1m', 'SPX_3m', 'SPX_6m', 'SPX_12m', 'QQQ_1m', 'QQQ_3m', 'QQQ_6m', 'QQQ_12m'];
function groupMedians(rows) {
  const out = {};
  for (const k of COLS) out[k] = median(rows.map(r => r[k]).filter(v => v != null));
  return out;
}

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
    medA: groupMedians(sigA), medB: groupMedians(sigB),
    curYoy: last?.yoy ?? null, curDate: last?.date ?? null,
  };
}

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
function medianRowHtml(med, label) {
  return `<tr style="border-top:2px solid var(--border);font-weight:600"><td colspan="2">${label}</td>` +
    COLS.map(k => `<td>${fmtPct(med[k])}</td>`).join('') + `</tr>`;
}
function baselineRowHtml() {
  const row = { SPX_1m: BASELINE.SPX['1m'], SPX_3m: BASELINE.SPX['3m'], SPX_6m: BASELINE.SPX['6m'], SPX_12m: BASELINE.SPX['12m'],
                QQQ_1m: BASELINE.QQQ['1m'], QQQ_3m: BASELINE.QQQ['3m'], QQQ_6m: BASELINE.QQQ['6m'], QQQ_12m: BASELINE.QQQ['12m'] };
  return `<tr style="color:var(--muted)"><td colspan="2">基率（1999-04~2025-06 全樣本月中位數）</td>` +
    COLS.map(k => `<td>${fmtPct(row[k])}</td>`).join('') + `</tr>`;
}

function renderTable() {
  const host = document.getElementById('marginpeak-table');
  if (!host || !state) return;
  const head = `<thead><tr><th>訊號月</th><th>YoY%</th>
      <th>SPX 1m</th><th>SPX 3m</th><th>SPX 6m</th><th>SPX 12m</th>
      <th>QQQ 1m</th><th>QQQ 3m</th><th>QQQ 6m</th><th>QQQ 12m</th></tr></thead>`;

  const bodyA = state.sigA.map(rowHtml).join('') + medianRowHtml(state.medA, '中位數') + baselineRowHtml();
  const bodyB = state.sigB.map(rowHtml).join('') + medianRowHtml(state.medB, '中位數') + baselineRowHtml();

  host.innerHTML = `
    <p style="margin:8px 0;color:var(--muted)">Margin YoY &gt;50% 之後 SPX 中期停滯、QQQ 先噴後回吐；峰值屬短期盤整訊號非崩盤（2000 除外）。樣本極小，參考劇本非統計 edge。</p>
    <h4 style="margin:12px 0 4px">訊號A・margin YoY 首次突破 50%（12個月去重）</h4>
    <table class="info-table">${head}<tbody>${bodyA}</tbody></table>
    <h4 style="margin:16px 0 4px">訊號B・局部峰值（&gt;30% 且為前後6個月最高）</h4>
    <table class="info-table">${head}<tbody>${bodyB}</tbody></table>
  `;
}

// ── chart render ──────────────────────────────────────────────────────
function render() {
  if (!chart || !state) return;

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

// ── lifecycle ─────────────────────────────────────────────────────────
function syncChips() {
  document.getElementById('marginpeak-idx-spx')?.classList.toggle('active', idxSel === 'SPX');
  document.getElementById('marginpeak-idx-qqq')?.classList.toggle('active', idxSel === 'QQQ');
  document.getElementById('marginpeak-mode-yoy')?.classList.toggle('active', marginMode === 'yoy');
  document.getElementById('marginpeak-mode-abs')?.classList.toggle('active', marginMode === 'abs');
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
}

export async function activate() {
  const host = document.getElementById('marginpeak-chart');
  if (!host) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : 'dark');
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
