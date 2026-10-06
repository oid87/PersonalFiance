// 經理人曝險 tab — NAAIM 經理人平均股票曝險 vs SPY/QQQ/SOXX 後續報酬/波動
//
// ground truth: Financial_work/naaim_exposure_study.py（baseline:
// Financial_work/_refactor_backup/baseline_naaim_exposure_study.txt，SPY/QQQ 逐格對拍）
//
// 核心結論（研究已完成，本 tab 只做視覺化，不重跑判斷邏輯）：
//   報酬面扣基率後 edge≈0（逐格反覆變號）；波動面 48/48 格方向一致且與直覺相反——
//   高曝險（滿倉）後續已實現波動反而「更低」，低曝險（減碼）後續反而「更高」。
//   合理解讀：NAAIM 是反應性指標（描述當下環境），不是預測性指標。
//
// 資料：data/bullbear.json 的 "naaim" key（週頻）+ data/SPY.json / QQQ.json / SOXX.json
// （皆未還原息日線）+ data/fear_greed.json（F&G，2011-01起日頻）+ data/VIX.json
// （VIX，2000起日頻）。全部前端 fetch 既有檔案，不新增資料管線。
//
// 2026-07-19 擴充三項純顯示功能（不動任何計算邏輯，逐項見下）：
//   ① F&G/VIX 疊加線（legend 開關，預設關閉）——F&G 只從 2011-01 起有資料，早於此的
//      NAAIM 樣本（2006-07起）沒有對應 F&G，series name 直接標注涵蓋起點，不補值。
//   ② NAAIM 百分位 forward-fill 成交易日階梯，只給圖表/tooltip 用；統計表/去重/
//      基率計算一律吃 computeForTickerPure() 回傳的原始週頻 pctRank ——
//      🚨 這條線是紅線：任何改動都不可讓 ffill 後的日頻值流入 evaluateGroup/
//      computeBaseline/dedupeSignals，否則一週的值會被當 5 個獨立交易日事件，
//      樣本數與基率全部失真（見對拍腳本 mismatches 必須仍為 0）。
//   ③ 時間範圍 1Y/2Y/3Y/全部——用 chart.dispatchAction({type:"dataZoom",...}) 調整顯示
//      視窗，不重跑 computeForTickerPure，統計表恆為全樣本。⚠️ 2026-07-19 修正：價格
//      軸（與 VIX 軸）的 min/max 必須依「目前選取範圍」重算，不能固定用全樣本極值——
//      NAAIM 樣本橫跨 20 年，全樣本極值差可達 90 倍（如 SOXX 7.79~655），縮到 1 年視窗
//      時價格線會被壓扁貼在軸的一端，看起來像一條死平線，等於看不出任何水位變化
//      （CLAUDE.md 圖表鐵則：人眼覺得圖不對就是有問題，不是美感偏好）。故切換範圍時
//      除了 dataZoom 也要重呼叫 render() 用可視窗內的 min/max 重算軸範圍。
//
// 計算與 python lab.py 對齊的三個關鍵點（逐項對照 naaim_exposure_study.py）：
//   1. 滾動百分位 = pandas `s.rolling(window,min_periods).rank(pct=True)*100`，
//      並非單純「count(x<=v)/n」——pandas rank 對「同一窗口內出現相同數值（ties）」
//      取平均名次，不是把全部同值都算最大名次。NAAIM mean 只有 2 位小數精度，
//      窗口內出現 tie 的機率不低（實測 942 個有效百分位中 13 個因 tie 導致
//      簡化版 count(<=v)/n 與精確 tie-averaged rank 差到 0.32pp，足以在門檻邊界
//      翻動事件是否入選），故本檔案精確重建 tie-averaged rank，不用
//      vixskew.js 的 cxRollingPctRank 簡化版（該檔案自己也在註解承認是簡化）。
//   2. 進場對齊 t0 = NAAIM 日期 + 2 天緩衝後第一個「嚴格大於」的交易日（見
//      findEntryDate）；遠期報酬起點是 t0，horizon 交易日數對照
//      python HORIZON_TD；已實現波動用 t0 起 td 個交易日日報酬 std（ddof=1，
//      對齊 pandas Series.std() 預設樣本標準差）× sqrt(252) × 100。
//   3. 基率母體 = 滾動百分位非 NaN 的 NAAIM 週（且該週要能對齊出 t0），不可用
//      全部 1045 週或全部交易日。

import { isLight, mob, PALETTE } from '../utils/theme.js';
import { requestJSON } from '../utils/data.js';
import { computeForTickerPure, ffillPctRankDaily } from './naaim_calc.mjs';
import { tsToLocalDate } from '../utils/dates.js';
import { bindOnce, chipPicker } from '../utils/dom.js';
export { rollingPctRank, findEntryDate, dedupeSignals, ffillPctRankDaily,
  fwdRet, realizedVol, computeForTickerPure } from './naaim_calc.mjs';

// ── 標的設定 ─────────────────────────────────────────────────────────
const TICKERS = [
  { key: "SPY",  label: "SPY",  file: "data/SPY.json",  color: "#58a6ff" },
  { key: "QQQ",  label: "QQQ",  file: "data/QQQ.json",  color: "#f778ba" },
  { key: "SOXX", label: "SOXX", file: "data/SOXX.json", color: "#22d3ee" },
];

// ── 疊加線設定（F&G/VIX，功能①）─────────────────────────────────────
const FG_NAME  = "F&G恐慌貪婪指數(2011起)";
const VIX_NAME = "VIX收盤價";
const FG_COLOR  = "#d2a8ff";
const VIX_COLOR = "#ffa657";

// ── 模組狀態 ─────────────────────────────────────────────────────────
let chart = null;
let ticker = "SPY";
let naaimDates = null;   // string[]，升冪
let naaimVals  = null;   // number[]，對齊 naaimDates
const priceCache  = {};  // tickerKey -> { dates, closes, dateIdx: Map }
const resultCache = {};  // tickerKey -> computeForTickerPure() 回傳值
let fgData  = null;      // { dates, vals } 2011-01起日頻
let vixData = null;      // { dates, closes } 2000起日頻
let showTable = true;
let rangeKey  = "ALL";   // "1Y" | "2Y" | "3Y" | "ALL"

// Pure research calculations are imported from naaim_calc.mjs.

// ── fetch / cache ────────────────────────────────────────────────────
async function loadNaaim(context = {}) {
  if (naaimDates) return;
  const j = await requestJSON("data/bullbear.json", { signal: context.signal });
  if (!Array.isArray(j?.naaim) || !j.naaim.length) throw new Error("bullbear.json: missing naaim rows");
  if (!j.naaim.every(r => typeof r?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date) &&
      Number.isFinite(r.mean))) throw new Error('bullbear.json: invalid NAAIM row');
  const rows = j.naaim.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  if (context.signal?.aborted || (context.isCurrent && !context.isCurrent())) return;
  naaimDates = rows.map(r => r.date);
  naaimVals = rows.map(r => +r.mean);
}

async function loadPrice(key, context = {}) {
  if (priceCache[key]) return priceCache[key];
  const t = TICKERS.find(x => x.key === key);
  const j = await requestJSON(t.file, { signal: context.signal });
  if (!Array.isArray(j?.data) || !j.data.length) throw new Error(`${t.file}: missing price rows`);
  if (!j.data.every(r => typeof r?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date) &&
      Number.isFinite(r.close) && r.close > 0)) throw new Error(`${t.file}: invalid price row`);
  const rows = j.data.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  const dates = rows.map(x => x.date);
  const closes = rows.map(x => +x.close);
  const dateIdx = new Map(dates.map((d, i) => [d, i]));
  const entry = { dates, closes, dateIdx };
  if (context.signal?.aborted || (context.isCurrent && !context.isCurrent())) return null;
  priceCache[key] = entry;
  return entry;
}

async function loadFG(context = {}) {
  if (fgData) return fgData;
  const j = await requestJSON("data/fear_greed.json", { signal: context.signal });
  if (!Array.isArray(j?.data) || !j.data.length) throw new Error("fear_greed.json: missing data rows");
  if (!j.data.every(r => typeof r?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date) &&
      Number.isFinite(r.value))) throw new Error('fear_greed.json: invalid value row');
  const rows = j.data.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  if (context.signal?.aborted || (context.isCurrent && !context.isCurrent())) return null;
  fgData = { dates: rows.map(x => x.date), vals: rows.map(x => +x.value) };
  return fgData;
}

async function loadVIX(context = {}) {
  if (vixData) return vixData;
  const j = await requestJSON("data/VIX.json", { signal: context.signal });
  if (!Array.isArray(j?.data) || !j.data.length) throw new Error("VIX.json: missing data rows");
  if (!j.data.every(r => typeof r?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date) &&
      Number.isFinite(r.close) && r.close > 0)) throw new Error('VIX.json: invalid close row');
  const rows = j.data.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  if (context.signal?.aborted || (context.isCurrent && !context.isCurrent())) return null;
  vixData = { dates: rows.map(x => x.date), closes: rows.map(x => +x.close) };
  return vixData;
}

async function computeForTicker(key, context = {}) {
  if (resultCache[key]) return resultCache[key];
  await loadNaaim(context);
  if (context.signal?.aborted || (context.isCurrent && !context.isCurrent())) return null;
  const price = await loadPrice(key, context);
  if (context.signal?.aborted || (context.isCurrent && !context.isCurrent())) return null;
  const result = computeForTickerPure({
    naaimDates, naaimVals,
    priceDates: price.dates, priceCloses: price.closes,
  });
  resultCache[key] = result;
  return result;
}

// ── 格式化 ───────────────────────────────────────────────────────────
function fmtPP(v) { return v == null ? "N/A" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}`; }
function fmtPct(v) { return v == null ? "N/A" : `${v.toFixed(1)}%`; }

const pxLog = v => Math.log10(v);
const pxUnlog = v => Math.pow(10, v);

// ── 表格 ─────────────────────────────────────────────────────────────
function renderTable(result) {
  const host = document.getElementById("naaim-table");
  if (!host) return;
  const horizons = [1, 4, 13, 26];
  const thead = `
    <thead>
      <tr>
        <th rowspan="2">門檻</th><th rowspan="2">方向</th>
        <th rowspan="2">去重前</th><th rowspan="2">去重後</th><th rowspan="2">樣本</th>
        ${horizons.map(h => `<th colspan="3">${h}週</th>`).join("")}
      </tr>
      <tr>
        ${horizons.map(() => `<th>報酬差(pp)</th><th>波動差(pp)</th><th>勝率</th>`).join("")}
      </tr>
    </thead>`;
  const rows = result.groups.map(g => {
    const rowStyle = g.warn ? ' style="background:rgba(248,81,73,.08)"' : "";
    const cells = horizons.map(h => {
      const c = g.byHorizon[h];
      return `<td>${fmtPP(c.retDiff)}</td><td>${fmtPP(c.volDiff)}</td><td>${fmtPct(c.winrate)}</td>`;
    }).join("");
    const sampleTag = g.warn
      ? `<span style="color:#f85149;font-weight:600">⚠️ 樣本不足</span>`
      : `<span style="color:#3fb950">✓</span>`;
    return `<tr${rowStyle}>
      <td>${g.direction === "高曝險" ? "≥" : "≤"}${g.threshold}</td>
      <td>${g.direction}</td>
      <td>${g.nPre}</td>
      <td>${g.nPost}</td>
      <td>${sampleTag}</td>
      ${cells}
    </tr>`;
  }).join("");
  host.innerHTML = `<table class="info-table">${thead}<tbody>${rows}</tbody></table>`;
}

// ── 主圖 ─────────────────────────────────────────────────────────────
function render(key, result) {
  if (!chart) return;
  const t = TICKERS.find(x => x.key === key);
  const price = priceCache[key];

  const axisClr = PALETTE.muted;
  const gridClr = PALETTE.grid;
  const tipBg   = PALETTE.bg;
  const tipBdr  = PALETTE.border;
  const textClr = PALETTE.text2;

  // x 軸限縮到 NAAIM 樣本期間（2006-07 起）——不是裁資料，是限縮研究期間；
  // 前段 SPY/QQQ/SOXX 有資料但 NAAIM 沒有，畫出來只會壓縮真正要看的區段。
  const naaimStart = naaimDates[0];
  const priceRows = [];
  for (let i = 0; i < price.dates.length; i++) {
    if (price.dates[i] >= naaimStart) priceRows.push([price.dates[i], pxLog(price.closes[i])]);
  }
  // 軸範圍只用「目前選取範圍的可視窗」內的資料算，不是全樣本——見檔頭 2026-07-19
  // 修正說明。visibleWindowStart 在檔案後段定義（function 宣告會 hoist，此處呼叫合法）。
  const latestPriceDate = priceRows.length ? priceRows[priceRows.length - 1][0] : naaimStart;
  const winStart = visibleWindowStart(naaimStart, latestPriceDate, rangeKey);
  const priceRowsInWindow = priceRows.filter(r => r[0] >= winStart);
  const priceValsAll = priceRows.map(r => pxUnlog(r[1]));  // 還原成價格；全樣本，範圍為空時的 fallback
  const priceValsWin = priceRowsInWindow.length ? priceRowsInWindow.map(r => pxUnlog(r[1])) : priceValsAll;
  const priceMin = Math.min(...priceValsWin), priceMax = Math.max(...priceValsWin);

  // 功能②：forward-fill 成交易日階梯，x 用跟 priceRows 同一份日期陣列，保證每個
  // 交易日 hover 都能同時對到價格與 NAAIM 兩條線（見 ffillPctRankDaily 註解）。
  // 純顯示用，不流入任何統計計算。
  const priceDatesTrimmed = priceRows.map(r => r[0]);
  const pctFill = ffillPctRankDaily(priceDatesTrimmed, naaimDates, result.pctRank, result.entryMap);
  const pctSeries = priceDatesTrimmed.map((d, i) => {
    const f = pctFill[i];
    return f ? [d, f.pct, f.isOriginal ? 1 : 0, f.naaimDate] : [d, null];
  });

  // 功能①：F&G/VIX 疊加線資料（限縮到 naaimStart 起，與價格線同一個顯示視窗）。
  const fgRows  = fgData  ? fgData.dates.map((d, i) => [d, fgData.vals[i]]).filter(r => r[0] >= naaimStart) : [];
  const vixRows = vixData ? vixData.dates.map((d, i) => [d, vixData.closes[i]]).filter(r => r[0] >= naaimStart) : [];
  // VIX 自己一條軸（不與 F&G 共用左軸的 0~100 百分位域，也不與價格對數軸共用）——
  // VIX 是原始波動率點數（近年多在 10~40，危機期可達 80+），跟百分位/價格是不同單位，
  // 共軸會讓讀者誤把它當同一把尺讀；獨立軸 + 專屬顏色最不容易誤讀。
  // 同理：VIX 軸也依可視窗重算（20 年全樣本的 VIX 範圍約 9~80+，1 年視窗內若剛好是
  // 平靜期會被全樣本極值壓成平線）；視窗內若沒有 VIX 資料才退回全樣本 min/max。
  const vixRowsInWindow = vixRows.filter(r => r[0] >= winStart);
  const vixValsAll = vixRows.map(r => r[1]);
  const vixVals = vixRowsInWindow.length ? vixRowsInWindow.map(r => r[1]) : vixValsAll;
  const vixLo = vixVals.length ? Math.min(...vixVals) : 0;
  const vixHi = vixVals.length ? Math.max(...vixVals) : 100;
  const vixPad = (vixHi - vixLo) * 0.1 || 1;
  const vixAxisMin = Math.max(0, Math.floor(vixLo - vixPad));
  const vixAxisMax = Math.ceil(vixHi + vixPad);

  const markerRows = result.high80Deduped
    .map(d => result.entryMap.get(d))
    .filter(t0 => t0 != null && price.dateIdx.has(t0))
    .map(t0 => [t0, pxLog(price.closes[price.dateIdx.get(t0)])]);

  chart.setOption({
    backgroundColor: "transparent", animation: false,
    tooltip: {
      trigger: "axis",
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        // xAxis.type:"time" 的 axisValue 是毫秒 timestamp，不是日期字串，要用
        // tsToLocalDate 轉回本地曆日顯示（見 add-tab skill 的 ECharts 眉角）。
        const raw = params[0]?.axisValue;
        const d = raw != null ? tsToLocalDate(raw) : "";
        let html = `<div style="font-weight:600;margin-bottom:4px">${d}</div>`;
        for (const p of params) {
          const v = Array.isArray(p.value) ? p.value[1] : p.value;
          if (v == null) continue;
          if (p.seriesName.includes("百分位")) {
            // value = [date, pct, isOriginal(1/0), naaimDate]（見 ffillPctRankDaily）。
            // isOriginal=0 代表這天不是調查日本身、是沿用上一次公布值的階梯延伸。
            const isOriginal = Array.isArray(p.value) && p.value[2] === 1;
            const naaimDate  = Array.isArray(p.value) ? p.value[3] : null;
            const tag = !isOriginal && naaimDate ? `（沿用 ${naaimDate.slice(5)} 公布值）` : "";
            html += `<div>${p.marker}${p.seriesName}: <b>${v.toFixed(1)}</b>${tag}</div>`;
          } else if (p.seriesName.includes(t.label)) {
            html += `<div>${p.marker}${p.seriesName}: <b>${pxUnlog(v).toFixed(2)}</b></div>`;  // y 存 log10，還原
          } else if (p.seriesName === FG_NAME) {
            html += `<div>${p.marker}${p.seriesName}: <b>${v.toFixed(0)}</b></div>`;
          } else if (p.seriesName === VIX_NAME) {
            html += `<div>${p.marker}${p.seriesName}: <b>${v.toFixed(2)}</b></div>`;
          }
        }
        return html;
      },
    },
    legend: {
      data: ["NAAIM 滾動百分位(156週)", `${t.label} 收盤價(未還原息)`, "高曝險(≥80,去重後)事件", FG_NAME, VIX_NAME],
      // F&G/VIX 預設關閉（功能①要求）——本圖主線是 NAAIM 百分位與價格，四條線全開
      // 會糊成一片（CLAUDE.md 圖表鐵則②），點 legend 上的名字即可開關。
      selected: { [FG_NAME]: false, [VIX_NAME]: false },
      top: 4, textStyle: { color: textClr, fontSize: 11 },
    },
    grid: { left: mob() ? 44 : 56, right: mob() ? 56 : 128, top: 64, bottom: mob() ? 60 : 48 },
    xAxis: {
      type: "time", min: naaimStart,
      axisLine: { lineStyle: { color: axisClr } }, axisTick: { show: false },
      axisLabel: { color: axisClr, fontSize: 11 }, splitLine: { show: false },
    },
    yAxis: [
      {
        type: "value", min: 0, max: 100, name: "NAAIM 百分位",
        nameTextStyle: { color: axisClr, fontSize: 10 },
        axisLabel: { color: axisClr, fontSize: 11 },
        axisLine: { show: false }, axisTick: { show: false },
        splitLine: { lineStyle: { color: gridClr } },
      },
      {
        type: "value", name: `${t.label}（log 刻度）`, position: "right",
        nameTextStyle: { color: t.color, fontSize: 10 },
        // 軸值是 log10(價格) 畫在線性軸上，標籤再 pxUnlog 還原成價格。
        // 為什麼不用 type:"log"：ECharts 5.5 的 log 軸只挑 10 的整數次方當刻度，且
        // axisLabel.customValues 與 interval **兩者實測皆被忽略**（不報錯，靜默無效），
        // 結果整條軸只印得出 min/max/10^n 三個標（SPY 是 61/100/836），100→836 中間
        // 一片空白看不出水位。改成線性軸後 splitNumber 生效，得到 √10 階梯
        // （7/10/32/100/316/721 這種），雖非整數但均勻可讀，價格水位一眼看得出來。
        // ⚠️ customValues 在 value 軸上同樣無效（試過，渲染出的仍是 echarts 自己的階梯），
        //    所以這裡不設，避免留下看似有作用實則死碼的設定。
        min: pxLog(priceMin * 0.9), max: pxLog(priceMax * 1.1),
        splitNumber: 6,
        axisLabel: { color: t.color, fontSize: 10,
                     formatter: v => {
                       const px = pxUnlog(v);
                       return (px >= 100 ? Math.round(px) : px.toFixed(px >= 10 ? 0 : 1)).toLocaleString();
                     } },
        axisLine: { lineStyle: { color: t.color } }, splitLine: { show: false },
      },
      {
        // VIX 專屬第三軸（功能①）。預設 show:false 跟隨 legend.selected[VIX_NAME] 的
        // 預設關閉狀態；legendselectchanged 監聽（見 bindLegendHandler）動態同步顯示，
        // 避免使用者關掉 VIX 線後右側還留一條沒有線對應的空軸。
        type: "value", name: "VIX", position: "right",
        offset: mob() ? 0 : 56, show: false,
        min: vixAxisMin, max: vixAxisMax,
        nameTextStyle: { color: VIX_COLOR, fontSize: 10 },
        axisLabel: { color: VIX_COLOR, fontSize: 10 },
        axisLine: { lineStyle: { color: VIX_COLOR } }, splitLine: { show: false },
      },
    ],
    dataZoom: [{ type: "inside", filterMode: "none" }, { type: "slider", height: 16, bottom: 4 }],
    series: [
      {
        name: "NAAIM 滾動百分位(156週)", type: "line", data: pctSeries,
        // 百分位是週頻 20 年、天然在 0~100 間高頻震盪，在寬圖上會變成滿版尖刺並蓋掉
        // 價格主線（CLAUDE.md 圖表鐵則②：雜訊線不可蓋掉主線）。降到最底層 + 細線 + 低不透明度
        // 當背景脈絡；真正要對照的價格線提到最上層。這是顯示層權重調整，不裁任何資料。
        yAxisIndex: 0, symbol: "none", connectNulls: false, z: 1,
        lineStyle: { color: "#e3b341", width: 0.9, opacity: 0.55 },
        markLine: {
          silent: true, symbol: "none",
          data: [
            { yAxis: 80, lineStyle: { color: "#f85149", type: "dashed", width: 1.4 },
              label: { formatter: "高曝險門檻 80", color: "#f85149", fontSize: 10, position: "insideEndTop" } },
            { yAxis: 20, lineStyle: { color: "#3fb950", type: "dashed", width: 1.4 },
              label: { formatter: "低曝險門檻 20", color: "#3fb950", fontSize: 10, position: "insideEndBottom" } },
          ],
        },
      },
      {
        name: `${t.label} 收盤價(未還原息)`, type: "line", data: priceRows,
        yAxisIndex: 1, symbol: "none", z: 3,
        lineStyle: { color: t.color, width: 1.8, opacity: 1 },
      },
      {
        name: "高曝險(≥80,去重後)事件", type: "scatter", data: markerRows,
        yAxisIndex: 1, symbolSize: 9, z: 4,
        itemStyle: { color: "#f85149", borderColor: PALETTE.bg, borderWidth: 1 },
      },
      {
        // F&G 與 NAAIM 百分位同域(0~100)，共用左軸(yAxisIndex 0)；2011-01 前無資料，
        // connectNulls:false 讓它斷線而非補值或連到 0（功能①的涵蓋缺口要求）。
        name: FG_NAME, type: "line", data: fgRows,
        yAxisIndex: 0, symbol: "none", connectNulls: false, z: 2,
        lineStyle: { color: FG_COLOR, width: 1.1, opacity: 0.85 },
      },
      {
        name: VIX_NAME, type: "line", data: vixRows,
        yAxisIndex: 2, symbol: "none", connectNulls: false, z: 2,
        lineStyle: { color: VIX_COLOR, width: 1.1, opacity: 0.85 },
      },
    ],
  }, { notMerge: true });
}

// 功能③：時間範圍 1Y/2Y/3Y/全部。尾端固定用「該標的資料最新日」往回推 N 年，
// 不是固定年份也不是瀏覽器 new Date()（資料可能落後今天，anchor 要用資料本身的
// 最後一天，跟圖表右緣一致）。只動 dataZoom 顯示視窗，不重算任何統計。
// dates.presetStart 是「往回 N 年」但錨在瀏覽器 new Date()（今天），這裡要求錨在
// 「該標的資料最後一天」（資料可能落後今天），兩者語意不同不能互換；與 findEntryDate
// 同款 UTC 錨定曆日加法（見該函式註解），非 tsToLocalDate 的場景（後者是 ECharts
// axisValue timestamp 還原顯示字串，不是曆日往回推運算）。
function yearsBeforeAnchor(anchorDate, n) {
  const d = new Date(anchorDate + "T00:00:00Z");
  d.setUTCFullYear(d.getUTCFullYear() - n);
  // check_reuse: keep — UTC 錨定曆日往回推 N 年，錨點是資料最後一天非 new Date()，與 dates.presetStart/cutoffDate 語意不同
  return d.toISOString().slice(0, 10);
}

// 目前選取範圍的可視窗起點：ALL 用 NAAIM 樣本起點，否則錨定「該標的資料最後一天」
// 往回推 N 年（與 applyRangeZoom 用同一套 anchor，兩者必須一致，不然軸範圍跟
// dataZoom 顯示的區間會對不上）。render() 用它來把價格/VIX 軸縮到可視窗內。
function visibleWindowStart(naaimStart, latest, key) {
  if (key === "ALL") return naaimStart;
  const n = { "1Y": 1, "2Y": 2, "3Y": 3 }[key];
  if (n == null) return naaimStart;
  const cand = yearsBeforeAnchor(latest, n);
  return cand > naaimStart ? cand : naaimStart;
}

function applyRangeZoom() {
  if (!chart) return;
  const price = priceCache[ticker];
  if (!price || !price.dates.length) return;
  const latest = price.dates[price.dates.length - 1];
  if (rangeKey === "ALL") {
    chart.dispatchAction({ type: "dataZoom", start: 0, end: 100 });
    return;
  }
  const n = { "1Y": 1, "2Y": 2, "3Y": 3 }[rangeKey];
  if (n == null) return;
  chart.dispatchAction({ type: "dataZoom", startValue: yearsBeforeAnchor(latest, n), endValue: latest });
}

// legendselectchanged 只綁一次（每次 echarts.init 後）；render() 用 notMerge:true
// 整份换 option，個別 setOption merge 呼叫不會被下一次 render 疊加成重複監聽。
function bindLegendHandler() {
  if (!chart) return;
  chart.off("legendselectchanged");
  chart.on("legendselectchanged", (params) => {
    // 動態同步 VIX 第三軸的顯示/隱藏，避免關掉 VIX 線後右側留一條沒有線對應的空軸。
    chart.setOption({ yAxis: [{}, {}, { show: !!params.selected[VIX_NAME] }] });
  });
}

function renderStatus(key, result) {
  const status = document.getElementById("naaim-status");
  if (!status) return;
  const validPct = result.pctRank.filter(v => v != null).length;
  const lastIdx = naaimDates.length - 1;
  const lastPct = result.pctRank[lastIdx];
  status.textContent = `${key} · NAAIM 原始樣本 ${naaimDates.length} 週(${naaimDates[0]}~${naaimDates[lastIdx]}) · `
    + `滾動百分位有效樣本 ${validPct} 週 · 最新百分位 ${lastPct != null ? lastPct.toFixed(1) : "N/A"}`
    + `（原始值 ${naaimVals[lastIdx].toFixed(2)}%）`;
}

let refreshVersion = 0;
async function refresh(context = {}) {
  const status = document.getElementById("naaim-status");
  const version = ++refreshVersion;
  const key = ticker;
  try {
    const [result] = await Promise.all([computeForTicker(key, context), loadFG(context), loadVIX(context)]);
    if (version !== refreshVersion || context.signal?.aborted || (context.isCurrent && !context.isCurrent())) return;
    render(key, result);
    renderTable(result);
    renderStatus(key, result);
    applyRangeZoom();
  } catch (e) {
    if (version !== refreshVersion) return;
    if (status) status.textContent = `載入失敗：${e.message}`;
    if (context.signal || context.isCurrent) throw e;
  }
}

function buildControls() {
  const host = document.getElementById("naaim-ticker-picker");
  if (bindOnce(host)) {
    host.innerHTML = TICKERS.map(t =>
      `<span class="chip${t.key === ticker ? " active" : ""}" data-naaim-ticker="${t.key}">${t.label}</span>`
    ).join("");
    chipPicker(host, "naaim-ticker", v => { ticker = v; refresh(); });
  }

  // 功能③：時間範圍 chips。不重跑 computeForTicker/不重算統計表（仍為全樣本），
  // 但要重呼叫 render()——價格/VIX 軸的 min/max 依可視窗重算（見檔頭 2026-07-19
  // 修正說明），資料本身沿用 resultCache，不重算，所以這裡是便宜的重繪。
  const rangeHost = document.getElementById("naaim-range-picker");
  chipPicker(rangeHost, "naaim-range", v => {
    rangeKey = v;
    if (resultCache[ticker]) render(ticker, resultCache[ticker]);
    applyRangeZoom();  // render() 是 notMerge:true 會重置 dataZoom，範圍要在其後重套
  });

  // 功能①末段：統計表顯示/隱藏開關。只切 display，不重算。
  const tableToggle = document.getElementById("naaim-table-toggle");
  if (bindOnce(tableToggle)) {
    tableToggle.addEventListener("click", () => {
      showTable = !showTable;
      tableToggle.classList.toggle("active", showTable);
      const wrap = document.getElementById("naaim-table-wrap");
      if (wrap) wrap.style.display = showTable ? "" : "none";
    });
  }
}

// ── lifecycle ────────────────────────────────────────────────────────
export async function init(context = {}) {
  const host = document.getElementById("naaim-chart");
  if (!host) return;
  if (!chart) { chart = echarts.init(host, isLight() ? null : "dark"); bindLegendHandler(); }
  buildControls();
  await refresh(context);
}

export function onThemeChange(light) {
  if (!chart) return;
  chart.dispose();
  chart = echarts.init(document.getElementById("naaim-chart"), light ? null : "dark");
  bindLegendHandler();
  if (resultCache[ticker]) {
    render(ticker, resultCache[ticker]);
    renderTable(resultCache[ticker]);
    applyRangeZoom();
  }
}

export function resize() { chart?.resize(); }

export function getCharts() { return chart ? [chart] : []; }
