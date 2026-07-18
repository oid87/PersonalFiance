// 流動性×槓桿 tab — 台/美/日 融資餘額 vs 指數「超額成長 + 翻頭」判準
//   國別 toggle：TW / US / JP（TW 預設）
//   上圖：excess = margin_yoy − index_yoy（0 軸標線 + ⚠️ 行動點＝超額>0 且翻頭）
//   下圖：YoY 疊圖 — index_yoy / margin_yoy / M2_yoy / M1(B)_yoy 四線（可各自 legend toggle）
//         TW 額外可疊「外資累計買超」（僅 TW，重用既有 data/taiwan_investors.json）
//   資料源：data/liquidity_leverage.json（scripts/fetch_liquidity_leverage.py 產出，
//   YoY/excess/翻頭皆已在 Python 端算好，前端只畫，不重算）。
//
//   邏輯出處：Financial_work/margin_vs_index_excess.py（已驗證 PASS）。
//   ⚠️ 融資絕對金額各國單位/定義不同不可比，本圖只用 YoY%/超額（比率）跨國比較；
//   當月未滿月讀數會隨月底重取樣持續變動。

import { isLight, tc, mob, PALETTE } from '../utils/theme.js';

let excessChart = null;
let yoyChart = null;
let market = "tw";       // tw | us | jp
let llRange = "5Y";
let showForeign = true;  // TW-only overlay

let llData = null;        // full liquidity_leverage.json
let investors = null;     // [[date, foreign, foreign_cum], ...] — TW only, reused from taiwan_investors.json

const MARKET_LABEL = { tw: "台灣", us: "美國", jp: "日本" };
const M1_FIELD = { tw: "m1b_yoy", us: "m1_yoy", jp: "m1_yoy" };
const M1_LABEL = { tw: "M1B 年增率", us: "M1 年增率", jp: "M1 年增率" };

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

  const [ll, inv] = await Promise.all([
    fetchJson("data/liquidity_leverage.json"),
    fetchJson("data/taiwan_investors.json", true),
  ]);
  llData = ll;
  investors = (inv?.data ?? []).map(r => [r.date, r.foreign, r.foreign_cum]);
}

function rows() {
  return llData?.[market]?.monthly ?? [];
}

function rangeStart(rangeKey) {
  if (rangeKey === "MAX") return "1900-01-01";
  const d = new Date();
  const map = { "1Y": 1, "2Y": 2, "5Y": 5, "10Y": 10 };
  d.setFullYear(d.getFullYear() - (map[rangeKey] ?? 5));
  // check_reuse: keep — 本地 range cutoff 變體:preset key 集合/MAX 哨兵/未命中預設與 dates.presetStart、dates.cutoffDate 皆不同,換過去會改行為
  return d.toISOString().slice(0, 10);
}

function filteredRows() {
  const from = rangeStart(llRange);
  return rows().filter(r => r.date >= from);
}

// Re-anchor foreign cumulative to zero at the window start (same logic as old liquidity.js)
function rebaseCumulative(rowsArr, from) {
  const filtered = rowsArr.filter(r => r[0] >= from);
  if (!filtered.length) return [];
  let acc = 0;
  return filtered.map(r => { acc += r[1] || 0; return [r[0], +acc.toFixed(2)]; });
}

function fmt(n, dp = 1) {
  if (n == null || !isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return sign + (+n).toFixed(dp);
}

// ── Top summary cards ────────────────────────────────────────────────────
function renderSummary() {
  const f = filteredRows();
  const last = [...rows()].reverse().find(r => r.index_yoy != null && r.margin_yoy != null);
  document.getElementById("ll-m1-label").textContent = M1_LABEL[market].replace(" 年增率", "");
  if (last) {
    document.getElementById("ll-index-yoy").textContent = fmt(last.index_yoy);
    document.getElementById("ll-margin-yoy").textContent = fmt(last.margin_yoy);
    const excessEl = document.getElementById("ll-excess");
    excessEl.textContent = fmt(last.excess);
    excessEl.style.color = last.excess > 0 ? "#22c55e" : "#f85149";
    document.getElementById("ll-excess-note").textContent = last.action_point
      ? "⚠️ 行動點（超額>0 且翻頭）" : last.excess > 0 ? "超額為正" : "超額為負";
    const m1v = last[M1_FIELD[market]];
    document.getElementById("ll-m1").textContent = m1v == null ? "—" : fmt(m1v);
    document.getElementById("ll-m2").textContent = last.m2_yoy == null ? "—" : fmt(last.m2_yoy);
    document.getElementById("ll-date").textContent = "資料月 " + last.date.slice(0, 7);
  } else {
    for (const id of ["ll-index-yoy", "ll-margin-yoy", "ll-excess", "ll-m1", "ll-m2"])
      document.getElementById(id).textContent = "—";
    document.getElementById("ll-date").textContent = "—";
  }

  const foreignCard = document.getElementById("ll-foreign-card");
  if (foreignCard) {
    if (market === "tw" && investors?.length) {
      foreignCard.style.display = "";
      const tail = investors.slice(-30);
      const sum = tail.reduce((a, r) => a + (r[1] || 0), 0);
      const el = document.getElementById("ll-foreign");
      el.textContent = fmt(sum, 0);
      el.style.color = sum > 0 ? "#22c55e" : "#f85149";
      document.getElementById("ll-foreign-date").textContent = "最新 " + investors[investors.length - 1][0];
    } else {
      foreignCard.style.display = "none";
    }
  }
  void f;
}

// ── 上圖：excess + ⚠️ 行動點 ──────────────────────────────────────────────
function renderExcessChart() {
  if (!excessChart) return;
  const f = filteredRows();
  const excessData = f.map(r => [r.date, r.excess]);
  const actionPts = f.filter(r => r.action_point).map(r => ({
    coord: [r.date, r.excess],
    symbol: "circle", symbolSize: 14,
    itemStyle: { color: "#f85149", borderColor: "#fff", borderWidth: 1 },
    label: { show: true, formatter: "⚠️", position: "top", fontSize: 13 },
  }));

  const axisClr = PALETTE.muted;
  const gridClr = tc("rgba(48,54,61,0.5)", "rgba(208,215,222,0.4)");
  const tipBg = PALETTE.bg;
  const tipBdr = PALETTE.border;
  const tipText = PALETTE.text;

  excessChart.setOption({
    backgroundColor: "transparent",
    title: {
      text: `${MARKET_LABEL[market]}：融資超額成長（margin_yoy − index_yoy）`,
      left: 8, top: 4, textStyle: { color: tipText, fontSize: 12, fontWeight: 600 },
    },
    tooltip: {
      trigger: "axis",
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: tipText, fontSize: 12 },
      formatter(params) {
        const p = params.find(x => x.seriesName === "超額 excess") || params[0];
        if (!p) return "";
        const row = f.find(r => r.date === p.value[0]);
        if (!row) return "";
        return `<b>${row.date.slice(0, 7)}</b><br/>`
          + `超額 excess: <b>${fmt(row.excess)}%</b><br/>`
          + `margin_yoy: ${fmt(row.margin_yoy)}%　index_yoy: ${fmt(row.index_yoy)}%<br/>`
          + (row.action_point ? `<span style="color:#f85149">⚠️ 行動點（超額>0 且翻頭）</span>` : "");
      },
    },
    grid: { left: mob() ? 44 : 60, right: mob() ? 16 : 32, top: 40, bottom: 28 },
    xAxis: { type: "time", axisLine: { lineStyle: { color: axisClr } },
      axisLabel: { color: axisClr, fontSize: 11 }, splitLine: { show: false } },
    yAxis: { type: "value", scale: true,
      axisLine: { lineStyle: { color: axisClr } },
      axisLabel: { color: axisClr, fontSize: 11, formatter: v => v + "%" },
      splitLine: { lineStyle: { color: gridClr } } },
    series: [{
      name: "超額 excess", type: "line", data: excessData, symbol: "none",
      lineStyle: { width: 1.8, color: "#58a6ff" },
      areaStyle: { color: "rgba(88,166,255,0.12)" },
      itemStyle: { color: "#58a6ff" },
      markLine: { silent: true, symbol: "none",
        data: [{ yAxis: 0, lineStyle: { color: axisClr, type: "dashed", width: 1, opacity: 0.7 } }] },
      markPoint: actionPts.length ? { data: actionPts, symbol: "circle" } : undefined,
    }],
    dataZoom: [
      { type: "inside" },
      { type: "slider", height: 14, bottom: 4, fillerColor: "rgba(88,166,255,0.12)",
        borderColor: PALETTE.border },
    ],
  }, { notMerge: true });
}

// ── 下圖：YoY 疊圖（index/margin/M2/M1(B)）＋ TW 外資累計可選 ──────────────
function renderYoyChart() {
  if (!yoyChart) return;
  const f = filteredRows();
  const from = rangeStart(llRange);
  const m1Field = M1_FIELD[market];

  const indexYoy = f.map(r => [r.date, r.index_yoy]);
  const marginYoy = f.map(r => [r.date, r.margin_yoy]);
  const m2Yoy = f.map(r => [r.date, r.m2_yoy]);
  const m1Yoy = f.map(r => [r.date, r[m1Field]]);

  const axisClr = PALETTE.muted;
  const gridClr = tc("rgba(48,54,61,0.5)", "rgba(208,215,222,0.4)");
  const tipBg = PALETTE.bg;
  const tipBdr = PALETTE.border;
  const tipText = PALETTE.text;

  const legendData = ["指數 index_yoy", "融資 margin_yoy", "M2 年增率", M1_LABEL[market]];
  const isTwForeign = market === "tw" && showForeign;
  if (isTwForeign) legendData.push("外資累計");

  const series = [
    { name: "指數 index_yoy", type: "line", yAxisIndex: 0, data: indexYoy, symbol: "none",
      lineStyle: { width: 1.6, color: tc("#e6edf3", "#1f2937") }, itemStyle: { color: tc("#e6edf3", "#1f2937") } },
    { name: "融資 margin_yoy", type: "line", yAxisIndex: 0, data: marginYoy, symbol: "none",
      lineStyle: { width: 1.6, color: "#f85149" }, itemStyle: { color: "#f85149" } },
    { name: "M2 年增率", type: "line", yAxisIndex: 0, data: m2Yoy, symbol: "none",
      lineStyle: { width: 1.4, color: "#e3b341", type: "dashed" }, itemStyle: { color: "#e3b341" } },
    { name: M1_LABEL[market], type: "line", yAxisIndex: 0, data: m1Yoy, symbol: "none",
      lineStyle: { width: 1.4, color: "#7c3aed", type: "dashed" }, itemStyle: { color: "#7c3aed" } },
  ];

  const yAxis = [
    { type: "value", scale: true,
      axisLine: { lineStyle: { color: axisClr } },
      axisLabel: { color: axisClr, fontSize: 11, formatter: v => v + "%" },
      splitLine: { lineStyle: { color: gridClr } } },
  ];
  if (isTwForeign) {
    const foreignCumF = rebaseCumulative(investors, from);
    series.push({ name: "外資累計", type: "line", yAxisIndex: 1, data: foreignCumF, symbol: "none",
      lineStyle: { width: 1.4, color: "#22c55e" }, itemStyle: { color: "#22c55e" } });
    yAxis.push({ type: "value", scale: true, position: "right",
      axisLine: { lineStyle: { color: "#22c55e" } },
      axisLabel: { color: "#22c55e", fontSize: 11, formatter: v => v.toFixed(0) + "億" },
      splitLine: { show: false } });
  }

  yoyChart.setOption({
    backgroundColor: "transparent",
    title: {
      text: `${MARKET_LABEL[market]}：YoY 疊圖（指數／融資／貨幣供給）`,
      left: 8, top: 4, textStyle: { color: tipText, fontSize: 12, fontWeight: 600 },
    },
    tooltip: {
      trigger: "axis", axisPointer: { type: "cross" },
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: tipText, fontSize: 12 },
      formatter(params) {
        if (!params?.length) return "";
        const ts = params[0].axisValueLabel || params[0].axisValue;
        const dateLabel = typeof ts === "string" ? ts.slice(0, 7) : new Date(ts).toISOString().slice(0, 7);
        let html = `<b>${dateLabel}</b><br/>`;
        for (const p of params) {
          const v = p.value?.[1];
          if (v == null) continue;
          const unit = p.seriesName === "外資累計" ? " 億" : "%";
          html += `<span style="color:${p.color}">●</span> ${p.seriesName}: <b>${fmt(v, unit === "%" ? 1 : 0)}${unit}</b><br/>`;
        }
        return html;
      },
    },
    legend: { data: legendData, top: 26, right: 8, textStyle: { color: tipText, fontSize: 11 } },
    grid: { left: mob() ? 44 : 60, right: isTwForeign ? (mob() ? 60 : 78) : (mob() ? 16 : 32), top: 56, bottom: 28 },
    xAxis: { type: "time", axisLine: { lineStyle: { color: axisClr } },
      axisLabel: { color: axisClr, fontSize: 11 }, splitLine: { show: false } },
    yAxis,
    series,
    dataZoom: [
      { type: "inside" },
      { type: "slider", height: 14, bottom: 4, fillerColor: "rgba(88,166,255,0.12)",
        borderColor: PALETTE.border },
    ],
  }, { notMerge: true });
}

function renderAll() {
  renderSummary();
  renderExcessChart();
  renderYoyChart();

  const statusEl = document.getElementById("liquidity-status");
  if (statusEl) {
    const f = filteredRows();
    const last = f[f.length - 1];
    const parts = [`${MARKET_LABEL[market]}`];
    if (last) parts.push(`最新 ${last.date.slice(0, 7)}`);
    parts.push(`範圍 ${llRange}`);
    const note = llData?.[market]?.note;
    if (note) parts.push(note);
    statusEl.textContent = parts.join(" · ");
  }
}

async function initOnce() {
  if (llData) return;
  await loadAll();
}

export async function activate() {
  const elTop = document.getElementById("liquidity-chart");
  const elBottom = document.getElementById("liquidity-yoy-chart");
  if (!excessChart && elTop) excessChart = echarts.init(elTop, isLight() ? null : "dark");
  if (!yoyChart && elBottom) yoyChart = echarts.init(elBottom, isLight() ? null : "dark");
  try {
    await initOnce();
    setTimeout(() => { excessChart?.resize(); yoyChart?.resize(); renderAll(); }, 50);
  } catch (e) {
    const s = document.getElementById("liquidity-status");
    if (s) s.textContent = "載入失敗：" + (e.message || e);
    console.error("[liquidity] load failed", e);
  }
}

export function onThemeChange(light) {
  if (!excessChart && !yoyChart) return;
  excessChart?.dispose();
  yoyChart?.dispose();
  excessChart = echarts.init(document.getElementById("liquidity-chart"), light ? null : "dark");
  yoyChart = echarts.init(document.getElementById("liquidity-yoy-chart"), light ? null : "dark");
  renderAll();
}

export function resize() { excessChart?.resize(); yoyChart?.resize(); }

// === Event wiring ===
document.getElementById("ll-market-picker")?.addEventListener("click", e => {
  const t = e.target.closest(".chip[data-ll-mkt]");
  if (!t) return;
  market = t.dataset.llMkt;
  for (const c of e.currentTarget.querySelectorAll(".chip"))
    c.classList.toggle("active", c === t);
  const foreignToggle = document.getElementById("ll-foreign-toggle");
  if (foreignToggle) foreignToggle.style.display = market === "tw" ? "" : "none";
  renderAll();
});

document.getElementById("ll-foreign-toggle")?.addEventListener("click", e => {
  if (market !== "tw") return;
  showForeign = !showForeign;
  e.currentTarget.classList.toggle("active", showForeign);
  renderYoyChart();
});

document.getElementById("ll-range-picker")?.addEventListener("click", e => {
  const t = e.target.closest(".chip[data-ll-range]");
  if (!t) return;
  llRange = t.dataset.llRange;
  for (const c of e.currentTarget.querySelectorAll(".chip"))
    c.classList.toggle("active", c === t);
  renderAll();
});
