// Calculations for the trend tab. Inputs and helper functions are supplied by the caller.
export function interpFpe(arr) {
  if (!arr || arr.length < 2) return arr.map(r => [r.date, r.fpe]);
  const out = [];
  for (let i = 0; i < arr.length - 1; i++) {
    const t1 = new Date(arr[i].date + "T00:00:00Z").getTime(), v1 = arr[i].fpe;
    const t2 = new Date(arr[i + 1].date + "T00:00:00Z").getTime(), v2 = arr[i + 1].fpe;
    const gap = Math.round((t2 - t1) / 86400000);
    for (let j = 0; j < gap; j++) {
      // check_reuse: keep — UTC 建構與 UTC 日期鍵切片相配；本地軸日期轉換會偏移一天。
      out.push([new Date(t1 + j * 86400000).toISOString().slice(0, 10), +(v1 + (v2 - v1) * (j / gap)).toFixed(3)]);
    }
  }
  out.push([arr[arr.length - 1].date, arr[arr.length - 1].fpe]);
  return out;
}

export function fearZones(fg, threshold) {
  if (!fg) return [];
  const out = [];
  let s = null, last = null;
  for (const [d, v] of fg) {
    if (v <= threshold) { if (!s) s = d; last = d; }
    else if (s) { out.push([s, last]); s = null; }
  }
  if (s) out.push([s, last]);
  return out;
}

export function fearEpisodes(fg, threshold) {
  if (!fg) return [];
  const out = [];
  let s = null, fgMin = 100, last = null;
  for (const [d, v] of fg) {
    if (v <= threshold) {
      if (!s) { s = d; fgMin = 100; }
      if (v < fgMin) fgMin = v;
      last = d;
    } else if (s) {
      out.push({ start: s, end: last, fgMin,
        days: Math.round((new Date(last) - new Date(s)) / 86400000) + 1 });
      s = null;
    }
  }
  if (s) out.push({ start: s, end: last, fgMin,
    days: Math.round((new Date(last) - new Date(s)) / 86400000) + 1 });
  return out;
}

export function drawdownFromPriorPeak(qqq, n) {
  const arr = [];
  for (let i = 0; i < qqq.length; i++) {
    if (i < n) { arr.push([qqq[i][0], null]); continue; }
    let peak = 0;
    for (let j = i - n; j < i; j++) if (qqq[j][1] > peak) peak = qqq[j][1];
    arr.push([qqq[i][0], (qqq[i][1] - peak) / peak * 100]);
  }
  return arr;
}

export function scoreZones(scoreArr, threshold = 4) {
  const zones = [];
  let zStart = null, prev = null;
  for (const [date, score] of scoreArr) {
    if (score >= threshold) { if (!zStart) zStart = date; }
    else if (zStart) { zones.push([zStart, prev]); zStart = null; }
    prev = date;
  }
  if (zStart) zones.push([zStart, prev]);
  return zones;
}

export function signalSnapshot(maps, date, lookupLE) {
  const d = date || maps.qqq.at(-1)?.[0];
  if (!d) return null;
  const ws = lookupLE(maps.weeklySignals, d);
  const fgRow = lookupLE(maps.fg, d);
  const vixRow = lookupLE(maps.vix, d);
  const ma200R = lookupLE(maps.ma200, d);
  const volRow = lookupLE(maps.vol, d);
  const ddRow = lookupLE(maps.ddArr, d);
  const qRow = lookupLE(maps.qqq, d);
  const kdK = ws?.[1] ?? null;
  const rsiVal = ws?.[3] ?? null;
  const tdCount = ws?.[4] ?? 0;
  const tdDir = ws?.[5] ?? null;
  const fgVal = fgRow?.[1] ?? null;
  const vixVal = vixRow?.[1] ?? null;
  const ma200V = ma200R?.[1] ?? null;
  const qClose = qRow?.[1] ?? null;
  const ma200Dev = (ma200V && qClose) ? (qClose - ma200V) / ma200V * 100 : null;
  const volVal = volRow?.[1] ?? null;
  const ddVal = ddRow?.[1] ?? null;
  const dailyRetRow = lookupLE(maps.dailyRetArr, d);
  const dailyRetV = dailyRetRow?.[0] === d ? dailyRetRow[1] : null;
  const hits = [
    kdK != null && kdK < 30, rsiVal != null && rsiVal < 30,
    fgVal != null && fgVal < 25, vixVal != null && vixVal > 20,
    ma200Dev != null && ma200Dev < 0, tdDir === 'down' && tdCount >= 7,
    ddVal != null && ddVal <= -10, volVal != null && volVal >= 80_000_000,
  ];
  return { d, kdK, rsiVal, tdCount, tdDir, fgVal, vixVal, ma200Dev, volVal,
    ddVal, dailyRetV, hits, count: hits.filter(Boolean).length,
    bounceHit: maps.bounceSignalSet?.has(d) ?? false };
}

export function buildSigMaps({ qqq, qqqHLC, fg = [], vix = [], vol = [] }, {
  toWeekly, toWeeklyHLC, computeKD, computeRSI, computeTDSetup,
  computeMA, lookupLE, computeBounceSignals,
}) {
  if (!qqq?.length) return null;
  const weekly = toWeekly(qqq);
  const wHLC = qqqHLC ? toWeeklyHLC(qqqHLC) : null;
  const kdArr = wHLC ? computeKD(wHLC, 9) : [];
  const rsiArr = computeRSI(weekly, 14);
  const tdArr = computeTDSetup(weekly);
  const rsiMap = new Map(rsiArr.map(r => [r[0], r[1]]));
  const tdMap = new Map(tdArr.map(r => [r.date, r]));
  const weeklySignals = kdArr.map(r => {
    const td = tdMap.get(r[0]);
    return [r[0], r[1], r[2], rsiMap.get(r[0]) ?? null, td?.count ?? 0, td?.dir ?? null];
  });
  const ma200 = computeMA(qqq, 200);
  const ddArr = drawdownFromPriorPeak(qqq, 60);
  const scoreArr = [];
  for (const [date, close] of qqq) {
    const ws = lookupLE(weeklySignals, date);
    const fgV = lookupLE(fg, date)?.[1] ?? null;
    const vixV = lookupLE(vix, date)?.[1] ?? null;
    const ma200V = lookupLE(ma200, date)?.[1] ?? null;
    const volV = lookupLE(vol, date)?.[1] ?? null;
    const ddV = lookupLE(ddArr, date)?.[1] ?? null;
    const dev = (ma200V && close) ? (close - ma200V) / ma200V * 100 : null;
    const score = [ws?.[1] != null && ws[1] < 30,
      ws?.[3] != null && ws[3] < 30, fgV != null && fgV < 25,
      vixV != null && vixV > 20, dev != null && dev < 0,
      ws?.[5] === 'down' && (ws[4] ?? 0) >= 7,
      ddV != null && ddV <= -10, volV != null && volV >= 80_000_000,
    ].filter(Boolean).length;
    scoreArr.push([date, score]);
  }
  const dailyRetArr = qqq.slice(1).map((r, i) => [r[0], (r[1] - qqq[i][1]) / qqq[i][1]]);
  const { bounceSignals: bSigs } = computeBounceSignals(qqq, fg, ma200);
  const bounceSignalSet = new Set(bSigs.map(r => r[0]));
  return { qqq, weeklySignals, ma200, ddArr, fg, vix, vol, scoreArr, dailyRetArr, bounceSignalSet };
}
