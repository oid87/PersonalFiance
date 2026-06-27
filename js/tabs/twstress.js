// 台股金融壓力 tab — 台版 OFR FSI（自建，與美國 FSI tab 對稱）
//   上 grid: 綜合壓力 0-100 + MA20/50/200 + 加權指數（log 右軸）+ 25/50/75 區帶
//   下 grid: 四維壓力子指數（匯率波動/股市波動/融資斷頭/外資避險），各 0-100
//
// 資料 data/taiwan_stress.json（compute_taiwan_stress.py：4 源各取2年滾動百分位加權）。
// ⚠ 越高＝壓力越大（非反向情緒；跟「台股情緒」tab 方向相反）。缺 credit/funding 兩維。
// 定位環境理解 / 風險溫度計，非交易訊號。

import { isLight, tc, mob } from '../utils/theme.js';

const DIMS = [
  { key: "fx",      name: "匯率波動",  color: "#e3b341" },
  { key: "eqvol",   name: "股市波動",  color: "#2dd4bf" },
  { key: "margin",  name: "融資斷頭",  color: "#f85149" },
  { key: "foreign", name: "外資避險",  color: "#a371f7" },
];
const PERIODS  = [20, 50, 200];
const MA_COLOR = { 20: "#58a6ff", 50: "#e3b341", 200: "#f85149" };
const MA_NAME  = { 20: "MA20", 50: "MA50", 200: "MA200" };
const TWII_COLOR = "#f778ba";

let tsChart = null;
let tsRange = "10Y";
let showTwii = true;
let rows = null;   // [{date, twii, composite, fx, eqvol, margin, foreign, ma20, ma50, ma200}]

async function loadAll() {
  if (rows) return;
  const r = await fetch("data/taiwan_stress.json", { cache: "no-cache" });
  if (!r.ok) throw new Error(`taiwan_stress.json: HTTP ${r.status}`);
  const j = await r.json();
  rows = (j?.data ?? []).map(d => ({ ...d }));
  computeMA(rows);
}

function computeMA(rs) {
  const n = rs.length;
  for (const p of PERIODS) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += rs[i].composite;
      if (i >= p) sum -= rs[i - p].composite;
      if (i >= p - 1) rs[i][`ma${p}`] = sum / p;
    }
  }
}

function rangeCutoff(key) {
  if (key === "MAX") return "0000-00-00";
  const d = new Date();
  const yrs = { "1Y": 1, "3Y": 3, "5Y": 5, "10Y": 10 }[key] || 10;
  d.setFullYear(d.getFullYear() - yrs);
  return d.toISOString().slice(0, 10);
}

function zone(v) {
  if (v >= 75) return { sig: "高壓 · 系統性風險明顯", clr: "#f85149" };
  if (v >= 50) return { sig: "偏高 · 壓力高於中位", clr: "#f0883e" };
  if (v >= 25) return { sig: "偏低 · 大致穩定",     clr: "#3fb950" };
  return { sig: "低壓 · 風險平靜", clr: "#3fb950" };
}

function setText(id, txt, color) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = txt;
  if (color) el.style.color = color;
}

function updateCards() {
  const last = rows[rows.length - 1];
  // 1. composite level
  const z = zone(last.composite);
  setText("ts-level-val", last.composite.toFixed(0), tc("#e6edf3", "#1f2328"));
  setText("ts-level-sub", `${last.date}｜0=最平靜 100=最緊張`, "var(--muted)");
  setText("ts-level-signal", z.sig, z.clr);

  // 2. trend vs MA50
  const above50 = last.ma50 != null && last.composite > last.ma50;
  let tVal, tSig, tClr;
  if (last.ma50 == null) { tVal = "—"; tSig = "—"; tClr = "var(--muted)"; }
  else if (above50) { tVal = "▲ 壓力累積中"; tSig = "高於季均（壓力上升）"; tClr = "#f0883e"; }
  else              { tVal = "▼ 壓力消退中"; tSig = "低於季均（壓力下降）"; tClr = "#3fb950"; }
  setText("ts-trend-val", tVal, tClr);
  setText("ts-trend-sub", last.ma50 != null ? `MA50 ${last.ma50.toFixed(0)}｜MA200 ${last.ma200?.toFixed(0) ?? "—"}` : "—", "var(--muted)");
  setText("ts-trend-signal", tSig, tClr);

  // 3. top driver
  const drv = DIMS.map(d => ({ name: d.name, v: last[d.key], color: d.color }))
                  .filter(d => d.v != null).sort((a, b) => b.v - a.v);
  if (drv.length) {
    const top = drv[0];
    setText("ts-driver-val", top.name, top.color);
    setText("ts-driver-sub", `壓力 ${top.v.toFixed(0)}／100｜最低 ${drv[drv.length - 1].name} ${drv[drv.length - 1].v.toFixed(0)}`, "var(--muted)");
    setText("ts-driver-signal", top.v >= 50 ? "目前最大壓力來源" : "各面向壓力均不高", top.v >= 50 ? "#f0883e" : "#3fb950");
  }
}

export function render() {
  if (!tsChart || !rows) return;
  const axisClr = tc("#8b949e", "#57606a");
  const gridClr = tc("rgba(48,54,61,0.5)", "rgba(208,215,222,0.4)");
  const tipBg   = tc("#161b22", "#ffffff");
  const tipBdr  = tc("#30363d", "#d0d7de");
  const textClr = tc("#c9d1d9", "#24292f");

  updateCards();

  const cutoff = rangeCutoff(tsRange);
  const view   = rows.filter(r => r.date >= cutoff);
  const dates  = view.map(r => r.date);
  const comp   = view.map(r => +r.composite.toFixed(1));
  const maData = Object.fromEntries(PERIODS.map(p =>
                   [p, view.map(r => r[`ma${p}`] != null ? +r[`ma${p}`].toFixed(1) : null)]));
  const dimData = Object.fromEntries(DIMS.map(d =>
                   [d.key, view.map(r => r[d.key] != null ? +r[d.key].toFixed(1) : null)]));
  const twiiData = showTwii ? view.map(r => r.twii ?? null) : null;

  const status = document.getElementById("ts-status");
  if (status) status.textContent =
    `台股金融壓力綜合 · ${dates.length} 個交易日（${tsRange}）· 0-100 越高壓力越大 · 自建四維（匯率/股市波動+融資維持率+外資期貨）`;

  const L = mob() ? 40 : 52, R = showTwii ? (mob() ? 48 : 62) : (mob() ? 16 : 28);
  // two stacked grids, each with its OWN legend directly above it (綜合+均線 上 / 四維 下)
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
    { gridIndex: 0, min: 0, max: 100, name: "壓力", nameTextStyle: { color: axisClr, fontSize: 10 },
      axisLabel: { color: axisClr, fontSize: 11 }, axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: gridClr } } },
  ];
  let twiiAxisIdx = -1;
  if (showTwii && twiiData) {
    twiiAxisIdx = yAxis.length;
    yAxis.push({ gridIndex: 0, type: "log", scale: true, position: "right",
      name: "加權", nameTextStyle: { color: TWII_COLOR, fontSize: 10 },
      axisLine: { lineStyle: { color: TWII_COLOR } },
      axisLabel: { color: TWII_COLOR, fontSize: 10, formatter: v => v >= 1000 ? (v / 1000).toFixed(0) + "K" : v },
      splitLine: { show: false } });
  }
  const dimAxisIdx = yAxis.length;
  yAxis.push({ gridIndex: 1, min: 0, max: 100, name: "子指數", nameTextStyle: { color: axisClr, fontSize: 10 },
    axisLabel: { color: axisClr, fontSize: 10 }, axisLine: { show: false }, axisTick: { show: false },
    splitLine: { lineStyle: { color: gridClr } },
    markLine: { silent: true, symbol: "none",
      data: [{ yAxis: 50, lineStyle: { color: axisClr, type: "dashed", width: 1, opacity: 0.4 } }] } });

  const zoneMark = {
    silent: true, symbol: "none",
    data: [
      { yAxis: 75, lineStyle: { color: "#f85149", type: "dashed", width: 1, opacity: 0.6 },
        label: { formatter: "75 高壓", color: "#f85149", fontSize: 9, position: "insideEndTop" } },
      { yAxis: 50, lineStyle: { color: axisClr, type: "dashed", width: 1, opacity: 0.4 },
        label: { formatter: "50", color: axisClr, fontSize: 9, position: "insideEndTop" } },
      { yAxis: 25, lineStyle: { color: "#3fb950", type: "dashed", width: 1, opacity: 0.6 },
        label: { formatter: "25 低壓", color: "#3fb950", fontSize: 9, position: "insideEndBottom" } },
    ],
  };

  const compColor = tc("#e6edf3", "#1f2328");
  const maSeries = PERIODS.map(p => ({
    name: MA_NAME[p], type: "line", xAxisIndex: 0, yAxisIndex: 0, data: maData[p],
    symbol: "none", smooth: false, z: 3, itemStyle: { color: MA_COLOR[p] },
    lineStyle: { color: MA_COLOR[p], width: 1.2, opacity: 0.85 },
  }));
  const dimSeries = DIMS.map(d => ({
    name: d.name, type: "line", xAxisIndex: 1, yAxisIndex: dimAxisIdx, data: dimData[d.key],
    symbol: "none", smooth: false, connectNulls: true, itemStyle: { color: d.color },
    lineStyle: { color: d.color, width: 1.3 },
  }));

  const series = [
    { name: "綜合壓力", type: "line", xAxisIndex: 0, yAxisIndex: 0, data: comp,
      symbol: "none", smooth: false, z: 5, itemStyle: { color: compColor },
      lineStyle: { color: compColor, width: 1.8 },
      areaStyle: { color: tc("rgba(248,81,73,0.10)", "rgba(248,81,73,0.07)") },
      markLine: zoneMark },
    ...maSeries,
    ...dimSeries,
  ];
  if (showTwii && twiiData) {
    series.splice(1, 0, { name: "加權指數", type: "line", xAxisIndex: 0, yAxisIndex: twiiAxisIdx,
      data: twiiData, symbol: "none", smooth: false, z: 2, connectNulls: true,
      itemStyle: { color: TWII_COLOR }, lineStyle: { color: TWII_COLOR, width: 1.3, opacity: 0.8 } });
  }

  const topLegend = ["綜合壓力", ...(showTwii ? ["加權指數"] : []), ...PERIODS.map(p => MA_NAME[p])];
  const dimLegend = DIMS.map(d => d.name);

  tsChart.setOption({
    backgroundColor: "transparent", animation: false,
    tooltip: {
      trigger: "axis", axisPointer: { type: "cross", link: [{ xAxisIndex: "all" }] },
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        const d = params[0]?.axisValue ?? "";
        let html = `<div style="font-weight:600;margin-bottom:4px">${d}</div>`;
        for (const p of params) {
          if (p.value == null) continue;
          const v = p.seriesName === "加權指數" ? (+p.value).toFixed(0) : (+p.value).toFixed(0);
          html += `<div>${p.marker}${p.seriesName}: <b>${v}</b></div>`;
        }
        return html;
      },
    },
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    grid, xAxis, yAxis,
    dataZoom: [{ type: "inside", xAxisIndex: [0, 1], filterMode: "none" }],
    legend: [
      { data: topLegend, top: 2,     left: "center", textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr },
      { data: dimLegend, top: "53%", left: "center", textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr },
    ],
    series,
  }, { notMerge: true });
}

function buildControls() {
  const rp = document.getElementById("ts-range-picker");
  if (rp && !rp.dataset.built) {
    rp.dataset.built = "1";
    rp.addEventListener("click", e => {
      const t = e.target.closest(".chip[data-ts-range]");
      if (!t) return;
      tsRange = t.dataset.tsRange;
      rp.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c === t));
      render();
    });
  }
  const tb = document.getElementById("ts-twii-toggle");
  if (tb && !tb.dataset.built) {
    tb.dataset.built = "1";
    tb.addEventListener("click", () => {
      showTwii = !showTwii;
      tb.classList.toggle("active", showTwii);
      render();
    });
  }
}

export async function activate() {
  const host = document.getElementById("ts-chart");
  if (!host) return;
  if (!tsChart) tsChart = echarts.init(host, isLight() ? null : "dark");
  buildControls();
  try {
    await loadAll();
    setTimeout(() => { tsChart?.resize(); render(); }, 50);
  } catch (e) {
    const s = document.getElementById("ts-status");
    if (s) s.textContent = "載入失敗：" + (e.message || e);
    console.error("[twstress] load failed", e);
  }
}
export function onThemeChange(light) {
  if (!tsChart) return;
  tsChart.dispose();
  tsChart = echarts.init(document.getElementById("ts-chart"), light ? null : "dark");
  if (rows) render();
}
export function resize() { tsChart?.resize(); }
