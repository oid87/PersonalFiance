// Theme helpers — read body class, return theme-conditional values.
// applyTheme() (which has to re-init all chart instances on toggle) lives in
// boot.js for now; it will move out alongside the switcher in a later step.

export function isLight() {
  return document.body.classList.contains("light");
}

export function tc(dark, light) {
  return isLight() ? light : dark;
}

export function mob() {
  return window.innerWidth < 600 || window.innerHeight < 500;
}

// ── PALETTE ──────────────────────────────────────────────────────────────
// Collapses the most common literal tc("#dark","#light") pairs repeated
// across js/tabs/*.js (grep tally 2026-07, `grep -rhoE 'tc\("#[0-9a-fA-F]{3,6}"\s*,\s*"#[0-9a-fA-F]{3,6}"\)' js/tabs/ | uniq -c | sort -rn`):
//   61x tc("#8b949e","#57606a")  → muted       (axis labels / secondary title text)
//   61x tc("#30363d","#d0d7de")  → border      (axis line / tooltip border)
//   49x tc("#161b22","#ffffff")  → bg          (tooltip background)
//   45x tc("#e6edf3","#1f2328")  → text        (tooltip / primary text)
//   26x tc("#c9d1d9","#24292f")  → text2       (secondary text, e.g. credit.js/infl_nowcast.js)
//   10x tc("#21262d","#e1e4e8")  → grid        (split line)
//    5x tc("#0d1117","#ffffff")  → cellBorder  (heatmap cell / marker border, e.g. cpi.js/sector.js)
// Deliberately a getter object (each property re-evaluates tc() on access),
// NOT a frozen snapshot — tc() depends on document.body.classList at call
// time, so freezing at module-load time would bake in whichever theme was
// active on first import and never update on theme toggle.
export const PALETTE = {
  get muted()      { return tc("#8b949e", "#57606a"); },
  get border()     { return tc("#30363d", "#d0d7de"); },
  get bg()         { return tc("#161b22", "#ffffff"); },
  get text()       { return tc("#e6edf3", "#1f2328"); },
  get text2()      { return tc("#c9d1d9", "#24292f"); },
  get grid()       { return tc("#21262d", "#e1e4e8"); },
  get cellBorder() { return tc("#0d1117", "#ffffff"); },
};

// ── echartsBase ──────────────────────────────────────────────────────────
// Common ECharts option skeleton distilled from the shared grid/tooltip/
// xAxis/yAxis/dataZoom boilerplate repeated across js/tabs/*.js (~47 sites).
// Representative sites compared for their *common* settings (2026-07):
//   - js/tabs/marginheat.js:158-184  (tooltip axis+cross, grid, category xAxis, dataZoom inside)
//   - js/tabs/bullbear.js:321-343    (tooltip axis, time xAxis, muted axis labels)
//   - js/tabs/cpi.js:190-217         (tooltip axis, grid, axisLine/splitLine colors)
// Common ground taken as defaults: tooltip.trigger="axis" + PALETTE bg/border/text,
// grid with the usual four insets, xAxis/yAxis axisLine+axisLabel in PALETTE.muted,
// yAxis splitLine in PALETTE.grid, and a dataZoom:[{type:"inside",filterMode:"none"}]
// (present in marginheat.js/cpi.js, absent in bullbear.js — kept as a default since
// overrides can delete it via `dataZoom: []` if a tab doesn't want it).
// P0 scope: NOT wired into any tab. Verified for structure + deep-merge only.
function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function deepMerge(base, overrides) {
  if (!isPlainObject(overrides)) return overrides;
  const out = { ...base };
  for (const k of Object.keys(overrides)) {
    out[k] = isPlainObject(base?.[k]) && isPlainObject(overrides[k])
      ? deepMerge(base[k], overrides[k])
      : overrides[k];
  }
  return out;
}

export function echartsBase(overrides = {}) {
  const base = {
    backgroundColor: "transparent",
    tooltip: {
      trigger: "axis",
      backgroundColor: PALETTE.bg,
      borderColor: PALETTE.border,
      textStyle: { color: PALETTE.text, fontSize: 12 },
    },
    grid: {
      left: mob() ? 44 : 56,
      right: mob() ? 16 : 24,
      top: "10%",
      bottom: "12%",
    },
    xAxis: {
      type: "category",
      axisLine: { lineStyle: { color: PALETTE.muted } },
      axisLabel: { color: PALETTE.muted, fontSize: 11 },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value",
      axisLine: { lineStyle: { color: PALETTE.muted } },
      axisLabel: { color: PALETTE.muted, fontSize: 11 },
      splitLine: { lineStyle: { color: PALETTE.grid } },
    },
    dataZoom: [{ type: "inside", filterMode: "none" }],
  };
  return deepMerge(base, overrides);
}
