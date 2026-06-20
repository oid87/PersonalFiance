// 牛熊指標 tab — 窮人版 BofA Bull & Bear Indicator
// 7 components, each percentile-ranked to 0–10, equal-weight composite.
// Data: bullbear.json (NAAIM/COT/FRED) + breadth.json + SP500_PE.json + SP500.json
import { isLight, tc, mob } from '../utils/theme.js';
import { tsToLocalDate, lookupLE } from '../utils/dates.js';

let gaugeChart = null, mainChart = null;
let bb = null;            // bullbear.json
let breadthArr = null;    // [{date, pct200}]
let peArr = null;         // [{date, pe}]
let spArr = null;         // [[date, close]]
let composite = null;     // [{date, score, components:{...}}]
let rangePreset = "5Y";

const C = {
  score: "#f778ba", sp: "#58a6ff",
  naaim: "#3fb950", cot: "#e3b341", hy: "#f85149",
  sloos: "#a371f7", consumer: "#58d9f9", breadth: "#f0883e", pe: "#d2a8ff",
};

const COMP_META = [
  { key: "mmf",      label: "貨幣基金部位",     color: C.naaim,    dir: -1, tip: "貨幣市場基金總額 (高=機構防禦=看空，NAAIM 替代)" },
  { key: "cot",      label: "COT 槓桿基金淨部位", color: C.cot,   dir: 1,  tip: "CFTC S&P500期貨 Leveraged Funds 淨合約數" },
  { key: "hy",       label: "HY 信用利差",      color: C.hy,      dir: -1, tip: "ICE BofA HY OAS (越高越恐慌)" },
  { key: "sloos",    label: "SLOOS 信貸收緊",   color: C.sloos,   dir: -1, tip: "銀行收緊貸款標準淨比例 (越高越緊)" },
  { key: "consumer", label: "消費者信心",        color: C.consumer, dir: 1,  tip: "密西根大學消費者信心指數" },
  { key: "breadth",  label: "市場廣度",         color: C.breadth,  dir: 1,  tip: "S&P500 站上200MA比例" },
  { key: "pe",       label: "估值 P/E",         color: C.pe,       dir: 1,  tip: "S&P500 Trailing P/E (高=樂觀/亢奮)" },
  { key: "naaim",    label: "NAAIM 經理曝險",   color: "#7ee787",  dir: 1,  tip: "主動型基金經理平均股票曝險 (0–200%，若可取得)" },
];

// ── percentile rank ────────────────────────────────────────────────────────

function percentileRank(val, sorted) {
  if (!sorted.length) return 5;
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < val) lo = mid + 1; else hi = mid;
  }
  return (lo / sorted.length) * 10;
}

function buildComposite() {
  const series = {};
  const allVals = {};

  // NAAIM → weekly [{date, val}]
  if (bb.naaim?.length) {
    series.naaim = bb.naaim.map(r => ({ date: r.date, val: r.mean }));
    allVals.naaim = bb.naaim.map(r => r.mean).sort((a, b) => a - b);
  }
  // MMF (Money Market Fund assets) — NAAIM proxy
  if (bb.mmf?.length) {
    series.mmf = bb.mmf.map(r => ({ date: r.date, val: r.value }));
    allVals.mmf = bb.mmf.map(r => r.value).sort((a, b) => a - b);
  }
  // COT leveraged net
  if (bb.cot?.length) {
    series.cot = bb.cot.map(r => ({ date: r.date, val: r.lev_net }));
    allVals.cot = bb.cot.map(r => r.lev_net).sort((a, b) => a - b);
  }
  // HY spread
  if (bb.hy_spread?.length) {
    series.hy = bb.hy_spread.map(r => ({ date: r.date, val: r.value }));
    allVals.hy = bb.hy_spread.map(r => r.value).sort((a, b) => a - b);
  }
  // SLOOS
  if (bb.sloos?.length) {
    series.sloos = bb.sloos.map(r => ({ date: r.date, val: r.value }));
    allVals.sloos = bb.sloos.map(r => r.value).sort((a, b) => a - b);
  }
  // Consumer sentiment
  if (bb.consumer?.length) {
    series.consumer = bb.consumer.map(r => ({ date: r.date, val: r.value }));
    allVals.consumer = bb.consumer.map(r => r.value).sort((a, b) => a - b);
  }
  // Breadth (% above 200MA)
  if (breadthArr?.length) {
    series.breadth = breadthArr;
    allVals.breadth = breadthArr.map(r => r.val).sort((a, b) => a - b);
  }
  // P/E
  if (peArr?.length) {
    series.pe = peArr;
    allVals.pe = peArr.map(r => r.val).sort((a, b) => a - b);
  }

  // collect all unique dates (weekly grid from earliest to latest)
  const allDates = new Set();
  for (const arr of Object.values(series)) for (const r of arr) allDates.add(r.date);
  const dates = [...allDates].sort();

  // for each series, build a Map for O(1) lookup and a forward-fill index
  const maps = {};
  for (const [k, arr] of Object.entries(series)) {
    maps[k] = arr.map(r => [r.date, r.val]); // sorted [date, val]
  }

  // build composite at weekly cadence
  const result = [];
  for (const d of dates) {
    const comps = {};
    let sum = 0, count = 0;
    for (const m of COMP_META) {
      const arr = maps[m.key];
      if (!arr?.length) continue;
      const entry = lookupLE(arr, d);
      if (!entry) continue;
      // only use if data is within 90 days (don't forward-fill stale quarterly data too far)
      const daysDiff = (new Date(d) - new Date(entry[0])) / 86400000;
      if (daysDiff > 120) continue;
      const raw = entry[1];
      let score = percentileRank(raw, allVals[m.key]);
      if (m.dir === -1) score = 10 - score;
      comps[m.key] = { raw, score: Math.round(score * 10) / 10 };
      sum += score;
      count++;
    }
    if (count >= 3) {
      result.push({ date: d, score: Math.round((sum / count) * 10) / 10, n: count, ...comps });
    }
  }
  return result;
}

// ── downsample for chart performance ───────────────────────────────────────

function downsample(arr, maxPts) {
  if (arr.length <= maxPts) return arr;
  const step = Math.ceil(arr.length / maxPts);
  const out = [];
  for (let i = 0; i < arr.length; i += step) out.push(arr[i]);
  if (out.at(-1) !== arr.at(-1)) out.push(arr.at(-1));
  return out;
}

// ── labels / colors ────────────────────────────────────────────────────────

function bbLabel(v) {
  if (v <= 2) return "極度看空";
  if (v <= 4) return "偏空";
  if (v <= 6) return "中性";
  if (v <= 8) return "偏多";
  return "極度看多";
}
function bbColor(v) {
  if (v <= 2) return "#ef4444";
  if (v <= 4) return "#f97316";
  if (v <= 6) return "#eab308";
  if (v <= 8) return "#22c55e";
  return "#16a34a";
}
function contrarian(v) {
  if (v >= 8) return { text: "⚠ 反向賣出訊號", color: "#f85149" };
  if (v <= 2) return { text: "✦ 反向買入訊號", color: "#3fb950" };
  return null;
}

// ── init ────────────────────────────────────────────────────────────────────

export async function init() {
  const status = document.getElementById("bb-status");
  if (composite) { renderAll(); return; }
  status.textContent = "載入中…";
  try {
    const [bbResp, brResp, peResp, spResp] = await Promise.all([
      fetch("data/bullbear.json"),
      fetch("data/breadth.json"),
      fetch("data/SP500_PE.json"),
      fetch("data/SP500.json"),
    ]);
    bb = await bbResp.json();
    const br = await brResp.json();
    const pe = await peResp.json();
    const sp = await spResp.json();

    breadthArr = br.data
      .filter(r => r.above200_pct != null)
      .map(r => ({ date: r.date, val: r.above200_pct }));
    peArr = pe.data.map(r => ({ date: r.date, val: r.pe }));
    spArr = sp.data.map(r => [r.date, r.close]);

    composite = buildComposite();

    document.querySelectorAll("[data-bb-range]").forEach(el =>
      el.addEventListener("click", () => {
        rangePreset = el.dataset.bbRange;
        document.querySelectorAll("[data-bb-range]").forEach(e =>
          e.classList.toggle("active", e.dataset.bbRange === rangePreset));
        renderChart();
      }));

    renderAll();
    const keyMap = { hy: "hy_spread" };
    const avail = COMP_META.filter(m => {
      if (m.key === "breadth") return breadthArr?.length;
      if (m.key === "pe") return peArr?.length;
      return bb[keyMap[m.key] || m.key]?.length;
    }).length;
    status.textContent = `${avail}/7 個元件 · ${composite.length} 期 · 更新至 ${bb.updated}`;
  } catch (err) {
    status.textContent = `載入失敗：${err.message}`;
  }
}

// ── render ──────────────────────────────────────────────────────────────────

function renderAll() {
  renderGauge();
  renderCards();
  if (!mainChart) {
    mainChart = echarts.init(document.getElementById("bb-chart"), isLight() ? null : "dark");
    window.addEventListener("resize", () => mainChart?.resize());
  }
  renderChart();
}

export function onThemeChange(light) {
  if (gaugeChart) { gaugeChart.dispose(); gaugeChart = null; }
  if (mainChart)  { mainChart.dispose();  mainChart = null;  }
  if (composite) renderAll();
}

export function resize() {
  gaugeChart?.resize();
  mainChart?.resize();
}

function renderGauge() {
  if (!composite?.length) return;
  const latest = composite.at(-1);
  const score = latest.score;

  if (!gaugeChart) {
    gaugeChart = echarts.init(document.getElementById("bb-gauge"), isLight() ? null : "dark");
  }
  gaugeChart.setOption({
    backgroundColor: "transparent",
    series: [{
      type: "gauge",
      startAngle: 180, endAngle: 0,
      min: 0, max: 10,
      radius: "95%", center: ["50%", "82%"],
      axisLine: {
        lineStyle: {
          width: 20,
          color: [[0.2,"#ef4444"],[0.4,"#f97316"],[0.6,"#eab308"],[0.8,"#22c55e"],[1,"#16a34a"]]
        }
      },
      pointer: { length: "60%", width: 5, itemStyle: { color: "auto" } },
      axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false },
      detail: {
        offsetCenter: [0, "-25%"], fontSize: 42, fontWeight: 700,
        color: bbColor(score), formatter: v => v.toFixed(1)
      },
      title: { show: false },
      data: [{ value: score }],
    }]
  });

  document.getElementById("bb-label").textContent = bbLabel(score);
  document.getElementById("bb-label").style.color = bbColor(score);
  document.getElementById("bb-updated").textContent = `資料截至 ${latest.date}`;
  const sig = contrarian(score);
  const sigEl = document.getElementById("bb-signal");
  if (sig) {
    sigEl.textContent = sig.text;
    sigEl.style.color = sig.color;
    sigEl.style.display = "";
  } else {
    sigEl.style.display = "none";
  }
}

function renderCards() {
  if (!composite?.length) return;
  const latest = composite.at(-1);
  const el = document.getElementById("bb-bars");
  let html = "";
  for (const m of COMP_META) {
    const c = latest[m.key];
    if (!c) {
      html += `<div class="sent-ind-row">
        <span class="sent-ind-label">${m.label}</span>
        <div class="sent-ind-bar-bg"><div class="sent-ind-bar" style="width:0%;background:${m.color}"></div></div>
        <span class="sent-ind-val" style="color:var(--muted)">—</span>
      </div>`;
      continue;
    }
    const pct = c.score * 10;
    html += `<div class="sent-ind-row" title="${m.tip}">
      <span class="sent-ind-label">${m.label}</span>
      <div class="sent-ind-bar-bg"><div class="sent-ind-bar" style="width:${pct}%;background:${m.color}"></div></div>
      <span class="sent-ind-val" style="color:${bbColor(c.score)}">${c.score.toFixed(1)}</span>
    </div>`;
  }
  el.innerHTML = html;
}

function renderChart() {
  if (!mainChart || !composite?.length) return;
  const from = rangePreset === "all" ? null : (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - parseInt(rangePreset));
    return d.toISOString().slice(0, 10);
  })();

  let rows = from ? composite.filter(r => r.date >= from) : composite;
  rows = downsample(rows, 600);
  const scoreSeries = rows.map(r => [r.date, r.score]);
  const spFiltered = from ? spArr.filter(r => r[0] >= from) : spArr;
  const spSampled = downsample(spFiltered, 600);

  const tipBg = tc("#161b22","#ffffff"), tipBdr = tc("#30363d","#d0d7de");
  const tipTx = tc("#e6edf3","#1f2328"), axCl = tc("#8b949e","#57606a");
  const gridCl = tc("rgba(48,54,61,0.5)","rgba(208,215,222,0.4)");

  mainChart.setOption({
    backgroundColor: "transparent",
    tooltip: {
      trigger: "axis",
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: tipTx, fontSize: 12 },
      formatter: params => {
        const raw = params[0]?.axisValue;
        const date = raw ? tsToLocalDate(raw) : "";
        let html = `<b>${date}</b><br/>`;
        for (const p of params) {
          if (p.value?.[1] == null) continue;
          const v = p.value[1];
          if (p.seriesName === "牛熊指標") {
            html += `<span style="color:${bbColor(v)}">● 牛熊: <b>${v.toFixed(1)}</b> ${bbLabel(v)}</span><br/>`;
          } else {
            html += `<span style="color:${C.sp}">● S&P500: <b>${v.toFixed(0)}</b></span><br/>`;
          }
        }
        return html;
      }
    },
    legend: { data:["牛熊指標","S&P 500"], top:8, right:24, textStyle:{ color:axCl, fontSize:12 } },
    grid: { top:44, right: mob() ? 50 : 70, bottom:40, left: mob() ? 40 : 54 },
    xAxis: { type:"time", splitLine:{show:false}, axisLabel:{color:axCl,fontSize:11} },
    yAxis: [
      { type:"value", min:0, max:10, name:"牛熊", nameTextStyle:{color:axCl,fontSize:11},
        splitLine:{lineStyle:{color:gridCl}}, axisLabel:{color:axCl,fontSize:11} },
      { type:"value", name:"S&P 500", nameTextStyle:{color:C.sp,fontSize:11},
        position:"right", splitLine:{show:false}, axisLabel:{color:C.sp,fontSize:11} },
    ],
    series: [
      {
        name:"牛熊指標", type:"line", data:scoreSeries, yAxisIndex:0, symbol:"none",
        lineStyle:{ color:C.score, width:2 },
        areaStyle:{ color:{ type:"linear",x:0,y:0,x2:0,y2:1,
          colorStops:[{offset:0,color:"rgba(247,120,186,0.18)"},{offset:1,color:"rgba(247,120,186,0.01)"}] } },
        markArea:{ silent:true, data:[
          [{yAxis:0},{yAxis:2,itemStyle:{color:"rgba(239,68,68,0.07)"}}],
          [{yAxis:8},{yAxis:10,itemStyle:{color:"rgba(34,197,94,0.07)"}}],
        ]},
        markLine:{ silent:true, symbol:"none", data:[
          {yAxis:2,lineStyle:{color:"#ef4444",type:"dashed",width:1},
           label:{show:!mob(),formatter:"反向買 <2",color:"#ef4444",fontSize:10,position:"end"}},
          {yAxis:8,lineStyle:{color:"#22c55e",type:"dashed",width:1},
           label:{show:!mob(),formatter:"反向賣 >8",color:"#22c55e",fontSize:10,position:"end"}},
        ]}
      },
      {
        name:"S&P 500", type:"line", data:spSampled, yAxisIndex:1, symbol:"none",
        lineStyle:{ color:C.sp, width:1.2, opacity:0.7 },
      },
    ],
  }, true);
}
