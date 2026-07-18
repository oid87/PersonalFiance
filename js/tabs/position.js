// 位階 tab — 乖離率 + 布林通道（美股 style 20/50/200）
//   上 grid: 收盤價 + MA20/50/200 + 選定週期的布林 ±2σ 通道
//   下 grid: 乖離率（20/50/200，選定者加粗）+ 選定週期乖離的 ±1σ/±2σ 參考帶
//   標的: SPY/VOO · QQQ · SOXX
//
// 全部前端計算（rolling mean/std），資料直接讀現有 data/<TICKER>.json，無需新 fetch 腳本。
// 設計參考某總經 Youtuber：季線(50)布林下緣＝多頭低位階買點、年線(200)布林上緣＝短線過熱、
// 年線乖離＝過熱輔助；務必用「年線之上＝多頭」當狀態濾網（空頭沿著下緣走，碰下緣非買點）。

import { loaded, loadedHLC, loadedVol } from '../state.js';
import { isLight, tc, mob, PALETTE } from '../utils/theme.js';
import { ensureLoaded } from '../utils/data.js';

const MOM_PERIODS = [{ key: "1M", n: 21 }, { key: "3M", n: 63 }, { key: "6M", n: 126 }, { key: "12M", n: 252 }];
const ATR_PERIOD = 14;
const HL_WINDOW  = 252; // 52週（交易日）

const POS_TICKERS = [
  { key: "SPY",  label: "SPY / VOO",   color: "#a371f7" },
  { key: "QQQ",  label: "QQQ",          color: "#f778ba" },
  { key: "SOXX", label: "SOXX 半導體",  color: "#22d3ee" },
  { key: "TWII", label: "台灣加權",     color: "#3fb950" },
];
const PERIODS   = [20, 50, 200];
const MA_COLOR  = { 20: "#58a6ff", 50: "#e3b341", 200: "#f85149" };
const MA_NAME   = { 20: "MA20 月線", 50: "MA50 季線", 200: "MA200 年線" };

let posChart  = null;
let posTicker = "SPY";
let posPeriod = 50;
let posRange  = "3Y";
const rowCache = {};   // ticker -> computed rows

// ── compute: rolling mean/std → ma{p}, sd{p}, bias{p} for each period ──
function computeRows(closes /* [[date, close], …] ascending */, hlc, vol) {
  const n = closes.length;
  const rows = closes.map(c => ({ date: c[0], close: c[1] }));
  for (const p of PERIODS) {
    let sum = 0, sumsq = 0;
    for (let i = 0; i < n; i++) {
      const v = closes[i][1];
      sum += v; sumsq += v * v;
      if (i >= p) { const o = closes[i - p][1]; sum -= o; sumsq -= o * o; }
      if (i >= p - 1) {
        const mean = sum / p;
        const sd   = Math.sqrt(Math.max(0, sumsq / p - mean * mean));
        const r = rows[i];
        r[`ma${p}`]   = mean;
        r[`sd${p}`]   = sd;
        r[`bias${p}`] = (v - mean) / mean * 100;
      }
    }
  }

  // 動能：N 日前收盤 → 報酬率
  for (const { key, n: w } of MOM_PERIODS) {
    for (let i = 0; i < n; i++) {
      if (i < w) continue;
      const prev = closes[i - w][1];
      rows[i][`mom${key}`] = (closes[i][1] - prev) / prev * 100;
    }
  }

  if (hlc && hlc.length === n) {
    for (let i = 0; i < n; i++) { rows[i].high = hlc[i][1]; rows[i].low = hlc[i][2]; }

    // ATR14（Wilder's）：TR = max(高-低, |高-昨收|, |低-昨收|)
    let atr = null;
    for (let i = 0; i < n; i++) {
      if (i === 0) continue;
      const { high, low } = rows[i];
      const prevClose = rows[i - 1].close;
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      if (i < ATR_PERIOD) continue;
      if (i === ATR_PERIOD) {
        let sumTr = 0;
        for (let j = 1; j <= ATR_PERIOD; j++) {
          const h = rows[j].high, l = rows[j].low, pc = rows[j - 1].close;
          sumTr += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
        }
        atr = sumTr / ATR_PERIOD;
      } else {
        atr = (atr * (ATR_PERIOD - 1) + tr) / ATR_PERIOD;
      }
      rows[i].atr14 = atr;
    }

    // 52週（滾動 HL_WINDOW 交易日）高低 → 前高前低支撐壓力
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - HL_WINDOW + 1);
      let hh = -Infinity, ll = Infinity;
      for (let j = lo; j <= i; j++) { if (rows[j].high > hh) hh = rows[j].high; if (rows[j].low < ll) ll = rows[j].low; }
      rows[i].hh252 = hh; rows[i].ll252 = ll;
    }
  }
  if (vol && vol.length === n) {
    for (let i = 0; i < n; i++) rows[i].volume = vol[i][1];
  }
  return rows;
}

// full-history distribution of bias{p} → {mean, sd, vals}
function biasDist(rows, p) {
  const vals = [];
  for (const r of rows) { const v = r[`bias${p}`]; if (v != null && isFinite(v)) vals.push(v); }
  if (!vals.length) return null;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd   = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length);
  return { mean, sd, vals };
}
function pctRank(vals, x) {
  let c = 0; for (const v of vals) if (v <= x) c++;
  return c / vals.length * 100;
}

function rangeCutoff(key) {
  if (key === "MAX") return "0000-00-00";
  const d = new Date();
  ({ "1Y": () => d.setFullYear(d.getFullYear() - 1),
     "3Y": () => d.setFullYear(d.getFullYear() - 3),
     "5Y": () => d.setFullYear(d.getFullYear() - 5) })[key]?.();
  return d.toISOString().slice(0, 10);
}

function cfg() { return POS_TICKERS.find(t => t.key === posTicker) || POS_TICKERS[0]; }

// ── readout cards ──────────────────────────────────────────────────
function setText(id, txt, color) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = txt;
  if (color) el.style.color = color;
}

function updateCards(rows, dist) {
  const p    = posPeriod;
  const last = rows[rows.length - 1];
  const bull = last.close > last[`ma200`];

  document.getElementById("pos-zone-period").textContent = p;
  document.getElementById("pos-bias-period").textContent = p;

  // 位階：%B over the selected period's ±2σ band
  const up2 = last[`ma${p}`] + 2 * last[`sd${p}`];
  const lo2 = last[`ma${p}`] - 2 * last[`sd${p}`];
  const pctB = (up2 - lo2) > 0 ? (last.close - lo2) / (up2 - lo2) * 100 : null;
  let zSig, zClr;
  if (pctB == null)       { zSig = "—";                       zClr = "var(--muted)"; }
  else if (pctB >= 100)   { zSig = `突破${p}日布林上緣 · 過熱`; zClr = "#f85149"; }
  else if (pctB >= 80)    { zSig = "接近上緣 · 偏熱";          zClr = "#f0883e"; }
  else if (pctB > 20)     { zSig = "通道內 · 正常";            zClr = "var(--muted)"; }
  else if (pctB > 0)      { zSig = "接近下緣 · 偏弱";          zClr = "#f0883e"; }
  else                    { zSig = bull ? `跌破${p}日布林下緣 · 超賣（多頭買點候選）` : `跌破下緣 · 空頭沿帶（非買點）`;
                            zClr = bull ? "#3fb950" : "#f85149"; }
  setText("pos-zone-pct", pctB == null ? "—" : pctB.toFixed(0), PALETTE.text);
  setText("pos-zone-sub", `${MA_NAME[p]} ±2σ｜上 ${up2.toFixed(1)} / 下 ${lo2.toFixed(1)}`, "var(--muted)");
  setText("pos-zone-signal", zSig, zClr);

  // 乖離率：value + percentile
  const bias = last[`bias${p}`];
  let pr = null, bSig, bClr;
  if (bias == null || !dist) { bSig = "—"; bClr = "var(--muted)"; }
  else {
    pr = pctRank(dist.vals, bias);
    if      (pr >= 90) { bSig = "歷史高檔 · 過熱";  bClr = "#f85149"; }
    else if (pr >= 70) { bSig = "偏高 · 偏熱";      bClr = "#f0883e"; }
    else if (pr >  30) { bSig = "區間中段 · 正常";  bClr = "var(--muted)"; }
    else if (pr >  10) { bSig = "偏低 · 偏弱";      bClr = "#f0883e"; }
    else               { bSig = "歷史低檔 · 超賣";  bClr = "#3fb950"; }
  }
  setText("pos-bias-pct", bias == null ? "—" : (bias >= 0 ? "+" : "") + bias.toFixed(1),
          bias == null ? "var(--muted)" : (bias >= 0 ? "#f0883e" : "#58a6ff"));
  setText("pos-bias-sub", pr == null ? "—" : `歷史第 ${pr.toFixed(0)} 百分位（均值 ${dist.mean.toFixed(1)}%）`, "var(--muted)");
  setText("pos-bias-signal", bSig, bClr);

  // 趨勢濾網：price vs MA200 + MA200 slope
  const i200 = rows.length - 1;
  const prev = rows[Math.max(0, i200 - 20)][`ma200`];
  const slopeUp = last[`ma200`] != null && prev != null && last[`ma200`] >= prev;
  let rVal, rSig, rClr;
  if (last.close == null || last[`ma200`] == null) { rVal = "—"; rSig = "—"; rClr = "var(--muted)"; }
  else if (bull) {
    rVal = "▲ 站上年線";
    rSig = slopeUp ? "多頭 · 年線上彎" : "偏多 · 站上年線但年線下彎";
    rClr = slopeUp ? "#3fb950" : "#e3b341";
  } else {
    rVal = "▼ 跌破年線";
    rSig = "空頭 · 布林下緣買點要保守看";
    rClr = "#f85149";
  }
  setText("pos-regime-pct", rVal, rClr);
  const vsMa = ((last.close - last[`ma200`]) / last[`ma200`] * 100);
  setText("pos-regime-sub", `現價 ${last.close.toFixed(2)}｜距年線 ${vsMa >= 0 ? "+" : ""}${vsMa.toFixed(1)}%`, "var(--muted)");
  setText("pos-regime-signal", rSig, rClr);

  // 動能：1M/3M/6M/12M 報酬率（time-series momentum，非超買超賣型指標）
  const m12 = last.mom12M;
  setText("pos-mom-pct", m12 == null ? "—" : (m12 >= 0 ? "+" : "") + m12.toFixed(1),
          m12 == null ? "var(--muted)" : (m12 >= 0 ? "#3fb950" : "#f85149"));
  const momStr = MOM_PERIODS.map(({ key }) => {
    const v = last[`mom${key}`];
    return `${key} ${v == null ? "—" : (v >= 0 ? "+" : "") + v.toFixed(1) + "%"}`;
  }).join("　");
  setText("pos-mom-sub", momStr, "var(--muted)");
  const posCount = MOM_PERIODS.filter(({ key }) => (last[`mom${key}`] ?? 0) > 0).length;
  let mSig, mClr;
  if (last.mom1M == null) { mSig = "—"; mClr = "var(--muted)"; }
  else if (posCount === MOM_PERIODS.length)      { mSig = "全期正報酬 · 動能強勢"; mClr = "#3fb950"; }
  else if (posCount === 0)                        { mSig = "全期負報酬 · 動能弱勢"; mClr = "#f85149"; }
  else                                             { mSig = "多空混雜 · 動能不一致"; mClr = "#e3b341"; }
  setText("pos-mom-signal", mSig, mClr);

  // 波動度：ATR14 佔股價 %（不判斷方向，只給停損/部位大小的風險量尺）
  const atr = last.atr14;
  let aSig, aClr;
  if (atr == null) { aSig = "—"; aClr = "var(--muted)"; }
  else {
    setText("pos-atr-pct", (atr / last.close * 100).toFixed(2), PALETTE.text);
    const stop15 = last.close - 1.5 * atr, stop3 = last.close - 3 * atr;
    setText("pos-atr-sub", `ATR ${atr.toFixed(2)}｜停損參考：1.5×ATR ${stop15.toFixed(1)} ／ 3×ATR ${stop3.toFixed(1)}`, "var(--muted)");
    const atrPctOfPrice = atr / last.close * 100;
    if      (atrPctOfPrice >= 4) { aSig = "波動偏大 · 部位宜縮小"; aClr = "#f85149"; }
    else if (atrPctOfPrice >= 2) { aSig = "波動中等"; aClr = "#e3b341"; }
    else                         { aSig = "波動偏低"; aClr = "#3fb950"; }
  }
  if (atr != null) setText("pos-atr-signal", aSig, aClr);
  else { setText("pos-atr-pct", "—"); setText("pos-atr-sub", "—"); setText("pos-atr-signal", "—", "var(--muted)"); }

  // 支撐壓力：52 週（滾動 252 交易日）高低
  const hh = last.hh252, ll = last.ll252;
  if (hh == null || ll == null) {
    setText("pos-hl-pct", "—"); setText("pos-hl-sub", "—"); setText("pos-hl-signal", "—", "var(--muted)");
  } else {
    const toHigh = (hh - last.close) / last.close * 100;
    const toLow  = (last.close - ll) / last.close * 100;
    setText("pos-hl-pct", (-toHigh).toFixed(1), PALETTE.text);
    setText("pos-hl-sub", `壓力(高) ${hh.toFixed(1)} 距 ${toHigh.toFixed(1)}%｜支撐(低) ${ll.toFixed(1)} 距 ${toLow.toFixed(1)}%`, "var(--muted)");
    let hSig, hClr;
    if      (toHigh <= 1) { hSig = "貼近52週高點 · 壓力區"; hClr = "#f85149"; }
    else if (toLow  <= 1) { hSig = "貼近52週低點 · 支撐區"; hClr = "#3fb950"; }
    else                  { hSig = "區間內"; hClr = "var(--muted)"; }
    setText("pos-hl-signal", hSig, hClr);
  }
}

// ── render chart ───────────────────────────────────────────────────
function render(rows) {
  if (!posChart) return;
  const t = cfg(), p = posPeriod;
  const axisClr = PALETTE.muted;
  const gridClr = PALETTE.grid;
  const tipBg   = PALETTE.bg;
  const tipBdr  = PALETTE.border;
  const textClr = PALETTE.text2;

  const dist = biasDist(rows, p);          // full-history bias stats (stable reference)
  updateCards(rows, dist);

  const cutoff  = rangeCutoff(posRange);
  const view    = rows.filter(r => r.date >= cutoff);
  const dates   = view.map(r => r.date);
  const px       = view.map(r => +r.close.toFixed(2));
  const maData   = Object.fromEntries(PERIODS.map(q =>
                     [q, view.map(r => r[`ma${q}`]   != null ? +r[`ma${q}`].toFixed(2) : null)]));
  const biasData = Object.fromEntries(PERIODS.map(q =>
                     [q, view.map(r => r[`bias${q}`] != null ? +r[`bias${q}`].toFixed(2) : null)]));
  const lo2 = view.map(r => r[`ma${p}`] != null ? +(r[`ma${p}`] - 2 * r[`sd${p}`]).toFixed(2) : null);
  const band = view.map(r => r[`ma${p}`] != null ? +(4 * r[`sd${p}`]).toFixed(2) : null);   // upper2-lower2
  const up2 = view.map(r => r[`ma${p}`] != null ? +(r[`ma${p}`] + 2 * r[`sd${p}`]).toFixed(2) : null);
  const hasVol = t.key !== "TWII"; // 台灣加權指數量值不具意義
  const volData = hasVol ? view.map((r, i) => {
    const up = i === 0 ? true : r.close >= view[i - 1].close;
    return { value: r.volume ?? null, itemStyle: { color: up ? "#3fb95080" : "#f8514980" } };
  }) : [];

  const status = document.getElementById("pos-status");
  if (status) status.textContent =
    `${t.label} · ${MA_NAME[p]} 布林通道 + 乖離率 · ${dates.length} 個交易日（${posRange}）· 全前端計算`;

  // grid: 上 價格+52週高低, 中 成交量, 下 乖離；底部留 ~16% 給圖例
  const L = mob() ? 46 : 56, R = mob() ? 46 : 56;
  const grid = [
    { left: L, right: R, top: "3%",  height: mob() ? "34%" : "36%" },
    { left: L, right: R, top: mob() ? "40%" : "42%", height: mob() ? "10%" : "11%" },
    { left: L, right: R, top: "58%", height: mob() ? "22%" : "25%" },
  ];
  const xAxis = grid.map((_, i) => ({
    gridIndex: i, type: "category", data: dates, boundaryGap: i === 1,
    axisLine:  { lineStyle: { color: axisClr } }, axisTick: { show: false },
    axisLabel: { show: i === 2, color: axisClr, fontSize: 11 },
    splitLine: { show: false },
  }));
  const selColor = MA_COLOR[p];
  const yAxis = [
    { gridIndex: 0, scale: true, position: "left",
      axisLabel: { color: axisClr, fontSize: 11 }, axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: gridClr } } },
    { gridIndex: 1, name: "量", nameTextStyle: { color: axisClr, fontSize: 10 }, scale: true,
      axisLabel: { show: false }, axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false } },
    { gridIndex: 2, name: "乖離%", nameTextStyle: { color: axisClr, fontSize: 10 }, scale: true,
      axisLabel: { color: axisClr, fontSize: 10, formatter: v => v + "%" },
      axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: gridClr } } },
  ];

  // bottom bias reference markLines (selected period, full-history mean ±1σ/±2σ)
  const biasMarks = [];
  if (dist) {
    const m = dist.mean, s = dist.sd;
    biasMarks.push(
      { yAxis: 0,        lineStyle: { color: axisClr, type: "solid", width: 1, opacity: .4 } },
      { yAxis: +(m + 2 * s).toFixed(2), lineStyle: { color: "#f85149", type: "dashed", width: 1 },
        label: { formatter: "+2σ 過熱", color: "#f85149", fontSize: 10, position: "insideEndTop" } },
      { yAxis: +(m + s).toFixed(2),     lineStyle: { color: "#f0883e", type: "dashed", width: 1, opacity: .6 },
        label: { formatter: "+1σ", color: "#f0883e", fontSize: 9, position: "insideEndTop" } },
      { yAxis: +(m - s).toFixed(2),     lineStyle: { color: "#3fb950", type: "dashed", width: 1, opacity: .6 },
        label: { formatter: "-1σ", color: "#3fb950", fontSize: 9, position: "insideEndBottom" } },
      { yAxis: +(m - 2 * s).toFixed(2), lineStyle: { color: "#3fb950", type: "dashed", width: 1 },
        label: { formatter: "-2σ 超賣", color: "#3fb950", fontSize: 10, position: "insideEndBottom" } },
    );
  }
  // QQQ 年線(200日)固定 +20% 過熱參考線（指數專用 rule of thumb，只在 QQQ 顯示）
  if (posTicker === "QQQ" && p === 200) {
    biasMarks.push({
      yAxis: 20,
      lineStyle: { color: "#d2a8ff", type: "dashed", width: 1.5 },
      label: { formatter: "QQQ 年線 +20% 過熱", color: "#d2a8ff", fontSize: 10, position: "insideStartTop" },
    });
  }

  const maSeries = PERIODS.map(q => ({
    name: MA_NAME[q], type: "line", xAxisIndex: 0, yAxisIndex: 0, data: maData[q],
    symbol: "none", smooth: false, z: q === p ? 4 : 3,
    lineStyle: { color: MA_COLOR[q], width: q === p ? 2 : 1, opacity: q === p ? 1 : 0.5 },
  }));
  const biasSeries = PERIODS.map(q => ({
    name: `乖離${q}`, type: "line", xAxisIndex: 2, yAxisIndex: 2, data: biasData[q],
    symbol: "none", smooth: false, z: q === p ? 4 : 2,
    lineStyle: { color: MA_COLOR[q], width: q === p ? 2 : 1, opacity: q === p ? 1 : 0.35 },
    ...(q === p ? { markLine: { silent: true, symbol: "none", data: biasMarks } } : {}),
  }));

  // 52 週高低（前高前低支撐壓力）：取視窗內最新一筆的 rolling hh252/ll252 當水平線
  const hlMarks = [];
  const lastView = view[view.length - 1];
  if (lastView?.hh252 != null) {
    hlMarks.push(
      { yAxis: +lastView.hh252.toFixed(2), lineStyle: { color: "#f85149", type: "dotted", width: 1.5 },
        label: { formatter: "52週高", color: "#f85149", fontSize: 10, position: "insideEndTop" } },
      { yAxis: +lastView.ll252.toFixed(2), lineStyle: { color: "#3fb950", type: "dotted", width: 1.5 },
        label: { formatter: "52週低", color: "#3fb950", fontSize: 10, position: "insideEndBottom" } },
    );
  }

  const series = [
    // Bollinger ±2σ band fill (stacked: base = lower2, fill = height)
    { name: "_bbase", type: "line", xAxisIndex: 0, yAxisIndex: 0, data: lo2, stack: "bb",
      symbol: "none", silent: true, lineStyle: { opacity: 0 }, areaStyle: { opacity: 0 }, z: 1 },
    { name: "_bfill", type: "line", xAxisIndex: 0, yAxisIndex: 0, data: band, stack: "bb",
      symbol: "none", silent: true, lineStyle: { opacity: 0 },
      areaStyle: { color: selColor, opacity: 0.10 }, z: 1 },
    // band boundary lines
    { name: "_bup", type: "line", xAxisIndex: 0, yAxisIndex: 0, data: up2, symbol: "none", silent: true,
      lineStyle: { color: selColor, width: 1, type: "dashed", opacity: 0.55 }, z: 2 },
    { name: "_blo", type: "line", xAxisIndex: 0, yAxisIndex: 0, data: lo2, symbol: "none", silent: true,
      lineStyle: { color: selColor, width: 1, type: "dashed", opacity: 0.55 }, z: 2 },
    ...maSeries,
    { name: t.label, type: "line", xAxisIndex: 0, yAxisIndex: 0, data: px,
      symbol: "none", smooth: false, z: 5, lineStyle: { color: t.color, width: 1.8 },
      markLine: { silent: true, symbol: "none", data: hlMarks } },
    { name: "成交量", type: "bar", xAxisIndex: 1, yAxisIndex: 1, data: volData,
      large: true, silent: true, z: 1 },
    ...biasSeries,
  ];

  posChart.setOption({
    backgroundColor: "transparent", animation: false,
    tooltip: {
      trigger: "axis", axisPointer: { type: "cross", link: [{ xAxisIndex: "all" }] },
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        const d = params[0]?.axisValue ?? "";
        let html = `<div style="font-weight:600;margin-bottom:4px">${d}</div>`;
        for (const pm of params) {
          if (pm.seriesName.startsWith("_") || pm.value == null) continue;
          const isBias = pm.seriesName.startsWith("乖離");
          const raw = pm.seriesName === "成交量" ? pm.value?.value : pm.value;
          if (raw == null) continue;
          const val = isBias ? `${raw >= 0 ? "+" : ""}${(+raw).toFixed(2)}%`
                     : pm.seriesName === "成交量" ? (+raw).toLocaleString()
                     : (+raw).toFixed(2);
          html += `<div>${pm.marker}${pm.seriesName}: <b>${val}</b></div>`;
        }
        return html;
      },
    },
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    grid, xAxis, yAxis,
    dataZoom: [{ type: "inside", xAxisIndex: [0, 1, 2], filterMode: "none" }],
    legend: {
      data: [t.label, ...PERIODS.map(q => MA_NAME[q])],
      top: "bottom", textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr,
    },
    series,
  }, { notMerge: true });
}

// ── controls (idempotent) ──────────────────────────────────────────
function buildControls() {
  const tp = document.getElementById("pos-ticker-picker");
  if (tp && !tp.dataset.built) {
    tp.innerHTML = POS_TICKERS.map(t =>
      `<span class="chip${t.key === posTicker ? " active" : ""}" data-pos-ticker="${t.key}">${t.label}</span>`).join("");
    tp.dataset.built = "1";
    tp.querySelectorAll(".chip").forEach(c => c.addEventListener("click", () => {
      tp.querySelectorAll(".chip").forEach(e => e.classList.remove("active"));
      c.classList.add("active");
      posTicker = c.dataset.posTicker;
      refresh();
    }));
  }
  const pickWire = (sel, attr, set) => {
    const host = document.getElementById(sel);
    if (!host || host.dataset.built) return;
    host.dataset.built = "1";
    host.querySelectorAll(".chip").forEach(c => c.addEventListener("click", () => {
      host.querySelectorAll(".chip").forEach(e => e.classList.remove("active"));
      c.classList.add("active");
      set(c.dataset[attr]);
      render(rowCache[posTicker]);
    }));
  };
  pickWire("pos-period-picker", "posPeriod", v => posPeriod = +v);
  pickWire("pos-range-picker",  "posRange",  v => posRange  = v);
}

async function refresh() {
  const status = document.getElementById("pos-status");
  try {
    await ensureLoaded(posTicker);
    let rows = rowCache[posTicker];
    if (!rows) {
      rows = computeRows(loaded[posTicker], loadedHLC[posTicker], loadedVol[posTicker]);
      rowCache[posTicker] = rows;
    }
    render(rows);
  } catch (e) {
    if (status) status.textContent = `載入失敗：${e.message}`;
  }
}

// ── lifecycle ──────────────────────────────────────────────────────
export async function activate() {
  const host = document.getElementById("pos-chart");
  if (!host) return;
  if (!posChart) posChart = echarts.init(host, isLight() ? null : "dark");
  buildControls();
  await refresh();
}
export function onThemeChange(light) {
  if (!posChart) return;
  posChart.dispose();
  posChart = echarts.init(document.getElementById("pos-chart"), light ? null : "dark");
  if (rowCache[posTicker]) render(rowCache[posTicker]);
}
export function resize() { posChart?.resize(); }
