// 實質利率 tab — US TIPS 實質殖利率（DFII5 / DFII10 / DFII30）+ 0% 參考線
//   實質殖利率 = 名目殖利率 − 通膨預期，正值代表貨幣政策實質限制性（偏緊）
//   資料：data/real_rates.json（fetch_real_rates.py 抓 FRED CSV，免 key）

import { isLight, tc, mob } from '../utils/theme.js';

const LINES = [
  { key: "dfii5",  name: "5Y 實質殖利率",  color: "#58a6ff" },
  { key: "dfii10", name: "10Y 實質殖利率", color: "#e3b341" },
  { key: "dfii30", name: "30Y 實質殖利率", color: "#3fb950" },
];

let chart = null;
let range = "3Y";
let rows  = null;

async function loadAll() {
  if (rows) return;
  const r = await fetch("data/real_rates.json", { cache: "no-cache" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  rows = (j?.data ?? []).filter(x => x.dfii5 != null || x.dfii10 != null || x.dfii30 != null).map(x => ({ ...x }));
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
  const r10 = lastNonNull("dfii10");
  const r5  = lastNonNull("dfii5");

  if (r10) {
    const v = r10.dfii10;
    const clr = v > 0 ? "#f85149" : "#3fb950";
    setText("realr-10y-val", (v >= 0 ? "+" : "") + v.toFixed(2) + "%", clr);
    setText("realr-10y-sub", `${r10.date} · FRED DFII10`, "var(--muted)");
    setText("realr-10y-signal", v > 0 ? "實質偏緊" : "實質偏鬆", clr);

    setText("realr-state-val", v > 0 ? "實質偏緊" : "實質偏鬆", clr);
    setText("realr-state-sub", `10Y 實質殖利率 ${v >= 0 ? "+" : ""}${v.toFixed(2)}%`, "var(--muted)");
    setText("realr-state-signal", v > 0 ? "貨幣政策具實質限制性" : "貨幣政策未達實質限制性", clr);
  }

  if (r5) {
    const v = r5.dfii5;
    const clr = v > 0 ? "#f85149" : "#3fb950";
    setText("realr-5y-val", (v >= 0 ? "+" : "") + v.toFixed(2) + "%", clr);
    setText("realr-5y-sub", `${r5.date} · FRED DFII5`, "var(--muted)");
    setText("realr-5y-signal", v > 0 ? "實質偏緊" : "實質偏鬆", clr);
  }
}

// ── chart render ──────────────────────────────────────────────────────
export function render() {
  if (!chart || !rows?.length) return;

  const axisClr = tc("#8b949e", "#57606a");
  const gridClr = tc("rgba(48,54,61,0.5)", "rgba(208,215,222,0.4)");
  const tipBg   = tc("#161b22", "#ffffff");
  const tipBdr  = tc("#30363d", "#d0d7de");
  const textClr = tc("#c9d1d9", "#24292f");

  updateCards();

  const cut  = cutoffDate(range);
  const view = rows.filter(r => r.date >= cut);
  const dates = view.map(r => r.date);

  const status = document.getElementById("realr-status");
  if (status) status.textContent =
    `實質利率 · ${dates.length} 個交易日（${range}）· 資料 FRED DFII5/DFII10/DFII30`;

  const L = mob() ? 40 : 52;
  const R = mob() ? 16 : 28;

  const zeroLine = {
    silent: true, symbol: "none",
    lineStyle: { color: "#8b949e", type: "dashed", width: 1, opacity: 0.6 },
    label: { formatter: "0%（實質利率零軸）", color: "#8b949e", fontSize: 9, position: "insideEndTop" },
    data: [{ yAxis: 0 }],
  };

  const series = [];
  for (const ln of LINES) {
    series.push({
      name: ln.name, type: "line",
      data: view.map(r => r[ln.key] != null ? +r[ln.key].toFixed(3) : null),
      symbol: "none", connectNulls: true,
      itemStyle: { color: ln.color },
      lineStyle: { color: ln.color, width: ln.key === "dfii10" ? 2 : 1.3 },
      yAxisIndex: 0, z: ln.key === "dfii10" ? 5 : 3,
      markLine: ln.key === "dfii10" ? zeroLine : undefined,
    });
  }

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
      data: LINES.map(l => l.name), top: 2, left: "center",
      textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr,
    },
    grid: { left: L, right: R, top: "10%", bottom: "12%" },
    xAxis: {
      type: "category", data: dates, boundaryGap: false,
      axisLine: { lineStyle: { color: axisClr } }, axisTick: { show: false },
      axisLabel: { color: axisClr, fontSize: 11 },
      splitLine: { show: false },
    },
    yAxis: [{
      type: "value", scale: true, name: "%",
      nameTextStyle: { color: axisClr, fontSize: 10 },
      axisLabel: { color: axisClr, fontSize: 11, formatter: v => v.toFixed(1) + "%" },
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: gridClr } },
    }],
    dataZoom: [{ type: "inside", filterMode: "none" }],
    series,
  }, { notMerge: true });
}

// ── controls ──────────────────────────────────────────────────────────
function buildControls() {
  const rp = document.getElementById("realr-range-picker");
  if (rp && !rp.dataset.built) {
    rp.dataset.built = "1";
    rp.addEventListener("click", e => {
      const t = e.target.closest(".chip[data-realr-range]");
      if (!t) return;
      range = t.dataset.realrRange;
      rp.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c === t));
      render();
    });
  }
}

// ── lifecycle ─────────────────────────────────────────────────────────
export async function activate() {
  const host = document.getElementById("realr-chart");
  if (!host) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : "dark");
  buildControls();
  try {
    await loadAll();
    setTimeout(() => { chart?.resize(); render(); }, 50);
  } catch (e) {
    const s = document.getElementById("realr-status");
    if (s) s.textContent = "載入失敗：" + (e.message || e);
    console.error("[real_rates] load failed", e);
  }
}
export function onThemeChange(light) {
  if (!chart) return;
  chart.dispose();
  chart = echarts.init(document.getElementById("realr-chart"), light ? null : "dark");
  if (rows) render();
}
export function resize() { chart?.resize(); }
