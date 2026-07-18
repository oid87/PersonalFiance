import { isLight, tc, mob, PALETTE } from '../utils/theme.js';

let breadthChart     = null;
let breadthData      = null;
let breadthSpy       = {};   // { date: close }
let breadthVixMap    = {};   // { date: value }
let breadthFgMap     = {};   // { date: value }
let breadthVixActive = false;
let breadthFgActive  = false;
let breadthRange     = "2Y";
let breadthMaWin     = 50;   // 50 | 200 — 一次只看一條廣度線 + 指數同窗均線
let breadthMaMap     = {};   // { 50: {date: ma}, 200: {...} } — 以完整 overlay 歷史計算
let hbTriggers       = [];   // ["YYYY-MM-DD", ...] Hindenburg-style trigger dates

const UNIVERSE_CONFIG = {
  SP500: { dataFile: "data/breadth.json",     overlayFile: "data/SPY.json", overlayName: "SPY", label: "S&P 500" },
  NDX:   { dataFile: "data/breadth_ndx.json", overlayFile: "data/QQQ.json", overlayName: "QQQ", label: "Nasdaq-100" },
  XLG:   { dataFile: "data/breadth_xlg.json", overlayFile: "data/XLG.json", overlayName: "XLG", label: "S&P 500 Top 50" },
  TW50:  { dataFile: "data/breadth_tw50.json", overlayFile: "data/0050.TW.json", overlayName: "0050", label: "台灣50" },
};
let breadthUniverse = "SP500";
let breadthCache    = {};

function breadthSignal(pct, is200) {
  if (pct == null) return { label: "—", color: "var(--muted)" };
  if (is200) {
    if (pct >= 70) return { label: "長期多頭確認", color: "#3fb950" };
    if (pct >= 55) return { label: "偏多格局",     color: "#7ee787" };
    if (pct >= 35) return { label: "整理格局",     color: "#f0883e" };
    if (pct >= 20) return { label: "偏空格局",     color: "#f0883e" };
    return                { label: "長期空頭警戒", color: "#f85149" };
  }
  if (pct >= 75) return { label: "強勢多頭", color: "#3fb950" };
  if (pct >= 55) return { label: "多方主導", color: "#7ee787" };
  if (pct >= 35) return { label: "多空拉鋸", color: "#e3b341" };
  if (pct >= 20) return { label: "空方壓力", color: "#f0883e" };
  return               { label: "弱勢超賣", color: "#f85149" };
}

function breadthBearSignal(pct) {
  if (pct == null) return { label: "—", color: "var(--muted)" };
  if (pct < 15) return { label: "健康",         color: "#3fb950" };
  if (pct < 30) return { label: "局部修正",     color: "#e3b341" };
  if (pct < 50) return { label: "廣泛修正",     color: "#f0883e" };
  return              { label: "系統性熊市徵兆", color: "#f85149" };
}

// Simplified Hindenburg-style trigger on S&P 500 constituents.
// 真正版本用全 NYSE listed ~3000 檔 + McClellan Oscillator;這裡用 SPY 成分股當代理,所以叫 "Hindenburg-style"。
// 條件:① 新高 > 2.2% × total ② 新低 > 2.2% × total ③ 不能一邊壓倒另一邊(max ≤ 2× min) ④ SPY 高於 50 交易日前(趨勢濾網)
const HB_THRESHOLD       = 0.022;  // 2.2% of S&P500 ≈ 11 檔
const HB_TREND_LOOKBACK  = 50;     // 交易日
const HB_CLUSTER_WINDOW  = 30;     // 交易日內看叢集

function isHindenburgDay(row, rowPrev50, spyMap) {
  if (row.new_hi_count == null || row.new_lo_count == null) return false;
  const total = row.hl_total || row.total;
  if (!total) return false;
  const hi = row.new_hi_count, lo = row.new_lo_count;
  if (hi / total <= HB_THRESHOLD)        return false;
  if (lo / total <= HB_THRESHOLD)        return false;
  if (Math.max(hi, lo) > 2 * Math.min(hi, lo)) return false;
  if (!rowPrev50) return false;
  const spyNow  = spyMap[row.date];
  const spyPrev = spyMap[rowPrev50.date];
  if (spyNow == null || spyPrev == null) return false;
  if (spyNow <= spyPrev) return false;
  return true;
}

function computeHindenburgTriggers(rows, spyMap) {
  const out = [];
  for (let i = HB_TREND_LOOKBACK; i < rows.length; i++) {
    if (isHindenburgDay(rows[i], rows[i - HB_TREND_LOOKBACK], spyMap))
      out.push(rows[i].date);
  }
  return out;
}

function hindenburgStatus(triggers, latestDate, rows) {
  if (!triggers.length) return { label: "正常",      color: "var(--muted)", count: 0 };
  // Count triggers in trailing HB_CLUSTER_WINDOW trading days from latestDate
  const latestIdx  = rows.findIndex(r => r.date === latestDate);
  const cutoffIdx  = Math.max(0, latestIdx - HB_CLUSTER_WINDOW);
  const cutoffDate = rows[cutoffIdx].date;
  const recent     = triggers.filter(d => d >= cutoffDate);
  if (recent.length >= 2) return { label: `叢集 ${recent.length} 次`, color: "#f85149", count: recent.length };
  if (recent.length === 1) return { label: "單次觸發", color: "#f0883e", count: 1 };
  return { label: "30日內無觸發", color: "var(--muted)", count: 0 };
}

async function loadUniverse(universe) {
  if (!breadthCache[universe]) {
    const cfg = UNIVERSE_CONFIG[universe];
    const [bResp, overlayResp] = await Promise.all([
      fetch(cfg.dataFile,    { cache: "no-cache" }),
      fetch(cfg.overlayFile, { cache: "no-cache" }),
    ]);
    if (!bResp.ok) throw new Error(`HTTP ${bResp.status}`);
    const data = await bResp.json();
    const overlayJson = await overlayResp.json();
    const overlay = {};
    for (const r of overlayJson.data) overlay[r.date] = r.close;
    // 指數自身均線:用完整 overlay 歷史算,才不會在短窗(1Y/2Y)開頭缺一段
    const sorted = [...overlayJson.data].sort((a, b) => a.date < b.date ? -1 : 1);
    const maMaps = {};
    for (const win of [50, 200]) {
      const m = {};
      let sum = 0;
      for (let i = 0; i < sorted.length; i++) {
        sum += sorted[i].close;
        if (i >= win) sum -= sorted[i - win].close;
        if (i >= win - 1) m[sorted[i].date] = sum / win;
      }
      maMaps[win] = m;
    }
    breadthCache[universe] = { data, overlay, maMaps };
  }
  breadthUniverse = universe;
  breadthData = breadthCache[universe].data;
  breadthSpy  = breadthCache[universe].overlay;
  breadthMaMap = breadthCache[universe].maMaps;
}

function setBearCard(pct, count, total) {
  document.getElementById("bc-bear-pct").textContent =
    pct != null ? pct.toFixed(1) : "—";
  document.getElementById("bc-bear-count").textContent =
    count != null ? `${count} / ${total}` : "— / —";
  const sig = breadthBearSignal(pct);
  const el  = document.getElementById("bc-bear-signal");
  el.textContent = sig.label;
  el.style.color = sig.color;
}

function refreshBreadthView() {
  const status = document.getElementById("breadth-status");
  const rows   = breadthData.data;
  const latest = rows[rows.length - 1];

  function setCard(suffix, pct, count, total, is200) {
    document.getElementById(`bc-${suffix}-pct`).textContent =
      pct != null ? pct.toFixed(1) : "—";
    document.getElementById(`bc-${suffix}-count`).textContent =
      count != null ? `${count} / ${total}` : "— / —";
    const sig = breadthSignal(pct, is200);
    const el  = document.getElementById(`bc-${suffix}-signal`);
    el.textContent  = sig.label;
    el.style.color  = sig.color;
  }
  setCard("50",  latest.above50_pct,  latest.above50_count,  latest.total, false);
  setCard("200", latest.above200_pct, latest.above200_count, latest.total, true);
  setBearCard(latest.bear_pct, latest.bear_count, latest.bear_total);

  // Compute Hindenburg-style triggers (needs SPY for trend filter)
  hbTriggers = computeHindenburgTriggers(rows, breadthSpy);
  const hlEl   = document.getElementById("bc-hl-count");
  const hlPctEl= document.getElementById("bc-hl-pct");
  const hlSigEl= document.getElementById("bc-hl-signal");
  if (hlEl && latest.new_hi_count != null && latest.new_lo_count != null) {
    const tot = latest.hl_total || latest.total;
    hlEl.textContent    = `${latest.new_hi_count} / ${latest.new_lo_count}`;
    hlPctEl.textContent = `${(latest.new_hi_count/tot*100).toFixed(1)}% / ${(latest.new_lo_count/tot*100).toFixed(1)}% · n=${tot}`;
    const st = hindenburgStatus(hbTriggers, latest.date, rows);
    hlSigEl.textContent = st.label;
    hlSigEl.style.color = st.color;
  } else if (hlEl) {
    hlEl.textContent    = "— / —";
    hlPctEl.textContent = "（資料更新中，CI 跑完後生效）";
    hlSigEl.textContent = "—";
  }

  if (!breadthChart) {
    breadthChart = echarts.init(
      document.getElementById("breadth-chart"), isLight() ? null : "dark");
  }
  renderBreadthChart();
  status.textContent =
    `${UNIVERSE_CONFIG[breadthUniverse].label} 市場廣度 · ${rows.length} 個交易日 · 更新至 ${breadthData.updated}`;
}

export async function init() {
  const status = document.getElementById("breadth-status");
  if (breadthData) { renderBreadthChart(); return; }
  status.textContent = "載入中…";
  try {
    await loadUniverse("SP500");

    document.querySelectorAll("[data-breadth-range]").forEach(el => {
      el.addEventListener("click", () => {
        breadthRange = el.dataset.breadthRange;
        document.querySelectorAll("[data-breadth-range]").forEach(e =>
          e.classList.toggle("active", e.dataset.breadthRange === breadthRange));
        renderBreadthChart();
      });
    });

    document.querySelectorAll("[data-breadth-ma]").forEach(el => {
      el.addEventListener("click", () => {
        breadthMaWin = +el.dataset.breadthMa;
        document.querySelectorAll("[data-breadth-ma]").forEach(e =>
          e.classList.toggle("active", +e.dataset.breadthMa === breadthMaWin));
        renderBreadthChart();
      });
    });

    document.querySelectorAll("[data-breadth-universe]").forEach(el => {
      el.addEventListener("click", async () => {
        const u = el.dataset.breadthUniverse;
        if (u === breadthUniverse) return;
        document.querySelectorAll("[data-breadth-universe]").forEach(e =>
          e.classList.toggle("active", e.dataset.breadthUniverse === u));
        status.textContent = "載入中…";
        try {
          await loadUniverse(u);
          refreshBreadthView();
        } catch (err) {
          status.textContent = `載入失敗：${err.message}`;
        }
      });
    });

    async function loadAndToggle(key, mapRef, file, btnId) {
      const active = key === "VIX" ? breadthVixActive : breadthFgActive;
      document.getElementById(btnId).classList.toggle("active", active);
      if (active && Object.keys(mapRef).length === 0) {
        try {
          const r = await fetch(file, { cache: "no-cache" });
          const j = await r.json();
          for (const row of (j.data || []))
            mapRef[row.date] = row.close !== undefined ? row.close : row.value;
        } catch (e) { console.warn("breadth overlay load failed:", e); }
      }
      renderBreadthChart();
    }

    document.getElementById("breadth-vix-toggle").addEventListener("click", () => {
      breadthVixActive = !breadthVixActive;
      loadAndToggle("VIX", breadthVixMap, "data/VIX.json", "breadth-vix-toggle");
    });
    document.getElementById("breadth-fg-toggle").addEventListener("click", () => {
      breadthFgActive = !breadthFgActive;
      loadAndToggle("F&G", breadthFgMap, "data/fear_greed.json", "breadth-fg-toggle");
    });

    refreshBreadthView();
  } catch (err) {
    status.textContent = `載入失敗：${err.message}`;
  }
}

export function renderBreadthChart() {
  if (!breadthData || !breadthChart) return;
  const axisClr = PALETTE.muted;
  const gridClr = PALETTE.grid;
  const tipBg   = PALETTE.bg;
  const tipBdr  = PALETTE.border;
  const tipText = PALETTE.text;

  let rows = breadthData.data;
  if (breadthRange !== "MAX") {
    const years   = parseInt(breadthRange) || 2;
    const cutoff  = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - years);
    // check_reuse: keep — 本地 range cutoff 變體:preset key 集合/MAX 哨兵/未命中預設與 dates.presetStart、dates.cutoffDate 皆不同,換過去會改行為
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    rows = rows.filter(r => r.date >= cutoffStr);
  }

  const dates    = rows.map(r => r.date);
  const above50  = rows.map(r => r.above50_pct  != null ? r.above50_pct  : null);
  const above200 = rows.map(r => r.above200_pct != null ? r.above200_pct : null);
  const spyVals  = rows.map(r => breadthSpy[r.date]   != null ? +breadthSpy[r.date].toFixed(2)   : null);
  const breadthVals = breadthMaWin === 50 ? above50 : above200;
  const maSrc    = breadthMaMap[breadthMaWin] || {};
  const maVals   = rows.map(r => maSrc[r.date] != null ? +maSrc[r.date].toFixed(2) : null);
  const vixVals  = rows.map(r => breadthVixMap[r.date] != null ? +breadthVixMap[r.date].toFixed(2) : null);
  const fgVals   = rows.map(r => breadthFgMap[r.date]  != null ? +breadthFgMap[r.date].toFixed(1)  : null);

  // Hindenburg trigger markers: scatter on SPY line, filtered to visible range
  const dateSet = new Set(dates);
  const hbPoints = hbTriggers
    .filter(d => dateSet.has(d) && breadthSpy[d] != null)
    .map(d => [d, +breadthSpy[d].toFixed(2)]);

  // ── build dynamic yAxis list ──────────────────────────────────
  const yAxes = [
    { // [0] left: breadth %
      type: "value", min: 0, max: 100,
      splitLine: { lineStyle: { color: gridClr } },
      axisLine: { show: false },
      axisLabel: { color: axisClr, fontSize: 11, formatter: v => v + "%" },
    },
    { // [1] right: SPY price
      type: "value", position: "right", offset: 0,
      splitLine: { show: false }, axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: "#a371f7", fontSize: 10, formatter: v => "$" + v },
    },
  ];
  let overlayIdx = -1;
  if (breadthVixActive || breadthFgActive) {
    overlayIdx = yAxes.length;
    yAxes.push({
      type: "value", position: "right", offset: mob() ? 44 : 58,
      scale: true,
      splitLine: { show: false }, axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { show: false },
    });
  }

  breadthChart.setOption({
    backgroundColor: "transparent",
    tooltip: {
      trigger: "axis",
      backgroundColor: tipBg, borderColor: tipBdr,
      textStyle: { color: tipText, fontSize: 12 },
      formatter(params) {
        const d   = params[0].axisValue;
        const row = rows[params[0].dataIndex];
        let html  = `<div style="margin-bottom:4px;font-size:11px;color:${axisClr}">${d}</div>`;
        for (const p of params) {
          if (p.value == null) continue;
          let val;
          if (p.seriesName.startsWith(UNIVERSE_CONFIG[breadthUniverse].overlayName)) val = `$${p.value.toFixed(2)}`;
          else if (p.seriesName === "VIX")   val = p.value.toFixed(1);
          else if (p.seriesName === "F&G")   val = p.value.toFixed(0);
          else                               val = `${p.value.toFixed(1)}%`;
          html += `<div>${p.marker}${p.seriesName}: <b>${val}</b></div>`;
        }
        if (row) {
          html +=
            `<div style="margin-top:4px;font-size:11px;color:${axisClr}">` +
            `50MA: ${row.above50_count}/${row.total} · 200MA: ${row.above200_count ?? "—"}/${row.total}</div>`;
          if (row.new_hi_count != null) {
            const isHb = hbTriggers.includes(row.date);
            html +=
              `<div style="font-size:11px;color:${axisClr}">` +
              `新高/新低: ${row.new_hi_count}/${row.new_lo_count}${isHb ? ` <span style="color:#f85149">⚠ 興登堡觸發</span>` : ""}</div>`;
          }
        }
        return html;
      },
    },
    grid: { top: 28, bottom: 36, left: mob() ? 48 : 56,
            right: mob() ? 56 : (overlayIdx >= 0 ? 112 : 68) },
    xAxis: {
      type: "category", data: dates, boundaryGap: false,
      axisLine: { lineStyle: { color: axisClr } },
      axisTick: { show: false },
      axisLabel: { color: axisClr, fontSize: 11 },
    },
    yAxis: yAxes,
    series: [
      {
        name: UNIVERSE_CONFIG[breadthUniverse].overlayName,
        type: "line", data: spyVals, smooth: 0.3, symbol: "none",
        yAxisIndex: 1, z: 1,
        lineStyle: { width: 1.2, color: "#a371f7", opacity: 0.6 },
      },
      {
        name: `${UNIVERSE_CONFIG[breadthUniverse].overlayName} ${breadthMaWin}MA`,
        type: "line", data: maVals, smooth: 0.3, symbol: "none",
        yAxisIndex: 1, z: 2,
        lineStyle: { width: 2, color: "#d2a8ff", type: "dashed" },
      },
      {
        name: `${breadthMaWin}日均線以上`,
        type: "line", data: breadthVals, smooth: 0.3, symbol: "none",
        yAxisIndex: 0, z: 3,
        lineStyle: { width: 2, color: breadthMaWin === 50 ? "#58a6ff" : "#3fb950" },
        areaStyle: { color: breadthMaWin === 50 ? "rgba(88,166,255,0.08)" : "rgba(63,185,80,0.06)" },
        markLine: {
          silent: true, symbol: "none",
          data: [
            // 15/25 = 深底/淺底(2022 深修正 vs 2025/4 後淺修正即反彈)；75/85 對稱鏡射，標示廣度過熱區間
            { yAxis: 15, lineStyle: { type: "dashed", color: "rgba(248,81,73,0.5)",  width: 1 },
              label: { formatter: "15% 深底", color: "#f85149", fontSize: 10, position: "insideEndTop" } },
            { yAxis: 25, lineStyle: { type: "dashed", color: "rgba(240,136,62,0.5)", width: 1 },
              label: { formatter: "25% 淺底", color: "#f0883e", fontSize: 10, position: "insideEndTop" } },
            { yAxis: 50, lineStyle: { type: "dashed", color: "rgba(139,148,158,0.4)", width: 1 },
              label: { formatter: "50%", color: axisClr,   fontSize: 10, position: "insideEndTop" } },
            { yAxis: 75, lineStyle: { type: "dashed", color: "rgba(240,136,62,0.5)", width: 1 },
              label: { formatter: "75% 過熱", color: "#f0883e", fontSize: 10, position: "insideEndTop" } },
            { yAxis: 85, lineStyle: { type: "dashed", color: "rgba(63,185,80,0.5)",  width: 1 },
              label: { formatter: "85% 極熱", color: "#3fb950",  fontSize: 10, position: "insideEndTop" } },
          ],
        },
        markArea: {
          silent: true,
          data: [
            [{ yAxis: 0,  itemStyle: { color: "rgba(248,81,73,0.06)" } }, { yAxis: 15  }],
            [{ yAxis: 15, itemStyle: { color: "rgba(240,136,62,0.04)" } }, { yAxis: 25  }],
            [{ yAxis: 75, itemStyle: { color: "rgba(240,136,62,0.04)" } }, { yAxis: 85  }],
            [{ yAxis: 85, itemStyle: { color: "rgba(63,185,80,0.06)"  } }, { yAxis: 100 }],
          ],
        },
      },
      ...(breadthVixActive ? [{
        name: "VIX",
        type: "line", data: vixVals, smooth: 0.3, symbol: "none",
        yAxisIndex: overlayIdx, z: 2,
        lineStyle: { width: 1.5, color: "#f0883e", type: "dashed" },
        areaStyle: { color: "rgba(240,136,62,0.06)" },
      }] : []),
      ...(breadthFgActive ? [{
        name: "F&G",
        type: "line", data: fgVals, smooth: 0.3, symbol: "none",
        yAxisIndex: overlayIdx, z: 2,
        lineStyle: { width: 1.5, color: "#e3b341", type: "dashed" },
        areaStyle: { color: "rgba(227,179,65,0.05)" },
      }] : []),
      ...(hbPoints.length ? [{
        name: "興登堡觸發",
        type: "scatter", data: hbPoints,
        yAxisIndex: 1, z: 6,
        symbol: "pin", symbolSize: 18,
        itemStyle: { color: "#f85149", borderColor: "#fff", borderWidth: 1 },
        tooltip: { show: true },
      }] : []),
    ],
  }, { notMerge: true });
}

export function onThemeChange(light) {
  if (!breadthChart) return;
  breadthChart.dispose();
  breadthChart = echarts.init(document.getElementById("breadth-chart"), light ? null : "dark");
  renderBreadthChart();
}

export function resize() {
  breadthChart?.resize();
}
