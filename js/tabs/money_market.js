// 貨幣市場壓力 tab — 隔夜利率 SOFR / IORB / EFFR + SOFR−IORB 利差
//   SOFR 明顯高於 IORB（利差 spike > 0）= 隔夜擔保資金吃緊（對照 2019-09 回購危機）
//   資料：data/money_market.json（fetch_money_market.py 抓 FRED CSV，免 key）

import { isLight, tc, mob, PALETTE } from '../utils/theme.js';

const LINES = [
  { key: "sofr", name: "SOFR", color: "#58a6ff" },
  { key: "iorb", name: "IORB", color: "#e3b341" },
  { key: "effr", name: "EFFR", color: "#8b949e" },
];

let chart = null;
let range = "3Y";
let rows  = null;

async function loadAll() {
  if (rows) return;
  const r = await fetch("data/money_market.json", { cache: "no-cache" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  rows = (j?.data ?? []).filter(x => x.sofr != null || x.iorb != null || x.effr != null || x.sofr_iorb != null).map(x => ({ ...x }));
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

function lastNonNull(key) {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i][key] != null) return rows[i];
  }
  return null;
}

function updateCards() {
  const rSofr = lastNonNull("sofr");
  const rSpread = lastNonNull("sofr_iorb");
  const rEffr = lastNonNull("effr");

  if (rSofr) {
    setText("mmkt-sofr-val", rSofr.sofr.toFixed(2) + "%", "var(--text)");
    setText("mmkt-sofr-sub", `${rSofr.date} · FRED SOFR`, "var(--muted)");
    setText("mmkt-sofr-signal", "擔保隔夜融資利率", "var(--muted)");
  }

  if (rSpread) {
    const v = rSpread.sofr_iorb;
    // 利差 > 0（SOFR 高於 IORB）= 資金偏緊；spike 越大越危險
    const tight = v > 0;
    const clr = v >= 0.05 ? "#f85149" : (v > 0 ? "#e3b341" : "#3fb950");
    setText("mmkt-spread-val", (v >= 0 ? "+" : "") + v.toFixed(2) + "%", clr);
    setText("mmkt-spread-sub", `${rSpread.date} · SOFR − IORB`, "var(--muted)");
    setText("mmkt-spread-signal", v >= 0.05 ? "隔夜資金明顯偏緊" : (tight ? "資金略緊" : "正常"), clr);
  }

  if (rEffr) {
    setText("mmkt-effr-val", rEffr.effr.toFixed(2) + "%", "var(--text)");
    setText("mmkt-effr-sub", `${rEffr.date} · FRED EFFR`, "var(--muted)");
    setText("mmkt-effr-signal", "有效聯邦基金利率", "var(--muted)");
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

  const status = document.getElementById("mmkt-status");
  if (status) status.textContent =
    `貨幣市場 · ${dates.length} 個交易日（${range}）· 資料 FRED SOFR/IORB/EFFR`;

  const L = mob() ? 40 : 52;
  const R = mob() ? 40 : 56;

  const zeroLine = {
    silent: true, symbol: "none",
    lineStyle: { color: "#8b949e", type: "dashed", width: 1, opacity: 0.6 },
    label: { formatter: "0（利差零軸）", color: "#8b949e", fontSize: 9, position: "insideEndTop" },
    data: [{ yAxis: 0 }],
  };

  const series = [];
  for (const ln of LINES) {
    series.push({
      name: ln.name, type: "line",
      data: view.map(r => r[ln.key] != null ? +r[ln.key].toFixed(3) : null),
      symbol: "none", connectNulls: true,
      itemStyle: { color: ln.color },
      lineStyle: { color: ln.color, width: ln.key === "sofr" ? 2 : 1.3 },
      yAxisIndex: 0, z: ln.key === "sofr" ? 5 : 3,
    });
  }
  // SOFR−IORB 利差在第二軸（尺度差很多）
  series.push({
    name: "SOFR − IORB 利差", type: "line",
    data: view.map(r => r.sofr_iorb != null ? +r.sofr_iorb.toFixed(3) : null),
    symbol: "none", connectNulls: true,
    itemStyle: { color: "#f85149" },
    lineStyle: { color: "#f85149", width: 1.4, opacity: 0.9 },
    yAxisIndex: 1, z: 6,
    markLine: zeroLine,
  });

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
          html += `<div>${p.marker}${p.seriesName}: <b>${(+p.value).toFixed(2)}%</b></div>`;
        }
        return html;
      },
    },
    legend: {
      data: [...LINES.map(l => l.name), "SOFR − IORB 利差"], top: 2, left: "center",
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
        type: "value", scale: true, name: "利率 %",
        nameTextStyle: { color: axisClr, fontSize: 10 },
        axisLabel: { color: axisClr, fontSize: 11, formatter: v => v.toFixed(1) + "%" },
        axisLine: { show: false }, axisTick: { show: false },
        splitLine: { lineStyle: { color: gridClr } },
      },
      {
        type: "value", scale: true, name: "利差 %", position: "right",
        nameTextStyle: { color: "#f85149", fontSize: 10 },
        axisLabel: { color: "#f85149", fontSize: 11, formatter: v => v.toFixed(2) + "%" },
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
  const rp = document.getElementById("mmkt-range-picker");
  if (rp && !rp.dataset.built) {
    rp.dataset.built = "1";
    rp.addEventListener("click", e => {
      const t = e.target.closest(".chip[data-mmkt-range]");
      if (!t) return;
      range = t.dataset.mmktRange;
      rp.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c === t));
      render();
    });
  }
}

// ── lifecycle ─────────────────────────────────────────────────────────
export async function activate() {
  const host = document.getElementById("mmkt-chart");
  if (!host) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : "dark");
  buildControls();
  try {
    await loadAll();
    setTimeout(() => { chart?.resize(); render(); }, 50);
  } catch (e) {
    const s = document.getElementById("mmkt-status");
    if (s) s.textContent = "載入失敗：" + (e.message || e);
    console.error("[money_market] load failed", e);
  }
}
export function onThemeChange(light) {
  if (!chart) return;
  chart.dispose();
  chart = echarts.init(document.getElementById("mmkt-chart"), light ? null : "dark");
  if (rows) render();
}
export function resize() { chart?.resize(); }
