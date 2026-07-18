// P0-JS equivalence tests — pure node ESM, no framework.
// Run: node js/utils/__tests__/p0_equiv.test.mjs
//
// Each block asserts the new js/utils/{theme,math,data}.js export produces
// bit-identical output to the original inline implementation still living
// in the tab file (grep'd file:line noted per block — line numbers drift,
// re-grep before trusting them). Any item that is NOT full-equal is called
// out explicitly as "特化不全等" with the reason, per spec P0-JS.

import assert from "node:assert";

// ── DOM/BOM stubs (theme.js/echartsBase need document.body + window) ────
// Minimal stand-ins good enough for tc()/isLight()/mob(); no real DOM needed.
let bodyClassSet = new Set();
globalThis.document = {
  body: {
    classList: {
      contains: (c) => bodyClassSet.has(c),
      add: (c) => bodyClassSet.add(c),
      remove: (c) => bodyClassSet.delete(c),
    },
  },
};
globalThis.window = { innerWidth: 1280, innerHeight: 900 };

function setTheme(mode /* "dark" | "light" */) {
  bodyClassSet = new Set(mode === "light" ? ["light"] : []);
  globalThis.document.body.classList.contains = (c) => bodyClassSet.has(c);
}

const { PALETTE, echartsBase, tc } = await import("../theme.js");
const { percentileRank, percentile, mean, std, zscore } = await import("../math.js");
const { fetchJSON } = await import("../data.js");

let passCount = 0;
function pass(label) { passCount++; console.log(`PASS  ${label}`); }
function note(label, reason) { console.log(`NOTE  ${label} — ${reason}`); }

// ═══════════════════════════════════════════════════════════════════════
// theme.js — PALETTE
// ═══════════════════════════════════════════════════════════════════════
// Literal hex pairs per grep tally (2026-07):
//   grep -rhoE 'tc\("#[0-9a-fA-F]{3,6}"\s*,\s*"#[0-9a-fA-F]{3,6}"\)' js/tabs/ | sort | uniq -c | sort -rn
{
  const expectDark = {
    muted: "#8b949e", border: "#30363d", bg: "#161b22",
    text: "#e6edf3", text2: "#c9d1d9", grid: "#21262d", cellBorder: "#0d1117",
  };
  const expectLight = {
    muted: "#57606a", border: "#d0d7de", bg: "#ffffff",
    text: "#1f2328", text2: "#24292f", grid: "#e1e4e8", cellBorder: "#ffffff",
  };

  setTheme("dark");
  for (const k of Object.keys(expectDark)) {
    assert.strictEqual(PALETTE[k], expectDark[k], `PALETTE.${k} (dark)`);
  }
  pass("PALETTE dark-mode hex values match grep tally (js/tabs/*.js literal tc() pairs)");

  setTheme("light");
  for (const k of Object.keys(expectLight)) {
    assert.strictEqual(PALETTE[k], expectLight[k], `PALETTE.${k} (light)`);
  }
  pass("PALETTE light-mode hex values match grep tally");

  // getter, not frozen snapshot: same object re-reads after theme flips
  setTheme("dark");
  assert.strictEqual(PALETTE.muted, "#8b949e");
  setTheme("light");
  assert.strictEqual(PALETTE.muted, "#57606a", "PALETTE.muted must re-evaluate tc() after theme toggle, not stay frozen at import time");
  pass("PALETTE is a live getter (re-evaluates after body class change), not a frozen snapshot");
  setTheme("dark");
}

// ═══════════════════════════════════════════════════════════════════════
// theme.js — echartsBase (structural + deep-merge; P0 does not retrofit
// any tab, so there is no tab-inline value to be bit-equal to)
// ═══════════════════════════════════════════════════════════════════════
{
  const base = echartsBase();
  assert.ok(base.grid && typeof base.grid === "object", "echartsBase().grid present");
  assert.ok(base.tooltip && base.tooltip.trigger === "axis", "echartsBase().tooltip.trigger='axis'");
  assert.ok(base.xAxis && base.yAxis, "echartsBase().xAxis/yAxis present");
  assert.strictEqual(base.tooltip.backgroundColor, PALETTE.bg, "tooltip bg sourced from PALETTE, not a literal");
  assert.strictEqual(base.tooltip.borderColor, PALETTE.border, "tooltip border sourced from PALETTE");
  assert.strictEqual(base.xAxis.axisLabel.color, PALETTE.muted, "xAxis label color sourced from PALETTE");
  assert.strictEqual(base.yAxis.splitLine.lineStyle.color, PALETTE.grid, "yAxis splitLine color sourced from PALETTE");
  assert.ok(Array.isArray(base.dataZoom) && base.dataZoom[0].type === "inside", "dataZoom default present (marginheat.js:184 / cpi.js:259 pattern)");
  pass("echartsBase() structure: grid/tooltip/xAxis/yAxis present, colors from PALETTE (not literals)");

  const merged = echartsBase({ grid: { left: 999 }, xAxis: { name: "foo" } });
  assert.strictEqual(merged.grid.left, 999, "deep merge overrides grid.left");
  assert.ok(merged.grid.right !== undefined, "deep merge preserves sibling grid keys not overridden");
  assert.strictEqual(merged.xAxis.name, "foo", "deep merge adds new xAxis key");
  assert.strictEqual(merged.xAxis.type, "category", "deep merge preserves xAxis.type when not overridden");
  pass("echartsBase(overrides) deep-merges nested objects, does not clobber siblings");
}

// ═══════════════════════════════════════════════════════════════════════
// math.js — percentileRank
// ═══════════════════════════════════════════════════════════════════════

// Inline copy of js/tabs/bullbear.js:34-42 (re-grep to confirm before trusting line#)
function bullbearInline(val, sorted) {
  if (!sorted.length) return 5;
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < val) lo = mid + 1; else hi = mid;
  }
  return (lo / sorted.length) * 10;
}

// Inline copy of js/tabs/marginheat.js:276-284
function marginheatInline(val, sortedAsc) {
  if (!sortedAsc.length) return null;
  let lo = 0, hi = sortedAsc.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedAsc[mid] < val) lo = mid + 1; else hi = mid;
  }
  return (lo / sortedAsc.length) * 100;
}

// Inline copy of js/tabs/usdliq.js:35-39 (note: args are (arr, v), flipped vs the other two)
function usdliqInline(arr, v) {
  if (!arr.length || v == null) return null;
  const below = arr.filter(x => x < v).length;
  return (below / arr.length) * 100;
}

{
  const samples = [
    { v: 5, s: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    { v: 0, s: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    { v: 100, s: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    { v: 4.5, s: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    { v: -3.2, s: [-10, -5.5, -3.2, 0, 1.1, 7] },
    { v: 3.2, s: [3.2] },
    { v: 42, s: [1, 1, 1, 42, 42, 100] },
  ];
  for (const { v, s } of samples) {
    const frac = percentileRank(v, s);
    assert.strictEqual(frac * 10, bullbearInline(v, s), `percentileRank(${v}, [...len=${s.length}])*10 === bullbear inline`);
    assert.strictEqual(frac * 100, marginheatInline(v, s), `percentileRank(${v}, [...len=${s.length}])*100 === marginheat inline`);
    assert.strictEqual(frac * 100, usdliqInline(s, v), `percentileRank(${v}, [...len=${s.length}])*100 === usdliq inline (args flipped: arr,v)`);
  }
  pass("percentileRank fraction ×10/×100 equals bullbear.js:34-42 / marginheat.js:276-284 / usdliq.js:35-39 inline, across 7 (val,sorted) pairs");

  // empty-array fallback divergence: util returns null; callers keep their own fallback (5 / null) — NOT unified
  assert.strictEqual(percentileRank(1, []), null);
  assert.strictEqual(bullbearInline(1, []), 5);
  assert.strictEqual(marginheatInline(1, []), null);
  note("percentileRank empty-array fallback", "util returns null; bullbear.js keeps its own fallback of 5, marginheat.js keeps null — caller-owned, not unified (spec 鐵則 #2)");
}

// ═══════════════════════════════════════════════════════════════════════
// math.js — percentile
// ═══════════════════════════════════════════════════════════════════════

// Inline copy of js/tabs/cpi.js:46-52 (filters + sorts internally; p in 0–1)
function cpiInline(arr, p) {
  const s = arr.filter(v => v != null && !Number.isNaN(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

// Inline copy of js/tabs/levvol.js:61-67 (pre-sorted input; p in 0–1)
function levvolInline(sorted, p) {
  const n = sorted.length;
  if (n === 0) return null;
  const idx = p * (n - 1), lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

// Inline copy of js/tabs/marginmap.js:156-162 (p in 0–100, NOT 0–1)
function marginmapInline(sortedArr, p) {
  if (!sortedArr.length) return null;
  const idx = (p / 100) * (sortedArr.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}

// Inline copy of js/tabs/vixskew.js:481-486 / js/tabs/vxnvix.js:21-25 (identical bodies;
// floor-based nearest-rank, NO interpolation — a genuinely different algorithm)
function vixskewInline(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

{
  const arrs = [
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    [-5, -1, 0, 2, 7, 100],
    [3.14, 2.71, 1.41, 0, -1],
  ];
  const ps = [0, 0.05, 0.25, 0.5, 0.7, 0.95, 1];
  for (const raw of arrs) {
    const sorted = raw.slice().sort((a, b) => a - b);
    for (const p of ps) {
      assert.strictEqual(percentile(sorted, p), cpiInline(raw, p), `percentile(sorted, ${p}) === cpi.js inline (unsorted raw input, same result)`);
      // levvol.js uses the algebraically-equal `lo*(1-frac)+hi*frac` form (vs this
      // util's `lo+(hi-lo)*frac`) — same math, different FP rounding path at
      // non-integer idx. Bit-identical whenever idx is an integer (frac=0/1);
      // tolerance-based elsewhere. Documented, not silently forced to strictEqual.
      const a = percentile(sorted, p), b = levvolInline(sorted, p);
      assert.ok(Math.abs(a - b) < 1e-9, `percentile(sorted, ${p})≈levvol.js inline (within 1e-9; differs from bit-exact only by FP-associativity, see comment)`);
      assert.strictEqual(percentile(sorted, p), marginmapInline(sorted, p * 100), `percentile(sorted, ${p}) === marginmap.js inline(sorted, ${p}*100) [scale 0-1 vs 0-100]`);
    }
  }
  pass("percentile (numpy type-7 linear interp) bit-equal to cpi.js:46-52 & marginmap.js:156-162 (×100 scale) inline; equal to levvol.js:61-67 within 1e-9 (algebraically-equal but differently-ordered FP arithmetic) — 3 arrays × 7 fractions");

  // vixskew/vxnvix: NOT unified — floor/nearest-rank vs linear interpolation.
  // Demonstrate the divergence rather than asserting false equality.
  const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const p = 0.25; // idx = 0.25*9 = 2.25 → interp expects 3.25, floor-rank returns s[2]=3
  assert.strictEqual(vixskewInline(s, p), 3);
  assert.strictEqual(percentile(s, p), 3.25);
  assert.notStrictEqual(percentile(s, p), vixskewInline(s, p));
  note("vixskew.js:481-486 / vxnvix.js:21-25 percentile()", "different algorithm (floor-based nearest-rank, no interpolation) — NOT equal to numpy-style percentile() by design at non-integer idx (e.g. p=0.25 on 10-elem array: floor-rank=3 vs linear-interp=3.25); left un-unified per 鐵則 #2, not retrofitted");
}

// ═══════════════════════════════════════════════════════════════════════
// math.js — mean / std / zscore
// ═══════════════════════════════════════════════════════════════════════

// Inline copy of js/tabs/levvol.js:37-42 (ddof=0, population)
function levvolStdInline(arr) {
  const n = arr.length;
  if (n === 0) return null;
  const m = arr.reduce((a, b) => a + b, 0) / n;
  const v = arr.reduce((a, b) => a + (b - m) * (b - m), 0) / n;
  return Math.sqrt(v);
}

// Inline copy of js/tabs/position.js:107-108 (ddof=0, population)
function positionMeanSdInline(vals) {
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((s, v) => s + (v - m) ** 2, 0) / vals.length);
  return { mean: m, sd };
}

{
  const datasets = [
    [1, 2, 3, 4, 5],
    [10, 10, 10, 10],
    [-3, 0, 3, 9, 27, -8.5],
    [0.001, 0.002, 0.0005],
  ];
  for (const arr of datasets) {
    assert.strictEqual(std(arr, 0), levvolStdInline(arr), `std(arr, ddof=0) === levvol.js:37-42 std() inline`);
    const inl = positionMeanSdInline(arr);
    assert.strictEqual(mean(arr), inl.mean, `mean(arr) === position.js:107 inline mean`);
    assert.strictEqual(std(arr, 0), inl.sd, `std(arr, ddof=0) === position.js:108 inline sd`);
  }
  pass("mean()/std(arr,0) equal levvol.js:37-42 std() and position.js:107-108 inline mean/sd (ddof=0/population) across 4 datasets");

  note("kelly.js:49-72 rollingMuSigma2 (ddof=1)", "OUT of P0 scope per spec — it's a rolling, *252-annualized variant, not a plain mean/std over a static array; std(arr,1) is verified only against hand-computed expected values below, not against kelly.js");

  // ddof=1 (sample variance) — no tab-inline non-rolling site uses this; verify
  // against hand-computed expected value only (numpy-style sample std).
  const arr1 = [2, 4, 4, 4, 5, 5, 7, 9]; // classic textbook example: population std=2, sample std=2*sqrt(8/7)
  const popStd = std(arr1, 0);
  const sampleStd = std(arr1, 1);
  assert.strictEqual(popStd, 2);
  assert.ok(Math.abs(sampleStd - 2 * Math.sqrt(8 / 7)) < 1e-9, "std(arr,1) sample variance /(n-1), hand-computed");
  pass("std(arr, ddof=1) matches hand-computed sample-variance expected value (numpy ddof=1 semantics; no non-rolling tab site to compare against)");

  // zscore
  const z = zscore(arr1, 0);
  const m1 = mean(arr1);
  for (let i = 0; i < arr1.length; i++) {
    assert.ok(Math.abs(z[i] - (arr1[i] - m1) / popStd) < 1e-12, `zscore[${i}] matches (x-mean)/std`);
  }
  pass("zscore(arr, ddof) matches (arr - mean)/std elementwise (no tab-inline site uses zscore; new canonical, hand-verified)");
}

// ═══════════════════════════════════════════════════════════════════════
// data.js — fetchJSON
// ═══════════════════════════════════════════════════════════════════════
{
  const realFetch = globalThis.fetch;

  // {data:[...]} shape (majority convention — e.g. wkrev.js:319-320, struct.js:31-32, sector.js:229-230)
  globalThis.fetch = async (url, opts) => {
    assert.strictEqual(opts.cache, "no-cache", "fetchJSON must pass {cache:'no-cache'}");
    return { ok: true, status: 200, json: async () => ({ data: [{ date: "2026-01-01", close: 1 }] }) };
  };
  const r1 = await fetchJSON("dummy1.json");
  assert.deepStrictEqual(r1, [{ date: "2026-01-01", close: 1 }]);
  pass("fetchJSON unwraps {data:[...]} shape (majority convention across ~46 fetch sites)");

  // bare array/object shape (no .data key — falls back to raw j)
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ([1, 2, 3]) });
  const r2 = await fetchJSON("dummy2.json");
  assert.deepStrictEqual(r2, [1, 2, 3]);
  pass("fetchJSON falls back to raw payload when no .data key present (e.g. relstrength.js: payload=j style)");

  // HTTP non-ok → throws
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  await assert.rejects(() => fetchJSON("dummy3.json"), /HTTP 404/, "fetchJSON throws on non-ok response");
  pass("fetchJSON throws on non-ok HTTP response");

  globalThis.fetch = realFetch;
}

console.log(`\n${passCount} assertion blocks passed. See NOTE lines above for divergences documented per spec 鐵則 #2.`);
