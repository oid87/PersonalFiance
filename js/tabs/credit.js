// 信用 tab — 殖利率曲線 + 信用利差 + 逾期率 + BDC P/NAV（美國信用市場壓力全景）
//   上 chart (creditChart, 2 stacked grids):
//     Grid 0: 10Y−2Y 殖利率利差 + 0 基準線 + SP500（對數右軸）+ 衰退陰影
//     Grid 1: HY OAS + IG OAS + SP500（對數右軸）
//   下 chart (delinqChart): 信用卡逾期率 + 不動產逾期率（季頻，衰退陰影）
//   底 chart (bdcChart): BDC P/NAV 私募信貸壓力代理（ARCC/OBDC/BXSL/FSK/MAIN）
//
// 資料: credit_spread.json(HY/IG,3yr) / delinquency.json(季,1991+)
//       US10Y.json / US2Y.json(殖利率,2000+) / SP500.json / umich.json(recession)
//       bdc_nav.json(BDC P/NAV,3yr)

import { isLight, tc, mob } from '../utils/theme.js';

const SP_COLOR  = "#f778ba";
const HY_COLOR  = "#f85149";
const IG_COLOR  = "#58a6ff";
const YC_COLOR  = "#e3b341";
const CC_COLOR  = "#f0883e";
const RE_COLOR  = "#79c0ff";
const REC_COLOR = "rgba(248,81,73,0.10)";

const BDC_COLORS = {
  ARCC: "#3fb950", OBDC: "#58a6ff", BXSL: "#f0883e",
  FSK:  "#e3b341", MAIN: "#d2a8ff", avg4: "#a371f7",
};
const BDC_TICKERS = ["ARCC", "OBDC", "BXSL", "FSK", "MAIN"];

let creditChart = null;
let delinqChart = null;
let bdcChart    = null;
let cRange = "10Y";
let showSP = true;

let spreadData = null;   // [{date, hy, ig}]
let yieldData  = null;   // [{date, spread}]
let delinqData = null;   // [{date, credit_card, real_estate}]
let sp500Data  = null;   // [[date, close]]
let recessions = null;   // [{start, end}]
let bdcData    = null;   // [{date, ARCC, OBDC, BXSL, FSK, MAIN, avg, avg4}]

async function loadAll() {
  if (spreadData) return;
  const get = async (path, opt = false) => {
    try {
      const r = await fetch(path, { cache: "no-cache" });
      if (!r.ok) { if (opt) return null; throw new Error(`${path}: HTTP ${r.status}`); }
      return await r.json();
    } catch (e) { if (opt) return null; throw e; }
  };
  const [cs, y10, y2, sp, um, dl, bdc] = await Promise.all([
    get("data/credit_spread.json"),
    get("data/US10Y.json"),
    get("data/US2Y.json"),
    get("data/SP500.json", true),
    get("data/umich.json", true),
    get("data/delinquency.json", true),
    get("data/bdc_nav.json", true),
  ]);

  spreadData = cs?.data ?? [];

  const y2Map = new Map((y2?.data ?? []).map(r => [r.date, r.value]));
  yieldData = (y10?.data ?? [])
    .filter(r => y2Map.has(r.date) && r.value != null && y2Map.get(r.date) != null)
    .map(r => ({ date: r.date, spread: +(r.value - y2Map.get(r.date)).toFixed(3) }));

  delinqData = dl?.data ?? [];
  sp500Data  = (sp?.data ?? []).map(r => [r.date, r.close]);
  recessions = (um?.recessions ?? []).filter(r => r.end >= "1990-01-01");
  bdcData    = bdc?.data ?? [];
}

function rangeStart(key) {
  if (key === "MAX") return "1900-01-01";
  const d = new Date();
  d.setFullYear(d.getFullYear() - ({ "1Y": 1, "3Y": 3, "5Y": 5, "10Y": 10 }[key] ?? 10));
  return d.toISOString().slice(0, 10);
}

function setText(id, txt, color) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = txt;
  if (color) el.style.color = color;
}

function updateCards() {
  const lastS = spreadData[spreadData.length - 1];
  if (lastS) {
    const hy = lastS.hy;
    let sig, clr;
    if (hy >= 8)       { sig = "極高壓力（危機級）";     clr = "#f85149"; }
    else if (hy >= 6)  { sig = "高壓力 · 衰退預警";      clr = "#f0883e"; }
    else if (hy >= 4)  { sig = "偏高 · 市場警覺";        clr = "#e3b341"; }
    else               { sig = "正常水位";                clr = "#3fb950"; }
    setText("crd-hy-val",    hy.toFixed(2) + "%", tc("#e6edf3", "#1f2328"));
    setText("crd-hy-sub",    `IG ${lastS.ig.toFixed(2)}%｜${lastS.date}`, "var(--muted)");
    setText("crd-hy-signal", sig, clr);
  }

  const lastY = yieldData[yieldData.length - 1];
  if (lastY) {
    const s = lastY.spread;
    let sig, clr;
    if (s >= 0.5)      { sig = "正常陡峭 · 寬鬆環境";   clr = "#3fb950"; }
    else if (s >= 0)   { sig = "趨平 · 市場謹慎";        clr = "#e3b341"; }
    else if (s >= -0.5){ sig = "輕微倒掛 · 衰退預警";   clr = "#f0883e"; }
    else               { sig = "深度倒掛 · 歷史強訊號";  clr = "#f85149"; }
    setText("crd-yc-val",    (s >= 0 ? "+" : "") + s.toFixed(2) + "%", s >= 0 ? "#3fb950" : "#f85149");
    setText("crd-yc-sub",    `10Y − 2Y｜${lastY.date}`, "var(--muted)");
    setText("crd-yc-signal", sig, clr);
  }

  const lastD = delinqData[delinqData.length - 1];
  if (lastD) {
    const cc = lastD.credit_card;
    let sig, clr;
    if (cc >= 5)       { sig = "偏高 · 消費者壓力大";   clr = "#f85149"; }
    else if (cc >= 3)  { sig = "正常偏高 · 需留意";      clr = "#e3b341"; }
    else               { sig = "健康水位";                clr = "#3fb950"; }
    setText("crd-del-val",    cc.toFixed(2) + "%", tc("#e6edf3", "#1f2328"));
    setText("crd-del-sub",    `不動產 ${lastD.real_estate.toFixed(2)}%｜${lastD.date}`, "var(--muted)");
    setText("crd-del-signal", sig, clr);
  }

  const lastB = bdcData?.length ? bdcData[bdcData.length - 1] : null;
  if (lastB?.avg4 != null) {
    const a4 = lastB.avg4;
    let sig, clr;
    if (a4 >= 0.95)     { sig = "接近面值 · 市場認可";    clr = "#3fb950"; }
    else if (a4 >= 0.85){ sig = "輕微折價 · 市場存疑";    clr = "#e3b341"; }
    else if (a4 >= 0.75){ sig = "明顯折價 · 私信壓力";    clr = "#f0883e"; }
    else                { sig = "深度折價 · 流動性危機訊號"; clr = "#f85149"; }
    setText("crd-bdc-val",    a4.toFixed(3) + "x", tc("#e6edf3", "#1f2328"));
    setText("crd-bdc-sub",    `ARCC OBDC BXSL FSK 等權重（不含MAIN）｜${lastB.date}`, "var(--muted)");
    setText("crd-bdc-signal", sig, clr);
  }
}

export function render() {
  if (!creditChart || !yieldData) return;
  updateCards();

  const axisClr = tc("#8b949e", "#57606a");
  const gridClr = tc("rgba(48,54,61,0.5)", "rgba(208,215,222,0.4)");
  const tipBg   = tc("#161b22", "#ffffff");
  const tipBdr  = tc("#30363d", "#d0d7de");
  const textClr = tc("#c9d1d9", "#24292f");
  const cutoff  = rangeStart(cRange);

  // Grid 0: yield curve (full history)
  const ycView  = yieldData.filter(r => r.date >= cutoff);
  // Grid 1: HY/IG spread (3yr window from FRED public API)
  const spView  = spreadData.filter(r => r.date >= cutoff);

  const spMap = new Map(sp500Data);
  const spOnYC = showSP ? ycView.map(r => spMap.get(r.date) ?? null) : [];
  const spOnSp = showSP ? spView.map(r => spMap.get(r.date) ?? null) : [];

  const recForYC = (recessions ?? [])
    .filter(r => r.end >= cutoff)
    .map(r => ([
      { xAxis: r.start < cutoff ? cutoff : r.start, itemStyle: { color: REC_COLOR } },
      { xAxis: r.end }
    ]));

  const L = mob() ? 40 : 52, R = showSP ? (mob() ? 48 : 62) : (mob() ? 16 : 28);
  const grid = [
    { left: L, right: R, top: "8%",  height: mob() ? "36%" : "39%" },
    { left: L, right: R, top: "57%", height: mob() ? "31%" : "34%" },
  ];
  const xAxis = [
    { gridIndex: 0, type: "category", data: ycView.map(r => r.date), boundaryGap: false,
      axisLabel: { show: false }, axisLine: { lineStyle: { color: axisClr } },
      axisTick: { show: false }, splitLine: { show: false } },
    { gridIndex: 1, type: "category", data: spView.map(r => r.date), boundaryGap: false,
      axisLabel: { color: axisClr, fontSize: 11 }, axisLine: { lineStyle: { color: axisClr } },
      axisTick: { show: false }, splitLine: { show: false } },
  ];

  const yAxis = [
    { gridIndex: 0, scale: true,
      axisLabel: { color: axisClr, fontSize: 11, formatter: v => v.toFixed(1) + "%" },
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: gridClr } } },
    { gridIndex: 1, scale: true, min: 0,
      axisLabel: { color: axisClr, fontSize: 11, formatter: v => v.toFixed(1) + "%" },
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: gridClr } } },
  ];

  let sp0Idx = -1, sp1Idx = -1;
  if (showSP && sp500Data.length) {
    sp0Idx = yAxis.length;
    yAxis.push({ gridIndex: 0, type: "log", position: "right", scale: true,
      axisLine: { lineStyle: { color: SP_COLOR } },
      axisLabel: { color: SP_COLOR, fontSize: 10, formatter: v => v >= 1000 ? (v / 1000).toFixed(0) + "K" : v },
      splitLine: { show: false } });
    sp1Idx = yAxis.length;
    yAxis.push({ gridIndex: 1, type: "log", position: "right", scale: true,
      axisLine: { lineStyle: { color: SP_COLOR } },
      axisLabel: { color: SP_COLOR, fontSize: 10, formatter: v => v >= 1000 ? (v / 1000).toFixed(0) + "K" : v },
      splitLine: { show: false } });
  }

  const series = [
    { name: "10Y−2Y利差", type: "line", xAxisIndex: 0, yAxisIndex: 0,
      data: ycView.map(r => r.spread), symbol: "none", smooth: false,
      itemStyle: { color: YC_COLOR }, lineStyle: { color: YC_COLOR, width: 1.6 },
      areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1,
        colorStops: [{ offset: 0, color: "rgba(227,179,65,0.18)" }, { offset: 1, color: "rgba(227,179,65,0)" }] } },
      markLine: { silent: true, symbol: "none", data: [
        { yAxis: 0, lineStyle: { color: "#f0883e", type: "dashed", width: 1, opacity: 0.7 },
          label: { formatter: "倒掛基準", color: "#f0883e", fontSize: 9, position: "insideEndTop" } }
      ]},
      markArea: { silent: true, data: recForYC, label: { show: false } },
    },
    { name: "HY OAS", type: "line", xAxisIndex: 1, yAxisIndex: 1,
      data: spView.map(r => r.hy), symbol: "none", smooth: false,
      itemStyle: { color: HY_COLOR }, lineStyle: { color: HY_COLOR, width: 1.8 } },
    { name: "IG OAS", type: "line", xAxisIndex: 1, yAxisIndex: 1,
      data: spView.map(r => r.ig), symbol: "none", smooth: false,
      itemStyle: { color: IG_COLOR }, lineStyle: { color: IG_COLOR, width: 1.4 } },
  ];

  if (showSP && sp0Idx >= 0) {
    series.push(
      { name: "S&P 500", type: "line", xAxisIndex: 0, yAxisIndex: sp0Idx,
        data: spOnYC, symbol: "none", smooth: false, connectNulls: true, z: 2,
        itemStyle: { color: SP_COLOR }, lineStyle: { color: SP_COLOR, width: 1.3, opacity: 0.7 } },
      { name: "S&P 500 ", type: "line", xAxisIndex: 1, yAxisIndex: sp1Idx,
        data: spOnSp, symbol: "none", smooth: false, connectNulls: true, z: 2,
        itemStyle: { color: SP_COLOR }, lineStyle: { color: SP_COLOR, width: 1.3, opacity: 0.7 } }
    );
  }

  const topLegend = ["10Y−2Y利差", ...(showSP ? ["S&P 500"] : [])];
  const btmLegend = ["HY OAS", "IG OAS", ...(showSP ? ["S&P 500 "] : [])];

  creditChart.setOption({
    backgroundColor: "transparent", animation: false,
    tooltip: {
      trigger: "axis", axisPointer: { type: "cross", link: [{ xAxisIndex: "all" }] },
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        if (!params.length) return "";
        const d = params[0]?.axisValue ?? "";
        let html = `<div style="font-weight:600;margin-bottom:4px">${d}</div>`;
        for (const p of params) {
          if (p.value == null) continue;
          if (p.seriesName.startsWith("S&P")) {
            html += `<div>${p.marker}S&P 500: <b>${(+p.value).toFixed(0)}</b></div>`;
          } else {
            html += `<div>${p.marker}${p.seriesName}: <b>${(+p.value).toFixed(2)}%</b></div>`;
          }
        }
        return html;
      },
    },
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    grid, xAxis, yAxis,
    dataZoom: [{ type: "inside", xAxisIndex: [0, 1], filterMode: "none" }],
    legend: [
      { data: topLegend, top: 2,    left: "center", textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr },
      { data: btmLegend, top: "50%", left: "center", textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr },
    ],
    series,
  }, { notMerge: true });

  renderDelinq(textClr, axisClr, gridClr, tipBg, tipBdr, cutoff);
  renderBDC(textClr, axisClr, gridClr, tipBg, tipBdr, cutoff);
}

function renderDelinq(textClr, axisClr, gridClr, tipBg, tipBdr, cutoff) {
  if (!delinqChart || !delinqData.length) return;
  const view = delinqData.filter(r => r.date >= cutoff);
  if (!view.length) return;

  const recAreas = (recessions ?? [])
    .filter(r => r.end >= cutoff)
    .map(r => ([
      { xAxis: r.start < cutoff ? cutoff : r.start, itemStyle: { color: REC_COLOR } },
      { xAxis: r.end }
    ]));

  delinqChart.setOption({
    backgroundColor: "transparent", animation: false,
    tooltip: {
      trigger: "axis",
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        if (!params.length) return "";
        const d = params[0]?.axisValue ?? "";
        let html = `<div style="font-weight:600;margin-bottom:4px">${d}</div>`;
        for (const p of params) {
          if (p.value == null) continue;
          html += `<div>${p.marker}${p.seriesName}: <b>${(+p.value).toFixed(2)}%</b></div>`;
        }
        return html;
      },
    },
    grid: { left: mob() ? 40 : 52, right: mob() ? 16 : 28, top: "17%", bottom: "14%" },
    xAxis: {
      type: "category", data: view.map(r => r.date), boundaryGap: false,
      axisLabel: { color: axisClr, fontSize: 11 }, axisLine: { lineStyle: { color: axisClr } },
      axisTick: { show: false }, splitLine: { show: false },
    },
    yAxis: {
      scale: true, min: 0,
      axisLabel: { color: axisClr, fontSize: 11, formatter: v => v.toFixed(1) + "%" },
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: gridClr } },
    },
    legend: {
      data: ["信用卡逾期率", "不動產逾期率"], top: 4, left: "center",
      textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr,
    },
    series: [
      { name: "信用卡逾期率", type: "line", data: view.map(r => r.credit_card),
        symbol: "circle", symbolSize: 5, smooth: false,
        itemStyle: { color: CC_COLOR }, lineStyle: { color: CC_COLOR, width: 2 },
        markArea: { silent: true, data: recAreas, label: { show: false } },
      },
      { name: "不動產逾期率", type: "line", data: view.map(r => r.real_estate),
        symbol: "circle", symbolSize: 5, smooth: false,
        itemStyle: { color: RE_COLOR }, lineStyle: { color: RE_COLOR, width: 2 },
      },
    ],
    dataZoom: [{ type: "inside", filterMode: "none" }],
  }, { notMerge: true });
}

function renderBDC(textClr, axisClr, gridClr, tipBg, tipBdr, cutoff) {
  if (!bdcChart || !bdcData?.length) return;
  const view = bdcData.filter(r => r.date >= cutoff && r.avg4 != null);
  if (!view.length) return;

  const series = BDC_TICKERS.map(t => ({
    name: t,
    type: "line",
    data: view.map(r => r[t] ?? null),
    symbol: "none", smooth: false, connectNulls: true,
    itemStyle: { color: BDC_COLORS[t] },
    lineStyle: { color: BDC_COLORS[t], width: t === "MAIN" ? 1.2 : 1.5 },
  }));

  series.push({
    name: "avg4（非MAIN）",
    type: "line",
    data: view.map(r => r.avg4 ?? null),
    symbol: "none", smooth: false, connectNulls: true,
    itemStyle: { color: BDC_COLORS.avg4 },
    lineStyle: { color: BDC_COLORS.avg4, width: 2.2 },
    markLine: { silent: true, symbol: "none", data: [
      { yAxis: 1.0,
        lineStyle: { color: "#f0883e", type: "dashed", width: 1, opacity: 0.7 },
        label: { formatter: "NAV面值", color: "#f0883e", fontSize: 9, position: "insideEndTop" } },
    ]},
  });

  bdcChart.setOption({
    backgroundColor: "transparent", animation: false,
    tooltip: {
      trigger: "axis",
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        if (!params.length) return "";
        const d = params[0]?.axisValue ?? "";
        let html = `<div style="font-weight:600;margin-bottom:4px">${d}</div>`;
        for (const p of params) {
          if (p.value == null) continue;
          html += `<div>${p.marker}${p.seriesName}: <b>${(+p.value).toFixed(3)}x</b></div>`;
        }
        return html;
      },
    },
    grid: { left: mob() ? 40 : 52, right: mob() ? 16 : 28, top: "17%", bottom: "14%" },
    xAxis: {
      type: "category", data: view.map(r => r.date), boundaryGap: false,
      axisLabel: { color: axisClr, fontSize: 11 },
      axisLine: { lineStyle: { color: axisClr } },
      axisTick: { show: false }, splitLine: { show: false },
    },
    yAxis: {
      scale: true,
      axisLabel: { color: axisClr, fontSize: 11, formatter: v => v.toFixed(2) + "x" },
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: gridClr } },
    },
    legend: {
      data: [...BDC_TICKERS, "avg4（非MAIN）"], top: 4, left: "center",
      textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr,
    },
    dataZoom: [{ type: "inside", filterMode: "none" }],
    series,
  }, { notMerge: true });
}

function buildControls() {
  const rp = document.getElementById("crd-range-picker");
  if (rp && !rp.dataset.built) {
    rp.dataset.built = "1";
    rp.addEventListener("click", e => {
      const t = e.target.closest(".chip[data-crd-range]");
      if (!t) return;
      cRange = t.dataset.crdRange;
      rp.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c === t));
      render();
    });
  }
  const sb = document.getElementById("crd-sp-toggle");
  if (sb && !sb.dataset.built) {
    sb.dataset.built = "1";
    sb.addEventListener("click", () => {
      showSP = !showSP;
      sb.classList.toggle("active", showSP);
      render();
    });
  }
}

export async function activate() {
  const h1 = document.getElementById("crd-chart");
  const h2 = document.getElementById("crd-delinq-chart");
  const h3 = document.getElementById("crd-bdc-chart");
  if (!h1 || !h2) return;
  if (!creditChart) creditChart = echarts.init(h1, isLight() ? null : "dark");
  if (!delinqChart) delinqChart = echarts.init(h2, isLight() ? null : "dark");
  if (h3 && !bdcChart) bdcChart = echarts.init(h3, isLight() ? null : "dark");
  buildControls();
  try {
    await loadAll();
    setTimeout(() => { creditChart?.resize(); delinqChart?.resize(); bdcChart?.resize(); render(); }, 50);
  } catch (e) {
    const s = document.getElementById("crd-status");
    if (s) s.textContent = "載入失敗：" + (e.message || e);
    console.error("[credit] load failed", e);
  }
}

export function onThemeChange(light) {
  if (creditChart) {
    creditChart.dispose();
    creditChart = echarts.init(document.getElementById("crd-chart"), light ? null : "dark");
  }
  if (delinqChart) {
    delinqChart.dispose();
    delinqChart = echarts.init(document.getElementById("crd-delinq-chart"), light ? null : "dark");
  }
  if (bdcChart) {
    bdcChart.dispose();
    bdcChart = echarts.init(document.getElementById("crd-bdc-chart"), light ? null : "dark");
  }
  if (spreadData) render();
}

export function resize() {
  creditChart?.resize();
  delinqChart?.resize();
  bdcChart?.resize();
}
