// 通膨預期 tab — US Breakeven Inflation Rates (FRED)
//   T5YIE (5Y breakeven) + T10YIE (10Y breakeven) + T5YIFR (5Y-5Y forward)
//   日頻折線 + MA20/MA50 + 可疊 SPY（對數右軸）
//   資料：data/inflation_exp.json（fetch_inflation_exp.py 抓 FRED CSV，免 key）

import { isLight, tc, mob, PALETTE } from '../utils/theme.js';
import { cutoffDate } from '../utils/dates.js';

const LINES = [
  { key: "be5y",    name: "5Y Breakeven",  color: "#58a6ff" },
  { key: "be10y",   name: "10Y Breakeven", color: "#d2a8ff" },
  { key: "fwd5y5y", name: "5Y-5Y Forward", color: "#e3b341" },
];
const MA_PERIODS = [20, 50];
const MA_COLOR   = { 20: "#2dd4bf", 50: "#f0883e" };
const SPY_COLOR  = "#f778ba";

let chart   = null;
let range   = "3Y";
let showSPY = false;
let showMA  = false;
let rows    = null;
let spData  = null;

async function loadAll() {
  if (rows) return;
  const fetchJson = async (path, optional = false) => {
    try {
      const r = await fetch(path, { cache: "no-cache" });
      if (!r.ok) { if (optional) return null; throw new Error(`${path}: HTTP ${r.status}`); }
      return r.json();
    } catch (e) { if (optional) return null; throw e; }
  };
  const [infJson, spJson] = await Promise.all([
    fetchJson("data/inflation_exp.json"),
    fetchJson("data/SP500.json", true),
  ]);
  rows = (infJson?.data ?? []).filter(r => r.be5y != null || r.be10y != null).map(r => ({ ...r }));
  computeMA(rows);
  spData = spJson?.data ? new Map(spJson.data.map(r => [r.date, r.close])) : null;
}

function computeMA(rs) {
  const n = rs.length;
  for (const p of MA_PERIODS) {
    let sum = 0, cnt = 0;
    for (let i = 0; i < n; i++) {
      const v = rs[i].be5y;
      if (v != null) { sum += v; cnt++; }
      if (i >= p) {
        const old = rs[i - p].be5y;
        if (old != null) { sum -= old; cnt--; }
      }
      if (cnt === p) rs[i][`ma${p}`] = sum / p;
    }
  }
}

// ── cards ─────────────────────────────────────────────────────────────
function setText(id, txt, color) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = txt;
  if (color) el.style.color = color;
}

function updateCards() {
  const last = rows[rows.length - 1];
  const be5  = last.be5y;
  const be10 = last.be10y;
  const fwd  = last.fwd5y5y;

  // card 1: 5Y breakeven level
  if (be5 != null) {
    let sig, clr;
    if      (be5 > 3.0) { sig = "通膨預期過熱";     clr = "#f85149"; }
    else if (be5 > 2.5) { sig = "偏高 · Fed 警戒區"; clr = "#f0883e"; }
    else if (be5 > 2.0) { sig = "正常區間 · 錨定穩";  clr = "#3fb950"; }
    else if (be5 > 1.5) { sig = "偏低 · 通縮隱憂";   clr = "#58a6ff"; }
    else                { sig = "通縮預期 · 極端訊號"; clr = "#d2a8ff"; }
    setText("inf-5y-val", be5.toFixed(2) + "%", PALETTE.text);
    setText("inf-5y-sub", `${last.date} · TIPS 5Y Breakeven`, "var(--muted)");
    setText("inf-5y-signal", sig, clr);
  }

  // card 2: 1-month change in 5Y
  const prev20 = rows[rows.length - 21]?.be5y;
  if (be5 != null && prev20 != null) {
    const chg = be5 - prev20;
    const tClr = chg >= 0 ? "#f85149" : "#3fb950";
    setText("inf-chg-val", (chg >= 0 ? "▲ +" : "▼ ") + chg.toFixed(2) + "%", tClr);
    setText("inf-chg-sub", `vs 20個交易日前（${prev20.toFixed(2)}%）`, "var(--muted)");
    setText("inf-chg-signal", chg >= 0 ? "通膨預期升溫" : "通膨預期降溫", tClr);
  }

  // card 3: 10Y - 5Y spread (term premium)
  if (be5 != null && be10 != null) {
    const spread = be10 - be5;
    const sClr = spread >= 0 ? "#e3b341" : "#58a6ff";
    setText("inf-spread-val", (spread >= 0 ? "+" : "") + spread.toFixed(2) + "%", sClr);
    setText("inf-spread-sub", `10Y(${be10.toFixed(2)}%) − 5Y(${be5.toFixed(2)}%)`, "var(--muted)");
    setText("inf-spread-signal",
      spread >= 0 ? "長期 > 短期（市場認為通膨持久）" : "短期 > 長期（暫時性通膨）", sClr);
  }
}

// ── chart render ──────────────────────────────────────────────────────
export function render() {
  if (!chart || !rows?.length) return;

  const axisClr = PALETTE.muted;
  const gridClr = tc("rgba(48,54,61,0.5)", "rgba(208,215,222,0.4)");
  const tipBg   = PALETTE.bg;
  const tipBdr  = PALETTE.border;
  const textClr = PALETTE.text2;

  updateCards();

  const cut  = cutoffDate(range);
  const view = rows.filter(r => r.date >= cut);
  const dates = view.map(r => r.date);

  const status = document.getElementById("inf-status");
  if (status) status.textContent =
    `通膨預期 · ${dates.length} 個交易日（${range}）· 資料 FRED TIPS breakeven`;

  const L = mob() ? 40 : 52;
  let R = mob() ? 16 : 28;

  const yAxis = [{
    type: "value", scale: true, name: "%",
    nameTextStyle: { color: axisClr, fontSize: 10 },
    axisLabel: { color: axisClr, fontSize: 11, formatter: v => v.toFixed(1) + "%" },
    axisLine: { show: false }, axisTick: { show: false },
    splitLine: { lineStyle: { color: gridClr } },
  }];

  let spyAxisIdx = -1;
  const spyArr = [];
  if (showSPY && spData?.size) {
    spyAxisIdx = yAxis.length;
    R = mob() ? 48 : 62;
    yAxis.push({
      type: "log", scale: true, position: "right",
      name: "SPY", nameTextStyle: { color: SPY_COLOR, fontSize: 10 },
      axisLine: { lineStyle: { color: SPY_COLOR } },
      axisLabel: { color: SPY_COLOR, fontSize: 10, formatter: v => v >= 1000 ? (v / 1000).toFixed(0) + "K" : v.toFixed(0) },
      splitLine: { show: false },
    });
    for (const d of dates) spyArr.push(spData.get(d) ?? null);
  }

  const refLine = {
    silent: true, symbol: "none",
    data: [
      { yAxis: 2.0, lineStyle: { color: "#3fb950", type: "dashed", width: 1, opacity: 0.4 },
        label: { formatter: "2% Fed 目標", color: "#3fb950", fontSize: 9, position: "insideEndTop" } },
    ],
  };

  const series = [];
  for (const ln of LINES) {
    series.push({
      name: ln.name, type: "line",
      data: view.map(r => r[ln.key] != null ? +r[ln.key].toFixed(4) : null),
      symbol: "none", connectNulls: true,
      itemStyle: { color: ln.color },
      lineStyle: { color: ln.color, width: ln.key === "be5y" ? 2 : 1.5 },
      yAxisIndex: 0, z: 5,
      markLine: ln.key === "be5y" ? refLine : undefined,
    });
  }

  if (showMA) {
    for (const p of MA_PERIODS) {
      series.push({
        name: `5Y MA${p}`, type: "line",
        data: view.map(r => r[`ma${p}`] != null ? +r[`ma${p}`].toFixed(4) : null),
        symbol: "none", connectNulls: true,
        itemStyle: { color: MA_COLOR[p] },
        lineStyle: { color: MA_COLOR[p], width: 1.2, opacity: 0.8, type: "dashed" },
        yAxisIndex: 0, z: 3,
      });
    }
  }

  if (showSPY && spyAxisIdx >= 0) {
    series.push({
      name: "SPY", type: "line", data: spyArr,
      symbol: "none", connectNulls: true, z: 2,
      itemStyle: { color: SPY_COLOR },
      lineStyle: { color: SPY_COLOR, width: 1.3, opacity: 0.7 },
      yAxisIndex: spyAxisIdx,
    });
  }

  const legendData = LINES.map(l => l.name);
  if (showMA) legendData.push("5Y MA20", "5Y MA50");
  if (showSPY) legendData.push("SPY");

  chart.setOption({
    backgroundColor: "transparent", animation: false,
    tooltip: {
      trigger: "axis", axisPointer: { type: "cross" },
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        const d = params[0]?.axisValue ?? "";
        let html = `<div style="font-weight:600;margin-bottom:4px">${d}</div>`;
        for (const p of params) {
          if (p.value == null) continue;
          const v = p.seriesName === "SPY" ? (+p.value).toFixed(2) : (+p.value).toFixed(2) + "%";
          html += `<div>${p.marker}${p.seriesName}: <b>${v}</b></div>`;
        }
        return html;
      },
    },
    legend: {
      data: legendData, top: 2, left: "center",
      textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr,
    },
    grid: { left: L, right: R, top: "10%", bottom: "12%" },
    xAxis: {
      type: "category", data: dates, boundaryGap: false,
      axisLine: { lineStyle: { color: axisClr } }, axisTick: { show: false },
      axisLabel: { color: axisClr, fontSize: 11 },
      splitLine: { show: false },
    },
    yAxis,
    dataZoom: [{ type: "inside", filterMode: "none" }],
    series,
  }, { notMerge: true });
}

// ── controls ──────────────────────────────────────────────────────────
function buildControls() {
  const rp = document.getElementById("inf-range-picker");
  if (rp && !rp.dataset.built) {
    rp.dataset.built = "1";
    rp.addEventListener("click", e => {
      const t = e.target.closest(".chip[data-inf-range]");
      if (!t) return;
      range = t.dataset.infRange;
      rp.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c === t));
      render();
    });
  }
  const sb = document.getElementById("inf-spy-toggle");
  if (sb && !sb.dataset.built) {
    sb.dataset.built = "1";
    sb.addEventListener("click", () => {
      showSPY = !showSPY;
      sb.classList.toggle("active", showSPY);
      render();
    });
  }
  const mb = document.getElementById("inf-ma-toggle");
  if (mb && !mb.dataset.built) {
    mb.dataset.built = "1";
    mb.addEventListener("click", () => {
      showMA = !showMA;
      mb.classList.toggle("active", showMA);
      render();
    });
  }
}

// ── lifecycle ─────────────────────────────────────────────────────────
export async function activate() {
  const host = document.getElementById("inf-chart");
  if (!host) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : "dark");
  buildControls();
  try {
    await loadAll();
    setTimeout(() => { chart?.resize(); render(); }, 50);
  } catch (e) {
    const s = document.getElementById("inf-status");
    if (s) s.textContent = "載入失敗：" + (e.message || e);
    console.error("[inflation] load failed", e);
  }
}
export function onThemeChange(light) {
  if (!chart) return;
  chart.dispose();
  chart = echarts.init(document.getElementById("inf-chart"), light ? null : "dark");
  if (rows) render();
}
export function resize() { chart?.resize(); }
