// 通膨 Nowcast tab — Cleveland Fed Inflation Nowcasting(CPI/PCE 當月即時預估)
//   ⚠️ 這是「對當前/近未來月份的模型預估」,date 語意=預估目標期,非已實現值;
//      故與其他 tab「不留未來日期」慣例刻意不同(官網只給最近 1-2 期,靠 CI 逐日累積歷史)
//   資料：data/infl_nowcast.json（fetch_infl_nowcast.py 解析 Cleveland Fed HTML table,免 key）

import { isLight, tc, mob } from '../utils/theme.js';

// 最新月的四個 YoY 預估 + 2% Fed 目標參考
const YOY = [
  { key: "cpi_yoy",      name: "CPI",      color: "#58a6ff" },
  { key: "core_cpi_yoy", name: "Core CPI", color: "#79c0ff" },
  { key: "pce_yoy",      name: "PCE",      color: "#e3b341" },
  { key: "core_pce_yoy", name: "Core PCE", color: "#f0883e" },
];

let chart = null;
let payload = null;

async function loadAll() {
  if (payload) return;
  const r = await fetch("data/infl_nowcast.json", { cache: "no-cache" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  payload = await r.json();
}

function setText(id, txt, color) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = txt;
  if (color) el.style.color = color;
}

function latestMonth() {
  const d = payload?.data ?? [];
  return d.length ? d[d.length - 1] : null;
}

function updateCards() {
  const m = latestMonth();
  if (!m) return;
  const fmt = v => v == null ? "—" : (v >= 0 ? "" : "") + v.toFixed(2) + "%";
  const clrOf = v => v == null ? "var(--muted)" : (v > 2 ? "#f85149" : v < 1.5 ? "#3fb950" : "#e3b341");

  setText("nowc-cpi-val", fmt(m.cpi_yoy), clrOf(m.cpi_yoy));
  setText("nowc-cpi-sub", `${m.date} 預估 · CPI YoY`, "var(--muted)");
  setText("nowc-cpi-signal", m.cpi_yoy > 2 ? "高於 2% 目標" : "接近/低於目標", clrOf(m.cpi_yoy));

  setText("nowc-corecpi-val", fmt(m.core_cpi_yoy), clrOf(m.core_cpi_yoy));
  setText("nowc-corecpi-sub", `${m.date} 預估 · Core CPI YoY`, "var(--muted)");
  setText("nowc-corecpi-signal", "剔除食物能源", "var(--muted)");

  setText("nowc-corepce-val", fmt(m.core_pce_yoy), clrOf(m.core_pce_yoy));
  setText("nowc-corepce-sub", `${m.date} 預估 · Core PCE YoY`, "var(--muted)");
  setText("nowc-corepce-signal", "Fed 最看重", "var(--muted)");
}

export function render() {
  if (!chart) return;
  const m = latestMonth();

  const axisClr = tc("#8b949e", "#57606a");
  const gridClr = tc("rgba(48,54,61,0.5)", "rgba(208,215,222,0.4)");
  const tipBg   = tc("#161b22", "#ffffff");
  const tipBdr  = tc("#30363d", "#d0d7de");
  const textClr = tc("#c9d1d9", "#24292f");

  updateCards();

  const status = document.getElementById("nowc-status");
  if (status) status.textContent = m
    ? `Cleveland Fed Nowcast · 最新預估目標月 ${m.date} · ⚠️預估值非實績,歷史靠每日累積`
    : "尚無資料";

  if (!m) { chart.clear(); return; }

  const cats = YOY.map(y => y.name);
  const vals = YOY.map(y => m[y.key] != null ? +m[y.key].toFixed(2) : null);
  const colors = YOY.map(y => y.color);

  const targetLine = {
    silent: true, symbol: "none",
    lineStyle: { color: "#f85149", type: "dashed", width: 1, opacity: 0.7 },
    label: { formatter: "2% Fed 目標", color: "#f85149", fontSize: 10, position: "insideEndTop" },
    data: [{ yAxis: 2 }],
  };

  chart.setOption({
    backgroundColor: "transparent", animation: false,
    tooltip: {
      trigger: "axis", axisPointer: { type: "shadow" },
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        const p = params[0];
        return `${p.axisValue} YoY: <b>${p.value == null ? "—" : (+p.value).toFixed(2) + "%"}</b>`;
      },
    },
    grid: { left: mob() ? 40 : 52, right: mob() ? 16 : 28, top: "14%", bottom: "10%" },
    xAxis: {
      type: "category", data: cats,
      axisLine: { lineStyle: { color: axisClr } }, axisTick: { show: false },
      axisLabel: { color: textClr, fontSize: 12 },
    },
    yAxis: {
      type: "value", name: "YoY %",
      nameTextStyle: { color: axisClr, fontSize: 10 },
      axisLabel: { color: axisClr, fontSize: 11, formatter: v => v.toFixed(1) + "%" },
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: gridClr } },
    },
    series: [{
      type: "bar", data: vals.map((v, i) => ({ value: v, itemStyle: { color: colors[i] } })),
      barWidth: "48%",
      label: { show: true, position: "top", color: textClr, fontSize: 12, formatter: p => p.value == null ? "—" : p.value.toFixed(2) + "%" },
      markLine: targetLine,
    }],
  }, { notMerge: true });
}

export async function activate() {
  const host = document.getElementById("nowc-chart");
  if (!host) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : "dark");
  try {
    await loadAll();
    setTimeout(() => { chart?.resize(); render(); }, 50);
  } catch (e) {
    const s = document.getElementById("nowc-status");
    if (s) s.textContent = "載入失敗：" + (e.message || e);
    console.error("[infl_nowcast] load failed", e);
  }
}
export function onThemeChange(light) {
  if (!chart) return;
  chart.dispose();
  chart = echarts.init(document.getElementById("nowc-chart"), light ? null : "dark");
  if (payload) render();
}
export function resize() { chart?.resize(); }
