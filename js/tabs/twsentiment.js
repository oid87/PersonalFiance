// 台股情緒 tab — 台股恐懼貪婪指數 (P/C + 散戶多空 + 趨勢 + 融資 合成) + 加權指數參照
// + 原始元件面板：選擇權 P/C ratio / 台指期散戶多空+外資 / 大盤融資餘額。
import { isLight, tc, mob } from '../utils/theme.js';
import { tsToLocalDate } from '../utils/dates.js';

let chart = null, gauge = null;
let sent = null;            // taiwan_sentiment.json
let twii = null, pc = null, fut = null, mar = null;   // raw component arrays
let rangePreset = "5Y";

const C = {
  twii: "#58a6ff", comp: "#f778ba", pcv: "#f0883e", pco: "#d2a8ff",
  retail: "#3fb950", foreign: "#f85149", margin: "#e3b341",
};

export async function init() {
  const status = document.getElementById("twsent-status");
  if (sent) { renderAll(); return; }
  status.textContent = "載入中…";
  try {
    const [s, t, p, f, m] = await Promise.all([
      fetch("data/taiwan_sentiment.json").then(r => r.json()),
      fetch("data/TWII.json").then(r => r.json()),
      fetch("data/taiwan_pcratio.json").then(r => r.json()),
      fetch("data/taiwan_fut_inst.json").then(r => r.json()),
      fetch("data/taiwan_margin_total.json").then(r => r.json()),
    ]);
    sent = s;
    twii = t.data.map(r => [r.date, r.close]);
    pc   = p.data;
    fut  = f.data;
    mar  = m.data;

    document.querySelectorAll("[data-twsent-range]").forEach(el =>
      el.addEventListener("click", () => {
        rangePreset = el.dataset.twsentRange;
        document.querySelectorAll("[data-twsent-range]").forEach(e =>
          e.classList.toggle("active", e.dataset.twsentRange === rangePreset));
        renderChart(); renderTable();
      }));

    renderAll();
    status.textContent = `台股恐懼貪婪 ${sent.data.length} 日 · 更新至 ${sent.updated}`;
  } catch (err) {
    status.textContent = `載入失敗：${err.message}`;
  }
}

function fgLabel(v) {
  if (v < 20) return "極度恐懼"; if (v < 40) return "恐懼";
  if (v < 60) return "中性"; if (v < 80) return "貪婪"; return "極度貪婪";
}
function fgColor(v) {
  if (v < 20) return "#ef4444"; if (v < 40) return "#f97316";
  if (v < 60) return "#eab308"; if (v < 80) return "#22c55e"; return "#16a34a";
}

function fromDate() {
  if (rangePreset === "all") return sent?.data?.[0]?.date || null;
  const d = new Date();
  d.setFullYear(d.getFullYear() - parseInt(rangePreset));
  return d.toISOString().slice(0, 10);
}

function renderAll() {
  renderCards();
  if (!gauge) gauge = echarts.init(document.getElementById("twsent-gauge"), isLight() ? null : "dark");
  renderGauge(sent.latest.composite);
  if (!chart) {
    chart = echarts.init(document.getElementById("twsent-chart"), isLight() ? null : "dark");
    window.addEventListener("resize", () => chart && chart.resize());
  }
  renderChart();
  renderTable();
}

function renderCards() {
  const lat = sent.latest;
  const tw = twii.at(-1), p = pc.at(-1), f = fut.at(-1), m = mar.at(-1);
  document.getElementById("twsent-score-label").textContent = fgLabel(lat.composite);
  document.getElementById("twsent-score-label").style.color = fgColor(lat.composite);
  const card = (label, val, sub, color) =>
    `<div class="aaii-card"><div class="aaii-card-label">${label}</div>
     <div class="aaii-card-val" style="color:${color || "var(--text)"}">${val}</div>
     <div class="aaii-card-sub">${sub}</div></div>`;
  document.getElementById("twsent-cards").innerHTML =
    card("加權指數", tw[1].toLocaleString("en-US", { maximumFractionDigits: 0 }), tw[0], C.twii) +
    card("選擇權 P/C 成交量比", p.vol_pc.toFixed(1), `${p.date}`, C.pcv) +
    card("散戶淨多 (口)", (f.retail_net >= 0 ? "+" : "") + f.retail_net.toLocaleString("en-US"), `外資 ${f.foreign_net.toLocaleString("en-US")}`, f.retail_net >= 0 ? C.retail : C.foreign) +
    card("大盤融資餘額 (億)", m.margin_money.toLocaleString("en-US", { maximumFractionDigits: 0 }), m.date, C.margin);
}

function renderGauge(score) {
  gauge.setOption({
    backgroundColor: "transparent",
    series: [{
      type: "gauge", startAngle: 180, endAngle: 0, min: 0, max: 100,
      radius: "100%", center: ["50%", "78%"],
      axisLine: { lineStyle: { width: 18, color: [[0.2, "#ef4444"], [0.4, "#f97316"], [0.6, "#eab308"], [0.8, "#22c55e"], [1, "#16a34a"]] } },
      pointer: { length: "62%", width: 5, itemStyle: { color: "auto" } },
      axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false },
      detail: { offsetCenter: [0, "-18%"], fontSize: 36, fontWeight: 700, color: fgColor(score), formatter: v => Math.round(v) },
      title: { show: false }, data: [{ value: Math.round(score) }],
    }],
  });
}

function renderChart() {
  if (!sent || !chart) return;
  const from = fromDate();
  const fil = arr => from ? arr.filter(r => (r[0] ?? r.date) >= from) : arr;

  const comp = fil(sent.data.map(r => [r.date, r.composite]));
  const twS = fil(twii);
  const pcv = fil(pc).map(r => [r.date, r.vol_pc]);
  const pco = fil(pc).map(r => [r.date, r.oi_pc]);
  const ret = fil(fut).map(r => [r.date, r.retail_net]);
  const fgn = fil(fut).map(r => [r.date, r.foreign_net]);
  const mgn = fil(mar).map(r => [r.date, r.margin_money]);

  const xmin = from || sent.data[0].date;
  const xmax = [twii.at(-1)[0], sent.data.at(-1).date].sort().at(-1);

  const tipBg = tc("#161b22", "#ffffff"), tipBdr = tc("#30363d", "#d0d7de");
  const tipTx = tc("#e6edf3", "#1f2328"), axCl = tc("#8b949e", "#57606a");
  const gridCl = tc("rgba(48,54,61,0.5)", "rgba(208,215,222,0.4)");
  const xAx = i => ({ type: "time", gridIndex: i, min: xmin, max: xmax,
    axisLabel: { show: i === 3, color: axCl, fontSize: 11 }, axisLine: { lineStyle: { color: gridCl } }, splitLine: { show: false } });

  chart.setOption({
    backgroundColor: "transparent", animation: false,
    axisPointer: { link: [{ xAxisIndex: "all" }], label: { backgroundColor: axCl } },
    legend: { top: 6, left: "center", textStyle: { color: axCl, fontSize: 11 }, itemWidth: mob() ? 14 : 25, itemGap: mob() ? 8 : 16,
      data: ["加權指數", "恐懼貪婪", "P/C 成交量比", "P/C 未平倉比", "散戶淨多", "外資淨", "融資餘額"], selected: { "P/C 未平倉比": false } },
    tooltip: { trigger: "axis", backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: tipTx, fontSize: 12 },
      formatter: params => {
        if (!params.length) return "";
        let html = `<b>${tsToLocalDate(params[0].axisValue)}</b><br/>`;
        for (const p of params) {
          const v = p.value?.[1]; if (v == null) continue;
          let s;
          if (p.seriesName === "加權指數") s = v.toLocaleString("en-US", { maximumFractionDigits: 0 });
          else if (p.seriesName === "恐懼貪婪") s = `${v.toFixed(0)} ${fgLabel(v)}`;
          else if (p.seriesName === "融資餘額") s = v.toLocaleString("en-US", { maximumFractionDigits: 0 }) + " 億";
          else if (p.seriesName.startsWith("P/C")) s = v.toFixed(1);
          else s = (v >= 0 ? "+" : "") + v.toLocaleString("en-US") + " 口";
          html += `<span style="color:${p.color}">● ${p.seriesName}: <b>${s}</b></span><br/>`;
        }
        return html;
      } },
    grid: [
      { left: mob() ? 48 : 64, right: mob() ? 48 : 60, top: mob() ? 70 : 44, height: mob() ? "16%" : "17%" },
      { left: mob() ? 48 : 64, right: mob() ? 48 : 60, top: "34%", height: mob() ? "15%" : "16%" },
      { left: mob() ? 48 : 64, right: mob() ? 48 : 60, top: "56%", height: mob() ? "15%" : "16%" },
      { left: mob() ? 48 : 64, right: mob() ? 48 : 60, top: "78%", height: mob() ? "15%" : "16%" },
    ],
    xAxis: [xAx(0), xAx(1), xAx(2), xAx(3)],
    yAxis: [
      { type: "value", gridIndex: 0, scale: true, name: "加權", nameTextStyle: { color: C.twii, fontSize: 10 }, axisLabel: { color: axCl, fontSize: 10 }, splitLine: { lineStyle: { color: gridCl } } },
      { type: "value", gridIndex: 0, min: 0, max: 100, position: "right", name: "恐懼貪婪", nameTextStyle: { color: C.comp, fontSize: 10 }, axisLabel: { color: C.comp, fontSize: 10 }, splitLine: { show: false } },
      { type: "value", gridIndex: 1, scale: true, name: "P/C", nameTextStyle: { color: C.pcv, fontSize: 10 }, axisLabel: { color: axCl, fontSize: 10 }, splitLine: { lineStyle: { color: gridCl } } },
      { type: "value", gridIndex: 2, scale: true, name: "口", nameTextStyle: { color: axCl, fontSize: 10 }, axisLabel: { color: axCl, fontSize: 10 }, splitLine: { lineStyle: { color: gridCl } } },
      { type: "value", gridIndex: 3, scale: true, name: "億", nameTextStyle: { color: C.margin, fontSize: 10 }, axisLabel: { color: axCl, fontSize: 10 }, splitLine: { lineStyle: { color: gridCl } } },
    ],
    series: [
      { name: "加權指數", type: "line", xAxisIndex: 0, yAxisIndex: 0, data: twS, symbol: "none", lineStyle: { color: C.twii, width: 1.5 },
        areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: "rgba(88,166,255,0.16)" }, { offset: 1, color: "rgba(88,166,255,0.01)" }] } } },
      { name: "恐懼貪婪", type: "line", xAxisIndex: 0, yAxisIndex: 1, data: comp, symbol: "none", lineStyle: { color: C.comp, width: 1.2 },
        markLine: { silent: true, symbol: "none", data: [
          { yAxis: 25, lineStyle: { color: "#f85149", type: "dashed", width: 1 }, label: { show: !mob(), formatter: "恐懼25", color: "#f85149", fontSize: 9, position: "insideEndTop" } },
          { yAxis: 75, lineStyle: { color: "#16a34a", type: "dashed", width: 1 }, label: { show: !mob(), formatter: "貪婪75", color: "#16a34a", fontSize: 9, position: "insideEndBottom" } },
        ] } },
      { name: "P/C 成交量比", type: "line", xAxisIndex: 1, yAxisIndex: 2, data: pcv, symbol: "none", lineStyle: { color: C.pcv, width: 1 },
        markLine: { silent: true, symbol: "none", data: [{ yAxis: 100, lineStyle: { color: axCl, type: "dotted", width: 1 } }] } },
      { name: "P/C 未平倉比", type: "line", xAxisIndex: 1, yAxisIndex: 2, data: pco, symbol: "none", lineStyle: { color: C.pco, width: 1, type: "dashed" } },
      { name: "散戶淨多", type: "line", xAxisIndex: 2, yAxisIndex: 3, data: ret, symbol: "none", lineStyle: { color: C.retail, width: 1.2 },
        markLine: { silent: true, symbol: "none", data: [{ yAxis: 0, lineStyle: { color: axCl, type: "dotted", width: 1 } }] } },
      { name: "外資淨", type: "line", xAxisIndex: 2, yAxisIndex: 3, data: fgn, symbol: "none", lineStyle: { color: C.foreign, width: 1 } },
      { name: "融資餘額", type: "line", xAxisIndex: 3, yAxisIndex: 4, data: mgn, symbol: "none", lineStyle: { color: C.margin, width: 1.4 } },
    ],
    dataZoom: [
      { type: "inside", xAxisIndex: [0, 1, 2, 3] },
      { type: "slider", xAxisIndex: [0, 1, 2, 3], height: 16, bottom: 6, fillerColor: "rgba(88,166,255,0.1)", borderColor: tc("#30363d", "#d0d7de") },
    ],
  }, true);
}

function renderTable() {
  const from = fromDate();
  const rows = (from ? sent.data.filter(r => r.date >= from) : sent.data).slice().reverse();
  const pcMap = Object.fromEntries(pc.map(r => [r.date, r]));
  const futMap = Object.fromEntries(fut.map(r => [r.date, r]));
  const marMap = Object.fromEntries(mar.map(r => [r.date, r]));
  const twMap = Object.fromEntries(twii);
  document.getElementById("twsent-thead").innerHTML =
    `<tr><th>日期</th><th>恐懼貪婪</th><th>P/C量比</th><th>散戶淨多</th><th>外資淨</th><th>融資(億)</th><th>加權</th></tr>`;
  const muted = "<span style='color:var(--muted)'>—</span>";
  document.getElementById("twsent-tbody").innerHTML = rows.map(r => {
    const p = pcMap[r.date], f = futMap[r.date], m = marMap[r.date], tw = twMap[r.date];
    return `<tr>
      <td>${r.date}</td>
      <td style="color:${fgColor(r.composite)};font-weight:600">${r.composite.toFixed(0)}</td>
      <td>${p ? p.vol_pc.toFixed(1) : muted}</td>
      <td class="${f && f.retail_net >= 0 ? "pos" : "neg"}">${f ? (f.retail_net >= 0 ? "+" : "") + f.retail_net.toLocaleString("en-US") : muted}</td>
      <td>${f ? f.foreign_net.toLocaleString("en-US") : muted}</td>
      <td>${m ? m.margin_money.toLocaleString("en-US", { maximumFractionDigits: 0 }) : muted}</td>
      <td>${tw ? tw.toLocaleString("en-US", { maximumFractionDigits: 0 }) : muted}</td>
    </tr>`;
  }).join("");
  document.getElementById("twsent-table-count").textContent = `${rows.length} 日`;
}

export function onThemeChange(light) {
  if (chart) { chart.dispose(); chart = echarts.init(document.getElementById("twsent-chart"), light ? null : "dark"); renderChart(); }
  if (gauge) { gauge.dispose(); gauge = echarts.init(document.getElementById("twsent-gauge"), light ? null : "dark"); renderGauge(sent.latest.composite); }
}

export function resize() { chart?.resize(); gauge?.resize(); }
