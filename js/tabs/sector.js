import { SECTOR_ETFS, SECTOR_LABEL, sectorLoaded } from '../state.js';
import { isLight, tc, mob, PALETTE } from '../utils/theme.js';

// ── State ──────────────────────────────────────────────────────────────
let market        = "us";
let sortCol       = "1M";
let treemapChart   = null;
let heatmapChart   = null;
let liveHoldings   = null;
let twData         = null;
let curSortedKeys  = [];
let showSparklines = null;

const PERIODS = ["1W","1M","3M","6M","YTD","1Y"];
const DAYS    = { "1W":5, "1M":21, "3M":63, "6M":126, "1Y":252 };

// ── US sector weights (approximate S&P 500 %, for treemap sizing) ──────
const US_WEIGHTS = {
  XLK:31, XLF:13, XLV:12, XLY:10, XLC:9, XLI:9,
  XLP:6, XLE:3.5, XLU:2.5, XLRE:2, XLB:2,
};

// ── TW sector config ───────────────────────────────────────────────────
const TW_KEYS = [
  "semiconductor","finance","e_components","telecom","computer",
  "shipping","steel","biotech","optoelectronics","construction",
  "tourism","food","plastics","oil_gas","digital_cloud","green_energy","machinery",
];
const TW_LABEL = {
  semiconductor:"半導體", finance:"金融保險", shipping:"航運", steel:"鋼鐵",
  biotech:"生技醫療", telecom:"通信網路", optoelectronics:"光電", computer:"電腦週邊",
  e_components:"電子零組件", construction:"建材營造", tourism:"觀光餐旅",
  food:"食品", plastics:"塑膠", oil_gas:"油電燃氣",
  digital_cloud:"數位雲端", green_energy:"綠能環保", machinery:"電機機械",
};
const TW_WEIGHTS = {
  semiconductor:48, finance:10, e_components:5, telecom:4, computer:3,
  shipping:3, steel:2, biotech:2, optoelectronics:2, construction:2,
  tourism:1, food:2, plastics:2, oil_gas:1.5, digital_cloud:1.5,
  green_energy:1, machinery:2,
};

// ── US ETF top-10 holdings ─────────────────────────────────────────────
const SECTOR_HOLDINGS = {
  XLK: [
    { sym:"NVDA", w:13.1, zh:"輝達",  desc:"AI 加速晶片(GPU)龍頭" },
    { sym:"AAPL", w:11.7, zh:"蘋果",  desc:"iPhone／消費電子" },
    { sym:"MSFT", w:8.5,  zh:"微軟",  desc:"軟體／雲端 Azure" },
    { sym:"MU",   w:6.8,  zh:"美光",  desc:"記憶體 DRAM／HBM" },
    { sym:"AVGO", w:5.4,  zh:"博通",  desc:"網通／客製 AI 晶片" },
    { sym:"AMD",  w:5.2,  zh:"超微",  desc:"CPU／GPU" },
    { sym:"INTC", w:3.3,  zh:"英特爾", desc:"CPU／晶圓代工" },
    { sym:"CSCO", w:3.0,  zh:"思科",  desc:"網路設備" },
    { sym:"LRCX", w:2.5,  zh:"科林研發", desc:"半導體設備" },
    { sym:"ORCL", w:2.4,  zh:"甲骨文", desc:"資料庫／雲端" },
  ],
  XLF: [
    { sym:"BRK-B", w:11.8, zh:"波克夏", desc:"巴菲特控股" },
    { sym:"JPM",   w:11.0, zh:"摩根大通", desc:"美國最大銀行" },
    { sym:"V",     w:7.5,  zh:"Visa", desc:"全球支付網路" },
    { sym:"MA",    w:5.5,  zh:"萬事達", desc:"全球支付網路" },
    { sym:"BAC",   w:4.7,  zh:"美國銀行", desc:"商業銀行" },
    { sym:"GS",    w:4.2,  zh:"高盛", desc:"投資銀行" },
    { sym:"MS",    w:3.4,  zh:"摩根士丹利", desc:"投行" },
    { sym:"WFC",   w:3.3,  zh:"富國銀行", desc:"商業銀行" },
    { sym:"C",     w:3.0,  zh:"花旗", desc:"全球銀行" },
    { sym:"AXP",   w:2.3,  zh:"美國運通", desc:"信用卡" },
  ],
  XLV: [
    { sym:"LLY",  w:16.2, zh:"禮來",   desc:"GLP-1 龍頭" },
    { sym:"JNJ",  w:10.0, zh:"嬌生",   desc:"製藥／醫療器材" },
    { sym:"ABBV", w:7.1,  zh:"艾伯維", desc:"製藥(免疫)" },
    { sym:"UNH",  w:6.4,  zh:"聯合健康", desc:"醫療保險" },
    { sym:"MRK",  w:5.4,  zh:"默克",   desc:"癌症藥 Keytruda" },
    { sym:"TMO",  w:3.4,  zh:"賽默飛", desc:"生技儀器" },
    { sym:"AMGN", w:3.4,  zh:"安進",   desc:"生物製藥" },
    { sym:"GILD", w:3.1,  zh:"吉利德", desc:"抗病毒藥" },
    { sym:"ISRG", w:2.8,  zh:"直覺手術", desc:"手術機器人" },
    { sym:"PFE",  w:2.8,  zh:"輝瑞",   desc:"製藥" },
  ],
  XLE: [
    { sym:"XOM", w:22.1, zh:"埃克森美孚", desc:"綜合石油" },
    { sym:"CVX", w:16.6, zh:"雪佛龍",   desc:"綜合石油" },
    { sym:"COP", w:6.8,  zh:"康菲",     desc:"油氣探勘" },
    { sym:"SLB", w:4.7,  zh:"斯倫貝謝", desc:"油田服務" },
    { sym:"WMB", w:4.3,  zh:"威廉斯",   desc:"天然氣管線" },
    { sym:"VLO", w:4.3,  zh:"瓦萊羅",   desc:"煉油" },
    { sym:"MPC", w:4.2,  zh:"馬拉松石油", desc:"煉油" },
    { sym:"EOG", w:4.2,  zh:"EOG",      desc:"頁岩油氣" },
    { sym:"PSX", w:4.1,  zh:"菲利普斯66", desc:"煉油／化工" },
    { sym:"BKR", w:3.6,  zh:"貝克休斯", desc:"油田服務" },
  ],
  XLI: [
    { sym:"CAT", w:7.6, zh:"卡特彼勒", desc:"重型機械" },
    { sym:"GE",  w:6.3, zh:"GE 航太",  desc:"航空引擎" },
    { sym:"GEV", w:4.8, zh:"GE Vernova",desc:"電力設備" },
    { sym:"RTX", w:4.5, zh:"雷神",     desc:"國防" },
    { sym:"BA",  w:3.4, zh:"波音",     desc:"民航機" },
    { sym:"UNP", w:2.9, zh:"聯合太平洋",desc:"鐵路" },
    { sym:"ETN", w:2.9, zh:"伊頓",     desc:"電力管理" },
    { sym:"HON", w:2.8, zh:"漢威聯合", desc:"工業自動化" },
    { sym:"UBER",w:2.7, zh:"Uber",    desc:"叫車／外送" },
    { sym:"DE",  w:2.5, zh:"強鹿",     desc:"農用機械" },
  ],
  XLY: [
    { sym:"AMZN", w:27.6, zh:"亞馬遜",  desc:"電商／AWS" },
    { sym:"TSLA", w:20.0, zh:"特斯拉",  desc:"電動車" },
    { sym:"HD",   w:5.2,  zh:"家得寶",  desc:"居家修繕" },
    { sym:"TJX",  w:3.9,  zh:"TJX",    desc:"折扣服飾" },
    { sym:"MCD",  w:3.6,  zh:"麥當勞",  desc:"速食連鎖" },
    { sym:"BKNG", w:3.0,  zh:"Booking",desc:"線上訂房" },
    { sym:"LOW",  w:2.7,  zh:"勞氏",    desc:"居家修繕" },
    { sym:"SBUX", w:2.5,  zh:"星巴克",  desc:"咖啡連鎖" },
    { sym:"MAR",  w:1.9,  zh:"萬豪",    desc:"飯店" },
    { sym:"GM",   w:1.7,  zh:"通用汽車",desc:"汽車" },
  ],
  XLP: [
    { sym:"WMT",  w:10.8, zh:"沃爾瑪",  desc:"零售龍頭" },
    { sym:"COST", w:9.1,  zh:"好市多",  desc:"會員量販" },
    { sym:"PG",   w:7.1,  zh:"寶僑",    desc:"日用品" },
    { sym:"KO",   w:6.5,  zh:"可口可樂",desc:"飲料" },
    { sym:"PM",   w:5.9,  zh:"菲莫",    desc:"菸草(國際)" },
    { sym:"MDLZ", w:5.0,  zh:"億滋",    desc:"零食" },
    { sym:"MO",   w:4.7,  zh:"奧馳亞",  desc:"菸草(美國)" },
    { sym:"CL",   w:4.5,  zh:"高露潔",  desc:"日用品" },
    { sym:"PEP",  w:4.2,  zh:"百事",    desc:"飲料" },
    { sym:"MNST", w:4.2,  zh:"怪獸飲料",desc:"能量飲料" },
  ],
  XLU: [
    { sym:"NEE", w:13.2, zh:"NextEra", desc:"再生能源電力" },
    { sym:"SO",  w:7.4,  zh:"南方電力",desc:"區域電力" },
    { sym:"DUK", w:6.9,  zh:"杜克能源",desc:"區域電力" },
    { sym:"CEG", w:6.5,  zh:"Constellation",desc:"核電(AI供電)" },
    { sym:"AEP", w:5.0,  zh:"美國電力",desc:"區域電力" },
    { sym:"SRE", w:4.2,  zh:"Sempra", desc:"電力／天然氣" },
    { sym:"D",   w:4.2,  zh:"Dominion",desc:"區域電力" },
    { sym:"VST", w:3.7,  zh:"Vistra", desc:"電力(含核電)" },
    { sym:"ETR", w:3.6,  zh:"Entergy",desc:"區域電力" },
    { sym:"XEL", w:3.4,  zh:"Xcel",   desc:"區域電力" },
  ],
  XLRE: [
    { sym:"WELL", w:9.9, zh:"Welltower",desc:"醫療 REIT" },
    { sym:"PLD",  w:9.2, zh:"Prologis", desc:"物流倉儲 REIT" },
    { sym:"EQIX", w:7.2, zh:"Equinix",  desc:"資料中心 REIT" },
    { sym:"AMT",  w:6.0, zh:"美國電塔", desc:"通訊基地台" },
    { sym:"SPG",  w:4.7, zh:"Simon",    desc:"購物中心 REIT" },
    { sym:"DLR",  w:4.6, zh:"Digital Realty",desc:"資料中心" },
    { sym:"PSA",  w:4.4, zh:"Public Storage",desc:"自助倉儲" },
    { sym:"VTR",  w:4.2, zh:"Ventas",   desc:"醫療 REIT" },
    { sym:"CCI",  w:4.2, zh:"Crown Castle",desc:"通訊塔" },
    { sym:"O",    w:4.1, zh:"Realty Income",desc:"月配息 REIT" },
  ],
  XLB: [
    { sym:"LIN", w:14.1, zh:"林德",    desc:"工業氣體" },
    { sym:"NEM", w:7.3,  zh:"紐蒙特",  desc:"黃金礦業" },
    { sym:"NUE", w:6.3,  zh:"紐柯",    desc:"鋼鐵" },
    { sym:"FCX", w:5.7,  zh:"自由港",  desc:"銅礦" },
    { sym:"VMC", w:4.6,  zh:"火神材料",desc:"建材砂石" },
    { sym:"CRH", w:4.6,  zh:"CRH",     desc:"建材" },
    { sym:"APD", w:4.4,  zh:"空氣產品",desc:"工業氣體" },
    { sym:"STLD",w:4.4,  zh:"鋼動力",  desc:"鋼鐵" },
    { sym:"CTVA",w:4.3,  zh:"科迪華",  desc:"農化" },
    { sym:"SHW", w:4.3,  zh:"宣偉",    desc:"塗料" },
  ],
  XLC: [
    { sym:"META",  w:14.0, zh:"Meta",   desc:"社群(FB/IG)" },
    { sym:"GOOGL", w:9.8,  zh:"谷歌 A", desc:"搜尋／YouTube" },
    { sym:"GOOG",  w:7.8,  zh:"谷歌 C", desc:"Alphabet(無投票權)" },
    { sym:"TTWO",  w:4.9,  zh:"Take-Two",desc:"遊戲(GTA)" },
    { sym:"LYV",   w:4.8,  zh:"Live Nation",desc:"演唱會" },
    { sym:"SATS",  w:4.6,  zh:"EchoStar",desc:"衛星通訊" },
    { sym:"DIS",   w:4.5,  zh:"迪士尼", desc:"媒體／串流" },
    { sym:"WBD",   w:4.2,  zh:"華納探索",desc:"HBO" },
    { sym:"EA",    w:4.2,  zh:"美商藝電",desc:"遊戲" },
    { sym:"OMC",   w:4.1,  zh:"宏盟",   desc:"廣告" },
  ],
};

// ── Helpers ─────────────────────────────────────────────────────────────
function keys()    { return market === "us" ? [...SECTOR_ETFS] : TW_KEYS.filter(k => twData?.data?.[k]); }
function label(k)  { return market === "us" ? (SECTOR_LABEL[k] || k) : (TW_LABEL[k] || k); }
function weight(k) { return market === "us" ? (US_WEIGHTS[k] || 1) : (TW_WEIGHTS[k] || 1); }
function series(k) { return market === "us" ? (sectorLoaded[k] || []) : (twData?.data?.[k] || []); }

function calcReturn(data, period) {
  if (!data || data.length < 2) return null;
  const latest = data[data.length - 1][1];
  if (period === "YTD") {
    const yr = data[data.length - 1][0].slice(0, 4) + "-01-01";
    const base = data.find(r => r[0] >= yr);
    return base ? (latest / base[1] - 1) * 100 : null;
  }
  const n = DAYS[period];
  if (data.length <= n) return null;
  const base = data[data.length - 1 - n][1];
  return base > 0 ? (latest / base - 1) * 100 : null;
}

// check_reuse: keep — 帶 .toFixed(2) 捨入,與 math.computeMA 不等價
function computeMA(data, win) {
  const out = [];
  for (let i = 0; i < data.length; i++) {
    if (i < win - 1) { out.push([data[i][0], null]); continue; }
    let s = 0;
    for (let j = i - win + 1; j <= i; j++) s += data[j][1];
    out.push([data[i][0], +(s / win).toFixed(2)]);
  }
  return out;
}

function retColor(pct) {
  if (pct == null) return PALETTE.border;
  const t = Math.min(1, Math.abs(pct) / 20);
  if (pct >= 0) {
    const r = Math.round(30 + (1-t)*215), g = Math.round(100 + (1-t)*145), b = Math.round(30 + (1-t)*215);
    return `rgb(${r},${g},${b})`;
  }
  const r = Math.round(200 - (1-t)*(-45)), g = Math.round(40 + (1-t)*205), b = Math.round(40 + (1-t)*205);
  return `rgb(${r},${g},${b})`;
}

const googleUrl = sym => `https://www.google.com/search?q=${encodeURIComponent(sym + " stock")}`;

// ── Data loading ────────────────────────────────────────────────────────
async function loadUS() {
  await Promise.all(SECTOR_ETFS.map(async etf => {
    if (sectorLoaded[etf]) return;
    const resp = await fetch(`data/${etf}.json`, { cache: "no-cache" });
    if (!resp.ok) throw new Error(`${etf}: HTTP ${resp.status}`);
    const j = await resp.json();
    sectorLoaded[etf] = (j.data || []).map(r => [r.date, r.close]);
  }));
  if (!liveHoldings) {
    try {
      const r = await fetch("data/sector_holdings.json", { cache: "no-cache" });
      if (r.ok) liveHoldings = (await r.json()).data || null;
    } catch { /* fallback */ }
  }
}

async function loadTW() {
  if (twData) return;
  const resp = await fetch("data/taiwan_sector_index.json", { cache: "no-cache" });
  if (!resp.ok) throw new Error("台股產業指數載入失敗");
  twData = await resp.json();
}

// ── Line chart modal ────────────────────────────────────────────────────
function showLineChart(key) {
  const data = series(key);
  if (!data || data.length < 10) return;

  document.getElementById("sector-pop")?.remove();
  treemapChart?.dispatchAction({ type: "hideTip" });
  heatmapChart?.dispatchAction({ type: "hideTip" });

  const light = isLight();
  const bg  = light ? "#ffffff" : "#161b22";
  const bd  = light ? "#d0d7de" : "#30363d";
  const tx  = light ? "#1f2328" : "#e6edf3";
  const mut = light ? "#57606a" : "#8b949e";

  const latest = data[data.length-1][1];
  const r1m = calcReturn(data, "1M");
  const r3m = calcReturn(data, "3M");
  const r1y = calcReturn(data, "1Y");
  const fmtRet = v => v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
  const retClr = v => v == null ? mut : v >= 0 ? "#3fb950" : "#f78166";

  const displayLabel = label(key);
  const displayKey = market === "us" ? key : "";
  const priceStr = market === "us" ? `$${latest.toFixed(2)}` : latest.toFixed(2);

  // Holdings section (US only)
  let holdingsHTML = "";
  if (market === "us") {
    const holdings = (liveHoldings && liveHoldings[key]) || SECTOR_HOLDINGS[key];
    if (holdings) {
      holdingsHTML = `<div style="margin-top:12px;border-top:1px solid ${bd};padding-top:10px">
        <div style="font-size:12px;color:${mut};margin-bottom:6px">前十大持股</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">${holdings.map(h =>
          `<a href="${googleUrl(h.sym)}" target="_blank" rel="noopener noreferrer"
              style="font-size:12px;padding:3px 8px;border:1px solid ${bd};border-radius:6px;
                     text-decoration:none;color:${tx};white-space:nowrap">
            <b>${h.sym}</b> <span style="color:${mut}">${h.zh} ${h.w}%</span>
          </a>`).join("")}</div></div>`;
    }
  }

  const ov = document.createElement("div");
  ov.id = "sector-pop";
  ov.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:16px";
  ov.innerHTML = `<div style="background:${bg};border:1px solid ${bd};border-radius:12px;max-width:720px;width:100%;
    max-height:90vh;overflow:auto;padding:16px;box-shadow:0 12px 40px rgba(0,0,0,.35)">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <div style="font-weight:700;font-size:16px;color:${tx}">${displayLabel}${displayKey ? " · " + displayKey : ""}</div>
      <span style="font-size:14px;color:${tx};font-variant-numeric:tabular-nums">${priceStr}</span>
      <span style="font-size:12px;margin-left:4px">
        <span style="color:${retClr(r1m)}">1M ${fmtRet(r1m)}</span>
        <span style="color:${mut};margin:0 2px">·</span>
        <span style="color:${retClr(r3m)}">3M ${fmtRet(r3m)}</span>
        <span style="color:${mut};margin:0 2px">·</span>
        <span style="color:${retClr(r1y)}">1Y ${fmtRet(r1y)}</span>
      </span>
      <button id="sector-pop-x" style="margin-left:auto;background:none;border:none;color:${mut};font-size:20px;cursor:pointer;line-height:1">✕</button>
    </div>
    <div id="sector-line-chart" style="width:100%;height:340px"></div>
    ${holdingsHTML}
  </div>`;
  document.body.appendChild(ov);

  // Init ECharts line chart
  const lineEl = document.getElementById("sector-line-chart");
  const lineChart = echarts.init(lineEl, light ? null : "dark");
  const ma50  = computeMA(data, 50);
  const ma200 = computeMA(data, 200);

  lineChart.setOption({
    backgroundColor: "transparent",
    tooltip: {
      trigger: "axis",
      backgroundColor: bg, borderColor: bd,
      textStyle: { color: tx, fontSize: 12 },
      formatter: ps => {
        const d = ps[0]?.axisValue || "";
        return `<b>${d}</b><br/>` + ps.map(p =>
          `${p.marker} ${p.seriesName}: <b>${p.value?.[1] != null ? p.value[1].toFixed(2) : "—"}</b>`
        ).join("<br/>");
      },
    },
    legend: {
      data: [displayLabel, "MA50", "MA200"],
      top: 4, textStyle: { color: mut, fontSize: 11 },
    },
    grid: { top: 32, bottom: 50, left: 55, right: 16 },
    xAxis: {
      type: "category",
      data: data.map(d => d[0]),
      axisLabel: { color: mut, fontSize: 10 },
      axisLine: { lineStyle: { color: bd } },
    },
    yAxis: {
      type: "value", scale: true,
      axisLabel: { color: mut, fontSize: 10 },
      splitLine: { lineStyle: { color: bd, opacity: 0.3 } },
    },
    dataZoom: [
      { type: "inside", start: Math.max(0, 100 - 252 / data.length * 100), end: 100 },
      { type: "slider", height: 18, bottom: 4, borderColor: bd,
        textStyle: { color: mut, fontSize: 10 } },
    ],
    series: [
      { name: displayLabel, type: "line", data: data, symbol: "none", lineStyle: { width: 1.5 },
        itemStyle: { color: "#58a6ff" } },
      { name: "MA50", type: "line", data: ma50, symbol: "none",
        lineStyle: { width: 1, type: "dashed", color: "#d29922" } },
      { name: "MA200", type: "line", data: ma200, symbol: "none",
        lineStyle: { width: 1, type: "dashed", color: "#f78166" } },
    ],
  });

  const close = () => { lineChart.dispose(); ov.remove(); };
  ov.addEventListener("click", e => { if (e.target === ov) close(); });
  document.getElementById("sector-pop-x").addEventListener("click", close);
  document.addEventListener("keydown", function esc(e) {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); }
  });
  window.addEventListener("resize", () => lineChart.resize(), { once: true });
}

// ── Treemap ─────────────────────────────────────────────────────────────
function renderTreemap(returns) {
  if (!treemapChart) return;
  const ks = curSortedKeys;
  const tipBg = PALETTE.bg, tipBdr = PALETTE.border;
  const tipText = PALETTE.text;

  const treeData = ks.map(k => {
    const ret = returns[k]?.[sortCol];
    return {
      name: label(k) + (market === "us" ? "\n" + k : ""),
      value: weight(k),
      _key: k,
      _ret: ret,
      itemStyle: { color: retColor(ret), borderColor: PALETTE.cellBorder, borderWidth: 2 },
      label: {
        color: PALETTE.text, fontSize: weight(k) > 8 ? 13 : 11, fontWeight: 600,
      },
    };
  });

  treemapChart.setOption({
    backgroundColor: "transparent",
    tooltip: {
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: tipText },
      formatter: p => {
        const ret = p.data?._ret;
        const clr = ret != null ? (ret >= 0 ? "#3fb950" : "#f78166") : "";
        return `<b>${label(p.data?._key)}</b>${market==="us" ? " · " + p.data?._key : ""}<br/>`
          + `${sortCol}: <b style="color:${clr}">${ret != null ? (ret>=0?"+":"") + ret.toFixed(2)+"%" : "—"}</b><br/>`
          + `<span style="font-size:11px;color:${PALETTE.muted}">佔比 ≈${p.data?.value}%</span>`;
      },
    },
    series: [{
      type: "treemap",
      data: treeData,
      roam: false, nodeClick: false,
      breadcrumb: { show: false },
      levels: [{ itemStyle: { borderWidth: 0, gapWidth: 2 } }],
      label: { show: true, formatter: "{b}", position: "insideCenter" },
      emphasis: { label: { fontSize: 14 } },
    }],
  }, { notMerge: true });

  treemapChart.off("click");
  treemapChart.on("click", p => { if (p.data?._key) showLineChart(p.data._key); });
}

// ── Grid heatmap ────────────────────────────────────────────────────────
function renderHeatmap(returns) {
  if (!heatmapChart) return;
  const ks = curSortedKeys;
  const tipBg = PALETTE.bg, tipBdr = PALETTE.border;
  const tipText = PALETTE.text, axisClr = PALETTE.muted;

  const heatData = [];
  for (let pi = 0; pi < PERIODS.length; pi++) {
    for (let ei = 0; ei < ks.length; ei++) {
      const v = returns[ks[ei]]?.[PERIODS[pi]];
      heatData.push([ei, pi, v != null ? +v.toFixed(2) : null]);
    }
  }
  const maxAbs = heatData.reduce((m, d) => d[2] != null ? Math.max(m, Math.abs(d[2])) : m, 1);
  const xLabels = ks.map(k => mob() ? (market === "us" ? k : label(k).slice(0,3)) : (market === "us" ? `${label(k)}\n${k}` : label(k)));

  heatmapChart.setOption({
    backgroundColor: "transparent",
    tooltip: {
      trigger: "item", backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: tipText },
      formatter: p => {
        const v = p.value?.[2], k = ks[p.value?.[0]], per = PERIODS[p.value?.[1]];
        if (v == null || !k) return "";
        const kLabel = market === "us" ? `${k} ${label(k)}` : label(k);
        return `<b>${kLabel}</b><br/>${per}: <b style="color:${v>=0?"#3fb950":"#f78166"}">${v>=0?"+":""}${v.toFixed(2)}%</b>`;
      },
    },
    visualMap: {
      min: -maxAbs, max: maxAbs, calculable: false,
      orient: "horizontal", left: "center", bottom: 10,
      itemWidth: 12, itemHeight: 120,
      text: ["+", "−"], textStyle: { color: tipText, fontSize: 11 },
      inRange: { color: ["#c62828","#ef9a9a","#f5f5f5","#a5d6a7","#1b5e20"] },
    },
    grid: { top: 16, bottom: 72, left: mob() ? 40 : 56, right: 16 },
    xAxis: {
      type: "category", data: xLabels, splitArea: { show: true },
      axisLine: { lineStyle: { color: axisClr } },
      axisLabel: { color: tipText, fontSize: mob() ? 10 : 11, interval: 0, rotate: market === "tw" && !mob() ? 30 : 0 },
    },
    yAxis: {
      type: "category", data: PERIODS, splitArea: { show: true },
      axisLine: { lineStyle: { color: axisClr } },
      axisLabel: { color: tipText, fontSize: 12 },
    },
    series: [{
      type: "heatmap", data: heatData,
      label: {
        show: !mob(), fontSize: 11,
        formatter: p => p.value?.[2] != null ? (p.value[2] >= 0 ? "+" : "") + p.value[2].toFixed(1) + "%" : "—",
      },
      emphasis: { itemStyle: { shadowBlur: 6, shadowColor: "rgba(0,0,0,.3)" } },
    }],
  }, { notMerge: true });

  heatmapChart.off("click");
  heatmapChart.on("click", p => {
    const k = ks[p.value?.[0]];
    if (k) showLineChart(k);
  });
}

// ── Sparklines ─────────────────────────────────────────────────────────
function adjustChartHeight() {
  const hmEl = document.getElementById("sector-chart");
  if (!hmEl) return;
  hmEl.style.height = showSparklines && curSortedKeys.length
    ? `calc(100vh - 314px - var(--cat-bar-h))`
    : "";
  heatmapChart?.resize();
}

function renderSparklines() {
  const wrap = document.getElementById("sector-sparkline-wrap");
  if (!wrap) return;
  adjustChartHeight();
  if (!showSparklines || !curSortedKeys.length) {
    wrap.style.display = "none";
    return;
  }

  const ks = curSortedKeys;
  const isMob = mob();
  const leftPad = isMob ? 40 : 56;
  wrap.style.cssText = `display:flex;padding:4px 16px 0 ${leftPad}px;gap:1px;border-top:1px solid ${PALETTE.border}`;
  if (isMob) wrap.style.minWidth = "600px";
  wrap.innerHTML = "";

  const frag = document.createDocumentFragment();
  for (const k of ks) {
    if (series(k).length < 2) continue;
    const cell = document.createElement("div");
    cell.style.cssText = "flex:1;min-width:0;height:50px;cursor:pointer;border-radius:4px";
    cell.title = `${label(k)} 近3M走勢`;
    cell.addEventListener("click", () => showLineChart(k));
    cell.addEventListener("mouseenter", () => { cell.style.background = tc("rgba(255,255,255,.06)","rgba(0,0,0,.05)"); });
    cell.addEventListener("mouseleave", () => { cell.style.background = ""; });
    const cvs = document.createElement("canvas");
    cvs.style.cssText = "width:100%;height:100%;display:block";
    cell.appendChild(cvs);
    frag.appendChild(cell);
  }
  wrap.appendChild(frag);

  setTimeout(() => {
    const ksValid = ks.filter(k => series(k).length >= 2);
    for (let i = 0; i < ksValid.length && i < wrap.children.length; i++) {
      const cvs = wrap.children[i]?.querySelector("canvas");
      if (!cvs) continue;
      const data = series(ksValid[i]).slice(-63);
      const ret = calcReturn(series(ksValid[i]), "3M");
      const color = ret == null ? PALETTE.muted : ret >= 0 ? "#3fb950" : "#f78166";
      drawSparkline(cvs, data, color);
    }
  });
}

function drawSparkline(cvs, data, color) {
  const w = cvs.offsetWidth, h = cvs.offsetHeight;
  if (!w || !h || !data.length) return;
  const dpr = window.devicePixelRatio || 1;
  cvs.width = w * dpr;
  cvs.height = h * dpr;
  const ctx = cvs.getContext("2d");
  ctx.scale(dpr, dpr);

  const vals = data.map(d => d[1]);
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || 1;
  const pad = 3;

  ctx.beginPath();
  for (let i = 0; i < vals.length; i++) {
    const x = vals.length > 1 ? (i / (vals.length - 1)) * w : w / 2;
    const y = pad + (1 - (vals[i] - min) / range) * (h - 2 * pad);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = color + "1a";
  ctx.fill();
}

// ── Main render ─────────────────────────────────────────────────────────
export async function renderSectorTab() {
  const statusEl = document.getElementById("sector-status");
  statusEl.textContent = "載入中…";

  try {
    if (market === "us") await loadUS();
    else await loadTW();
  } catch (e) {
    statusEl.textContent = `載入失敗：${e.message}`;
    return;
  }

  const ks = keys();
  if (!ks.length) { statusEl.textContent = "無資料"; return; }

  const returns = {};
  for (const k of ks) {
    returns[k] = {};
    for (const p of PERIODS)
      returns[k][p] = p === "YTD" ? calcReturn(series(k), "YTD") : calcReturn(series(k), p);
  }

  const sorted = [...ks].sort((a, b) => (returns[b]?.[sortCol] ?? -Infinity) - (returns[a]?.[sortCol] ?? -Infinity));
  curSortedKeys = sorted;

  renderTreemap(returns);
  renderHeatmap(returns);
  renderSparklines();

  const latestDates = ks.map(k => series(k)?.at(-1)?.[0]).filter(Boolean).sort();
  const latest = latestDates.at(-1) ?? "—";
  const mktLabel = market === "us" ? "美股11大產業 ETF" : `台股${ks.length}大產業指數`;
  statusEl.textContent = `${mktLabel} · 以${sortCol}排序 · 截至 ${latest} · 點任一板塊看走勢+MA`;
}

// ── Lifecycle ───────────────────────────────────────────────────────────
function initCharts() {
  const theme = isLight() ? null : "dark";
  const tmEl = document.getElementById("sector-treemap");
  const hmEl = document.getElementById("sector-chart");
  hmEl.style.minWidth = mob() ? "600px" : "";

  if (!treemapChart) treemapChart = echarts.init(tmEl, theme);
  if (!heatmapChart) heatmapChart = echarts.init(hmEl, theme);
}

export function activate() {
  if (showSparklines === null) showSparklines = !mob();
  const tog = document.getElementById("sector-sparkline-toggle");
  if (tog) tog.classList.toggle("active", showSparklines);
  initCharts();
  setTimeout(() => { treemapChart?.resize(); heatmapChart?.resize(); renderSectorTab(); }, 50);
}

export function onThemeChange(light) {
  const theme = light ? null : "dark";
  if (treemapChart) { treemapChart.dispose(); treemapChart = echarts.init(document.getElementById("sector-treemap"), theme); }
  if (heatmapChart) { heatmapChart.dispose(); heatmapChart = echarts.init(document.getElementById("sector-chart"), theme); }
  renderSectorTab();
}

export function resize() {
  document.getElementById("sector-chart")?.style.removeProperty("height");
  treemapChart?.resize();
  heatmapChart?.resize();
  renderSparklines();
}

// ── Event listeners ─────────────────────────────────────────────────────
document.getElementById("sector-sort-picker")?.addEventListener("click", e => {
  const t = e.target.closest(".chip[data-sector-col]");
  if (!t) return;
  sortCol = t.dataset.sectorCol;
  for (const c of e.currentTarget.querySelectorAll(".chip"))
    c.classList.toggle("active", c === t);
  renderSectorTab();
});

document.getElementById("sector-sparkline-toggle")?.addEventListener("click", e => {
  showSparklines = !showSparklines;
  e.currentTarget.classList.toggle("active", showSparklines);
  renderSparklines();
});

document.getElementById("sector-market-picker")?.addEventListener("click", e => {
  const t = e.target.closest(".chip[data-sector-mkt]");
  if (!t) return;
  market = t.dataset.sectorMkt;
  for (const c of e.currentTarget.querySelectorAll(".chip"))
    c.classList.toggle("active", c === t);
  renderSectorTab();
});
