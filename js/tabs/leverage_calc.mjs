// Pure leverage calculations extracted from leverage.js.
const dayDiff = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

// ── Math core ─────────────────────────────────────────────────────────────
export function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
export function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
// Geometric Brownian Motion underlying level path (starts at 1).
export function gbmLevels(days, muA, sigA, rng) {
  const dt = 1 / 252, drift = (muA - 0.5 * sigA * sigA) * dt, vol = sigA * Math.sqrt(dt);
  const L = [1];
  for (let i = 1; i <= days; i++) L.push(L[i - 1] * Math.exp(drift + vol * gauss(rng)));
  return L;
}
// Daily-reset leveraged curve (starts at 1) from an underlying level series.
export function leverageFromLevels(levels, K, annualCost) {
  const dd = annualCost / 252, lev = [1];
  for (let i = 1; i < levels.length; i++) {
    const r = levels[i] / levels[i - 1] - 1;
    lev.push(Math.max(lev[i - 1] * (1 + K * r - dd), 0));
  }
  return lev;
}
export function maxDrawdown(eq) {
  let peak = -Infinity, mdd = 0;
  for (const v of eq) { if (v > peak) peak = v; if (peak > 0) mdd = Math.min(mdd, v / peak - 1); }
  return mdd;
}
export function longestUnderwater(dates, eq) {
  let peak = -Infinity, peakDate = dates[0], maxd = 0;
  for (let i = 0; i < eq.length; i++) {
    if (eq[i] >= peak) { peak = eq[i]; peakDate = dates[i]; }
    else maxd = Math.max(maxd, dayDiff(peakDate, dates[i]));
  }
  return maxd;
}
export function drawdownEpisodes(dates, eq, topN = 5) {
  const eps = [];
  let peak = eq[0], pi = 0, trough = eq[0], ti = 0, inDD = false;
  for (let i = 1; i < eq.length; i++) {
    if (eq[i] >= peak) {
      if (inDD) { eps.push({ pi, ti, ri: i, depth: trough / peak - 1 }); inDD = false; }
      peak = eq[i]; pi = i; trough = eq[i]; ti = i;
    } else {
      if (eq[i] < trough) { trough = eq[i]; ti = i; }
      inDD = true;
    }
  }
  if (inDD) eps.push({ pi, ti, ri: null, depth: trough / peak - 1 });
  eps.sort((a, b) => a.depth - b.depth);
  return eps.slice(0, topN).map(e => ({
    depth: e.depth, peakDate: dates[e.pi], troughDate: dates[e.ti],
    recDate: e.ri != null ? dates[e.ri] : null,
    days: dayDiff(dates[e.pi], e.ri != null ? dates[e.ri] : dates[dates.length - 1]),
  }));
}
export function crashLevels(scenario) {
  const L = [1];
  const glideTo = (target, steps) => {
    const start = L[L.length - 1];
    for (let i = 1; i <= steps; i++) L.push(start * Math.pow(target / start, i / steps));
  };
  if (scenario === 'vshape') { glideTo(0.65, 25); glideTo(0.95, 35); glideTo(1.02, 20); }
  else if (scenario === 'lcrash') { glideTo(0.5, 18); for (let i = 0; i < 55; i++) L.push(L[L.length - 1] * (1 + (i % 2 ? 0.004 : -0.004))); }
  else if (scenario === 'sawtooth') { for (let i = 0; i < 90; i++) L.push(L[L.length - 1] * (1 + (i % 2 ? 0.06 : -0.06))); }
  else { glideTo(0.55, 180); }
  return L;
}

// ── Historical backtest builder ───────────────────────────────────────────
export function applyContrib(dates, levNav, oneNav, settings) {
  const n = dates.length, levVal = new Array(n), oneVal = new Array(n);
  let levUnits = 0, oneUnits = 0, contributed = 0, curMonth = dates[0].slice(0, 7);
  for (let i = 0; i < n; i++) {
    if (i === 0) { levUnits += settings.initial / levNav[0]; oneUnits += settings.initial / oneNav[0]; contributed += settings.initial; }
    else if (settings.dca) {
      const m = dates[i].slice(0, 7);
      if (m !== curMonth) { curMonth = m; if (levNav[i] > 0 && oneNav[i] > 0) { levUnits += settings.dcaAmount / levNav[i]; oneUnits += settings.dcaAmount / oneNav[i]; contributed += settings.dcaAmount; } }
    }
    levVal[i] = levUnits * levNav[i]; oneVal[i] = oneUnits * oneNav[i];
  }
  return { levVal, oneVal, contributed };
}
export function buildBacktestPure(bundle, settings) {
  const etf = bundle.etfs.find(e => e.id === settings.etf);
  if (!etf) return null;
  const under = bundle.underlyings[etf.underlying];
  const uData = under.data;
  const from = settings.from || uData[0][0];
  const to = settings.to || uData[uData.length - 1][0];
  const win = uData.filter(r => r[0] >= from && r[0] <= to);
  if (win.length < 2) return null;
  const K = etf.leverage, inc = etf.inception;
  const annualCost = etf.expense + (K - 1) * etf.financing, dd = annualCost / 252;
  const rret = {};
  for (let i = 1; i < etf.real.length; i++) rret[etf.real[i][0]] = etf.real[i][1] / etf.real[i - 1][1] - 1;
  const dates = [win[0][0]], levNav = [1], oneNav = [1];
  let synthDays = 0;
  for (let i = 1; i < win.length; i++) {
    const d = win[i][0], ur = win[i][1] / win[i - 1][1] - 1;
    let lr;
    if (d >= inc && rret[d] != null) lr = rret[d];
    else { lr = K * ur - dd; synthDays++; }
    levNav.push(Math.max(levNav[i - 1] * (1 + lr), 0));
    oneNav.push(oneNav[i - 1] * (1 + ur));
    dates.push(d);
  }
  const { levVal, oneVal, contributed } = applyContrib(dates, levNav, oneNav, settings);
  return {
    etf, dates, levNav, oneNav, levVal, oneVal, contributed, K, inc, annualCost,
    synthDays, actualStart: dates[0], lastDate: dates[dates.length - 1],
    synthetic: dates[0] < inc, underName: under.name,
  };
}

