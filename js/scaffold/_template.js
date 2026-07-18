// js/scaffold/_template.js — 新 tab 起手範本。
//
// 新 tab 從這裡複製起手,**不要**從舊 tab copy(舊 tab 常混雜著已經不建議的內聯
// pattern——2026-07 稽核:js/utils 採用率僅 12-16%)。本範本示範標準流程:
//   1. import 共用層(theme/dates/math/data),不要在 tab 裡重寫 tc()/computeMA()/
//      percentile() 之類的 primitive。
//   2. `activate()`(首次切入載入)+ `onThemeChange(light)` + `resize()` 三個
//      生命週期 export,對齊 boot.js/switcher.js 的呼叫慣例。
//   3. `ensureLoaded(key)` 走 SERIES 註冊表 + `loaded` 快取(見 js/state.js),
//      不要自己重寫 fetch(...).then(r=>r.json())。
//   4. `echartsBase({...overrides})` 出圖,不要從零手刻 grid/tooltip/axis 樣板。
//
// ⚠️ 本檔**不註冊進 boot.js**,只是複製起手用的範本,不會被實際掛載成 tab。

import { loaded } from '../state.js';
import { isLight, echartsBase, PALETTE } from '../utils/theme.js';
import { filterRange, tsToLocalDate } from '../utils/dates.js';
import { computeMA, percentileRank } from '../utils/math.js';
import { ensureLoaded } from '../utils/data.js';

const TAB_ID = 'scaffold-template'; // 複製時改成新 tab 的 id
let chart = null;

// ── data load ────────────────────────────────────────────────────────────
async function loadAll() {
  // 示範:走 SERIES 註冊表(js/state.js)+ 共用快取,不自己重寫 fetch。
  // 複製時把 'QQQ' 換成新 tab 需要的 SERIES key,或改讀專屬 data/*.json
  // (若無 SERIES 註冊,改用 utils/data.js 的 fetchJSON(url))。
  await ensureLoaded('QQQ');
}

function buildOption() {
  const rows = filterRange(loaded['QQQ'] ?? []);
  const ma20 = computeMA(rows, 20);

  // percentileRank 範例:目前值在近 N 筆的百分位(0–1,自行 *100 顯示)。
  const closes = rows.map(r => r[1]).sort((a, b) => a - b);
  const latest = rows.length ? rows[rows.length - 1][1] : null;
  const pct = latest != null ? percentileRank(latest, closes) : null;

  return echartsBase({
    series: [
      {
        name: 'QQQ(範本示範)',
        type: 'line',
        data: rows.map(r => [r[0], r[1]]),
        itemStyle: { color: PALETTE.text },
        showSymbol: false,
      },
      {
        name: 'MA20',
        type: 'line',
        data: ma20.map(r => [r[0], r[1]]),
        itemStyle: { color: PALETTE.muted },
        showSymbol: false,
      },
    ],
    // pct 只是示範計算結果,實際 tab 可畫成卡片文字,這裡先不額外渲染。
    _demoPercentile: pct,
  });
}

// ── lifecycle ────────────────────────────────────────────────────────────
export async function activate() {
  const host = document.getElementById(`${TAB_ID}-chart`);
  if (!host) return; // 範本不掛載,正常情況下 host 一定是 null
  if (!chart) chart = echarts.init(host, isLight() ? null : 'dark');
  try {
    await loadAll();
    chart.setOption(buildOption(), { notMerge: true });
  } catch (e) {
    console.error(`[${TAB_ID}] load failed`, e);
  }
}

export function onThemeChange(_light) {
  if (!chart) return;
  chart.setOption(buildOption(), { notMerge: true });
}

export function resize() {
  chart?.resize();
}

// 複製時順便看一下 tsToLocalDate 的用途說明(ECharts time-axis 用本地午夜解析
// "YYYY-MM-DD",tooltip callback 若要把 axisValue 轉回日期字串,一律用它,不要用
// toISOString().slice(0,10)(那是 UTC,離午夜近的時區會差一天)。
void tsToLocalDate;
