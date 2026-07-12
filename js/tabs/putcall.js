// Put/Call ratio tab — CBOE(2006-2019)接 OCC(2019+)每日賣權/買權比
//   高 P/C（>1）= 買保護/看空情緒濃 → 反向偏多；低 P/C（<0.7）= 貪婪 → 反向偏空
//   資料：data/putcall.json（fetch_putcall.py，CBOE 凍結 archive + OCC daily-volume-totals，免 key）
//   schema 為巢狀 by-series：{ total:[{date,pc}], equity:[{date,pc}] }

import { isLight, tc, mob } from '../utils/theme.js';

const LINES = [
  { key: "total_pc",  name: "Total P/C",  color: "#58a6ff" },
  { key: "equity_pc", name: "Equity P/C", color: "#e3b341" },
];

let chart = null;
let range = "3Y";
let rows  = null;

async function loadAll() {
  if (rows) return;
  const r = await fetch("data/putcall.json", { cache: "no-cache" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  // 巢狀 by-series → 依日期合併成 {date, total_pc, equity_pc}
  const map = new Map();
  for (const x of (j?.total ?? []))  { const o = map.get(x.date) || { date: x.date }; o.total_pc  = x.pc; map.set(x.date, o); }
  for (const x of (j?.equity ?? [])) { const o = map.get(x.date) || { date: x.date }; o.equity_pc = x.pc; map.set(x.date, o); }
  rows = [...map.values()].sort((a, b) => a.date < b.date ? -1 : 1);
}

function cutoffDate(key) {
  if (key === "MAX") return "0000-00-00";
  const d = new Date();
  const yrs = { "1Y": 1, "3Y": 3, "5Y": 5, "10Y": 10 }[key] ?? 3;
  d.setFullYear(d.getFullYear() - yrs);
  return d.toISOString().slice(0, 10);
}

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

// P/C 是反向情緒:高=看空氣氛濃(反向偏多)、低=貪婪(反向偏空)
function pcSignal(v) {
  if (v >= 1.0)  return { txt: "看空情緒濃（反向偏多）", clr: "#3fb950" };
  if (v >= 0.85) return { txt: "偏空", clr: "#7ee787" };
  if (v >= 0.7)  return { txt: "中性", clr: "var(--muted)" };
  return { txt: "貪婪（反向偏空）", clr: "#f85149" };
}

function updateCards() {
  const rt = lastNonNull("total_pc");
  const re = lastNonNull("equity_pc");
  if (rt) {
    const s = pcSignal(rt.total_pc);
    setText("putc-total-val", rt.total_pc.toFixed(3), s.clr);
    setText("putc-total-sub", `${rt.date} · Total Put/Call`, "var(--muted)");
    setText("putc-total-signal", s.txt, s.clr);
    setText("putc-state-val", s.txt, s.clr);
    setText("putc-state-sub", `Total P/C ${rt.total_pc.toFixed(3)}`, "var(--muted)");
    setText("putc-state-signal", "P/C 為反向情緒指標", "var(--muted)");
  }
  if (re) {
    const s = pcSignal(re.equity_pc);
    setText("putc-equity-val", re.equity_pc.toFixed(3), s.clr);
    setText("putc-equity-sub", `${re.date} · Equity Put/Call`, "var(--muted)");
    setText("putc-equity-signal", s.txt, s.clr);
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

  const status = document.getElementById("putc-status");
  if (status) status.textContent =
    `Put/Call · ${dates.length} 個交易日（${range}）· CBOE archive + OCC`;

  const L = mob() ? 40 : 52;
  const R = mob() ? 16 : 28;

  const oneLine = {
    silent: true, symbol: "none",
    lineStyle: { color: "#8b949e", type: "dashed", width: 1, opacity: 0.6 },
    label: { formatter: "1.0（多空均衡）", color: "#8b949e", fontSize: 9, position: "insideEndTop" },
    data: [{ yAxis: 1 }],
  };

  const series = [];
  for (const ln of LINES) {
    series.push({
      name: ln.name, type: "line",
      data: view.map(r => r[ln.key] != null ? +r[ln.key].toFixed(3) : null),
      symbol: "none", connectNulls: true,
      itemStyle: { color: ln.color },
      lineStyle: { color: ln.color, width: ln.key === "total_pc" ? 2 : 1.3 },
      yAxisIndex: 0, z: ln.key === "total_pc" ? 5 : 3,
      markLine: ln.key === "total_pc" ? oneLine : undefined,
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
          html += `<div>${p.marker}${p.seriesName}: <b>${(+p.value).toFixed(3)}</b></div>`;
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
      type: "value", scale: true, name: "P/C",
      nameTextStyle: { color: axisClr, fontSize: 10 },
      axisLabel: { color: axisClr, fontSize: 11, formatter: v => v.toFixed(2) },
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: gridClr } },
    }],
    dataZoom: [{ type: "inside", filterMode: "none" }],
    series,
  }, { notMerge: true });
}

function buildControls() {
  const rp = document.getElementById("putc-range-picker");
  if (rp && !rp.dataset.built) {
    rp.dataset.built = "1";
    rp.addEventListener("click", e => {
      const t = e.target.closest(".chip[data-putc-range]");
      if (!t) return;
      range = t.dataset.putcRange;
      rp.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c === t));
      render();
    });
  }
}

export async function activate() {
  const host = document.getElementById("putc-chart");
  if (!host) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : "dark");
  buildControls();
  try {
    await loadAll();
    setTimeout(() => { chart?.resize(); render(); }, 50);
  } catch (e) {
    const s = document.getElementById("putc-status");
    if (s) s.textContent = "載入失敗：" + (e.message || e);
    console.error("[putcall] load failed", e);
  }
}
export function onThemeChange(light) {
  if (!chart) return;
  chart.dispose();
  chart = echarts.init(document.getElementById("putc-chart"), light ? null : "dark");
  if (rows) render();
}
export function resize() { chart?.resize(); }
