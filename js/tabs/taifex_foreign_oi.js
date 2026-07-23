// 台指期外資未平倉 tab — TAIFEX 三大法人 台指期(TXF)外資(及陸資)未平倉淨額(口數)
//   正值=外資淨多、負值=淨空;是台股外資期貨部位方向的直接籌碼訊號
//   資料：data/taifex_foreign_oi.json（fetch_taifex_foreign_oi.py 抓 TAIFEX 官方,免 key）

import { isLight, tc, mob } from '../utils/theme.js';

let chart = null;
let range = "MAX";
let rows  = null;

async function loadAll() {
  if (rows) return;
  const r = await fetch("data/taifex_foreign_oi.json", { cache: "no-cache" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  rows = (j?.data ?? []).filter(x => x.tx_foreign_net_oi != null).map(x => ({ ...x }));
}

function cutoffDate(key) {
  if (key === "MAX") return "0000-00-00";
  const d = new Date();
  const m = { "3M": 3, "6M": 6, "1Y": 12 }[key] ?? 999;
  d.setMonth(d.getMonth() - m);
  return d.toISOString().slice(0, 10);
}

function setText(id, txt, color) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = txt;
  if (color) el.style.color = color;
}

function lastNonNull() {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].tx_foreign_net_oi != null) return rows[i];
  return null;
}
function nthAgo(n) {
  // 從最後一筆往回第 n 筆(交易日)
  const idx = rows.length - 1 - n;
  return idx >= 0 ? rows[idx] : null;
}

function fmt(v) { return (v >= 0 ? "+" : "") + v.toLocaleString("en-US") + " 口"; }

function updateCards() {
  const last = lastNonNull();
  if (!last) return;
  const v = last.tx_foreign_net_oi;
  const clr = v >= 0 ? "#3fb950" : "#f85149";
  setText("taifex-net-val", fmt(v), clr);
  setText("taifex-net-sub", `${last.date} · 外資 TXF 未平倉淨額`, "var(--muted)");
  setText("taifex-net-signal", v >= 0 ? "外資淨多" : "外資淨空", clr);

  setText("taifex-dir-val", v >= 0 ? "淨多單" : "淨空單", clr);
  setText("taifex-dir-sub", `${Math.abs(v).toLocaleString("en-US")} 口`, "var(--muted)");
  setText("taifex-dir-signal", "台指期外資部位方向", "var(--muted)");

  const wkAgo = nthAgo(5);
  if (wkAgo) {
    const chg = v - wkAgo.tx_foreign_net_oi;
    const c2 = chg >= 0 ? "#3fb950" : "#f85149";
    setText("taifex-chg-val", (chg >= 0 ? "+" : "") + chg.toLocaleString("en-US") + " 口", c2);
    setText("taifex-chg-sub", `vs ${wkAgo.date}(約一週前)`, "var(--muted)");
    setText("taifex-chg-signal", chg >= 0 ? "增加多方部位" : "增加空方部位", c2);
  }
}

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

  const status = document.getElementById("taifex-status");
  if (status) status.textContent =
    `台指期外資未平倉 · ${dates.length} 個交易日（${range}）· TAIFEX 三大法人`;

  const zeroLine = {
    silent: true, symbol: "none",
    lineStyle: { color: "#8b949e", type: "dashed", width: 1, opacity: 0.6 },
    label: { formatter: "0（多空平衡）", color: "#8b949e", fontSize: 9, position: "insideEndTop" },
    data: [{ yAxis: 0 }],
  };

  chart.setOption({
    backgroundColor: "transparent", animation: false,
    tooltip: {
      trigger: "axis", axisPointer: { type: "cross" },
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        const p = params[0];
        if (!p || p.value == null) return p?.axisValue ?? "";
        return `<div style="font-weight:600;margin-bottom:4px">${p.axisValue}</div>外資淨未平倉: <b>${fmt(+p.value)}</b>`;
      },
    },
    grid: { left: mob() ? 56 : 72, right: mob() ? 16 : 28, top: "8%", bottom: "12%" },
    xAxis: {
      type: "category", data: dates, boundaryGap: false,
      axisLine: { lineStyle: { color: axisClr } }, axisTick: { show: false },
      axisLabel: { color: axisClr, fontSize: 11 },
      splitLine: { show: false },
    },
    yAxis: [{
      type: "value", scale: true, name: "口數",
      nameTextStyle: { color: axisClr, fontSize: 10 },
      axisLabel: { color: axisClr, fontSize: 11, formatter: v => (v / 1000).toFixed(0) + "k" },
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: gridClr } },
    }],
    dataZoom: [{ type: "inside", filterMode: "none" }],
    series: [{
      name: "外資淨未平倉", type: "line",
      data: view.map(r => r.tx_foreign_net_oi != null ? r.tx_foreign_net_oi : null),
      symbol: "none", connectNulls: true,
      itemStyle: { color: "#58a6ff" },
      lineStyle: { color: "#58a6ff", width: 2 },
      areaStyle: { color: "rgba(88,166,255,0.12)" },
      markLine: zeroLine,
    }],
  }, { notMerge: true });
}

function buildControls() {
  const rp = document.getElementById("taifex-range-picker");
  if (rp && !rp.dataset.built) {
    rp.dataset.built = "1";
    rp.addEventListener("click", e => {
      const t = e.target.closest(".chip[data-taifex-range]");
      if (!t) return;
      range = t.dataset.taifexRange;
      rp.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c === t));
      render();
    });
  }
}

export async function activate() {
  const host = document.getElementById("taifex-chart");
  if (!host) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : "dark");
  buildControls();
  try {
    await loadAll();
    setTimeout(() => { chart?.resize(); render(); }, 50);
  } catch (e) {
    const s = document.getElementById("taifex-status");
    if (s) s.textContent = "載入失敗：" + (e.message || e);
    console.error("[taifex_foreign_oi] load failed", e);
  }
}
export function onThemeChange(light) {
  if (!chart) return;
  chart.dispose();
  chart = echarts.init(document.getElementById("taifex-chart"), light ? null : "dark");
  if (rows) render();
}
export function resize() { chart?.resize(); }
