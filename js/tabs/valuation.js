// 估值 tab — 多標的 Forward / Trailing P/E
//   上 grid: 收盤價
//   下 grid: Forward PE (藍) + Trailing PE (橘)，per-ticker 參考線
//   標的: SPY/VOO · QQQ · SOXX · 0050 · MAGS(七巨頭)
//
// 資料來源（能撈多遠撈多遠）：
//   forward — <TICKER>_valuation.json 的 fpe（成分股加權，含歷史估計 seed）
//   trailing — SPY 用 SP500_PE.json(multpl, 1871起) / 0050 用 TWSE / 其餘用 ETF trailingPE 每日累積

import { loaded } from '../state.js';
import { isLight, tc } from '../utils/theme.js';
import { ensureLoaded } from '../utils/data.js';

// ── Per-ticker config ──────────────────────────────────────────────
// 每個來源附 real（實際值算法）/ est（估計值依據），供 tooltip 標明「用什麼算的」
const VAL_TICKERS = [
  {
    key: "SPY", label: "SPY / VOO", priceKey: "SPY", priceLabel: "SPY", color: "#a371f7",
    fwd:   { file: "data/SPY_valuation.json", field: "fpe", real: "前20大持股加權 forwardPE", est: "FactSet/Yardeni 公開 forward PE" },
    trail: { file: "data/SP500_PE.json",      field: "pe",  real: "multpl S&P500 實際本益比", est: "—" },
    refs: [ { v: 21, t: "21x 偏貴", c: "#f0883e" }, { v: 17, t: "17x 長均", c: "#3fb950" } ],
  },
  {
    key: "QQQ", label: "QQQ", priceKey: "QQQ", priceLabel: "QQQ", color: "#f778ba",
    fwd:   { file: "data/QQQ_valuation.json", field: "fpe", real: "前10大持股加權 forwardPE(排除>60x)", est: "Nasdaq-100 公開分析值" },
    trail: { file: "data/QQQ_valuation.json", field: "tpe", real: "QQQ ETF 實際 trailingPE", est: "歷史 Nasdaq-100 trailing 估計" },
    refs: [ { v: 21, t: "21x 底部帶", c: "#f0883e" }, { v: 20, t: "20x 熊底", c: "#ef4444" } ],
  },
  {
    key: "SOXX", label: "SOXX 半導體", priceKey: "SOXX", priceLabel: "SOXX", color: "#22d3ee",
    fwd:   { file: "data/SOXX_valuation.json", field: "fpe", real: "前20大持股加權 forwardPE", est: "FactSet/Bloomberg 半導體報告" },
    trail: { file: "data/SOXX_valuation.json", field: "tpe", real: "SOXX ETF 實際 trailingPE", est: "半導體產業 trailing 估計" },
    refs: [ { v: 20, t: "20x", c: "#f0883e" }, { v: 14, t: "14x 熊底", c: "#ef4444" } ],
  },
  {
    key: "TWII", label: "台指 大盤", priceLabel: "台指", priceFile: "data/TWII.json", color: "#3fb950",
    fwd:   { file: "data/TW_valuation.json", field: "fpe", real: "實際未來4季EPS回推(後見)／近期成分股 forwardPE", est: "—" },
    trail: { file: "data/TW_valuation.json", field: "tpe", real: "FinMind 大型股 PER 加權（大盤代理）", est: "—" },
    refs: [ { v: 18, t: "18x", c: "#f0883e" }, { v: 12, t: "12x 熊底", c: "#ef4444" } ],
  },
  {
    key: "MAGS", label: "MAGS 七巨頭", priceKey: "MAGS", priceLabel: "MAGS", color: "#ff6b6b",
    fwd:   { file: "data/MAGS_valuation.json", field: "fpe", real: "七巨頭等權 forwardPE(排除TSLA離群)", est: "七巨頭等權估計" },
    trail: { file: "data/MAGS_valuation.json", field: "tpe", real: "七巨頭等權 trailingPE(排除TSLA離群)", est: "七巨頭等權估計" },
    refs: [ { v: 28, t: "28x", c: "#f0883e" }, { v: 20, t: "20x", c: "#3fb950" } ],
  },
];

const FWD_COLOR = "#58a6ff";   // forward 藍
const TRL_COLOR = "#f0883e";   // trailing 橘

// 台股景氣對策信號（國發會）— 只在 0050 多加一層
const BIZ_FILE = "data/taiwan_business_signal.json";
// 燈號分數區間 [下限, 上限, 顏色, 名稱]（顏色用於折線分段 + 背景帶）
const BIZ_ZONES = [
  { lo: 38, hi: 45, c: "#cc3333", name: "紅燈 · 熱絡" },
  { lo: 32, hi: 38, c: "#e6912c", name: "黃紅燈 · 轉熱" },
  { lo: 23, hi: 32, c: "#3fae5a", name: "綠燈 · 穩定" },
  { lo: 17, hi: 23, c: "#5b9bd5", name: "黃藍燈 · 轉冷" },
  { lo:  5, hi: 17, c: "#2f6fb0", name: "藍燈 · 低迷" },
];
function bizLightOf(score) {
  return BIZ_ZONES.find(z => score >= z.lo && score < z.hi) || BIZ_ZONES[0];
}
// 指數(~45000)用千分位整數、個股/ETF用兩位小數
function fmtPrice(v) {
  return v >= 1000 ? Math.round(v).toLocaleString("en-US") : (+v).toFixed(2);
}

let valChart  = null;
let valTicker = "SPY";
let valRange  = "5Y";
const fileCache = {};   // path -> data array

// ── Data loading ───────────────────────────────────────────────────
async function loadFile(path) {
  if (fileCache[path]) return fileCache[path];
  const r = await fetch(path, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  const j = await r.json();
  fileCache[path] = (j.data || []).slice().sort((a, b) => a.date < b.date ? -1 : 1);
  return fileCache[path];
}

// pull a sparse [{date, <field>}] -> dense daily [[date, val]] via linear interp
function buildSeries(rows, field) {
  const pts = (rows || [])
    .filter(r => r[field] != null && isFinite(r[field]))
    .map(r => ({ date: r.date, v: +r[field] }));
  if (pts.length === 0) return [];
  if (pts.length === 1) return [[pts[0].date, pts[0].v]];
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const t1 = new Date(pts[i].date + "T00:00:00Z").getTime();
    const t2 = new Date(pts[i + 1].date + "T00:00:00Z").getTime();
    const v1 = pts[i].v, v2 = pts[i + 1].v;
    const gap = Math.round((t2 - t1) / 86400000);
    if (gap <= 1) { out.push([pts[i].date, v1]); continue; }
    for (let j = 0; j < gap; j++) {
      const d = new Date(t1 + j * 86400000).toISOString().slice(0, 10);
      out.push([d, +(v1 + (v2 - v1) * (j / gap)).toFixed(3)]);
    }
  }
  out.push([pts[pts.length - 1].date, pts[pts.length - 1].v]);
  return out;
}

function rangeStartDate(key, minDate) {
  if (key === "MAX") return minDate || "1900-01-01";
  const d = new Date();
  ({ "3Y": () => d.setFullYear(d.getFullYear() - 3),
     "5Y": () => d.setFullYear(d.getFullYear() - 5),
    "10Y": () => d.setFullYear(d.getFullYear() - 10),
    "20Y": () => d.setFullYear(d.getFullYear() - 20) })[key]?.();
  return d.toISOString().slice(0, 10);
}

function cfg() { return VAL_TICKERS.find(t => t.key === valTicker) || VAL_TICKERS[0]; }

// 找出「實際計算值」從哪一天起（src 非 seed）。回傳分界日：
//   "0000" → 全部實際（如 multpl SP500_PE 無 src）
//   "9999" → 全部估計（只有 seed）
//   其他   → 該日(含)起為實際，之前為估計
function realFromDate(rows, field) {
  if (!rows || !rows.length) return "9999";
  const hasSrc = rows.some(r => r.src !== undefined);
  if (!hasSrc) return "0000";
  const real = rows.find(r => r[field] != null && r.src && r.src !== "seed");
  return real ? real.date : "9999";
}
// tooltip 用：記住目前各線的實際分界日
let peRealFrom = { fwd: "0000", trl: "0000" };

// ── Render ─────────────────────────────────────────────────────────
function render(price, fwdFull, trlFull, bizRows, realFrom) {
  if (!valChart) return;
  const t = cfg();
  const BIZ_NAME = "景氣對策信號";
  const showBiz = t.key === "TWII" && bizRows && bizRows.length > 0;
  peRealFrom = realFrom || { fwd: "0000", trl: "0000" };

  const axisClr = tc("#8b949e", "#57606a");
  const gridClr = tc("#21262d", "#e1e4e8");
  const tipBg   = tc("#161b22", "#ffffff");
  const tipBdr  = tc("#30363d", "#d0d7de");
  const textClr = tc("#c9d1d9", "#24292f");

  // overall data span (for MAX) and display window
  const spanArrs = [price, fwdFull, trlFull].filter(a => a && a.length);
  const minDate = spanArrs.map(a => a[0][0]).sort()[0];
  const from = rangeStartDate(valRange, minDate);
  const to = spanArrs.map(a => a[a.length - 1][0]).sort().at(-1);

  const clip = a => (a || []).filter(r => r[0] >= from);
  const priceD = clip(price), fwdD = clip(fwdFull), trlD = clip(trlFull);
  const bizD = showBiz ? bizRows.filter(r => r.date >= from).map(r => [r.date, r.score]) : [];

  // status label
  const last = a => a.length ? a[a.length - 1][1] : null;
  const lf = last(fwdD), lt = last(trlD), lp = last(priceD);
  const statusEl = document.getElementById("val-status");
  if (statusEl) {
    const parts = [`${t.label}`];
    if (lp != null) parts.push(`價 ${fmtPrice(+lp)}`);
    if (lf != null) parts.push(`Fwd PE ${lf.toFixed(1)}x`);
    if (lt != null) parts.push(`Trail PE ${lt.toFixed(1)}x`);
    if (lf != null && lt != null) parts.push(`折讓 ${((1 - lf / lt) * 100).toFixed(0)}%`);
    if (showBiz) { const b = bizRows[bizRows.length - 1]; parts.push(`景氣 ${b.score} ${b.light}燈`); }
    statusEl.textContent = parts.join(" · ");
  }

  // dynamic 2-grid (price + PE) or 3-grid (+ 景氣燈號 for 0050)
  const L = 64, R = 18;
  const grid = showBiz
    ? [ { left: L, right: R, top: "4%",  height: "27%" },
        { left: L, right: R, top: "39%", height: "24%" },
        { left: L, right: R, top: "71%", height: "15%" } ]
    : [ { left: L, right: R, top: "4%",  height: "44%" },
        { left: L, right: R, top: "56%", height: "34%" } ];
  const lastGrid = grid.length - 1;
  const bizGridIdx = showBiz ? 2 : -1;

  const xAxis = grid.map((_, i) => ({
    gridIndex: i, type: "time", min: from, max: to,
    axisLabel: { show: i === lastGrid, color: axisClr, fontSize: 11 },
    axisLine: { lineStyle: { color: axisClr } }, splitLine: { lineStyle: { color: gridClr } },
  }));

  const yAxis = [
    { gridIndex: 0, name: t.priceLabel, nameTextStyle: { color: axisClr, fontSize: 11 }, scale: true,
      axisLabel: { color: axisClr, fontSize: 11 },
      axisLine: { lineStyle: { color: axisClr } }, splitLine: { lineStyle: { color: gridClr } } },
    { gridIndex: 1, name: "P/E", nameTextStyle: { color: axisClr, fontSize: 11 },
      axisLabel: { color: axisClr, fontSize: 11, formatter: v => `${v}x` },
      axisLine: { lineStyle: { color: axisClr } }, splitLine: { lineStyle: { color: gridClr } },
      min: v => Math.max(0, Math.floor(v.min - 1)), max: v => Math.ceil(v.max + 1) },
  ];
  if (showBiz) yAxis.push({
    gridIndex: 2, name: "景氣分數", nameTextStyle: { color: axisClr, fontSize: 11 },
    min: 5, max: 45, interval: 10,
    axisLabel: { color: axisClr, fontSize: 10 },
    axisLine: { lineStyle: { color: axisClr } }, splitLine: { show: false },
  });

  // split a dense series into 估計(虛線淡) + 實際(實線) at the realFrom boundary
  const pePair = (name, dense, color, z, rf) => {
    const est  = dense.filter(p => p[0] <  rf);
    const real = dense.filter(p => p[0] >= rf);
    const out = [];
    if (est.length) out.push({
      name, type: "line", xAxisIndex: 1, yAxisIndex: 1, data: est, z,
      lineStyle: { color, width: 1.6, type: "dashed", opacity: 0.5 },
      itemStyle: { color, opacity: 0.5 }, symbol: "none",
    });
    if (real.length) out.push({
      name, type: "line", xAxisIndex: 1, yAxisIndex: 1, data: real, z,
      lineStyle: { color, width: 1.8 }, itemStyle: { color },
      showSymbol: real.length < 8, symbol: "circle", symbolSize: 5,
    });
    return out;
  };

  const series = [
    { name: t.priceLabel, type: "line", xAxisIndex: 0, yAxisIndex: 0, data: priceD,
      lineStyle: { color: t.color, width: 1.6 }, itemStyle: { color: t.color }, symbol: "none", z: 3 },
  ];
  if (fwdD.length) series.push(...pePair("Forward PE", fwdD, FWD_COLOR, 3, peRealFrom.fwd));
  if (trlD.length) series.push(...pePair("Trailing PE", trlD, TRL_COLOR, 2, peRealFrom.trl));
  series.push({   // PE reference levels
    name: "_ref", type: "line", xAxisIndex: 1, yAxisIndex: 1, data: [], symbol: "none",
    markLine: {
      silent: true, symbol: "none", lineStyle: { type: "dashed", width: 1 }, label: { fontSize: 10 },
      data: t.refs.map(r => ({ yAxis: r.v, lineStyle: { color: r.c },
        label: { formatter: r.t, color: r.c, position: "insideEndTop" } })),
    },
  });

  let bizSeriesIdx = -1;
  if (showBiz) {
    bizSeriesIdx = series.length;
    series.push({
      name: BIZ_NAME, type: "line", xAxisIndex: bizGridIdx, yAxisIndex: 2, data: bizD,
      lineStyle: { width: 2 }, symbol: "circle", symbolSize: 3, z: 3,
      markArea: {   // faint background bands for the 5 light zones
        silent: true,
        data: BIZ_ZONES.map(zn => [
          { yAxis: zn.lo, itemStyle: { color: zn.c, opacity: 0.12 } }, { yAxis: zn.hi },
        ]),
      },
    });
  }

  const legendData = [
    t.priceLabel,
    ...(fwdD.length ? ["Forward PE"] : []),
    ...(trlD.length ? ["Trailing PE"] : []),
    ...(showBiz ? [BIZ_NAME] : []),
  ];

  const option = {
    backgroundColor: "transparent", animation: false,
    tooltip: {
      trigger: "axis", axisPointer: { type: "cross", link: [{ xAxisIndex: "all" }] },
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        const date = params[0]?.axisValue ?? "";
        const ds = typeof date === "number" ? new Date(date).toISOString().slice(0, 10) : date;
        let html = `<div style="font-weight:600;margin-bottom:4px">${ds}</div>`;
        const seen = new Set();
        for (const p of params) {
          const val = Array.isArray(p.value) ? p.value[1] : p.value;
          if (val == null || seen.has(p.seriesName)) continue;
          seen.add(p.seriesName);
          let f;
          if (p.seriesName === BIZ_NAME) {
            f = `${Math.round(+val)} 分（${bizLightOf(+val).name}）`;
          } else if (p.seriesName === t.priceLabel) {
            f = fmtPrice(+val);
          } else {
            const isFwd = p.seriesName === "Forward PE";
            const srcCfg = isFwd ? t.fwd : t.trail;
            const rf = isFwd ? peRealFrom.fwd : peRealFrom.trl;
            const est = ds < rf;
            const tag = est ? "<span style='color:#8b949e'>估計</span>" : "<span style='color:#3fb950'>實際</span>";
            const basis = srcCfg ? (est ? srcCfg.est : srcCfg.real) : "";
            f = `${(+val).toFixed(2)}x ${tag}`
              + (basis && basis !== "—" ? `<span style='color:#8b949e;font-size:11px'> · ${basis}</span>` : "");
          }
          html += `<div>${p.marker}${p.seriesName}: <b>${f}</b></div>`;
        }
        return html;
      },
    },
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    grid, xAxis, yAxis,
    dataZoom: [{ type: "inside", xAxisIndex: grid.map((_, i) => i), filterMode: "none" }],
    legend: { data: legendData, top: "bottom", textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr },
    series,
  };
  // colour the 景氣 line by its light zone
  if (showBiz && bizSeriesIdx >= 0) {
    option.visualMap = {
      show: false, type: "piecewise", seriesIndex: bizSeriesIdx, dimension: 1,
      pieces: BIZ_ZONES.map(zn => ({ gte: zn.lo, lt: zn.hi, color: zn.c })),
    };
  }

  valChart.setOption(option, { notMerge: true });
}

async function refresh() {
  const t = cfg();
  const statusEl = document.getElementById("val-status");
  const showBiz = t.key === "TWII";
  try {
    let price;
    if (t.priceFile) {                       // index served from its own file (not in SERIES)
      const rows = await loadFile(t.priceFile);
      price = rows.map(r => [r.date, r.close ?? r.value]);
    } else {
      await ensureLoaded(t.priceKey);
      price = (loaded[t.priceKey] || []).slice();
    }
    const [fwdRows, trlRows, bizRows] = await Promise.all([
      t.fwd   ? loadFile(t.fwd.file)   : Promise.resolve(null),
      t.trail ? loadFile(t.trail.file) : Promise.resolve(null),
      showBiz ? loadFile(BIZ_FILE).catch(() => null) : Promise.resolve(null),
    ]);
    const fwd = t.fwd   ? buildSeries(fwdRows, t.fwd.field)   : [];
    const trl = t.trail ? buildSeries(trlRows, t.trail.field) : [];
    const realFrom = {
      fwd: t.fwd   ? realFromDate(fwdRows, t.fwd.field)   : "9999",
      trl: t.trail ? realFromDate(trlRows, t.trail.field) : "9999",
    };
    render(price, fwd, trl, bizRows, realFrom);
  } catch (e) {
    if (statusEl) statusEl.textContent = `載入失敗：${e.message}`;
  }
}

// ── Lifecycle ──────────────────────────────────────────────────────
export async function activate() {
  const container = document.getElementById("val-chart");
  if (!container) return;
  if (!valChart) valChart = echarts.init(container, null, { renderer: "canvas" });
  renderTickerPicker();
  await refresh();
}

export function onThemeChange() { if (valChart) refresh(); }
export function resize() { valChart?.resize(); }

export function setRange(key) { valRange = key; refresh(); }
export function setTicker(key) { valTicker = key; refresh(); }

// build the ticker chip row (idempotent)
function renderTickerPicker() {
  const host = document.getElementById("val-ticker-picker");
  if (!host || host.dataset.built) return;
  host.innerHTML = VAL_TICKERS.map(t =>
    `<span class="chip${t.key === valTicker ? " active" : ""}" data-val-ticker="${t.key}">${t.label}</span>`
  ).join("");
  host.dataset.built = "1";
  host.querySelectorAll(".chip").forEach(chip =>
    chip.addEventListener("click", () => {
      host.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      setTicker(chip.dataset.valTicker);
    })
  );
}
