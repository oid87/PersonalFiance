// 台股籌碼 tab — 2x2 四宮格 + 第五格（佔滿整列）：
//   台指期三大法人未平倉 / 台指期近月收盤 / 台指選擇權外資未平倉 /
//   上市融資餘額 / 散戶多空比・期指（微台 TMF / 小台 MTX 切換）
//   資料：data/taiwan_fut_inst.json、data/taiwan_basis.json、
//         data/taiwan_opt_inst.json（可能尚未產生，缺檔時該格顯示提示文字）、
//         data/taiwan_margin_total.json、data/taiwan_retail_ls.json

import { isLight, PALETTE, mob } from '../utils/theme.js';
import { cutoffDate } from '../utils/dates.js';
import { fetchJSON } from '../utils/data.js';

const POS_COLOR = "#3fb950";
const NEG_COLOR = "#f85149";

let charts = { fut: null, basis: null, opt: null, margin: null, retail: null };
let rows   = { fut: null, basis: null, opt: null, margin: null, retail: null };
let optAvailable = false;
let range  = "3Y";
let retailProduct = "tmf"; // 微台預設；跟 range 各自獨立保存，互切不互相重設
let loaded = false;

async function loadAll() {
  if (loaded) return;
  const [futRows, basisRows, marginRows, retailRows] = await Promise.all([
    fetchJSON("data/taiwan_fut_inst.json"),
    fetchJSON("data/taiwan_basis.json"),
    fetchJSON("data/taiwan_margin_total.json"),
    fetchJSON("data/taiwan_retail_ls.json"),
  ]);
  rows.fut    = futRows;
  rows.basis  = basisRows;
  rows.margin = marginRows;
  rows.retail = retailRows;

  try {
    const optRows = await fetchJSON("data/taiwan_opt_inst.json");
    rows.opt = Array.isArray(optRows) ? optRows : [];
    optAvailable = rows.opt.length > 0;
  } catch (e) {
    rows.opt = [];
    optAvailable = false;
    console.warn("[twchips] taiwan_opt_inst.json load failed (可能尚未產生)", e);
  }
  loaded = true;
}

function filterByRange(list) {
  const cut = cutoffDate(range);
  return list.filter(r => r.date >= cut);
}

// signVal: 是否在數值本身也加上 +/- 前綴（預設 false，維持既有四格的顯示方式不變；
// 散戶多空比這種「正負本身就是核心訊息」的欄位傳 true，比照 diff 的 +/- 呈現）。
function setStat(valId, diffId, latest, prev, unit, digits = 0, signVal = false) {
  const valEl  = document.getElementById(valId);
  const diffEl = diffId ? document.getElementById(diffId) : null;
  if (valEl) {
    valEl.textContent = latest == null
      ? "—"
      : (signVal && latest >= 0 ? "+" : "")
        + (digits ? latest.toFixed(digits) : Math.round(latest).toLocaleString("en-US"))
        + (unit || "");
    valEl.style.color = latest == null ? "" : (latest >= 0 ? POS_COLOR : NEG_COLOR);
  }
  if (diffEl) {
    if (latest == null || prev == null) {
      diffEl.textContent = "—";
      diffEl.style.color = "";
    } else {
      const diff = latest - prev;
      diffEl.textContent = (diff >= 0 ? "+" : "") + (digits ? diff.toFixed(digits) : Math.round(diff).toLocaleString("en-US"));
      diffEl.style.color = diff >= 0 ? POS_COLOR : NEG_COLOR;
    }
  }
}

function zeroLine(color) {
  return {
    silent: true, symbol: "none",
    lineStyle: { color: color || PALETTE.muted, type: "dashed", width: 1, opacity: 0.6 },
    data: [{ yAxis: 0 }],
  };
}

function baseChartOption(overrides) {
  return {
    backgroundColor: "transparent",
    animation: false,
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "cross" },
      backgroundColor: PALETTE.bg,
      borderColor: PALETTE.border,
      textStyle: { color: PALETTE.text, fontSize: 12 },
    },
    grid: { left: mob() ? 48 : 64, right: mob() ? 12 : 20, top: 24, bottom: 28 },
    xAxis: {
      type: "category",
      boundaryGap: false,
      axisLine: { lineStyle: { color: PALETTE.muted } },
      axisTick: { show: false },
      axisLabel: { color: PALETTE.muted, fontSize: 10 },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value",
      scale: true,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: PALETTE.muted, fontSize: 10 },
      splitLine: { lineStyle: { color: PALETTE.grid } },
    },
    dataZoom: [{ type: "inside", filterMode: "none" }],
    ...overrides,
  };
}

// ── panel 1: 台指期三大法人未平倉 ───────────────────────────────────────
function renderFut() {
  const el = document.getElementById("twchips-fut-chart");
  if (!el || !rows.fut?.length) return;
  if (!charts.fut) charts.fut = echarts.init(el, isLight() ? null : "dark");

  const all  = rows.fut;
  const last = all[all.length - 1];
  const prev = all.length > 1 ? all[all.length - 2] : null;
  setStat("twchips-fut-val", "twchips-fut-diff", last?.foreign_net, prev?.foreign_net);

  const view = filterByRange(all);
  const dates = view.map(r => r.date);

  charts.fut.setOption(baseChartOption({
    legend: { data: ["外資", "投信", "自營商"], top: 0, right: 0, textStyle: { color: PALETTE.muted, fontSize: 11 } },
    grid: { left: mob() ? 48 : 64, right: mob() ? 12 : 20, top: 30, bottom: 28 },
    xAxis: { data: dates },
    series: [
      { name: "外資",   type: "line", data: view.map(r => r.foreign_net), symbol: "none", itemStyle: { color: "#58a6ff" }, lineStyle: { color: "#58a6ff", width: 1.6 }, markLine: zeroLine() },
      { name: "投信",   type: "line", data: view.map(r => r.trust_net),  symbol: "none", itemStyle: { color: "#f0883e" }, lineStyle: { color: "#f0883e", width: 1.2 } },
      { name: "自營商", type: "line", data: view.map(r => r.dealer_net), symbol: "none", itemStyle: { color: "#a371f7" }, lineStyle: { color: "#a371f7", width: 1.2 } },
    ],
  }), { notMerge: true });
}

// ── panel 2: 台指期近月收盤 ─────────────────────────────────────────────
function renderBasis() {
  const el = document.getElementById("twchips-basis-chart");
  if (!el || !rows.basis?.length) return;
  if (!charts.basis) charts.basis = echarts.init(el, isLight() ? null : "dark");

  const all  = rows.basis;
  const last = all[all.length - 1];
  const prev = all.length > 1 ? all[all.length - 2] : null;
  setStat("twchips-basis-val", "twchips-basis-diff", last?.futures, prev?.futures);

  const view = filterByRange(all);
  const dates = view.map(r => r.date);

  charts.basis.setOption(baseChartOption({
    xAxis: { data: dates },
    series: [
      { name: "台指期近月", type: "line", data: view.map(r => r.futures), symbol: "none",
        itemStyle: { color: "#58a6ff" }, lineStyle: { color: "#58a6ff", width: 1.6 } },
    ],
  }), { notMerge: true });
}

// ── panel 3: 台指選擇權外資未平倉 ───────────────────────────────────────
function renderOpt() {
  const el       = document.getElementById("twchips-opt-chart");
  const emptyEl  = document.getElementById("twchips-opt-empty");
  if (!el) return;

  if (!optAvailable) {
    el.style.display = "none";
    if (emptyEl) emptyEl.hidden = false;
    setStat("twchips-opt-call-val", "twchips-opt-call-diff", null, null);
    setStat("twchips-opt-put-val",  "twchips-opt-put-diff",  null, null);
    return;
  }
  el.style.display = "";
  if (emptyEl) emptyEl.hidden = true;
  if (!charts.opt) charts.opt = echarts.init(el, isLight() ? null : "dark");

  const all  = rows.opt;
  const last = all[all.length - 1];
  const prev = all.length > 1 ? all[all.length - 2] : null;
  setStat("twchips-opt-call-val", "twchips-opt-call-diff", last?.call_foreign, prev?.call_foreign);
  setStat("twchips-opt-put-val",  "twchips-opt-put-diff",  last?.put_foreign,  prev?.put_foreign);

  const view = filterByRange(all);
  const dates = view.map(r => r.date);

  charts.opt.setOption(baseChartOption({
    legend: { data: ["CALL", "PUT"], top: 0, right: 0, textStyle: { color: PALETTE.muted, fontSize: 11 } },
    grid: { left: mob() ? 48 : 64, right: mob() ? 12 : 20, top: 30, bottom: 28 },
    xAxis: { data: dates },
    series: [
      { name: "CALL", type: "line", data: view.map(r => r.call_foreign), symbol: "none", itemStyle: { color: POS_COLOR }, lineStyle: { color: POS_COLOR, width: 1.6 }, markLine: zeroLine() },
      { name: "PUT",  type: "line", data: view.map(r => r.put_foreign),  symbol: "none", itemStyle: { color: NEG_COLOR }, lineStyle: { color: NEG_COLOR, width: 1.6 } },
    ],
  }), { notMerge: true });
}

// ── panel 4: 上市融資餘額 ───────────────────────────────────────────────
function renderMargin() {
  const el = document.getElementById("twchips-margin-chart");
  if (!el || !rows.margin?.length) return;
  if (!charts.margin) charts.margin = echarts.init(el, isLight() ? null : "dark");

  const all  = rows.margin;
  const last = all[all.length - 1];
  const prev = all.length > 1 ? all[all.length - 2] : null;
  setStat("twchips-margin-val", "twchips-margin-diff", last?.margin_money, prev?.margin_money, "", 1);

  const view = filterByRange(all);
  const dates = view.map(r => r.date);

  charts.margin.setOption(baseChartOption({
    xAxis: { data: dates },
    series: [
      { name: "融資餘額(億元)", type: "line", data: view.map(r => r.margin_money), symbol: "none",
        itemStyle: { color: "#f0883e" }, lineStyle: { color: "#f0883e", width: 1.6 },
        areaStyle: { color: "rgba(240,136,62,0.14)" } },
    ],
  }), { notMerge: true });
}

// ── panel 5: 散戶多空比・期指（微台 TMF / 小台 MTX）─────────────────────
// TMF 2024-07-29 才上市，之前 tmf_* 全為 null；找「最後一筆非 null」而非
// 陣列末筆，防未來停牌/資料缺漏時誤讀到 null。
function findLastValidIdx(list, prefix, beforeIdx) {
  for (let i = beforeIdx; i >= 0; i--) {
    if (list[i][`${prefix}_ratio`] != null) return i;
  }
  return -1;
}

function buildRetailOption(view, prefix) {
  const dates     = view.map(r => r.date);
  const ratioData = view.map(r => r[`${prefix}_ratio`] ?? null);
  const closeData = view.map(r => r[`${prefix}_close`] ?? null);
  const volData   = view.map(r => r[`${prefix}_volume`] ?? null);
  const sideMargin = mob() ? 44 : 60;

  return {
    backgroundColor: "transparent",
    animation: false,
    // 雙 grid 上下疊圖同步：top-level axisPointer.link 讓兩個 grid 的十字線
    // 跟著同一個 x 索引移動；dataZoom.xAxisIndex:[0,1] 讓縮放也同步。
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    tooltip: {
      trigger: "axis",
      backgroundColor: PALETTE.bg,
      borderColor: PALETTE.border,
      textStyle: { color: PALETTE.text, fontSize: 12 },
    },
    grid: [
      { left: sideMargin, right: sideMargin, top: 8, height: "56%" },
      { left: sideMargin, right: sideMargin, top: "68%", height: "22%" },
    ],
    xAxis: [
      {
        type: "category", gridIndex: 0, data: dates, boundaryGap: false,
        axisLine: { lineStyle: { color: PALETTE.muted } }, axisTick: { show: false },
        axisLabel: { show: false }, splitLine: { show: false },
      },
      {
        type: "category", gridIndex: 1, data: dates, boundaryGap: false,
        axisLine: { lineStyle: { color: PALETTE.muted } }, axisTick: { show: false },
        axisLabel: { color: PALETTE.muted, fontSize: 10 }, splitLine: { show: false },
      },
    ],
    yAxis: [
      {
        type: "value", gridIndex: 0, scale: true, position: "left",
        name: "多空比(%)", nameTextStyle: { color: PALETTE.muted, fontSize: 10 },
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: PALETTE.muted, fontSize: 10, formatter: v => v + "%" },
        splitLine: { lineStyle: { color: PALETTE.grid } },
      },
      {
        type: "value", gridIndex: 0, scale: true, position: "right",
        name: "收盤", nameTextStyle: { color: PALETTE.muted, fontSize: 10 },
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: PALETTE.muted, fontSize: 10 },
        splitLine: { show: false },
      },
      { type: "value", gridIndex: 1, scale: true, show: false },
    ],
    dataZoom: [{ type: "inside", xAxisIndex: [0, 1], filterMode: "none" }],
    series: [
      {
        name: "散戶多空比", type: "line", xAxisIndex: 0, yAxisIndex: 0,
        data: ratioData, symbol: "none", connectNulls: false,
        itemStyle: { color: "#f0883e" }, lineStyle: { color: "#f0883e", width: 1.8 },
        markLine: zeroLine(),
      },
      {
        name: "近月收盤", type: "line", xAxisIndex: 0, yAxisIndex: 1,
        data: closeData, symbol: "none", connectNulls: false,
        itemStyle: { color: "#58a6ff" }, lineStyle: { color: "#58a6ff", width: 1, opacity: 0.45 },
      },
      {
        name: "成交量", type: "bar", xAxisIndex: 1, yAxisIndex: 2,
        data: volData, itemStyle: { color: PALETTE.muted, opacity: 0.6 },
      },
    ],
  };
}

function renderRetail() {
  const el = document.getElementById("twchips-retail-chart");
  if (!el || !rows.retail?.length) return;
  if (!charts.retail) charts.retail = echarts.init(el, isLight() ? null : "dark");

  const all    = rows.retail;
  const prefix = retailProduct;

  const lastIdx = findLastValidIdx(all, prefix, all.length - 1);
  const prevIdx = lastIdx >= 0 ? findLastValidIdx(all, prefix, lastIdx - 1) : -1;
  const lastRow = lastIdx >= 0 ? all[lastIdx] : null;
  const prevRow = prevIdx >= 0 ? all[prevIdx] : null;

  setStat("twchips-retail-ratio-val", "twchips-retail-ratio-diff",
    lastRow?.[`${prefix}_ratio`], prevRow?.[`${prefix}_ratio`], "%", 2, true);

  const closeEl = document.getElementById("twchips-retail-close-val");
  if (closeEl) {
    const v = lastRow?.[`${prefix}_close`];
    closeEl.textContent = v != null ? Math.round(v).toLocaleString("en-US") : "—";
  }
  const volEl = document.getElementById("twchips-retail-vol-val");
  if (volEl) {
    const v = lastRow?.[`${prefix}_volume`];
    volEl.textContent = v != null ? Math.round(v).toLocaleString("en-US") : "—";
  }

  const view = filterByRange(all);
  charts.retail.setOption(buildRetailOption(view, prefix), { notMerge: true });
}

function renderAll() {
  renderFut();
  renderBasis();
  renderOpt();
  renderMargin();
  renderRetail();
  const status = document.getElementById("twchips-status");
  if (status) {
    // 五格資料長度不一（fut 2018 起、opt/retail 受期交所滾動 3 年視窗限制），
    // 顯示筆數會誤導，改顯示各來源中最新的一天。
    const lastDate = l => (l?.length ? l[l.length - 1].date : "");
    const latest = [rows.fut, rows.basis, rows.opt, rows.margin, rows.retail]
      .map(lastDate).filter(Boolean).sort().pop() || "—";
    const optNote = optAvailable ? "" : "（選擇權未平倉資料尚未產生）";
    status.textContent = `台股籌碼 · 最新 ${latest}（${range}）· TAIFEX / FinMind ${optNote}`;
  }
}

function buildControls() {
  const rp = document.getElementById("twchips-range-picker");
  if (rp && !rp.dataset.built) {
    rp.dataset.built = "1";
    rp.addEventListener("click", e => {
      const t = e.target.closest(".chip[data-twchips-range]");
      if (!t) return;
      range = t.dataset.twchipsRange;
      rp.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c === t));
      renderAll();
    });
  }
}

// 商品切換（微台/小台）狀態獨立於 range picker；切換只重繪第五格，不動其他四格。
function buildProductPicker() {
  const pp = document.getElementById("twchips-retail-product-picker");
  if (pp && !pp.dataset.built) {
    pp.dataset.built = "1";
    pp.addEventListener("click", e => {
      const t = e.target.closest(".chip[data-twchips-product]");
      if (!t) return;
      retailProduct = t.dataset.twchipsProduct;
      pp.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c === t));
      renderRetail();
    });
  }
}

export async function init() {
  buildControls();
  buildProductPicker();
  const status = document.getElementById("twchips-status");
  try {
    await loadAll();
    renderAll();
  } catch (e) {
    if (status) status.textContent = "載入失敗：" + (e.message || e);
    console.error("[twchips] load failed", e);
  }
}

export function onThemeChange(_light) {
  for (const key of Object.keys(charts)) {
    if (charts[key]) { charts[key].dispose(); charts[key] = null; }
  }
  if (loaded) renderAll();
}

export function resize() {
  Object.values(charts).forEach(c => c?.resize());
}
