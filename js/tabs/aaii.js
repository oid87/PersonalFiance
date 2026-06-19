// AAII 散戶情緒對照 tab — 仿 MacroMicro「恐懼貪婪指數 AAII 與 S&P500 關係」
// 四格對照圖：S&P500 指數(^GSPC) / 市場恐慌(CNN F&G + VIX) / AAII 看多·中立·看空 / 看多−看空
// + 完整週度歷史對照表。AAII 為週頻，其餘為日頻，依日期向前對齊。
// S&P 500 用指數(^GSPC, 1987起)而非 SPY ETF(2000起)，以便對齊 AAII 1987 起點。
import { isLight, tc, mob } from '../utils/theme.js';
import { tsToLocalDate, lookupLE } from '../utils/dates.js';

let aaiiChart   = null;
let aaii        = null;   // {data:[{date,bull,neutral,bear,spread}], updated}
let spArr = null, fgArr = null, vixArr = null;   // sorted [date, value] for lookupLE
let rangePreset = "5Y";

const C = {
  spy: "#58a6ff", fg: "#d2a8ff", vix: "#f0883e",
  bull: "#3fb950", neutral: "#8b949e", bear: "#f85149", net: "#e3b341",
};

export async function init() {
  const status = document.getElementById("aaii-status");
  if (aaii) { renderAll(); return; }
  status.textContent = "載入中…";
  try {
    const [aResp, spResp, fgResp, vixResp, vixEResp] = await Promise.all([
      fetch("data/aaii.json"),
      fetch("data/SP500.json"),       // S&P 500 index (^GSPC) — history back to 1987, unlike SPY ETF (2000)
      fetch("data/fear_greed.json"),
      fetch("data/VIX.json"),         // modern VIX, 2000+ (shared with other tabs, untouched)
      fetch("data/VIX_early.json"),   // ^VXO 1986-89 + ^VIX 1990-99 — extends VIX panel back to 1987
    ]);
    aaii = await aResp.json();
    const sp = await spResp.json(), fg = await fgResp.json(), vix = await vixResp.json();
    const vixE = vixEResp.ok ? await vixEResp.json() : { data: [] };
    spArr = sp.data.map(r => [r.date, r.close]);
    fgArr  = fg.data.map(r => [r.date, r.value]);
    // stitch: VIX_early (1986-1999) ahead of VIX.json (2000+) → continuous 1986→now
    vixArr = vixE.data.map(r => [r.date, r.close]).concat(vix.data.map(r => [r.date, r.close]));

    document.querySelectorAll("[data-aaii-range]").forEach(el =>
      el.addEventListener("click", () => {
        rangePreset = el.dataset.aaiiRange;
        document.querySelectorAll("[data-aaii-range]").forEach(e =>
          e.classList.toggle("active", e.dataset.aaiiRange === rangePreset));
        renderChart(); renderTable();
      }));

    renderAll();
    status.textContent = `AAII 散戶調查 ${aaii.data.length} 週 · 更新至 ${aaii.updated}`;
  } catch (err) {
    status.textContent = `載入失敗：${err.message}`;
  }
}

function fromDate() {
  // "all"  = back to AAII's start (1987) — the longest the survey goes. Pre-2000
  //          VIX and pre-2011 CNN F&G panels are simply blank there.
  // "2011" = the common window where all four indicators exist (CNN F&G starts 2011).
  if (rangePreset === "all")  return aaii?.data?.[0]?.date || null;
  if (rangePreset === "2011") return fgArr?.[0]?.[0] || null;
  const d = new Date();
  d.setFullYear(d.getFullYear() - parseInt(rangePreset));
  return d.toISOString().slice(0, 10);
}

function netColor(v) { return v >= 0 ? C.bull : C.bear; }

function renderAll() {
  renderCards();
  if (!aaiiChart) {
    aaiiChart = echarts.init(document.getElementById("aaii-chart"), isLight() ? null : "dark");
    window.addEventListener("resize", () => aaiiChart && aaiiChart.resize());
  }
  renderChart();
  renderTable();
}

function renderCards() {
  const a = aaii.data.at(-1);
  const spy = spArr.at(-1), vix = vixArr.at(-1), fg = fgArr.at(-1);
  const card = (label, val, sub, color) => `
    <div class="aaii-card">
      <div class="aaii-card-label">${label}</div>
      <div class="aaii-card-val" style="color:${color || "var(--text)"}">${val}</div>
      <div class="aaii-card-sub">${sub}</div>
    </div>`;
  document.getElementById("aaii-cards").innerHTML =
    card("AAII 淨看多", (a.spread >= 0 ? "+" : "") + a.spread.toFixed(1) + "%", `截至 ${a.date}`, netColor(a.spread)) +
    card("AAII 看多 / 看空", `${a.bull.toFixed(1)} / ${a.bear.toFixed(1)}`, `中立 ${a.neutral.toFixed(1)}%`, C.bull) +
    card("CNN 恐懼貪婪", fg[1].toFixed(0), fg[0], C.fg) +
    card("VIX", vix[1].toFixed(1), vix[0], C.vix) +
    card("S&P 500 指數", spy[1].toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }), spy[0], C.spy);
}

function renderChart() {
  if (!aaii || !aaiiChart) return;
  const from = fromDate();
  const fil = arr => from ? arr.filter(r => r[0] >= from) : arr;

  const aRows = fil(aaii.data.map(r => [r.date, r]));
  // AAII is weekly; insert a null break wherever two consecutive readings are
  // >21 days apart so a data gap shows as a broken line, not a straight fill.
  const withGaps = pick => {
    const out = [];
    for (let i = 0; i < aRows.length; i++) {
      const [d, r] = aRows[i];
      if (i > 0) {
        const prev = new Date(aRows[i - 1][0]), cur = new Date(d);
        if ((cur - prev) / 86400000 > 21) {
          const mid = new Date((prev.getTime() + cur.getTime()) / 2).toISOString().slice(0, 10);
          out.push([mid, null]);
        }
      }
      out.push([d, pick(r)]);
    }
    return out;
  };
  const bull = withGaps(r => r.bull);
  const neut = withGaps(r => r.neutral);
  const bear = withGaps(r => r.bear);
  const net  = withGaps(r => r.spread);
  const spy = fil(spArr), fgs = fil(fgArr), vix = fil(vixArr);

  // shared x range so the four grids line up exactly
  const xmin = from || (spArr[0][0] < aaii.data[0].date ? aaii.data[0].date : spArr[0][0]);
  const allLast = [spArr.at(-1)[0], fgArr.at(-1)[0], vixArr.at(-1)[0], aaii.data.at(-1).date].sort();
  const xmax = allLast.at(-1);

  const tipBg = tc("#161b22", "#ffffff"), tipBdr = tc("#30363d", "#d0d7de");
  const tipTx = tc("#e6edf3", "#1f2328"), axCl = tc("#8b949e", "#57606a");
  const gridCl = tc("rgba(48,54,61,0.5)", "rgba(208,215,222,0.4)");

  const xAxisCommon = i => ({
    type: "time", gridIndex: i, min: xmin, max: xmax,
    axisLabel: { show: i === 3, color: axCl, fontSize: 11 },
    axisLine: { lineStyle: { color: gridCl } },
    splitLine: { show: false },
  });

  aaiiChart.setOption({
    backgroundColor: "transparent",
    animation: false,
    axisPointer: { link: [{ xAxisIndex: "all" }], label: { backgroundColor: axCl } },
    legend: {
      top: 6, left: "center", textStyle: { color: axCl, fontSize: 11 },
      itemWidth: mob() ? 14 : 25, itemGap: mob() ? 8 : 16,
      data: ["S&P 500", "CNN 恐懼貪婪", "VIX", "看多", "中立", "看空", "看多−看空"],
    },
    tooltip: {
      trigger: "axis",
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: tipTx, fontSize: 12 },
      formatter: params => {
        if (!params.length) return "";
        const date = tsToLocalDate(params[0].axisValue);
        let html = `<b>${date}</b><br/>`;
        const unit = { "S&P 500": v => v.toLocaleString("en-US", { maximumFractionDigits: 0 }), "VIX": v => v.toFixed(1) };
        for (const p of params) {
          const v = p.value?.[1];
          if (v == null) continue;
          const fmt = unit[p.seriesName] ? unit[p.seriesName](v)
            : (p.seriesName === "看多−看空" ? (v >= 0 ? "+" : "") + v.toFixed(1) + "%" : v.toFixed(1) + "%");
          html += `<span style="color:${p.color}">● ${p.seriesName}: <b>${fmt}</b></span><br/>`;
        }
        return html;
      },
    },
    grid: [
      { left: mob() ? 46 : 60, right: mob() ? 46 : 58, top: mob() ? 68 : 44, height: mob() ? "14%" : "15%" },
      { left: mob() ? 46 : 60, right: mob() ? 46 : 58, top: "30%", height: mob() ? "14%" : "15%" },
      { left: mob() ? 46 : 60, right: mob() ? 46 : 58, top: "52%", height: mob() ? "14%" : "15%" },
      { left: mob() ? 46 : 60, right: mob() ? 46 : 58, top: "74%", height: mob() ? "15%" : "16%" },
    ],
    xAxis: [xAxisCommon(0), xAxisCommon(1), xAxisCommon(2), xAxisCommon(3)],
    yAxis: [
      { type: "value", gridIndex: 0, scale: true, name: "S&P500", nameTextStyle: { color: C.spy, fontSize: 10 },
        axisLabel: { color: axCl, fontSize: 10 }, splitLine: { lineStyle: { color: gridCl } } },
      { type: "value", gridIndex: 1, min: 0, max: 100, name: "F&G", nameTextStyle: { color: C.fg, fontSize: 10 },
        axisLabel: { color: axCl, fontSize: 10 }, splitLine: { lineStyle: { color: gridCl } } },
      { type: "value", gridIndex: 1, scale: true, position: "right", name: "VIX", nameTextStyle: { color: C.vix, fontSize: 10 },
        axisLabel: { color: C.vix, fontSize: 10 }, splitLine: { show: false } },
      { type: "value", gridIndex: 2, min: 0, max: 70, name: "%", nameTextStyle: { color: axCl, fontSize: 10 },
        axisLabel: { color: axCl, fontSize: 10 }, splitLine: { lineStyle: { color: gridCl } } },
      { type: "value", gridIndex: 3, scale: true, name: "看多−看空", nameTextStyle: { color: C.net, fontSize: 10 },
        axisLabel: { color: axCl, fontSize: 10 }, splitLine: { lineStyle: { color: gridCl } } },
    ],
    series: [
      { name: "S&P 500", type: "line", xAxisIndex: 0, yAxisIndex: 0, data: spy, symbol: "none",
        lineStyle: { color: C.spy, width: 1.5 },
        areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [{ offset: 0, color: "rgba(88,166,255,0.18)" }, { offset: 1, color: "rgba(88,166,255,0.01)" }] } } },
      { name: "CNN 恐懼貪婪", type: "line", xAxisIndex: 1, yAxisIndex: 1, data: fgs, symbol: "none",
        lineStyle: { color: C.fg, width: 1.3 },
        markLine: { silent: true, symbol: "none", data: [
          { yAxis: 25, lineStyle: { color: "#f85149", type: "dashed", width: 1 }, label: { show: !mob(), formatter: "恐懼25", color: "#f85149", fontSize: 9, position: "start" } },
          { yAxis: 75, lineStyle: { color: "#3fb950", type: "dashed", width: 1 }, label: { show: !mob(), formatter: "貪婪75", color: "#3fb950", fontSize: 9, position: "start" } },
        ] } },
      { name: "VIX", type: "line", xAxisIndex: 1, yAxisIndex: 2, data: vix, symbol: "none",
        lineStyle: { color: C.vix, width: 1, opacity: 0.85 } },
      { name: "看多", type: "line", xAxisIndex: 2, yAxisIndex: 3, data: bull, symbol: "none", lineStyle: { color: C.bull, width: 1.4 } },
      { name: "中立", type: "line", xAxisIndex: 2, yAxisIndex: 3, data: neut, symbol: "none", lineStyle: { color: C.neutral, width: 1, type: "dashed" } },
      { name: "看空", type: "line", xAxisIndex: 2, yAxisIndex: 3, data: bear, symbol: "none", lineStyle: { color: C.bear, width: 1.4 } },
      { name: "看多−看空", type: "line", xAxisIndex: 3, yAxisIndex: 4, data: net, symbol: "none",
        lineStyle: { color: C.net, width: 1.5 },
        areaStyle: { origin: "auto", color: "rgba(227,179,65,0.15)" },
        markLine: { silent: true, symbol: "none", data: [
          { yAxis: 0, lineStyle: { color: axCl, type: "dashed", width: 1 }, label: { show: !mob(), formatter: "0", color: axCl, fontSize: 9, position: "start" } },
        ] } },
    ],
    dataZoom: [
      { type: "inside", xAxisIndex: [0, 1, 2, 3] },
      { type: "slider", xAxisIndex: [0, 1, 2, 3], height: 16, bottom: 6,
        fillerColor: "rgba(88,166,255,0.1)", borderColor: tc("#30363d", "#d0d7de") },
    ],
  }, true);
}

function renderTable() {
  const from = fromDate();
  const rows = (from ? aaii.data.filter(r => r.date >= from) : aaii.data).slice().reverse();
  const thead = document.getElementById("aaii-thead");
  const tbody = document.getElementById("aaii-tbody");
  thead.innerHTML = `<tr>
    <th>日期</th><th>看多</th><th>中立</th><th>看空</th><th>淨看多</th><th>CNN F&G</th><th>VIX</th><th>S&P 500</th></tr>`;
  const num = (v, suf = "") => v == null ? `<span style="color:var(--muted)">—</span>` : v.toFixed(suf === "%" ? 1 : (suf === "$" ? 2 : 0)) + (suf === "%" ? "%" : "");
  tbody.innerHTML = rows.map(r => {
    const fg = lookupLE(fgArr, r.date), vix = lookupLE(vixArr, r.date), spy = lookupLE(spArr, r.date);
    return `<tr>
      <td>${r.date}</td>
      <td style="color:${C.bull}">${r.bull.toFixed(1)}</td>
      <td>${r.neutral.toFixed(1)}</td>
      <td style="color:${C.bear}">${r.bear.toFixed(1)}</td>
      <td class="${r.spread >= 0 ? "pos" : "neg"}" style="font-weight:600">${r.spread >= 0 ? "+" : ""}${r.spread.toFixed(1)}</td>
      <td>${fg ? Math.round(fg[1]) : "<span style='color:var(--muted)'>—</span>"}</td>
      <td>${vix ? vix[1].toFixed(1) : "<span style='color:var(--muted)'>—</span>"}</td>
      <td>${spy ? spy[1].toLocaleString("en-US", { maximumFractionDigits: 0 }) : "<span style='color:var(--muted)'>—</span>"}</td>
    </tr>`;
  }).join("");
  document.getElementById("aaii-table-count").textContent = `${rows.length} 週`;
}

export function onThemeChange(light) {
  if (aaiiChart) {
    aaiiChart.dispose();
    aaiiChart = echarts.init(document.getElementById("aaii-chart"), light ? null : "dark");
    renderChart();
  }
}

export function resize() { aaiiChart?.resize(); }
