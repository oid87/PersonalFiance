// 淨流動性 tab — Fed 淨流動性（WALCL − TGA − RRP）
//   net_liq 主線（粗）+ 可選 walcl/tga/rrp 三細項 toggle
//   資料：data/net_liquidity.json（fetch_net_liquidity.py 抓 FRED CSV，免 key）

import { isLight, tc, mob, PALETTE } from '../utils/theme.js';

const SUB_LINES = [
  { key: "walcl", name: "Fed 總資產 (WALCL)", color: "#58a6ff" },
  { key: "tga",   name: "財政部帳戶 (TGA)",   color: "#e3b341" },
  { key: "rrp",   name: "隔夜逆回購 (RRP)",   color: "#d2a8ff" },
];
const NET_COLOR = "#3fb950";

let chart    = null;
let range    = "3Y";
let showSet  = new Set();   // 目前開啟的細項 key
let rows     = null;

async function loadAll() {
  if (rows) return;
  const r = await fetch("data/net_liquidity.json", { cache: "no-cache" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  rows = (j?.data ?? []).filter(x => x.net_liq != null).map(x => ({ ...x }));
}

function cutoffDate(key) {
  if (key === "MAX") return "0000-00-00";
  const d = new Date();
  const yrs = { "1Y": 1, "3Y": 3, "5Y": 5, "10Y": 10 }[key] ?? 3;
  d.setFullYear(d.getFullYear() - yrs);
  return d.toISOString().slice(0, 10);
}

// 找出「距今 N 天前」最接近（<=）的一筆資料，供卡片變化量計算
function findNDaysAgo(days) {
  if (!rows?.length) return null;
  const target = new Date(rows[rows.length - 1].date);
  target.setDate(target.getDate() - days);
  const targetStr = target.toISOString().slice(0, 10);
  let best = null;
  for (const rrow of rows) {
    if (rrow.date <= targetStr) best = rrow;
    else break;
  }
  return best;
}

function fmtT(millions) {
  if (millions == null) return "—";
  return "$" + (millions / 1e6).toFixed(2) + " T";
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

  setText("netliq-cur-val", fmtT(last.net_liq), PALETTE.text);
  setText("netliq-cur-sub", `${last.date} · WALCL−TGA−RRP`, "var(--muted)");
  setText("netliq-cur-signal", "淨流動性水位", NET_COLOR);

  const y1 = findNDaysAgo(365);
  if (y1 && y1.net_liq != null) {
    const chg = last.net_liq - y1.net_liq;
    const clr = chg >= 0 ? "#3fb950" : "#f85149";
    setText("netliq-1y-val", (chg >= 0 ? "▲ +" : "▼ ") + fmtT(Math.abs(chg)).replace("$", ""), clr);
    setText("netliq-1y-sub", `vs ${y1.date}（${fmtT(y1.net_liq)}）`, "var(--muted)");
    setText("netliq-1y-signal", chg >= 0 ? "流動性擴張" : "流動性緊縮", clr);
  }

  const m3 = findNDaysAgo(90);
  if (m3 && m3.net_liq != null) {
    const chg = last.net_liq - m3.net_liq;
    const clr = chg >= 0 ? "#3fb950" : "#f85149";
    setText("netliq-3m-val", (chg >= 0 ? "▲ +" : "▼ ") + fmtT(Math.abs(chg)).replace("$", ""), clr);
    setText("netliq-3m-sub", `vs ${m3.date}（${fmtT(m3.net_liq)}）`, "var(--muted)");
    setText("netliq-3m-signal", chg >= 0 ? "近3月擴張" : "近3月緊縮", clr);
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

  const status = document.getElementById("netliq-status");
  if (status) status.textContent =
    `淨流動性 · ${dates.length} 個交易日（${range}）· 資料 FRED WALCL/WTREGEN/RRPONTSYD`;

  const L = mob() ? 48 : 62;
  const R = mob() ? 16 : 28;

  const series = [{
    name: "淨流動性", type: "line",
    data: view.map(r => r.net_liq != null ? +r.net_liq.toFixed(0) : null),
    symbol: "none", connectNulls: true,
    itemStyle: { color: NET_COLOR },
    lineStyle: { color: NET_COLOR, width: 2.5 },
    yAxisIndex: 0, z: 5,
  }];

  for (const ln of SUB_LINES) {
    if (!showSet.has(ln.key)) continue;
    // RRP 目前僅數十億、與兆級主線同軸會貼底 → 放獨立右軸;WALCL/TGA 與主線同量級留主軸
    const onRight = ln.key === "rrp";
    series.push({
      name: ln.name + (onRight ? "（右軸）" : ""), type: "line",
      data: view.map(r => r[ln.key] != null ? +r[ln.key].toFixed(0) : null),
      symbol: "none", connectNulls: true,
      itemStyle: { color: ln.color },
      lineStyle: { color: ln.color, width: 1.3, opacity: 0.85, type: onRight ? "dashed" : "solid" },
      yAxisIndex: onRight ? 1 : 0, z: 3,
    });
  }

  const legendData = ["淨流動性", ...SUB_LINES.filter(l => showSet.has(l.key)).map(l => l.name)];

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
          html += `<div>${p.marker}${p.seriesName}: <b>${fmtT(p.value)}</b></div>`;
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
    yAxis: [
      {
        type: "value", scale: true, name: "$T",
        nameTextStyle: { color: axisClr, fontSize: 10 },
        axisLabel: { color: axisClr, fontSize: 11, formatter: v => (v / 1e6).toFixed(1) + "T" },
        axisLine: { show: false }, axisTick: { show: false },
        splitLine: { lineStyle: { color: gridClr } },
      },
      {
        type: "value", scale: true, name: "RRP $T", position: "right",
        nameTextStyle: { color: axisClr, fontSize: 10 },
        axisLabel: { color: axisClr, fontSize: 11, formatter: v => (v / 1e6).toFixed(2) + "T" },
        axisLine: { show: false }, axisTick: { show: false },
        splitLine: { show: false },
      },
    ],
    dataZoom: [{ type: "inside", filterMode: "none" }],
    series,
  }, { notMerge: true });
}

// ── controls ──────────────────────────────────────────────────────────
function buildControls() {
  const rp = document.getElementById("netliq-range-picker");
  if (rp && !rp.dataset.built) {
    rp.dataset.built = "1";
    rp.addEventListener("click", e => {
      const t = e.target.closest(".chip[data-netliq-range]");
      if (!t) return;
      range = t.dataset.netliqRange;
      rp.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c === t));
      render();
    });
  }
  const sub = document.getElementById("netliq-sub-toggles");
  if (sub && !sub.dataset.built) {
    sub.dataset.built = "1";
    sub.addEventListener("click", e => {
      const t = e.target.closest(".chip[data-netliq-sub]");
      if (!t) return;
      const key = t.dataset.netliqSub;
      if (showSet.has(key)) showSet.delete(key); else showSet.add(key);
      t.classList.toggle("active", showSet.has(key));
      render();
    });
  }
}

// ── lifecycle ─────────────────────────────────────────────────────────
export async function activate() {
  const host = document.getElementById("netliq-chart");
  if (!host) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : "dark");
  buildControls();
  try {
    await loadAll();
    setTimeout(() => { chart?.resize(); render(); }, 50);
  } catch (e) {
    const s = document.getElementById("netliq-status");
    if (s) s.textContent = "載入失敗：" + (e.message || e);
    console.error("[net_liquidity] load failed", e);
  }
}
export function onThemeChange(light) {
  if (!chart) return;
  chart.dispose();
  chart = echarts.init(document.getElementById("netliq-chart"), light ? null : "dark");
  if (rows) render();
}
export function resize() { chart?.resize(); }
