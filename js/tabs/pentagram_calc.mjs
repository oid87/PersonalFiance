// 五線譜／樂活通道的純函式模組。無 DOM、無 fetch、無 new Date()(日期一律由參數傳入)。
import { computeLinearRegression } from '../utils/math.js';
import { toWeekly } from '../utils/dates.js';

export const ZONES = [
  { key: 'xgreed',  label: '極度貪婪', color: '#e91e63' },
  { key: 'greed',   label: '貪婪',     color: '#f48fb1' },
  { key: 'neutral', label: '中性',     color: '#78909c' },
  { key: 'fear',    label: '恐懼',     color: '#64b5f6' },
  { key: 'xfear',   label: '極度恐懼', color: '#1565c0' },
];

export function pentaZone(price, b) {
  const { u2, u1, l1, l2 } = b;
  if (price >= u2) return ZONES[0];
  if (price >= u1) return ZONES[1];
  if (price <= l2) return ZONES[4];
  if (price <= l1) return ZONES[3];
  return ZONES[2];
}

export function lastBands(reg) {
  if (!reg) return null;
  const last = arr => arr[arr.length - 1][1];
  return {
    u2: last(reg.upper2),
    u1: last(reg.upper1),
    tr: last(reg.trend),
    l1: last(reg.lower1),
    l2: last(reg.lower2),
  };
}

export function periodStart(period, today) {
  const d = new Date(today + "T00:00:00Z");
  if (period === "0.5Y") {
    d.setUTCMonth(d.getUTCMonth() - 6);
  } else if (period === "1.5Y") {
    d.setUTCFullYear(d.getUTCFullYear() - 1);
    d.setUTCMonth(d.getUTCMonth() - 6);
  } else if (period === "3.5Y") {
    d.setUTCFullYear(d.getUTCFullYear() - 3);
    d.setUTCMonth(d.getUTCMonth() - 6);
  } else if (period === "5Y") {
    d.setUTCFullYear(d.getUTCFullYear() - 5);
  } else {
    throw new Error(`unknown period: ${period}`);
  }
  return d.toISOString().slice(0, 10);
}

export function multiPeriodZones(daily, periods, today, { weekly = false } = {}) {
  return periods.map(period => {
    const start = periodStart(period, today);
    let rows = daily.filter(r => r[0] >= start && r[0] <= today);
    if (weekly) rows = toWeekly(rows);
    const reg = computeLinearRegression(rows);
    const bands = lastBands(reg);
    const zone = bands ? pentaZone(rows[rows.length - 1][1], bands) : null;
    return { period, n: rows.length, bands, zone };
  });
}

export function computeDonchianBands(weeklyHLC, n = 20) {
  const mid = [], upper = [], lower = [];
  if (weeklyHLC.length <= n) return { mid, upper, lower };
  for (let i = n; i < weeklyHLC.length; i++) {
    const window = weeklyHLC.slice(i - n, i);
    let hi = -Infinity, lo = Infinity;
    for (const [, high, low] of window) {
      if (high > hi) hi = high;
      if (low < lo) lo = low;
    }
    const date = weeklyHLC[i][0];
    const midVal = (hi + lo) / 2;
    upper.push([date, +hi.toFixed(4)]);
    lower.push([date, +lo.toFixed(4)]);
    mid.push([date, +midVal.toFixed(4)]);
  }
  return { mid, upper, lower };
}

export function channelState(close, upper, lower) {
  if (close == null || upper == null || lower == null ||
      Number.isNaN(close) || Number.isNaN(upper) || Number.isNaN(lower)) {
    return { key: 'na', label: '—' };
  }
  if (close > upper) return { key: 'above', label: '突破上緣' };
  if (close < lower) return { key: 'below', label: '跌破下緣' };
  return { key: 'inside', label: '通道內' };
}

export function combinedSignal(zoneKey, chKey) {
  if (zoneKey === 'xgreed') {
    if (chKey === 'above') {
      return { tone: 'warn', text: '五線譜極度貪婪＋突破樂活上緣：股價可能將轉弱' };
    }
    return { tone: 'info', text: '僅五線譜極度貪婪、樂活未突破上緣：有機會再漲一段' };
  }
  if (zoneKey === 'xfear') {
    if (chKey === 'below') {
      return { tone: 'opportunity', text: '五線譜極度恐懼＋跌破樂活下緣：底部訊號較強' };
    }
    return { tone: 'info', text: '僅五線譜極度恐懼、樂活未跌破下緣：底部訊號較弱' };
  }
  return null;
}
