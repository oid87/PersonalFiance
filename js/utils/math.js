// Pure math/statistics helpers — no state, no DOM.

export function computeMA(data, period) {
  const out = [];
  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j][1];
    out.push([data[i][0], +(sum / period).toFixed(4)]);
  }
  return out;
}

export function toArithReturns(data) {
  const out = [];
  for (let i = 1; i < data.length; i++) {
    const prev = data[i-1][1];
    if (prev !== 0) out.push([data[i][0], (data[i][1] - prev) / prev]);
  }
  return out;
}

export function pearsonCorr(x, y) {
  const n = x.length;
  if (n < 30) return NaN;
  let sx = 0, sy = 0, sxy = 0, sx2 = 0, sy2 = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i]; sy += y[i]; sxy += x[i]*y[i]; sx2 += x[i]*x[i]; sy2 += y[i]*y[i];
  }
  const num = n*sxy - sx*sy;
  const den = Math.sqrt((n*sx2 - sx*sx) * (n*sy2 - sy*sy));
  return den === 0 ? NaN : num / den;
}

export function computeM2YoY(m2data) {
  const out = [];
  for (let i = 12; i < m2data.length; i++) {
    const prev = m2data[i-12][1];
    if (prev > 0) out.push([m2data[i][0], +((m2data[i][1]/prev - 1)*100).toFixed(2)]);
  }
  return out;
}

export function computeLinearRegression(data) {
  const n = data.length;
  if (n < 10) return null;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX  += i;
    sumY  += data[i][1];
    sumXY += i * data[i][1];
    sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return null;
  const slope     = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  let sumR2 = 0;
  for (let i = 0; i < n; i++) {
    const r = data[i][1] - (slope * i + intercept);
    sumR2 += r * r;
  }
  const sigma  = Math.sqrt(sumR2 / n);
  const trend  = [], upper1 = [], upper2 = [], lower1 = [], lower2 = [];
  for (let i = 0; i < n; i++) {
    const date = data[i][0];
    const reg  = slope * i + intercept;
    trend.push( [date, +reg.toFixed(4)]);
    upper1.push([date, +(reg + sigma).toFixed(4)]);
    upper2.push([date, +(reg + 2 * sigma).toFixed(4)]);
    lower1.push([date, +(reg - sigma).toFixed(4)]);
    lower2.push([date, +(reg - 2 * sigma).toFixed(4)]);
  }
  return { trend, upper1, upper2, lower1, lower2 };
}

export function computeRSI(data, period = 14) {
  const out = [];
  if (data.length <= period) return out;
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const d = data[i][1] - data[i-1][1];
    if (d > 0) ag += d; else al -= d;
  }
  ag /= period; al /= period;
  out.push([data[period][0], al === 0 ? 100 : +(100 - 100 / (1 + ag / al)).toFixed(2)]);
  for (let i = period + 1; i < data.length; i++) {
    const d = data[i][1] - data[i-1][1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
    out.push([data[i][0], al === 0 ? 100 : +(100 - 100 / (1 + ag / al)).toFixed(2)]);
  }
  return out;
}

export function computeKD(hlcData, period = 9) {
  const out = [];
  let K = 50, D = 50;
  for (let i = period - 1; i < hlcData.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (hlcData[j][1] > hh) hh = hlcData[j][1];
      if (hlcData[j][2] < ll) ll = hlcData[j][2];
    }
    const rsv = hh === ll ? 50 : (hlcData[i][3] - ll) / (hh - ll) * 100;
    K = K * 2/3 + rsv / 3;
    D = D * 2/3 + K / 3;
    out.push([hlcData[i][0], +K.toFixed(2), +D.toFixed(2)]);
  }
  return out;
}

export function computeTDSetup(closeData) {
  const out = [];
  let uc = 0, dc = 0;
  for (let i = 4; i < closeData.length; i++) {
    const curr = closeData[i][1], p4 = closeData[i-4][1];
    if      (curr > p4) { dc = 0; uc = uc >= 9 ? 1 : uc + 1; out.push({ date: closeData[i][0], count: uc, dir: 'up' }); }
    else if (curr < p4) { uc = 0; dc = dc >= 9 ? 1 : dc + 1; out.push({ date: closeData[i][0], count: dc, dir: 'down' }); }
    else                { uc = 0; dc = 0; }
  }
  return out;
}

export function computeDDZones(dailyData, lookbackDays = 60, threshold = 0.10) {
  if (dailyData.length < lookbackDays + 1) return [];
  const zones = [];
  let zoneStart = null;
  for (let i = lookbackDays; i < dailyData.length; i++) {
    const cur = dailyData[i][1];
    let peak = 0;
    for (let j = i - lookbackDays; j < i; j++) if (dailyData[j][1] > peak) peak = dailyData[j][1];
    const dd = (cur - peak) / peak;
    if (dd <= -threshold) {
      if (!zoneStart) zoneStart = dailyData[i][0];
    } else {
      if (zoneStart) { zones.push([zoneStart, dailyData[i - 1][0]]); zoneStart = null; }
    }
  }
  if (zoneStart) zones.push([zoneStart, dailyData[dailyData.length - 1][0]]);
  return zones;
}

// Bounce signal: QQQ < MA200 & F&G < 15 → 2%+ bounce within 14 days
export function computeBounceSignals(qqqData, fgData, ma200Data) {
  const fgMap    = new Map(fgData.map(r => [r[0], r[1]]));
  const ma200Map = new Map(ma200Data.map(r => [r[0], r[1]]));
  const MS14     = 14 * 86400000;

  // Trigger days: QQQ close < MA200 AND F&G < 15
  const triggerMs = [];
  for (const [date, close] of qqqData) {
    const fg = fgMap.get(date);
    const ma = ma200Map.get(date);
    if (fg != null && fg < 15 && ma != null && close < ma)
      triggerMs.push(new Date(date + "T00:00:00Z").getTime());
  }
  if (!triggerMs.length) return { bounceSignals: [], bounceRetMap: new Map() };

  // Bounce days: within 14 calendar days after any trigger AND daily gain > 2%
  const bounceSignals = [];
  const bounceRetMap  = new Map();
  for (let i = 1; i < qqqData.length; i++) {
    const [date, close] = qqqData[i];
    const prev = qqqData[i - 1][1];
    const ret  = (close - prev) / prev;
    if (ret <= 0.02) continue;
    const dMs = new Date(date + "T00:00:00Z").getTime();
    if (triggerMs.some(t => t <= dMs && dMs <= t + MS14)) {
      const ma   = ma200Map.get(date);
      const vsMa = ma != null ? (close - ma) / ma * 100 : null;
      bounceSignals.push([date, close]);
      bounceRetMap.set(date, { ret, fg: fgMap.get(date) ?? null, vsMa });
    }
  }
  return { bounceSignals, bounceRetMap };
}

const CHANNEL_SIGMA_MULT = 2.5;

export function computeChannelBands(weeklyAll) {
  const N = 20;
  const ma20 = [], upper = [], lower = [];
  for (let i = N - 1; i < weeklyAll.length; i++) {
    const slice = weeklyAll.slice(i - N + 1, i + 1);
    const closes = slice.map(r => r[1]);
    const mean = closes.reduce((a, b) => a + b, 0) / N;
    const variance = closes.reduce((s, v) => s + (v - mean) ** 2, 0) / N;
    const sigma = Math.sqrt(variance);
    const date = weeklyAll[i][0];
    ma20.push([date, +mean.toFixed(4)]);
    upper.push([date, +(mean + CHANNEL_SIGMA_MULT * sigma).toFixed(4)]);
    lower.push([date, +(mean - CHANNEL_SIGMA_MULT * sigma).toFixed(4)]);
  }
  return { ma20, upper, lower };
}
