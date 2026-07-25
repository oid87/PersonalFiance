// 新興市場壓力 tab — OFR FSI「Emerging markets」分項（倒置）× 台股加權指數（仿 MacroMicro
// 「全球-金融壓力指數[FSI]」那張圖）
//   上 grid: OFR FSI Emerging markets 分項 ×(-1) 倒置 + MA20/50/200（週）+ 零軸
//   下 grid: 台股加權 ^TWII 收盤 + MA20/50/200（週）
//
// 資料 data/fsi.json 的 `em` 欄（fetch_fsi.py 抓 financialresearch.gov，每日 2000+，免 key）
// + data/TWII.json 的 `close`（fetch_stocks.py 抓，1997+，已在 CI，本 tab 不重抓）。
// 兩邊先各自轉週頻再取交集 —— 理由兩點：
//   ①FSI 缺席日＝美國假日整列不存在（不是 NaN）、TWII 缺席日＝台灣休市日，兩邊休市日曆不同，
//     直接照日期 join 會處處對不上，所以先各自 resample 成週再對齊；
//   ②週內若某邊完全沒有交易日，該週不產點、不向前填值（同 nfci.js／fsi.js 慣例，不做 fillna）。
// MA 全部算在「週頻」序列上（20/50/200 週），不足窗口不畫。EM 分項的 MA 算在「倒置後」的序列，
// 才會跟畫出來的線同向。
//
// 定位「環境理解」，不是交易訊號 —— 本檔文案與註解一律不做多空/買賣/進出場判讀。

import { isLight, tc, mob, PALETTE } from '../utils/theme.js';
import { computeMA } from '../utils/math.js';

const PERIODS  = [20, 50, 200];
const MA_COLOR = { 20: "#58a6ff", 50: "#e3b341", 200: "#f85149" };
// 主線刻意用 PALETTE.text（同 nfci.js:203 的 nfciColor）而非紅色系：MA_COLOR[200] 已佔用
// #f85149，主線再用同色會與 MA200 難以分辨。PALETTE 隨主題變，故在 render 內取值不放這裡。
const TWII_COLOR = "#f778ba";   // 與 twstress.js / fsi.js 的加權指數/S&P overlay 同一慣例色

let emfsiChart = null;
let emfsiRange = "2Y";

let weeks   = null;  // string[]，週交集日期（週日對齊），升冪
let emInv   = null;  // number[]，EM FSI 倒置後的週值（與 weeks 對齊）
let emRaw   = null;  // number[]，EM FSI 原始（非倒置）週值，僅供卡片顯示
let twii    = null;  // number[]，TWII 收盤週值（與 weeks 對齊）
let emMA    = null;  // { 20: number|null[], 50: …, 200: … }，算在 emInv 上
let twiiMA  = null;  // { 20: …, 50: …, 200: … }，算在 twii 上
let latestDaily = null; // fsi.json 最後一筆日頻 rec，供「現值」卡使用

// ── weekly resample：取該週最後一個交易日的值，對齊到該週的「週日」 ──────
// 與 dates.js 的 toWeekly()/toWeeklyHLC() 是不同 key 慣例：那兩支對齊到「週一」；
// MacroMicro 的圖是對齊「週日」，且輸入/輸出都是純 [date, value] pair 而非
// [tradeDate, value] 保留原始交易日，所以本地另寫，不能直接換成 dates.toWeekly。
// check_reuse: keep — 週日對齊與保留原始交易日期是本 tab 特有需求，理由見上
function toWeeklySunday(pairs) {
  const byWeek = new Map(); // sundayKey → value；輸入日期升冪時，同週較晚的交易日會覆蓋較早的，天然等於「取該週最後一個交易日」
  for (const [d, v] of pairs) {
    const dt = new Date(d + "T00:00:00Z");
    const day = dt.getUTCDay(); // 0=Sun..6=Sat
    const diff = day === 0 ? 0 : 7 - day;
    const sun = new Date(dt);
    sun.setUTCDate(dt.getUTCDate() + diff);
    // check_reuse: keep — 週日對齊 key，非 dates.tsToLocalDate 的用途(那支是 ECharts 時間軸 ts→本地日期)
    byWeek.set(sun.toISOString().slice(0, 10), v);
  }
  return [...byWeek.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

// 用 canonical math.computeMA([date,val] pairs, period) 算週 MA，再對齊回完整週序列
// （不足窗口的週份補 null，不 fillna——computeMA 本身就是從第 period 筆才開始輸出）。
function maAligned(pairs, period, alignDates) {
  const m = new Map(computeMA(pairs, period));
  return alignDates.map(d => (m.has(d) ? m.get(d) : null));
}

// ── load + weekly resample + MA ─────────────────────────────────────
async function loadAll() {
  if (weeks) return;
  const [fsiJson, twiiJson] = await Promise.all([
    fetch("data/fsi.json",  { cache: "no-cache" }).then(r => { if (!r.ok) throw new Error(`fsi.json: HTTP ${r.status}`); return r.json(); }),
    fetch("data/TWII.json", { cache: "no-cache" }).then(r => { if (!r.ok) throw new Error(`TWII.json: HTTP ${r.status}`); return r.json(); }),
  ]);

  const fsiRows  = fsiJson?.data ?? [];
  const twiiRows = twiiJson?.data ?? [];
  latestDaily = fsiRows.length ? fsiRows[fsiRows.length - 1] : null;

  const emPairsDaily   = fsiRows.map(r => [r.date, r.em]);
  const twiiPairsDaily = twiiRows.map(r => [r.date, r.close]);

  const emWeekly   = toWeeklySunday(emPairsDaily);   // [[sunday, em], …]
  const twiiWeekly = toWeeklySunday(twiiPairsDaily); // [[sunday, close], …]

  const emMap   = new Map(emWeekly);
  const twiiMap = new Map(twiiWeekly);
  // x 軸取兩者交集（FSI 從 2000-01-03、TWII 從 1997-07-02 起，交集起點落在 2000 年那週）
  weeks = emWeekly.map(([d]) => d).filter(d => twiiMap.has(d));

  emRaw = weeks.map(d => emMap.get(d));
  emInv = emRaw.map(v => -v);           // 倒置只在這裡做一次，畫圖與 MA 都用這個
  twii  = weeks.map(d => twiiMap.get(d));

  const emInvPairs = weeks.map((d, i) => [d, emInv[i]]);
  const twiiPairs  = weeks.map((d, i) => [d, twii[i]]);
  emMA   = Object.fromEntries(PERIODS.map(p => [p, maAligned(emInvPairs, p, weeks)]));
  twiiMA = Object.fromEntries(PERIODS.map(p => [p, maAligned(twiiPairs,  p, weeks)]));
}

// check_reuse: keep — 本地 range cutoff 變體：preset key 集合(6M/1Y/2Y/3Y/5Y/10Y/MAX)、
// MAX 哨兵、未命中預設(2年) 與 dates.presetStart/dates.cutoffDate、以及 nfci.js/fsi.js/
// twstress.js 各自的本地 rangeCutoff 皆不同 key 集合，換掉會改變預設區間。
function rangeCutoff(key) {
  if (key === "MAX") return "0000-00-00";
  const d = new Date();
  // check_reuse: keep — 6M 分支，理由同上（本地 key 集合含 dates.presetStart 沒有的 6M/2Y）
  if (key === "6M") { d.setMonth(d.getMonth() - 6); return d.toISOString().slice(0, 10); }
  const yrs = { "1Y": 1, "2Y": 2, "3Y": 3, "5Y": 5, "10Y": 10 }[key] ?? 2;
  d.setFullYear(d.getFullYear() - yrs);
  // check_reuse: keep — 理由同函式開頭註解
  return d.toISOString().slice(0, 10);
}

// ── readout cards（純敘述現況，不含買賣/進出場判讀）───────────────────
function setText(id, txt, color) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = txt;
  if (color) el.style.color = color;
}

function updateCards() {
  if (!weeks || !weeks.length || !latestDaily) return;
  const n = weeks.length;

  // 1. EM FSI 現值（日頻最新一筆，原始值，非倒置）
  const emNow = latestDaily.em;
  setText("emfsi-level-val", (emNow >= 0 ? "+" : "") + emNow.toFixed(3), PALETTE.text);
  setText("emfsi-level-sub", `${latestDaily.date}｜0＝歷史均值｜原始值（非倒置）`, "var(--muted)");
  setText("emfsi-level-signal", emNow >= 0 ? "高於歷史均值" : "低於歷史均值", PALETTE.text2);

  // 2. vs MA50（週，倒置後序列）——純位置敘述
  const invNow = emInv[n - 1];
  const ma50   = emMA[50][n - 1];
  let mVal, mSig, mClr;
  if (ma50 == null) { mVal = "—"; mSig = "—"; mClr = "var(--muted)"; }
  else {
    const above = invNow > ma50;
    mVal = (invNow >= 0 ? "+" : "") + invNow.toFixed(3);
    mSig = above ? "高於週 MA50（倒置後）" : "低於週 MA50（倒置後）";
    mClr = PALETTE.text2;
  }
  setText("emfsi-ma50-val", mVal, mClr);
  setText("emfsi-ma50-sub", ma50 != null ? `MA50(週) ${ma50.toFixed(3)}｜MA200(週) ${emMA[200][n-1]?.toFixed(3) ?? "—"}` : "—", "var(--muted)");
  setText("emfsi-ma50-signal", mSig, mClr);

  // 3. 資料最新日期 + 更新延遲
  setText("emfsi-date-val", latestDaily.date, PALETTE.text);
  setText("emfsi-date-sub", `台股加權 ${weeks[n-1]} 那週｜週頻交集`, "var(--muted)");
  setText("emfsi-date-signal", "OFR FSI 更新約延遲 2 個交易日", "var(--muted)");
}

// ── render ───────────────────────────────────────────────────────────
export function render() {
  if (!emfsiChart || !weeks) return;
  const axisClr = PALETTE.muted;
  const gridClr = tc("rgba(48,54,61,0.5)", "rgba(208,215,222,0.4)");
  const tipBg   = PALETTE.bg;
  const tipBdr  = PALETTE.border;
  const textClr = PALETTE.text2;

  updateCards();

  const cutoff = rangeCutoff(emfsiRange);
  const idx0 = weeks.findIndex(d => d >= cutoff);
  const start = idx0 === -1 ? weeks.length : idx0;
  const dates    = weeks.slice(start);
  const emLine   = emInv.slice(start).map(v => +v.toFixed(3));
  const twiiLine = twii.slice(start).map(v => +v.toFixed(2));
  const emMaView   = Object.fromEntries(PERIODS.map(p => [p, emMA[p].slice(start).map(v => v != null ? +v.toFixed(3) : null)]));
  const twiiMaView = Object.fromEntries(PERIODS.map(p => [p, twiiMA[p].slice(start).map(v => v != null ? +v.toFixed(2) : null)]));

  const status = document.getElementById("emfsi-status");
  if (status) status.textContent =
    `OFR FSI 新興市場分項（倒置）× 台股加權 · ${dates.length} 週（${emfsiRange}）· 20/50/200 週均線 · 來源 financialresearch.gov + 台股加權指數`;

  const L = mob() ? 40 : 52, R = mob() ? 16 : 28;
  const grid = [
    { left: L, right: R, top: "9%",  height: mob() ? "36%" : "39%" },
    { left: L, right: R, top: "63%", height: mob() ? "23%" : "25%" },
  ];
  const xAxis = grid.map((_, i) => ({
    gridIndex: i, type: "category", data: dates, boundaryGap: false,
    axisLine: { lineStyle: { color: axisClr } }, axisTick: { show: false },
    axisLabel: { show: i === 1, color: axisClr, fontSize: 11 },
    splitLine: { show: false },
  }));

  const yAxis = [
    { gridIndex: 0, scale: true, name: "EM FSI(倒置)", nameTextStyle: { color: axisClr, fontSize: 10 },
      axisLabel: { color: axisClr, fontSize: 11 }, axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: gridClr } } },
    { gridIndex: 1, scale: true, name: "台股加權", nameTextStyle: { color: axisClr, fontSize: 10 },
      axisLabel: { color: axisClr, fontSize: 10 }, axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: gridClr } } },
  ];

  const zeroMark = {
    silent: true, symbol: "none",
    data: [{ yAxis: 0, lineStyle: { color: axisClr, type: "solid", width: 1, opacity: 0.5 },
      label: { formatter: "0 歷史均值", color: axisClr, fontSize: 10, position: "insideEndTop" } }],
  };

  const emMaSeries = PERIODS.map(p => ({
    name: `MA${p}`, type: "line", xAxisIndex: 0, yAxisIndex: 0, data: emMaView[p],
    symbol: "none", smooth: false, connectNulls: false, z: 3,
    itemStyle: { color: MA_COLOR[p] }, lineStyle: { color: MA_COLOR[p], width: 1.2, opacity: 0.85 },
  }));
  const twiiMaSeries = PERIODS.map(p => ({
    name: `TWII MA${p}`, type: "line", xAxisIndex: 1, yAxisIndex: 1, data: twiiMaView[p],
    symbol: "none", smooth: false, connectNulls: false, z: 3,
    itemStyle: { color: MA_COLOR[p] }, lineStyle: { color: MA_COLOR[p], width: 1.2, opacity: 0.85 },
  }));

  const emColor = PALETTE.text;
  const series = [
    { name: "新興市場FSI(倒置)", type: "line", xAxisIndex: 0, yAxisIndex: 0, data: emLine,
      symbol: "none", smooth: false, z: 5, itemStyle: { color: emColor },
      lineStyle: { color: emColor, width: 1.8 }, markLine: zeroMark },
    ...emMaSeries,
    { name: "台股加權指數", type: "line", xAxisIndex: 1, yAxisIndex: 1, data: twiiLine,
      symbol: "none", smooth: false, z: 5, itemStyle: { color: TWII_COLOR },
      lineStyle: { color: TWII_COLOR, width: 1.8 } },
    ...twiiMaSeries,
  ];

  const topLegend    = ["新興市場FSI(倒置)", ...PERIODS.map(p => `MA${p}`)];
  const bottomLegend  = ["台股加權指數", ...PERIODS.map(p => `TWII MA${p}`)];

  emfsiChart.setOption({
    backgroundColor: "transparent", animation: false,
    tooltip: {
      trigger: "axis", axisPointer: { type: "cross", link: [{ xAxisIndex: "all" }] },
      backgroundColor: tipBg, borderColor: tipBdr, textStyle: { color: textClr, fontSize: 12 },
      formatter(params) {
        const d = params[0]?.axisValue ?? "";
        let html = `<div style="font-weight:600;margin-bottom:4px">${d}</div>`;
        for (const p of params) {
          if (p.value == null) continue;
          const v = p.seriesName.startsWith("台股") || p.seriesName.startsWith("TWII")
            ? (+p.value).toFixed(0) : (+p.value).toFixed(3);
          html += `<div>${p.marker}${p.seriesName}: <b>${v}</b></div>`;
        }
        return html;
      },
    },
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    grid, xAxis, yAxis,
    dataZoom: [{ type: "inside", xAxisIndex: [0, 1], filterMode: "none" }],
    legend: [
      { data: topLegend,    top: 2,     left: "center", textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr },
      { data: bottomLegend, top: "53%", left: "center", textStyle: { color: textClr, fontSize: 11 }, inactiveColor: axisClr },
    ],
    series,
  }, { notMerge: true });
}

// ── controls ─────────────────────────────────────────────────────────
function buildControls() {
  const rp = document.getElementById("emfsi-range-picker");
  if (rp && !rp.dataset.built) {
    rp.dataset.built = "1";
    rp.addEventListener("click", e => {
      const t = e.target.closest(".chip[data-emfsi-range]");
      if (!t) return;
      emfsiRange = t.dataset.emfsiRange;
      rp.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c === t));
      render();
    });
  }
}

// ── lifecycle ────────────────────────────────────────────────────────
export async function activate() {
  const host = document.getElementById("emfsi-chart");
  if (!host) return;
  if (!emfsiChart) emfsiChart = echarts.init(host, isLight() ? null : "dark");
  buildControls();
  try {
    await loadAll();
    setTimeout(() => { emfsiChart?.resize(); render(); }, 50);
  } catch (e) {
    const s = document.getElementById("emfsi-status");
    if (s) s.textContent = "載入失敗：" + (e.message || e);
    console.error("[emfsi] load failed", e);
  }
}
export function onThemeChange(light) {
  if (!emfsiChart) return;
  emfsiChart.dispose();
  emfsiChart = echarts.init(document.getElementById("emfsi-chart"), light ? null : "dark");
  if (weeks) render();
}
export function resize() { emfsiChart?.resize(); }
