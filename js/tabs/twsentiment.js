// 台股情緒 tab — 台股恐懼貪婪指數 (P/C + 散戶多空 + 趨勢 + 融資 合成) + 加權指數參照
// + 原始元件面板：選擇權 P/C ratio / 台指期散戶多空+外資 / 大盤融資餘額。
import { isLight, tc, mob, PALETTE } from '../utils/theme.js';
import { tsToLocalDate } from '../utils/dates.js';

let chart = null, gauge = null, mcChart = null, basisChart = null, chipsChart = null, forcedChart = null;
let sent = null;            // taiwan_sentiment.json
let twii = null, pc = null, fut = null, mar = null, mr = null;   // raw component arrays (mr=融資維持率[[date,ratio]])
let mcData = null;          // taiwan_margin_mktcap.json: {data:[{date,ratio,...}], k_billion_per_point, ...}
let basisData = null;       // taiwan_basis.json: {data:[{date,futures,spot,basis,basis_pct,contract}], ...}
let tdccData = null;        // tdcc_holders.json: {data:{"0050":[{date,holders}],"00631L":[...],"00675L":[...]}}
let daytradeData = null;    // tw_daytrading.json: {data:[{date,shares_ratio,amount,amount_ratio}], skip_dates}
let rangePreset = "5Y";

const C = {
  twii: "#58a6ff", comp: "#f778ba", pcv: "#f0883e", pco: "#d2a8ff",
  retail: "#3fb950", foreign: "#f85149", margin: "#e3b341", maint: "#7ee787",
  mcap: "#a371f7",
  h631: "#ffa657", h675: "#f85149", dtDaily: "#58a6ff", dtMA: "#f778ba",
  shortDaily: "#3fb950", shortMA: "#e3b341",
};

// 簡單移動平均, rows=[[date,value],...] 升冪, 回傳同長度陣列 (前 window-1 筆為 null)
function movingAvg(rows, window) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    if (i < window - 1) { out.push([rows[i][0], null]); continue; }
    let sum = 0, n = 0;
    for (let j = i - window + 1; j <= i; j++) {
      const v = rows[j][1];
      if (v != null) { sum += v; n++; }
    }
    out.push([rows[i][0], n ? sum / n : null]);
  }
  return out;
}

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
    mr   = [];                                  // 融資維持率(重建)，TWSE 回補中可能僅近期
    try {
      const rr = await fetch("data/taiwan_margin_ratio.json");
      if (rr.ok) mr = ((await rr.json()).data || []).map(r => [r.date, r.ratio]);
    } catch { /* optional — 缺檔不影響其他元件 */ }

    try {
      const mc = await fetch("data/taiwan_margin_mktcap.json");
      if (mc.ok) mcData = await mc.json();
    } catch { /* optional — 缺檔則隱藏該 section */ }

    try { const rb = await fetch("data/taiwan_basis.json"); if (rb.ok) basisData = (await rb.json()).data || null; } catch (e) {}

    try { const rt = await fetch("data/tdcc_holders.json"); if (rt.ok) tdccData = await rt.json(); } catch (e) { /* optional — 缺檔則該序列不畫 */ }
    try { const rd = await fetch("data/tw_daytrading.json"); if (rd.ok) daytradeData = await rd.json(); } catch (e) { /* optional — 缺檔則該序列不畫 */ }

    document.querySelectorAll("[data-twsent-range]").forEach(el =>
      el.addEventListener("click", () => {
        rangePreset = el.dataset.twsentRange;
        document.querySelectorAll("[data-twsent-range]").forEach(e =>
          e.classList.toggle("active", e.dataset.twsentRange === rangePreset));
        renderChart(); renderTable(); renderForced(); renderMktcap(); renderBasis(); renderChips();
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
  // check_reuse: keep — 本地 range cutoff 變體:preset key 集合/MAX 哨兵/未命中預設與 dates.presetStart、dates.cutoffDate 皆不同,換過去會改行為
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
  renderForced();
  renderMktcap();
  renderBasis();
  renderChips();
}

// 韓式「融資水位 × 斷頭壓力」雙格:上=融資餘額+加權(背離),下=融資維持率(斷頭壓力代理)
// 卡片=自可視範圍加權指數波段高點起,指數跌幅 vs 融資餘額降幅(洗乾淨了嗎)
function renderForced() {
  const cardEl = document.getElementById("twsent-forced-card");
  const chartEl = document.getElementById("twsent-forced-chart");
  if (!cardEl || !chartEl) return;

  const from = fromDate();
  const fil = arr => from ? arr.filter(r => (r[0] ?? r.date) >= from) : arr;
  const mgn = fil(mar).map(r => [r.date, r.margin_money]);   // 融資餘額(億)
  const twS = fil(twii);                                     // 加權指數
  const mrt = mr ? fil(mr) : [];                             // 融資維持率(重建)

  if (!mgn.length || !twS.length) {
    cardEl.innerHTML = `<div style="color:var(--muted);font-size:12px">所選範圍內無融資/加權資料</div>`;
    return;
  }

  // 卡片:找可視範圍內加權指數波段高點 → 算 指數與融資 自高點至今的降幅
  let peakIdx = 0;
  for (let i = 1; i < twS.length; i++) if (twS[i][1] > twS[peakIdx][1]) peakIdx = i;
  const peakDate = twS[peakIdx][0];
  const twPeak = twS[peakIdx][1], twNow = twS.at(-1)[1];
  const twDrop = (twNow / twPeak - 1) * 100;                 // 指數自高點 %
  // 融資餘額:取 peakDate 當日(或之後最近)一筆為基準
  const mgnAtPeak = mgn.find(r => r[0] >= peakDate);
  const mgnBase = mgnAtPeak ? mgnAtPeak[1] : mgn[0][1];
  const mgnNow = mgn.at(-1)[1];
  const mgnDrop = (mgnNow / mgnBase - 1) * 100;              // 融資自高點 %
  // 「沒洗乾淨」訊號:指數明顯跌、融資卻幾乎沒降
  const dirty = twDrop <= -8 && mgnDrop > twDrop / 2;
  const mrLat = mrt.length ? mrt.at(-1) : null;

  const dropSpan = (v, inv) => {
    const bad = inv ? v > -3 : false;   // 融資降幅太小=壞(紅);指數跌本身用綠紅視覺
    const col = v >= 0 ? "#f85149" : "#3fb950";
    return `<span style="color:${col};font-weight:700">${v >= 0 ? "+" : ""}${v.toFixed(1)}%</span>`;
  };
  cardEl.innerHTML =
    `<span style="color:var(--muted);font-size:12px">自波段高 ${peakDate} 起</span>
     <span style="font-size:13px;margin-left:10px">加權 ${dropSpan(twDrop)}</span>
     <span style="color:var(--muted)">·</span>
     <span style="font-size:13px">融資餘額 ${dropSpan(mgnDrop, true)}</span>
     ${mrLat ? `<span style="color:var(--muted)">·</span><span style="font-size:13px">維持率 <b style="color:${C.maint}">${mrLat[1].toFixed(0)}%</b></span>` : ""}
     <span style="margin-left:12px;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;
       background:${dirty ? "rgba(248,81,73,0.15)" : "rgba(63,185,80,0.15)"};
       color:${dirty ? "#f85149" : "#3fb950"}">
       ${dirty ? "⚠ 指數跌、融資未降 → 籌碼未洗清" : "融資隨指數同步收縮"}</span>
     <div style="margin-top:5px;color:var(--muted);font-size:11px;line-height:1.45">
       融資維持率＝玩股網式(融資現值 ÷ 放款金額);含/扣 ETF 幾乎相同(≈180%,因 ETF 與個股維持率此刻近乎一致)。
       M平方 159% 係<b>不同公式、非同口徑</b>,勿跨家比絕對值——此線非券商整戶維持率,勿貼 130% 追繳線,看<b>相對位階與有無翻頭</b>即可。</div>`;

  if (!forcedChart) {
    forcedChart = echarts.init(chartEl, isLight() ? null : "dark");
    window.addEventListener("resize", () => forcedChart && forcedChart.resize());
  }

  const xmin = from || mgn[0][0];
  const xmax = [twS.at(-1)[0], mgn.at(-1)[0]].sort().at(-1);
  const tipBg = PALETTE.bg, tipBdr = PALETTE.border;
  const tipTx = PALETTE.text, axCl = PALETTE.muted;
  const gridCl = tc("rgba(48,54,61,0.5)", "rgba(208,215,222,0.4)");
  const hasMr = mrt.length > 0;
  const xAx = i => ({ type: "time", gridIndex: i, min: xmin, max: xmax,
    axisLabel: { show: i === (hasMr ? 1 : 0), color: axCl, fontSize: 11 },
    axisLine: { lineStyle: { color: gridCl } }, splitLine: { show: false } });

  forcedChart.setOption({
    backgroundColor: "transparent", animation: false,
    axisPointer: { link: [{ xAxisIndex: "all" }], label: { backgroundColor: axCl } },
    legend: { top: 4, left: "center", textStyle: { color: axCl, fontSize: 11 },
      itemWidth: mob() ? 14 : 25, itemGap: mob() ? 8 : 16,
      data: ["融資餘額", "加權指數"].concat(hasMr ? ["融資維持率"] : []) },
    tooltip: { trigger: "axis", backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: tipTx, fontSize: 12 },
      formatter: params => {
        if (!params.length) return "";
        let html = `<b>${tsToLocalDate(params[0].axisValue)}</b><br/>`;
        for (const p of params) {
          const v = p.value?.[1]; if (v == null) continue;
          let s;
          if (p.seriesName === "融資餘額") s = v.toLocaleString("en-US", { maximumFractionDigits: 0 }) + " 億";
          else if (p.seriesName === "加權指數") s = v.toLocaleString("en-US", { maximumFractionDigits: 0 });
          else s = v.toFixed(1) + "%";
          html += `<span style="color:${p.color}">● ${p.seriesName}: <b>${s}</b></span><br/>`;
        }
        return html;
      } },
    grid: hasMr ? [
      { left: mob() ? 52 : 66, right: mob() ? 52 : 64, top: mob() ? 52 : 36, height: "44%" },
      { left: mob() ? 52 : 66, right: mob() ? 52 : 64, top: "68%", height: "24%" },
    ] : [
      { left: mob() ? 52 : 66, right: mob() ? 52 : 64, top: mob() ? 52 : 36, bottom: 40 },
    ],
    xAxis: hasMr ? [xAx(0), xAx(1)] : [xAx(0)],
    yAxis: [
      { type: "value", gridIndex: 0, scale: true, name: "融資億", nameTextStyle: { color: C.margin, fontSize: 10 },
        axisLabel: { color: C.margin, fontSize: 10 }, splitLine: { lineStyle: { color: gridCl } } },
      { type: "value", gridIndex: 0, scale: true, position: "right", name: "加權", nameTextStyle: { color: C.twii, fontSize: 10 },
        axisLabel: { color: C.twii, fontSize: 10 }, splitLine: { show: false } },
    ].concat(hasMr ? [
      { type: "value", gridIndex: 1, scale: true, name: "維持率%", nameTextStyle: { color: C.maint, fontSize: 10 },
        axisLabel: { color: C.maint, fontSize: 10 }, splitLine: { lineStyle: { color: gridCl } } },
    ] : []),
    series: [
      { name: "融資餘額", type: "line", xAxisIndex: 0, yAxisIndex: 0, data: mgn, symbol: "none",
        lineStyle: { color: C.margin, width: 1.8 },
        areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [{ offset: 0, color: "rgba(227,179,65,0.22)" }, { offset: 1, color: "rgba(227,179,65,0.02)" }] } },
        markLine: { silent: true, symbol: "none", data: [
          { xAxis: peakDate, lineStyle: { color: axCl, type: "dashed", width: 1 },
            label: { show: !mob(), formatter: "波段高", color: axCl, fontSize: 10, position: "insideEndTop" } },
        ] } },
      { name: "加權指數", type: "line", xAxisIndex: 0, yAxisIndex: 1, data: twS, symbol: "none",
        lineStyle: { color: C.twii, width: 1.4 } },
    ].concat(hasMr ? [
      { name: "融資維持率", type: "line", xAxisIndex: 1, yAxisIndex: 2, data: mrt, symbol: "none",
        lineStyle: { color: C.maint, width: 1.6 },
        areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [{ offset: 0, color: "rgba(126,231,135,0.18)" }, { offset: 1, color: "rgba(126,231,135,0.02)" }] } },
        markPoint: { symbol: "circle", symbolSize: 8, data: (mrLat ? [{
          coord: [mrLat[0], mrLat[1]],
          itemStyle: { color: C.maint, borderColor: PALETTE.cellBorder, borderWidth: 2 },
          label: { formatter: `${mrLat[1].toFixed(0)}%`, position: "top", color: C.maint, fontSize: 11, fontWeight: 600 },
        }] : []) } },
    ] : []),
    dataZoom: [
      { type: "inside", xAxisIndex: hasMr ? [0, 1] : [0] },
      { type: "slider", xAxisIndex: hasMr ? [0, 1] : [0], height: 16, bottom: 6,
        fillerColor: "rgba(88,166,255,0.1)", borderColor: PALETTE.border },
    ],
  }, true);
}

function renderMktcap() {
  const cardEl = document.getElementById("twsent-mktcap-card");
  const chartEl = document.getElementById("twsent-mktcap-chart");
  if (!cardEl || !chartEl) return;
  if (!mcData || !mcData.data || !mcData.data.length) {
    cardEl.innerHTML = `<div style="color:var(--muted);font-size:12px">無資料（taiwan_margin_mktcap.json 未產生）</div>`;
    return;
  }
  const allRows = mcData.data;
  const from = fromDate();
  const rows = from ? allRows.filter(r => r.date >= from) : allRows;
  if (!rows.length) {
    cardEl.innerHTML = `<div style="color:var(--muted);font-size:12px">所選範圍內無資料</div>`;
    return;
  }
  const latest = allRows.at(-1);   // card 永遠秀最新一筆 (不被範圍篩掉)
  const prev = allRows.length > 20 ? allRows.at(-21) : null;
  const chg = prev ? latest.ratio - prev.ratio : null;
  const chgStr = chg == null ? "" :
    `<span style="color:${chg >= 0 ? "#f85149" : "#3fb950"};font-size:12px;margin-left:8px">
      ${chg >= 0 ? "▲ +" : "▼ "}${chg.toFixed(2)} 近月</span>`;
  cardEl.innerHTML =
    `<span style="color:var(--muted);font-size:12px">最新</span>
     <span style="font-size:22px;font-weight:700;color:${C.mcap};margin-left:8px">
       ${latest.ratio.toFixed(2)} ‰</span>
     <span style="color:var(--muted);font-size:12px;margin-left:8px">${latest.date}</span>
     ${chgStr}
     <span style="color:var(--muted);font-size:12px;margin-left:14px">
       融資 ${latest.margin_billion.toLocaleString("en-US", { maximumFractionDigits: 0 })} 億 ÷ 上市市值估 ${latest.mktcap_billion_est.toLocaleString("en-US", { maximumFractionDigits: 0 })} 億</span>`;

  if (!mcChart) {
    mcChart = echarts.init(chartEl, isLight() ? null : "dark");
    window.addEventListener("resize", () => mcChart && mcChart.resize());
  }
  const series = rows.map(r => [r.date, r.ratio]);
  const tipBg = PALETTE.bg, tipBdr = PALETTE.border;
  const tipTx = PALETTE.text, axCl = PALETTE.muted;
  const gridCl = tc("rgba(48,54,61,0.5)", "rgba(208,215,222,0.4)");
  mcChart.setOption({
    backgroundColor: "transparent", animation: false,
    grid: { left: mob() ? 44 : 56, right: mob() ? 14 : 28, top: 18, bottom: 30 },
    tooltip: {
      trigger: "axis", backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: tipTx, fontSize: 12 },
      formatter: params => {
        if (!params.length) return "";
        const p = params[0]; const v = p.value?.[1];
        return `<b>${tsToLocalDate(p.axisValue)}</b><br/>
          <span style="color:${p.color}">● ${p.seriesName}: <b>${v.toFixed(2)} ‰</b></span>`;
      },
    },
    xAxis: { type: "time", axisLabel: { color: axCl, fontSize: 11 },
      axisLine: { lineStyle: { color: gridCl } }, splitLine: { show: false } },
    yAxis: { type: "value", scale: true, name: "‰", nameTextStyle: { color: axCl, fontSize: 10 },
      axisLabel: { color: axCl, fontSize: 10 }, splitLine: { lineStyle: { color: gridCl } } },
    series: [{
      name: "融資/市值", type: "line", data: series, symbol: "none",
      lineStyle: { color: C.mcap, width: 1.8 },
      areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1,
        colorStops: [{ offset: 0, color: "rgba(163,113,247,0.22)" }, { offset: 1, color: "rgba(163,113,247,0.02)" }] } },
      markLine: { silent: true, symbol: "none", data: [
        { yAxis: 5.0, lineStyle: { color: "#f85149", type: "dashed", width: 1.4 },
          label: { formatter: "2021高點 5.0", color: "#f85149", fontSize: 11, position: "insideEndTop" } },
      ] },
      markPoint: { symbol: "circle", symbolSize: 9, data: (rows.includes(latest) ? [{
        coord: [latest.date, latest.ratio],
        itemStyle: { color: C.mcap, borderColor: PALETTE.cellBorder, borderWidth: 2 },
        label: { formatter: `${latest.ratio.toFixed(2)} ‰`, position: "top", color: C.mcap, fontSize: 11, fontWeight: 600 },
      }] : []) },
    }],
  }, true);
}

function renderBasis() {
  const cardEl = document.getElementById("twsent-basis-card");
  const chartEl = document.getElementById("twsent-basis-chart");
  if (!cardEl || !chartEl) return;
  if (!basisData || !basisData.length) {
    cardEl.innerHTML = `<div style="color:var(--muted);font-size:12px">無資料（taiwan_basis.json 未產生）</div>`;
    return;
  }
  const from = fromDate();
  const rows = from ? basisData.filter(r => r.date >= from) : basisData;
  if (!rows.length) {
    cardEl.innerHTML = `<div style="color:var(--muted);font-size:12px">所選範圍內無資料</div>`;
    return;
  }
  const latest = basisData.at(-1);   // card 永遠秀最新一筆 (不被範圍篩掉)
  const basisColor = latest.basis < 0 ? "#f85149" : "#3fb950";
  const basisKind = latest.basis < 0 ? "逆價差" : "正價差";
  cardEl.innerHTML =
    `<span style="color:var(--muted);font-size:12px">最新</span>
     <span style="font-size:22px;font-weight:700;color:${basisColor};margin-left:8px">
       ${latest.basis >= 0 ? "+" : ""}${latest.basis.toFixed(1)} 點</span>
     <span style="color:${basisColor};font-size:13px;margin-left:6px">（${basisKind}）</span>
     <span style="color:var(--muted);font-size:12px;margin-left:8px">${latest.date}</span>
     <span style="color:var(--muted);font-size:12px;margin-left:14px">
       近月 ${latest.contract} · ${latest.basis_pct >= 0 ? "+" : ""}${latest.basis_pct.toFixed(2)}%</span>`;

  if (!basisChart) {
    basisChart = echarts.init(chartEl, isLight() ? null : "dark");
    window.addEventListener("resize", () => basisChart && basisChart.resize());
  }
  const series = rows.map(r => [r.date, r.basis]);
  const contractMap = Object.fromEntries(rows.map(r => [r.date, r.contract]));
  const tipBg = PALETTE.bg, tipBdr = PALETTE.border;
  const tipTx = PALETTE.text, axCl = PALETTE.muted;
  const gridCl = tc("rgba(48,54,61,0.5)", "rgba(208,215,222,0.4)");
  basisChart.setOption({
    backgroundColor: "transparent", animation: false,
    grid: { left: mob() ? 44 : 56, right: mob() ? 14 : 28, top: 18, bottom: 30 },
    tooltip: {
      trigger: "axis", backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: tipTx, fontSize: 12 },
      formatter: params => {
        if (!params.length) return "";
        const p = params[0]; const v = p.value?.[1]; const d = tsToLocalDate(p.axisValue);
        const ct = contractMap[d] || "";
        return `<b>${d}</b><br/>
          <span style="color:${p.color}">● ${p.seriesName}: <b>${v >= 0 ? "+" : ""}${v.toFixed(1)} 點</b></span>
          <span style="color:${tipTx};font-size:11px"> · 近月 ${ct}</span>`;
      },
    },
    xAxis: { type: "time", axisLabel: { color: axCl, fontSize: 11 },
      axisLine: { lineStyle: { color: gridCl } }, splitLine: { show: false } },
    yAxis: { type: "value", scale: true, name: "點", nameTextStyle: { color: axCl, fontSize: 10 },
      axisLabel: { color: axCl, fontSize: 10 }, splitLine: { lineStyle: { color: gridCl } } },
    series: [{
      name: "基差", type: "line", data: series, symbol: "none",
      lineStyle: { color: C.margin, width: 1.5 },
      markLine: { silent: true, symbol: "none", data: [
        { yAxis: 0, lineStyle: { color: axCl, type: "dashed", width: 1.2 },
          label: { formatter: "0", color: axCl, fontSize: 10, position: "insideEndTop" } },
      ] },
      markPoint: { symbol: "circle", symbolSize: 9, data: (rows.includes(latest) ? [{
        coord: [latest.date, latest.basis],
        itemStyle: { color: basisColor, borderColor: PALETTE.cellBorder, borderWidth: 2 },
        label: { formatter: `${latest.basis >= 0 ? "+" : ""}${latest.basis.toFixed(1)}`, position: "top", color: basisColor, fontSize: 11, fontWeight: 600 },
      }] : []) },
    }],
  }, true);
}

// 散戶籌碼:槓桿ETF受益人數(00631L/00675L,週頻) + 當沖占比(日值+20日均) + 融券餘額(原值+20日均)
// 三 grid 直排,獨立參考,未併入恐懼貪婪合成分數 (compute_taiwan_sentiment.py 不碰)
function renderChips() {
  const chartEl = document.getElementById("twsent-chips-chart");
  if (!chartEl) return;
  if (!chipsChart) {
    chipsChart = echarts.init(chartEl, isLight() ? null : "dark");
    window.addEventListener("resize", () => chipsChart && chipsChart.resize());
  }

  const from = fromDate();
  const fil = arr => from ? arr.filter(r => r[0] >= from) : arr;

  const h631All = ((tdccData?.data?.["00631L"]) || []).map(r => [r.date, r.holders]);
  const h675All = ((tdccData?.data?.["00675L"]) || []).map(r => [r.date, r.holders]);
  const dtAll = (daytradeData?.data || []).map(r => [r.date, r.shares_ratio]);
  const dtMAAll = movingAvg(dtAll, 20);
  const shortAll = mar.filter(r => r.short_lots != null).map(r => [r.date, r.short_lots]);
  const shortMAAll = movingAvg(shortAll, 20);

  const h631 = fil(h631All), h675 = fil(h675All);
  const dt = fil(dtAll), dtMA = fil(dtMAAll);
  const short = fil(shortAll), shortMA = fil(shortMAAll);

  const allDates = [h631, h675, dt, short].flat().map(r => r[0]);
  if (!allDates.length) return;
  const xmin = from || allDates.reduce((a, b) => (a < b ? a : b));
  const xmax = allDates.reduce((a, b) => (a > b ? a : b));

  const tipBg = PALETTE.bg, tipBdr = PALETTE.border;
  const tipTx = PALETTE.text, axCl = PALETTE.muted;
  const gridCl = tc("rgba(48,54,61,0.5)", "rgba(208,215,222,0.4)");
  const xAx = i => ({ type: "time", gridIndex: i, min: xmin, max: xmax,
    axisLabel: { show: i === 2, color: axCl, fontSize: 11 }, axisLine: { lineStyle: { color: gridCl } }, splitLine: { show: false } });

  chipsChart.setOption({
    backgroundColor: "transparent", animation: false,
    axisPointer: { link: [{ xAxisIndex: "all" }], label: { backgroundColor: axCl } },
    legend: { top: 6, left: "center", textStyle: { color: axCl, fontSize: 11 }, itemWidth: mob() ? 14 : 25, itemGap: mob() ? 8 : 16,
      data: ["00631L受益人數", "00675L受益人數", "當沖占比(日)", "當沖占比20日均", "融券餘額(張)", "融券20日均"] },
    tooltip: { trigger: "axis", backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: tipTx, fontSize: 12 },
      formatter: params => {
        if (!params.length) return "";
        let html = `<b>${tsToLocalDate(params[0].axisValue)}</b><br/>`;
        for (const p of params) {
          const v = p.value?.[1]; if (v == null) continue;
          let s;
          if (p.seriesName.includes("受益人數")) s = v.toLocaleString("en-US");
          else if (p.seriesName.includes("當沖")) s = v.toFixed(1) + "%";
          else s = v.toLocaleString("en-US") + " 張";
          html += `<span style="color:${p.color}">● ${p.seriesName}: <b>${s}</b></span><br/>`;
        }
        return html;
      } },
    grid: [
      { left: mob() ? 48 : 64, right: mob() ? 20 : 30, top: mob() ? 60 : 40, height: mob() ? "22%" : "23%" },
      { left: mob() ? 48 : 64, right: mob() ? 20 : 30, top: "42%", height: mob() ? "20%" : "21%" },
      { left: mob() ? 48 : 64, right: mob() ? 20 : 30, top: "76%", height: mob() ? "20%" : "21%" },
    ],
    xAxis: [xAx(0), xAx(1), xAx(2)],
    yAxis: [
      { type: "value", gridIndex: 0, scale: true, name: "人數", nameTextStyle: { color: axCl, fontSize: 10 }, axisLabel: { color: axCl, fontSize: 10 }, splitLine: { lineStyle: { color: gridCl } } },
      { type: "value", gridIndex: 1, scale: true, name: "%", nameTextStyle: { color: axCl, fontSize: 10 }, axisLabel: { color: axCl, fontSize: 10 }, splitLine: { lineStyle: { color: gridCl } } },
      { type: "value", gridIndex: 2, scale: true, name: "張", nameTextStyle: { color: axCl, fontSize: 10 }, axisLabel: { color: axCl, fontSize: 10 }, splitLine: { lineStyle: { color: gridCl } } },
    ],
    series: [
      { name: "00631L受益人數", type: "line", xAxisIndex: 0, yAxisIndex: 0, data: h631, symbol: "none", itemStyle: { color: C.h631 }, lineStyle: { color: C.h631, width: 1.5 } },
      { name: "00675L受益人數", type: "line", xAxisIndex: 0, yAxisIndex: 0, data: h675, symbol: "none", itemStyle: { color: C.h675 }, lineStyle: { color: C.h675, width: 1.5 } },
      { name: "當沖占比(日)", type: "line", xAxisIndex: 1, yAxisIndex: 1, data: dt, symbol: "none", itemStyle: { color: C.dtDaily }, lineStyle: { color: C.dtDaily, width: 0.8, opacity: 0.45 } },
      { name: "當沖占比20日均", type: "line", xAxisIndex: 1, yAxisIndex: 1, data: dtMA, symbol: "none", connectNulls: true, itemStyle: { color: C.dtMA }, lineStyle: { color: C.dtMA, width: 1.6 } },
      { name: "融券餘額(張)", type: "line", xAxisIndex: 2, yAxisIndex: 2, data: short, symbol: "none", itemStyle: { color: C.shortDaily }, lineStyle: { color: C.shortDaily, width: 0.8, opacity: 0.45 } },
      { name: "融券20日均", type: "line", xAxisIndex: 2, yAxisIndex: 2, data: shortMA, symbol: "none", connectNulls: true, itemStyle: { color: C.shortMA }, lineStyle: { color: C.shortMA, width: 1.6 } },
    ],
    dataZoom: [
      { type: "inside", xAxisIndex: [0, 1, 2] },
      { type: "slider", xAxisIndex: [0, 1, 2], height: 16, bottom: 6, fillerColor: "rgba(88,166,255,0.1)", borderColor: PALETTE.border },
    ],
  }, true);
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
  const mrLat = mr && mr.length ? mr.at(-1) : null;
  const mrPrev = mr && mr.length > 20 ? mr.at(-21)[1] : null;     // ~1個月(20交易日)前
  const mrChg = mrLat && mrPrev != null ? mrLat[1] - mrPrev : null;
  document.getElementById("twsent-cards").innerHTML =
    card("加權指數", tw[1].toLocaleString("en-US", { maximumFractionDigits: 0 }), tw[0], C.twii) +
    card("選擇權 P/C 成交量比", p.vol_pc.toFixed(1), `${p.date}`, C.pcv) +
    card("散戶淨多 (口)", (f.retail_net >= 0 ? "+" : "") + f.retail_net.toLocaleString("en-US"), `外資 ${f.foreign_net.toLocaleString("en-US")}`, f.retail_net >= 0 ? C.retail : C.foreign) +
    card("大盤融資餘額 (億)", m.margin_money.toLocaleString("en-US", { maximumFractionDigits: 0 }), m.date, C.margin) +
    (mrLat ? card("融資維持率 (重建)", mrLat[1].toFixed(0) + "%",
        (mrChg != null ? (mrChg >= 0 ? "▲ +" : "▼ ") + mrChg.toFixed(0) + " 近月" : mrLat[0]) + " · 擔保品÷融資",
        mrChg == null ? C.maint : (mrChg >= 0 ? C.maint : C.foreign)) : "");
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
  const mrt = mr ? fil(mr) : [];

  const xmin = from || sent.data[0].date;
  const xmax = [twii.at(-1)[0], sent.data.at(-1).date].sort().at(-1);

  const tipBg = PALETTE.bg, tipBdr = PALETTE.border;
  const tipTx = PALETTE.text, axCl = PALETTE.muted;
  const gridCl = tc("rgba(48,54,61,0.5)", "rgba(208,215,222,0.4)");
  const xAx = i => ({ type: "time", gridIndex: i, min: xmin, max: xmax,
    axisLabel: { show: i === 3, color: axCl, fontSize: 11 }, axisLine: { lineStyle: { color: gridCl } }, splitLine: { show: false } });

  chart.setOption({
    backgroundColor: "transparent", animation: false,
    axisPointer: { link: [{ xAxisIndex: "all" }], label: { backgroundColor: axCl } },
    legend: { top: 6, left: "center", textStyle: { color: axCl, fontSize: 11 }, itemWidth: mob() ? 14 : 25, itemGap: mob() ? 8 : 16,
      data: ["加權指數", "恐懼貪婪", "P/C 成交量比", "P/C 未平倉比", "散戶淨多", "外資淨", "融資餘額", "融資維持率"], selected: { "P/C 未平倉比": false } },
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
          else if (p.seriesName === "融資維持率") s = v.toFixed(1) + "%";
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
      { type: "value", gridIndex: 3, scale: true, position: "right", name: "維持率%", nameTextStyle: { color: C.maint, fontSize: 10 }, axisLabel: { color: C.maint, fontSize: 10 }, splitLine: { show: false } },
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
      { name: "融資維持率", type: "line", xAxisIndex: 3, yAxisIndex: 5, data: mrt, symbol: "none", lineStyle: { color: C.maint, width: 1.4 } },
    ],
    dataZoom: [
      { type: "inside", xAxisIndex: [0, 1, 2, 3] },
      { type: "slider", xAxisIndex: [0, 1, 2, 3], height: 16, bottom: 6, fillerColor: "rgba(88,166,255,0.1)", borderColor: PALETTE.border },
    ],
  }, true);
}

function renderTable() {
  const from = fromDate();
  const rows = (from ? sent.data.filter(r => r.date >= from) : sent.data).slice().reverse();
  const pcMap = Object.fromEntries(pc.map(r => [r.date, r]));
  const futMap = Object.fromEntries(fut.map(r => [r.date, r]));
  const marMap = Object.fromEntries(mar.map(r => [r.date, r]));
  const mrMap = Object.fromEntries(mr || []);
  const twMap = Object.fromEntries(twii);
  document.getElementById("twsent-thead").innerHTML =
    `<tr><th>日期</th><th>恐懼貪婪</th><th>P/C量比</th><th>散戶淨多</th><th>外資淨</th><th>融資(億)</th><th>維持率</th><th>加權</th></tr>`;
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
      <td style="color:${C.maint}">${mrMap[r.date] != null ? mrMap[r.date].toFixed(0) + "%" : muted}</td>
      <td>${tw ? tw.toLocaleString("en-US", { maximumFractionDigits: 0 }) : muted}</td>
    </tr>`;
  }).join("");
  document.getElementById("twsent-table-count").textContent = `${rows.length} 日`;
}

export function onThemeChange(light) {
  if (chart) { chart.dispose(); chart = echarts.init(document.getElementById("twsent-chart"), light ? null : "dark"); renderChart(); }
  if (gauge) { gauge.dispose(); gauge = echarts.init(document.getElementById("twsent-gauge"), light ? null : "dark"); renderGauge(sent.latest.composite); }
  if (forcedChart) { forcedChart.dispose(); forcedChart = null; renderForced(); }
  if (mcChart) { mcChart.dispose(); mcChart = null; renderMktcap(); }
  if (basisChart) { basisChart.dispose(); basisChart = null; renderBasis(); }
  if (chipsChart) { chipsChart.dispose(); chipsChart = null; renderChips(); }
}

export function resize() { chart?.resize(); gauge?.resize(); forcedChart?.resize(); mcChart?.resize(); basisChart?.resize(); chipsChart?.resize(); }
