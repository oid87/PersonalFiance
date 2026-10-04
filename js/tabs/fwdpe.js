// Forward P/E 自建 tab — 指數層級 forward P/E 自建時間序列（VOO / QQQ）
//
// 資料來源:data/forward_pe_voo.jsonl、data/forward_pe_qqq.jsonl（append-only
// JSONL，scripts/fetch_forward_pe.py 每日寫入一行）。方法論、日期語意
// （date=腳本執行日 vs price_asof=報價實際交易日）、資料品質門檻見
// docs/forward_pe.md。
//
// ⚠️ 這條線跟既有的 js/tabs/valuation.js（前 20 大持股加權算術平均）刻意平行
// 跑，不互相取代，見 docs/forward_pe.md 開頭說明。
//
// ⚠️ 序列從 2026-09 才開始逐日累積，目前只有 1 個資料點——這是預期行為，不是
// bug。UI（showSymbol、status 行）刻意設計成在只有 1 個點時也看得出「這條線剛
// 開始長」，不要拿它做位階判斷。
//
// ⚠️ σ 帶門檻是 24 個完整月：自算序列現在還太短，滿 24 個完整月才自動畫出
// μ±kσ markLine（見下 SIGMA_MIN_MONTHS），且只在單一標的顯示時畫（見 buildOption）。

import { isLight, mob, PALETTE, echartsBase } from '../utils/theme.js';
import { tsToLocalDate, toMonthlyLast } from '../utils/dates.js';
import { bindOnce } from '../utils/dom.js';
import { sigmaBands } from '../utils/math.js';

const VOO_NTM_COLOR = '#58a6ff'; // 藍 — VOO NTM
const VOO_FY2_COLOR = '#8bc4ff'; // 淡藍 — VOO FY2（虛線）
const QQQ_NTM_COLOR = '#f0883e'; // 橘 — QQQ NTM
const QQQ_FY2_COLOR = '#f7b381'; // 淡橘 — QQQ FY2（虛線）

// 5y / 10y 均線所需的最少交易日數（見 docs/forward_pe.md「四條硬規則」第 4 條）。
const TRADING_DAYS_5Y = 1260;
const TRADING_DAYS_10Y = 2520;

// σ 帶樣本門檻：完整月（不含當月），自算序列累積到這個數才畫 σ 帶。
const SIGMA_MIN_MONTHS = 24;
const SIGMA_K_COLORS = { 0.5: "#58a6ff", 1: "#3fb950", 1.5: "#ef4444", 2: "#a371f7" };

let chart = null;
let vooRows = null; // [{date, ticker, price_asof, forward_pe_ntm, forward_pe_fy2, valid_ntm, valid_fy2, coverage_ntm, ...}, ...]
let qqqRows = null;
let showVoo = true;
let showQqq = true;
let showFy2 = false;

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().startsWith(value + 'T');
}

function validateRow(row, ticker) {
  if (!row || Array.isArray(row) || typeof row !== 'object' || !validDate(row.date)
    || (row.price_asof != null && !validDate(row.price_asof)) || row.ticker !== ticker
    || typeof row.valid_ntm !== 'boolean' || typeof row.valid_fy2 !== 'boolean') return false;
  for (const field of ['forward_pe', 'forward_pe_ntm', 'forward_pe_fy2', 'coverage_ntm', 'coverage_fy2']) {
    if (row[field] != null && (typeof row[field] !== 'number' || !Number.isFinite(row[field]))) return false;
  }
  return (!row.valid_ntm || (row.forward_pe_ntm != null && row.coverage_ntm != null))
    && (!row.valid_fy2 || (row.forward_pe_fy2 != null && row.coverage_fy2 != null));
}

// ── data load ────────────────────────────────────────────────────────────
// data/forward_pe_*.jsonl 是 JSONL（一行一個 JSON 物件），utils/data.js 的
// fetchJSON 吃不了（它假設單一 JSON payload 帶 `.data` 欄位）。目前只有這個
// tab 用 jsonl，故本檔自己寫一個小 helper，不上提到 utils/data.js（過早抽象）。
// 回傳值語意:[] = 該標的確定無資料(404,可快取);null = 這次載入失敗(其他非 ok
// 狀態碼或例外,不快取,下次切入 tab 要重抓)。
async function loadJsonl(url, context = {}) {
  try {
    const res = await fetch(url, { cache: 'no-cache', signal: context.signal });
    if (res.status === 404) return []; // 404 → 視為該標的無資料，不炸掉整個 tab
    if (!res.ok) return null; // 其他非 ok 狀態(如 503)→ 這次失敗,不快取
    const text = await res.text();
    const rows = text
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => JSON.parse(line));
    if (!rows.length) throw new Error(`${url}: empty JSONL`);
    const ticker = url.includes('_voo.') ? 'VOO' : 'QQQ';
    if (!rows.every(row => validateRow(row, ticker))) throw new Error(`${url}: invalid row`);
    return rows;
  } catch (e) {
    console.error(`[fwdpe] loadJsonl failed: ${url}`, e);
    return null;
  }
}

// x 軸用 price_asof（報價實際所屬的交易日），不是 date（腳本執行日）；
// price_asof 為 null 時退回用 date。
function effDate(r) {
  return r.price_asof ?? r.date;
}

function sortByEffDate(rows) {
  return [...rows].sort((a, b) => {
    const da = effDate(a), db = effDate(b);
    return da < db ? -1 : da > db ? 1 : 0;
  });
}

// NTM forward PE 的 μ±kσ 帶：月頻重採樣(去掉當月partial)，基期＝全部完整月
// （這條序列沒有更長歷史可選，不做基期 chip）。未滿 SIGMA_MIN_MONTHS 個完整月
// 時 sig 回 null，只回月數供 status 行顯示進度。
function ntmSigma(rows) {
  const points = rows.map(r => [effDate(r), r.valid_ntm ? r.forward_pe_ntm : null]);
  const months = toMonthlyLast(points).filter(m => !m.partial);
  return {
    months: months.length,
    sig: months.length >= SIGMA_MIN_MONTHS ? sigmaBands(months.map(m => m.value)) : null,
  };
}

async function loadAll(context = {}) {
  if (vooRows && qqqRows) return; // 兩支都成功過才不重抓
  const [voo, qqq] = await Promise.all([
    vooRows ? Promise.resolve(vooRows) : loadJsonl('data/forward_pe_voo.jsonl', context),
    qqqRows ? Promise.resolve(qqqRows) : loadJsonl('data/forward_pe_qqq.jsonl', context),
  ]);
  if (context.signal?.aborted || (context.isCurrent && !context.isCurrent())) return;
  if (!voo?.length && !qqq?.length) throw new Error("forward P/E: both sources unavailable");
  vooRows = voo ? sortByEffDate(voo) : null;
  qqqRows = qqq ? sortByEffDate(qqq) : null;
}

// ── cards ────────────────────────────────────────────────────────────────
function setText(id, txt, color) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = txt;
  if (color) el.style.color = color;
}

function fmtPe(v) {
  return v == null ? '—' : v.toFixed(2);
}

function fmtCoverage(v) {
  return v == null ? '—' : (v * 100).toFixed(1) + '%';
}

// validationNote 文案照抄 docs/forward_pe.md 對帳結果的既定語意，不改寫成更
// 樂觀的說法：VOO 已對過 FactSet，QQQ 目前無外部來源可對帳。
function updateCard(prefix, rows, validationNote) {
  if (rows === null) {
    setText(`fwdpe-${prefix}-val`, '—');
    setText(`fwdpe-${prefix}-sub`, '載入失敗，重新切入可重試');
    setText(`fwdpe-${prefix}-signal`, validationNote, PALETTE.muted);
    return;
  }
  if (!rows.length) {
    setText(`fwdpe-${prefix}-val`, '—');
    setText(`fwdpe-${prefix}-sub`, '無資料');
    setText(`fwdpe-${prefix}-signal`, validationNote, PALETTE.muted);
    return;
  }
  const last = rows[rows.length - 1];
  const ntm = last.valid_ntm ? last.forward_pe_ntm : null;
  const fy2 = last.valid_fy2 ? last.forward_pe_fy2 : null;
  setText(`fwdpe-${prefix}-val`, fmtPe(ntm));
  setText(
    `fwdpe-${prefix}-sub`,
    `FY2 ${fmtPe(fy2)} · coverage ${fmtCoverage(last.coverage_ntm)} · price_asof ${effDate(last)}`,
    'var(--muted)'
  );
  setText(`fwdpe-${prefix}-signal`, validationNote, PALETTE.muted);
}

function updateCards() {
  updateCard('voo', vooRows, '已對帳 FactSet 19.5（+0.43%）');
  updateCard('qqq', qqqRows, '無外部驗證（見 docs）');
}

// ── status line ──────────────────────────────────────────────────────────
// 目的:讓人一眼看出這條線剛開始長,現在不該拿它做位階判斷。
function statusText() {
  const vN = vooRows?.length ?? 0;
  const qN = qqqRows?.length ?? 0;
  const vStart = vN ? effDate(vooRows[0]) : '—';
  const qStart = qN ? effDate(qqqRows[0]) : '—';
  const remain5y = n => Math.max(0, TRADING_DAYS_5Y - n);
  const remain10y = n => Math.max(0, TRADING_DAYS_10Y - n);
  const vPart = vooRows === null
    ? 'VOO 載入失敗'
    : `VOO ${vN} 個交易日資料點（序列起點 ${vStart}）· 距 5Y 均線尚需 ${remain5y(vN)} 個交易日、10Y 均線尚需 ${remain10y(vN)} 個`;
  const qPart = qqqRows === null
    ? 'QQQ 載入失敗'
    : `QQQ ${qN} 個交易日資料點（序列起點 ${qStart}）· 距 5Y 均線尚需 ${remain5y(qN)} 個交易日、10Y 均線尚需 ${remain10y(qN)} 個`;
  const vM = vooRows === null ? '—' : ntmSigma(vooRows).months;
  const qM = qqqRows === null ? '—' : ntmSigma(qqqRows).months;
  const sigmaPart = (vM !== '—' && qM !== '—' && vM >= SIGMA_MIN_MONTHS && qM >= SIGMA_MIN_MONTHS)
    ? `σ 帶：已達 24 完整月，只顯示單一標的時畫出`
    : `σ 帶：VOO ${vM}/24、QQQ ${qM}/24 完整月（滿 24 個完整月且只顯示單一標的時自動畫出）`;
  return `${vPart}　｜　${qPart}　｜　${sigmaPart}　｜　序列剛開始累積，目前不足以做位階判斷`;
}

// ── chart ────────────────────────────────────────────────────────────────
function seriesData(rows, field, validField) {
  return rows.map(r => [effDate(r), r[validField] ? r[field] : null]);
}

// 序列短到沒有天然時間跨度時，用來撐開 x 軸的視窗半寬。
const DAY_MS = 86400000;
const AXIS_PAD_DAYS = 3;
const MIN_POINTS_FOR_AUTO_AXIS = 3;

// 目前畫得出來的所有 effDate 中，最早與最晚者。點數 < MIN_POINTS_FOR_AUTO_AXIS 時
// 回傳一組 min/max 撐開軸；否則回 null，交給 ECharts 自己算。
function shortSeriesAxisSpan() {
  const dates = [];
  if (showVoo) for (const r of vooRows ?? []) dates.push(effDate(r));
  if (showQqq) for (const r of qqqRows ?? []) dates.push(effDate(r));
  const uniq = [...new Set(dates.filter(Boolean))].sort();
  if (uniq.length === 0 || uniq.length >= MIN_POINTS_FOR_AUTO_AXIS) return null;
  const pad = AXIS_PAD_DAYS * DAY_MS;
  return {
    min: new Date(`${uniq[0]}T00:00:00`).getTime() - pad,
    max: new Date(`${uniq[uniq.length - 1]}T00:00:00`).getTime() + pad,
  };
}

// 9 條 markLine：μ 一條 + 4 個 k 各 ±1 條。格式同估值 tab（js/tabs/valuation.js）。
function sigmaMarkLineData(sig) {
  const data = [
    { yAxis: sig.mu, lineStyle: { color: PALETTE.muted },
      label: { formatter: `μ ${sig.mu.toFixed(2)}`, color: PALETTE.muted, position: 'insideEndTop' } },
  ];
  for (const b of sig.bands) {
    const c = SIGMA_K_COLORS[b.k];
    data.push({ yAxis: b.hi, lineStyle: { color: c },
      label: { formatter: `+${b.k}σ ${b.hi.toFixed(2)}`, color: c, position: 'insideEndTop' } });
    data.push({ yAxis: b.lo, lineStyle: { color: c },
      label: { formatter: `−${b.k}σ ${b.lo.toFixed(2)}`, color: c, position: 'insideEndTop' } });
  }
  return data;
}

function buildOption() {
  const series = [];
  const legendNames = [];
  const axisSpan = shortSeriesAxisSpan();

  if (showVoo && vooRows?.length) {
    series.push({
      name: 'VOO NTM', type: 'line',
      data: seriesData(vooRows, 'forward_pe_ntm', 'valid_ntm'),
      showSymbol: true, symbolSize: 8, connectNulls: false,
      itemStyle: { color: VOO_NTM_COLOR }, lineStyle: { color: VOO_NTM_COLOR, width: 2 },
    });
    legendNames.push('VOO NTM');
    if (showFy2) {
      series.push({
        name: 'VOO FY2', type: 'line',
        data: seriesData(vooRows, 'forward_pe_fy2', 'valid_fy2'),
        showSymbol: true, symbolSize: 8, connectNulls: false,
        itemStyle: { color: VOO_FY2_COLOR },
        lineStyle: { color: VOO_FY2_COLOR, width: 1.5, type: 'dashed' },
      });
      legendNames.push('VOO FY2');
    }
  }

  if (showQqq && qqqRows?.length) {
    series.push({
      name: 'QQQ NTM', type: 'line',
      data: seriesData(qqqRows, 'forward_pe_ntm', 'valid_ntm'),
      showSymbol: true, symbolSize: 8, connectNulls: false,
      itemStyle: { color: QQQ_NTM_COLOR }, lineStyle: { color: QQQ_NTM_COLOR, width: 2 },
    });
    legendNames.push('QQQ NTM');
    if (showFy2) {
      series.push({
        name: 'QQQ FY2', type: 'line',
        data: seriesData(qqqRows, 'forward_pe_fy2', 'valid_fy2'),
        showSymbol: true, symbolSize: 8, connectNulls: false,
        itemStyle: { color: QQQ_FY2_COLOR },
        lineStyle: { color: QQQ_FY2_COLOR, width: 1.5, type: 'dashed' },
      });
      legendNames.push('QQQ FY2');
    }
  }

  // σ 帶：只在恰好一個標的顯示（showVoo !== showQqq）且該標的滿 24 完整月時畫。
  // 同時顯示兩個標的時不畫（兩組各 9 條會糊成一團）；FY2 開關不影響（σ 只算 NTM）。
  if (showVoo !== showQqq) {
    const rows = showVoo ? vooRows : qqqRows;
    const ntmName = showVoo ? 'VOO NTM' : 'QQQ NTM';
    if (rows?.length) {
      const { sig } = ntmSigma(rows);
      if (sig) {
        const ntmSeries = series.find(s => s.name === ntmName);
        if (ntmSeries) {
          ntmSeries.markLine = {
            silent: true, symbol: 'none', lineStyle: { type: 'dashed', width: 1 }, label: { fontSize: 10 },
            data: sigmaMarkLineData(sig),
          };
        }
      }
    }
  }

  return echartsBase({
    animation: false,
    tooltip: {
      trigger: 'axis',
      formatter(params) {
        if (!params.length) return '';
        const axisVal = params[0]?.axisValue;
        const dateStr = typeof axisVal === 'number' ? tsToLocalDate(axisVal) : (axisVal ?? '');
        let html = `<div style="font-weight:600;margin-bottom:4px">${dateStr}</div>`;
        let any = false;
        for (const p of params) {
          const v = p.value?.[1];
          if (v == null) continue;
          any = true;
          html += `<div>${p.marker}${p.seriesName}: <b>${(+v).toFixed(2)}</b></div>`;
        }
        return any ? html : `<div>${dateStr}（此日期無有效資料）</div>`;
      },
    },
    legend: {
      data: legendNames, top: 2, left: 'center',
      textStyle: { color: PALETTE.text2, fontSize: 11 }, inactiveColor: PALETTE.muted,
    },
    grid: { left: mob() ? 44 : 56, right: mob() ? 16 : 24, top: '14%', bottom: '12%' },
    xAxis: {
      type: 'time',
      // 日頻序列：刻度至少間隔一天，否則序列很短時 ECharts 會自動縮到日內尺度、
      // 軸上標出 06:00 / 12:00 / 18:00 這種對估值毫無意義的小時刻度。
      minInterval: DAY_MS,
      // 序列剛開始時（1~2 個點）沒有天然的時間跨度，補一個 ±3 天的視窗，
      // 讓孤點落在軸中間而不是黏在邊緣。點數夠多之後就讓 ECharts 自己決定。
      ...(axisSpan ?? {}),
      axisLabel: {
        color: PALETTE.muted, fontSize: 11,
        formatter: (v) => tsToLocalDate(v),
      },
      axisLine: { lineStyle: { color: PALETTE.muted } },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value', scale: true, name: 'Forward P/E',
      nameTextStyle: { color: PALETTE.muted, fontSize: 10 },
      axisLabel: { color: PALETTE.muted, fontSize: 11 },
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: PALETTE.grid } },
    },
    series,
  });
}

// ── controls ─────────────────────────────────────────────────────────────
function buildControls() {
  const voo = document.getElementById('fwdpe-voo-toggle');
  if (bindOnce(voo)) {
    voo.addEventListener('click', () => {
      showVoo = !showVoo;
      voo.classList.toggle('active', showVoo);
      chart?.setOption(buildOption(), { notMerge: true });
    });
  }
  const qqq = document.getElementById('fwdpe-qqq-toggle');
  if (bindOnce(qqq)) {
    qqq.addEventListener('click', () => {
      showQqq = !showQqq;
      qqq.classList.toggle('active', showQqq);
      chart?.setOption(buildOption(), { notMerge: true });
    });
  }
  const fy2 = document.getElementById('fwdpe-fy2-toggle');
  if (bindOnce(fy2)) {
    fy2.addEventListener('click', () => {
      showFy2 = !showFy2;
      fy2.classList.toggle('active', showFy2);
      chart?.setOption(buildOption(), { notMerge: true });
    });
  }
}

// ── lifecycle ────────────────────────────────────────────────────────────
export async function activate(context = {}) {
  const host = document.getElementById('fwdpe-chart');
  if (!host) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : 'dark');
  buildControls();
  const status = document.getElementById('fwdpe-status');
  try {
    await loadAll(context);
    if (context.signal?.aborted || (context.isCurrent && !context.isCurrent())) return;
    updateCards();
    chart.setOption(buildOption(), { notMerge: true });
    if (status) status.textContent = statusText();
  } catch (e) {
    if (status) status.textContent = '載入失敗：' + (e.message || e);
    throw e;
  }
}

export function onThemeChange(_light) {
  if (!chart) return;
  chart.setOption(buildOption(), { notMerge: true });
}

export function resize() {
  chart?.resize();
}

export function getCharts() { return chart ? [chart] : []; }
