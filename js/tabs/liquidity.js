// 資金面 tab — 台股資金面綜合視圖
//   上 grid: 加權指數 (^TWII) + 櫃買指數 (^TWOII, 可切)
//   下 grid: M1B-M2 同比利差（黃柱，月頻拉平到日頻）
//           + 融資餘額（紅線，億）+ 外資累計買超（綠線，億，window 內歸零起算）
// 邏輯重點：MacroMicro 看到的「指數新高 + 利差沒跟」背離，可手動 toggle markArea。

import { isLight, tc, mob } from '../utils/theme.js';

let liqChart = null;
let liqRange = "2Y";
let showTwoii   = true;
let showMargin  = true;
let showForeign = true;
let showDivergence = false;

// Cached raw data (loaded once)
let twii = null;       // [{date,close}]
let twoii = null;      // [{date,close}]
let money = null;      // { monthly:[{date,m1b_yoy,m2_yoy,spread}], annual:[...] }
let margin = null;     // [{date,margin_yi,short_units}]
let investors = null;  // [{date,foreign,foreign_cum,...}]

async function loadAll() {
  const fetchJson = async (path, optional = false) => {
    try {
      const r = await fetch(path, { cache: "no-cache" });
      if (!r.ok) { if (optional) return null; throw new Error(`${path}: HTTP ${r.status}`); }
      return await r.json();
    } catch (e) {
      if (optional) { console.warn(`[liquidity] optional load failed: ${path}`, e); return null; }
      throw e;
    }
  };

  const [tw, tot, mon, mar, inv] = await Promise.all([
    fetchJson("data/TWII.json"),
    fetchJson("data/TWOII.json", true),
    fetchJson("data/taiwan_money_supply.json"),
    fetchJson("data/taiwan_margin_total.json", true),
    fetchJson("data/taiwan_investors.json", true),
  ]);
  twii  = (tw?.data  ?? []).map(r => [r.date, r.close]);
  twoii = (tot?.data ?? []).map(r => [r.date, r.close]);
  money = mon ?? { monthly: [], annual: [] };
  margin    = (mar?.data ?? []).map(r => [r.date, r.margin_money, r.short_lots ?? null]);
  investors = (inv?.data ?? []).map(r => [r.date, r.foreign, r.foreign_cum]);
}

function rangeStart(rangeKey) {
  if (rangeKey === "MAX") return "1900-01-01";
  const d = new Date();
  const map = { "1Y": 1, "2Y": 2, "5Y": 5, "10Y": 10 };
  d.setFullYear(d.getFullYear() - (map[rangeKey] ?? 2));
  return d.toISOString().slice(0, 10);
}

function filterByDate(rows, from) {
  return rows.filter(r => r[0] >= from);
}

// Build a daily-grain spread series by holding monthly value forward to next month
function spreadAsDaily(monthlyRows, dailyDates) {
  if (!monthlyRows.length || !dailyDates.length) return [];
  const sorted = monthlyRows.slice().sort((a, b) => a.date.localeCompare(b.date));
  const out = [];
  let mi = 0;
  for (const d of dailyDates) {
    while (mi + 1 < sorted.length && sorted[mi + 1].date <= d) mi++;
    const cur = sorted[mi];
    if (cur && cur.date <= d) out.push([d, cur.spread]);
  }
  return out;
}

// Re-anchor foreign cumulative to zero at the window start
function rebaseCumulative(rows, from) {
  // rows: [date, foreign_daily, foreign_cum]
  const filtered = rows.filter(r => r[0] >= from);
  if (!filtered.length) return [];
  let acc = 0;
  return filtered.map(r => { acc += r[1] || 0; return [r[0], +acc.toFixed(2)]; });
}

// Detect divergence intervals: TAIEX makes new high vs prior 6M but spread is below
// its prior 6M average. Greedy merge of adjacent monthly windows.
function detectDivergence(twiiF, monthlyAll, from) {
  if (!twiiF.length || !monthlyAll.length) return [];
  const months = monthlyAll.filter(m => m.date >= from);
  // Build month → spread, also a 6M lookback avg
  const indexByDate = new Map(twiiF.map((r, i) => [r[0], i]));
  const zones = [];
  let zStart = null, zEnd = null;
  for (let i = 0; i < months.length; i++) {
    const m = months[i];
    // closest TWII bar
    let twPt = null;
    for (let j = indexByDate.get(m.date) ?? 0; j < twiiF.length && twiiF[j][0] <= m.date.slice(0, 7) + "-31"; j++) twPt = twiiF[j];
    // fallback: scan
    if (!twPt) {
      const candidates = twiiF.filter(r => r[0] <= m.date);
      twPt = candidates[candidates.length - 1];
    }
    if (!twPt) continue;
    // Index 6M high
    const sixMoAgo = new Date(twPt[0]); sixMoAgo.setMonth(sixMoAgo.getMonth() - 6);
    const sixIso = sixMoAgo.toISOString().slice(0, 10);
    const hi6m = twiiF.filter(r => r[0] >= sixIso && r[0] <= twPt[0])
                      .reduce((a, r) => Math.max(a, r[1]), 0);
    const isHigh = twPt[1] >= hi6m * 0.995;
    // Spread 6M avg vs current
    const sixMonths = months.slice(Math.max(0, i - 5), i + 1);
    const avg = sixMonths.reduce((a, x) => a + x.spread, 0) / sixMonths.length;
    const spreadWeak = m.spread < avg && m.spread < 2.0;
    const div = isHigh && spreadWeak;
    if (div) {
      if (!zStart) zStart = m.date;
      zEnd = m.date;
    } else if (zStart) {
      zones.push([zStart, zEnd]);
      zStart = null;
    }
  }
  if (zStart) zones.push([zStart, zEnd]);
  return zones;
}

function fmt(n, dp = 2) {
  if (n == null || !isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return sign + (+n).toFixed(dp);
}

function renderSummary() {
  const lat = money?.latest;
  if (lat) {
    document.getElementById("lc-m1b").textContent = (+lat.m1b_yoy).toFixed(2);
    document.getElementById("lc-m1b").style.color = lat.m1b_yoy >= 6 ? "#22c55e" : lat.m1b_yoy >= 4 ? "" : "#f59e0b";
    document.getElementById("lc-m2").textContent  = (+lat.m2_yoy).toFixed(2);
    document.getElementById("lc-spread").textContent = fmt(lat.spread, 2);
    document.getElementById("lc-spread").style.color = lat.spread > 0 ? "#22c55e" : "#f0883e";
    document.getElementById("lc-m1b-date").textContent = "資料月 " + lat.date.slice(0, 7);
    document.getElementById("lc-m2-date").textContent  = "資料月 " + lat.date.slice(0, 7);
    document.getElementById("lc-spread-note").textContent = lat.spread > 1 ? "資金活絡，黃金交叉" : lat.spread > 0 ? "輕微正向" : "負利差 — 資金避險";
  }
  const margLat = margin?.[margin.length - 1];
  if (margLat) {
    document.getElementById("lc-margin").textContent = (margLat[1] / 1).toFixed(0);
    document.getElementById("lc-margin-date").textContent = margLat[0];
  }
  if (investors?.length) {
    // Sum last 30 trading days net foreign
    const tail = investors.slice(-30);
    const sum = tail.reduce((a, r) => a + (r[1] || 0), 0);
    const el = document.getElementById("lc-foreign");
    el.textContent = fmt(sum, 0);
    el.style.color = sum > 0 ? "#22c55e" : "#f85149";
    document.getElementById("lc-foreign-date").textContent = "最新 " + investors[investors.length - 1][0];
  }
}

export function render() {
  if (!liqChart) return;
  const from = rangeStart(liqRange);
  const twiiF = filterByDate(twii,  from);
  const twoiiF = filterByDate(twoii, from);
  const marginF = filterByDate(margin, from);
  const foreignCumF = rebaseCumulative(investors, from);
  const spreadDaily = spreadAsDaily(money.monthly, twiiF.map(r => r[0]));

  const axisClr = tc("#8b949e", "#57606a");
  const gridClr = tc("rgba(48,54,61,0.5)", "rgba(208,215,222,0.4)");
  const tipBg   = tc("#161b22", "#ffffff");
  const tipBdr  = tc("#30363d", "#d0d7de");
  const tipText = tc("#e6edf3", "#1f2328");

  const divergenceZones = showDivergence ? detectDivergence(twiiF, money.monthly, from) : [];
  const divergenceMarkArea = divergenceZones.map(([s, e]) => [
    { xAxis: s, itemStyle: { color: "rgba(239,68,68,0.10)" } },
    { xAxis: e },
  ]);

  const legendData = ["加權指數"];
  if (showTwoii)   legendData.push("櫃買指數");
  legendData.push("M1B-M2 利差");
  if (showMargin)  legendData.push("融資餘額");
  if (showForeign) legendData.push("外資累計");

  // === Y-axis layout ===
  // grid 0: TAIEX (left) + 櫃買 (right when toggled)
  // grid 1: spread (left, % units, ~−5..+15) + margin (right offset 0) + foreign (right offset ~70)
  const grid0YAxes = [
    { gridIndex: 0, scale: true, name: "加權",
      nameTextStyle: { color: tc("#e6edf3", "#1f2328"), fontSize: 11 },
      axisLine: { lineStyle: { color: axisClr } },
      axisLabel: { color: axisClr, fontSize: 11 },
      splitLine: { lineStyle: { color: gridClr } } },
  ];
  let twoiiAxisIdx = -1;
  if (showTwoii) {
    twoiiAxisIdx = grid0YAxes.length;
    grid0YAxes.push({ gridIndex: 0, scale: true, position: "right",
      name: "櫃買", nameTextStyle: { color: "#7c3aed", fontSize: 11 },
      axisLine: { lineStyle: { color: "#7c3aed" } },
      axisLabel: { color: "#7c3aed", fontSize: 11 }, splitLine: { show: false } });
  }
  const spreadAxisIdx = grid0YAxes.length;
  const grid1YAxes = [
    { gridIndex: 1, scale: true, name: "M1B-M2 (%)", nameTextStyle: { color: "#e3b341", fontSize: 11 },
      axisLine: { lineStyle: { color: "#e3b341" } },
      axisLabel: { color: "#e3b341", fontSize: 11, formatter: v => v.toFixed(1) },
      splitLine: { lineStyle: { color: gridClr } },
      markLine: { silent: true, symbol: "none",
        data: [{ yAxis: 0, lineStyle: { color: axisClr, type: "dashed", width: 1, opacity: 0.5 } }] } },
  ];
  let marginAxisIdx = -1, foreignAxisIdx = -1;
  if (showMargin) {
    marginAxisIdx = grid0YAxes.length + grid1YAxes.length;
    grid1YAxes.push({ gridIndex: 1, scale: true, position: "right",
      name: "融資 (億)", nameTextStyle: { color: "#f85149", fontSize: 11 },
      axisLine: { lineStyle: { color: "#f85149" } },
      axisLabel: { color: "#f85149", fontSize: 11, formatter: v => v.toFixed(0) },
      splitLine: { show: false } });
  }
  if (showForeign) {
    foreignAxisIdx = grid0YAxes.length + grid1YAxes.length;
    grid1YAxes.push({ gridIndex: 1, scale: true, position: "right",
      offset: showMargin ? (mob() ? 38 : 56) : 0,
      name: "外資累計 (億)", nameTextStyle: { color: "#22c55e", fontSize: 11 },
      axisLine: { lineStyle: { color: "#22c55e" } },
      axisLabel: { color: "#22c55e", fontSize: 11, formatter: v => v.toFixed(0) },
      splitLine: { show: false } });
  }
  // Final yAxis array (preserve indices)
  const yAxis = [...grid0YAxes, ...grid1YAxes];

  const rightPadGrid = (showMargin && showForeign) ? (mob() ? 90 : 120)
                    : (showMargin || showForeign) ? (mob() ? 50 : 70)
                    : (mob() ? 16 : 32);

  // === Series ===
  const series = [
    { name: "加權指數", type: "line", xAxisIndex: 0, yAxisIndex: 0, data: twiiF,
      symbol: "none",
      lineStyle: { width: 1.8, color: tc("#e6edf3", "#1f2937") },
      itemStyle: { color: tc("#e6edf3", "#1f2937") },
      markArea: divergenceMarkArea.length
        ? { silent: true, data: divergenceMarkArea } : undefined },
  ];
  if (showTwoii && twoiiF.length) {
    series.push({ name: "櫃買指數", type: "line", xAxisIndex: 0, yAxisIndex: twoiiAxisIdx,
      data: twoiiF, symbol: "none", lineStyle: { width: 1.4, color: "#7c3aed", type: "dashed" },
      itemStyle: { color: "#7c3aed" } });
  }
  series.push({ name: "M1B-M2 利差", type: "bar", xAxisIndex: 1, yAxisIndex: spreadAxisIdx,
    data: spreadDaily, barMaxWidth: 4,
    itemStyle: { color: p => (p.value?.[1] ?? 0) >= 0 ? "rgba(227,179,65,0.7)" : "rgba(248,81,73,0.55)" } });
  if (showMargin && marginF.length) {
    series.push({ name: "融資餘額", type: "line", xAxisIndex: 1, yAxisIndex: marginAxisIdx,
      data: marginF.map(r => [r[0], r[1]]),
      symbol: "none", lineStyle: { width: 1.5, color: "#f85149" }, itemStyle: { color: "#f85149" } });
  }
  if (showForeign && foreignCumF.length) {
    series.push({ name: "外資累計", type: "line", xAxisIndex: 1, yAxisIndex: foreignAxisIdx,
      data: foreignCumF, symbol: "none",
      lineStyle: { width: 1.5, color: "#22c55e" }, itemStyle: { color: "#22c55e" } });
  }

  liqChart.setOption({
    backgroundColor: "transparent",
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "cross", link: [{ xAxisIndex: "all" }] },
      backgroundColor: tipBg, borderColor: tipBdr,
      textStyle: { color: tipText, fontSize: 12 },
      formatter(params) {
        if (!params?.length) return "";
        const ts = params[0].axisValueLabel || params[0].axisValue;
        const dateLabel = typeof ts === "string" ? ts.slice(0, 10)
                        : new Date(ts).toISOString().slice(0, 10);
        const seen = new Set();
        let html = `<b>${dateLabel}</b><br/>`;
        for (const p of params) {
          if (seen.has(p.seriesName)) continue; seen.add(p.seriesName);
          const v = p.value?.[1];
          if (v == null) continue;
          const unit = p.seriesName === "M1B-M2 利差" ? "%"
                     : (p.seriesName === "融資餘額" || p.seriesName === "外資累計") ? " 億" : "";
          const formatted = (Math.abs(v) >= 1000) ? v.toFixed(0) : v.toFixed(2);
          html += `<span style="color:${p.color}">●</span> ${p.seriesName}: <b>${formatted}${unit}</b><br/>`;
        }
        return html;
      },
    },
    legend: { data: legendData, top: 4, textStyle: { color: tipText, fontSize: 12 } },
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    grid: [
      { left: mob() ? 50 : 72, right: rightPadGrid, top: 36, height: "52%" },
      { left: mob() ? 50 : 72, right: rightPadGrid, top: "64%", height: "26%" },
    ],
    xAxis: [
      { type: "time", gridIndex: 0, axisLabel: { show: false },
        axisLine: { lineStyle: { color: axisClr } }, splitLine: { show: false } },
      { type: "time", gridIndex: 1,
        axisLine: { lineStyle: { color: axisClr } },
        axisLabel: { color: axisClr, fontSize: 11 }, splitLine: { show: false } },
    ],
    yAxis,
    dataZoom: [
      { type: "inside", xAxisIndex: [0, 1] },
      { type: "slider", xAxisIndex: [0, 1], height: 16, bottom: 8,
        fillerColor: "rgba(88,166,255,0.12)",
        borderColor: tc("#30363d", "#d0d7de") },
    ],
    series,
  }, { notMerge: true });

  // Status line
  const lat = money?.latest;
  const latestTwii = twiiF[twiiF.length - 1];
  const statusEl = document.getElementById("liquidity-status");
  if (statusEl) {
    const parts = [];
    if (latestTwii) parts.push(`加權 ${latestTwii[1]?.toFixed(0)} (${latestTwii[0]})`);
    if (lat) parts.push(`M1B-M2 ${fmt(lat.spread, 2)}% (${lat.date.slice(0, 7)})`);
    if (divergenceZones.length) parts.push(`偵測到 ${divergenceZones.length} 段背離區`);
    parts.push(`範圍 ${liqRange}`);
    statusEl.textContent = parts.join(" · ");
  }
}

async function initOnce() {
  if (twii && money) return;
  await loadAll();
  renderSummary();
}

export async function activate() {
  const el = document.getElementById("liquidity-chart");
  if (!liqChart && el) {
    liqChart = echarts.init(el, isLight() ? null : "dark");
  }
  try {
    await initOnce();
    setTimeout(() => { liqChart?.resize(); render(); }, 50);
  } catch (e) {
    const s = document.getElementById("liquidity-status");
    if (s) s.textContent = "載入失敗：" + (e.message || e);
    console.error("[liquidity] load failed", e);
  }
}

export function onThemeChange(light) {
  if (!liqChart) return;
  liqChart.dispose();
  liqChart = echarts.init(document.getElementById("liquidity-chart"), light ? null : "dark");
  render();
}

export function resize() { liqChart?.resize(); }

// === Event wiring ===
document.getElementById("liq-twoii-toggle")?.addEventListener("click", e => {
  showTwoii = !showTwoii;
  e.currentTarget.classList.toggle("active", showTwoii);
  render();
});
document.getElementById("liq-margin-toggle")?.addEventListener("click", e => {
  showMargin = !showMargin;
  e.currentTarget.classList.toggle("active", showMargin);
  render();
});
document.getElementById("liq-foreign-toggle")?.addEventListener("click", e => {
  showForeign = !showForeign;
  e.currentTarget.classList.toggle("active", showForeign);
  render();
});
document.getElementById("liq-divergence-toggle")?.addEventListener("click", e => {
  showDivergence = !showDivergence;
  e.currentTarget.classList.toggle("active", showDivergence);
  render();
});
document.getElementById("liq-range-picker")?.addEventListener("click", e => {
  const t = e.target.closest(".chip[data-liq-range]");
  if (!t) return;
  liqRange = t.dataset.liqRange;
  for (const c of e.currentTarget.querySelectorAll(".chip"))
    c.classList.toggle("active", c === t);
  render();
});
