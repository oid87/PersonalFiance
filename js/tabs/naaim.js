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
// （皆未還原息日線）。全部前端 fetch 既有檔案，不新增資料管線。
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
import { mean, std } from '../utils/math.js';
import { tsToLocalDate } from '../utils/dates.js';

// ── 標的設定 ─────────────────────────────────────────────────────────
const TICKERS = [
  { key: "SPY",  label: "SPY",  file: "data/SPY.json",  color: "#58a6ff" },
  { key: "QQQ",  label: "QQQ",  file: "data/QQQ.json",  color: "#f778ba" },
  { key: "SOXX", label: "SOXX", file: "data/SOXX.json", color: "#22d3ee" },
];

// ── 研究參數（逐項對齊 Financial_work/naaim_exposure_study.py）────────
const NAAIM_WINDOW      = 156;  // 週
const NAAIM_MIN_PERIODS = 104;  // 週
const HORIZON_TD    = { 1: 5, 4: 20, 13: 65, 26: 130 };
const HIGH_THRESHOLDS = [80, 90, 95];
const LOW_THRESHOLDS  = [20, 10, 5];
const DEDUPE_GAP_DAYS = 90;
const MIN_SAMPLE_WARN = 20;

// ── 模組狀態 ─────────────────────────────────────────────────────────
let chart = null;
let ticker = "SPY";
let naaimDates = null;   // string[]，升冪
let naaimVals  = null;   // number[]，對齊 naaimDates
const priceCache  = {};  // tickerKey -> { dates, closes, dateIdx: Map }
const resultCache = {};  // tickerKey -> computeForTickerPure() 回傳值

// ── 純計算函式（無 DOM/fetch 依賴，供 tab 本身與 node 對拍腳本共用）───

// pandas `.rolling(window, min_periods).rank(pct=True) * 100` 精確重建：
// 視窗內 tie（同值）取平均名次，不是簡化的 count(x<=v)/n。
// check_reuse: keep — 與 js/utils/math.js 的 percentileRank(val, sortedAsc) 是不同演算法
// （靜態全陣列、count(x<val)/len、無 tie 平均），也與 vixskew.js 的 cxRollingPctRank
// 是不同演算法（該函式自己註解承認是簡化版 count(x<=v)/n，未做 tie 平均）。
// 本函式是本 tab 唯一需要「與 pandas rolling.rank(pct=True) bit-exact」的用途，
// 换成上述任一簡化版都會在門檻邊界（如 79.7 vs 80.2）造成事件是否入選的差異。
export function rollingPctRank(vals, window, minPeriods) {
  const n = vals.length;
  const out = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const start = Math.max(0, i - window + 1);
    const w = i - start + 1;
    if (w < minPeriods) continue;
    const v = vals[i];
    let less = 0, equal = 0;
    for (let j = start; j <= i; j++) {
      if (vals[j] < v) less++;
      else if (vals[j] === v) equal++;
    }
    const rank = less + (equal + 1) / 2;
    out[i] = (rank / w) * 100;
  }
  return out;
}

// t0 = naaimDate + 2 天緩衝後，第一個嚴格大於該緩衝日的交易日。
// 對齊 python find_entry_date：candidates = price_index[price_index > naaim_date + 2天]。
export function findEntryDate(priceDatesAsc, naaimDate) {
  const d = new Date(naaimDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 2);
  // 不是 dates.tsToLocalDate 的場景：tsToLocalDate 是把 ECharts 本地午夜 axisValue
  // timestamp 轉回顯示用日期字串（依瀏覽器時區）；這裡要做的是 UTC 錨定的曆日加法，
  // 逐字對齊 python pd.Timestamp + pd.Timedelta(days=2)（timezone-naive，等同 UTC
  // 正規化）。換成 tsToLocalDate 會依瀏覽器時區位移計算出的曆日，在 UTC-負offset 地區
  // （如美洲）可能把 cutoff 往前推一天，破壞已用 node 腳本對拍
  // baseline_naaim_exposure_study.txt 驗證過的 bit-exact 結果。dates.presetStart 也
  // 不適用：它是「往回 N 年」的 range cutoff，不是「往前 N 天」的日期加法。
  // check_reuse: keep — UTC 錨定曆日加法，需與 python pd.Timestamp+Timedelta bit-exact，非顯示格式化
  const cutoff = d.toISOString().slice(0, 10);
  let lo = 0, hi = priceDatesAsc.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (priceDatesAsc[mid] <= cutoff) lo = mid + 1; else hi = mid;
  }
  return lo < priceDatesAsc.length ? priceDatesAsc[lo] : null;
}

// 同 python lab.dedupe_signals(dates, gap_days=90)：排序後與前一保留訊號相差
// <gapDays 曆日則跳過。
// check_reuse: keep — 與 vixskew.js 的 cxDedupeSignals 演算法相同但該函式是
// module-private（未 export），且本檔案操作的是日期字串陣列而非索引陣列；
// spec 範圍只做本 tab，不做跨檔抽公用函式的 refactor。
export function dedupeSignals(datesAsc, gapDays) {
  const out = [];
  let lastMs = null;
  for (const d of datesAsc) {
    const ms = Date.parse(d + "T00:00:00Z");
    if (lastMs === null || (ms - lastMs) / 86400000 >= gapDays) {
      out.push(d);
      lastMs = ms;
    }
  }
  return out;
}

// 對齊 python lab.fwd_ret：future = price[index>dt]；不足 td 筆回 null；
// 取 future 的第 td 筆（0-index td-1），單筆四捨五入到小數 2 位（python 端
// 也是逐筆 round(...,2) 後才平均，逐筆對齊才能讓平均值與 baseline 對拍到 0.01pp內）。
export function fwdRet(closes, idx0, td) {
  if (idx0 == null) return null;
  if (idx0 + td >= closes.length) return null;
  const v = (closes[idx0 + td] / closes[idx0] - 1) * 100;
  return Math.round(v * 100) / 100;
}

// 對齊 python realized_vol：t0 起 td 個交易日日報酬，std（ddof=1，對齊 pandas
// Series.std() 預設樣本標準差）× sqrt(252) × 100。
export function realizedVol(closes, idx0, td) {
  if (idx0 == null) return null;
  if (idx0 + td >= closes.length) return null;
  const rets = [];
  for (let i = idx0; i < idx0 + td; i++) rets.push(closes[i + 1] / closes[i] - 1);
  if (rets.length < 2) return null;
  const s = std(rets, 1);
  return s == null ? null : s * Math.sqrt(252) * 100;
}

function computeBaseline(baseDates, entryMap, dateIdx, closes) {
  const baseline = {};
  for (const [weeksStr, td] of Object.entries(HORIZON_TD)) {
    const weeks = Number(weeksStr);
    const rets = [], vols = [];
    for (const d of baseDates) {
      const t0 = entryMap.get(d);
      const idx0 = dateIdx.get(t0);
      const r = fwdRet(closes, idx0, td);
      if (r != null) rets.push(r);
      const v = realizedVol(closes, idx0, td);
      if (v != null) vols.push(v);
    }
    baseline[weeks] = {
      meanRet: rets.length ? mean(rets) : null,
      meanVol: vols.length ? mean(vols) : null,
      n: rets.length,
    };
  }
  return baseline;
}

function evaluateGroup(datesPreDedupe, entryMap, dateIdx, closes, baseline, direction, threshold) {
  const nPre = datesPreDedupe.length;
  const deduped = dedupeSignals(datesPreDedupe.slice().sort(), DEDUPE_GAP_DAYS);
  const nPost = deduped.length;
  const warn = nPost < MIN_SAMPLE_WARN;
  const byHorizon = {};
  for (const [weeksStr, td] of Object.entries(HORIZON_TD)) {
    const weeks = Number(weeksStr);
    const rets = [], vols = [];
    for (const d of deduped) {
      const t0 = entryMap.get(d);
      const idx0 = dateIdx.get(t0);
      const r = fwdRet(closes, idx0, td);
      if (r != null) rets.push(r);
      const v = realizedVol(closes, idx0, td);
      if (v != null) vols.push(v);
    }
    const meanRet = rets.length ? mean(rets) : null;
    const meanVol = vols.length ? mean(vols) : null;
    const winrate = rets.length ? (rets.filter(r => r > 0).length / rets.length) * 100 : null;
    const b = baseline[weeks];
    byHorizon[weeks] = {
      meanRet, meanVol, winrate,
      retDiff: (meanRet != null && b.meanRet != null) ? meanRet - b.meanRet : null,
      volDiff: (meanVol != null && b.meanVol != null) ? meanVol - b.meanVol : null,
      n: rets.length,
    };
  }
  return { direction, threshold, nPre, nPost, warn, deduped, byHorizon };
}

// 純計算入口：只吃平行陣列，無 fetch/DOM 依賴 —— 可在瀏覽器（本 tab）與 node
// 對拍腳本（比對 Financial_work baseline_naaim_exposure_study.txt）共用同一份邏輯。
export function computeForTickerPure({ naaimDates, naaimVals, priceDates, priceCloses }) {
  const pctRank = rollingPctRank(naaimVals, NAAIM_WINDOW, NAAIM_MIN_PERIODS);
  const entryMap = new Map();
  for (const d of naaimDates) {
    const t0 = findEntryDate(priceDates, d);
    if (t0 != null) entryMap.set(d, t0);
  }
  const dateIdx = new Map(priceDates.map((d, i) => [d, i]));

  const baseDates = [];
  for (let i = 0; i < naaimDates.length; i++) {
    if (pctRank[i] != null && entryMap.has(naaimDates[i])) baseDates.push(naaimDates[i]);
  }
  const baseline = computeBaseline(baseDates, entryMap, dateIdx, priceCloses);

  const groups = [];
  let high80Deduped = [];
  for (const thr of HIGH_THRESHOLDS) {
    const datesPre = [];
    for (let i = 0; i < naaimDates.length; i++) {
      if (pctRank[i] != null && pctRank[i] >= thr && entryMap.has(naaimDates[i])) datesPre.push(naaimDates[i]);
    }
    const g = evaluateGroup(datesPre, entryMap, dateIdx, priceCloses, baseline, "高曝險", thr);
    groups.push(g);
    if (thr === 80) high80Deduped = g.deduped;
  }
  for (const thr of LOW_THRESHOLDS) {
    const datesPre = [];
    for (let i = 0; i < naaimDates.length; i++) {
      if (pctRank[i] != null && pctRank[i] <= thr && entryMap.has(naaimDates[i])) datesPre.push(naaimDates[i]);
    }
    const g = evaluateGroup(datesPre, entryMap, dateIdx, priceCloses, baseline, "低曝險", thr);
    groups.push(g);
  }
  return { pctRank, entryMap, baseline, groups, high80Deduped, dateIdx };
}

// ── fetch / cache ────────────────────────────────────────────────────
async function loadNaaim() {
  if (naaimDates) return;
  const r = await fetch("data/bullbear.json", { cache: "no-cache" });
  if (!r.ok) throw new Error(`bullbear.json: HTTP ${r.status}`);
  const j = await r.json();
  const rows = (j.naaim || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  naaimDates = rows.map(r => r.date);
  naaimVals  = rows.map(r => +r.mean);
}

async function loadPrice(key) {
  if (priceCache[key]) return priceCache[key];
  const t = TICKERS.find(x => x.key === key);
  const r = await fetch(t.file, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${t.file}: HTTP ${r.status}`);
  const j = await r.json();
  const rows = (j.data || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  const dates = rows.map(x => x.date);
  const closes = rows.map(x => +x.close);
  const dateIdx = new Map(dates.map((d, i) => [d, i]));
  const entry = { dates, closes, dateIdx };
  priceCache[key] = entry;
  return entry;
}

async function computeForTicker(key) {
  if (resultCache[key]) return resultCache[key];
  await loadNaaim();
  const price = await loadPrice(key);
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
  const priceVals = priceRows.map(r => pxUnlog(r[1]));  // 還原成價格再算 min/max
  const priceMin = Math.min(...priceVals), priceMax = Math.max(...priceVals);

  const pctSeries = naaimDates.map((d, i) => [d, result.pctRank[i]]);

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
          if (p.seriesName.includes("百分位")) html += `<div>${p.marker}${p.seriesName}: <b>${v.toFixed(1)}</b></div>`;
          else if (p.seriesName.includes(t.label)) html += `<div>${p.marker}${p.seriesName}: <b>${pxUnlog(v).toFixed(2)}</b></div>`;  // y 存 log10，還原
        }
        return html;
      },
    },
    legend: {
      data: ["NAAIM 滾動百分位(156週)", `${t.label} 收盤價(未還原息)`, "高曝險(≥80,去重後)事件"],
      top: 4, textStyle: { color: textClr, fontSize: 11 },
    },
    grid: { left: mob() ? 44 : 56, right: mob() ? 48 : 64, top: 48, bottom: mob() ? 60 : 48 },
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
    ],
  }, { notMerge: true });
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

async function refresh() {
  const status = document.getElementById("naaim-status");
  try {
    const result = await computeForTicker(ticker);
    render(ticker, result);
    renderTable(result);
    renderStatus(ticker, result);
  } catch (e) {
    if (status) status.textContent = `載入失敗：${e.message}`;
    console.error("[naaim] refresh failed", e);
  }
}

function buildControls() {
  const host = document.getElementById("naaim-ticker-picker");
  if (!host || host.dataset.built) return;
  host.innerHTML = TICKERS.map(t =>
    `<span class="chip${t.key === ticker ? " active" : ""}" data-naaim-ticker="${t.key}">${t.label}</span>`
  ).join("");
  host.dataset.built = "1";
  host.querySelectorAll(".chip").forEach(chip =>
    chip.addEventListener("click", () => {
      host.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      ticker = chip.dataset.naaimTicker;
      refresh();
    })
  );
}

// ── lifecycle ────────────────────────────────────────────────────────
export async function init() {
  const host = document.getElementById("naaim-chart");
  if (!host) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : "dark");
  buildControls();
  await refresh();
}

export function onThemeChange(light) {
  if (!chart) return;
  chart.dispose();
  chart = echarts.init(document.getElementById("naaim-chart"), light ? null : "dark");
  if (resultCache[ticker]) { render(ticker, resultCache[ticker]); renderTable(resultCache[ticker]); }
}

export function resize() { chart?.resize(); }
