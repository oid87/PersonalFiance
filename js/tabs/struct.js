// 結構判讀 tab — QQQ 支撐(VPVR代理)/上升通道(迴歸±2σ)/趨勢結構(swing pivot)
//   資料：直接讀 data/QQQ.json 收盤價，前端即時計算，無另開 fetch 腳本
//   支撐/壓力用「成交量價格分佈（VPVR）」代理持股成本分佈——QQQ是指數ETF，沒有真實籌碼成本資料
//   無未來函數風險（純現況快照工具），但 swing pivot 用 fractal(k=5)，最後 5 根不算 confirmed pivot（右側資料不足）

import { isLight, tc, PALETTE } from '../utils/theme.js';
import { computeMA } from '../utils/math.js';

const VPVR_BINS = 40;
const HVN_PERCENTILE = 0.70;
const FRACTAL_K = 5;
const VOL_BREAKOUT_MULT = 1.3;
const VOL_AVG_WINDOW = 20;
const WARMUP_MAX = 60; // 主圖前置暖身根數（不進入任何計算，純視覺延續）
const FALSE_BREAKOUT_WINDOW = 5; // 突破/跌破後幾根內收回=假；資料不足=待確認（防未來函數）
const ROUND_STEP = 50; // QQQ 整數關卡間距
const ROUND_RANGE_PCT = 0.15; // 現價 ±15% 範圍內
const MA_SUPPORT_PERIOD = 60;  // 季線
const MA_RESIST_PERIOD = 250;  // 年線

let chart = null;
let vpvrChart = null;
let lookback = 252;
let allBars = null; // [{date,open,high,low,close,volume}] ascending, full history

// ── data load ─────────────────────────────────────────────────────────
async function loadData() {
  if (allBars) return allBars;
  const resp = await fetch('data/QQQ.json', { cache: 'no-cache' });
  if (!resp.ok) throw new Error(`QQQ.json: HTTP ${resp.status}`);
  const j = await resp.json();
  allBars = (j.data || []).map(r => ({
    date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume || 0,
  }));
  return allBars;
}

// ── A. VPVR 支撐/壓力 ─────────────────────────────────────────────────
// 40 等寬 bin，每根K volume 平均分攤到 [low,high] 覆蓋的所有 bin；
// POC=累積量最大 bin 中心價；HVN=量≥該分佈70百分位的 bin；支撐/壓力=現價下方/上方最近 HVN。
function computeVPVR(slice) {
  let minLow = Infinity, maxHigh = -Infinity;
  for (const b of slice) {
    if (b.low < minLow) minLow = b.low;
    if (b.high > maxHigh) maxHigh = b.high;
  }
  const range = maxHigh - minLow;
  const binWidth = range > 0 ? range / VPVR_BINS : 1;
  const vols = new Array(VPVR_BINS).fill(0);

  const binOf = price => {
    let idx = Math.floor((price - minLow) / binWidth);
    if (idx < 0) idx = 0;
    if (idx > VPVR_BINS - 1) idx = VPVR_BINS - 1;
    return idx;
  };

  for (const b of slice) {
    if (b.low === b.high) {
      vols[binOf(b.low)] += b.volume;
      continue;
    }
    const loBin = binOf(b.low);
    const hiBin = binOf(b.high);
    const span = hiBin - loBin + 1;
    const share = b.volume / span;
    for (let k = loBin; k <= hiBin; k++) vols[k] += share;
  }

  const centers = vols.map((_, i) => minLow + (i + 0.5) * binWidth);

  let pocIdx = 0;
  for (let i = 1; i < VPVR_BINS; i++) if (vols[i] > vols[pocIdx]) pocIdx = i;
  const poc = centers[pocIdx];

  const sorted = [...vols].sort((a, b) => a - b);
  const rank = Math.floor(HVN_PERCENTILE * (sorted.length - 1));
  const threshold = sorted[rank];
  const hvnIdx = [];
  for (let i = 0; i < VPVR_BINS; i++) if (vols[i] >= threshold) hvnIdx.push(i);

  const currentPrice = slice[slice.length - 1].close;
  let support = null, resistance = null;
  for (const i of hvnIdx) {
    const c = centers[i];
    if (c < currentPrice && (support == null || c > support)) support = c;
    if (c > currentPrice && (resistance == null || c < resistance)) resistance = c;
  }

  return { bins: vols, centers, poc, pocIdx, support, resistance, hvnIdx, currentPrice };
}

// ── B. 迴歸通道（最小平方，x=0..n-1）+ 放量突破 ─────────────────────────
function computeChannel(slice) {
  const closes = slice.map(b => b.close);
  const n = closes.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i; sumY += closes[i]; sumXY += i * closes[i]; sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  const slope = denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  const trend = new Array(n);
  let sumR2 = 0;
  for (let i = 0; i < n; i++) {
    trend[i] = slope * i + intercept;
    const r = closes[i] - trend[i];
    sumR2 += r * r;
  }
  const sigma = Math.sqrt(sumR2 / n); // 迴歸殘差標準差
  const upper = trend.map(v => v + 2 * sigma);
  const lower = trend.map(v => v - 2 * sigma);
  return { slope, intercept, sigma, trend, upper, lower };
}

// 放量突破：close[gi] > 上緣[li] 且 volume[gi] > 1.3 × 該根前20日均量（用全歷史找前20日，非僅lookback切片）
function computeBreakouts(fullBars, startIdx, channel) {
  const breakouts = [];
  const upper = channel.upper;
  for (let li = 0; li < upper.length; li++) {
    const gi = startIdx + li;
    const bar = fullBars[gi];
    if (bar.close <= upper[li]) continue;
    if (gi < VOL_AVG_WINDOW) continue; // 前置資料不足，跳過
    let sum = 0;
    for (let k = gi - VOL_AVG_WINDOW; k < gi; k++) sum += fullBars[k].volume;
    const avgVol = sum / VOL_AVG_WINDOW;
    if (bar.volume > VOL_BREAKOUT_MULT * avgVol) breakouts.push(li);
  }
  return breakouts; // slice-local indices
}

// ── C. swing 高低點（fractal, k=5）+ 趨勢結構 ───────────────────────────
function computeSwings(slice) {
  const n = slice.length;
  const highs = [], lows = [];
  for (let i = FRACTAL_K; i < n - FRACTAL_K; i++) {
    let isHigh = true, isLow = true;
    for (let k = i - FRACTAL_K; k <= i + FRACTAL_K; k++) {
      if (k === i) continue;
      if (slice[k].high > slice[i].high) isHigh = false;
      if (slice[k].low < slice[i].low) isLow = false;
    }
    if (isHigh) highs.push({ idx: i, date: slice[i].date, price: slice[i].high });
    if (isLow) lows.push({ idx: i, date: slice[i].date, price: slice[i].low });
  }
  return { highs, lows };
}

function determineStructure(swings) {
  const highs = swings.highs.slice(-3);
  const lows = swings.lows.slice(-3);
  if (highs.length < 2 || lows.length < 2) {
    return { label: '盤整', reason: '樣本不足（swing 高/低點 < 2 個）' };
  }
  const h2 = highs.slice(-2); // [較舊, 較新]
  const l2 = lows.slice(-2);
  const highsDown = h2[1].price < h2[0].price;
  const highsUp = h2[1].price > h2[0].price;
  const lowsDown = l2[1].price < l2[0].price;
  const lowsUp = l2[1].price > l2[0].price;
  let label = '盤整';
  if (highsDown && lowsDown) label = '下跌';
  else if (highsUp && lowsUp) label = '上升';
  return { label };
}

// ── D. 支撐壓力互換（role reversal）─────────────────────────────────────
// 現價「上方」的 swing low（原本是支撐點）→ 前支撐已被跌破，反過來變壓力
// 現價「下方」的 swing high（原本是壓力點）→ 前壓力已被站上，反過來變支撐
function computeReversals(swings, currentPrice) {
  const reversalHighIdx = new Set(); // swing high 但現在在現價下方 → 前壓力→現支撐
  const reversalLowIdx = new Set();  // swing low 但現在在現價上方 → 前支撐→現壓力
  for (const hi of swings.highs) if (hi.price < currentPrice) reversalHighIdx.add(hi.idx);
  for (const lo of swings.lows) if (lo.price > currentPrice) reversalLowIdx.add(lo.idx);
  return { reversalHighIdx, reversalLowIdx, count: reversalHighIdx.size + reversalLowIdx.size };
}

// ── E. 假突破/假跌破 ─────────────────────────────────────────────────
// type：close[i] 破上緣=breakout、破下緣=breakdown。
// status：之後 FALSE_BREAKOUT_WINDOW(5) 根內 close 收回通道內 → false（假）；未收回 → true（真）；
//         右側資料不足 5 根 → pending（待確認，防未來函數，不可武斷判真假）。
function computeBreakoutEvents(slice, channel) {
  const n = slice.length;
  const events = [];
  for (let i = 0; i < n; i++) {
    const close = slice[i].close;
    let type = null;
    if (close > channel.upper[i]) type = 'breakout';
    else if (close < channel.lower[i]) type = 'breakdown';
    if (!type) continue;

    const aheadAvail = n - 1 - i;
    if (aheadAvail < FALSE_BREAKOUT_WINDOW) {
      events.push({ idx: i, type, status: 'pending' });
      continue;
    }
    let reverted = false;
    for (let k = i + 1; k <= i + FALSE_BREAKOUT_WINDOW; k++) {
      const c2 = slice[k].close;
      if (type === 'breakout' && c2 <= channel.upper[k]) { reverted = true; break; }
      if (type === 'breakdown' && c2 >= channel.lower[k]) { reverted = true; break; }
    }
    events.push({ idx: i, type, status: reverted ? 'false' : 'true' });
  }
  return events;
}

// ── F. 整數關卡（現價 ±15%，QQQ 每 50 元一條） ───────────────────────────
function computeRoundLevels(price) {
  const lo = price * (1 - ROUND_RANGE_PCT);
  const hi = price * (1 + ROUND_RANGE_PCT);
  const levels = [];
  const start = Math.ceil(lo / ROUND_STEP) * ROUND_STEP;
  for (let v = start; v <= hi; v += ROUND_STEP) levels.push(v);
  return levels;
}

// ── G. 均線動態支撐/壓力（MA60季線／MA250年線） ─────────────────────────
// computeMA 回傳 [[date,val],...]（砍暖身期，從 index period-1 開始）；對齊回原長度陣列
// 用「全歷史」bars 算（非僅 lookback 切片），避免顯示區間開頭因暖身不足出現不必要的 null。
function alignMAFull(bars, period) {
  const closeSeries = bars.map(b => [b.date, b.close]);
  const raw = computeMA(closeSeries, period);
  const out = new Array(bars.length).fill(null);
  for (let k = 0; k < raw.length; k++) out[period - 1 + k] = raw[k][1];
  return out;
}

// ── 彙整：lookback 切片 + 三塊演算法 + 主圖顯示範圍(含暖身) ────────────
function buildDisplay(bars, lb) {
  const n = bars.length;
  const effLb = Math.min(lb, n);
  const startIdx = n - effLb;
  const warmup = Math.min(WARMUP_MAX, startIdx);
  const displayStart = startIdx - warmup;
  const displayBars = bars.slice(displayStart);
  const slice = bars.slice(startIdx);

  const vpvr = computeVPVR(slice);
  const channel = computeChannel(slice);
  const breakoutsLocal = computeBreakouts(bars, startIdx, channel);
  const swings = computeSwings(slice);
  const structure = determineStructure(swings);

  const lastClose = slice[slice.length - 1].close;
  const lastUpper = channel.upper[channel.upper.length - 1];
  const lastLower = channel.lower[channel.lower.length - 1];
  let channelState;
  if (lastClose > lastUpper) channelState = '放量突破上緣';
  else if (lastClose < lastLower) channelState = '跌破下緣';
  else channelState = '在通道內';

  const reversal = computeReversals(swings, lastClose);
  const breakoutEvents = computeBreakoutEvents(slice, channel);
  const roundLevels = computeRoundLevels(lastClose);

  const localOffset = startIdx - displayStart; // == warmup
  const trendFull = new Array(displayBars.length).fill(null);
  const upperFull = new Array(displayBars.length).fill(null);
  const lowerFull = new Array(displayBars.length).fill(null);
  for (let li = 0; li < effLb; li++) {
    trendFull[localOffset + li] = channel.trend[li];
    upperFull[localOffset + li] = channel.upper[li];
    lowerFull[localOffset + li] = channel.lower[li];
  }

  // MA60/MA250：算在全歷史 bars 上，再裁到 displayBars 對應區間
  const ma60Full = alignMAFull(bars, MA_SUPPORT_PERIOD);
  const ma250Full = alignMAFull(bars, MA_RESIST_PERIOD);
  const ma60Display = displayBars.map((_, i) => ma60Full[displayStart + i] ?? null);
  const ma250Display = displayBars.map((_, i) => ma250Full[displayStart + i] ?? null);
  const ma60Latest = ma60Full[n - 1];
  const ma250Latest = ma250Full[n - 1];

  return {
    displayBars, slice, localOffset, effLb,
    vpvr, channel, breakoutsLocal, swings, structure,
    lastClose, lastUpper, lastLower, channelState,
    trendFull, upperFull, lowerFull,
    reversal, breakoutEvents, roundLevels,
    ma60Display, ma250Display, ma60Latest, ma250Latest,
  };
}

// ── badges ────────────────────────────────────────────────────────────
function setText(id, txt, color) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = txt;
  if (color) el.style.color = color;
}

function updateBadges(res) {
  const trendColor = res.structure.label === '上升' ? '#3fb950'
    : res.structure.label === '下跌' ? '#f85149' : '#e3b341';
  setText('struct-trend-val', res.structure.label, trendColor);
  setText('struct-trend-sub',
    `swing high ${res.swings.highs.length} 個｜swing low ${res.swings.lows.length} 個（取最近各3個，用最近2個判定）`,
    'var(--muted)');

  const channelColor = res.channelState === '在通道內' ? '#8b949e'
    : res.channelState === '放量突破上緣' ? '#3fb950' : '#f85149';
  setText('struct-channel-val', res.channelState, channelColor);
  const slopeDir = res.channel.slope > 0 ? '上升通道' : res.channel.slope < 0 ? '下降通道' : '走平';
  setText('struct-channel-sub',
    `${slopeDir}（斜率 ${res.channel.slope.toFixed(3)}/日）｜lookback 內放量突破 ${res.breakoutsLocal.length} 次`,
    'var(--muted)');

  const price = res.lastClose;
  const fmtLevel = (label, v) => {
    if (v == null) return `${label}：無`;
    const pct = ((v - price) / price * 100).toFixed(2);
    return `${label} ${v.toFixed(2)}（${Number(pct) > 0 ? '+' : ''}${pct}%）`;
  };
  setText('struct-sr-val', `${fmtLevel('支撐', res.vpvr.support)}　|　${fmtLevel('壓力', res.vpvr.resistance)}`,
    PALETTE.text);
  setText('struct-sr-sub', `POC ${res.vpvr.poc.toFixed(2)}｜現價 ${price.toFixed(2)}`, 'var(--muted)');

  const status = document.getElementById('struct-status');
  if (status) status.textContent =
    `QQQ · lookback ${lookback} 日（實際 ${res.effLb} 根）· 現價 ${price.toFixed(2)} · POC ${res.vpvr.poc.toFixed(2)} · 結構 ${res.structure.label} · 通道 ${res.channelState}`;

  // 新增：支撐壓力互換 / 假突破假跌破 / 均線最新值 摘要（供圖上核對，非另開 badge）
  const be = res.breakoutEvents;
  const nPending = be.filter(e => e.status === 'pending').length;
  const nTrue = be.filter(e => e.status === 'true').length;
  const nFalse = be.filter(e => e.status === 'false').length;
  const latestEvent = be.length ? be[be.length - 1] : null;
  const latestTxt = latestEvent
    ? `最新一個突破/跌破事件：${latestEvent.type === 'breakout' ? '突破上緣' : '跌破下緣'} @ ${res.slice[latestEvent.idx].date}（${{ pending: '待確認', true: '真', false: '假' }[latestEvent.status]}）`
    : '本區間內無突破/跌破事件';
  const notes = document.getElementById('struct-notes');
  if (notes) {
    notes.textContent =
      `支撐壓力互換點 ${res.reversal.count} 個（前壓力→現支撐 ${res.reversal.reversalHighIdx.size}、前支撐→現壓力 ${res.reversal.reversalLowIdx.size}）｜` +
      `突破/跌破事件 ${be.length} 個（真 ${nTrue}／假 ${nFalse}／待確認 ${nPending}）｜${latestTxt}｜` +
      `MA60(季線) ${res.ma60Latest != null ? res.ma60Latest.toFixed(2) : 'N/A'}｜MA250(年線) ${res.ma250Latest != null ? res.ma250Latest.toFixed(2) : 'N/A'}｜` +
      `整數關卡 ${res.roundLevels.join('/')}`;
  }
}

// ── 主圖渲染 ──────────────────────────────────────────────────────────
function renderMainChart(res) {
  const axisClr = PALETTE.muted;
  const gridClr = PALETTE.grid;
  const tipBg = PALETTE.bg;
  const tipBdr = PALETTE.border;
  const textClr = PALETTE.text2;

  const dates = res.displayBars.map(b => b.date);
  const closes = res.displayBars.map(b => b.close);

  // swing high/low：若屬「支撐壓力互換」候選點，改用空心菱形+文字label取代一般三角形
  const highMarks = res.swings.highs.map(s => {
    const isRev = res.reversal.reversalHighIdx.has(s.idx);
    return isRev ? {
      coord: [dates[res.localOffset + s.idx], s.price],
      symbol: 'diamond', symbolSize: 13,
      itemStyle: { color: 'transparent', borderColor: '#f778ba', borderWidth: 2 },
      label: { show: true, formatter: '前壓力→現支撐', position: 'bottom', fontSize: 9, color: '#f778ba' },
    } : {
      coord: [dates[res.localOffset + s.idx], s.price],
      symbol: 'triangle', symbolRotate: 180, symbolSize: 9,
      itemStyle: { color: '#f85149' }, label: { show: false },
    };
  });
  const lowMarks = res.swings.lows.map(s => {
    const isRev = res.reversal.reversalLowIdx.has(s.idx);
    return isRev ? {
      coord: [dates[res.localOffset + s.idx], s.price],
      symbol: 'diamond', symbolSize: 13,
      itemStyle: { color: 'transparent', borderColor: '#f778ba', borderWidth: 2 },
      label: { show: true, formatter: '前支撐→現壓力', position: 'top', fontSize: 9, color: '#f778ba' },
    } : {
      coord: [dates[res.localOffset + s.idx], s.price],
      symbol: 'triangle', symbolSize: 9,
      itemStyle: { color: '#3fb950' }, label: { show: false },
    };
  });

  // 假突破/假跌破：真=實心三角形（綠=真突破/紅=真跌破）、假=空心圓、待確認=灰菱形
  const breakoutEventMarks = res.breakoutEvents.map(ev => {
    const bar = res.slice[ev.idx];
    const coord = [dates[res.localOffset + ev.idx], bar.close];
    if (ev.status === 'pending') {
      return {
        coord, symbol: 'diamond', symbolSize: 11,
        itemStyle: { color: '#8b949e' },
        label: { show: true, formatter: '待確認', position: 'top', fontSize: 9, color: '#8b949e' },
      };
    }
    if (ev.status === 'false') {
      const clr = '#e3b341';
      return {
        coord, symbol: 'emptyCircle', symbolSize: 11,
        itemStyle: { color: 'transparent', borderColor: clr, borderWidth: 2 },
        label: { show: true, formatter: ev.type === 'breakout' ? '假突破' : '假跌破', position: 'top', fontSize: 9, color: clr },
      };
    }
    const clr = ev.type === 'breakout' ? '#3fb950' : '#f85149';
    return {
      coord, symbol: 'triangle', symbolRotate: ev.type === 'breakout' ? 0 : 180, symbolSize: 12,
      itemStyle: { color: clr },
      label: { show: true, formatter: ev.type === 'breakout' ? '真突破' : '真跌破', position: ev.type === 'breakout' ? 'top' : 'bottom', fontSize: 9, color: clr },
    };
  });

  // 整數關卡：現價 ±15%、QQQ 每 50 元一條，淡色虛線
  const roundLevelLines = res.roundLevels.map(v => ({
    yAxis: v,
    lineStyle: { color: axisClr, type: 'dashed', width: 1, opacity: 0.45 },
    label: { formatter: `整數關卡 ${v}`, color: axisClr, fontSize: 9, position: 'insideEndTop' },
  }));

  chart.setOption({
    backgroundColor: 'transparent', animation: false,
    tooltip: {
      trigger: 'axis',
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        const p = params.find(x => x.seriesName === '收盤');
        if (!p) return '';
        const i = p.dataIndex;
        let html = `<div style="font-weight:600;margin-bottom:4px">${dates[i]}</div>`;
        html += `<div>收盤 ${closes[i] != null ? closes[i].toFixed(2) : '—'}</div>`;
        if (res.trendFull[i] != null) {
          html += `<div>迴歸中線 ${res.trendFull[i].toFixed(2)}｜上緣 ${res.upperFull[i].toFixed(2)}｜下緣 ${res.lowerFull[i].toFixed(2)}</div>`;
        }
        if (res.ma60Display[i] != null) html += `<div>MA60(季線) ${res.ma60Display[i].toFixed(2)}</div>`;
        if (res.ma250Display[i] != null) html += `<div>MA250(年線) ${res.ma250Display[i].toFixed(2)}</div>`;
        return html;
      },
    },
    legend: {
      data: ['收盤', '迴歸中線', '通道上緣', '通道下緣', 'MA60(季線)', 'MA250(年線)'],
      top: 2, left: 'center', itemWidth: 14, itemHeight: 8,
      textStyle: { color: textClr, fontSize: 10 }, inactiveColor: axisClr,
    },
    grid: { left: 56, right: 30, top: '14%', bottom: '14%' },
    xAxis: {
      type: 'category', data: dates, boundaryGap: false,
      axisLine: { lineStyle: { color: axisClr } }, axisTick: { show: false },
      axisLabel: { color: axisClr, fontSize: 11 }, splitLine: { show: false },
    },
    yAxis: {
      scale: true, position: 'left',
      axisLabel: { color: axisClr, fontSize: 11 }, axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: gridClr } },
    },
    dataZoom: [{ type: 'inside', filterMode: 'none' }, { type: 'slider', height: 16, bottom: 4 }],
    series: [
      {
        name: '收盤', type: 'line', data: closes, showSymbol: false, z: 5,
        lineStyle: { color: '#58a6ff', width: 1.6 },
        markPoint: { silent: false, data: [...highMarks, ...lowMarks, ...breakoutEventMarks] },
        markLine: {
          silent: true, symbol: 'none',
          data: roundLevelLines,
        },
      },
      {
        name: '迴歸中線', type: 'line', data: res.trendFull, showSymbol: false, connectNulls: false,
        lineStyle: { color: '#8b949e', width: 1, type: 'dashed' },
      },
      {
        name: '通道上緣', type: 'line', data: res.upperFull, showSymbol: false, connectNulls: false,
        lineStyle: { color: '#3fb950', width: 1.2, opacity: 0.8 },
      },
      {
        name: '通道下緣', type: 'line', data: res.lowerFull, showSymbol: false, connectNulls: false,
        lineStyle: { color: '#f85149', width: 1.2, opacity: 0.8 },
      },
      {
        name: 'MA60(季線)', type: 'line', data: res.ma60Display, showSymbol: false, connectNulls: true, z: 3,
        lineStyle: { color: '#e3b341', width: 1.2, opacity: 0.9 },
      },
      {
        name: 'MA250(年線)', type: 'line', data: res.ma250Display, showSymbol: false, connectNulls: true, z: 3,
        lineStyle: { color: '#d2a8ff', width: 1.4, opacity: 0.9 },
      },
    ],
  }, { notMerge: true });
}

// ── VPVR 側圖渲染（水平長條：y=價格bin、x=成交量） ──────────────────────
function renderVpvrChart(res) {
  const axisClr = PALETTE.muted;
  const tipBg = PALETTE.bg;
  const tipBdr = PALETTE.border;
  const textClr = PALETTE.text2;
  const barBase = PALETTE.border;

  const vc = res.vpvr;
  const hvnSet = new Set(vc.hvnIdx);
  const labels = vc.centers.map(c => c.toFixed(1));

  let curIdx = 0, curDist = Infinity;
  vc.centers.forEach((c, i) => {
    const d = Math.abs(c - vc.currentPrice);
    if (d < curDist) { curDist = d; curIdx = i; }
  });

  vpvrChart.setOption({
    backgroundColor: 'transparent', animation: false,
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'shadow' },
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        const p = params[0];
        if (!p) return '';
        return `價位 ${labels[p.dataIndex]}<br/>量 ${Math.round(p.value).toLocaleString()}`;
      },
    },
    grid: { left: 64, right: 16, top: 10, bottom: 20 },
    xAxis: {
      type: 'value', axisLabel: { show: false },
      splitLine: { show: false }, axisLine: { show: false }, axisTick: { show: false },
    },
    yAxis: {
      type: 'category', data: labels,
      axisLabel: { color: axisClr, fontSize: 9 }, axisLine: { show: false }, axisTick: { show: false },
    },
    series: [{
      type: 'bar', barWidth: '72%',
      data: vc.bins.map((v, i) => ({
        value: v,
        itemStyle: { color: i === vc.pocIdx ? '#e3b341' : (hvnSet.has(i) ? '#58a6ff' : barBase) },
      })),
      markLine: {
        silent: true, symbol: 'none',
        lineStyle: { color: '#f85149', type: 'dashed', width: 1.5 },
        data: [{ yAxis: labels[curIdx], label: { formatter: '現價', color: '#f85149', fontSize: 9, position: 'insideEndTop' } }],
      },
    }],
  }, { notMerge: true });
}

function render(bars) {
  if (!chart || !vpvrChart) return;
  const res = buildDisplay(bars, lookback);
  renderMainChart(res);
  renderVpvrChart(res);
  updateBadges(res);
}

// ── controls ──────────────────────────────────────────────────────────
function buildControls() {
  const host = document.getElementById('struct-lookback-picker');
  if (!host || host.dataset.built) return;
  host.dataset.built = '1';
  host.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => {
    host.querySelectorAll('.chip').forEach(e => e.classList.remove('active'));
    c.classList.add('active');
    lookback = parseInt(c.dataset.structLookback, 10);
    if (allBars) render(allBars);
  }));
}

async function refresh() {
  const status = document.getElementById('struct-status');
  try {
    const bars = await loadData();
    render(bars);
  } catch (e) {
    if (status) status.textContent = `載入失敗：${e.message}`;
    console.error('[struct] load failed', e);
  }
}

// ── lifecycle ─────────────────────────────────────────────────────────
export async function init() {
  const host = document.getElementById('struct-chart');
  const vhost = document.getElementById('struct-vpvr');
  if (!host || !vhost) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : 'dark');
  else chart.resize();
  if (!vpvrChart) vpvrChart = echarts.init(vhost, isLight() ? null : 'dark');
  else vpvrChart.resize();
  buildControls();
  if (allBars) { render(allBars); return; }
  await refresh();
}
export function onThemeChange(light) {
  if (chart) {
    chart.dispose();
    chart = echarts.init(document.getElementById('struct-chart'), light ? null : 'dark');
  }
  if (vpvrChart) {
    vpvrChart.dispose();
    vpvrChart = echarts.init(document.getElementById('struct-vpvr'), light ? null : 'dark');
  }
  if (allBars) render(allBars);
}
export function resize() { chart?.resize(); vpvrChart?.resize(); }
