// 金融壓力指數 tab — 美國 OFR Financial Stress Index（仿 MacroMicro）
//   上 grid: OFR FSI 總分 + MA20/50/200 + 零軸；可疊 S&P 500（log 右軸）
//   下 grid: 五大細項貢獻 堆疊面積（信用/股票估值/安全資產/資金/波動性），加總＝總分
//
// 資料 data/fsi.json（fetch_fsi.py 抓 financialresearch.gov，每日 2000+，免 key）。
// MA 全前端 rolling 計算。0＝各變量在歷史均值；>0 風險升高、<0 穩定。
// 定位「環境理解 / 風險溫度計」非交易訊號。

import { isLight, tc, mob } from '../utils/theme.js';

const COMPS = [
  { key: "credit",  name: "信用",         color: "#f85149" },
  { key: "equity",  name: "股票估值",     color: "#d2a8ff" },
  { key: "safe",    name: "安全資產",     color: "#58a6ff" },
  { key: "funding", name: "資金/流動性",  color: "#e3b341" },
  { key: "vol",     name: "波動性",       color: "#2dd4bf" },
];
const PERIODS  = [20, 50, 200];
const MA_COLOR = { 20: "#58a6ff", 50: "#e3b341", 200: "#f85149" };
const MA_NAME  = { 20: "MA20", 50: "MA50", 200: "MA200" };
const SP_COLOR = "#f778ba";

let fsiChart = null;
let fsiRange = "10Y";
let showSP   = true;
let rows     = null;   // [{date, fsi, credit, …, ma20, ma50, ma200}]
let sp       = null;   // [[date, close]]

// ── load + compute MA (rolling mean of the headline FSI) ─────────────
async function loadAll() {
  if (rows) return;
  const fetchJson = async (path, optional = false) => {
    try {
      const r = await fetch(path, { cache: "no-cache" });
      if (!r.ok) { if (optional) return null; throw new Error(`${path}: HTTP ${r.status}`); }
      return await r.json();
    } catch (e) { if (optional) return null; throw e; }
  };
  const [fsiJson, spJson] = await Promise.all([
    fetchJson("data/fsi.json"),
    fetchJson("data/SP500.json", true),
  ]);
  rows = (fsiJson?.data ?? []).map(r => ({ ...r }));
  computeMA(rows);
  sp = (spJson?.data ?? []).map(r => [r.date, r.close]);
}

function computeMA(rs) {
  const n = rs.length;
  for (const p of PERIODS) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += rs[i].fsi;
      if (i >= p) sum -= rs[i - p].fsi;
      if (i >= p - 1) rs[i][`ma${p}`] = sum / p;
    }
  }
}

function rangeCutoff(key) {
  if (key === "MAX") return "0000-00-00";
  const d = new Date();
  ({ "1Y": 1, "3Y": 3, "5Y": 5, "10Y": 10 }[key] || 10) &&
    d.setFullYear(d.getFullYear() - ({ "1Y": 1, "3Y": 3, "5Y": 5, "10Y": 10 }[key] || 10));
  return d.toISOString().slice(0, 10);
}

// ── readout cards ────────────────────────────────────────────────────
function setText(id, txt, color) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = txt;
  if (color) el.style.color = color;
}

function updateCards() {
  const last = rows[rows.length - 1];
  // 1. level
  let lSig, lClr;
  if      (last.fsi >= 5)  { lSig = "高壓力 · 風險明顯升高"; lClr = "#f85149"; }
  else if (last.fsi >= 0)  { lSig = "壓力高於常態";          lClr = "#f0883e"; }
  else if (last.fsi >= -2) { lSig = "低於常態 · 大致穩定";   lClr = "#3fb950"; }
  else                     { lSig = "明顯低於常態 · 寬鬆";   lClr = "#3fb950"; }
  setText("fsi-level-val", (last.fsi >= 0 ? "+" : "") + last.fsi.toFixed(2), tc("#e6edf3", "#1f2328"));
  setText("fsi-level-sub", `${last.date}｜0＝歷史均值`, "var(--muted)");
  setText("fsi-level-signal", lSig, lClr);

  // 2. trend — FSI vs MA50 + MA20/MA50 cross
  const above50 = last.ma50 != null && last.fsi > last.ma50;
  const cross   = last.ma20 != null && last.ma50 != null
    ? (last.ma20 > last.ma50 ? "MA20 在 MA50 之上" : "MA20 在 MA50 之下") : "—";
  let tVal, tSig, tClr;
  if (last.ma50 == null) { tVal = "—"; tSig = "—"; tClr = "var(--muted)"; }
  else if (above50)      { tVal = "▲ 壓力累積中"; tSig = `高於季均（${cross}）`; tClr = "#f0883e"; }
  else                   { tVal = "▼ 壓力消退中"; tSig = `低於季均（${cross}）`; tClr = "#3fb950"; }
  setText("fsi-trend-val", tVal, tClr);
  setText("fsi-trend-sub", last.ma50 != null ? `MA50 ${last.ma50.toFixed(2)}｜MA200 ${last.ma200?.toFixed(2) ?? "—"}` : "—", "var(--muted)");
  setText("fsi-trend-signal", tSig, tClr);

  // 3. top driver — largest positive contribution (or least-negative)
  const drv = COMPS.map(c => ({ name: c.name, v: last[c.key], color: c.color }))
                   .sort((a, b) => b.v - a.v);
  const top = drv[0];
  setText("fsi-driver-val", top.name, top.color);
  setText("fsi-driver-sub", `貢獻 ${top.v >= 0 ? "+" : ""}${top.v.toFixed(2)}｜最低 ${drv[drv.length - 1].name} ${drv[drv.length - 1].v.toFixed(2)}`, "var(--muted)");
  setText("fsi-driver-signal", top.v >= 0 ? "目前最大壓力來源" : "各面向均低於均值", top.v >= 0 ? "#f0883e" : "#3fb950");
}

// ── render ───────────────────────────────────────────────────────────
export function render() {
  if (!fsiChart || !rows) return;
  const axisClr = tc("#8b949e", "#57606a");
  const gridClr = tc("rgba(48,54,61,0.5)", "rgba(208,215,222,0.4)");
  const tipBg   = tc("#161b22", "#ffffff");
  const tipBdr  = tc("#30363d", "#d0d7de");
  const textClr = tc("#c9d1d9", "#24292f");

  updateCards();

  const cutoff = rangeCutoff(fsiRange);
  const view   = rows.filter(r => r.date >= cutoff);
  const dates  = view.map(r => r.date);
  const fsiLine = view.map(r => +r.fsi.toFixed(3));
  const maData  = Object.fromEntries(PERIODS.map(p =>
                    [p, view.map(r => r[`ma${p}`] != null ? +r[`ma${p}`].toFixed(3) : null)]));
  const compData = Object.fromEntries(COMPS.map(c =>
                    [c.key, view.map(r => +r[c.key].toFixed(3))]));

  // S&P overlay aligned to FSI dates (forward-fill not needed; both daily, inner-join by lookup)
  let spData = null;
  if (showSP && sp?.length) {
    const m = new Map(sp);
    spData = dates.map(d => (m.has(d) ? +m.get(d).toFixed(2) : null));
  }

  const status = document.getElementById("fsi-status");
  if (status) status.textContent =
    `OFR 金融壓力指數 · ${dates.length} 個交易日（${fsiRange}）· 總分＋五細項＋20/50/200日均線 · 來源 financialresearch.gov`;

  const L = mob() ? 40 : 52, R = showSP ? (mob() ? 46 : 60) : (mob() ? 16 : 28);
  // two stacked grids, each with its OWN legend directly above it (總分+均線 上 / 細項 下)
  const grid = [
    { left: L, right: R, top: "9%",  height: mob() ? "36%" : "39%" },
    { left: L, right: R, top: "63%", height: mob() ? "23%" : "25%" },
  ];
  const xAxis = grid.map((_, i) => ({
    gridIndex: i, type: "category", data: dates, boundaryGap: false,
    axisLine: { lineStyle: { color: axisClr } }, axisTick: { show: false },
    axisLabel: { show: i === 1, color: axisClr, fontSize: 11 },
    splitLine: { show: false },
  }));

  const yAxis = [
    { gridIndex: 0, scale: true, name: "FSI", nameTextStyle: { color: axisClr, fontSize: 10 },
      axisLabel: { color: axisClr, fontSize: 11 }, axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: gridClr } } },
  ];
  let spAxisIdx = -1;
  if (showSP && spData) {
    spAxisIdx = yAxis.length;
    yAxis.push({ gridIndex: 0, type: "log", scale: true, position: "right",
      name: "S&P500", nameTextStyle: { color: SP_COLOR, fontSize: 10 },
      axisLine: { lineStyle: { color: SP_COLOR } },
      axisLabel: { color: SP_COLOR, fontSize: 10, formatter: v => v >= 1000 ? (v / 1000).toFixed(0) + "K" : v },
      splitLine: { show: false } });
  }
  const compAxisIdx = yAxis.length;
  yAxis.push({ gridIndex: 1, scale: true, name: "細項貢獻", nameTextStyle: { color: axisClr, fontSize: 10 },
    axisLabel: { color: axisClr, fontSize: 10 }, axisLine: { show: false }, axisTick: { show: false },
    splitLine: { lineStyle: { color: gridClr } },
    markLine: { silent: true, symbol: "none",
      data: [{ yAxis: 0, lineStyle: { color: axisClr, type: "solid", width: 1, opacity: 0.4 } }] } });

  // top grid markLines: zero baseline + stress zones
  const zeroMark = {
    silent: true, symbol: "none",
    data: [
      { yAxis: 0, lineStyle: { color: axisClr, type: "solid", width: 1, opacity: 0.5 },
        label: { formatter: "0 歷史均值", color: axisClr, fontSize: 10, position: "insideEndTop" } },
      { yAxis: 5, lineStyle: { color: "#f85149", type: "dashed", width: 1, opacity: 0.5 },
        label: { formatter: "壓力升高", color: "#f85149", fontSize: 9, position: "insideEndTop" } },
    ],
  };

  const maSeries = PERIODS.map(p => ({
    name: MA_NAME[p], type: "line", xAxisIndex: 0, yAxisIndex: 0, data: maData[p],
    symbol: "none", smooth: false, z: 3, itemStyle: { color: MA_COLOR[p] },
    lineStyle: { color: MA_COLOR[p], width: 1.2, opacity: 0.85 },
  }));

  // 細項：五條獨立線（不堆疊），看每個面向各自走勢
  const compSeries = COMPS.map(c => ({
    name: c.name, type: "line", xAxisIndex: 1, yAxisIndex: compAxisIdx,
    data: compData[c.key], symbol: "none", smooth: false, connectNulls: true,
    itemStyle: { color: c.color }, lineStyle: { color: c.color, width: 1.3 },
    emphasis: { focus: "series" },
  }));

  const fsiColor = tc("#e6edf3", "#1f2328");
  const series = [
    { name: "FSI 總分", type: "line", xAxisIndex: 0, yAxisIndex: 0, data: fsiLine,
      symbol: "none", smooth: false, z: 5, itemStyle: { color: fsiColor },
      lineStyle: { color: fsiColor, width: 1.8 },
      markLine: zeroMark },
    ...maSeries,
    ...compSeries,
  ];
  if (showSP && spData) {
    series.splice(1, 0, { name: "S&P 500", type: "line", xAxisIndex: 0, yAxisIndex: spAxisIdx,
      data: spData, symbol: "none", smooth: false, z: 2, connectNulls: true,
      itemStyle: { color: SP_COLOR },
      lineStyle: { color: SP_COLOR, width: 1.3, opacity: 0.8 } });
  }

  const topLegend  = ["FSI 總分", ...(showSP ? ["S&P 500"] : []), ...PERIODS.map(p => MA_NAME[p])];
  const compLegend = COMPS.map(c => c.name);

  fsiChart.setOption({
    backgroundColor: "transparent", animation: false,
    tooltip: {
      trigger: "axis", axisPointer: { type: "cross", link: [{ xAxisIndex: "all" }] },
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        const d = params[0]?.axisValue ?? "";
        let html = `<div style="font-weight:600;margin-bottom:4px">${d}</div>`;
        for (const p of params) {
          if (p.value == null) continue;
          const v = p.seriesName === "S&P 500" ? (+p.value).toFixed(0) : (+p.value).toFixed(2);
          html += `<div>${p.marker}${p.seriesName}: <b>${v}</b></div>`;
        }
        return html;
      },
    },
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    grid, xAxis, yAxis,
    dataZoom: [{ type: "inside", xAxisIndex: [0, 1], filterMode: "none" }],
    legend: [
      { data: topLegend,  top: 2,     left: "center", textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr },
      { data: compLegend, top: "53%", left: "center", textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr },
    ],
    series,
  }, { notMerge: true });
}

// ── controls ─────────────────────────────────────────────────────────
function buildControls() {
  const rp = document.getElementById("fsi-range-picker");
  if (rp && !rp.dataset.built) {
    rp.dataset.built = "1";
    rp.addEventListener("click", e => {
      const t = e.target.closest(".chip[data-fsi-range]");
      if (!t) return;
      fsiRange = t.dataset.fsiRange;
      rp.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c === t));
      render();
    });
  }
  const sb = document.getElementById("fsi-sp-toggle");
  if (sb && !sb.dataset.built) {
    sb.dataset.built = "1";
    sb.addEventListener("click", () => {
      showSP = !showSP;
      sb.classList.toggle("active", showSP);
      render();
    });
  }
}

// ── lifecycle ────────────────────────────────────────────────────────
export async function activate() {
  const host = document.getElementById("fsi-chart");
  if (!host) return;
  if (!fsiChart) fsiChart = echarts.init(host, isLight() ? null : "dark");
  buildControls();
  try {
    await loadAll();
    setTimeout(() => { fsiChart?.resize(); render(); }, 50);
  } catch (e) {
    const s = document.getElementById("fsi-status");
    if (s) s.textContent = "載入失敗：" + (e.message || e);
    console.error("[fsi] load failed", e);
  }
}
export function onThemeChange(light) {
  if (!fsiChart) return;
  fsiChart.dispose();
  fsiChart = echarts.init(document.getElementById("fsi-chart"), light ? null : "dark");
  if (rows) render();
}
export function resize() { fsiChart?.resize(); }
