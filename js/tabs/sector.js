import { SECTOR_ETFS, SECTOR_LABEL, sectorLoaded } from '../state.js';
import { isLight, tc, mob } from '../utils/theme.js';

let sectorChart    = null;
let sectorSortCol  = "1M";
let curSortedETFs  = [];     // current column order, for click→popup mapping
let liveHoldings   = null;   // data/sector_holdings.json (auto-fetched 權重/名單) — 優先於硬編 fallback

const SECTOR_PERIODS = ["1W","1M","3M","6M","YTD","1Y"];
const SECTOR_DAYS    = { "1W": 5, "1M": 21, "3M": 63, "6M": 126, "1Y": 252 };

// 各板塊 ETF 前十大持股（權重為 ETF 佔比，更新於 2026-06；偶爾手動更新即可）
const SECTOR_HOLDINGS = {
  XLK: [
    { sym:"NVDA", w:13.1, zh:"輝達",  desc:"AI 加速晶片(GPU)龍頭" },
    { sym:"AAPL", w:11.7, zh:"蘋果",  desc:"iPhone／消費電子" },
    { sym:"MSFT", w:8.5,  zh:"微軟",  desc:"軟體／雲端 Azure" },
    { sym:"MU",   w:6.8,  zh:"美光",  desc:"記憶體 DRAM／HBM" },
    { sym:"AVGO", w:5.4,  zh:"博通",  desc:"網通／客製 AI 晶片" },
    { sym:"AMD",  w:5.2,  zh:"超微",  desc:"CPU／GPU(對打 Intel/NVDA)" },
    { sym:"INTC", w:3.3,  zh:"英特爾", desc:"CPU／晶圓代工" },
    { sym:"CSCO", w:3.0,  zh:"思科",  desc:"網路設備" },
    { sym:"LRCX", w:2.5,  zh:"科林研發", desc:"半導體製程設備" },
    { sym:"ORCL", w:2.4,  zh:"甲骨文", desc:"資料庫／雲端" },
  ],
  XLF: [
    { sym:"BRK-B", w:11.8, zh:"波克夏", desc:"巴菲特控股集團" },
    { sym:"JPM",   w:11.0, zh:"摩根大通", desc:"美國最大銀行" },
    { sym:"V",     w:7.5,  zh:"Visa", desc:"全球支付網路" },
    { sym:"MA",    w:5.5,  zh:"萬事達", desc:"全球支付網路" },
    { sym:"BAC",   w:4.7,  zh:"美國銀行", desc:"大型商業銀行" },
    { sym:"GS",    w:4.2,  zh:"高盛", desc:"投資銀行" },
    { sym:"MS",    w:3.4,  zh:"摩根士丹利", desc:"投行／財富管理" },
    { sym:"WFC",   w:3.3,  zh:"富國銀行", desc:"商業銀行" },
    { sym:"C",     w:3.0,  zh:"花旗", desc:"全球銀行" },
    { sym:"AXP",   w:2.3,  zh:"美國運通", desc:"信用卡／支付" },
  ],
  XLV: [
    { sym:"LLY",  w:16.2, zh:"禮來",   desc:"減肥／糖尿病藥(GLP-1)龍頭" },
    { sym:"JNJ",  w:10.0, zh:"嬌生",   desc:"製藥／醫療器材" },
    { sym:"ABBV", w:7.1,  zh:"艾伯維", desc:"製藥(免疫／美容)" },
    { sym:"UNH",  w:6.4,  zh:"聯合健康", desc:"最大醫療保險商" },
    { sym:"MRK",  w:5.4,  zh:"默克",   desc:"製藥(癌症藥 Keytruda)" },
    { sym:"TMO",  w:3.4,  zh:"賽默飛", desc:"生技儀器／試劑" },
    { sym:"AMGN", w:3.4,  zh:"安進",   desc:"生物製藥" },
    { sym:"GILD", w:3.1,  zh:"吉利德", desc:"抗病毒藥" },
    { sym:"ISRG", w:2.8,  zh:"直覺手術", desc:"手術機器人(達文西)" },
    { sym:"PFE",  w:2.8,  zh:"輝瑞",   desc:"製藥" },
  ],
  XLE: [
    { sym:"XOM", w:22.1, zh:"埃克森美孚", desc:"綜合石油巨頭" },
    { sym:"CVX", w:16.6, zh:"雪佛龍",   desc:"綜合石油" },
    { sym:"COP", w:6.8,  zh:"康菲",     desc:"油氣探勘生產" },
    { sym:"SLB", w:4.7,  zh:"斯倫貝謝", desc:"油田服務龍頭" },
    { sym:"WMB", w:4.3,  zh:"威廉斯",   desc:"天然氣管線" },
    { sym:"VLO", w:4.3,  zh:"瓦萊羅",   desc:"煉油" },
    { sym:"MPC", w:4.2,  zh:"馬拉松石油", desc:"煉油" },
    { sym:"EOG", w:4.2,  zh:"EOG",      desc:"頁岩油氣探勘" },
    { sym:"PSX", w:4.1,  zh:"菲利普斯66", desc:"煉油／化工" },
    { sym:"BKR", w:3.6,  zh:"貝克休斯", desc:"油田服務／設備" },
  ],
  XLI: [
    { sym:"CAT", w:7.6, zh:"卡特彼勒",  desc:"重型機械設備" },
    { sym:"GE",  w:6.3, zh:"GE 航太",   desc:"航空引擎" },
    { sym:"GEV", w:4.8, zh:"GE Vernova", desc:"電力／電網設備" },
    { sym:"RTX", w:4.5, zh:"雷神",      desc:"國防／航太" },
    { sym:"BA",  w:3.4, zh:"波音",      desc:"民航機製造" },
    { sym:"UNP", w:2.9, zh:"聯合太平洋", desc:"鐵路貨運" },
    { sym:"ETN", w:2.9, zh:"伊頓",      desc:"電力管理設備" },
    { sym:"HON", w:2.8, zh:"漢威聯合",  desc:"工業自動化／航太" },
    { sym:"UBER",w:2.7, zh:"Uber",     desc:"叫車／外送平台" },
    { sym:"DE",  w:2.5, zh:"強鹿",      desc:"農用機械" },
  ],
  XLY: [
    { sym:"AMZN", w:27.6, zh:"亞馬遜",   desc:"電商／雲端 AWS" },
    { sym:"TSLA", w:20.0, zh:"特斯拉",   desc:"電動車" },
    { sym:"HD",   w:5.2,  zh:"家得寶",   desc:"居家修繕零售" },
    { sym:"TJX",  w:3.9,  zh:"TJX",     desc:"折扣服飾零售" },
    { sym:"MCD",  w:3.6,  zh:"麥當勞",   desc:"速食連鎖" },
    { sym:"BKNG", w:3.0,  zh:"Booking", desc:"線上訂房旅遊" },
    { sym:"LOW",  w:2.7,  zh:"勞氏",     desc:"居家修繕零售" },
    { sym:"SBUX", w:2.5,  zh:"星巴克",   desc:"咖啡連鎖" },
    { sym:"MAR",  w:1.9,  zh:"萬豪",     desc:"飯店集團" },
    { sym:"GM",   w:1.7,  zh:"通用汽車", desc:"汽車製造" },
  ],
  XLP: [
    { sym:"WMT",  w:10.8, zh:"沃爾瑪",   desc:"零售龍頭" },
    { sym:"COST", w:9.1,  zh:"好市多",   desc:"會員制量販" },
    { sym:"PG",   w:7.1,  zh:"寶僑",     desc:"日用消費品" },
    { sym:"KO",   w:6.5,  zh:"可口可樂", desc:"飲料" },
    { sym:"PM",   w:5.9,  zh:"菲利普莫里斯", desc:"菸草(國際)" },
    { sym:"MDLZ", w:5.0,  zh:"億滋",     desc:"零食(餅乾巧克力)" },
    { sym:"MO",   w:4.7,  zh:"奧馳亞",   desc:"菸草(美國)" },
    { sym:"CL",   w:4.5,  zh:"高露潔",   desc:"日用品／牙膏" },
    { sym:"PEP",  w:4.2,  zh:"百事",     desc:"飲料／零食" },
    { sym:"MNST", w:4.2,  zh:"怪獸飲料", desc:"能量飲料" },
  ],
  XLU: [
    { sym:"NEE", w:13.2, zh:"NextEra",  desc:"再生能源電力龍頭" },
    { sym:"SO",  w:7.4,  zh:"南方電力", desc:"區域電力公司" },
    { sym:"DUK", w:6.9,  zh:"杜克能源", desc:"區域電力公司" },
    { sym:"CEG", w:6.5,  zh:"Constellation", desc:"核電龍頭(AI 供電)" },
    { sym:"AEP", w:5.0,  zh:"美國電力", desc:"區域電力公司" },
    { sym:"SRE", w:4.2,  zh:"Sempra",   desc:"電力／天然氣" },
    { sym:"D",   w:4.2,  zh:"Dominion", desc:"區域電力公司" },
    { sym:"VST", w:3.7,  zh:"Vistra",   desc:"電力(含核電)" },
    { sym:"ETR", w:3.6,  zh:"Entergy",  desc:"區域電力公司" },
    { sym:"XEL", w:3.4,  zh:"Xcel",     desc:"區域電力公司" },
  ],
  XLRE: [
    { sym:"WELL", w:9.9, zh:"Welltower", desc:"醫療／長照 REIT" },
    { sym:"PLD",  w:9.2, zh:"Prologis",  desc:"物流倉儲 REIT" },
    { sym:"EQIX", w:7.2, zh:"Equinix",   desc:"資料中心 REIT" },
    { sym:"AMT",  w:6.0, zh:"美國電塔",  desc:"通訊基地台 REIT" },
    { sym:"SPG",  w:4.7, zh:"Simon",     desc:"購物中心 REIT" },
    { sym:"DLR",  w:4.6, zh:"Digital Realty", desc:"資料中心 REIT" },
    { sym:"PSA",  w:4.4, zh:"Public Storage", desc:"自助倉儲 REIT" },
    { sym:"VTR",  w:4.2, zh:"Ventas",    desc:"醫療／長照 REIT" },
    { sym:"CCI",  w:4.2, zh:"Crown Castle", desc:"通訊塔 REIT" },
    { sym:"O",    w:4.1, zh:"Realty Income", desc:"月配息零售 REIT" },
  ],
  XLB: [
    { sym:"LIN", w:14.1, zh:"林德",     desc:"工業氣體龍頭" },
    { sym:"NEM", w:7.3,  zh:"紐蒙特",   desc:"黃金礦業" },
    { sym:"NUE", w:6.3,  zh:"紐柯",     desc:"鋼鐵" },
    { sym:"FCX", w:5.7,  zh:"自由港",   desc:"銅礦" },
    { sym:"VMC", w:4.6,  zh:"火神材料", desc:"建材砂石" },
    { sym:"CRH", w:4.6,  zh:"CRH",      desc:"建材／水泥" },
    { sym:"APD", w:4.4,  zh:"空氣產品", desc:"工業氣體" },
    { sym:"STLD",w:4.4,  zh:"鋼動力",   desc:"鋼鐵" },
    { sym:"CTVA",w:4.3,  zh:"科迪華",   desc:"農業種子／農化" },
    { sym:"SHW", w:4.3,  zh:"宣偉",     desc:"塗料／油漆" },
  ],
  XLC: [
    { sym:"META",  w:14.0, zh:"Meta",    desc:"社群(FB／IG)／廣告" },
    { sym:"GOOGL", w:9.8,  zh:"谷歌 A",  desc:"搜尋／YouTube／雲端" },
    { sym:"GOOG",  w:7.8,  zh:"谷歌 C",  desc:"同 Alphabet(無投票權)" },
    { sym:"TTWO",  w:4.9,  zh:"Take-Two", desc:"遊戲(GTA／2K)" },
    { sym:"LYV",   w:4.8,  zh:"Live Nation", desc:"演唱會／票務" },
    { sym:"SATS",  w:4.6,  zh:"EchoStar", desc:"衛星通訊(Dish)" },
    { sym:"DIS",   w:4.5,  zh:"迪士尼",  desc:"媒體／娛樂／串流" },
    { sym:"WBD",   w:4.2,  zh:"華納兄弟探索", desc:"媒體／串流(HBO)" },
    { sym:"EA",    w:4.2,  zh:"美商藝電", desc:"遊戲(戰地／模擬市民)" },
    { sym:"OMC",   w:4.1,  zh:"宏盟",    desc:"廣告代理集團" },
  ],
};

const googleUrl = sym => `https://www.google.com/search?q=${encodeURIComponent(sym + " stock")}`;

async function loadSectorData() {
  await Promise.all(SECTOR_ETFS.map(async etf => {
    if (sectorLoaded[etf]) return;
    const resp = await fetch(`data/${etf}.json`, { cache: "no-cache" });
    if (!resp.ok) throw new Error(`${etf}: HTTP ${resp.status}`);
    const j = await resp.json();
    sectorLoaded[etf] = (j.data || []).map(r => [r.date, r.close]);
  }));
  // 持股名單/權重（自動抓的 JSON 優先，失敗則用硬編 fallback）
  if (!liveHoldings) {
    try {
      const r = await fetch("data/sector_holdings.json", { cache: "no-cache" });
      if (r.ok) liveHoldings = (await r.json()).data || null;
    } catch { /* keep fallback */ }
  }
}

function sectorReturn(data, nDays, ytd) {
  if (!data || data.length < 2) return null;
  const latest = data[data.length - 1][1];
  if (ytd) {
    const yearStart = data[data.length - 1][0].slice(0, 4) + "-01-01";
    const base = data.find(r => r[0] >= yearStart);
    return base ? (latest / base[1] - 1) * 100 : null;
  }
  if (data.length <= nDays) return null;
  const base = data[data.length - 1 - nDays][1];
  return base > 0 ? (latest / base - 1) * 100 : null;
}

function showHoldingsPopup(etf) {
  const holdings = (liveHoldings && liveHoldings[etf]) || SECTOR_HOLDINGS[etf];
  if (!holdings) return;
  sectorChart?.dispatchAction({ type: "hideTip" });
  document.getElementById("sector-pop")?.remove();

  const light = isLight();
  const bg  = light ? "#ffffff" : "#161b22";
  const bd  = light ? "#d0d7de" : "#30363d";
  const tx  = light ? "#1f2328" : "#e6edf3";
  const mut = light ? "#57606a" : "#8b949e";

  const rows = holdings.map(h => `
    <a href="${googleUrl(h.sym)}" target="_blank" rel="noopener noreferrer"
       style="display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-radius:8px;
              text-decoration:none;color:${tx};border:1px solid ${bd};margin-bottom:8px">
      <span style="flex-shrink:0;min-width:44px;font-weight:700;color:#3fb950;font-variant-numeric:tabular-nums">${h.w}%</span>
      <span style="line-height:1.5">
        <span style="font-weight:600">${h.sym}</span> <span style="color:${mut}">${h.zh}</span><br/>
        <span style="font-size:12px;color:${mut}">${h.desc}</span>
      </span>
      <span style="margin-left:auto;flex-shrink:0;color:${mut};font-size:12px;align-self:center">Google&nbsp;↗</span>
    </a>`).join("");

  const ov = document.createElement("div");
  ov.id = "sector-pop";
  ov.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.45);" +
    "display:flex;align-items:center;justify-content:center;padding:20px";
  ov.innerHTML =
    `<div style="background:${bg};border:1px solid ${bd};border-radius:12px;max-width:440px;width:100%;
                 max-height:82vh;overflow:auto;padding:18px 18px 14px;box-shadow:0 12px 40px rgba(0,0,0,.3)">
       <div style="display:flex;align-items:center;margin-bottom:12px">
         <div style="font-weight:700;font-size:16px;color:${tx}">${SECTOR_LABEL[etf]} · ${etf}
           <span style="font-weight:400;font-size:13px;color:${mut}">前十大持股</span></div>
         <button id="sector-pop-x" style="margin-left:auto;background:none;border:none;color:${mut};
           font-size:20px;cursor:pointer;line-height:1">✕</button>
       </div>
       ${rows}
       <div style="font-size:11px;color:${mut};margin-top:6px">點任一檔 → 開 Google 看股價 · 權重為 ETF 持股佔比</div>
     </div>`;
  document.body.appendChild(ov);

  const close = () => ov.remove();
  ov.addEventListener("click", e => { if (e.target === ov) close(); });
  document.getElementById("sector-pop-x").addEventListener("click", close);
  document.addEventListener("keydown", function esc(e) {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); }
  });
}

function bindChartClick() {
  if (!sectorChart) return;
  sectorChart.off("click");
  sectorChart.on("click", p => {
    const etf = curSortedETFs[p.value?.[0]];
    if (etf) showHoldingsPopup(etf);
  });
}

export async function renderSectorTab() {
  if (!sectorChart) return;
  const statusEl = document.getElementById("sector-status");
  statusEl.textContent = "載入中…";
  try { await loadSectorData(); } catch(e) { statusEl.textContent = `載入失敗：${e.message}`; return; }

  // Compute returns for each ETF × period
  const returns = {};
  for (const etf of SECTOR_ETFS) {
    returns[etf] = {};
    for (const p of SECTOR_PERIODS) {
      returns[etf][p] = p === "YTD"
        ? sectorReturn(sectorLoaded[etf], 0, true)
        : sectorReturn(sectorLoaded[etf], SECTOR_DAYS[p], false);
    }
  }

  // Sort ETFs by selected column
  const sortedETFs = [...SECTOR_ETFS].sort((a, b) => {
    const va = returns[a][sectorSortCol] ?? -Infinity;
    const vb = returns[b][sectorSortCol] ?? -Infinity;
    return vb - va;
  });
  curSortedETFs = sortedETFs;

  // ECharts heatmap: rows = periods, cols = ETFs (sorted)
  const heatData = [];
  for (let pi = 0; pi < SECTOR_PERIODS.length; pi++) {
    for (let ei = 0; ei < sortedETFs.length; ei++) {
      const v = returns[sortedETFs[ei]][SECTOR_PERIODS[pi]];
      heatData.push([ei, pi, v != null ? +v.toFixed(2) : null]);
    }
  }

  const maxAbs = heatData.reduce((m, d) => d[2] != null ? Math.max(m, Math.abs(d[2])) : m, 1);
  const tipBg   = tc("#161b22","#ffffff"), tipBdr = tc("#30363d","#d0d7de");
  const tipText = tc("#e6edf3","#1f2328"), axisClr = tc("#8b949e","#57606a");

  const xLabels = sortedETFs.map(e => mob() ? e : `${SECTOR_LABEL[e]}\n${e}`);

  sectorChart.setOption({
    backgroundColor: "transparent",
    tooltip: {
      trigger: "item", backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: tipText },
      formatter: p => {
        const v = p.value?.[2];
        const etf = sortedETFs[p.value?.[0]];
        const per = SECTOR_PERIODS[p.value?.[1]];
        if (v == null || !etf) return "";
        return `<b>${etf} ${SECTOR_LABEL[etf]}</b><br/>${per}: <b style="color:${v>=0?"#3fb950":"#f78166"}">${v>=0?"+":""}${v.toFixed(2)}%</b>`;
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
      axisLabel: { color: tipText, fontSize: 11, interval: 0 },
    },
    yAxis: {
      type: "category", data: SECTOR_PERIODS, splitArea: { show: true },
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

  const latest = SECTOR_ETFS.map(e => sectorLoaded[e]?.at(-1)?.[0]).filter(Boolean).sort().at(-1) ?? "—";
  statusEl.textContent = `美股11大產業 ETF · 以${sectorSortCol}排序 · 資料截至 ${latest} · 點任一格看前十大持股`;
}

export function activate() {
  const el = document.getElementById("sector-chart");
  if (!sectorChart) {
    sectorChart = echarts.init(el, isLight() ? null : "dark");
    bindChartClick();
  }
  setTimeout(() => { sectorChart.resize(); renderSectorTab(); }, 50);
}

export function onThemeChange(light) {
  if (!sectorChart) return;
  sectorChart.dispose();
  sectorChart = echarts.init(document.getElementById("sector-chart"), light ? null : "dark");
  bindChartClick();
  renderSectorTab();
}

export function resize() {
  sectorChart?.resize();
}

document.getElementById("sector-sort-picker")?.addEventListener("click", e => {
  const t = e.target.closest(".chip[data-sector-col]");
  if (!t) return;
  sectorSortCol = t.dataset.sectorCol;
  for (const c of e.currentTarget.querySelectorAll(".chip"))
    c.classList.toggle("active", c === t);
  renderSectorTab();
});
