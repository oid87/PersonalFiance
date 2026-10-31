// 融資去槓桿警報 — 可互動的歷史回測。
// 引擎：js/tabs/marginalert_calc.mjs（純函式；與 scripts/backtest_margin_delever.mjs 共用同一份）。
// 資料：data/TWII.json、data/taiwan_margin_total.json（必要）；data/taiwan_margin_ratio_mm.json、
//       data/taiwan_margin_ratio.json（選用，重建維持率；缺少時只停用規則 B，明示 partial）。
// 這是研究／風險警示工具：不修改任何正式交易條件，警報 ≠ 買入訊號，融資減少 ≠ 斷頭。

import { echartsBase, isLight, PALETTE, mob } from '../utils/theme.js';
import { requestJSON } from '../utils/data.js';
import { tooltipPosition } from '../utils/tooltip.js';
import { preserveChartState } from '../utils/chartLifecycle.js';
import {
  CASES, runFullBacktest, mergeRatio, singleDayFlags, evaluateFlags, GATES, median, fearAnalysis, clampFear, buildDataset,
} from './marginalert_calc.mjs';
import { analyzeHistory, scenarioView, signalOverlap, MANUAL_BETAS, KEY_DROP_PTS, buildChartSeries, windowSlice, endForWave } from './marginstress_calc.mjs';
import { chipPicker } from '../utils/dom.js';
import { minSpanForAxis } from '../utils/zoomFloor.js';

const TAB_ID = 'marginalert';
// 頁面預設範圍：維持率重建資料最早的一天（引擎／CLI 報告的 DEFAULTS.start 仍是 2020-01-01，不受影響）
const PAGE_START = '2004-02-11';
const $ = id => document.getElementById(`${TAB_ID}-${id}`);

let chart = null;
let raw = null;        // { twii, margin, ratio, ratioInfo, partial }
let res = null;        // runFullBacktest 結果
let sel = null;        // 目前選擇門檻×閘門的事件評估
let fear = null;       // 恐懼貪婪 × 目前警報 的對照（無 F&G 資料時為 null）
let ui = { fg: true, fearThr: 15, th: 3, gate: 0, caseId: 'A', lookback: 120, entry: 'nextOpen', cooldown: 10, minIdxDrop: 1, start: PAGE_START, end: null };
let wired = false;
let stressH = null;    // analyzeHistory 快取（與參考日、Beta 情境無關）
let stressOv = null;   // signalOverlap 快取
let stChart = null;    // 維持率 × 指數（可滑回歷史）
let stSeries = null;   // buildChartSeries 快取（含各自 120 日高點與爆掉點）
let stSeriesByDate = null;
let stWin = { years: 1, endDate: null };
let stressUi = { ref: 'idxHigh', refDate: '', beta: 'hist', custom: { low: MANUAL_BETAS.low, base: MANUAL_BETAS.base, high: MANUAL_BETAS.high } };

// ── 格式化 ───────────────────────────────────────────────────────────
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const f = (x, d = 1) => (isNum(x) ? x.toFixed(d) : '—');
const sg = (x, d = 1) => (isNum(x) ? (x > 0 ? '+' : '') + x.toFixed(d) : '—');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const tbl = (head, rows, cls = '') =>
  `<div class="table-scroll" tabindex="0" role="region" aria-label="回測表格"><table class="info-table ${cls}"><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${
    rows.map(r => `<tr>${r.map(c => `<td>${c ?? ''}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const fwd = (fw, h) => { const s = fw?.[h]; return s && s.n ? `${sg(s.retMedian)} / ${sg(s.retMean)}` : '—'; };
// 觸發時的醒目字：紅色加粗（亮／暗主題各用夠對比的紅）；不單靠顏色，旁邊另有 🔔／標記
const hot = text => `<b style="color:${isLight() ? '#c62828' : '#ff6b6b'}">${text}</b>`;
// 維持率「現在(距四週高點的變化)」：例如高點 200 → 現在 180 顯示 180.0(-20.0)
const ratioDelta = (ratio, r4) => (isNum(ratio) ? `${f(ratio, 1)}${r4 ? `(${sg(r4.diff, 1)})` : ''}` : '—');
const neg = (x, d = 1) => (isNum(x) ? `-${x.toFixed(d)}%` : '—');

// ── 載入 ─────────────────────────────────────────────────────────────
function usableRows(payload, keys, label) {
  const rows = payload?.data;
  if (!Array.isArray(rows) || !rows.some(r => typeof r?.date === 'string' && keys.every(k => Number.isFinite(r[k])))) {
    throw new Error(`${label} 資料格式不完整`);
  }
  return rows;
}

async function loadAll(context = {}) {
  if (raw) return;
  const [tw, mg] = await Promise.all([
    requestJSON('data/TWII.json', { signal: context.signal }),
    requestJSON('data/taiwan_margin_total.json', { signal: context.signal }),
  ]);
  const twii = usableRows(tw, ['open', 'high', 'low', 'close'], '加權指數');
  let margin = usableRows(mg, ['margin_money'], '上市融資餘額');
  let mm = [], rc = [], partial = null;
  // 2001-2007 融資餘額補遺（靜態檔，與主檔以日期合併、主檔優先；缺檔只是少了更早的資料）
  let earlyCount = 0;
  try {
    const e = await requestJSON('data/taiwan_margin_total_early.json', { signal: context.signal });
    const rows = Array.isArray(e?.data) ? e.data.filter(r => typeof r?.date === 'string' && Number.isFinite(r.margin_money) && r.margin_money > 0) : [];
    const have = new Set(margin.map(r => r.date));
    const extra = rows.filter(r => !have.has(r.date));
    earlyCount = extra.length;
    margin = [...extra, ...margin].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  } catch (err) {
    if (context.signal?.aborted) throw err;
    partial = '2001–2007 融資餘額補遺載入失敗：只用 2008 起的融資餘額';
  }
  try {
    const [a, b] = await Promise.all([
      requestJSON('data/taiwan_margin_ratio_mm.json', { signal: context.signal }),
      requestJSON('data/taiwan_margin_ratio.json', { signal: context.signal }),
    ]);
    mm = Array.isArray(a?.data) ? a.data : [];
    rc = Array.isArray(b?.data) ? b.data : [];
  } catch (e) {
    if (context.signal?.aborted) throw e;
    partial = '重建維持率資料載入失敗：規則 B 停用（不估算）';
  }
  let fearGreed = [];
  try {
    const g = await requestJSON('data/fear_greed.json', { signal: context.signal });
    fearGreed = Array.isArray(g?.data) ? g.data : [];
    if (!fearGreed.length) throw new Error('empty');
  } catch (e) {
    if (context.signal?.aborted) throw e;
    partial = (partial ? partial + '；' : '') + '恐懼貪婪資料載入失敗：F&G 圖層與區間停用';
  }
  if (context.signal?.aborted || context.isCurrent?.() === false) return;
  const merged = mergeRatio(mm, rc);
  if (!merged.rows.length && !partial) partial = '無維持率資料：規則 B 停用（不估算）';
  const lastDate = margin.reduce((m, r) => (r.date > m ? r.date : m), '');
  raw = { twii, margin, ratio: merged.rows, fearGreed, ratioInfo: merged, partial, lastDate, earlyCount, marginUpdated: mg.updated, source: mg.source };
  ui.end = lastDate;
}

// ── 回測 ─────────────────────────────────────────────────────────────
function currentCfg() {
  const ths = [...new Set([2, 3, 4, 5, ui.th])].sort((a, b) => a - b);
  return { fearThr: ui.fearThr, start: ui.start, end: ui.end, lookback: ui.lookback, entry: ui.entry, cooldown: ui.cooldown, minIdxDrop: ui.minIdxDrop, thresholds: ths };
}
function recompute() {
  res = runFullBacktest({ twii: raw.twii, margin: raw.margin, ratio: raw.ratio, fearGreed: raw.fearGreed }, currentCfg());
  deriveSelection();
}
function deriveSelection() {
  const { ds, cfg } = res;
  const flags = singleDayFlags(ds, ui.th).filter(i => ds.days[i].dd >= ui.gate);
  sel = { flags, ...evaluateFlags(ds, flags, cfg) };
  fear = raw.fearGreed?.length ? fearAnalysis(ds, ui.fearThr, flags, cfg) : null;
}

// 每日總覽用：同 renderZone() 的最新維持率分區，加上 deriveSelection() 的今日是否為警報日。
// 不碰頁面 DOM；res 會留著，之後打開本頁不必重算。
export async function overviewSummary(context = {}) {
  await loadAll(context);
  if (!raw || context.signal?.aborted || context.isCurrent?.() === false) return null;
  if (!res) recompute();
  const { ds } = res, days = ds.days;
  const last = [...days].reverse().find(d => isNum(d.ratio));
  const flags = singleDayFlags(ds, ui.th).filter(i => ds.days[i].dd >= ui.gate);
  return {
    date: days.at(-1)?.date ?? null, ratio: last?.ratio ?? null, ratioDate: last?.date ?? null,
    zone: zoneOf(last?.ratio), triggered: flags.includes(days.length - 1),
    marginDay: days.at(-1)?.m?.[1] ?? null, th: ui.th, warn: WARN_LV, boom: BOOM_LV,
  };
}

// ── 圖 ───────────────────────────────────────────────────────────────
// F&G < thr 的連續區段 → markArea 的 [start,end] 對
function fearSegments(days, thr) {
  const segs = [];
  let start = null, prev = null;
  for (const d of days) {
    if (isNum(d.fg) && d.fg < thr) { if (start === null) start = d.date; prev = d.date; }
    else if (start !== null) { segs.push([start, prev]); start = null; }
  }
  if (start !== null) segs.push([start, prev]);
  return segs;
}

// ── 維持率分區與「指數跌 8%」推估 ─────────────────────────────────
// 固定觀察線（使用者指定）：160 警戒、150 爆炸。是頁面觀察線，不是官方門檻（130% 才是個別帳戶追繳線）；
// 重建值口徑會隨年代漂移，2026 年也有在 160 以上就爆量的例子，分區表會列出漏抓的爆量日數。
const WARN_LV = 160, BOOM_LV = 150, DROP_PCT = 8;
const ZONES = [
  { key: 'ok', label: '正常', min: WARN_LV },
  { key: 'warn', label: '警戒', min: BOOM_LV },
  { key: 'boom', label: '爆炸區', min: -Infinity },
];
const zoneOf = r => (isNum(r) ? ZONES.find(z => r >= z.min) : null);
const zoneText = z => (!z ? '—' : z.key === 'boom' ? hot(z.label) : z.key === 'warn' ? `<b style="color:#f59e0b">${z.label}</b>` : z.label);
// 回撤深度 d% 的歷史 Beta 中位（analyzeHistory 的 5/10/15/20% 各深度，中間線性內插）
function betaAt(d) {
  const rows = (stressH?.depth ?? []).filter(r => isNum(r.median));
  if (!rows.length) return null;
  if (d <= rows[0].depth) return rows[0].median;
  for (let k = 1; k < rows.length; k++) {
    const a = rows[k - 1], b = rows[k];
    if (d <= b.depth) return a.median + (b.median - a.median) * (d - a.depth) / (b.depth - a.depth);
  }
  return rows.at(-1).median;
}
// 指數再跌 d% → 維持率（M1 = M0 ×（1 − β·d），假設融資餘額不變）
const projectAt = (m0, d) => { const b = betaAt(d); return isNum(m0) && isNum(b) ? m0 * (1 - b * d / 100) : null; };
// 維持率掉到 target 約需指數再跌幾 %（β 隨深度變，迭代幾次收斂）
function dropToHit(m0, target) {
  if (!isNum(m0) || target >= m0) return 0;
  let d = 10;
  for (let k = 0; k < 5; k++) { const b = betaAt(d); if (!isNum(b)) return null; d = (1 - target / m0) / b * 100; }
  return d;
}
const projLine = d => { const m = projectAt(d.ratio, DROP_PCT); return isNum(m) ? `跌${DROP_PCT}%（${f(d.close * (1 - DROP_PCT / 100), 0)}）→ 維持率 ≈${f(m, 1)}（${sg(m - d.ratio, 1)}）` : ''; };
const needLine = (d, lv, name) => { const n = dropToHit(d.ratio, lv); return `${name} ${lv}：${n === 0 ? hot('已跌破') : isNum(n) ? `指數再跌 ${f(n, 1)}%（≈${f(d.close * (1 - n / 100), 0)}）` : '—'}`; };
// 各分區當天／之後 1～3 個交易日出現「單日融資 ≤ -門檻」的比例（用目前回測範圍的資料即時算）
function zoneStats(days, th) {
  const rows = ZONES.map(z => ({ z, n: 0, same: 0, next3: 0 }));
  for (let i = 0; i < days.length - 3; i++) {
    const z = zoneOf(days[i].ratio);
    if (!z) continue;
    const r = rows.find(x => x.z === z);
    r.n++;
    if (isNum(days[i].m[1]) && days[i].m[1] <= -th) r.same++;
    if ([1, 2, 3].some(k => isNum(days[i + k].m[1]) && days[i + k].m[1] <= -th)) r.next3++;
  }
  return rows;
}
// T 日融資大減時，回看 T-1、T-2 的維持率與指數：大減是當天急殺，還是兩天前就破了、今天才被砍
function lagLine(days, i) {
  const p = k => days[i - k];
  if (!p(2) || !isNum(p(2).ratio)) return '';
  return `T-2→T 維持率 ${[2, 1, 0].map(k => f(p(k).ratio, 0)).join('→')}`;
}
// 60 日高點→現在（跌了多少）與 20 日低點→現在（漲了多少）：指數 %、融資 億＋%；
// 「融資÷指數」＝融資變動% ÷ 指數變動%（>1 融資動得比指數兇；指數變動 <3% 時分母太小、不算）。
// 維持率約＝指數×β，另列在維持率那行（60日），不在表內重複。
const pctChg = (now, base) => (isNum(now) && isNum(base) && base ? (now / base - 1) * 100 : null);
function swingTable(d) {
  const { x, m } = d.sw ?? {};
  if (!x || !m) return '';
  const col = ref => {
    const xp = pctChg(d.close, x[ref]), mp = pctChg(d.margin, m[ref]);
    return { xp, mp, amt: d.margin - m[ref], lev: isNum(xp) && isNum(mp) && Math.abs(xp) >= 3 ? mp / xp : null };
  };
  const H = col('hi'), L = col('lo');
  const td = 'style="padding:0 0 0 6px;text-align:right;white-space:nowrap"';
  const row = (name, a, b) => `<tr><td style="white-space:nowrap">${name}</td><td ${td}>${a}</td><td ${td}>${b}</td></tr>`;
  const mg = c => `${sg(c.amt, 0)}億 ${sg(c.mp, 1)}%`;
  const dv = divergence(d);
  return `<table style="border-collapse:collapse;font-size:11px;width:100%">` +
    `<tr style="color:${PALETTE.muted}"><td></td><td ${td}>60日高→今</td><td ${td}>20日低→今</td></tr>` +
    row('加權', `${sg(H.xp, 1)}%`, `${sg(L.xp, 1)}%`) +
    row('融資', mg(H), mg(L)) +
    row('融資÷指數', isNum(H.lev) ? `${f(H.lev, 2)}×` : '—', isNum(L.lev) ? `${f(L.lev, 2)}×` : '—') + '</table>' +
    (dv ? `<div style="font-size:11px;margin-top:2px">${dv}</div>` : '');
}
// 指數與融資背離（只在發生時顯示一行；描述現況，回測沒有穩定的預測方向，不當訊號）：
// ①指數距 60 日高 ≤ -8%，融資卻比指數高點那天多 → 接刀
// ②指數在 20 日低附近（≤ +2%）且距 60 日高 ≤ -5%，融資比自身 20 日低多 ≥ 3% → 未洗
// ③指數距 20 日低 ≥ +8%，融資比指數低點那天少 → 沒用槓桿的反彈
function divergence(d) {
  const { x, m, mx } = d.sw ?? {};
  if (!x || !m) return '';
  const xh = pctChg(d.close, x.hi), xl = pctChg(d.close, x.lo), ml = pctChg(d.margin, m.lo);
  const tag = t => `<b style="color:#f59e0b">背離</b>｜${t}`;
  if (isNum(mx?.hi) && xh <= -8 && d.margin >= mx.hi) return tag(`指數跌 ${f(-xh, 1)}%，融資比指數高點日（${x.hiDate.slice(5)}）還多 ${f(d.margin - mx.hi, 0)} 億（接刀）`);
  if (xl <= 2 && xh <= -5 && ml >= 3) return tag(`指數在 20 日低點${xl >= 0.05 ? `附近（${sg(xl, 1)}%）` : ''}，融資比 20 日低還多 ${f(d.margin - m.lo, 0)} 億（未洗）`);
  if (isNum(mx?.lo) && xl >= 8 && d.margin < mx.lo) return tag(`指數反彈 ${f(xl, 1)}%，融資比指數低點日（${x.loDate.slice(5)}）少 ${f(mx.lo - d.margin, 0)} 億（沒用槓桿）`);
  return '';
}

function buildOption() {
  const { ds } = res;
  const days = ds.days;
  const showFg = ui.fg && !!raw.fearGreed?.length;
  const fearAreas = showFg ? fearSegments(days, ui.fearThr).map(([a, b]) => [{ xAxis: a, itemStyle: { color: 'rgba(163,113,247,0.22)' } }, { xAxis: b }]) : [];
  const dates = days.map(d => d.date);
  const flagged = new Set(sel.flags);
  const firstSet = new Set(sel.events.map(e => e.startIdx));
  const first = sel.events.map(e => [e.date, days[e.startIdx].close]);
  const rest = sel.flags.filter(i => !firstSet.has(i)).map(i => [days[i].date, days[i].close]);
  const areaData = CASES.filter(c => dates.some(d => d >= c.from && d <= c.to)).map(c => [
    { name: c.id === 'A' || c.id === 'B' ? `Case ${c.id}` : c.id === 'S1' ? '2020/3' : '2025/4', xAxis: nearest(dates, c.from), itemStyle: { color: PALETTE.grid, opacity: 0.6 } },
    { xAxis: nearest(dates, c.to) },
  ]);
  const barColor = v => (isNum(v) && v <= -ui.th ? '#ef4444' : isNum(v) && v < 0 ? '#e3b341' : '#3fb950');
  const axis = (gridIndex, show) => ({
    type: 'category', gridIndex, data: dates, boundaryGap: false,
    axisLine: { lineStyle: { color: PALETTE.muted } }, axisLabel: { color: PALETTE.muted, fontSize: 11, show },
    axisTick: { show: false }, splitLine: { show: false },
  });
  const yAxis = (gridIndex, name, extra = {}) => ({
    type: 'value', gridIndex, name, scale: true, nameTextStyle: { color: PALETTE.muted, fontSize: 10 },
    axisLabel: { color: PALETTE.muted, fontSize: 11 }, splitLine: { lineStyle: { color: PALETTE.grid } }, ...extra,
  });
  const L = mob() ? 44 : 60, Rr = mob() ? 34 : 48;   // 右邊留給維持率軸
  const nAx = showFg ? [0, 1, 2, 3] : [0, 1, 2];
  const yearSpan = minSpanForAxis({ type: 'category', data: dates }, 365) ?? undefined;
  const ratioC = '#f59e0b', marginC = '#58a6ff';
  return echartsBase({
    animation: false,
    legend: { top: 0, textStyle: { color: PALETTE.muted, fontSize: 11 }, data: ['加權指數', `警報首日(≤-${ui.th}%)`, '同波續發日', '融資餘額(億)', '融資維持率(重建)', '融資單日%', ...(showFg ? ['恐懼貪婪'] : [])] },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'cross' }, backgroundColor: PALETTE.bg, borderColor: PALETTE.border, textStyle: { color: PALETTE.text, fontSize: 12 },
      confine: true, extraCssText: `white-space:normal;width:${mob() ? 250 : 290}px;line-height:1.45`,
      formatter(params) {
        const i = params?.[0]?.dataIndex;
        const d = days[i];
        if (!d) return '';
        const fired = flagged.has(i);                                   // 與圖上警報標記同一判斷（含回撤閘門）
        const belowGate = !fired && isNum(d.m[1]) && d.m[1] <= -ui.th;     // 融資達標但回撤閘門未過
        const oneDay = `單日 ${sg(d.m[1], 2)}%（${sg(d.dm1, 0)} 億）`;
        const z = zoneOf(d.ratio);
        const sw = swingTable(d);
        const sec = t => `<div style="margin-top:3px;padding-top:3px;border-top:1px solid ${PALETTE.border}">${t}</div>`;
        return `<b>${d.date}</b>${fired ? ' 🔔' : ''}<br>加權 ${f(d.close, 0)}（${sg(d.x[1], 2)}%）` +
          `<br>融資 ${f(d.margin, 0)} 億｜${fired ? hot(oneDay + ' 觸發') : oneDay}${belowGate ? `<br>（距 ${ui.lookback} 日高 -${f(d.dd)}%，未達回撤閘門 ${ui.gate}%，不算警報）` : ''}` +
          (sw ? sec(sw) : '') +
          (isNum(d.ratio) ? sec(`維持率 ${f(d.ratio, 1)}｜${zoneText(z)}` +
            (d.r4 ? `<br>較高點：四週 ${sg(d.r4.diff, 1)}${d.sw?.r ? `｜60日 ${sg(d.ratio - d.sw.r.hi, 1)}` : ''}` : '') + `<br>${projLine(d)}` + (lagLine(days, i) ? `<br>${lagLine(days, i)}` : '')) : '') +
          (isNum(d.fg) ? `<div>恐懼貪婪 ${f(d.fg, 1)}</div>` : '');
      },
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    // grid 0 指數、1 融資餘額（左軸）＋維持率（右軸）、2 單日%、3 恐懼貪婪（選用）
    grid: showFg ? [
      { left: L, right: Rr, top: mob() ? 108 : 40, height: mob() ? '24%' : '29%' },
      { left: L, right: Rr, top: '40%', height: '24%' },
      { left: L, right: Rr, top: '67%', height: '10%' },
      { left: L, right: Rr, top: '81%', height: '10%' },
    ] : [
      { left: L, right: Rr, top: mob() ? 108 : 40, height: mob() ? '28%' : '34%' },
      { left: L, right: Rr, top: '46%', height: '28%' },
      { left: L, right: Rr, top: '78%', height: '12%' },
    ],
    xAxis: [...nAx.slice(0, -1).map(k => axis(k, false)), axis(nAx.at(-1), true)],
    yAxis: [yAxis(0, mob() ? '' : '加權指數', { min: 'dataMin' }), yAxis(1, '融資(億)', { min: 'dataMin', axisLabel: { color: marginC, fontSize: 11 } }),
      yAxis(1, '維持率%', { position: 'right', splitLine: { show: false }, axisLabel: { color: ratioC, fontSize: 11 } }), yAxis(2, '單日%', { scale: false }),
      ...(showFg ? [yAxis(3, '恐懼貪婪', { scale: false, min: 0, max: 100 })] : [])],
    // 這頁 slider／滾輪最短一年（使用者指定；比全站 9 個月的 zoomFloor 長）
    dataZoom: [
      { type: 'inside', xAxisIndex: nAx, filterMode: 'filter', minValueSpan: yearSpan },
      { type: 'slider', xAxisIndex: nAx, height: 16, bottom: 6, filterMode: 'filter', minValueSpan: yearSpan },
    ],
    series: [
      { name: '加權指數', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: days.map(d => d.close), showSymbol: false,
        lineStyle: { width: 1.3, color: PALETTE.text }, itemStyle: { color: PALETTE.text },
        markArea: { silent: true, label: { color: PALETTE.muted, fontSize: 10 }, data: [...areaData, ...fearAreas] } },
      { name: `警報首日(≤-${ui.th}%)`, type: 'scatter', xAxisIndex: 0, yAxisIndex: 0, data: first, symbol: 'triangle', symbolSize: 12, itemStyle: { color: '#ef4444' }, z: 5 },
      { name: '同波續發日', type: 'scatter', xAxisIndex: 0, yAxisIndex: 0, data: rest, symbol: 'circle', symbolSize: 6, itemStyle: { color: '#e3b341' }, z: 4 },
      { name: '融資餘額(億)', type: 'line', xAxisIndex: 1, yAxisIndex: 1, data: days.map(d => d.margin), showSymbol: false, lineStyle: { width: 1.2, color: marginC }, itemStyle: { color: marginC },
        markArea: { silent: true, data: fearAreas } },
      { name: '融資維持率(重建)', type: 'line', xAxisIndex: 1, yAxisIndex: 2, data: days.map(d => (isNum(d.ratio) ? d.ratio : null)), showSymbol: false, connectNulls: false,
        lineStyle: { width: 1.5, color: ratioC }, itemStyle: { color: ratioC },
        markLine: { silent: true, symbol: 'none', label: { position: 'insideStartTop', fontSize: 10 }, data: [
          { yAxis: WARN_LV, lineStyle: { color: '#e3b341', type: 'dashed' }, label: { formatter: `警戒 ${WARN_LV}`, color: '#e3b341' } },
          { yAxis: BOOM_LV, lineStyle: { color: '#ef4444', type: 'dashed' }, label: { formatter: `爆炸 ${BOOM_LV}`, color: '#ef4444' } }] } },
      { name: '融資單日%', type: 'bar', xAxisIndex: 2, yAxisIndex: 3, data: days.map(d => ({ value: isNum(d.m[1]) ? +d.m[1].toFixed(3) : null, itemStyle: { color: barColor(d.m[1]) } })),
        markLine: { silent: true, symbol: 'none', label: { formatter: `-${ui.th}%`, color: PALETTE.muted, fontSize: 10 }, lineStyle: { color: '#ef4444', type: 'dashed' }, data: [{ yAxis: -ui.th }] },
        markArea: { silent: true, data: fearAreas } },
      ...(showFg ? [{ name: '恐懼貪婪', type: 'line', xAxisIndex: 3, yAxisIndex: 4, data: days.map(d => (isNum(d.fg) ? d.fg : null)), showSymbol: false, connectNulls: false,
        lineStyle: { width: 1.2, color: '#a371f7' }, itemStyle: { color: '#a371f7' },
        markLine: { silent: true, symbol: 'none', label: { formatter: `<${ui.fearThr}`, color: PALETTE.muted, fontSize: 10 }, lineStyle: { color: '#a371f7', type: 'dashed' }, data: [{ yAxis: ui.fearThr }] },
        markArea: { silent: true, data: fearAreas } }] : []),
    ],
  });
}
// 點個案 chip 時把圖放大到該個案前後各約 15 個交易日
function zoomToCase() {
  const cs = res?.cases.find(c => c.id === ui.caseId);
  if (!cs || !chart) return;
  const dates = res.ds.days.map(d => d.date);
  const a = Math.max(0, dates.indexOf(nearest(dates, cs.from)) - 15);
  const b = Math.min(dates.length - 1, dates.indexOf(nearest(dates, cs.to)) + 15);
  chart.dispatchAction({ type: 'dataZoom', startValue: a, endValue: b });
}
function nearest(dates, d) {
  const hit = dates.find(x => x >= d);
  return hit ?? dates.at(-1);
}

function fearCard(ds) {
  const card = (v, sub) => `<div class="lev-card" style="min-width:220px"><div class="lc-sub">恐懼貪婪指數（CNN）</div><div class="lc-val">${v}</div><div class="lc-sub">${sub}</div></div>`;
  if (!fear) return card('—', '無 F&G 資料');
  const last = [...ds.days].reverse().find(d => isNum(d.fg));
  const lift = isNum(fear.lift) ? `lift ${f(fear.lift, 1)}` : 'lift —';
  return card(last ? `${f(last.fg, 1)}${last.fg < ui.fearThr ? ' 😨' : ''}` : '—',
    `${last ? esc(last.date) : ''}｜<${ui.fearThr} 共 ${fear.fearDays} 日（${f(fear.fearShare)}%）｜${lift}`);
}

function ratioCard(ds) {
  const d = ds.days.at(-1);
  const card = (v, sub) => `<div class="lev-card" style="min-width:220px"><div class="lc-sub">融資維持率（重建）：現在(距四週高點變化)</div><div class="lc-val">${v}</div><div class="lc-sub">${sub}</div></div>`;
  if (!d?.r4) return card('—', '無維持率資料');
  return card(ratioDelta(d.ratio, d.r4), `四週內高點 ${f(d.r4.high, 1)}（${esc(d.r4.date)}）→ 現在 ${f(d.ratio, 1)}（${esc(d.date)}）；括號＝較高點變化的點數`);
}

// ── 融資壓力情境推估（歷史敏感度）────────────────────────────────────
// 引擎：js/tabs/marginstress_calc.mjs。只讀既有資料、不改任何警報規則；任何一步失敗只讓此區塊顯示錯誤，不影響上方回測與圖表。
const pct = (x, d = 1) => (isNum(x) ? `${sg(x, d)}%` : '—');
const stLabel = { 'target-not-below': '目標不低於參考維持率，不需下跌', 'out-of-range': '超出合理範圍（需跌幅≥100%）', 'bad-beta': 'Beta 無效', invalid: '資料缺漏', 'not-below': '均線高於參考點，不推估' };
const stCard = (k, v, sub = '') => `<div class="lev-card" style="min-width:150px"><div class="lc-sub">${esc(k)}</div><div class="lc-val">${v}</div><div class="lc-sub">${sub}</div></div>`;

function stressData() { return { twii: raw.twii, margin: raw.margin, ratio: raw.ratio }; }
function stressBetaInput() {
  if (stressUi.beta === 'manual') return { ...MANUAL_BETAS };
  if (stressUi.beta === 'custom') return { ...stressUi.custom };
  return null;
}
function stressRefMode() {
  if (stressUi.ref === 'custom') return /^\d{4}-\d{2}-\d{2}$/.test(stressUi.refDate) ? stressUi.refDate : 'idxHigh';
  return stressUi.ref;
}
function betaSourceText(b) {
  if (b.source === 'historical') return `歷史 ${b.n} 個 ≥10% 下跌波段（同一高點只留最深一段）的 P25／中位數／P75`;
  if (b.source === 'historical-light') return `${b.note}，取 P25／中位數／P75；融資還沒明顯下降時 Beta 通常較高`;
  if (b.source === 'manual') return '手動設定的情境參數，非統計信賴區間（歷史樣本不足或你選了手動）';
  if (b.source === 'user') return '自訂 Beta，未經回測驗證';
  return b.note || '';
}

function stateCards(v, h) {
  const r = v.ref, d = v.delever, z = v.realized;
  const nowDelta = isNum(r.latestM) && isNum(r.m0) ? r.latestM - r.m0 : null;
  const nowPct = isNum(nowDelta) ? (r.latestM / r.m0 - 1) * 100 : null;
  return [
    stCard('加權指數（現在）', f(r.latestP, 0), esc(r.latestDate)),
    stCard('融資維持率（重建，現在）', `${f(r.latestM, 2)}%`, `${esc(r.latestDate)}｜較參考高點 ${sg(nowDelta, 1)} 點（${pct(nowPct)}）`),
    stCard('參考高點', `${f(r.p0, 0)}`, `${esc(r.date)}｜維持率 ${f(r.m0, 2)}%`),
    stCard('融資餘額（億）', f(d?.margin, 0), d ? `${esc(d.date)}｜單日 ${pct(d.d1?.pct, 2)}（${sg(d.d1?.amt, 0)} 億）` : '—'),
    stCard('5 日／10 日融資變化', `${pct(d?.d5?.pct, 2)} ／ ${pct(d?.d10?.pct, 2)}`, `${sg(d?.d5?.amt, 0)} ／ ${sg(d?.d10?.amt, 0)} 億`),
    stCard('參考日→現在 實際倍數', z?.ok ? f(z.beta, 2) : '—', z?.ok ? `指數 ${pct(-z.indexDecline * 100)}、維持率 ${pct(-z.marginDecline * 100)}（相對）` : '指數尚未低於參考高點'),
  ].join('');
}

function targetsTable(v) {
  const t = v.targets;
  if (!t) return '<p>無維持率資料，無法推估。</p>';
  const r = v.ref;
  const rows = t.map(x => {
    if (x.status !== 'ok') return [`<b>${esc(x.label)}</b>`, esc(stLabel[x.status] ?? x.status), '', '', '', ''];
    return [`<b>${esc(x.label)}</b>`, `<b>${f(x.projected, 0)}</b>`, `${f(x.rangeLow, 0)} ～ ${f(x.rangeHigh, 0)}`,
      pct(x.fromRefPct), `${sg(x.fromNowPts, 0)}（${pct(x.fromNowPct)}）`, x.key === 'drop30' ? `${f(r.m0 - KEY_DROP_PTS, 1)}%` : ''];
  });
  const b = v.betas;
  return `<p class="text-muted-sm">Beta：低 ${f(b.low, 2)}／基準 ${f(b.base, 2)}／高 ${f(b.high, 2)}（${esc(betaSourceText(b))}）。起點 ${esc(r.date)} 收盤 ${f(r.p0, 0)}、維持率 ${f(r.m0, 2)}%。<b>「自參考高點回撤」與「自目前再跌」是兩個不同的量。</b></p>` +
    tbl(['目標維持率', '推估加權指數（基準 Beta）', `指數區間（Beta 高→低）`, '自參考高點回撤', '自目前（' + r.latestDate + '）再下跌 點數（%）', '備註（對應維持率）'], rows) +
    `<p class="text-muted-sm">這是「歷史敏感度情境推估」，不是支撐位、底部或預測低點。150% 不是固定的市場底部；130% 是個別信用帳戶的追繳門檻，全市場維持率接近 130% 不代表全面斷頭。</p>`;
}

function maTableHtml(v) {
  const m = v.ma;
  if (!m) return '<p>無維持率資料，無法推估。</p>';
  const rows = m.rows.map(x => [`<b>${x.period}MA</b>`, f(x.ma, 0), x.belowMa ? '目前已在均線下' : pct(x.fromNowPct),
    x.status === 'ok' ? `<b>${f(x.base, 1)}%</b>` : esc(stLabel[x.status] ?? x.status), x.status === 'ok' ? `${f(x.rangeLow, 1)}% ～ ${f(x.rangeHigh, 1)}%` : '']);
  return `<p class="text-muted-sm">均線＝加權指數收盤的 N 個交易日簡單平均，以最新日 ${esc(m.rows[0]?.asOf ?? v.ref.latestDate)} 的固定值試算（未來均線會隨時間移動）；維持率由參考高點（${esc(v.ref.date)}）按 Beta 推估，不是從現在的維持率另算。${m.skipped.length ? `資料不足、略過：${m.skipped.join('、')}MA。` : ''}供週期觀察，不產生買賣指令。</p>` +
    tbl(['均線', '均線點位', '距目前', '推估維持率（基準）', 'Beta 情境範圍（高 Beta → 低 Beta）'], rows);
}

function deleverHtml(v) {
  const d = v.delever, r = v.ref;
  if (!d?.ok) return '<p>無融資餘額資料。</p>';
  const cell = c => (c ? `${pct(c.pct, 2)}（${sg(c.amt, 0)} 億）` : '—');
  const t = tbl(['融資餘額（億）', '單日', '5 日', '10 日', `自參考日 ${r.date}`, '自參考日後的高點→現在'],
    [[`<b>${f(d.margin, 0)}</b>（${esc(d.date)}）`, cell(d.d1), cell(d.d5), cell(d.d10), cell(d.sinceRef), d.peakDrop ? `${pct(d.peakDrop.pct, 2)}（高點 ${f(d.peakDrop.peak, 0)}，${esc(d.peakDrop.peakDate)}）` : '—']]);
  const msg = d.flag === 'ratio-down-margin-not-down'
    ? `<p><b>維持率自參考高點下降 ${f(-d.ratioPts, 1)} 點，但同期融資餘額 ${pct(d.sinceRef?.pct, 2)}（沒有減少）。</b>這代表目前維持率下降主要來自股價下跌，融資戶整體尚未明顯降槓桿；但不能據此認定「還沒殺完」——融資部位組成、新增融資與主動還款都會影響餘額；反過來，餘額下降也不等於斷頭。</p>`
    : `<p class="text-muted-sm">${isNum(d.ratioPts) ? `維持率自參考高點 ${sg(d.ratioPts, 1)} 點；` : ''}融資餘額自參考日 ${pct(d.sinceRef?.pct, 2)}。融資下降＝去槓桿強度的描述，不等於斷頭；股價下跌造成的維持率下降與融資戶實際減碼要分開看。</p>`;
  return t + msg + `<p class="text-muted-sm">原有警報（單日融資 ≤ -3%＋回撤閘門、舊 2/3 規則）不受此區塊影響；上方圖表與下方事件表仍是警報判斷。</p>`;
}

function betaTableHtml(h) {
  const s = h.stats, b = h.scenario, rg = h.betaRegime;
  const last = h.usable.at(-1);
  const rows = [
    ['歷史中位數', f(s.median, 2)], ['P25 ～ P75', `${f(s.p25, 2)} ～ ${f(s.p75, 2)}`], ['最小 ～ 最大', `${f(s.min, 2)} ～ ${f(s.max, 2)}`],
    ['平均／變異係數', `${f(s.mean, 2)} ／ ${f(s.cv, 2)}`], ['最近一波', last ? `${f(last.beta, 2)}（${esc(last.peakDate)}→${esc(last.lowDate)}）` : '—'],
    ...(rg.light.n ? [[`融資未大幅去槓桿的波段（期間融資最大跌幅 > ${rg.heavyAt}%）`, `中位 ${f(rg.light.median, 2)}｜${f(rg.light.min, 2)} ～ ${f(rg.light.max, 2)}｜n=${rg.light.n}`]] : []),
    ...(rg.heavy.n ? [[`融資大幅去槓桿的波段（≤ ${rg.heavyAt}%）`, `中位 ${f(rg.heavy.median, 2)}｜${f(rg.heavy.min, 2)} ～ ${f(rg.heavy.max, 2)}｜n=${rg.heavy.n}`]] : []),
    ['情境用的低／基準／高', `${f(b.low, 2)} ／ ${f(b.base, 2)} ／ ${f(b.high, 2)}（${esc(betaSourceText(b))}）`],
  ];
  const dep = tbl(['指數回撤到', '波段數', 'Beta 中位數', '最小', '最大'], h.depth.map(d => [`≥${d.depth}%`, d.n, f(d.median, 2), f(d.min, 2), f(d.max, 2)]));
  const dm = h.depth.filter(d => isNum(d.median));
  const trend = dm.length >= 2 ? (dm.at(-1).median < dm[0].median - 0.05
    ? `回撤越深，Beta 中位數反而越低（${f(dm[0].median, 2)}→${f(dm.at(-1).median, 2)}）：深度修正時維持率相對跌幅並不隨指數加速，多半因為融資戶減碼、維持率被拉回。用固定 Beta 去推深的目標（例如 150%、130%）會高估維持率的跌法，推出的指數位置偏高。`
    : '不同回撤深度的 Beta 沒有明確單調關係。') : '';
  const dp = h.depthPaired;
  const paired = dp && dp.n >= 3 ? `同一批 ${dp.n} 個回撤達 ${dp.depths.at(-1)}% 的波段，Beta 中位數在 ${dp.depths.map((d, i) => `${d}%→${f(dp.medians[i], 2)}`).join('、')}，${dp.declined}/${dp.n} 波從 ${dp.depths[0]}% 到 ${dp.depths.at(-1)}% 變低（排除組成效應後方向相同）。` : '';
  const high = isNum(last?.beta) && isNum(s.max) && last.beta >= s.max - 0.05;
  return `<p class="text-muted-sm">Beta＝（M0-M1）/M0 ÷ （P0-P1）/P0，高點日→低點日的區間累計值，不是迴歸斜率，也不是維持率下降的點數。</p>` +
    tbl(['統計', '值'], rows) +
    (high ? `<p><b>2026 年這一波（${f(last.beta, 2)}）已是歷史最高的一端，不應當成固定值。</b>歷史基準是 ${f(s.median, 2)}；若要保守看待，把它當「高敏感度」情境而不是基準。</p>` : '') +
    `<h4>不同回撤深度的 Beta</h4>${dep}<p class="text-muted-sm">${esc(trend)}${esc(paired)}</p>`;
}

function historyHtml(h) {
  const rows = h.history.filter(w => w.independent).map(w => {
    if (!w.ok) return [`${esc(w.peakDate)}→${esc(w.lowDate)}`, neg(w.maxDd), '—', '—', '—', '—', '—', '—', '—', `維持率缺值：${esc(w.reason)}（2004-02 以前無重建資料，不補值）`];
    const burn = w.marginMaxBurn;
    return [`${esc(w.peakDate)}→${esc(w.lowDate)}${w.open ? '（未結束）' : ''}`, neg(w.maxDd), `${f(w.m0, 1)} → ${f(w.m1, 1)}`, pct(-w.marginDecline * 100), `-${f(w.ptsDrop, 1)}`, `<b>${f(w.beta, 2)}</b>`,
      isNum(w.marginChange) ? pct(w.marginChange) : '無融資資料', burn ? pct(burn.pct) : '—', isNum(w.collateralChange) ? pct(w.collateralChange, 0) : '—', `最低 ${f(w.ratioMin, 1)}（${esc(w.ratioMinDate)}）`];
  });
  const c = h.coverage;
  return `<p class="text-muted-sm">覆蓋：指數波段 ${c.waves} 段（回撤≥10% 進入、<5% 結束；同一高點的多段只算最深一段），其中有維持率者 ${c.withRatio} 段，可用於統計 ${c.usable} 段（${esc(c.firstUsable ?? '—')}～${esc(c.lastUsable ?? '—')}）。維持率重建資料自 2004-02-11，更早波段不補造。融資餘額自 2001-01-03（2001–2007 為補遺檔，與主檔日期合併）。</p>` +
    tbl(['波段（高點→低點）', '指數回撤', '維持率 起→低點', '維持率相對跌幅', '下降點數', 'Beta', '融資餘額變化（高→低）', '期間融資最大跌幅', '抵押品市值變化（推算，含賣股還款）', '期間最低維持率'], rows) +
    `<p class="text-muted-sm">「期間融資最大跌幅」＝融資餘額自身的峰谷，不等於兩端日期差。抵押品市值由 維持率＝抵押品÷融資餘額 推算，包含融資戶賣股還款造成的減少，不是單純股價跌幅。</p>`;
}

function backtestHtml(h) {
  const wf = h.walkForward.filter(r => !r.skipped);
  if (!wf.length) return '<p>歷史樣本不足，無法回測。</p>';
  const fm = (x, d = 1) => (isNum(x) ? sg(x, d) : '—');
  const tgt = (r, key) => { const t = r.predictions.median.targets.find(x => x.key === key); if (!t) return '—'; if (t.status === 'not-touched') return '未觸及'; if (t.status !== 'ok') return esc(stLabel[t.status] ?? t.status); return `${f(t.projected, 0)} vs ${f(t.actualIndex, 0)}（${pct(t.errPct)}）`; };
  const rows = wf.map(r => [`${esc(r.wave.peakDate.slice(0, 7))}（${neg(r.wave.maxDd, 0)}）`, `${f(r.betas.median, 2)}（前${r.priorN}波）`, f(r.wave.m1, 1), f(r.predictions.median.predMargin, 1), fm(r.predictions.median.errMarginPts),
    `${f(r.betas.prev, 2)} → ${fm(r.predictions.prev.errMarginPts)}`, pct(r.predictions.median.errIndexPct), tgt(r, 'm0-30'), tgt(r, '150')]);
  const e = h.errors, g = h.regime;
  return `<p class="text-muted-sm">每一波只用「之前已結束」的波段估計 Beta（中位數；另列只用上一波），再套到該波實際的指數跌幅預測低點維持率；誤差＝預測−實際（點）。反推指數＝用實際低點維持率反推指數，對照實際低點指數。目標維持率（高點-30 點、150%）若該波從未觸及，標「未觸及」，不算成功也不算失敗。</p>` +
    tbl(['波段（高點月／回撤）', '所用 Beta（前 n 波中位數）', '實際低點維持率', '預測', '誤差（點）', '只用上一波 Beta → 誤差（點）', '反推低點指數誤差', '目標高點-30 點：推估 vs 實際首次觸及日指數', '150%：推估 vs 實際'], rows) +
    `<p><b>誤差摘要（n=${e.median.n}）：</b>中位數 Beta 預測維持率的絕對誤差中位 ${f(e.median.marginErrPtsMedAbs, 1)} 點（${e.median.within5pts}/${e.median.n} 波在 ±5 點內；平均偏差 ${fm(e.median.marginErrPtsMean)} 點）；只用上一波 Beta 則為 ${f(e.prev.marginErrPtsMedAbs, 1)} 點（${e.prev.within5pts}/${e.prev.n} 波在 ±5 點內）。反推指數的絕對誤差中位 ${f(e.median.indexErrPctMedAbs, 1)}%。</p>` +
    `<p class="text-muted-sm">偏差集中的環境：融資期間大幅去槓桿（期間最大跌幅 ≤ ${g.heavyAt}%，${g.heavy.n} 波）平均誤差 ${fm(g.heavy.meanErr)} 點（預測的維持率比實際低，亦即模型高估跌幅）；融資變動較小者（${g.light.n} 波）平均誤差 ${fm(g.light.meanErr)} 點。上一波 Beta 與下一波差很多時（例如 2021→2022、2015、2007）誤差最大，所以不建議只用單一案例的 Beta。</p>`;
}

function overlapHtml() {
  const o = stressOv;
  if (!o) return '<p>資料不足。</p>';
  const c = o.counts;
  const ev = o.events.map(e => [esc(e.date), neg(e.dd), `-${f(e.ratioDrop, 1)} 點`, pct(-e.marginDropPct), e.noClearMarginDrop ? '<b>沒有明顯下降</b>' : '有下降', isNum(e.lagDays) ? `${e.lagDays} 日` : '—']);
  return `<p class="text-muted-sm">只做研究與顯示，不改既有規則。A＝120 日高點回撤≥15%，B＝重建維持率自 120 日高點降≥30 點（固定 120 日、2004-02 起，不隨上方回測參數變動）；融資「沒有明顯下降」＝A∧B 事件首日，融資餘額較 120 日高點降幅 &lt;10%。</p>` +
    tbl(['有維持率的交易日', 'A 成立', 'B 成立', 'A∧B 同時', 'A 不含 B', 'B 不含 A', 'P(B∣A)', 'P(A∣B)', 'Jaccard'],
      [[c.days, c.A, c.B, `<b>${c.both}</b>`, c.Aonly, c.Bonly, `${f(o.pBgivenA, 0)}%`, `${f(o.pAgivenB, 0)}%`, `${f(o.jaccard, 0)}%`]]) +
    `<h4>A∧B 事件（冷卻 20 日）：共 ${o.events.length} 件，其中融資沒有明顯下降 ${o.eventsNoClearMarginDrop} 件</h4>` +
    tbl(['事件首日', '指數回撤', '維持率降幅', '融資 vs 120 日高點', '融資', 'A、B 先後相隔'], ev) +
    `<p class="text-muted-sm"><b>訊號相關性提醒：</b>回撤與維持率下降同源（維持率＝抵押品市值÷融資餘額，股價跌則兩者同步惡化），A、B 幾乎同時成立時，「三選二」可能只是同一件事被算兩次；此時應回頭看融資餘額是否真的下降（C），不要因為兩項成立就認為恐慌已釋放完畢。這裡不另創交易評分。</p>`;
}

function notesHtml(h, v) {
  const ri = raw.ratioInfo, g = res.gaps;
  return `<ul><li>維持率：TWSE MI_MARGN×MI_INDEX <b>逐檔重建</b>（上市 only、含 ETF，民間估算），${esc(g.ratioRange.join('～'))}；<b>不是</b>證交所公布的整戶維持率，也與券商整戶口徑不同、數值偏高。兩個重建檔重疊 ${ri.overlap} 日最大差 ${ri.maxAbsDiff}（口徑相同才拼接）。</li>
    <li>融資餘額：${esc(raw.source ?? 'FinMind 大盤融資餘額')}（億元），與 TWSE 彙總逐日交叉核對差 0。指數：data/TWII.json 收盤（不含股息）。</li>
    <li>日期對齊：所有計算用「同一交易日」的指數、維持率、融資，缺值就略過該波段／區塊，不用鄰近日期補、不補零。最新日期：指數 ${esc(v.alignment.twii ?? '—')}｜維持率 ${esc(v.alignment.ratio ?? '—')}｜融資 ${esc(v.alignment.margin ?? '—')}${v.alignment.aligned ? '（一致）' : '（<b>不一致</b>，推估以三者共同日期為準）'}；皆為收盤資料，不混用盤中。</li>
    <li>130% 是個別信用帳戶的追繳門檻，全市場維持率接近 130% 不代表全面斷頭；150% 不是固定的市場底部。所有推估只標示為「歷史敏感度情境推估」。</li>
    <li>Beta 以「區間累計跌幅比值」定義；未提供 rolling regression，避免與此定義混淆。樣本：獨立波段 ${h.coverage.usable} 段，彼此並非獨立同分布，數字是描述，不是預測。</li>
    <li>歷史 Beta 與回測不使用該波完成後才知道的資料（見 F）；測試：<code>npm test</code>（含 js/tabs/marginstress_calc.test.mjs）；報告重現：<code>node scripts/backtest_margin_stress.mjs --out docs/research/margin-stress-projection-backtest.md</code>。</li></ul>`;
}

// ── 維持率 × 指數（可滑回歷史）與爆掉點 ─────────────────────────────
const UNIT = { idx: '點', rt: '百分點', mg: '億' };
// 較自己的 120 日高點：「-12.3%（-5,812 點，高點 06-22 47,742）」。三個高點是三個不同的量
const hl = (o, key) => {
  if (!o) return '—';
  const d = key === 'idx' ? 0 : 1;
  return `${pct(o.dropPct)}（${sg(o.dropAbs, d)} ${UNIT[key]}，高點 ${esc(o.highDate.slice(5))} ${f(o.high, d)}）`;
};
function ensureSeries() {
  if (stSeries || !raw?.ratio?.length) return;
  stSeries = buildChartSeries({ twii: raw.twii, margin: raw.margin, ratio: raw.ratio });
  stSeriesByDate = new Map(stSeries.map(r => [r.date, r]));
}
function stDates() { return stSeries.map(r => r.date); }
function stCurrentWindow() {
  return windowSlice(stDates(), stWin.endDate, stWin.years);
}
const nearestIn = (dates, d, fallback) => dates.find(x => x >= d) ?? fallback;

function stOption(win) {
  const rows = stSeries.slice(win.i0, win.i1 + 1);
  const dates = rows.map(r => r.date);
  const L = mob() ? 40 : 56, Rr = mob() ? 54 : 56;
  const waves = (stressH?.history ?? []).filter(w => w.independent && w.ok && w.lowDate >= dates[0] && w.peakDate <= dates.at(-1));
  const areas = waves.map(w => [
    { name: `-${f(w.maxDd, 0)}%`, xAxis: nearestIn(dates, w.peakDate, dates[0]), itemStyle: { color: 'rgba(239,68,68,0.10)' }, label: { color: PALETTE.muted, fontSize: 10 } },
    { xAxis: dates.includes(w.lowDate) ? w.lowDate : dates.at(-1) },
  ]);
  const mk = (r, color) => {
    const first = (r.hit3 ? r.first3 : r.first2);
    return {
      value: [r.date, r.close], itemStyle: { color },
      label: first && !mob() ? { show: true, position: 'top', fontSize: 10, color, formatter: `${f(r.m1, 1)}%\n指數${f(r.idx.dropPct, 0)}%｜融資${r.mg ? f(r.mg.dropPct, 0) : '—'}%` } : { show: false },
    };
  };
  const hit3 = rows.filter(r => r.hit3).map(r => mk(r, '#ef4444'));
  const hit2 = rows.filter(r => r.hit2 && !r.hit3).map(r => mk(r, '#f59e0b'));
  const ratioC = '#f59e0b';
  const axis = (gridIndex, show) => ({ type: 'category', gridIndex, data: dates, boundaryGap: false, axisLine: { lineStyle: { color: PALETTE.muted } }, axisLabel: { color: PALETTE.muted, fontSize: 11, show }, axisTick: { show: false }, splitLine: { show: false } });
  const yA = (gridIndex, name, extra = {}) => ({ type: 'value', gridIndex, name, scale: true, nameTextStyle: { color: PALETTE.muted, fontSize: 10 }, axisLabel: { color: PALETTE.muted, fontSize: 11 }, splitLine: { lineStyle: { color: PALETTE.grid } }, ...extra });
  return echartsBase({
    animation: false,
    legend: { top: 0, textStyle: { color: PALETTE.muted, fontSize: 11 }, data: ['加權指數', '融資維持率（重建）', '爆掉點 ≥3%', '爆掉點 2～3%', '融資餘額(億)'] },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'cross' }, backgroundColor: PALETTE.bg, borderColor: PALETTE.border, textStyle: { color: PALETTE.text, fontSize: 12 },
      formatter(params) {
        const r = rows[params?.[0]?.dataIndex];
        if (!r) return '';
        const hit = r.hit3 ? '≥3%' : r.hit2 ? '≥2%' : null;
        const one = `單日融資 ${sg(r.m1, 2)}%（${sg(r.m1Amt, 0)} 億）`;
        return `<b>${r.date}</b>${hit ? ' 🔔' : ''}<br>加權 ${f(r.close, 0)}｜維持率 ${f(r.ratio, 2)}%｜融資 ${f(r.margin, 0)} 億<br>${hit ? hot(`${one} ← 爆掉點 ${hit}`) : one}` +
          `<br>指數較 120 日高點 ${hl(r.idx, 'idx')}<br>維持率較 120 日高點 ${hl(r.rt, 'rt')}<br>融資較 120 日高點 ${hl(r.mg, 'mg')}`;
      },
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: [{ left: L, right: Rr, top: mob() ? 92 : 34, height: mob() ? '48%' : '56%' }, { left: L, right: Rr, top: mob() ? '74%' : '74%', height: '14%' }],
    xAxis: [axis(0, false), axis(1, true)],
    yAxis: [yA(0, mob() ? '' : '維持率 %', { axisLabel: { color: ratioC, fontSize: 11 } }), yA(0, mob() ? '' : '加權指數', { position: 'right', splitLine: { show: false } }), yA(1, mob() ? '' : '融資(億)')],
    series: [
      { name: '融資維持率（重建）', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: rows.map(r => r.ratio), showSymbol: false, lineStyle: { width: 1.6, color: ratioC }, itemStyle: { color: ratioC }, areaStyle: { color: ratioC, opacity: 0.10 },
        markLine: { silent: true, symbol: 'none', label: { formatter: '130% 個別帳戶追繳線', color: PALETTE.muted, fontSize: 10, position: 'insideStartTop' }, lineStyle: { color: PALETTE.muted, type: 'dashed' }, data: [{ yAxis: 130 }] } },
      { name: '加權指數', type: 'line', xAxisIndex: 0, yAxisIndex: 1, data: rows.map(r => r.close), showSymbol: false, lineStyle: { width: 1.4, color: PALETTE.text }, itemStyle: { color: PALETTE.text },
        markArea: { silent: true, label: { color: PALETTE.muted, fontSize: 10 }, data: areas } },
      { name: '爆掉點 ≥3%', type: 'scatter', xAxisIndex: 0, yAxisIndex: 1, data: hit3, symbol: 'triangle', symbolSize: 13, itemStyle: { color: '#ef4444' }, z: 6 },
      { name: '爆掉點 2～3%', type: 'scatter', xAxisIndex: 0, yAxisIndex: 1, data: hit2, symbol: 'circle', symbolSize: 8, itemStyle: { color: '#f59e0b' }, z: 5 },
      { name: '融資餘額(億)', type: 'line', xAxisIndex: 1, yAxisIndex: 2, data: rows.map(r => r.margin), showSymbol: false, connectNulls: false, lineStyle: { width: 1.2, color: '#58a6ff' }, itemStyle: { color: '#58a6ff' }, areaStyle: { color: '#58a6ff', opacity: 0.08 } },
    ],
  });
}

function stHitsTable(win) {
  const rows = stSeries.slice(win.i0, win.i1 + 1).filter(r => r.hit2);
  if (!rows.length) return '<p class="text-muted-sm">這段視窗內沒有單日融資減少 ≥2% 的爆掉點。</p>';
  const cell = (r, o, key) => { if (!o) return '—'; const d = key === 'idx' ? 0 : 1; return `${key === 'idx' ? f(r.close, 0) : key === 'rt' ? `${f(r.ratio, 2)}%` : `${f(r.margin, 0)} 億`}<br>${pct(o.dropPct)}（${sg(o.dropAbs, d)} ${UNIT[key]}）<br><span class="text-muted-sm">高點 ${esc(o.highDate)}：${f(o.high, d)}</span>`; };
  const body = rows.map(r => {
    const lvl = r.hit3 ? '≥3%' : '≥2%';
    const first = (r.hit3 ? r.first3 : r.first2) ? '首次' : '續發';
    const mark = t => (r.hit3 ? hot(t) : `<b>${t}</b>`);
    return [mark(r.date), `${mark(lvl)}｜${first}`, `${mark(`${sg(r.m1, 2)}%`)}<br>${sg(r.m1Amt, 0)} 億`, cell(r, r.idx, 'idx'), cell(r, r.rt, 'rt'), cell(r, r.mg, 'mg')];
  });
  const n3 = rows.filter(r => r.hit3).length;
  return `<p class="text-muted-sm">視窗內共 ${rows.length} 個爆掉點（≥3% ${n3}、2～3% ${rows.length - n3}）。每格的「高點」是該序列<b>自己的</b> 120 日高點（日期與數值各自獨立）；括號內是較該高點減少的量。</p>` +
    tbl(['日期', '門檻｜首次／續發', '單日融資', '指數（較 120 日高點）', '維持率（較 120 日高點）', '融資餘額（較 120 日高點）'], body, 'st-hits-table');
}

function renderStressChart() {
  const host = $('st-chart');
  if (!host) return;
  ensureSeries();
  if (!stSeries?.length) { host.style.display = 'none'; return; }
  host.style.display = '';
  const win = stCurrentWindow();
  if (!win) return;
  if (!stChart) stChart = echarts.init(host, isLight() ? null : 'dark');
  stChart.setOption(stOption(win), { notMerge: true });
  stChart.resize();
  $('st-range').textContent = `${win.startDate} ～ ${win.endDate}${win.clipped ? '（資料起點）' : ''}`;
  const sl = $('st-end'), dates = stDates();
  sl.min = String(Math.min(60, dates.length - 1)); sl.max = String(dates.length - 1); sl.value = String(win.i1);
  $('st-enddate').value = win.endDate;
  $('st-enddate').min = dates[0]; $('st-enddate').max = dates.at(-1);
  for (const c of $('st-width').querySelectorAll('.chip')) c.classList.toggle('active', Number(c.dataset.w) === stWin.years);
  const first = stSeries[0].date;
  $('st-chart-note').textContent = `資料：指數＋重建維持率自 ${first}、融資餘額自 ${raw.margin[0]?.date ?? '—'}${raw.earlyCount ? `（2001–2007 為補遺檔 ${raw.earlyCount} 日）` : ''}；紅區＝指數回撤≥10% 的波段（高點→低點）。維持率是重建值，非官方整戶維持率。`;
  $('st-hits').innerHTML = stHitsTable(win);
}
function fillWaveSelect() {
  const sel = $('st-wave');
  if (!sel || !stressH || sel.dataset.filled === String(stressH.history.length)) return;
  const waves = stressH.history.filter(w => w.independent && w.ok).sort((a, b) => (a.peakDate < b.peakDate ? 1 : -1));
  sel.innerHTML = '<option value="">（選擇波段）</option>' + waves.map(w => `<option value="${esc(w.lowDate)}">${esc(w.peakDate.slice(0, 7))}→${esc(w.lowDate.slice(0, 7))}｜指數 -${f(w.maxDd, 0)}%｜維持率 ${f(w.m0, 0)}→${f(w.m1, 0)}${w.open ? '（未結束）' : ''}</option>`).join('');
  sel.dataset.filled = String(stressH.history.length);
}
// 合併連續的滑桿事件；用 setTimeout 而不是 requestAnimationFrame：分頁在背景時 rAF 會暫停，視窗就不更新
let stTimer = 0;
const stRender = () => { clearTimeout(stTimer); stTimer = setTimeout(() => { try { renderStressChart(); } catch (e) { console.error('[marginalert] st chart failed', e); } }, 16); };
function wireStressChart() {
  chipPicker($('st-width'), 'w', v => { stWin.years = Number(v); stRender(); });
  $('st-end')?.addEventListener('input', e => { const d = stDates()[Number(e.target.value)]; if (d) { stWin.endDate = d; stRender(); } });
  $('st-enddate')?.addEventListener('change', e => { if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) { stWin.endDate = e.target.value; stRender(); } });
  $('st-latest')?.addEventListener('click', () => { stWin.endDate = null; stRender(); });
  const shift = dir => () => {
    const dates = stDates(), w = stCurrentWindow();
    if (!w) return;
    const i = Math.max(Math.min(60, dates.length - 1), Math.min(dates.length - 1, w.i1 + dir * Math.round(stWin.years * 252 / 2)));
    stWin.endDate = i >= dates.length - 1 ? null : dates[i];
    stRender();
  };
  $('st-prev')?.addEventListener('click', shift(-1));
  $('st-next')?.addEventListener('click', shift(1));
  $('st-wave')?.addEventListener('change', e => {
    const low = e.target.value;
    if (!low) return;
    const w = stressH?.history.find(x => x.lowDate === low);
    if (w) { stWin.endDate = endForWave(stDates(), w, stWin.years); stRender(); }
    e.target.value = '';
  });
  $('winchart')?.addEventListener('toggle', () => stChart?.resize());
  $('stress')?.addEventListener('toggle', () => stChart?.resize());
}

function renderStress() {
  const set = (id, html) => { const el = $(id); if (el) el.innerHTML = html; };
  try {
    if (!raw.ratio?.length) { set('st-warn', '無維持率重建資料：融資壓力情境推估停用（不估算）。'); ['st-state', 'st-targets', 'st-ma', 'st-delever', 'st-beta-table', 'st-history', 'st-backtest', 'st-overlap', 'st-notes'].forEach(id => set(id, '')); return; }
    if (!stressH) stressH = analyzeHistory(stressData());
    if (stressOv === null) {
      try { stressOv = signalOverlap(buildDataset(stressData(), { start: '2004-02-11', end: raw.lastDate, lookback: 120 })); } catch (e) { console.warn('[marginalert] overlap failed', e); stressOv = false; }
    }
    const v = scenarioView(stressData(), stressH, { refMode: stressRefMode(), beta: stressBetaInput(), scenario: stressUi.beta === 'light' ? 'light' : 'hist' });
    const warn = [];
    if (!v.ref.ok) warn.push(v.ref.reason === 'date-missing' ? `參考日 ${esc(v.ref.date)} 沒有指數或維持率資料，請改日期` : '指數與維持率沒有共同日期');
    if (!v.alignment.aligned) warn.push('指數／維持率／融資最新日期不一致');
    set('st-warn', warn.length ? `⚠ ${warn.join('；')}` : `資料日 ${esc(v.alignment.twii)}（收盤）｜歷史敏感度情境推估，不是支撐位或底部預測`);
    fillWaveSelect();
    renderStressChart();
    set('st-beta-table', betaTableHtml(stressH));
    set('st-history', historyHtml(stressH));
    set('st-backtest', backtestHtml(stressH));
    set('st-overlap', stressOv ? overlapHtml() : '<p>資料不足。</p>');
    set('st-notes', notesHtml(stressH, v));
    if (!v.ref.ok) { ['st-state', 'st-targets', 'st-ma', 'st-delever'].forEach(id => set(id, '')); return; }
    set('st-state', stateCards(v, stressH));
    set('st-targets', targetsTable(v));
    set('st-ma', maTableHtml(v));
    set('st-delever', deleverHtml(v));
  } catch (e) {
    console.error('[marginalert] stress render failed', e);
    set('st-warn', `⚠ 融資壓力情境推估計算失敗：${esc(e.message || e)}（不影響下方警報回測）`);
  }
}
function syncStressControls() {
  const val = (id, v) => { const el = $(id); if (el) el.value = String(v); };
  val('st-ref', stressUi.ref); val('st-beta', stressUi.beta);
  const rd = $('st-refdate'); if (rd) { rd.style.display = stressUi.ref === 'custom' ? '' : 'none'; rd.value = stressUi.refDate || raw?.lastDate || ''; }
  const cu = $('st-custom'); if (cu) cu.style.display = stressUi.beta === 'custom' ? 'flex' : 'none';
  for (const k of ['low', 'base', 'high']) val(`st-b-${k}`, stressUi.custom[k]);
}
function wireStress() {
  const on = (id, fn) => $(id)?.addEventListener('change', fn);
  on('st-ref', e => { stressUi.ref = e.target.value; syncStressControls(); renderStress(); });
  on('st-refdate', e => { stressUi.refDate = e.target.value; renderStress(); });
  on('st-beta', e => { stressUi.beta = e.target.value; syncStressControls(); renderStress(); });
  for (const k of ['low', 'base', 'high']) on(`st-b-${k}`, e => { const x = Number(e.target.value); if (Number.isFinite(x) && x > 0 && x <= 5) stressUi.custom[k] = x; renderStress(); });
}

// ── 卡片 ─────────────────────────────────────────────────────────────
function renderSummary() {
  const { ds } = res;
  const evs = sel.events;
  const f20 = sel.forward[20], f60 = sel.forward[60];
  const card = (k, v, s = '') => `<div class="lev-card" style="min-width:132px"><div class="lc-sub">${esc(k)}</div><div class="lc-val">${v}</div><div class="lc-sub">${s}</div></div>`;
  const ddMed = median(evs.map(e => e.day.dd));
  $('summary').innerHTML = [
    card('觸發日 / 獨立事件', `${sel.flagDays} / ${evs.length}`, `連續≥2日事件 ${sel.clusters2plus}｜冷卻 ${res.cfg.cooldown} 日`),
    card('事件首日回撤(中位)', neg(ddMed), `${res.cfg.lookback} 日高點（當時已知）`),
    card('20日報酬 中位/均', fwd(sel.forward, 20), `n=${f20?.n ?? 0}｜隔日${res.cfg.entry === 'nextOpen' ? '開盤' : '收盤'}進場`),
    card('60日報酬 中位/均', fwd(sel.forward, 60), `n=${f60?.n ?? 0}`),
    card('20日內再破警報日低點', f20?.n ? `${f(f20.breakLowPct, 0)}%` : '—', `20日最大回撤中位 ${neg(f20 ? -f20.mddMedian : null)}`),
    ratioCard(ds),
    fearCard(ds),
    card('基準：所有日 20日中位', sg(res.baseline.all.forward[20].retMedian) + '%', `回撤≥10%的日子 ${sg(res.baseline.dd10.forward[20].retMedian)}%`),
  ].join('');
  $('status').textContent = `${ds.days[0]?.date}～${ds.days.at(-1)?.date}｜${ds.days.length} 個訊號日｜資料更新 ${raw.marginUpdated ?? '—'}${raw.partial ? `｜⚠ ${raw.partial}` : ''}`;
}

// ── 表格 ─────────────────────────────────────────────────────────────
function tableEvents() {
  const rows = sel.events.map(e => {
    const h = e.fwd?.h;
    const cell = k => (h?.[k] ? sg(h[k].ret) : '—');
    return [hot(e.date), hot(`${f(e.day.m[1], 2)}%`), `${sg(e.day.x[1], 2)}%`, neg(e.day.dd), ratioDelta(e.day.ratio, e.day.r4), e.triggerDays, cell(5), cell(10), cell(20), cell(60),
      h?.[20] ? f(h[20].mdd) + '%' : '—', h?.[20] ? (h[20].breakLow ? '是' : '否') : '—'];
  });
  const sum = res.cfg.horizons.map(k => { const s = sel.forward[k]; return [`${k} 日`, s.n, sg(s.retMean) + '%', sg(s.retMedian) + '%', f(s.winRate, 0) + '%', f(s.mddMedian) + '%', f(s.mddWorst) + '%', f(s.rallyMedian) + '%', f(s.breakLowPct, 0) + '%', f(s.daysToLowMedian, 0)]; });
  return tbl(['持有', 'n', '報酬均值', '報酬中位', '勝率', '最大回撤中位', '最差回撤', '最大反彈中位', '再破警報日低點', '最低點距警報日(日)'], sum) +
    tbl(['事件首日', '融資%', '當日指數%', '回撤', '維持率(距4週高點)', '連續日', '5日%', '10日%', '20日%', '60日%', '20日最大回撤', '20日內再破低'], rows);
}
function tableAnnual() {
  const ths = res.cfg.thresholds;
  return tbl(['年', '交易日', ...ths.map(t => `≥${t}% 日/事件/多日`), '最大單日減幅', '當日指數', '當日回撤'],
    res.annual.map(a => [a.year, a.tradingDays, ...ths.map(t => `${a.byTh[t].days}/${a.byTh[t].events}/${a.byTh[t].multiDay}`),
      a.maxDrop ? `${f(a.maxDrop.pct, 2)}%（${a.maxDrop.date}）` : '—', a.maxDrop ? `${sg(a.maxDrop.idx1, 2)}%` : '—', a.maxDrop ? neg(a.maxDrop.dd) : '—'])) +
    `<p class="text-muted-sm">門檻是巢狀的：-5% 同時算進 2/3/4/5。「事件」＝相隔超過 ${res.cfg.cooldown} 個交易日才算新事件；「多日」＝該事件連續觸發≥2 日。</p>`;
}
function tableThresholds() {
  const ths = res.cfg.thresholds;
  const head = ['訊號', '觸發日', '獨立事件', '首日回撤中位', '5日', '10日', '20日', '60日', '60日最大回撤中位', '20日再破低'];
  const row = (name, v) => [name, v.flagDays ?? v.n, v.events?.length ?? '—', v.ddFirstEventMedian !== undefined ? neg(v.ddFirstEventMedian) : '—',
    fwd(v.forward, 5), fwd(v.forward, 10), fwd(v.forward, 20), fwd(v.forward, 60), f(v.forward[60].mddMedian) + '%', v.forward[20].n ? f(v.forward[20].breakLowPct, 0) + '%' : '—'];
  const main = tbl(head, [...ths.map(t => row(`單日≤-${t}%`, res.thresholds[t])),
    row('基準：所有日', res.baseline.all), row('基準：回撤≥10%', res.baseline.dd10), row('基準：回撤≥15%', res.baseline.dd15)]);
  const gate = tbl(['融資', '回撤閘門', '觸發日', '獨立事件', '波段命中', '距低點中位(日)', '剩餘跌幅中位', '20日 中/均', '60日最大回撤中位', '20日再破低'],
    res.gated.map(g => [`≤-${g.th}%`, g.gate ? `≥${g.gate}%` : '無', g.flagDays, g.events, `${g.waveHit}/${g.waveTotal}`, f(g.leadMedian, 0), sg(g.remainingMedian) + '%', fwd(g.forward, 20), f(g.forward[60].mddMedian) + '%', g.forward[20].n ? f(g.forward[20].breakLowPct, 0) + '%' : '—']));
  return `<p class="text-muted-sm">報酬欄＝中位 / 均值（%）。基準＝所有（或回撤≥N%的）訊號日用同一進場規則。</p>${main}<h4>融資減幅 × 指數回撤閘門（${GATES.join('/')}%）</h4>${gate}`;
}
function tableBands() {
  const b = res.bands120;   // 欄位名沿用；實際回撤用 cfg.lookback
  return `<p class="text-muted-sm">回撤＝收盤相對過去 ${res.cfg.lookback} 日最高收盤（含當日，不用未來資料）。各欄為該區間內「發生」的比例；「之後60日再下跌」只用於事後描述。</p>` +
    tbl(['回撤區間', '交易日', '≤-2%', '≤-3%', '≤-4%', '連2日≤-2%', '3日≤-5%', '5日≤-8%', '之後60日再下跌(中位)', '距低點(日,中位)'],
      b.map(r => [r.label, r.n, ...[r.p2, r.p3, r.p4, r.consec2, r.m3_5, r.m5_8].map(v => f(v) + '%'), f(r.remainMedian) + '%', f(r.daysToLowMedian, 0)])) +
    `<h4>客觀下跌波段</h4>` + tbl(['波段高點', '進入(回撤≥10%)', '波段低點', '結束(<5%)', '最大回撤'],
      res.waves.map(w => [w.peakDate, w.startDate, w.lowDate, w.endDate + (w.open ? '（未結束）' : ''), neg(w.maxDd)]));
}
function tableWindows() {
  const rd = res.rd[res.cfg.minIdxDrop] ?? res.rd[1];
  return tbl(['窗口', '門檻', '觸發日', '獨立事件', '首日回撤中位', '5日', '10日', '20日', '60日', '60日最大回撤中位', '20日再破低'],
    res.windows.map(w => [`${w.N}日`, `≤-${w.th}%`, w.flagDays, w.events, neg(w.ddFirstEventMedian), fwd(w.forward, 5), fwd(w.forward, 10), fwd(w.forward, 20), fwd(w.forward, 60), f(w.forward[60].mddMedian) + '%', w.forward[20].n ? f(w.forward[20].breakLowPct, 0) + '%' : '—'])) +
    `<h4>R／D（指數跌幅下限 ${res.cfg.minIdxDrop}%）</h4><p class="text-muted-sm">R=|融資變動|/|指數變動|；D=|融資|-|指數|（百分點）。指數上漲而融資下降＝「反彈中的去槓桿」，另列、不套 R。指數跌幅不足下限的日子不算（R 會失真）。</p>` +
    tbl(['窗口', '有效下跌樣本', 'R中位', 'D中位', 'R≥1', 'R≥1.5', 'R≥2', '反彈中去槓桿(日)', '20日中位：全部/R≥1/R≥1.5/反彈中'],
      res.cfg.windows.map(N => { const v = rd[N]; return [`${N}日`, v.validFall, f(v.RMedian, 2), f(v.DMedian, 2), v.R_ge1, v.R_ge15, v.R_ge2, v.rebound, [v.fwd20_all, v.fwd20_R1, v.fwd20_R15, v.fwd20_rebound].map(x => sg(x)).join(' / ')]; }));
}
function tableRules() {
  const mk = rs => tbl(['變體(C 條件)', '候選日', '獨立事件', '重複度(日/事)', '波段命中', '首次觸發距低點(日,中位)', '剩餘跌幅中位', '首次觸發回撤中位', '20日 中/均', '60日最大回撤中位', '20日再破低'],
    rs.map(r => [esc(r.label), r.flagDays, r.events, f(r.dupRatio, 1), `${r.waveHit}/${r.waveTotal}`, f(r.leadMedian, 0), sg(r.remainingMedian) + '%', f(r.ddAtFirstMedian) + '%', fwd(r.forward, 20), f(r.forward[60].mddMedian) + '%', r.forward[20].n ? f(r.forward[20].breakLowPct, 0) + '%' : '—']));
  const noB = raw.ratio.length === 0;
  return `<p class="text-muted-sm">A＝${res.cfg.lookback}日高點回撤≥${res.cfg.ruleDd}%；B＝<b>重建</b>維持率自${res.cfg.lookback}日高點降≥${res.cfg.ruleRatioDrop}個百分點（TWSE 逐檔重建、非官方）；C＝依列。≥2 項才列入。${noB ? '<b>無維持率資料，B 不成立（不估算）。</b>' : ''}</p>` +
    `<h4>2/3 規則（含重建 B）</h4>${mk(res.rules2of3)}<h4>僅 A∧C（不依賴重建維持率）</h4>${mk(res.rulesAC)}`;
}
function tableCase() {
  const cs = res.cases.find(c => c.id === ui.caseId) ?? res.cases[0];
  if (!cs) return '<p>此區間無個案資料（調整回測區間）。</p>';
  const first = obj => [2, 3, 4, 5].map(t => { const v = obj[t]; return v ? [`≥${t}%`, v.date, f(v.m1, 2) + '%', sg(v.idx1, 2) + '%', neg(v.dd), v.tdBeforeLow, sg(v.closeToLowPct) + '%'] : [`≥${t}%`, '未觸發', '', '', '', '', '']; });
  const h = ['警報', '首次日期', '當日融資', '當日指數', '回撤', '距區間低點(日)', '警報日收盤→低點'];
  const cv = cs.converge;
  return `<p><b>${esc(cs.label)}</b>（${cs.from}～${cs.to}）：${res.cfg.lookback}日高點 ${cs.peak.date} ${f(cs.peak.close, 0)} → 區間最低收盤 ${cs.low.date} ${f(cs.low.close, 0)}（${neg(cs.low.dd)}）；融資 ${cs.marginHigh.date} ${f(cs.marginHigh.v, 0)} → ${cs.marginLow.date} ${f(cs.marginLow.v, 0)} 億（${f(cs.marginPeakToLowPct)}%）` +
    `${cs.lowDateMatchesHint === null ? '' : cs.lowDateMatchesHint ? `；指定低點 ${cs.lowHint} 與資料一致` : `；<b>指定低點 ${cs.lowHint} 與資料不一致（資料低點 ${cs.low.date}）</b>`}。${cs.main ? '' : '（壓力測試，不作門檻設計依據）'}</p>` +
    tbl(h, first(cs.first)) +
    (Object.keys(cs.firstSincePeak).length ? `<p class="text-muted-sm">窗口起點晚於波段高點 ${cs.peak.date}：自高點起算的首次警報——</p>${tbl(h, first(cs.firstSincePeak))}` : '') +
    (cv ? `<p class="text-muted-sm">-3% 首次警報前後 5 日指數日跌幅：前 均值 ${sg(cv.beforeMean, 2)}%／≤-2% 共 ${cv.beforeDown2} 日；後 均值 ${sg(cv.afterMean, 2)}%／≤-2% 共 ${cv.afterDown2} 日（n=${cv.afterN}）。</p>` : '') +
    `<details class="ui-details"><summary>逐日明細</summary>${tbl(['日期', '收盤', '指數%', '回撤', '融資億', '融資%', '融資Δ億', '3日%', '5日%', '維持率(重建)現在(距高點)', '四週高點(日期)'],
      cs.rows.map(r => { const hit = isNum(r.m1) && r.m1 <= -ui.th && r.dd >= ui.gate; const mark = t => (hit ? hot(t) : t); return [mark(hit ? '🔔 ' + r.date : r.date), f(r.close, 0), sg(r.x1, 2), f(r.dd), f(r.margin, 0), mark(sg(r.m1, 2)), mark(sg(r.dm1, 0)), sg(r.m3), sg(r.m5), ratioDelta(r.ratio, r.r4), r.r4 ? `${f(r.r4.high, 1)}（${r.r4.date.slice(5)}）` : '—']; }))}</details>`;
}
function tableFear() {
  if (!fear) return '<p>無恐懼貪婪資料。</p>';
  const rows = [5, 10, 15, 20, 25].map(t => ({ t, a: fearAnalysis(res.ds, t, sel.flags, res.cfg) }));
  return `<p class="text-muted-sm">F&G &lt; ${ui.fearThr} 視為恐懼區（紫色陰影，可用上方滑桿調 5～25）；警報＝目前選的單日融資門檻（≤-${ui.th}%${ui.gate ? `、回撤≥${ui.gate}%` : ''}）。「相對」＝恐懼日裡警報發生率是否高於非恐懼日（lift&gt;1）。注意：警報多集中在少數幾波，lift 會被少數事件放大；F&G 是美股情緒指數（CNN），2011 年起。</p>` +
    tbl(['F&G <', '恐懼日', '占比', 'P(警報|恐懼)', 'P(警報|非恐懼)', 'lift', '警報日在恐懼區', '事件首日已在恐懼區(含前5日)', '事件首日 F&G 中位'],
      rows.map(({ t, a }) => [`<b>${t === ui.fearThr ? '▶ ' : ''}&lt;${t}</b>`, a.fearDays, f(a.fearShare) + '%', f(a.pAlarmGivenFear) + '%', f(a.pAlarmGivenNot) + '%', f(a.lift, 1),
        `${a.alarmDaysInFear}/${a.alarmDays}（${f(a.pFearGivenAlarm, 0)}%）`, `${a.eventsNearFear}/${a.eventsKnown}`, f(a.fgMedianAtEvent, 1)])) +
    `<h4>逐波段：F&G 最低點／首次進恐懼區 vs 波段低點與首次警報（交易日；正＝早於波段低點）</h4>` +
    tbl(['波段(高點→低點)', '最大回撤', 'F&G 最低(日期)', '最低日距低點', '首次進恐懼區', '距低點', '首次警報', '距低點', '波段內恐懼日', '波段內警報日'],
      fear.waves.map(w => [`${w.peakDate}→${w.lowDate}`, neg(w.maxDd), w.fgMin === null ? '—' : `${f(w.fgMin, 1)}（${w.fgMinDate}）`, w.fgMinToLowTd === null ? '—' : -w.fgMinToLowTd,
        w.firstFearDate ?? '未進入', w.firstFearToLowTd ?? '—', w.firstAlarmDate ?? '未觸發', w.firstAlarmToLowTd ?? '—', w.fearDaysInWave, w.alarmDaysInWave]));
}
function renderTables() {
  $('t-fear').innerHTML = tableFear();
  $('t-events').innerHTML = tableEvents();
  $('t-annual').innerHTML = tableAnnual();
  $('t-thresholds').innerHTML = tableThresholds();
  $('t-bands').innerHTML = tableBands();
  $('t-windows').innerHTML = tableWindows();
  $('t-rules').innerHTML = tableRules();
  $('t-case').innerHTML = tableCase();
  $('sources').innerHTML = sourcesHtml();
}
function sourcesHtml() {
  const g = res.gaps, ri = raw.ratioInfo;
  return `<ul><li>TAIEX：data/TWII.json（${esc(g.twiiRange.join('～'))}，不含股息的收盤指數）。</li>
    <li>上市融資餘額（億元）：${esc(raw.source ?? 'FinMind 大盤融資餘額')}（${esc(g.marginRange.join('～'))}${raw.earlyCount ? `；2001-01-03～2007-12-31 為靜態補遺檔 data/taiwan_margin_total_early.json（${raw.earlyCount} 日，與 TWSE 彙總 964 日逐日核對差 0）` : ''}）；與 TWSE MI_MARGN 彙總數逐日交叉比對差異 0（見報告 A）。</li>
    <li>融資維持率：TWSE MI_MARGN×MI_INDEX <b>逐檔重建</b>（上市 only、含 ETF，與券商整戶口徑不同、偏高），${esc(g.ratioRange.join('～'))}，兩個重建檔重疊 ${ri.overlap} 日最大差 ${ri.maxAbsDiff}。僅作規則 B 參考，非官方公布值。</li>
    <li>缺口：成交量／金額沒有可靠資料（TWII volume 恆為 0），未使用；TWII 缺 ${esc(g.marginOnly.join(', ') || '無')}，不補值、該日不當訊號日。</li>
    <li>上市與上櫃不混用；N 日窗各自回推 N 個交易日；警報用收盤後資料，進場最早為隔日（${res.cfg.entry === 'nextOpen' ? '開盤' : '收盤'}）。</li>
    <li>重現：<code>node scripts/backtest_margin_delever.mjs --out docs/research/margin-delever-alert-backtest.md</code>；引擎 <code>js/tabs/marginalert_calc.mjs</code>，測試 <code>npm test</code>。</li></ul>`;
}

// ── 控制 ─────────────────────────────────────────────────────────────
function syncChips() {
  const val = (id, v) => { const el = $(id); if (el) el.value = String(v); };
  const preset = [2, 3, 4, 5].includes(ui.th);
  val('th-select', preset ? ui.th : 'custom');
  const ti = $('th-input'); if (ti) { ti.style.display = preset ? 'none' : ''; ti.value = ui.th; }
  val('gate-select', ui.gate); val('fg-select', ui.fg ? 'on' : 'off'); val('lb-select', ui.lookback);
  val('entry-select', ui.entry); val('mind-select', ui.minIdxDrop); val('case-select', ui.caseId);
  val('fear-range', ui.fearThr);
  const fv = $('fear-val'); if (fv) fv.textContent = ui.fearThr;
  val('cooldown', ui.cooldown); val('start', ui.start); val('end', ui.end);
  for (const c of $('range-chips')?.querySelectorAll('.chip') ?? []) c.classList.toggle('active', c.dataset.s === ui.start);
  const line = $('params-line');
  if (line) line.textContent = `融資≤-${ui.th}%｜閘門${ui.gate ? `≥${ui.gate}%` : '無'}｜F&G ${ui.fg ? `顯示 <${ui.fearThr}` : '隱藏'}｜${ui.lookback}日高點｜隔日${ui.entry === 'nextOpen' ? '開盤' : '收盤'}｜冷卻${ui.cooldown}日｜${ui.start}～${ui.end}`;
}
function renderZone() {
  const el = $('zone');
  if (!el) return;
  const days = res.ds.days;
  const last = [...days].reverse().find(d => isNum(d.ratio));
  if (!last) { el.innerHTML = '<p class="text-muted-sm">無維持率資料，分區與推估停用。</p>'; return; }
  const st = zoneStats(days, ui.th);
  const hits = days.filter(d => isNum(d.ratio) && isNum(d.m[1]) && d.m[1] <= -ui.th);
  const missed = hits.filter(d => d.ratio >= WARN_LV).length;
  const rng = z => (z.key === 'ok' ? `≥ ${WARN_LV}` : z.key === 'warn' ? `${BOOM_LV}～${WARN_LV}` : `< ${BOOM_LV}`);
  const card = `<div class="lev-card" style="min-width:240px;max-width:360px"><div class="lc-sub">最新 ${esc(last.date)}｜維持率(重建)</div>` +
    `<div class="lc-val">${f(last.ratio, 1)} ${zoneText(zoneOf(last.ratio))}</div><div class="lc-sub" style="line-height:1.6">${projLine(last)}<br>${needLine(last, WARN_LV, '警戒')}<br>${needLine(last, BOOM_LV, '爆炸')}</div></div>`;
  el.innerHTML = card +
    `<div style="flex:1;min-width:260px">` +
    tbl(['維持率', '交易日', '當天融資≤-' + ui.th + '%', '之後1～3日'],
      st.map(r => [`${zoneText(r.z)} ${rng(r.z)}`, r.n, r.n ? `${f(r.same / r.n * 100, 1)}%` : '—', r.n ? `${f(r.next3 / r.n * 100, 1)}%` : '—'])) +
    `<p class="text-muted-sm">${esc(res.cfg.start)}～${esc(res.cfg.end)}。爆量日 ${hits.length} 天中有 ${missed} 天發生在維持率 ≥${WARN_LV}（固定線抓不到，多在波段剛開始急殺時）。跌${DROP_PCT}% 推估用歷史 β 中位、假設融資餘額不變，是情境不是預測。</p></div>`;
}
function draw() {
  renderSummary();
  renderStress();
  renderZone();
  renderTables();
  return preserveChartState(() => (chart ? [chart] : []), () => { chart.setOption(buildOption(), { notMerge: true }); });
}
function readInputs() {
  if ($('th-select').value === 'custom') {
    const th = Number($('th-input').value);
    if (Number.isFinite(th) && th >= 0.5 && th <= 20) ui.th = Math.round(th * 10) / 10;
  }
  const cd = Math.round(Number($('cooldown').value));
  if (Number.isFinite(cd) && cd >= 0 && cd <= 60) ui.cooldown = cd;
  const s = $('start').value, e = $('end').value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) ui.start = s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(e)) ui.end = e;
  if (ui.start > ui.end) [ui.start, ui.end] = [ui.end, ui.start];
}
function rerun(fromInputs = true) {
  if (fromInputs) readInputs();
  syncChips();
  const t0 = performance.now();
  recompute();
  draw();
  $('timing').textContent = `重跑 ${Math.round(performance.now() - t0)} ms`;
}
// ⓘ 說明：點一下顯示、再點一下（或點別處／Esc）關閉；同時只開一個
let pop = null, popBtn = null;
function closeInfo() {
  if (popBtn) { popBtn.setAttribute('aria-expanded', 'false'); popBtn.removeAttribute('aria-describedby'); }
  if (pop) pop.hidden = true;
  popBtn = null;
}
function placeInfo() {
  if (!pop || !popBtn) return;
  if (!popBtn.isConnected || popBtn.offsetParent === null) { closeInfo(); return; }
  const pos = tooltipPosition(popBtn.getBoundingClientRect(), { width: pop.offsetWidth, height: pop.offsetHeight }, { width: innerWidth, height: innerHeight });
  if (!pos) { closeInfo(); return; }
  pop.style.left = `${pos.left}px`; pop.style.top = `${pos.top}px`;
}
function toggleInfo(btn) {
  if (popBtn === btn) { closeInfo(); return; }
  closeInfo();
  if (!pop) {
    pop = document.createElement('div');
    pop.className = 'ma-pop'; pop.id = `${TAB_ID}-pop`; pop.setAttribute('role', 'tooltip'); pop.hidden = true;
    document.body.append(pop);
  }
  popBtn = btn;
  pop.textContent = btn.dataset.info || '';
  pop.hidden = false;
  btn.setAttribute('aria-expanded', 'true'); btn.setAttribute('aria-describedby', pop.id);
  placeInfo();
}
function wireInfo() {
  document.addEventListener('click', e => {
    const btn = e.target.closest?.('.ma-info');
    if (btn && btn.closest(`#tab-${TAB_ID}`)) { e.preventDefault(); toggleInfo(btn); return; }
    if (popBtn && !pop.contains(e.target)) closeInfo();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeInfo(); });
  window.addEventListener('resize', placeInfo);
  window.addEventListener('scroll', placeInfo, true);
  window.addEventListener('hashchange', closeInfo);
}

function wire() {
  if (wired) return;
  wired = true;
  wireInfo();
  chipPicker($('range-chips'), 's', v => { ui.start = v; rerun(false); });
  wireStress();
  wireStressChart();
  const on = (id, fn) => $(id)?.addEventListener('change', fn);
  on('fg-select', e => { ui.fg = e.target.value === 'on'; syncChips(); draw(); });
  $('fear-range')?.addEventListener('input', e => { ui.fearThr = clampFear(e.target.value); recompute(); syncChips(); draw(); });
  on('th-select', e => {
    if (e.target.value === 'custom') { $('th-input').style.display = ''; $('th-input').focus(); return; }
    ui.th = Number(e.target.value); rerun(false);
  });
  on('gate-select', e => { ui.gate = Number(e.target.value); deriveSelection(); syncChips(); draw(); });
  on('lb-select', e => { ui.lookback = Number(e.target.value); rerun(false); });
  on('entry-select', e => { ui.entry = e.target.value; rerun(false); });
  on('mind-select', e => { ui.minIdxDrop = Number(e.target.value); rerun(false); });
  on('case-select', e => { ui.caseId = e.target.value; $('t-case').innerHTML = tableCase(); zoomToCase(); });
  $('run')?.addEventListener('click', () => rerun(true));
  $('reset')?.addEventListener('click', () => {
    ui = { fg: true, fearThr: 15, th: 3, gate: 0, caseId: 'A', lookback: 120, entry: 'nextOpen', cooldown: 10, minIdxDrop: 1, start: PAGE_START, end: raw.lastDate };
    rerun(false);
  });
  for (const id of ['th-input', 'cooldown', 'start', 'end']) on(id, () => rerun(true));
}

// ── lifecycle ────────────────────────────────────────────────────────
export async function activate(context = {}) {
  const host = $('chart');
  if (!host) return;
  if (!chart) chart = echarts.init(host, isLight() ? null : 'dark');
  try {
    await loadAll(context);
    if (context.signal?.aborted || context.isCurrent?.() === false) return;
    wire();
    syncChips();
    syncStressControls();
    if (!res) recompute();
    await draw();
    chart.resize();
  } catch (e) {
    console.error(`[${TAB_ID}] load failed`, e);
    const s = $('status');
    if (s) s.textContent = '載入失敗：' + (e.message || e);
    throw e;
  }
}
export function onThemeChange(light) {
  closeInfo();
  if (!chart) return;
  const host = $('chart');
  chart.dispose();
  chart = echarts.init(host, light ? null : 'dark');
  if (res) chart.setOption(buildOption(), { notMerge: true });
  if (stChart) {
    stChart.dispose();
    stChart = echarts.init($('st-chart'), light ? null : 'dark');
    if (stSeries?.length) { const w = stCurrentWindow(); if (w) stChart.setOption(stOption(w), { notMerge: true }); }
  }
}
export function resize() { chart?.resize(); stChart?.resize(); }
export function getCharts() { return [chart, stChart].filter(Boolean); }
