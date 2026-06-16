// 量價 tab — ^TWII + QQQ 雙標的量價結構
//   每個標的兩格 grid：
//     · 上 grid: 收盤價（黑/白）+ OBV 累積能量線（紫，右軸）
//     · 下 grid: 成交量柱（漲紅跌綠）+ 20 日均量（橘虛線）
//   目的：肉眼比對「價漲量增/縮」「OBV 與價背離」型態。
//   資料來源：data/TWII.json, data/QQQ.json（已含 volume）

import { isLight, tc, mob } from '../utils/theme.js';

let vpChart = null;
let vpRange = "1Y";
let showOBV = true;
let showMA20Vol = true;
let showDivergence = false;

// raw cache
let twii = null;   // [{date,open,close,volume}]
let qqq  = null;

async function loadAll() {
  const fj = async (path) => {
    const r = await fetch(path, { cache: "no-cache" });
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json();
  };
  const [t, q] = await Promise.all([
    fj("data/TWII.json"),
    fj("data/QQQ.json"),
  ]);
  twii = (t?.data ?? []).filter(r => r.volume > 0);   // skip早期 volume=0 列
  qqq  = (q?.data ?? []).filter(r => r.volume > 0);
}

function rangeStart(key) {
  if (key === "MAX") return "1900-01-01";
  const d = new Date();
  const map = { "6M": 0.5, "1Y": 1, "2Y": 2, "5Y": 5 };
  const years = map[key] ?? 1;
  d.setMonth(d.getMonth() - Math.round(years * 12));
  return d.toISOString().slice(0, 10);
}

// OBV: 起始 0；當日 close > 前日 → +volume；< → -volume；= → 0
function computeOBV(rows) {
  if (!rows.length) return [];
  const out = new Array(rows.length);
  let obv = 0;
  out[0] = [rows[0].date, 0];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1].close;
    const cur = rows[i].close;
    const v = rows[i].volume || 0;
    if (cur > prev) obv += v;
    else if (cur < prev) obv -= v;
    out[i] = [rows[i].date, obv];
  }
  return out;
}

// 20-day SMA of volume
function ma(rows, n) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < rows.length; i++) {
    sum += rows[i].volume || 0;
    if (i >= n) sum -= rows[i - n].volume || 0;
    if (i >= n - 1) out.push([rows[i].date, +(sum / n).toFixed(0)]);
  }
  return out;
}

// 將 volume bars 拆成漲日(綠/紅)與跌日，顏色由前一日 close 決定
function volBars(rows) {
  if (!rows.length) return [];
  return rows.map((r, i) => {
    const prev = i > 0 ? rows[i - 1].close : r.close;
    const up = r.close >= prev;
    return {
      value: [r.date, r.volume],
      itemStyle: { color: up ? "rgba(239,68,68,0.65)" : "rgba(34,197,94,0.65)" },
    };
  });
}

function pricePoints(rows) {
  return rows.map(r => [r.date, r.close]);
}

// 偵測量價背離（60D rolling window）
//   bull (底部背離): 當日 close 創 60D 新低，但 OBV > 60D 最低 OBV * (1 - tol)
//   bear (頂部背離): 當日 close 創 60D 新高，但 OBV < 60D 最高 OBV * (1 + tol) 之下
// 連續命中的天聚合成同一個 markArea 區段，最短 2 日才標
function detectDivergence(rows, obvSeries) {
  const WIN = 60;
  const TOL = 0.005;   // 0.5% 容忍度，避免極值剛好擦邊
  const MIN_RUN = 2;
  if (rows.length < WIN) return { bull: [], bear: [] };
  const closes = rows.map(r => r.close);
  const obv = obvSeries.map(p => p[1]);
  const hits = []; // {i, type}
  for (let i = WIN; i < rows.length; i++) {
    const cWin = closes.slice(i - WIN, i + 1);
    const oWin = obv.slice(i - WIN, i + 1);
    const cMin = Math.min(...cWin), cMax = Math.max(...cWin);
    const oMin = Math.min(...oWin), oMax = Math.max(...oWin);
    const c = closes[i], o = obv[i];
    // 價創新低但 OBV 沒創新低 → 底部背離
    if (c <= cMin * (1 + TOL) && o > oMin + Math.abs(oMin) * TOL) {
      hits.push({ i, type: "bull" });
    }
    // 價創新高但 OBV 沒創新高 → 頂部背離
    else if (c >= cMax * (1 - TOL) && o < oMax - Math.abs(oMax) * TOL) {
      hits.push({ i, type: "bear" });
    }
  }
  // 聚合連續同類型成區段
  const bull = [], bear = [];
  let cur = null;
  for (const h of hits) {
    if (cur && cur.type === h.type && h.i - cur.end <= 3) {
      cur.end = h.i;
    } else {
      if (cur && cur.end - cur.start + 1 >= MIN_RUN) {
        (cur.type === "bull" ? bull : bear).push([rows[cur.start].date, rows[cur.end].date]);
      }
      cur = { type: h.type, start: h.i, end: h.i };
    }
  }
  if (cur && cur.end - cur.start + 1 >= MIN_RUN) {
    (cur.type === "bull" ? bull : bear).push([rows[cur.start].date, rows[cur.end].date]);
  }
  return { bull, bear };
}

function buildMarkAreas(div) {
  const areas = [];
  for (const [s, e] of div.bull) {
    areas.push([
      { xAxis: s, itemStyle: { color: "rgba(34,197,94,0.12)" } },
      { xAxis: e },
    ]);
  }
  for (const [s, e] of div.bear) {
    areas.push([
      { xAxis: s, itemStyle: { color: "rgba(248,81,73,0.12)" } },
      { xAxis: e },
    ]);
  }
  return areas;
}

function fmtVol(v) {
  if (v == null || !isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (abs >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return v.toFixed(0);
}

export function render() {
  if (!vpChart || !twii || !qqq) return;
  const from = rangeStart(vpRange);
  const tw = twii.filter(r => r.date >= from);
  const qq = qqq.filter(r => r.date >= from);

  const twPrice = pricePoints(tw);
  const qqPrice = pricePoints(qq);
  const twObv = computeOBV(tw);
  const qqObv = computeOBV(qq);
  const twVol = volBars(tw);
  const qqVol = volBars(qq);
  const twVolMa = ma(tw, 20);
  const qqVolMa = ma(qq, 20);

  const axisClr = tc("#8b949e", "#57606a");
  const gridClr = tc("rgba(48,54,61,0.5)", "rgba(208,215,222,0.4)");
  const tipBg   = tc("#161b22", "#ffffff");
  const tipBdr  = tc("#30363d", "#d0d7de");
  const tipText = tc("#e6edf3", "#1f2328");
  const priceClr = tc("#e6edf3", "#1f2937");
  const obvClr = "#a78bfa";
  const maClr  = "#f59e0b";

  // ── grids: 0=TWII價, 1=TWII量, 2=QQQ價, 3=QQQ量
  const leftPad  = mob() ? 56 : 78;
  const rightPad = showOBV ? (mob() ? 56 : 76) : (mob() ? 16 : 32);

  const grid = [
    { left: leftPad, right: rightPad, top: 36,    height: "26%" },
    { left: leftPad, right: rightPad, top: "36%", height: "10%" },
    { left: leftPad, right: rightPad, top: "54%", height: "26%" },
    { left: leftPad, right: rightPad, top: "82%", height: "10%" },
  ];

  const xAxis = [0, 1, 2, 3].map(i => ({
    type: "time", gridIndex: i,
    axisLine: { lineStyle: { color: axisClr } },
    axisLabel: i === 1 || i === 3
      ? { color: axisClr, fontSize: 10 }
      : { show: false },
    splitLine: { show: false },
  }));

  // yAxes:
  //   0: TWII price (left, grid 0)
  //   1: TWII OBV   (right, grid 0)
  //   2: TWII vol   (left, grid 1)
  //   3: QQQ price  (left, grid 2)
  //   4: QQQ OBV    (right, grid 2)
  //   5: QQQ vol    (left, grid 3)
  const yAxis = [
    { gridIndex: 0, scale: true, name: "TWII", nameTextStyle: { color: priceClr, fontSize: 11 },
      axisLine: { lineStyle: { color: axisClr } },
      axisLabel: { color: axisClr, fontSize: 11, formatter: v => v.toFixed(0) },
      splitLine: { lineStyle: { color: gridClr } } },
    { gridIndex: 0, scale: true, position: "right",
      name: "OBV", nameTextStyle: { color: obvClr, fontSize: 10 },
      axisLine: { lineStyle: { color: obvClr } },
      axisLabel: { color: obvClr, fontSize: 10, formatter: v => fmtVol(v) },
      splitLine: { show: false }, show: showOBV },
    { gridIndex: 1, scale: true, name: "量", nameTextStyle: { color: axisClr, fontSize: 10 },
      axisLine: { lineStyle: { color: axisClr } },
      axisLabel: { color: axisClr, fontSize: 10, formatter: v => fmtVol(v) },
      splitLine: { show: false } },
    { gridIndex: 2, scale: true, name: "QQQ", nameTextStyle: { color: priceClr, fontSize: 11 },
      axisLine: { lineStyle: { color: axisClr } },
      axisLabel: { color: axisClr, fontSize: 11, formatter: v => v.toFixed(0) },
      splitLine: { lineStyle: { color: gridClr } } },
    { gridIndex: 2, scale: true, position: "right",
      name: "OBV", nameTextStyle: { color: obvClr, fontSize: 10 },
      axisLine: { lineStyle: { color: obvClr } },
      axisLabel: { color: obvClr, fontSize: 10, formatter: v => fmtVol(v) },
      splitLine: { show: false }, show: showOBV },
    { gridIndex: 3, scale: true, name: "量", nameTextStyle: { color: axisClr, fontSize: 10 },
      axisLine: { lineStyle: { color: axisClr } },
      axisLabel: { color: axisClr, fontSize: 10, formatter: v => fmtVol(v) },
      splitLine: { show: false } },
  ];

  const twDiv = showDivergence ? detectDivergence(tw, twObv) : { bull: [], bear: [] };
  const qqDiv = showDivergence ? detectDivergence(qq, qqObv) : { bull: [], bear: [] };
  const twAreas = buildMarkAreas(twDiv);
  const qqAreas = buildMarkAreas(qqDiv);

  const series = [
    { name: "TWII 收盤", type: "line", xAxisIndex: 0, yAxisIndex: 0,
      data: twPrice, symbol: "none",
      lineStyle: { width: 1.6, color: priceClr }, itemStyle: { color: priceClr },
      markArea: twAreas.length ? { silent: true, data: twAreas } : undefined },
    { name: "TWII 量", type: "bar", xAxisIndex: 1, yAxisIndex: 2,
      data: twVol, barMaxWidth: 6 },
    { name: "QQQ 收盤", type: "line", xAxisIndex: 2, yAxisIndex: 3,
      data: qqPrice, symbol: "none",
      lineStyle: { width: 1.6, color: priceClr }, itemStyle: { color: priceClr },
      markArea: qqAreas.length ? { silent: true, data: qqAreas } : undefined },
    { name: "QQQ 量", type: "bar", xAxisIndex: 3, yAxisIndex: 5,
      data: qqVol, barMaxWidth: 6 },
  ];

  if (showOBV) {
    series.push(
      { name: "TWII OBV", type: "line", xAxisIndex: 0, yAxisIndex: 1,
        data: twObv, symbol: "none",
        lineStyle: { width: 1.2, color: obvClr, type: "dashed" }, itemStyle: { color: obvClr } },
      { name: "QQQ OBV", type: "line", xAxisIndex: 2, yAxisIndex: 4,
        data: qqObv, symbol: "none",
        lineStyle: { width: 1.2, color: obvClr, type: "dashed" }, itemStyle: { color: obvClr } },
    );
  }
  if (showMA20Vol) {
    series.push(
      { name: "TWII 20日均量", type: "line", xAxisIndex: 1, yAxisIndex: 2,
        data: twVolMa, symbol: "none",
        lineStyle: { width: 1.2, color: maClr }, itemStyle: { color: maClr } },
      { name: "QQQ 20日均量", type: "line", xAxisIndex: 3, yAxisIndex: 5,
        data: qqVolMa, symbol: "none",
        lineStyle: { width: 1.2, color: maClr }, itemStyle: { color: maClr } },
    );
  }

  const legendData = ["TWII 收盤", "QQQ 收盤", "TWII 量", "QQQ 量"];
  if (showOBV)     legendData.push("TWII OBV", "QQQ OBV");
  if (showMA20Vol) legendData.push("TWII 20日均量", "QQQ 20日均量");

  vpChart.setOption({
    backgroundColor: "transparent",
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "cross", link: [{ xAxisIndex: "all" }] },
      backgroundColor: tipBg, borderColor: tipBdr,
      textStyle: { color: tipText, fontSize: 12 },
      formatter(params) {
        if (!params?.length) return "";
        const ts = params[0].axisValueLabel || params[0].axisValue;
        const dateLabel = typeof ts === "string"
          ? ts.slice(0, 10)
          : new Date(ts).toISOString().slice(0, 10);
        const seen = new Set();
        let html = `<b>${dateLabel}</b><br/>`;
        for (const p of params) {
          if (seen.has(p.seriesName)) continue;
          seen.add(p.seriesName);
          const v = p.value?.[1];
          if (v == null) continue;
          const isPrice = p.seriesName.includes("收盤");
          const txt = isPrice ? (+v).toFixed(2) : fmtVol(v);
          html += `<span style="color:${p.color}">●</span> ${p.seriesName}: <b>${txt}</b><br/>`;
        }
        return html;
      },
    },
    legend: { data: legendData, top: 4, textStyle: { color: tipText, fontSize: 11 } },
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    grid,
    xAxis,
    yAxis,
    dataZoom: [
      { type: "inside", xAxisIndex: [0, 1, 2, 3] },
      { type: "slider", xAxisIndex: [0, 1, 2, 3], height: 14, bottom: 2,
        fillerColor: "rgba(88,166,255,0.12)",
        borderColor: tc("#30363d", "#d0d7de") },
    ],
    series,
  }, { notMerge: true });

  // status
  const statusEl = document.getElementById("volprice-status");
  if (statusEl) {
    const lt = tw[tw.length - 1], lq = qq[qq.length - 1];
    const parts = [];
    if (lt) parts.push(`TWII ${lt.close.toFixed(0)} · 量 ${fmtVol(lt.volume)} (${lt.date})`);
    if (lq) parts.push(`QQQ ${lq.close.toFixed(2)} · 量 ${fmtVol(lq.volume)} (${lq.date})`);
    if (showDivergence) {
      const tb = twDiv.bull.length, tr = twDiv.bear.length;
      const qb = qqDiv.bull.length, qr = qqDiv.bear.length;
      parts.push(`背離 TWII 底/頂 ${tb}/${tr} · QQQ 底/頂 ${qb}/${qr}`);
    }
    parts.push(`範圍 ${vpRange}`);
    statusEl.textContent = parts.join(" · ");
  }
}

async function initOnce() {
  if (twii && qqq) return;
  await loadAll();
}

export async function activate() {
  const el = document.getElementById("volprice-chart");
  if (!vpChart && el) {
    vpChart = echarts.init(el, isLight() ? null : "dark");
  }
  try {
    await initOnce();
    setTimeout(() => { vpChart?.resize(); render(); }, 50);
  } catch (e) {
    const s = document.getElementById("volprice-status");
    if (s) s.textContent = "載入失敗：" + (e.message || e);
    console.error("[volprice] load failed", e);
  }
}

export function onThemeChange(light) {
  if (!vpChart) return;
  vpChart.dispose();
  vpChart = echarts.init(document.getElementById("volprice-chart"), light ? null : "dark");
  render();
}

export function resize() { vpChart?.resize(); }

// ── event wiring
document.getElementById("vp-obv-toggle")?.addEventListener("click", e => {
  showOBV = !showOBV;
  e.currentTarget.classList.toggle("active", showOBV);
  render();
});
document.getElementById("vp-ma20-toggle")?.addEventListener("click", e => {
  showMA20Vol = !showMA20Vol;
  e.currentTarget.classList.toggle("active", showMA20Vol);
  render();
});
document.getElementById("vp-divergence-toggle")?.addEventListener("click", e => {
  showDivergence = !showDivergence;
  e.currentTarget.classList.toggle("active", showDivergence);
  render();
});
document.getElementById("vp-range-picker")?.addEventListener("click", e => {
  const t = e.target.closest(".chip[data-vp-range]");
  if (!t) return;
  vpRange = t.dataset.vpRange;
  for (const c of e.currentTarget.querySelectorAll(".chip"))
    c.classList.toggle("active", c === t);
  render();
});
