// VXN−VIX 波動率價差 tab — Nasdaq(VXN) 相對大盤(VIX)的隱含波動率溢價
//   主圖：spread = VXN.close - VIX.close 時序折線 + 90th/95th 全樣本固定分位數門檻線
//   資料：data/vxnvix.json（scripts/prep_vxnvix.py 由本地 VIX.json/VXN.json 對齊產生，免 key）

import { isLight, tc, mob, PALETTE } from '../utils/theme.js';

const SPREAD_COLOR = "#58a6ff";

let chart = null;
let range = "3Y";
let payload = null; // full parsed json: { data, percentile_90, percentile_95, current, updated }

async function loadAll() {
  if (payload) return;
  const r = await fetch("data/vxnvix.json", { cache: "no-cache" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  payload = j;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

function cutoffDate(key) {
  if (key === "MAX") return "0000-00-00";
  const d = new Date();
  const yrs = { "1Y": 1, "3Y": 3, "5Y": 5, "10Y": 10 }[key] ?? 3;
  d.setFullYear(d.getFullYear() - yrs);
  return d.toISOString().slice(0, 10);
}

// ── cards ─────────────────────────────────────────────────────────────
function setText(id, txt, color) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = txt;
  if (color) el.style.color = color;
}

function updateCards() {
  if (!payload) return;
  const cur = payload.current;
  const p90 = payload.percentile_90;
  const p95 = payload.percentile_95;
  if (!cur) return;

  let sig, clr;
  if (cur.spread >= p95) { sig = "極端偏高（≥95th）"; clr = "#f85149"; }
  else if (cur.spread >= p90) { sig = "偏高（≥90th）"; clr = "#f0883e"; }
  else { sig = "正常區間"; clr = "#3fb950"; }

  setText("vxnvix-spread-val", cur.spread.toFixed(2), PALETTE.text);
  setText("vxnvix-spread-sub", `${cur.date} · VXN − VIX`, "var(--muted)");
  setText("vxnvix-spread-signal", sig, clr);

  setText("vxnvix-rank-val", `${cur.percentile_rank.toFixed(1)}%`, PALETTE.text);
  setText("vxnvix-rank-sub", "全樣本（2001年至今）百分位排名", "var(--muted)");
  setText("vxnvix-rank-signal", sig, clr);

  setText("vxnvix-thresh-val", `${p90.toFixed(2)} / ${p95.toFixed(2)}`, PALETTE.text);
  setText("vxnvix-thresh-sub", "90th / 95th 全樣本固定門檻", "var(--muted)");
  setText("vxnvix-thresh-signal", "非逐日訊號，僅供參考", "var(--muted)");
}

// ── chart render ──────────────────────────────────────────────────────
export function render() {
  if (!chart || !payload?.data?.length) return;

  const axisClr = PALETTE.muted;
  const gridClr = tc("rgba(48,54,61,0.5)", "rgba(208,215,222,0.4)");
  const tipBg   = PALETTE.bg;
  const tipBdr  = PALETTE.border;
  const textClr = PALETTE.text2;
  const isMob   = mob();

  updateCards();

  const cut  = cutoffDate(range);
  const view = payload.data.filter(r => r.date >= cut);
  const dates = view.map(r => r.date);

  const status = document.getElementById("vxnvix-status");
  if (status) status.textContent =
    `VXN−VIX 波動率價差 · ${dates.length} 個交易日（${range}）· 資料 CBOE VXN/VIX`;

  const L = mob() ? 40 : 52;
  const R = mob() ? 16 : 28;

  // Y 軸範圍由實際資料 min/max 決定，留 padding，避免裁切（門檻線也一併納入考量）
  const spreadVals = view.map(r => r.spread).filter(v => v != null);
  const p90 = payload.percentile_90;
  const p95 = payload.percentile_95;
  const allForRange = [...spreadVals, p90, p95];
  const dataMin = Math.min(...allForRange);
  const dataMax = Math.max(...allForRange);
  const pad = Math.max(0.5, (dataMax - dataMin) * 0.08);
  const yMin = Math.floor((dataMin - pad) * 10) / 10;
  const yMax = Math.ceil((dataMax + pad) * 10) / 10;

  const series = [{
    name: "VXN−VIX 價差", type: "line", xAxisIndex: 0, yAxisIndex: 0,
    data: view.map(r => r.spread != null ? +r.spread.toFixed(2) : null),
    symbol: "none", connectNulls: true,
    itemStyle: { color: SPREAD_COLOR },
    lineStyle: { color: SPREAD_COLOR, width: 1.6 },
    z: 5,
    markLine: {
      silent: true, symbol: "none",
      lineStyle: { color: "#f0883e", type: "dashed", width: 1 },
      label: { color: "#f0883e", fontSize: 9, position: "insideEndTop" },
      data: [
        { yAxis: p90, label: { formatter: `90th 百分位（${p90.toFixed(2)}）` }, lineStyle: { color: "#f0883e" } },
        { yAxis: p95, label: { formatter: `95th 百分位（${p95.toFixed(2)}）` }, lineStyle: { color: "#f85149" } },
      ],
    },
  }];

  const axBase = {
    type: "category", data: dates, boundaryGap: false,
    axisLine: { lineStyle: { color: axisClr } }, axisTick: { show: false },
    splitLine: { show: false },
  };

  chart.setOption({
    backgroundColor: "transparent", animation: false,
    tooltip: {
      trigger: "axis", axisPointer: { type: "cross" },
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        const p = params[0];
        if (!p) return "";
        const row = view[p.dataIndex];
        if (!row) return "";
        return `<div style="font-weight:600;margin-bottom:4px">${row.date}</div>
          <div>VXN: <b>${row.vxn.toFixed(2)}</b></div>
          <div>VIX: <b>${row.vix.toFixed(2)}</b></div>
          <div>${p.marker}價差: <b>${row.spread.toFixed(2)}</b></div>`;
      },
    },
    legend: {
      data: ["VXN−VIX 價差"], top: 2, left: "center",
      textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr,
    },
    grid: [{ left: L, right: R, top: "14%", height: "76%" }],
    xAxis: [
      { ...axBase, gridIndex: 0, axisLabel: { color: axisClr, fontSize: 10, rotate: isMob ? 30 : 0 } },
    ],
    yAxis: [
      {
        gridIndex: 0, type: "value", min: yMin, max: yMax, name: "VXN−VIX",
        nameTextStyle: { color: axisClr, fontSize: 10 },
        axisLabel: { color: axisClr, fontSize: 11 },
        axisLine: { show: false }, axisTick: { show: false },
        splitLine: { lineStyle: { color: gridClr } },
      },
    ],
    dataZoom: [{ type: "inside", xAxisIndex: [0], filterMode: "none" }],
    series,
  }, { notMerge: true });
}

// ── controls ──────────────────────────────────────────────────────────
function buildControls() {
  const rp = document.getElementById("vxnvix-range-picker");
  if (rp && !rp.dataset.built) {
    rp.dataset.built = "1";
    rp.addEventListener("click", e => {
      const t = e.target.closest(".chip[data-vxnvix-range]");
      if (!t) return;
      range = t.dataset.vxnvixRange;
      rp.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c === t));
      render();
    });
  }
}

// ── lifecycle ─────────────────────────────────────────────────────────
export async function activate() {
  const host = document.getElementById("vxnvix-chart");
  if (!host) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : "dark");
  buildControls();
  try {
    await loadAll();
    setTimeout(() => { chart?.resize(); render(); }, 50);
  } catch (e) {
    const s = document.getElementById("vxnvix-status");
    if (s) s.textContent = "載入失敗：" + (e.message || e);
    console.error("[vxnvix] load failed", e);
  }
}
export function onThemeChange(light) {
  if (!chart) return;
  chart.dispose();
  chart = echarts.init(document.getElementById("vxnvix-chart"), light ? null : "dark");
  if (payload) render();
}
export function resize() { chart?.resize(); }
