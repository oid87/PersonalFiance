// CPI tab calculations. Calendar anchors are caller supplied.
export function percentile(arr, p) {
  const s = arr.filter(v => v != null && !Number.isNaN(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

export function rollingMin(rows, key, window) {
  const out = new Array(rows.length).fill(null);
  for (let i = 0; i < rows.length; i++) {
    let m = null;
    for (let j = Math.max(0, i - window + 1); j <= i; j++) {
      const v = rows[j][key];
      if (v != null && (m == null || v < m)) m = v;
    }
    out[i] = m;
  }
  return out;
}

export function rangeStart(key, now) {
  if (key === "MAX") return "1900-01-01";
  const d = new Date(now);
  d.setFullYear(d.getFullYear() - ({ "1Y": 1, "3Y": 3, "5Y": 5, "10Y": 10 }[key] ?? 10));
  return d.toISOString().slice(0, 10);
}

export function latestNonNull(rows, key) {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i][key] != null) return rows[i].date;
  }
  return null;
}

export function contributionModel(row) {
  const items = [
    ...(row.parts ?? []).map(p => ({ label: p.label, contrib: p.contrib_pp, weight: p.weight, mom: p.mom, isResidual: false })),
    { label: "近似誤差", contrib: row.residual_pp, weight: null, mom: null, isResidual: true },
  ].filter(it => it.contrib != null).sort((a, b) => a.contrib - b.contrib);
  const energyPart = (row.parts ?? []).find(p => p.key === "energy");
  const nonEnergyTotal = energyPart?.contrib_pp != null && row.headline_mom != null
    ? row.headline_mom - energyPart.contrib_pp : null;
  const residualDominates = nonEnergyTotal != null && row.residual_pp != null
    ? Math.abs(row.residual_pp) >= Math.abs(nonEnergyTotal) : null;
  const rawVals = [...items.map(it => it.contrib), row.headline_mom, 0].filter(v => v != null);
  const vMin = Math.min(...rawVals), vMax = Math.max(...rawVals);
  const STEP = 0.05;
  const xMin = Math.floor(vMin / STEP) * STEP - STEP;
  const xMax = Math.ceil(vMax / STEP) * STEP + STEP;
  return { items, nonEnergyTotal, residualDominates, xMin, xMax };
}

export function heatmapModel(comps) {
  const dateSet = new Set();
  for (const c of comps) for (const d of c.data) dateSet.add(d.date);
  const cols = [...dateSet].sort().slice(-24);
  const colLabels = cols.map(d => d.slice(0, 7));
  const AGG_KEYS = ["headline", "core"];
  const aggRows = AGG_KEYS.map(k => comps.find(c => c.key === k)).filter(Boolean);
  const leafRows = comps.filter(c => !AGG_KEYS.includes(c.key));
  const rows = [...leafRows, { spacer: true, label: "" }, ...aggRows];
  const rowLabels = rows.map(r => r.label);
  const heatData = [], allVals = [];
  rows.forEach((r, ri) => {
    if (r.spacer) return;
    const map = new Map(r.data.map(d => [d.date, d.mom]));
    cols.forEach((d, ci) => {
      const v = map.get(d);
      if (v != null) { heatData.push([ci, ri, +v.toFixed(3)]); allVals.push(v); }
      else heatData.push([ci, ri, null]);
    });
  });
  const p5 = percentile(allVals, 0.05), p95 = percentile(allVals, 0.95);
  const bound = Math.max(Math.abs(p5 ?? 0), Math.abs(p95 ?? 0), 0.05);
  return { cols, colLabels, rowLabels, heatData, bound };
}

export function releaseTableRows(market, releaseDates) {
  if (!market.length || !releaseDates.length) return [];
  const dateIdx = new Map(market.map((r, i) => [r.date, i]));
  const rows = [];
  for (const rd of releaseDates) {
    const idx = dateIdx.get(rd);
    if (idx == null) { rows.push({ date: rd, dgs10bp: null, dgs2bp: null }); continue; }
    let prevIdx = idx - 1;
    while (prevIdx >= 0 && market[prevIdx].dgs10 == null) prevIdx--;
    const cur = market[idx], prev = prevIdx >= 0 ? market[prevIdx] : null;
    const dgs10bp = (cur.dgs10 != null && prev?.dgs10 != null) ? Math.round((cur.dgs10 - prev.dgs10) * 100) : null;
    let prevIdx2 = idx - 1;
    while (prevIdx2 >= 0 && market[prevIdx2].dgs2 == null) prevIdx2--;
    const prev2 = prevIdx2 >= 0 ? market[prevIdx2] : null;
    const dgs2bp = (cur.dgs2 != null && prev2?.dgs2 != null) ? Math.round((cur.dgs2 - prev2.dgs2) * 100) : null;
    rows.push({ date: rd, dgs10bp, dgs2bp });
  }
  return rows.slice(-12);
}

export function marketModel(full, releaseDates, cutoff) {
  const rows = full.filter(r => r.date >= cutoff);
  const rollMinAll = rollingMin(full, "dgs10", 60);
  const rollMinMap = new Map(full.map((r, i) => [r.date, rollMinAll[i]]));
  const releaseDatesInView = releaseDates.filter(d => d >= cutoff && d <= (rows[rows.length - 1]?.date ?? d));
  return { rows, rollMinMap, releaseDatesInView };
}
