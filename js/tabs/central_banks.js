// 全球央行資產負債表 tab — Fed / ECB / BOJ 總資產,rebase 成指數(視窗起點=100)
//   三者幣別單位不同(USD/EUR/JPY),不可直接相加 → 各自 rebase 才能比較擴縮速度
//   資料：data/central_banks.json（fetch_central_banks.py 抓 FRED WALCL/ECBASSETSW/JPNASSETS,免 key）

import { isLight, tc, mob } from '../utils/theme.js';

const LINES = [
  { key: "fed", name: "Fed（WALCL）",     color: "#58a6ff" },
  { key: "ecb", name: "ECB（ECBASSETSW）", color: "#e3b341" },
  { key: "boj", name: "BOJ（JPNASSETS）",  color: "#3fb950" },
];

let chart = null;
let range = "10Y";
let rows  = null;

async function loadAll() {
  if (rows) return;
  const r = await fetch("data/central_banks.json", { cache: "no-cache" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  rows = (j?.data ?? []).filter(x => x.fed != null || x.ecb != null || x.boj != null).map(x => ({ ...x }));
}

function cutoffDate(key) {
  if (key === "MAX") return "0000-00-00";
  const d = new Date();
  const yrs = { "3Y": 3, "5Y": 5, "10Y": 10, "20Y": 20 }[key] ?? 10;
  d.setFullYear(d.getFullYear() - yrs);
  return d.toISOString().slice(0, 10);
}

function setText(id, txt, color) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = txt;
  if (color) el.style.color = color;
}

// 視窗內第一個非 null 值當基期(=100)
function baseValue(view, key) {
  for (const r of view) if (r[key] != null) return r[key];
  return null;
}

function lastNonNull(key) {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i][key] != null) return rows[i];
  return null;
}

function updateCards(view) {
  // 卡片顯示各行在當前視窗的累積擴縮(相對基期%)
  const cards = [["fed", "cb-fed"], ["ecb", "cb-ecb"], ["boj", "cb-boj"]];
  for (const [key, dom] of cards) {
    const base = baseValue(view, key);
    const last = lastNonNull(key);
    if (base && last && last[key] != null) {
      const pct = (last[key] / base - 1) * 100;
      const clr = pct >= 0 ? "#3fb950" : "#f85149";
      setText(`${dom}-val`, (pct >= 0 ? "+" : "") + pct.toFixed(1) + "%", clr);
      setText(`${dom}-sub`, `${last.date} · 視窗基期以來`, "var(--muted)");
      setText(`${dom}-signal`, pct >= 0 ? "擴表" : "縮表", clr);
    }
  }
}

export function render() {
  if (!chart || !rows?.length) return;

  const axisClr = tc("#8b949e", "#57606a");
  const gridClr = tc("rgba(48,54,61,0.5)", "rgba(208,215,222,0.4)");
  const tipBg   = tc("#161b22", "#ffffff");
  const tipBdr  = tc("#30363d", "#d0d7de");
  const textClr = tc("#c9d1d9", "#24292f");

  const cut  = cutoffDate(range);
  const view = rows.filter(r => r.date >= cut);
  const dates = view.map(r => r.date);

  updateCards(view);

  const status = document.getElementById("cb-status");
  if (status) status.textContent =
    `全球央行資產表 · ${dates.length} 筆（${range}）· 各行以視窗起點 rebase=100`;

  const L = mob() ? 44 : 56;
  const R = mob() ? 16 : 28;

  const base = {};
  for (const ln of LINES) base[ln.key] = baseValue(view, ln.key);

  const series = LINES.map(ln => ({
    name: ln.name, type: "line",
    data: view.map(r => (r[ln.key] != null && base[ln.key]) ? +(r[ln.key] / base[ln.key] * 100).toFixed(2) : null),
    symbol: "none", connectNulls: true,
    itemStyle: { color: ln.color },
    lineStyle: { color: ln.color, width: 1.8 },
    yAxisIndex: 0, z: 3,
  }));

  const baseLine = {
    silent: true, symbol: "none",
    lineStyle: { color: "#8b949e", type: "dashed", width: 1, opacity: 0.5 },
    label: { formatter: "100（基期）", color: "#8b949e", fontSize: 9, position: "insideEndTop" },
    data: [{ yAxis: 100 }],
  };
  series[0].markLine = baseLine;

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
          html += `<div>${p.marker}${p.seriesName}: <b>${(+p.value).toFixed(1)}</b></div>`;
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
      type: "value", scale: true, name: "指數(基期=100)",
      nameTextStyle: { color: axisClr, fontSize: 10 },
      axisLabel: { color: axisClr, fontSize: 11 },
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: gridClr } },
    }],
    dataZoom: [{ type: "inside", filterMode: "none" }],
    series,
  }, { notMerge: true });
}

function buildControls() {
  const rp = document.getElementById("cb-range-picker");
  if (rp && !rp.dataset.built) {
    rp.dataset.built = "1";
    rp.addEventListener("click", e => {
      const t = e.target.closest(".chip[data-cb-range]");
      if (!t) return;
      range = t.dataset.cbRange;
      rp.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c === t));
      render();
    });
  }
}

export async function activate() {
  const host = document.getElementById("cb-chart");
  if (!host) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : "dark");
  buildControls();
  try {
    await loadAll();
    setTimeout(() => { chart?.resize(); render(); }, 50);
  } catch (e) {
    const s = document.getElementById("cb-status");
    if (s) s.textContent = "載入失敗：" + (e.message || e);
    console.error("[central_banks] load failed", e);
  }
}
export function onThemeChange(light) {
  if (!chart) return;
  chart.dispose();
  chart = echarts.init(document.getElementById("cb-chart"), light ? null : "dark");
  if (rows) render();
}
export function resize() { chart?.resize(); }
