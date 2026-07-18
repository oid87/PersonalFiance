import { isLight, tc, mob, PALETTE } from '../utils/theme.js';
import { tsToLocalDate } from '../utils/dates.js';

let sentChart       = null;
let sentGaugeChart  = null;
let sentData        = null;
let sentRangePreset = "5Y";

export async function init() {
  const status = document.getElementById("sent-status");
  if (sentData) { renderSentimentTab(); return; }
  status.textContent = "載入中…";
  try {
    const [sResp, spyResp, fgResp] = await Promise.all([
      fetch("data/sentiment.json"),
      fetch("data/SPY.json"),
      fetch("data/fear_greed.json"),
    ]);
    sentData = await sResp.json();
    const spyJson = await spyResp.json();
    const fgJson  = await fgResp.json();
    sentData._spy = {};
    for (const r of spyJson.data) sentData._spy[r.date] = r.close;
    sentData._fg = {};
    for (const r of fgJson.data) sentData._fg[r.date] = r.value;

    document.querySelectorAll("[data-sent-range]").forEach(el => {
      el.addEventListener("click", () => {
        sentRangePreset = el.dataset.sentRange;
        document.querySelectorAll("[data-sent-range]").forEach(e =>
          e.classList.toggle("active", e.dataset.sentRange === sentRangePreset));
        renderSentimentChart();
      });
    });

    renderSentimentTab();
    status.textContent = `已載入 ${sentData.data.length} 日資料 · 更新至 ${sentData.updated}`;
  } catch (err) {
    status.textContent = `載入失敗：${err.message}`;
  }
}

function sentLabel(v) {
  if (v < 20) return "極度恐懼";
  if (v < 40) return "恐懼";
  if (v < 60) return "中性";
  if (v < 80) return "貪婪";
  return "極度貪婪";
}

function sentColor(v) {
  if (v < 20) return "#ef4444";
  if (v < 40) return "#f97316";
  if (v < 60) return "#eab308";
  if (v < 80) return "#22c55e";
  return "#16a34a";
}

function renderSentimentTab() {
  const lat = sentData.latest;
  document.getElementById("sent-score-label").textContent = sentLabel(lat.composite);
  document.getElementById("sent-score-label").style.color = sentColor(lat.composite);
  document.getElementById("sent-updated").textContent = `資料截至 ${lat.date}`;

  function setBar(id, val) {
    document.getElementById("bar-" + id).style.width = val + "%";
    document.getElementById("val-" + id).textContent = Math.round(val);
    document.getElementById("val-" + id).style.color = sentColor(val);
  }
  setBar("vix",    lat.vix_pct);
  setBar("credit", lat.credit_pct);
  setBar("trend",  lat.trend_pct);
  setBar("safety", lat.safety_pct);

  if (!sentGaugeChart) {
    sentGaugeChart = echarts.init(document.getElementById("sentiment-gauge"), isLight() ? null : "dark");
  }
  renderSentimentGauge(lat.composite);

  if (!sentChart) {
    sentChart = echarts.init(document.getElementById("sentiment-chart"), isLight() ? null : "dark");
    window.addEventListener("resize", () => sentChart && sentChart.resize());
  }
  renderSentimentChart();
  renderSentimentBacktest(sentData.backtest);
}

function renderSentimentGauge(score) {
  sentGaugeChart.setOption({
    backgroundColor: "transparent",
    series: [{
      type: "gauge",
      startAngle: 180, endAngle: 0,
      min: 0, max: 100,
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
        color: sentColor(score), formatter: v => Math.round(v)
      },
      title: { show: false },
      data: [{ value: Math.round(score) }],
    }]
  });
}

function renderSentimentChart() {
  if (!sentData || !sentChart) return;
  const fromDate = sentRangePreset === "all" ? null : (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - parseInt(sentRangePreset));
    // check_reuse: keep — 本地 range cutoff 變體:preset key 集合/MAX 哨兵/未命中預設與 dates.presetStart、dates.cutoffDate 皆不同,換過去會改行為
    return d.toISOString().slice(0, 10);
  })();
  const rows = fromDate ? sentData.data.filter(r => r.date >= fromDate) : sentData.data;

  const sentSeries = rows.map(r => [r.date, r.composite]);
  const spySeries  = rows.map(r => [r.date, sentData._spy[r.date] ?? null]).filter(r => r[1] != null);
  const fgSeries   = rows.map(r => [r.date, sentData._fg[r.date]  ?? null]).filter(r => r[1] != null);

  const tipBg = PALETTE.bg, tipBdr = PALETTE.border;
  const tipTx = PALETTE.text, axCl = PALETTE.muted;
  const gridCl = tc("rgba(48,54,61,0.5)","rgba(208,215,222,0.4)");

  sentChart.setOption({
    backgroundColor: "transparent",
    tooltip: {
      trigger: "axis",
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: tipTx, fontSize: 12 },
      formatter: params => {
        const raw = params[0]?.axisValue;
        const date = raw ? tsToLocalDate(raw) : "";
        let html = `<b>${date}</b><br/>`;
        for (const p of params) {
          if (!p.value?.[1]) continue;
          const v = p.value[1];
          if (p.seriesName === "情緒指數")
            html += `<span style="color:${sentColor(v)}">● 情緒: <b>${v.toFixed(1)}</b> ${sentLabel(v)}</span><br/>`;
          else if (p.seriesName === "CNN F&G")
            html += `<span style="color:#e3b341">● CNN F&G: <b>${v.toFixed(0)}</b></span><br/>`;
          else
            html += `<span style="color:#58a6ff">● SPY: <b>$${v.toFixed(2)}</b></span><br/>`;
        }
        return html;
      }
    },
    legend: { data:["情緒指數","CNN F&G","SPY"], top:8, right:24, textStyle:{ color:axCl, fontSize:12 } },
    grid: { top:44, right: mob() ? 50 : 70, bottom:40, left: mob() ? 40 : 54 },
    xAxis: { type:"time", splitLine:{show:false}, axisLabel:{color:axCl,fontSize:11} },
    yAxis: [
      { type:"value", min:0, max:100, name:"情緒", nameTextStyle:{color:axCl,fontSize:11},
        splitLine:{lineStyle:{color:gridCl}}, axisLabel:{color:axCl,fontSize:11} },
      { type:"value", name:"SPY", nameTextStyle:{color:"#58a6ff",fontSize:11},
        position:"right", splitLine:{show:false}, axisLabel:{color:"#58a6ff",fontSize:11} },
    ],
    series: [
      {
        name:"情緒指數", type:"line", data:sentSeries, yAxisIndex:0, symbol:"none",
        lineStyle:{ color:"#f778ba", width:1.5 },
        areaStyle:{ color:{ type:"linear",x:0,y:0,x2:0,y2:1,
          colorStops:[{offset:0,color:"rgba(247,120,186,0.2)"},{offset:1,color:"rgba(247,120,186,0.01)"}] } },
        markArea:{ silent:true, data:[
          [{yAxis:0},{yAxis:25,itemStyle:{color:"rgba(239,68,68,0.07)"}}],
          [{yAxis:85},{yAxis:100,itemStyle:{color:"rgba(34,197,94,0.07)"}}],
        ]},
        markLine:{ silent:true, symbol:"none", data:[
          {yAxis:25,lineStyle:{color:"#ef4444",type:"dashed",width:1},
           label:{show:!mob(),formatter:"恐懼<25",color:"#ef4444",fontSize:10,position:"end"}},
          {yAxis:85,lineStyle:{color:"#22c55e",type:"dashed",width:1},
           label:{show:!mob(),formatter:"貪婪>85",color:"#22c55e",fontSize:10,position:"end"}},
        ]}
      },
      { name:"CNN F&G", type:"line", data:fgSeries, yAxisIndex:0, symbol:"none",
        lineStyle:{ color:"#e3b341", width:1.2, type:"dashed" } },
      { name:"SPY", type:"line", data:spySeries, yAxisIndex:1, symbol:"none",
        lineStyle:{ color:"#58a6ff", width:1.5 } },
    ],
    dataZoom:[
      {type:"inside",xAxisIndex:0},
      {type:"slider",xAxisIndex:0,height:18,bottom:4,
       fillerColor:"rgba(88,166,255,0.1)",borderColor:PALETTE.border},
    ],
  });
}

function renderSentimentBacktest(bt) {
  const thead = `<tr><th>日期</th><th>分數</th><th>1M SPY</th><th>3M SPY</th><th>6M SPY</th><th>1Y SPY</th></tr>`;
  function pct(v) {
    if (v == null) return `<span style="color:var(--muted)">—</span>`;
    return `<span class="${v>=0?"pos":"neg"}">${v>=0?"+":""}${v.toFixed(2)}%</span>`;
  }
  function buildTable(signals, thi, tbi) {
    document.getElementById(thi).innerHTML = thead;
    const tbody = document.getElementById(tbi);
    if (!signals.length) {
      tbody.innerHTML = `<tr><td colspan="6" style="color:var(--muted);text-align:center">無訊號</td></tr>`;
      return;
    }
    const keys = ["spy_ret_1m","spy_ret_3m","spy_ret_6m","spy_ret_1y"];
    tbody.innerHTML = signals.map(s => `<tr>
      <td>${s.date}</td>
      <td style="color:${sentColor(s.composite)};font-weight:600">${s.composite.toFixed(1)}</td>
      ${keys.map(k => `<td>${pct(s[k])}</td>`).join("")}
    </tr>`).join("");
  }
  function buildStats(signals, sid) {
    const el = document.getElementById(sid);
    if (!signals.length) { el.innerHTML = ""; return; }
    const keys = ["spy_ret_1m","spy_ret_3m","spy_ret_6m","spy_ret_1y"];
    const labels = ["1個月後","3個月後","6個月後","1年後"];
    const avgs = keys.map(k => {
      const vals = signals.map(s=>s[k]).filter(v=>v!=null);
      return vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : null;
    });
    el.innerHTML = `
      <div style="font-size:11px;color:var(--muted);margin-bottom:6px">SPY 平均報酬（n=${signals.length} 個訊號）</div>
      <div style="display:flex;gap:24px;flex-wrap:wrap">
        ${avgs.map((v,i)=>`<div>
          <div class="sent-stat-label">${labels[i]}</div>
          <div class="sent-stat-val" style="color:${v!=null&&v>=0?"#3fb950":"#f78166"}">
            ${v!=null?(v>=0?"+":"")+v.toFixed(2)+"%":"—"}
          </div>
        </div>`).join("")}
      </div>`;
  }
  buildTable(bt.fear_signals,  "sent-fear-thead",  "sent-fear-tbody");
  buildStats(bt.fear_signals,  "sent-fear-stats");
  buildTable(bt.greed_signals, "sent-greed-thead", "sent-greed-tbody");
  buildStats(bt.greed_signals, "sent-greed-stats");
}

export function onThemeChange(light) {
  if (sentChart) {
    sentChart.dispose();
    sentChart = echarts.init(document.getElementById("sentiment-chart"), light ? null : "dark");
    renderSentimentChart();
  }
  if (sentGaugeChart) {
    sentGaugeChart.dispose();
    sentGaugeChart = echarts.init(document.getElementById("sentiment-gauge"), light ? null : "dark");
    renderSentimentGauge(sentData.latest.composite);
  }
}

export function resize() {
  sentChart?.resize();
  sentGaugeChart?.resize();
}
