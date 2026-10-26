// Theme helpers — read body class, return theme-conditional values.
// applyTheme() (which has to re-init all chart instances on toggle) lives in
// boot.js for now; it will move out alongside the switcher in a later step.

export function isLight() {
  return document.body.classList.contains("light");
}

export function tc(dark, light) {
  return isLight() ? light : dark;
}

/** 灰色主題（body.dim）：深灰底，圖表沿用深色配色，只有底色相關的幾個 PALETTE 值換成較亮的灰。 */
export function isDim() {
  return document.body.classList.contains("dim");
}
const dimOr = (dim, dark, light) => (isLight() ? light : isDim() ? dim : dark);

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
// 灰色主題：格線／邊框／tooltip 底色要比深灰底（#22272e）亮，否則黑色主題的值放上去會看不見。
export const PALETTE = {
  get muted()      { return dimOr("#909dab", "#8b949e", "#57606a"); },
  get border()     { return dimOr("#444c56", "#30363d", "#d0d7de"); },
  get bg()         { return dimOr("#2d333b", "#161b22", "#ffffff"); },
  get text()       { return dimOr("#cdd9e5", "#e6edf3", "#1f2328"); },
  get text2()      { return dimOr("#adbac7", "#c9d1d9", "#24292f"); },
  get grid()       { return dimOr("#373e47", "#21262d", "#e1e4e8"); },
  get cellBorder() { return dimOr("#22272e", "#0d1117", "#ffffff"); },
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
