// QQQ/SPY 長期相對強度比值 tab — Nasdaq(QQQ) 相對大盤(SPY) 的長期價格比
//   主圖：ratio = QQQ.close / SPY.close 時序線（log scale）+ dotcom_peak/bust_trough/current 三個關鍵點標註
//   資料：data/relstrength.json（scripts/prep_relstrength.py 由本地 QQQ.json/SPY.json 對齊產生，免 key）
//   已知限制：QQQ 1999-03 才成立，本地資料自 2000-01-03 起，無法涵蓋 1995-1999；
//             ratio 為未還原息價格比（不含股息），方法論比照原始靈感來源（SpotGamma NDX/SPX 比較圖，同樣排除股息）。

import { isLight, tc, mob, PALETTE } from '../utils/theme.js';

const RATIO_COLOR = "#58a6ff";

let chart = null;
let range = "MAX";
let payload = null; // full parsed json: { data, dotcom_peak, bust_trough, current, updated }

async function loadAll() {
  if (payload) return;
  const r = await fetch("data/relstrength.json", { cache: "no-cache" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  payload = j;
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
  const peak = payload.dotcom_peak;
  const trough = payload.bust_trough;
  if (!cur || !peak || !trough) return;

  const vsCol = PALETTE.text;
  const pctOfPeak = (cur.ratio / peak.ratio) * 100;

  setText("relstrength-current-val", cur.ratio.toFixed(4), vsCol);
  setText("relstrength-current-sub", `${cur.date} · QQQ / SPY（未還原息）`, "var(--muted)");
  setText("relstrength-current-signal", "最新比值", "var(--muted)");

  setText("relstrength-peak-val", peak.ratio.toFixed(4), vsCol);
  setText("relstrength-peak-sub", `${peak.date} · 2000上半年區域高點`, "var(--muted)");
  setText("relstrength-peak-signal", `現值為峰值的 ${pctOfPeak.toFixed(1)}%`, pctOfPeak >= 100 ? "#f85149" : "#3fb950");

  setText("relstrength-trough-val", trough.ratio.toFixed(4), vsCol);
  setText("relstrength-trough-sub", `${trough.date} · 2002下半年區域低點`, "var(--muted)");
  setText("relstrength-trough-signal", "dot-com 泡沫破裂低點", "var(--muted)");
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

  const status = document.getElementById("relstrength-status");
  if (status) status.textContent =
    `QQQ/SPY 長期相對強度 · ${dates.length} 個交易日（${range}）· 資料自 2000-01-03 起（未還原息）`;

  const L = mob() ? 44 : 56;
  const R = mob() ? 16 : 28;

  // Y 軸範圍（log scale）由實際資料 min/max 決定，留 padding，避免裁切
  const ratioVals = view.map(r => r.ratio).filter(v => v != null && v > 0);
  const dataMin = Math.min(...ratioVals);
  const dataMax = Math.max(...ratioVals);
  const yMin = dataMin / 1.15;
  const yMax = dataMax * 1.15;

  const peak = payload.dotcom_peak;
  const trough = payload.bust_trough;
  const cur = payload.current;

  // 找出這三個關鍵點在 view 中的位置（只有落在目前 range 內才標）
  function findPoint(dateStr, ratio) {
    const idx = dates.indexOf(dateStr);
    if (idx === -1) return null;
    return { name: dateStr, coord: [dateStr, ratio], value: ratio };
  }
  const markData = [];
  const peakPt = findPoint(peak.date, peak.ratio);
  const troughPt = findPoint(trough.date, trough.ratio);
  const curPt = findPoint(cur.date, cur.ratio);
  if (peakPt) markData.push({ ...peakPt, itemStyle: { color: "#f85149" }, label: { formatter: `dot-com峰值\n${peak.ratio.toFixed(3)}`, color: "#f85149", fontSize: 9, position: "top" } });
  if (troughPt) markData.push({ ...troughPt, itemStyle: { color: "#f0883e" }, label: { formatter: `泡沫低點\n${trough.ratio.toFixed(3)}`, color: "#f0883e", fontSize: 9, position: "bottom" } });
  if (curPt) markData.push({ ...curPt, itemStyle: { color: "#3fb950" }, label: { formatter: `現值\n${cur.ratio.toFixed(3)}`, color: "#3fb950", fontSize: 9, position: "top" } });

  const series = [{
    name: "QQQ/SPY 比值", type: "line", xAxisIndex: 0, yAxisIndex: 0,
    data: view.map(r => r.ratio != null ? +r.ratio.toFixed(6) : null),
    symbol: "none", connectNulls: true,
    itemStyle: { color: RATIO_COLOR },
    lineStyle: { color: RATIO_COLOR, width: 1.6 },
    z: 5,
    markPoint: {
      symbol: "circle", symbolSize: 8,
      data: markData,
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
          <div>QQQ: <b>${row.qqq.toFixed(2)}</b></div>
          <div>SPY: <b>${row.spy.toFixed(2)}</b></div>
          <div>${p.marker}比值: <b>${row.ratio.toFixed(4)}</b></div>`;
      },
    },
    legend: {
      data: ["QQQ/SPY 比值"], top: 2, left: "center",
      textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr,
    },
    grid: [{ left: L, right: R, top: "14%", height: "76%" }],
    xAxis: [
      { ...axBase, gridIndex: 0, axisLabel: { color: axisClr, fontSize: 10, rotate: isMob ? 30 : 0 } },
    ],
    yAxis: [
      {
        gridIndex: 0, type: "log", min: yMin, max: yMax, name: "QQQ/SPY（log）",
        nameTextStyle: { color: axisClr, fontSize: 10 },
        axisLabel: { color: axisClr, fontSize: 11, formatter: v => v.toFixed(2) },
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
  const rp = document.getElementById("relstrength-range-picker");
  if (rp && !rp.dataset.built) {
    rp.dataset.built = "1";
    rp.addEventListener("click", e => {
      const t = e.target.closest(".chip[data-relstrength-range]");
      if (!t) return;
      range = t.dataset.relstrengthRange;
      rp.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c === t));
      render();
    });
  }
}

// ── lifecycle ─────────────────────────────────────────────────────────
export async function activate() {
  const host = document.getElementById("relstrength-chart");
  if (!host) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : "dark");
  buildControls();
  try {
    await loadAll();
    setTimeout(() => { chart?.resize(); render(); }, 50);
  } catch (e) {
    const s = document.getElementById("relstrength-status");
    if (s) s.textContent = "載入失敗：" + (e.message || e);
    console.error("[relstrength] load failed", e);
  }
}
export function onThemeChange(light) {
  if (!chart) return;
  chart.dispose();
  chart = echarts.init(document.getElementById("relstrength-chart"), light ? null : "dark");
  if (payload) render();
}
export function resize() { chart?.resize(); }
