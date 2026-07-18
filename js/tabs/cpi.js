// CPI 分項 tab — 機械回答兩個問題:
//   (1) 這次降溫是「廣泛」的,還是「少數高波動項」(通常是能源)壓低平均?
//       → panel 2「分項貢獻度分解」+ panel 4「通膨廣度」
//   (2) 數據偏鴿之後,市場買不買單(殖利率有沒有跟著跌)?
//       → panel 6「市場解讀」
//
// 資料 data/cpi.json:
//   components[]  — 24 個 BLS CPI 分項(彼此有重疊,如 housing 是 services 的子集;
//                    僅供「各自的 MoM 走勢」熱力圖使用,不做橫向加總)
//   decomposition[]— 互斥且窮盡(MECE)五塊拆解 + residual_pp,sum(parts.contrib_pp)+residual_pp
//                    === headline_mom(資料層已驗證此恆等式);瀑布圖唯一該吃的資料源
//   breadth[] / sticky[] — 年化月增率(%),非指數
//   market[]      — DGS10/DGS2/T10YIE 日頻
//   release_dates — CPI 公布日(ALFRED)
//
// ⚠️ 無市場 consensus 預期資料(免費源撈不到),故不計算 CPI surprise,只呈現公布日當日反應。

import { isLight, tc, mob, PALETTE } from '../utils/theme.js';

const RED = "#f85149", ORANGE = "#f0883e", YELLOW = "#e3b341",
      BLUE = "#58a6ff", GREEN = "#3fb950", PURPLE = "#d2a8ff";

let payload   = null;
let compMap   = null;   // key -> component object (raw BLS 分項,含重疊)
let contribChart = null, heatChart = null, breadthChart = null, stickyChart = null, marketChart = null;
let cpiRange    = "10Y";
let showRollMin = true;

// ── load ────────────────────────────────────────────────────────────
async function loadAll() {
  if (payload) return;
  const r = await fetch("data/cpi.json", { cache: "no-cache" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  payload = await r.json();
  compMap = new Map((payload.components ?? []).map(c => [c.key, c]));
}

// ── small utils ─────────────────────────────────────────────────────
function setText(id, txt, color) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = txt;
  if (color) el.style.color = color;
}

function percentile(arr, p) {
  const s = arr.filter(v => v != null && !Number.isNaN(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

function rollingMin(rows, key, window) {
  const out = new Array(rows.length).fill(null);
  for (let i = 0; i < rows.length; i++) {
    let m = null;
    for (let j = Math.max(0, i - window + 1); j <= i; j++) {
      const v = rows[j][key];
      if (v != null && (m == null || v < m)) m = v;
    }
    out[i] = m;
  }
  return out;
}

function rangeStart(key) {
  if (key === "MAX") return "1900-01-01";
  const d = new Date();
  d.setFullYear(d.getFullYear() - ({ "1Y": 1, "3Y": 3, "5Y": 5, "10Y": 10 }[key] ?? 10));
  return d.toISOString().slice(0, 10);
}

function latestNonNull(rows, key) {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i][key] != null) return rows[i].date;
  }
  return null;
}

function dateLabel(firstParam) {
  const ts = firstParam?.axisValueLabel ?? firstParam?.axisValue;
  if (ts == null) return "";
  return typeof ts === "string" ? ts.slice(0, 10) : new Date(ts).toISOString().slice(0, 10);
}

// ── 1. 頂部 readout ─────────────────────────────────────────────────
function updateCards() {
  const mmap = new Map((payload.momentum ?? []).map(m => [m.key, m]));
  const headlineComp = compMap.get("headline");
  const latestDate = headlineComp?.data?.at(-1)?.date ?? "—";
  const monthLabel = latestDate === "—" ? "—" : latestDate.slice(0, 7);

  const fmtPct = v => v == null ? "—" : (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
  const momClr = v => v == null ? "var(--muted)" : v > 0.3 ? RED : v < 0 ? GREEN : YELLOW;
  const momSig = v => v == null ? "—" : v < 0 ? "MoM 降溫" : v > 0.3 ? "MoM 升溫" : "持平";

  const cards = [
    { key: "headline",            id: "cpi-headline", extra: () => `YoY ${fmtPct(mmap.get("headline")?.yoy)}｜${monthLabel}` },
    { key: "core",                id: "cpi-core",      extra: () => `YoY ${fmtPct(mmap.get("core")?.yoy)}｜${monthLabel}` },
    { key: "shelter",             id: "cpi-housing",   extra: () => `YoY ${fmtPct(mmap.get("shelter")?.yoy)}｜權重 ${compMap.get("shelter")?.weight?.toFixed(1) ?? "—"}%` },
    { key: "services_ex_energy",  id: "cpi-svc",        extra: () => `YoY ${fmtPct(mmap.get("services_ex_energy")?.yoy)}｜權重 ${compMap.get("services_ex_energy")?.weight?.toFixed(1) ?? "—"}%` },
  ];
  for (const c of cards) {
    const m = mmap.get(c.key);
    setText(`${c.id}-val`, fmtPct(m?.mom), momClr(m?.mom));
    setText(`${c.id}-sub`, c.extra(), "var(--muted)");
    setText(`${c.id}-signal`, momSig(m?.mom), momClr(m?.mom));
  }
}

// ── 2. 分項貢獻度分解(MECE,吃 decomposition)────────────────────────
function populateDecompPicker() {
  const sel = document.getElementById("cpi-decomp-month");
  if (!sel || sel.dataset.built) return;
  const decomp = payload.decomposition ?? [];
  sel.innerHTML = decomp.map(d => `<option value="${d.date}">${d.date.slice(0, 7)}</option>`).join("");
  if (decomp.length) sel.value = decomp[decomp.length - 1].date;
  sel.dataset.built = "1";
  sel.addEventListener("change", () => renderContrib(sel.value));
}

function renderContrib(selectedDate) {
  if (!contribChart) return;
  const decomp = payload.decomposition ?? [];
  const sub = document.getElementById("cpi-contrib-subtitle");
  if (!decomp.length) {
    contribChart.clear();
    if (sub) sub.textContent = "⚠️ 資料尚無 decomposition(MECE 拆解)區塊,無法繪製此圖";
    return;
  }
  const row = decomp.find(d => d.date === selectedDate) ?? decomp[decomp.length - 1];

  const axisClr = PALETTE.muted;
  const gridClr = tc("rgba(48,54,61,0.5)", "rgba(208,215,222,0.4)");
  const tipBg   = PALETTE.bg;
  const tipBdr  = PALETTE.border;
  const textClr = PALETTE.text2;
  const GREY    = axisClr;

  const items = [
    ...(row.parts ?? []).map(p => ({ label: p.label, contrib: p.contrib_pp, weight: p.weight, mom: p.mom, isResidual: false })),
    { label: "近似誤差", contrib: row.residual_pp, weight: null, mom: null, isResidual: true },
  ].filter(it => it.contrib != null)
   .sort((a, b) => a.contrib - b.contrib);

  if (sub) sub.textContent =
    `${row.date.slice(0, 7)} · Headline MoM 合計 ${row.headline_mom >= 0 ? "+" : ""}${row.headline_mom.toFixed(2)}% ` +
    `· 能源/食品/核心商品/住房/核心服務(扣住房)五塊 MECE 拆解 + 近似誤差 = headline · ` +
    `contrib_pp 為 weight×MoM 一階近似,非 BLS 官方 chained 公式,誤差不隱藏、不塞進其他分項`;

  // residual-vs-signal sanity check: "非能源合計" = headline_mom − energy_contrib (i.e.
  // everything except energy, backed out from the MECE total, which folds the residual
  // back in). If |residual| >= |non-energy total|, the approximation error is AS BIG OR
  // BIGGER than the very number we're trying to read ("is ex-energy CPI cooling?") — so
  // that reading is not statistically distinguishable from noise this month and must say so.
  const noteEl = document.getElementById("cpi-residual-note");
  if (noteEl) {
    const energyPart = (row.parts ?? []).find(p => p.key === "energy");
    if (energyPart?.contrib_pp != null && row.headline_mom != null && row.residual_pp != null) {
      const nonEnergyTotal = row.headline_mom - energyPart.contrib_pp;
      const fmt = v => (v >= 0 ? "+" : "") + v.toFixed(3) + "pp";
      if (Math.abs(row.residual_pp) >= Math.abs(nonEnergyTotal)) {
        noteEl.innerHTML =
          `⚠️ <b>${row.date.slice(0, 7)}:近似誤差(${fmt(row.residual_pp)})大於「非能源合計」(${fmt(nonEnergyTotal)})</b>,` +
          `因此「扣掉能源後,其他項是否真的在降溫」在一階近似的誤差範圍內<b>無法確認</b>;要判斷廣度應改看下方 Median/Trimmed Mean(惟該序列可能尚未發布最新月份,見「通膨廣度」格揭露)。`;
      } else {
        noteEl.innerHTML =
          `${row.date.slice(0, 7)}:近似誤差(${fmt(row.residual_pp)})小於「非能源合計」(${fmt(nonEnergyTotal)}),此月的非能源訊號大於近似誤差雜訊,方向性可信度較高——但仍建議搭配下方 Median/Trimmed Mean 交叉確認。`;
      }
    } else {
      noteEl.textContent = "⚠️ 此期缺 energy 分項或 residual 資料,無法計算誤差/訊號比較。";
    }
  }

  // axis must cover bars AND the headline_mom reference markLine AND 0, or the dashed
  // line / a bar can be clipped off-canvas (see comment on xAxis below). Bounds are then
  // snapped outward to a 0.05 grid — leaving them as raw padded floats (e.g. 0.1116)
  // makes echarts insert an extra unaligned boundary tick that overlaps the last "nice"
  // tick label (observed: "0.1" and "0.1116" rendered on top of each other).
  const rawVals = [...items.map(it => it.contrib), row.headline_mom, 0].filter(v => v != null);
  const vMin = Math.min(...rawVals), vMax = Math.max(...rawVals);
  const STEP = 0.05;
  const xMin = Math.floor(vMin / STEP) * STEP - STEP;
  const xMax = Math.ceil(vMax / STEP) * STEP + STEP;

  contribChart.setOption({
    backgroundColor: "transparent", animation: false,
    tooltip: {
      trigger: "axis", axisPointer: { type: "shadow" },
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter: params => {
        const p = params[0];
        const it = items[p.dataIndex];
        if (!it) return "";
        if (it.isResidual) {
          return `<b>近似誤差</b><br/>${it.contrib >= 0 ? "+" : ""}${it.contrib.toFixed(3)}pp（一階近似 + 權重 vintage 造成,非遺漏）`;
        }
        return `<b>${it.label}</b><br/>貢獻 ${it.contrib >= 0 ? "+" : ""}${it.contrib.toFixed(3)}pp｜權重 ${it.weight?.toFixed(2) ?? "—"}%｜MoM ${it.mom != null ? (it.mom >= 0 ? "+" : "") + it.mom.toFixed(2) + "%" : "—"}`;
      },
    },
    grid: { left: mob() ? 104 : 154, right: mob() ? 30 : 54, top: 16, bottom: 28 },
    xAxis: {
      // explicit min/max: echarts' auto "scale" only looks at series (bar) values, NOT
      // markLine data — the headline_mom reference line can sit outside the bars' own
      // range (e.g. when the residual/parts don't span as wide as headline itself) and
      // get silently clipped off-canvas. Compute the range from bars + headline_mom + 0
      // together so the reference line is always visible.
      type: "value", name: "貢獻度 (pp)",
      min: xMin, max: xMax, splitNumber: 5,
      nameTextStyle: { color: axisClr, fontSize: 10 },
      axisLabel: { color: axisClr, fontSize: 11, formatter: v => v.toFixed(2) },
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: gridClr } },
    },
    yAxis: {
      type: "category", data: items.map(it => it.label),
      axisLabel: { color: textClr, fontSize: 12 },
      axisLine: { lineStyle: { color: axisClr } }, axisTick: { show: false },
    },
    series: [{
      type: "bar", barWidth: "55%",
      data: items.map(it => ({
        value: +it.contrib.toFixed(3),
        itemStyle: { color: it.isResidual ? GREY : (it.contrib >= 0 ? RED : GREEN) },
        label: { position: it.contrib >= 0 ? "right" : "left" },
      })),
      label: {
        show: true, color: textClr, fontSize: 12,
        formatter: p => (p.value >= 0 ? "+" : "") + p.value.toFixed(3),
      },
      markLine: {
        silent: true, symbol: "none",
        data: [
          { xAxis: 0, lineStyle: { color: axisClr, width: 1, opacity: 0.6 } },
          ...(row.headline_mom != null ? [{
            xAxis: +row.headline_mom.toFixed(3),
            lineStyle: { color: textClr, type: "dashed", width: 1.6, opacity: 0.9 },
            label: { formatter: `Headline MoM ${row.headline_mom >= 0 ? "+" : ""}${row.headline_mom.toFixed(2)}%`, color: textClr, fontSize: 10, position: "insideEndTop" },
          }] : []),
        ],
      },
    }],
  }, { notMerge: true });
}

// ── 3. 分項熱力圖(吃 components,rows 依 group 分組;Headline/Core 獨立置頂)──
function renderHeatmap() {
  if (!heatChart) return;
  const comps = payload.components ?? [];
  if (!comps.length) { heatChart.clear(); return; }

  const dateSet = new Set();
  for (const c of comps) for (const d of c.data) dateSet.add(d.date);
  const cols = [...dateSet].sort().slice(-24);
  const colLabels = cols.map(d => d.slice(0, 7));

  const AGG_KEYS = ["headline", "core"];
  const aggRows  = AGG_KEYS.map(k => comps.find(c => c.key === k)).filter(Boolean);
  const leafRows = comps.filter(c => !AGG_KEYS.includes(c.key));
  // category yAxis renders array index 0 at the BOTTOM and the last index at the TOP,
  // so aggRows (Headline/Core) go LAST in the array to land in their own block at the
  // visual top, separated from the leaf rows by a blank spacer row.
  const rows = [...leafRows, { spacer: true, label: "" }, ...aggRows];
  const rowLabels = rows.map(r => r.label);

  const heatData = [];
  const allVals = [];
  rows.forEach((r, ri) => {
    if (r.spacer) return;
    const map = new Map(r.data.map(d => [d.date, d.mom]));
    cols.forEach((d, ci) => {
      const v = map.get(d);
      if (v != null) { heatData.push([ci, ri, +v.toFixed(3)]); allVals.push(v); }
      else heatData.push([ci, ri, null]);
    });
  });

  const p5 = percentile(allVals, 0.05), p95 = percentile(allVals, 0.95);
  const bound = Math.max(Math.abs(p5 ?? 0), Math.abs(p95 ?? 0), 0.05);

  const axisClr = PALETTE.muted;
  const tipBg   = PALETTE.bg;
  const tipBdr  = PALETTE.border;
  const textClr = PALETTE.text2;
  const neutral = tc("#21262d", "#f0f2f5");
  const cellBdr = PALETTE.cellBorder;

  heatChart.setOption({
    backgroundColor: "transparent", animation: false,
    tooltip: {
      trigger: "item",
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter: p => {
        const v = p.value?.[2];
        const label = rowLabels[p.value[1]];
        if (v == null) return `<b>${label}</b><br/>${colLabels[p.value[0]]}：無資料`;
        const flag = (v < -bound || v > bound) ? "（超出色階範圍,以極端色顯示,此為真值）" : "";
        return `<b>${label}</b><br/>${colLabels[p.value[0]]} MoM：<b>${v >= 0 ? "+" : ""}${v.toFixed(2)}%</b>${flag}`;
      },
    },
    // grid.bottom must reserve room for BOTH the rotated x-axis labels and the visualMap
    // legend below them — otherwise the legend bar renders on top of the data cells and
    // reads as a fake column.
    grid: { left: mob() ? 96 : 150, right: mob() ? 16 : 24, top: 12, bottom: 96 },
    xAxis: {
      type: "category", data: colLabels, splitArea: { show: true },
      axisLabel: { color: axisClr, fontSize: 10, rotate: 45 },
      axisLine: { lineStyle: { color: axisClr } },
    },
    yAxis: {
      type: "category", data: rowLabels, splitArea: { show: true },
      axisLabel: {
        color: textClr, fontSize: 11,
        formatter: v => (v === "Headline CPI" || v === "Core CPI") ? `{agg|${v}}` : v,
        rich: { agg: { color: PALETTE.text, fontWeight: 700 } },
      },
      axisLine: { lineStyle: { color: axisClr } },
    },
    visualMap: {
      min: -bound, max: bound, orient: "horizontal", left: "center", bottom: 0,
      // continuous visualMap: itemHeight is the BAR LENGTH (long side), itemWidth its
      // thickness — swapping them renders a tiny vertical stub that reads as a data column.
      itemWidth: 14, itemHeight: 180,
      text: [`+${bound.toFixed(1)}%`, `−${bound.toFixed(1)}%`],
      textStyle: { color: textClr, fontSize: 11 },
      inRange: { color: [GREEN, neutral, RED] },
    },
    series: [{
      type: "heatmap", data: heatData,
      itemStyle: { borderColor: cellBdr, borderWidth: 1 },
      emphasis: { itemStyle: { shadowBlur: 6, shadowColor: "rgba(0,0,0,.3)" } },
    }],
  }, { notMerge: true });

  const s = document.getElementById("cpi-heatmap-subtitle");
  if (s) s.textContent =
    `色階以 5–95 百分位 clamp(±${bound.toFixed(2)}%)避免極端值(如油價驟跌)洗掉其餘格子的顏色層次,hover 可查真值 · ` +
    `Headline/Core 為總體項,獨立置頂不與底下細項同級比較 · 細項彼此有重疊(如「住房」是「服務」的子集),僅供各自 MoM 走勢對照,不做橫向加總`;
}

// ── 4. 通膨廣度 ─────────────────────────────────────────────────────
function renderBreadth() {
  if (!breadthChart) return;
  const all = payload.breadth ?? [];
  const rows = all.filter(r => r.date >= rangeStart(cpiRange));
  if (!rows.length) { breadthChart.clear(); return; }

  // honesty check: Cleveland Fed's Median/Trimmed Mean CPI is released on its own
  // schedule and can lag the headline BLS CPI print by a month — if so, the most
  // recent headline print's "is this broad-based cooling?" question is literally
  // unanswerable yet from this panel, and the chart must say so instead of letting
  // the reader assume the lines are current.
  const medDate    = latestNonNull(all, "median");
  const trimDate   = latestNonNull(all, "trimmed");
  const coreYoYDate = latestNonNull(all, "core_yoy");
  const headlineDate = compMap.get("headline")?.data?.at(-1)?.date ?? null;
  const sub = document.getElementById("cpi-breadth-subtitle");
  if (sub) {
    const lag = headlineDate && medDate && medDate < headlineDate;
    let txt = `Median/Trimmed 最新 ${medDate ?? "—"}｜Core YoY(本頁計算)最新 ${coreYoYDate ?? "—"}｜Headline 最新 ${headlineDate ?? "—"}`;
    if (lag) {
      txt = `⚠️ Median/Trimmed Mean CPI 最新僅到 ${medDate}(Cleveland Fed 尚未發布 ${headlineDate?.slice(0, 7)}),` +
            `本月「降溫是否廣泛」暫無法用這兩條線確認,線在 ${medDate.slice(0, 7)} 後如實中斷、不插值補點 · ` + txt;
    }
    sub.textContent = txt;
  }
  const breadthNote = document.getElementById("cpi-breadth-note");
  if (breadthNote) {
    breadthNote.innerHTML = (headlineDate && medDate && medDate < headlineDate)
      ? `⚠️ <b>本次「通膨廣度是否同步改善」目前仍無法確認</b>:Cleveland Fed 的 ${headlineDate.slice(0, 7)} Median/Trimmed Mean CPI 尚未發布(最新僅到 ${medDate.slice(0, 7)})。判斷廣度應等這兩條線更新,不要只看 Headline/Core 已經降溫就推論「普遍」降溫。`
      : `Median/Trimmed Mean CPI 與 Headline 同步至 ${medDate ?? "—"},廣度線已反映最新一期。`;
  }

  const axisClr = PALETTE.muted;
  const gridClr = tc("rgba(48,54,61,0.5)", "rgba(208,215,222,0.4)");
  const tipBg   = PALETTE.bg;
  const tipBdr  = PALETTE.border;
  const textClr = PALETTE.text2;

  breadthChart.setOption({
    backgroundColor: "transparent", animation: false,
    tooltip: {
      trigger: "axis", axisPointer: { type: "cross" },
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        if (!params.length) return "";
        const d = dateLabel(params[0]);
        let html = `<div style="font-weight:600;margin-bottom:4px">${d}</div>`;
        for (const p of params) {
          const v = Array.isArray(p.value) ? p.value[1] : p.value;
          if (v == null) continue;
          html += `<div>${p.marker}${p.seriesName}: <b>${(+v).toFixed(2)}%</b></div>`;
        }
        return html;
      },
    },
    grid: { left: mob() ? 40 : 52, right: mob() ? 16 : 28, top: "16%", bottom: "12%" },
    xAxis: {
      type: "time",
      axisLabel: { color: axisClr, fontSize: 11 }, axisLine: { lineStyle: { color: axisClr } },
      axisTick: { show: false }, splitLine: { show: false },
    },
    yAxis: {
      type: "value", scale: true, name: "年化 %",
      nameTextStyle: { color: axisClr, fontSize: 10 },
      axisLabel: { color: axisClr, fontSize: 11, formatter: v => v.toFixed(1) + "%" },
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: gridClr } },
    },
    legend: { top: 2, left: "center", textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr },
    dataZoom: [{ type: "inside", filterMode: "none" }],
    series: [
      { name: "中位數 Median CPI", type: "line", data: rows.map(r => [r.date, r.median]),
        symbol: "none", smooth: false, itemStyle: { color: BLUE }, lineStyle: { color: BLUE, width: 1.7 } },
      { name: "Trimmed Mean CPI", type: "line", data: rows.map(r => [r.date, r.trimmed]),
        symbol: "none", smooth: false, itemStyle: { color: ORANGE }, lineStyle: { color: ORANGE, width: 1.7 } },
      { name: "Core CPI YoY", type: "line", data: rows.map(r => [r.date, r.core_yoy]),
        symbol: "none", smooth: false, itemStyle: { color: PURPLE }, lineStyle: { color: PURPLE, width: 1.3, type: "dashed" } },
    ],
  }, { notMerge: true });
}

// ── 5. 黏性 vs 彈性 ─────────────────────────────────────────────────
function renderSticky() {
  if (!stickyChart) return;
  const rows = (payload.sticky ?? []).filter(r => r.date >= rangeStart(cpiRange));
  if (!rows.length) { stickyChart.clear(); return; }

  const axisClr = PALETTE.muted;
  const gridClr = tc("rgba(48,54,61,0.5)", "rgba(208,215,222,0.4)");
  const tipBg   = PALETTE.bg;
  const tipBdr  = PALETTE.border;
  const textClr = PALETTE.text2;

  stickyChart.setOption({
    backgroundColor: "transparent", animation: false,
    tooltip: {
      trigger: "axis", axisPointer: { type: "cross" },
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        if (!params.length) return "";
        const d = dateLabel(params[0]);
        let html = `<div style="font-weight:600;margin-bottom:4px">${d}</div>`;
        for (const p of params) {
          const v = Array.isArray(p.value) ? p.value[1] : p.value;
          if (v == null) continue;
          html += `<div>${p.marker}${p.seriesName}: <b>${(+v).toFixed(2)}%</b></div>`;
        }
        return html;
      },
    },
    grid: { left: mob() ? 40 : 52, right: mob() ? 16 : 28, top: "16%", bottom: "12%" },
    xAxis: {
      type: "time",
      axisLabel: { color: axisClr, fontSize: 11 }, axisLine: { lineStyle: { color: axisClr } },
      axisTick: { show: false }, splitLine: { show: false },
    },
    yAxis: {
      type: "value", scale: true, name: "年化 %",
      nameTextStyle: { color: axisClr, fontSize: 10 },
      axisLabel: { color: axisClr, fontSize: 11, formatter: v => v.toFixed(1) + "%" },
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: gridClr } },
    },
    legend: { top: 2, left: "center", textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr },
    dataZoom: [{ type: "inside", filterMode: "none" }],
    series: [
      { name: "Sticky CPI", type: "line", data: rows.map(r => [r.date, r.sticky]),
        symbol: "none", smooth: false, itemStyle: { color: RED }, lineStyle: { color: RED, width: 1.8 },
        markLine: { silent: true, symbol: "none", data: [
          { yAxis: 2, lineStyle: { color: axisClr, type: "dashed", width: 1, opacity: 0.7 },
            label: { formatter: "2% 目標", color: axisClr, fontSize: 10, position: "insideEndTop" } },
        ] } },
      { name: "Flex CPI", type: "line", data: rows.map(r => [r.date, r.flex]),
        symbol: "none", smooth: false, itemStyle: { color: GREEN }, lineStyle: { color: GREEN, width: 1.2, opacity: 0.85 } },
    ],
  }, { notMerge: true });
}

// ── 6. 市場解讀 ─────────────────────────────────────────────────────
// Two stacked grids in ONE chart instance:
//   grid0 (top)    — DGS10 / DGS2 / DGS10 60d rolling min, all ~3.5–5.5%
//   grid1 (bottom) — T10YIE alone, own y-axis (~2–2.5%). Sharing one axis with
//     DGS10/DGS2 previously pinned T10YIE to a flat line at the bottom of the
//     chart with no visible resolution — "等於白畫". Its own scale:true axis
//     lets it breathe.
// CPI release dates are marked with thin/low-opacity vertical markLines with
// NO text label (labels for ~20 dates crammed into one row rendered as an
// unreadable smear across the top of the chart); the date is instead surfaced
// in the tooltip when hovering that exact day, and via the subtitle note.
function renderMarket() {
  if (!marketChart) return;
  const full = payload.market ?? [];
  const rows = full.filter(r => r.date >= rangeStart(cpiRange));
  if (!rows.length) { marketChart.clear(); return; }

  const rollMinAll = rollingMin(full, "dgs10", 60);
  const rollMinMap = new Map(full.map((r, i) => [r.date, rollMinAll[i]]));

  const cutoff = rangeStart(cpiRange);
  const releaseDatesInView = (payload.release_dates ?? [])
    .filter(d => d >= cutoff && d <= (rows[rows.length - 1]?.date ?? d));
  const releaseSet = new Set(payload.release_dates ?? []);
  const releaseMarks = releaseDatesInView.map(d => ({
    xAxis: d,
    label: { show: false },
    lineStyle: { color: PALETTE.muted, type: "dashed", width: 1, opacity: 0.35 },
  }));

  const axisClr = PALETTE.muted;
  const gridClr = tc("rgba(48,54,61,0.5)", "rgba(208,215,222,0.4)");
  const tipBg   = PALETTE.bg;
  const tipBdr  = PALETTE.border;
  const textClr = PALETTE.text2;

  const sub = document.getElementById("cpi-market-subtitle");
  if (sub) sub.textContent =
    `淡灰虛線 = CPI 公布日(${releaseDatesInView.length} 次,hover 該日可見標註)· T10YIE 用獨立下軸(與 DGS10/DGS2 量級差 2x,同軸會被壓平)`;

  const L = mob() ? 40 : 52, R = mob() ? 16 : 28;
  const grid = [
    { left: L, right: R, top: "10%", height: mob() ? "42%" : "46%" },
    { left: L, right: R, top: "66%", height: mob() ? "20%" : "22%" },
  ];
  const xAxis = [
    { gridIndex: 0, type: "time",
      axisLabel: { show: false }, axisLine: { lineStyle: { color: axisClr } },
      axisTick: { show: false }, splitLine: { show: false } },
    { gridIndex: 1, type: "time",
      axisLabel: { color: axisClr, fontSize: 11 }, axisLine: { lineStyle: { color: axisClr } },
      axisTick: { show: false }, splitLine: { show: false } },
  ];
  const yAxis = [
    { gridIndex: 0, type: "value", scale: true, name: "DGS10/DGS2 %",
      nameTextStyle: { color: axisClr, fontSize: 10 },
      axisLabel: { color: axisClr, fontSize: 11, formatter: v => v.toFixed(1) + "%" },
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: gridClr } } },
    { gridIndex: 1, type: "value", scale: true, name: "T10YIE %",
      nameTextStyle: { color: PURPLE, fontSize: 10 },
      axisLabel: { color: PURPLE, fontSize: 11, formatter: v => v.toFixed(2) + "%" },
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: gridClr } } },
  ];

  const series = [
    { name: "DGS10", type: "line", xAxisIndex: 0, yAxisIndex: 0, data: rows.map(r => [r.date, r.dgs10 ?? null]),
      symbol: "none", smooth: false, connectNulls: true, z: 3, itemStyle: { color: BLUE }, lineStyle: { color: BLUE, width: 1.8 },
      markLine: { silent: true, symbol: "none", data: releaseMarks } },
    { name: "DGS2", type: "line", xAxisIndex: 0, yAxisIndex: 0, data: rows.map(r => [r.date, r.dgs2 ?? null]),
      symbol: "none", smooth: false, connectNulls: true, itemStyle: { color: ORANGE }, lineStyle: { color: ORANGE, width: 1.4 } },
    { name: "10Y 平衡通膨率(T10YIE)", type: "line", xAxisIndex: 1, yAxisIndex: 1, data: rows.map(r => [r.date, r.t10yie ?? null]),
      symbol: "none", smooth: false, connectNulls: true, itemStyle: { color: PURPLE }, lineStyle: { color: PURPLE, width: 1.4 } },
  ];
  if (showRollMin) {
    series.push({ name: "DGS10 滾動60日低點", type: "line", xAxisIndex: 0, yAxisIndex: 0, data: rows.map(r => [r.date, rollMinMap.get(r.date) ?? null]),
      symbol: "none", smooth: false, connectNulls: true, itemStyle: { color: GREEN }, lineStyle: { color: GREEN, width: 1.4, type: "dotted" } });
  }

  marketChart.setOption({
    backgroundColor: "transparent", animation: false,
    tooltip: {
      trigger: "axis", axisPointer: { type: "cross", link: [{ xAxisIndex: "all" }] },
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        if (!params.length) return "";
        const d = dateLabel(params[0]);
        let html = `<div style="font-weight:600;margin-bottom:4px">${d}${releaseSet.has(d) ? ' <span style="color:' + ORANGE + '">📅 CPI 公布日</span>' : ""}</div>`;
        for (const p of params) {
          const v = Array.isArray(p.value) ? p.value[1] : p.value;
          if (v == null) continue;
          html += `<div>${p.marker}${p.seriesName}: <b>${(+v).toFixed(2)}%</b></div>`;
        }
        return html;
      },
    },
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    grid, xAxis, yAxis,
    legend: { top: 2, left: "center", textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr },
    dataZoom: [{ type: "inside", xAxisIndex: [0, 1], filterMode: "none" }],
    series,
  }, { notMerge: true });
}

function releaseTableRows() {
  const market = payload.market ?? [];
  const releaseDates = payload.release_dates ?? [];
  if (!market.length || !releaseDates.length) return [];
  const dateIdx = new Map(market.map((r, i) => [r.date, i]));
  const rows = [];
  for (const rd of releaseDates) {
    const idx = dateIdx.get(rd);
    if (idx == null) { rows.push({ date: rd, dgs10bp: null, dgs2bp: null }); continue; }
    let prevIdx = idx - 1;
    while (prevIdx >= 0 && market[prevIdx].dgs10 == null) prevIdx--;
    const cur = market[idx], prev = prevIdx >= 0 ? market[prevIdx] : null;
    const dgs10bp = (cur.dgs10 != null && prev?.dgs10 != null) ? Math.round((cur.dgs10 - prev.dgs10) * 100) : null;
    let prevIdx2 = idx - 1;
    while (prevIdx2 >= 0 && market[prevIdx2].dgs2 == null) prevIdx2--;
    const prev2 = prevIdx2 >= 0 ? market[prevIdx2] : null;
    const dgs2bp = (cur.dgs2 != null && prev2?.dgs2 != null) ? Math.round((cur.dgs2 - prev2.dgs2) * 100) : null;
    rows.push({ date: rd, dgs10bp, dgs2bp });
  }
  return rows.slice(-12);
}

function renderReleaseTable() {
  const tbl = document.getElementById("cpi-release-table");
  if (!tbl) return;
  const rows = releaseTableRows();
  if (!rows.length) { tbl.innerHTML = "<p style='color:var(--muted);font-size:12px'>無資料</p>"; return; }
  const fmtBp = v => v == null ? "—" : (v >= 0 ? "+" : "") + v + " bp";
  const clrBp = v => v == null ? "var(--muted)" : v > 0 ? RED : v < 0 ? BLUE : "var(--muted)";
  tbl.innerHTML = `
    <div style="color:var(--muted);font-size:12px;margin-bottom:4px">近 12 次 CPI 公布日當日 vs 前一交易日殖利率變動(bp,無 consensus 資料,僅呈現實際反應)</div>
    <table class="info-table">
      <thead><tr><th>公布日</th><th>DGS10 變動</th><th>DGS2 變動</th></tr></thead>
      <tbody>
        ${rows.map(r => `<tr>
          <td>${r.date}</td>
          <td style="color:${clrBp(r.dgs10bp)}">${fmtBp(r.dgs10bp)}</td>
          <td style="color:${clrBp(r.dgs2bp)}">${fmtBp(r.dgs2bp)}</td>
        </tr>`).join("")}
      </tbody>
    </table>`;
}

// ── master render ───────────────────────────────────────────────────
export function render() {
  if (!payload) return;
  updateCards();
  populateDecompPicker();
  const sel = document.getElementById("cpi-decomp-month");
  renderContrib(sel?.value);
  renderHeatmap();
  renderBreadth();
  renderSticky();
  renderMarket();
  renderReleaseTable();

  const status = document.getElementById("cpi-status");
  if (status) status.textContent =
    `來源 FRED(BLS CPI 分項/Cleveland Fed Median-Trimmed/Atlanta Fed Sticky-Flex/DGS10-DGS2-T10YIE) · 公布日期取自 ALFRED · 更新於 ${payload.updated ?? "—"}`;
}

// ── controls ─────────────────────────────────────────────────────────
function buildControls() {
  const rp = document.getElementById("cpi-range-picker");
  if (rp && !rp.dataset.built) {
    rp.dataset.built = "1";
    rp.addEventListener("click", e => {
      const t = e.target.closest(".chip[data-cpi-range]");
      if (!t) return;
      cpiRange = t.dataset.cpiRange;
      rp.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c === t));
      renderBreadth(); renderSticky(); renderMarket();
    });
  }
  const rm = document.getElementById("cpi-rollmin-toggle");
  if (rm && !rm.dataset.built) {
    rm.dataset.built = "1";
    rm.addEventListener("click", () => {
      showRollMin = !showRollMin;
      rm.classList.toggle("active", showRollMin);
      renderMarket();
    });
  }
}

// ── lifecycle ────────────────────────────────────────────────────────
export async function activate() {
  const h1 = document.getElementById("cpi-contrib-chart");
  const h2 = document.getElementById("cpi-heatmap-chart");
  const h3 = document.getElementById("cpi-breadth-chart");
  const h4 = document.getElementById("cpi-sticky-chart");
  const h5 = document.getElementById("cpi-market-chart");
  if (!h1) return;
  if (!contribChart) contribChart = echarts.init(h1, isLight() ? null : "dark");
  if (!heatChart)    heatChart    = echarts.init(h2, isLight() ? null : "dark");
  if (!breadthChart) breadthChart = echarts.init(h3, isLight() ? null : "dark");
  if (!stickyChart)  stickyChart  = echarts.init(h4, isLight() ? null : "dark");
  if (!marketChart)  marketChart  = echarts.init(h5, isLight() ? null : "dark");
  buildControls();
  try {
    await loadAll();
    setTimeout(() => {
      contribChart?.resize(); heatChart?.resize(); breadthChart?.resize();
      stickyChart?.resize(); marketChart?.resize();
      render();
    }, 50);
  } catch (e) {
    const s = document.getElementById("cpi-status");
    if (s) s.textContent = "載入失敗：" + (e.message || e);
    console.error("[cpi] load failed", e);
  }
}

export function onThemeChange(light) {
  if (contribChart) { contribChart.dispose(); contribChart = echarts.init(document.getElementById("cpi-contrib-chart"), light ? null : "dark"); }
  if (heatChart)    { heatChart.dispose();    heatChart    = echarts.init(document.getElementById("cpi-heatmap-chart"), light ? null : "dark"); }
  if (breadthChart) { breadthChart.dispose(); breadthChart = echarts.init(document.getElementById("cpi-breadth-chart"), light ? null : "dark"); }
  if (stickyChart)  { stickyChart.dispose();  stickyChart  = echarts.init(document.getElementById("cpi-sticky-chart"), light ? null : "dark"); }
  if (marketChart)  { marketChart.dispose();  marketChart  = echarts.init(document.getElementById("cpi-market-chart"), light ? null : "dark"); }
  if (payload) render();
}

export function resize() {
  contribChart?.resize(); heatChart?.resize(); breadthChart?.resize();
  stickyChart?.resize(); marketChart?.resize();
}
