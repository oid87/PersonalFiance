// 景氣燈號 tab — 國發會景氣對策信號（9 項構成項加總 9–45 分 → 五燈），月頻 1984+。
// 定位：循環位置的「環境理解」，非交易訊號。資料 data/taiwan_business_signal.json。
import { isLight, tc, PALETTE } from '../utils/theme.js';

let chart = null;
let raw = null;                 // taiwan_business_signal.json: {data:[{date,score,light}], latest, updated}
let rangePreset = "10";         // 年

// 五燈：分數區間 + 顏色 + 狀態（由分數反推，較 light 字串穩定）
const BANDS = [
  { key: "藍",   name: "藍燈",   lo: 9,  hi: 16, color: "#2f6fed", desc: "低迷" },
  { key: "黃藍", name: "黃藍燈", lo: 17, hi: 22, color: "#17a2b8", desc: "轉弱" },
  { key: "綠",   name: "綠燈",   lo: 23, hi: 31, color: "#3fb950", desc: "穩定" },
  { key: "黃紅", name: "黃紅燈", lo: 32, hi: 37, color: "#f0883e", desc: "轉熱" },
  { key: "紅",   name: "紅燈",   lo: 38, hi: 45, color: "#e24b4a", desc: "熱絡" },
];
const bandOf = s => BANDS.find(b => s >= b.lo && s <= b.hi) || BANDS[2];

export async function init() {
  const status = document.getElementById("twcycle-status");
  if (raw) { renderAll(); return; }
  status.textContent = "載入中…";
  try {
    raw = await fetch("data/taiwan_business_signal.json").then(r => r.json());
    document.querySelectorAll("[data-twcycle-range]").forEach(el =>
      el.addEventListener("click", () => {
        rangePreset = el.dataset.twcycleRange;
        document.querySelectorAll("[data-twcycle-range]").forEach(e =>
          e.classList.toggle("active", e.dataset.twcycleRange === rangePreset));
        renderChart();
      }));
    renderAll();
    status.textContent =
      `國發會景氣對策信號 · ${raw.data.length} 個月（${raw.data[0].date.slice(0,7)}起）· 更新至 ${raw.updated}`;
  } catch (err) {
    status.textContent = `載入失敗：${err.message}`;
  }
}

function renderAll() { renderHeader(); renderChart(); }

function sliceRange(rows) {
  if (rangePreset === "all") return rows;
  return rows.slice(-12 * Number(rangePreset));
}

function renderHeader() {
  const d = raw.data;
  const last = d[d.length - 1];
  const b = bandOf(last.score);
  // 近 3 月方向
  const prev = d[d.length - 4];
  const diff = prev ? last.score - prev.score : 0;
  const arrow = diff > 0 ? "▲ 升溫" : diff < 0 ? "▼ 降溫" : "→ 持平";
  const arrowColor = diff > 0 ? "#e24b4a" : diff < 0 ? "#2f6fed" : "var(--muted)";
  const legend = BANDS.map(x =>
    `<span style="display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--muted)">
       <span style="width:11px;height:11px;border-radius:2px;background:${x.color}"></span>
       ${x.name} ${x.lo}–${x.hi} ${x.desc}</span>`).join("");
  document.getElementById("twcycle-header").innerHTML = `
    <div style="display:flex;flex-wrap:wrap;align-items:center;gap:18px;margin-bottom:12px">
      <div style="display:flex;align-items:center;gap:12px">
        <span style="width:16px;height:16px;border-radius:50%;background:${b.color};
              box-shadow:0 0 0 4px ${b.color}33"></span>
        <div>
          <div style="font-size:24px;font-weight:600;color:${b.color}">${b.name} · ${last.score} 分</div>
          <div style="font-size:12px;color:var(--muted)">${last.date.slice(0,7)} · ${b.desc}
            <span style="color:${arrowColor}">近3月 ${arrow}${diff ? ` ${diff>0?"+":""}${diff} 分` : ""}</span></div>
        </div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:14px;margin-left:auto">${legend}</div>
    </div>`;
}

function renderChart() {
  if (!chart) {
    chart = echarts.init(document.getElementById("twcycle-chart"), isLight() ? null : "dark");
    window.addEventListener("resize", () => chart && chart.resize());
  }
  const rows = sliceRange(raw.data);
  const dates = rows.map(r => r.date.slice(0, 7));
  const scores = rows.map(r => r.score);

  // 背景 5 色帶（連續邊界 16.5/22.5/31.5/37.5）
  const markAreaData = BANDS.map((b, i) => ([
    { yAxis: i === 0 ? 9 : BANDS[i].lo - 0.5,
      itemStyle: { color: b.color + (isLight() ? "1f" : "26") } },
    { yAxis: i === BANDS.length - 1 ? 45 : b.hi + 0.5 },
  ]));

  chart.setOption({
    animation: false,
    grid: { left: 44, right: 16, top: 16, bottom: 28 },
    tooltip: {
      trigger: "axis",
      formatter: p => {
        const s = p[0].value, b = bandOf(s);
        return `${p[0].axisValue}<br/><b style="color:${b.color}">${b.name}</b> · ${s} 分（${b.desc}）`;
      },
    },
    xAxis: {
      type: "category", data: dates, boundaryGap: false,
      axisLabel: { color: PALETTE.muted },
      axisLine: { lineStyle: { color: PALETTE.border } },
    },
    yAxis: {
      min: 9, max: 45, interval: 8,
      axisLabel: { color: PALETTE.muted },
      splitLine: { lineStyle: { color: PALETTE.grid } },
    },
    // 依分數區間給線段上色（五燈色）
    visualMap: {
      show: false, type: "piecewise", dimension: 1, seriesIndex: 0,
      pieces: BANDS.map(b => ({
        gte: b.lo - (b === BANDS[0] ? 1 : 0.5),
        lt: b.hi + 0.5, color: b.color,
      })),
    },
    series: [{
      type: "line", data: scores, showSymbol: false,
      lineStyle: { width: 2 },
      markArea: { silent: true, data: markAreaData },
    }],
  });
}

export function onThemeChange(light) {
  if (chart) {
    chart.dispose();
    chart = echarts.init(document.getElementById("twcycle-chart"), light ? null : "dark");
    renderChart();
  }
}

export function resize() { chart?.resize(); }
