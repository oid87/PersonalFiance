import {
  SERIES, CUSTOM_COLORS, customSeries, active, maActive,
  loaded, loadedHLC, loadedVol, state,
} from '../state.js';
import { tc, mob } from '../utils/theme.js';
import {
  tsToLocalDate, currentWindow, filterRange,
  dateAddDays, closestOnOrAfter, minBetween, lookupLE,
  toWeekly, toWeeklyHLC,
} from '../utils/dates.js';
import {
  computeMA, computeRSI, computeKD, computeTDSetup, computeDDZones, computeBounceSignals,
} from '../utils/math.js';
import { loadSeries, ensureLoaded } from '../utils/data.js';

const chartEl = document.getElementById("chart");
let chart = echarts.init(chartEl, null); // light by default

let fearActive    = false;
let fearThreshold = 20;

let ddZoneActive    = false;
let sigZoneActive   = false;
let trendFpeActive  = false;
let trendFpeData    = null;

function _interpFpe(arr) {
  if (!arr || arr.length < 2) return arr.map(r => [r.date, r.fpe]);
  const out = [];
  for (let i = 0; i < arr.length - 1; i++) {
    const t1 = new Date(arr[i].date + "T00:00:00Z").getTime(), v1 = arr[i].fpe;
    const t2 = new Date(arr[i+1].date + "T00:00:00Z").getTime(), v2 = arr[i+1].fpe;
    const gap = Math.round((t2 - t1) / 86400000);
    for (let j = 0; j < gap; j++) {
      out.push([new Date(t1 + j * 86400000).toISOString().slice(0,10), +(v1 + (v2-v1)*(j/gap)).toFixed(3)]);
    }
  }
  out.push([arr[arr.length-1].date, arr[arr.length-1].fpe]);
  return out;
}

const dateFrom = document.getElementById("date-from");
const dateTo   = document.getElementById("date-to");

chart.on("updateAxisPointer", evt => {
  try {
    const ts = evt?.axesInfo?.[0]?.value;
    if (typeof ts !== "number") return;
    renderSignalPanel(tsToLocalDate(ts));
  } catch (_) {}
});
chart.on("globalout", () => { if (state.sigMaps) renderSignalPanel(); });

// ── Fear helpers ───────────────────────────────────────────────
function fearZones(threshold) {
  const fg = loaded["F&G"];
  if (!fg) return [];
  const out = [];
  let s = null, last = null;
  for (const [d, v] of fg) {
    if (v <= threshold) { if (!s) s = d; last = d; }
    else if (s)         { out.push([s, last]); s = null; }
  }
  if (s) out.push([s, last]);
  return out;
}

function fearEpisodes(threshold) {
  const fg = loaded["F&G"];
  if (!fg) return [];
  const out = [];
  let s = null, fgMin = 100, last = null;
  for (const [d, v] of fg) {
    if (v <= threshold) {
      if (!s) { s = d; fgMin = 100; }
      if (v < fgMin) fgMin = v;
      last = d;
    } else if (s) {
      out.push({ start: s, end: last, fgMin,
        days: Math.round((new Date(last) - new Date(s)) / 86400000) + 1 });
      s = null;
    }
  }
  if (s) out.push({ start: s, end: last, fgMin,
    days: Math.round((new Date(last) - new Date(s)) / 86400000) + 1 });
  return out;
}

function updateChartHeight() {
  const h = (fearActive && loaded["F&G"]) ? 212 : 0;
  document.documentElement.style.setProperty("--fear-h", h + "px");
  setTimeout(() => chart.resize(), 220);
}

function renderFearPanel() {
  const panel = document.getElementById("fear-panel");
  if (!fearActive || !loaded["F&G"]) {
    panel.style.display = "none";
    updateChartHeight();
    return;
  }
  panel.style.display = "block";
  document.getElementById("fear-thresh-label").textContent = fearThreshold;
  updateChartHeight();

  const pk = loaded["SPY"] ? "SPY" : (loaded["VOO"] ? "VOO" : null);
  const eps = fearEpisodes(fearThreshold).reverse();

  document.getElementById("fear-ep-count").textContent = `${eps.length} 個事件`;
  document.getElementById("fear-price-note").textContent =
    pk ? `以 ${pk} 計算` : "（請啟用 SPY 或 VOO 顯示價格）";

  document.getElementById("fp-head").innerHTML = `<tr>
    <th>#</th><th>期間</th><th>天數</th><th>F&G低</th>
    ${pk ? `<th>${pk}最低</th><th>最低日</th><th>3M後</th><th>6M後</th><th>漲幅3M</th><th>漲幅6M</th>` : ""}
  </tr>`;

  if (!pk) {
    document.getElementById("fp-body").innerHTML =
      `<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:10px">啟用 SPY 或 VOO 以顯示價格欄位</td></tr>`;
    return;
  }

  const f  = v => v != null ? "$" + v.toFixed(2) : "—";
  const fp = (base, v) => {
    if (base == null || v == null) return `<td style="color:var(--muted)">—</td>`;
    const pct = (v / base - 1) * 100;
    return `<td class="${pct >= 0 ? "pos" : "neg"}">${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%</td>`;
  };

  document.getElementById("fp-body").innerHTML = eps.map((ep, i) => {
    const minP = minBetween(pk, ep.start, ep.end);
    const p3m  = closestOnOrAfter(pk, dateAddDays(ep.end, 90));
    const p6m  = closestOnOrAfter(pk, dateAddDays(ep.end, 180));
    return `<tr>
      <td style="color:var(--muted)">${eps.length - i}</td>
      <td>${ep.start} ~ ${ep.end}</td>
      <td style="color:var(--muted)">${ep.days}天</td>
      <td class="fear-val">${ep.fgMin}</td>
      <td><b>${f(minP?.price)}</b></td>
      <td style="color:var(--muted);font-size:11px">${minP?.date ?? "—"}</td>
      <td>${f(p3m)}</td>
      <td>${f(p6m)}</td>
      ${fp(minP?.price, p3m)}
      ${fp(minP?.price, p6m)}
    </tr>`;
  }).join("");
}

// ── Signal panel data builder ──────────────────────────────────
function buildSigMaps() {
  const qqq = loaded["QQQ"];
  if (!qqq?.length) return;
  const weekly = toWeekly(qqq);
  const wHLC   = loadedHLC["QQQ"] ? toWeeklyHLC(loadedHLC["QQQ"]) : null;

  const kdArr  = wHLC ? computeKD(wHLC, 9) : [];
  const rsiArr = computeRSI(weekly, 14);
  const tdArr  = computeTDSetup(weekly);
  const rsiMap = new Map(rsiArr.map(r => [r[0], r[1]]));
  const tdMap  = new Map(tdArr.map(r => [r.date, r]));
  const weeklySignals = kdArr.map(r => {
    const td = tdMap.get(r[0]);
    return [r[0], r[1], r[2], rsiMap.get(r[0]) ?? null, td?.count ?? 0, td?.dir ?? null];
  });

  const ma200 = computeMA(qqq, 200);

  const makeDDArr = (n) => {
    const arr = [];
    for (let i = 0; i < qqq.length; i++) {
      if (i < n) { arr.push([qqq[i][0], null]); continue; }
      let peak = 0;
      for (let j = i - n; j < i; j++) if (qqq[j][1] > peak) peak = qqq[j][1];
      arr.push([qqq[i][0], (qqq[i][1] - peak) / peak * 100]);
    }
    return arr;
  };
  const ddArr   = makeDDArr(60);

  const fg  = loaded["F&G"]    || [];
  const vix = loaded["VIX"]    || [];
  const vol = loadedVol["QQQ"] || [];

  const scoreArr = [];
  for (const [date, close] of qqq) {
    const ws     = lookupLE(weeklySignals, date);
    const fgV    = lookupLE(fg,     date)?.[1] ?? null;
    const vixV   = lookupLE(vix,    date)?.[1] ?? null;
    const ma200V = lookupLE(ma200,  date)?.[1] ?? null;
    const volV   = lookupLE(vol,    date)?.[1] ?? null;
    const ddV    = lookupLE(ddArr,  date)?.[1] ?? null;
    const dev    = (ma200V && close) ? (close - ma200V) / ma200V * 100 : null;
    const score = [
      ws?.[1] != null && ws[1] < 30,
      ws?.[3] != null && ws[3] < 30,
      fgV   != null && fgV  < 25,
      vixV  != null && vixV > 20,
      dev   != null && dev  < 0,
      ws?.[5] === 'down' && (ws[4] ?? 0) >= 7,
      ddV   != null && ddV  <= -10,
      volV  != null && volV >= 80_000_000,
    ].filter(Boolean).length;
    scoreArr.push([date, score]);
  }

  const dailyRetArr = qqq.slice(1).map((r, i) => [r[0], (r[1] - qqq[i][1]) / qqq[i][1]]);
  const { bounceSignals: bSigs } = computeBounceSignals(qqq, fg, ma200);
  const bounceSignalSet = new Set(bSigs.map(r => r[0]));
  state.sigMaps = { qqq, weeklySignals, ma200, ddArr, fg, vix, vol, scoreArr, dailyRetArr, bounceSignalSet };
}

export function renderSignalPanel(date) {
  if (!state.sigMaps) buildSigMaps();
  if (!state.sigMaps) return;

  const isLive = !date;
  const d = date || state.sigMaps.qqq.at(-1)?.[0];
  if (!d) return;

  const ws     = lookupLE(state.sigMaps.weeklySignals, d);
  const fgRow  = lookupLE(state.sigMaps.fg,   d);
  const vixRow = lookupLE(state.sigMaps.vix,  d);
  const ma200R = lookupLE(state.sigMaps.ma200, d);
  const volRow  = lookupLE(state.sigMaps.vol,   d);
  const ddRow   = lookupLE(state.sigMaps.ddArr, d);
  const qRow    = lookupLE(state.sigMaps.qqq,   d);

  const kdK     = ws?.[1]  ?? null;
  const rsiVal  = ws?.[3]  ?? null;
  const tdCount = ws?.[4]  ?? 0;
  const tdDir   = ws?.[5]  ?? null;
  const fgVal   = fgRow?.[1]   ?? null;
  const vixVal  = vixRow?.[1]  ?? null;
  const ma200V  = ma200R?.[1]  ?? null;
  const qClose  = qRow?.[1]    ?? null;
  const ma200Dev = (ma200V && qClose) ? (qClose - ma200V) / ma200V * 100 : null;
  const volVal  = volRow?.[1] ?? null;
  const ddVal   = ddRow?.[1]  ?? null;
  const dailyRetRow = lookupLE(state.sigMaps.dailyRetArr, d);
  const dailyRetV   = dailyRetRow?.[0] === d ? dailyRetRow[1] : null;

  const kdHit  = kdK      != null && kdK      < 30;
  const rsiHit = rsiVal   != null && rsiVal   < 30;
  const fgHit  = fgVal    != null && fgVal    < 25;
  const vixHit = vixVal   != null && vixVal   > 20;
  const maHit  = ma200Dev != null && ma200Dev < 0;
  const tdHit  = tdDir === 'down' && tdCount >= 7;
  const ddHit  = ddVal    != null && ddVal    <= -10;
  const volHit    = volVal   != null && volVal   >= 80_000_000;
  const bounceHit = state.sigMaps.bounceSignalSet?.has(d) ?? false;

  const set = (id, label, txt, hit) => {
    const el = document.getElementById(id); if (!el) return;
    el.textContent = txt != null ? `${label} ${txt}` : `${label} —`;
    el.classList.toggle("hit", !!hit);
  };
  set("sig-kd",   "週K",   kdK      != null ? kdK.toFixed(1)    : null, kdHit);
  set("sig-rsi",  "週RSI", rsiVal   != null ? rsiVal.toFixed(1)  : null, rsiHit);
  set("sig-fg",   "F&G",   fgVal    != null ? fgVal.toFixed(0)   : null, fgHit);
  set("sig-vix",  "VIX",   vixVal   != null ? vixVal.toFixed(1)  : null, vixHit);
  set("sig-ma",   "MA200", ma200Dev != null ? `${ma200Dev >= 0 ? "↑" : "↓"}${Math.abs(ma200Dev).toFixed(1)}%` : null, maHit);
  set("sig-td",   "九轉",  tdDir === 'down' && tdCount > 0 ? `${tdCount}計` : "0計", tdHit);
  set("sig-dd",   "12W",   ddVal    != null ? `${ddVal.toFixed(1)}%`    : null, ddHit);
  set("sig-vol",  "量",    volVal   != null ? `${(volVal / 1e6).toFixed(0)}M` : null, volHit);
  set("sig-bounce", "恐慌反彈", bounceHit ? `F&G:${fgVal.toFixed(0)} +${(dailyRetV * 100).toFixed(1)}%` : null, bounceHit);
  const hits = [kdHit, rsiHit, fgHit, vixHit, maHit, tdHit, ddHit, volHit].filter(Boolean).length;
  const countEl = document.getElementById("sig-count");
  if (countEl) {
    countEl.textContent = `${hits}/8`;
    countEl.style.color = hits >= 5 ? "#f85149" : hits >= 3 ? "#e3b341" : "var(--muted)";
  }
  const labelEl = document.querySelector("#signal-panel > span:first-child");
  if (labelEl) labelEl.textContent = isLive ? "QQQ 極端低點" : `QQQ @ ${d}`;
}

// ── Chart render ───────────────────────────────────────────────
export function render() {
  const series = [];
  const axisClr  = tc("#8b949e", "#57606a");
  const gridClr  = tc("#21262d", "#e1e4e8");
  const tipBg    = tc("#161b22", "#ffffff");
  const tipBdr   = tc("#30363d", "#d0d7de");
  const tipText  = tc("#e6edf3", "#1f2328");

  const isMob = mob();
  const yAxisDef = [
    { id: "price", name: "USD Price", position: "left",
      axisLine: { lineStyle: { color: axisClr } },
      splitLine: { lineStyle: { color: gridClr } } },
    { id: "vix",  name: "VIX",  position: "right",
      axisLine: { lineStyle: { color: "#f0883e" } }, splitLine: { show: false } },
    { id: "fg",   name: "F&G",  position: "right", offset: isMob ? 35 : 55, min: 0, max: 100,
      axisLine: { lineStyle: { color: "#e3b341" } }, splitLine: { show: false } },
    { id: "tw",   name: "TWD",  position: "left",  offset: isMob ? 45 : 70,
      axisLine: { lineStyle: { color: "#3fb950" } }, splitLine: { show: false } },
    { id: "btc",  name: "BTC",  position: "right", offset: isMob ? 65 : 110,
      axisLine: { lineStyle: { color: "#f7931a" } }, splitLine: { show: false } },
  ];

  const fpeYIdx = trendFpeActive && trendFpeData ? yAxisDef.length : -1;
  if (fpeYIdx >= 0) {
    yAxisDef.push({ id:"fpe", name:"FPE", position:"right", offset: isMob ? 95 : 150,
      min: v => Math.floor(v.min - 1), max: v => Math.ceil(v.max + 1),
      axisLabel: { formatter: v => `${v}x`, color:"#58a6ff", fontSize:11 },
      axisLine: { lineStyle:{ color:"#58a6ff" } }, splitLine:{ show:false } });
  }

  for (const s of [...SERIES, ...customSeries]) {
    if (!active.has(s.key) || !loaded[s.key]) continue;
    series.push({
      name: s.key,
      type: "line",
      data: filterRange(loaded[s.key]),
      yAxisIndex: s.yAxis,
      showSymbol: false,
      lineStyle: { width: 1.5, color: s.color },
      itemStyle: { color: s.color },
      emphasis: { focus: "series" },
    });
  }

  if (maActive.size > 0) {
    const MA_SKIP = new Set(["F&G", "VIX"]);
    for (const s of [...SERIES, ...customSeries]) {
      if (!active.has(s.key) || !loaded[s.key] || MA_SKIP.has(s.key)) continue;
      for (const period of [20, 50, 200]) {
        if (!maActive.has(period)) continue;
        const maData   = computeMA(loaded[s.key], period);
        const filtered = filterRange(maData);
        series.push({
          name: `__ma_${s.key}_${period}`,
          type: "line",
          data: filtered,
          yAxisIndex: s.yAxis,
          showSymbol: false,
          lineStyle: { width: 1, color: s.color, type: "dashed", opacity: 0.55 },
          itemStyle:  { color: s.color },
          silent: true,
          tooltip: {
            formatter: () => "",
            show: true,
          },
        });
      }
    }
  }

  if (fearActive && loaded["F&G"]) {
    const DEEP = 15;
    const markAreaData = [
      ...fearZones(fearThreshold).map(([s, e]) => [
        { xAxis: s, itemStyle: { color: "rgba(239,68,68,0.10)" } },
        { xAxis: e },
      ]),
      ...(fearThreshold > DEEP ? fearZones(DEEP) : []).map(([s, e]) => [
        { xAxis: s, itemStyle: { color: "rgba(185,28,28,0.22)" } },
        { xAxis: e },
      ]),
    ];
    series.push({
      name: "__fearZone",
      type: "line",
      data: [],
      yAxisIndex: 0,
      lineStyle: { width: 0 },
      symbol: "none",
      silent: true,
      markArea: { silent: true, data: markAreaData },
    });
  }

  if (sigZoneActive && loaded["QQQ"]) {
    if (!state.sigMaps) buildSigMaps();
    if (state.sigMaps?.scoreArr) {
      const zones = [];
      let zStart = null, prev = null;
      for (const [date, score] of state.sigMaps.scoreArr) {
        if (score >= 4) { if (!zStart) zStart = date; }
        else            { if (zStart) { zones.push([zStart, prev]); zStart = null; } }
        prev = date;
      }
      if (zStart) zones.push([zStart, prev]);
      if (zones.length) {
        series.push({
          name: "__sigZone", type: "line", data: [], yAxisIndex: 0,
          lineStyle: { width: 0 }, symbol: "none", silent: true,
          markArea: { silent: true, data: zones.map(([s, e]) => [
            { xAxis: s, itemStyle: { color: "rgba(63,185,80,0.13)" } },
            { xAxis: e },
          ])},
        });
      }
    }
  }

  if (ddZoneActive && loaded["QQQ"]) {
    const zones = computeDDZones(loaded["QQQ"], 60, 0.10);
    if (zones.length) {
      series.push({
        name: "__ddZone", type: "line", data: [], yAxisIndex: 0,
        lineStyle: { width: 0 }, symbol: "none", silent: true,
        markArea: { silent: true, data: zones.map(([s, e]) => [
          { xAxis: s, itemStyle: { color: "rgba(248,81,73,0.10)" } },
          { xAxis: e },
        ])},
      });
    }
  }

  if (fpeYIdx >= 0 && trendFpeData) {
    const fpeInterp = _interpFpe(trendFpeData);
    series.push({
      name: "QQQ FPE", type: "line",
      data: filterRange(fpeInterp),
      yAxisIndex: fpeYIdx,
      showSymbol: false,
      lineStyle: { color: "#58a6ff", width: 1.5 },
      itemStyle: { color: "#58a6ff" },
      emphasis: { focus: "series" },
    });
  }

  if (loaded["QQQ"] && loaded["F&G"]) {
    const qqqD   = loaded["QQQ"];
    const ma200B = computeMA(qqqD, 200);
    const { bounceSignals, bounceRetMap } = computeBounceSignals(qqqD, loaded["F&G"], ma200B);
    const filteredBouncePoints = filterRange(bounceSignals);
    if (filteredBouncePoints.length) {
      series.push({
        name: "__bounceSignal",
        type: "scatter",
        data: filteredBouncePoints,
        xAxisIndex: 0,
        yAxisIndex: 0,
        symbol: "triangle",
        symbolSize: 10,
        itemStyle: { color: "#f97316", opacity: 0.85 },
        z: 5,
        legendHoverLink: false,
        tooltip: {
          trigger: "item",
          formatter: p => {
            const info = bounceRetMap.get(p.data[0]);
            return `<b>${p.data[0]}</b><br/>恐慌反彈<br/>QQQ: $${(+p.data[1]).toFixed(2)}<br/>單日: +${((info?.ret ?? 0) * 100).toFixed(2)}%`;
          },
        },
      });
    }
  }

  chart.setOption({
    backgroundColor: "transparent",
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "cross" },
      backgroundColor: tipBg,
      borderColor: tipBdr,
      textStyle: { color: tipText },
      formatter(params) {
        let out = `<b>${params[0]?.axisValueLabel}</b><br/>`;
        for (const p of params) {
          if (p.seriesName.startsWith("__")) continue;
          out += `<span style="color:${p.color}">●</span> ${p.seriesName}: <b>${
            typeof p.value?.[1] === "number" ? p.value[1].toLocaleString() : "—"
          }</b><br/>`;
        }
        return out;
      },
    },
    legend: {
      data: series.filter(s => !s.name.startsWith("__")).map(s => s.name),
      textStyle: { color: tipText },
      top: 6,
    },
    grid: { left: isMob ? 75 : 115, right: isMob ? 100 : 160, top: 44, bottom: 56 },
    xAxis: {
      type: "time",
      axisLine: { lineStyle: { color: axisClr } },
      splitLine: { show: false },
    },
    yAxis: yAxisDef,
    dataZoom: [
      { type: "inside" },
      { type: "slider", height: 18, bottom: 14 },
    ],
    series,
  }, { notMerge: true });
}

// ── Series picker ──────────────────────────────────────────────
export function renderSeriesPicker() {
  const wrap = document.getElementById("series-picker");
  wrap.innerHTML = "";
  for (const s of SERIES) {
    const on = active.has(s.key);
    const el = document.createElement("span");
    el.className = "chip";
    el.textContent = s.key;
    el.style.borderColor = on ? s.color : "";
    el.style.color       = on ? s.color : "";
    el.onclick = async () => {
      if (active.has(s.key)) { active.delete(s.key); }
      else { active.add(s.key); await loadSeries(s); }
      renderSeriesPicker();
      render();
      if (fearActive) renderFearPanel();
    };
    wrap.appendChild(el);
  }
  for (const s of customSeries) {
    const on = active.has(s.key);
    const el = document.createElement("span");
    el.className = "chip";
    el.style.borderColor = on ? s.color : "";
    el.style.color       = on ? s.color : "";
    el.style.fontStyle   = "italic";
    const label = document.createTextNode(s.key + " ");
    const x = document.createElement("span");
    x.textContent = "×";
    x.style.cssText = "opacity:.55;cursor:pointer;font-style:normal";
    x.onclick = e => {
      e.stopPropagation();
      const idx = customSeries.indexOf(s);
      if (idx !== -1) customSeries.splice(idx, 1);
      active.delete(s.key);
      delete loaded[s.key]; delete loadedHLC[s.key]; delete loadedVol[s.key];
      renderSeriesPicker(); render();
    };
    el.appendChild(label); el.appendChild(x);
    el.onclick = () => {
      if (active.has(s.key)) active.delete(s.key); else active.add(s.key);
      renderSeriesPicker(); render();
    };
    wrap.appendChild(el);
  }
}

async function loadCustomTicker(rawSymbol) {
  const key = rawSymbol.trim().toUpperCase();
  if (!key) return;
  if (SERIES.find(s => s.key === key) || customSeries.find(s => s.key === key)) {
    active.add(key);
    renderSeriesPicker();
    render();
    return;
  }

  const status = document.getElementById("status");
  status.textContent = `載入 ${key} 中…`;

  try {
    let j;
    const staticResp = await fetch(`data/${key}.json`, { cache: "no-cache" });
    if (staticResp.ok) {
      j = await staticResp.json();
    } else {
      const apiResp = await fetch(`/api/stock?ticker=${encodeURIComponent(key)}`);
      if (!apiResp.ok) {
        const e = await apiResp.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${apiResp.status}`);
      }
      j = await apiResp.json();
    }

    const rows = (j.data || []).filter(r => r.close != null);
    if (!rows.length) throw new Error("無資料");

    loaded[key]    = rows.map(r => [r.date, r.close]);
    loadedHLC[key] = rows.map(r => [r.date, r.high, r.low, r.close]);
    loadedVol[key] = rows.map(r => [r.date, r.volume ?? 0]);
    state.sigMaps = null;

    const color = CUSTOM_COLORS[customSeries.length % CUSTOM_COLORS.length];
    customSeries.push({ key, file: null, color, yAxis: 0, custom: true });
    active.add(key);

    renderSeriesPicker();
    render();
    const latest = rows[rows.length - 1].date;
    status.textContent = `已載入 ${key}（${rows.length} 筆，至 ${latest}）`;
  } catch (err) {
    status.textContent = `⚠ 無法載入 ${key}：${err.message}`;
    setTimeout(() => { status.textContent = ""; }, 5000);
  }
}

// ── Tab module API ─────────────────────────────────────────────
export function activate() {
  setTimeout(() => chart.resize(), 50);
}

export function onThemeChange(light) {
  chart.dispose();
  chart = echarts.init(chartEl, light ? null : "dark");
  // Re-attach event handlers
  chart.on("updateAxisPointer", evt => {
    try {
      const ts = evt?.axesInfo?.[0]?.value;
      if (typeof ts !== "number") return;
      renderSignalPanel(tsToLocalDate(ts));
    } catch (_) {}
  });
  chart.on("globalout", () => { if (state.sigMaps) renderSignalPanel(); });
  render();
}

export function resize() {
  chart?.resize();
}

export async function toggleTrendFpe() {
  trendFpeActive = !trendFpeActive;
  document.getElementById("trend-fpe-toggle")?.classList.toggle("active", trendFpeActive);
  if (trendFpeActive && !trendFpeData) {
    try {
      const r = await fetch("data/QQQ_valuation.json", { cache: "no-cache" });
      const j = await r.json();
      trendFpeData = (j.data || []).sort((a, b) => a.date < b.date ? -1 : 1);
    } catch (e) {
      trendFpeActive = false;
      document.getElementById("trend-fpe-toggle")?.classList.remove("active");
      return;
    }
  }
  render();
}

// ── Wire trend-tab controls ────────────────────────────────────
document.getElementById("ma-picker")?.addEventListener("click", e => {
  const t = e.target.closest(".chip[data-ma]");
  if (!t) return;
  const p = +t.dataset.ma;
  if (maActive.has(p)) maActive.delete(p); else maActive.add(p);
  document.querySelectorAll("#ma-picker .chip[data-ma]").forEach(el =>
    el.classList.toggle("active", maActive.has(+el.dataset.ma)));
  render();
});

(function () {
  const input = document.getElementById("custom-ticker-input");
  const btn   = document.getElementById("custom-ticker-btn");
  if (!input || !btn) return;
  function submit() {
    const val = input.value.trim();
    if (!val) return;
    input.value = "";
    loadCustomTicker(val);
  }
  btn.addEventListener("click", submit);
  input.addEventListener("keydown", e => { if (e.key === "Enter") submit(); });
})();

document.getElementById("fear-toggle")?.addEventListener("click", async () => {
  fearActive = !fearActive;
  document.getElementById("fear-toggle").classList.toggle("fear-on", fearActive);
  if (fearActive) {
    await Promise.all([ensureLoaded("F&G"), ensureLoaded("SPY")]);
  }
  render();
  renderFearPanel();
});

document.getElementById("dd-toggle")?.addEventListener("click", () => {
  ddZoneActive = !ddZoneActive;
  document.getElementById("dd-toggle").classList.toggle("active", ddZoneActive);
  render();
});

document.getElementById("sig-zone-toggle")?.addEventListener("click", () => {
  sigZoneActive = !sigZoneActive;
  document.getElementById("sig-zone-toggle").classList.toggle("active", sigZoneActive);
  render();
});

let fThreshTimer = null;
document.getElementById("fear-threshold")?.addEventListener("input", e => {
  clearTimeout(fThreshTimer);
  fThreshTimer = setTimeout(() => {
    const v = parseInt(e.target.value);
    if (!isNaN(v) && v >= 1 && v <= 99) {
      fearThreshold = v;
      render();
      if (fearActive) renderFearPanel();
    }
  }, 300);
});

document.getElementById("range-picker")?.addEventListener("click", e => {
  const t = e.target.closest(".chip[data-range]");
  if (!t) return;
  state.rangePreset = t.dataset.range;
  state.customFrom = ""; state.customTo = "";
  if (dateFrom) dateFrom.value = "";
  if (dateTo)   dateTo.value = "";
  for (const c of e.currentTarget.querySelectorAll(".chip"))
    c.classList.toggle("active", c === t);
  render();
});

function onDateChange() {
  state.customFrom = dateFrom.value;
  state.customTo   = dateTo.value;
  if (state.customFrom || state.customTo)
    for (const c of document.querySelectorAll("#range-picker .chip"))
      c.classList.remove("active");
  render();
}
dateFrom?.addEventListener("change", onDateChange);
dateTo?.addEventListener("change", onDateChange);

if (dateTo) {
  dateTo.value = new Date().toISOString().slice(0, 10);
  dateTo.max   = dateTo.value;
}
