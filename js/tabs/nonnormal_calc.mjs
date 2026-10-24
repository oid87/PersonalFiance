// 極端狀態儀表板 — 純函式引擎（無 DOM、無 fetch）。js/tabs/nonnormal.js 與 scripts/research/backtest_nonnormal.mjs 共用。
// 每個閾值都標 src：'ref'（常見的市場經驗門檻）或 'project'（本專案定義），
// 自訂部分的理由見 docs/research/nonnormal-dashboard.md。描述性風險儀表板，不產生買賣指令。
//
// 防未來函數：每週的評估日只用「評估日當天或之前」的資料（lookup ≤ date）；均線、20 日高低點都以
// 該序列自己的交易日往回算。序列最新一筆距評估日超過 staleDays 個日曆日 → 該訊號 unavailable，
// 不當成未亮燈。
import { mergeRatio } from './marginalert_calc.mjs';

const DAY = 86400000;
const finite = v => typeof v === 'number' && Number.isFinite(v);
const days = (a, b) => (Date.parse(b) - Date.parse(a)) / DAY;
const iso = t => new Date(t).toISOString().slice(0, 10);

export const P = Object.freeze({
  maShort: 100,       // 短均線（100 個交易日）。使用者偏好 100/200/400（也可用季線／年線／兩年線 60/240/480）
  maLong: 200,        // 長均線（200 個交易日）
  ma2y: 400,          // 超長均線（400 個交易日）
  window: 20,         // 「急跌／急漲／一個月內」的計算期間：20 個交易日內的高低點（本專案定義）
  slopeLag: 20,       // 均線方向：與 20 個交易日前的均線比較（本專案定義）
  soxShock: 0.15,     // 費半急跌 > 15–20%（取下緣）
  soxDayDrop: 0.05,   // 費半盤中跌 5% → 隔天台股大機率受牽動（只當註記）
  spxShock: 0.05,     // S&P 500 崩跌 > 5%
  yieldJump: 0.25,    // 本專案：10Y 在 20 個交易日內自低點上升 ≥ 25bp（經驗上只說「快速上升」）
  dxyPoints: 5,       // 美元指數一個月內移動 > 5 點
  goldJump: 0.05,     // 黃金急漲 > 5%
  oilMove: 0.20,      // 油價急漲／急跌 > 20%
  vix: [15, 20, 30, 40], // VIX 五個區間的分界
  margin: [166, 150, 140, 130], // 融資維持率分層
  staleDays: 10,      // 本專案：資料比評估日舊超過 10 個日曆日即 unavailable
  horizonWeeks: 13,   // 回測：亮燈後看 13 週（約一季）的加權最大跌幅
  ddHit: 0.10,        // 回測：13 週內最大跌幅 ≥ 10% 算「之後真的出現明顯下跌」
});

// 資料檔。ref:true 只顯示、不計入共振。
export const SERIES = [
  { id: 'SOX', file: 'SOXX.json', label: '費半（SOXX）' },
  { id: 'SPX', file: 'VOO.json', label: 'S&P 500（VOO）' },
  { id: 'NDX', file: 'QQQ.json', label: '那斯達克 100（QQQ）' },
  { id: 'KOSPI', file: 'KS11.json', label: '韓國綜合指數' },
  { id: 'N225', file: 'N225.json', label: '日經 225', ref: true },
  { id: 'HSI', file: 'HSI.json', label: '恆生指數', ref: true },
  { id: 'SSE', file: 'SSE.json', label: '上證指數', ref: true },
  { id: 'STOXX50E', file: 'STOXX50E.json', label: '歐洲 Stoxx 50', ref: true },
  { id: 'US10Y', file: 'US10Y.json', label: '美國 10 年期殖利率', field: 'value', unit: '%' },
  { id: 'US2Y', file: 'US2Y.json', label: '美國 2 年期殖利率', field: 'value', unit: '%', ref: true },
  { id: 'DXY', file: 'DXY.json', label: '美元指數' },
  { id: 'GOLD', file: 'GCF.json', label: '黃金期貨' },
  { id: 'OIL', file: 'BRENT.json', label: '布蘭特原油' },
  { id: 'VIX', file: 'VIX.json', label: 'VIX' },
  { id: 'VXN', file: 'VXN.json', label: 'VXN', ref: true },
  { id: 'FG', file: 'fear_greed.json', label: 'CNN 恐懼貪婪指數', field: 'value', ref: true },
  { id: 'US_BREADTH', file: 'breadth.json', label: '美股市場廣度（S&P 500 成分股站上 200 日線比例）', field: 'above200_pct', ref: true },
  { id: 'BTC', file: 'BTC.json', label: '比特幣', ref: true },
  { id: 'TWII', file: 'TWII.json', label: '加權指數' },
  { id: 'TWOII', file: 'TWOII.json', label: '櫃買指數' },
];
export const EXTRA_FILES = { marginMm: 'taiwan_margin_ratio_mm.json', marginDaily: 'taiwan_margin_ratio.json', tpex: 'tpex_margin.json', breadth: 'tw_breadth_ls.json' };

// 兩個本專案的定義選擇，預設值在看歷史案例前依原則決定；回測 CLI 會列出四種組合的敏感度。
//   trendSlope：國際股市「轉弱」＝跌破短均線「且均線下彎」（費半趨勢：跌破均線且長期向下）。
//               false＝只看跌破。櫃買不受影響：櫃買「跌破均線」就提高警覺。
//   breadthDivergence：廣度收窄只在「加權仍在短均線上」時成立（指數強、個股弱）。false＝偏空多於偏多即成立。
export const DEFAULT_OPTS = Object.freeze({ trendSlope: true, breadthDivergence: true });

// ── series features ───────────────────────────────────────────────────────
function rollingMean(c, len) {
  const out = new Array(c.length).fill(null);
  let s = 0;
  for (let i = 0; i < c.length; i++) {
    s += c[i];
    if (i >= len) s -= c[i - len];
    if (i >= len - 1) out[i] = s / len;
  }
  return out;
}
function rollingExtreme(c, len, pick) {
  const out = new Array(c.length).fill(null);
  for (let i = 0; i < c.length; i++) {
    let v = c[i];
    for (let j = Math.max(0, i - len + 1); j < i; j++) v = pick(v, c[j]);
    out[i] = v;
  }
  return out;
}

/** rows [{date, close|value, low?}] → feature series. Rows with a non-finite value are dropped, never filled. */
export function buildSeries(rows = [], field = 'close') {
  const pts = rows.filter(r => r && typeof r.date === 'string' && finite(r[field]))
    .map(r => ({ date: r.date, v: r[field], low: finite(r.low) ? r.low : null }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .filter((r, i, a) => i === 0 || r.date !== a[i - 1].date);
  const close = pts.map(p => p.v);
  return {
    dates: pts.map(p => p.date), close, low: pts.map(p => p.low),
    ma: { [P.maShort]: rollingMean(close, P.maShort), [P.maLong]: rollingMean(close, P.maLong), [P.ma2y]: rollingMean(close, P.ma2y) },
    hi: rollingExtreme(close, P.window, Math.max), lo: rollingExtreme(close, P.window, Math.min),
  };
}

/** Index of the last row with date ≤ d, or -1. */
export function indexLE(s, d) {
  let lo = 0, hi = s.dates.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (s.dates[m] <= d) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}

/** Feature snapshot of series s as of date d. null = no data yet; {stale:true} = last row too old. */
export function at(s, d) {
  if (!s) return null;
  const i = indexLE(s, d);
  if (i < 0) return null;
  if (days(s.dates[i], d) > P.staleDays) return { stale: true, date: s.dates[i] };
  const c = s.close[i], ma = k => s.ma[k][i];
  return {
    i, date: s.dates[i], close: c, maS: ma(P.maShort), maL: ma(P.maLong), maXL: ma(P.ma2y),
    maSPrev: i >= P.slopeLag ? s.ma[P.maShort][i - P.slopeLag] : null,
    hi20: s.hi[i], lo20: s.lo[i],
    ddHigh: s.hi[i] > 0 ? c / s.hi[i] - 1 : null,   // 距 20 日高點（負值＝跌幅）
    upLow: s.lo[i] > 0 ? c / s.lo[i] - 1 : null,    // 距 20 日低點（正值＝漲幅）
  };
}
const usable = f => f && !f.stale;
const below = (f, k = 'maS') => (usable(f) && finite(f[k]) ? f.close < f[k] : null);
/** 國際股市「轉弱」：跌破短均線；opts.trendSlope 時另需短均線比 20 個交易日前低。null＝均線方向還算不出來。 */
function weakTrend(ctx, f) {
  if (!(f.close < f.maS)) return false;
  if (!ctx.opts.trendSlope) return true;
  return finite(f.maSPrev) ? f.maS < f.maSPrev : null;
}
const trendText = (ctx, f) => `${f.close < f.maS ? '低於' : '高於'} ${P.maShort} 日線 ${pct(f.close / f.maS - 1)}${finite(f.maSPrev) ? `｜均線${f.maS < f.maSPrev ? '下彎' : '上揚'}` : ''}`;

/** % change of s from the last close on/before (d − n calendar days) to the last close on/before d. */
export function changeSince(s, d, n) {
  const a = at(s, d), b = s ? indexLE(s, iso(Date.parse(d) - n * DAY)) : -1;
  if (!usable(a) || b < 0 || !(s.close[b] > 0)) return null;
  return a.close / s.close[b] - 1;
}
/** Worst single-day (low ÷ previous close − 1) in the 7 calendar days ending d. */
export function worstDayDrop(s, d) {
  const i = indexLE(s, d);
  let worst = null;
  for (let j = i; j > 0 && days(s.dates[j], d) < 7; j--) {
    const low = finite(s.low[j]) ? s.low[j] : s.close[j], r = low / s.close[j - 1] - 1;
    if (worst === null || r < worst) worst = r;
  }
  return worst;
}

// ── context ───────────────────────────────────────────────────────────────
/** raw: { SOX:[rows], SPX:[rows], …, marginMm:[rows], marginDaily:[rows], breadth:[rows] } (JSON .data arrays). */
export function buildContext(raw = {}, opts = {}) {
  const s = {};
  for (const def of SERIES) s[def.id] = buildSeries(raw[def.id] || [], def.field || 'close');
  const merged = mergeRatio(raw.marginMm || [], raw.marginDaily || []).rows;
  s.MARGIN = buildSeries(merged, 'ratio');
  s.MARGIN_EX = buildSeries((raw.marginMm || []).filter(r => finite(r?.ratio_exetf)), 'ratio_exetf');
  s.MARGIN_OTC = buildSeries(raw.tpex || [], 'ratio_all');   // 上櫃（含 ETF），分母 2026-08-24 起才有
  const breadth = (raw.breadth || []).filter(r => finite(r?.bull) && finite(r?.bear)).sort((a, b) => (a.date < b.date ? -1 : 1));
  s.BREADTH = { dates: breadth.map(r => r.date), rows: breadth };
  s.BREADTH_PCT = buildSeries(breadth.filter(r => r.bull + r.bear > 0).map(r => ({ date: r.date, close: (r.bull / (r.bull + r.bear)) * 100 })));
  const last = s.TWII.dates.at(-1) || null, lastUs = s.SPX.dates.at(-1) || null;
  return { s, opts: { ...DEFAULT_OPTS, ...opts }, lastDate: [last, lastUs].filter(Boolean).sort().at(-1) || null };
}
function breadthAt(ctx, d) {
  const b = ctx.s.BREADTH, i = indexLE(b, d);
  if (i < 0) return null;
  if (days(b.dates[i], d) > P.staleDays) return { stale: true, date: b.dates[i] };
  return b.rows[i];
}

// ── zones / tiers ───────────────────────────────────────────────────────
export const VIX_ZONES = [
  { max: 15, label: '< 15 極度平靜', action: '正常策略' },
  { max: 20, label: '15–20 正常', action: '正常策略' },
  { max: 30, label: '20–30 不安', action: '注意資金' },
  { max: 40, label: '30–40 恐慌', action: '先不亂賣；突破 30 準備資金' },
  { max: Infinity, label: '≥ 40 極度恐慌', action: '行動窗口' },
];
export const vixZone = v => (finite(v) ? VIX_ZONES.findIndex(z => v < z.max) : -1);

export const MARGIN_TIERS = [
  { min: 166, label: '≥ 166% 無壓力' },
  { min: 150, label: '150–166%' },
  { min: 140, label: '< 150% 承壓' },
  { min: 130, label: '< 140% 接近追繳' },
  { min: -Infinity, label: '< 130% 斷頭（強烈反向）' },
];
export const marginTier = r => (finite(r) ? MARGIN_TIERS.findIndex(t => r >= t.min) : -1);

// ── signals ───────────────────────────────────────────────────────────────
const pct = (x, d = 1) => (finite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%` : '—');
const na = (f, why) => ({ state: 'na', reason: f?.stale ? `資料停在 ${f.date}` : why || '尚無資料' });
const on = b => (b ? 'on' : 'off');
/** 美股大盤（S&P 500、那斯達克）：20 日內自高點跌 ≥ 5% 或轉弱。 */
function usStock(ctx, s, d) {
  const f = at(s, d);
  if (!usable(f) || !finite(f.maS)) return na(f);
  const shock = f.ddHigh <= -P.spxShock, weak = weakTrend(ctx, f), tags = [];
  if (weak === null && !shock) return na(null, '均線方向尚無法計算');
  if (shock) tags.push('崩跌 > 5%');
  return { state: on(shock || weak), asOf: f.date, value: f.close, text: `距 20 日高 ${pct(f.ddHigh)}｜${trendText(ctx, f)}`, tags };
}

export const GROUPS = { A: '國際股市', B: '金融市場訊號', C: '台股內部' };

export const SIGNALS = [
  {
    id: 'sox', short: '費半', group: 'A', label: '費半轉弱／急跌', series: 'SOX',
    rule: '跌破 100 日線且均線下彎，或 20 日內自高點跌 ≥ 15%',
    thresholds: [['急跌 > 15–20%（取 15%）', 'ref'], ['跌破均線且長期向下＝趨勢轉空', 'ref'], ['期間＝20 個交易日；均線＝100 日線', 'project'], ['單日盤中跌 ≥ 5% 只註記', 'ref']],
    eval(ctx, d) {
      const s = ctx.s.SOX, f = at(s, d);
      if (!usable(f) || !finite(f.maS)) return na(f);
      const shock = f.ddHigh <= -P.soxShock, weak = weakTrend(ctx, f), day = worstDayDrop(s, d), tags = [];
      if (weak === null && !shock) return na(null, '均線方向尚無法計算');
      if (shock) tags.push('急跌');
      if (finite(f.maL) && f.close < f.maL) tags.push('破 200 日線');
      if (finite(day) && day <= -P.soxDayDrop) tags.push(`單日盤中 ${pct(day)}`);
      return { state: on(shock || weak), asOf: f.date, value: f.close, text: `距 20 日高 ${pct(f.ddHigh)}｜${trendText(ctx, f)}`, tags };
    },
  },
  {
    id: 'ndx', short: '那斯達克', group: 'A', label: '那斯達克轉弱／崩跌', series: 'NDX',
    rule: '跌破 100 日線且均線下彎，或 20 日內自高點跌 ≥ 5%',
    thresholds: [['比照 S&P 500：崩跌 > 5%、轉弱＝跌破下彎的 100 日線', 'project'], ['用 QQQ 代表那斯達克 100', 'project']],
    eval: (ctx, d) => usStock(ctx, ctx.s.NDX, d),
  },
  {
    id: 'spx', short: 'S&P 500', group: 'A', label: 'S&P 500 轉弱／崩跌', series: 'SPX',
    rule: '跌破 100 日線且均線下彎，或 20 日內自高點跌 ≥ 5%',
    thresholds: [['崩跌 > 5%', 'ref'], ['期間＝20 個交易日', 'project'], ['轉弱＝跌破 100 日線且均線下彎', 'project']],
    eval: (ctx, d) => usStock(ctx, ctx.s.SPX, d),
  },
  {
    id: 'kospi', short: '韓股', group: 'A', label: '韓股轉弱', series: 'KOSPI',
    rule: '跌破 100 日線且均線下彎',
    thresholds: [['韓股先轉弱、台股未跌要提高警覺', 'ref'], ['轉弱＝跌破 100 日線且均線下彎', 'project']],
    eval(ctx, d) {
      const f = at(ctx.s.KOSPI, d), tw = at(ctx.s.TWII, d);
      if (!usable(f) || !finite(f.maS)) return na(f);
      const weak = weakTrend(ctx, f), tags = [];
      if (weak === null) return na(null, '均線方向尚無法計算');
      if (weak && below(tw) === false) tags.push('韓先弱、加權未破');
      return { state: on(weak), asOf: f.date, value: f.close, text: trendText(ctx, f), tags };
    },
  },
  {
    id: 'us10y', short: '美債 10Y', group: 'B', label: '美債 10Y 快速上升', series: 'US10Y',
    rule: '20 日內自低點上升 ≥ 25bp',
    thresholds: [['快速上升＝科技股估值壓力', 'ref'], ['20 日 ≥ 25bp', 'project'], ['2Y > 10Y 倒掛只註記', 'ref']],
    eval(ctx, d) {
      const f = at(ctx.s.US10Y, d), y2 = at(ctx.s.US2Y, d);
      if (!usable(f)) return na(f);
      const rise = Math.round((f.close - f.lo20) * 1e6) / 1e6, tags = [];   // 殖利率是兩位小數，避免 0.2499999 這類浮點誤差
      const spread = usable(y2) ? f.close - y2.close : null;
      if (finite(spread) && spread < 0) tags.push(`倒掛 ${(spread * 100).toFixed(0)}bp（不計）`);
      return { state: on(rise >= P.yieldJump), asOf: f.date, value: f.close, text: `${f.close.toFixed(2)}%｜20 日自低點 +${(rise * 100).toFixed(0)}bp${finite(spread) ? `｜10Y−2Y ${(spread * 100).toFixed(0)}bp` : ''}`, tags };
    },
  },
  {
    id: 'dxy', short: '美元', group: 'B', label: '美元走強', series: 'DXY',
    rule: '站上 100 日線且均線上揚，或 20 日內自低點漲 > 5 點',
    thresholds: [['一個月內移動 > 5 點', 'ref'], ['期間＝20 個交易日', 'project'], ['站上上揚的 100 日線＝走強', 'project']],
    eval(ctx, d) {
      const f = at(ctx.s.DXY, d);
      if (!usable(f) || !finite(f.maS) || !finite(f.maSPrev)) return na(f);
      const jump = f.close - f.lo20 > P.dxyPoints, fall = f.close - f.hi20 < -P.dxyPoints;
      const trend = f.close > f.maS && f.maS > f.maSPrev, tags = [];
      if (jump) tags.push('急漲 > 5 點');
      if (fall) tags.push('急跌 > 5 點（不計）');
      return { state: on(trend || jump), asOf: f.date, value: f.close, text: `${f.close.toFixed(1)}｜20 日 +${(f.close - f.lo20).toFixed(1)}／${(f.close - f.hi20).toFixed(1)} 點｜均線${f.maS > f.maSPrev ? '上揚' : '下彎'}`, tags };
    },
  },
  {
    id: 'gold', short: '黃金', group: 'B', label: '黃金恐慌型急漲', series: 'GOLD',
    rule: '20 日內自低點急漲 ≥ 5%，且 VIX ≥ 20',
    thresholds: [['急漲 > 5% → 觀察 VIX', 'ref'], ['期間＝20 個交易日', 'project'], ['VIX ≥ 20 才算恐慌型', 'project']],
    eval(ctx, d) {
      const f = at(ctx.s.GOLD, d), v = at(ctx.s.VIX, d);
      if (!usable(f) || !usable(v)) return na(usable(f) ? v : f);
      const jump = f.upLow >= P.goldJump, panic = jump && v.close >= P.vix[1], tags = [];
      if (jump && !panic) tags.push('非恐慌型（不計）');
      return { state: on(panic), asOf: f.date, value: f.close, text: `20 日自低點 ${pct(f.upLow)}｜VIX ${v.close.toFixed(1)}`, tags };
    },
  },
  {
    id: 'oil', short: '原油', group: 'B', label: '原油急漲／急跌', series: 'OIL',
    rule: '布蘭特 20 日內自低點急漲 ≥ 20% 或自高點急跌 ≥ 20%',
    thresholds: [['急漲／急跌 > 20%（雙面訊號）', 'ref'], ['期間＝20 個交易日', 'project'], ['用布蘭特', 'project']],
    eval(ctx, d) {
      const f = at(ctx.s.OIL, d);
      if (!usable(f)) return na(f, '布蘭特 2007-07 起');
      const up = f.upLow >= P.oilMove, down = f.ddHigh <= -P.oilMove, tags = [];
      if (up) tags.push('急漲');
      if (down) tags.push('急跌');
      return { state: on(up || down), asOf: f.date, value: f.close, text: `${f.close.toFixed(1)}｜20 日自低點 ${pct(f.upLow)}／自高點 ${pct(f.ddHigh)}`, tags };
    },
  },
  {
    id: 'vix', short: 'VIX', group: 'B', label: 'VIX 升高', series: 'VIX',
    rule: '收盤 ≥ 20',
    thresholds: [['20–30 開始不安；30 以上恐慌', 'ref']],
    eval(ctx, d) {
      const f = at(ctx.s.VIX, d);
      if (!usable(f)) return na(f);
      return { state: on(f.close >= P.vix[1]), asOf: f.date, value: f.close, text: `${f.close.toFixed(1)}｜${VIX_ZONES[vixZone(f.close)].label}`, tags: [] };
    },
  },
  {
    id: 'otc', short: '櫃買', group: 'C', label: '櫃買轉弱', series: 'TWOII',
    rule: '收盤跌破 100 日線',
    thresholds: [['櫃買先跌破均線要提高警覺', 'ref'], ['均線＝100 日線', 'project']],
    eval(ctx, d) {
      const f = at(ctx.s.TWOII, d), tw = at(ctx.s.TWII, d);
      if (!usable(f) || !finite(f.maS)) return na(f, '櫃買 2013-03 起');
      const weak = f.close < f.maS, tags = [];
      if (weak && below(tw) === false) tags.push('先於加權');
      if (finite(f.maL) && f.close < f.maL) tags.push('破 200 日線');
      if (finite(f.maXL) && f.close < f.maXL) tags.push('破 400 日線');
      return { state: on(weak), asOf: f.date, value: f.close, text: `${weak ? '低於' : '高於'} ${P.maShort} 日線 ${pct(f.close / f.maS - 1)}`, tags };
    },
  },
  {
    id: 'margin', short: '融資維持率', group: 'C', label: '融資維持率承壓', series: 'MARGIN',
    rule: '上市或上櫃融資維持率（本站計算、含 ETF）< 150%',
    thresholds: [['150% 以下承壓', 'ref'], ['用本站計算值（含 ETF 口徑）', 'project'], ['上櫃也計入（2026-08-24 起有資料）', 'project']],
    eval(ctx, d) {
      const m = marginNow(ctx, d);
      if (!m) return na(at(ctx.s.MARGIN, d), '重建維持率 2004-02 起');
      const tags = m.value < P.margin[1] ? [`${m.market} ${MARGIN_TIERS[marginTier(m.value)].label}`] : [];
      const text = [m.listed && `上市 ${m.listed.close.toFixed(1)}%`, m.otc && `上櫃 ${m.otc.close.toFixed(1)}%`].filter(Boolean).join('｜');
      return { state: on(m.value < P.margin[1]), asOf: m.asOf, value: m.value, text, tags };
    },
  },
  {
    id: 'breadth', short: '廣度', group: 'C', label: '廣度收窄', series: 'BREADTH',
    rule: '加權仍在 100 日線上，但偏空家數 > 偏多家數',
    thresholds: [['指數強、個股弱＝廣度收窄', 'ref'], ['用本站多空家數近似；指數強＝加權在 100 日線上', 'project']],
    eval(ctx, d) {
      const b = breadthAt(ctx, d), tw = at(ctx.s.TWII, d);
      if (!b || b.stale) return na(b, '多空家數 2024-04 起');
      if (!usable(tw) || !finite(tw.maS)) return na(tw, '判斷「指數強」需要加權資料');
      const weak = b.bear > b.bull, strong = below(tw) === false, tags = [];
      if (weak && strong) tags.push('指數強、個股弱');
      if (weak && !strong) tags.push('全面轉弱' + (ctx.opts.breadthDivergence ? '（不計）' : ''));
      const lit = weak && (strong || !ctx.opts.breadthDivergence);
      return { state: on(lit), asOf: b.date, value: b.bear - b.bull, text: `偏多 ${b.bull}／偏空 ${b.bear}（${b.n} 檔）`, tags };
    },
  },
];

/** 上市／上櫃融資維持率取較低者（各自過期就不用）。null＝兩者都沒有可用資料。 */
function marginNow(ctx, d) {
  const a = at(ctx.s.MARGIN, d), b = at(ctx.s.MARGIN_OTC, d);
  const listed = usable(a) ? a : null, otc = usable(b) ? b : null;
  if (!listed && !otc) return null;
  const low = !otc || (listed && listed.close <= otc.close) ? listed : otc;
  return { listed, otc, value: low.close, market: low === listed ? '上市' : '上櫃', asOf: [listed?.date, otc?.date].filter(Boolean).sort().at(-1) };
}

// ── levels ────────────────────────────────────────────────────────────────
export const LEVELS = [
  { label: '常態', desc: '0–1 個訊號亮燈：單一訊號視為雜訊' },
  { label: '留意', desc: '2–3 個訊號，或 4 個以上但都集中在同一組' },
  { label: '警戒', desc: '4 個以上、且橫跨至少 2 組（多市場同向）' },
  { label: '高度警戒', desc: '6 個以上、且三組都有亮燈' },
];
export function levelOf(count, groups) {
  if (count >= 6 && groups >= 3) return 3;
  if (count >= 4 && groups >= 2) return 2;
  if (count >= 2) return 1;
  return 0;
}

export function evaluateWeek(ctx, date) {
  const signals = SIGNALS.map(def => {
    const r = def.eval(ctx, date);
    return { id: def.id, group: def.group, label: def.label, ...r, tags: r.tags || [] };
  });
  const lit = signals.filter(x => x.state === 'on');
  const groups = new Set(lit.map(x => x.group)).size;
  return { date, signals, lit: lit.map(x => x.id), count: lit.length, available: signals.filter(x => x.state !== 'na').length, groups, level: levelOf(lit.length, groups) };
}

/** Week-end evaluation dates: every Friday in [from, min(to, ctx.lastDate)]. The running week (ctx.lastDate after the
 *  last Friday) is evaluated at ctx.lastDate; a Saturday make-up session replaces its own week's Friday. */
export function weekDates(ctx, from, to = ctx.lastDate) {
  const end = [to, ctx.lastDate].filter(Boolean).sort()[0];
  if (!from || !end || from > end) return [];
  const out = [];
  let t = Date.parse(from);
  while (new Date(t).getUTCDay() !== 5) t += DAY;
  for (; iso(t) <= end; t += 7 * DAY) out.push(iso(t));
  if (end === ctx.lastDate && (!out.length || out.at(-1) < end)) {
    if (out.length && new Date(Date.parse(end)).getUTCDay() === 6 && days(out.at(-1), end) === 1) out[out.length - 1] = end;
    else out.push(end);
  }
  return out;
}
export const history = (ctx, from, to) => weekDates(ctx, from, to).map(d => evaluateWeek(ctx, d));

// ── TWII vs TWOII time lag ───────────────────────────────────────────────
/** First date of the current streak below MA k (null when above / unknown). */
export function belowSince(s, k, d) {
  let i = indexLE(s, d);
  const m = s.ma[k];
  if (i < 0 || !finite(m[i]) || !(s.close[i] < m[i])) return null;
  while (i > 0 && finite(m[i - 1]) && s.close[i - 1] < m[i - 1]) i--;
  return s.dates[i];
}
export function leadLag(ctx, d) {
  const tw = ctx.s.TWII, two = ctx.s.TWOII;
  return [[P.maShort, '100 日線'], [P.maLong, '200 日線'], [P.ma2y, '400 日線']].map(([k, label]) => {
    const a = belowSince(two, k, d), b = belowSince(tw, k, d);
    const tradingGap = a && b ? indexLE(tw, b) - indexLE(tw, a) : null;
    let note = '';
    if (a && !b) note = '櫃買先破、加權未破';
    else if (!a && b) note = '加權破、櫃買抗跌';
    else if (a && b) note = tradingGap > 0 ? `櫃買早 ${tradingGap} 日` : tradingGap < 0 ? `加權早 ${-tradingGap} 日` : '同日';
    else note = '都在線上';
    return { ma: k, label, otcBelowSince: a, twiiBelowSince: b, tradingGap, note };
  });
}

// ── quote cards (principle 3: look at every market's reaction) ──────────
/** Card data for series s as of d: last value, change vs the previous row and vs ~1 week ago, and a window of the last
 *  `span` calendar days with moving averages (computed on the full history, so they exist from the window's first day). */
export function quote(s, d, { span = 183, mas = [50, 100] } = {}) {
  const i = s ? indexLE(s, d) : -1;
  if (i < 0) return null;
  for (const k of mas) s.ma[k] ??= rollingMean(s.close, k);
  const from = iso(Date.parse(s.dates[i]) - span * DAY);
  let j = i;
  while (j > 0 && s.dates[j - 1] >= from) j--;
  const last = s.close[i], prev = i > 0 ? s.close[i - 1] : null, w = indexLE(s, iso(Date.parse(s.dates[i]) - 7 * DAY));
  return {
    date: s.dates[i], from, stale: days(s.dates[i], d) > P.staleDays, last, prev,
    chg: finite(prev) ? last - prev : null, chgPct: prev > 0 ? last / prev - 1 : null,
    w1: w >= 0 ? last - s.close[w] : null, w1Pct: w >= 0 && s.close[w] > 0 ? last / s.close[w] - 1 : null,
    dates: s.dates.slice(j, i + 1), close: s.close.slice(j, i + 1),
    ma: Object.fromEntries(mas.map(k => [k, s.ma[k].slice(j, i + 1)])),
  };
}

// ── turnaround panel ──────────────────────────────────────────
export function turnaround(ctx, d) {
  const v = at(ctx.s.VIX, d), m = marginNow(ctx, d);
  return {
    vix: usable(v) ? { value: v.close, zone: vixZone(v.close), asOf: v.date } : null,
    margin: m ? { value: m.value, market: m.market, listed: m.listed?.close ?? null, otc: m.otc?.close ?? null, tier: marginTier(m.value), asOf: m.asOf } : null,
    asymmetricHint: usable(v) ? v.close >= P.vix[2] : null,     // VIX 30–40 以上是不對稱機會的工具之一
    marginBelow140: m ? m.value < P.margin[2] : null,           // 多燈同亮條件之一（上市、上櫃取低者）
  };
}

// ── backtest helpers ─────────────────────────────────────────────────────
export const CASES = [
  { id: '2022', label: '2022 年空頭', from: '2021-10-01', event: '2022-03-07', eventText: '加權跌破年線',
    note: '加權 3 月才跌破年線，但 2022 年 1 月已多市場轉弱（那斯達克、費半、S&P 500 1 月下旬轉中性偏空；10Y 上升；韓股、櫃買 1 月轉弱）' },
  { id: '2025', label: '2025 年 4 月關稅崩跌', from: '2024-10-01', event: '2025-04-02', eventText: '對等關稅宣布（台股 4/7 崩跌）',
    note: '崩跌前已累積：廣度收窄、融資維持率約 143%、櫃買長期在年線下、美股 2 月開始下跌' },
  { id: '2026', label: '2026 年 7 月櫃買斷頭', from: '2026-04-01', event: '2026-07-17', eventText: '加權跌破季線（7/30 到年線）',
    note: '櫃買 7/14 先跌破季線，加權 7/17 跟破，7/30 來到年線' },
];

/** Worst TWII close over the next `weeks` weeks relative to the close on d (decline from the start, not peak-to-trough).
 *  null until TWII itself has data through the end of the window. */
export function forwardDrawdown(ctx, d, weeks = P.horizonWeeks) {
  const s = ctx.s.TWII, i = indexLE(s, d), end = iso(Date.parse(d) + weeks * 7 * DAY);
  if (i < 0 || !(s.dates.at(-1) >= end)) return null;
  let worst = 0;
  for (let j = i + 1; j < s.dates.length && s.dates[j] <= end; j++) worst = Math.min(worst, s.close[j] / s.close[i] - 1);
  return worst;
}

/** Per historical case: week-by-week levels up to the event, the alert run in force at the event, and lead time. */
export function caseResult(ctx, c, minLevel = 2) {
  const weeks = history(ctx, c.from, iso(Date.parse(c.event) + 21 * DAY));
  const before = weeks.filter(w => w.date < c.event);
  const last = before.at(-1) || null;
  let runStart = null;
  if (last && last.level >= minLevel) {
    let k = before.length - 1;
    while (k > 0 && before[k - 1].level >= minLevel) k--;
    runStart = before[k].date;
  }
  const firstAny = before.find(w => w.level >= minLevel)?.date || null;
  const peak = before.reduce((m, w) => (w.count > (m?.count ?? -1) ? w : m), null);
  return {
    ...c, weeks, lastBefore: last, runStart, firstAny,
    leadWeeks: runStart ? Math.round(days(runStart, c.event) / 7) : null,
    peakBefore: peak,
    maxLevel8w: before.slice(-8).reduce((m, w) => Math.max(m, w.level), 0),
  };
}

/** Base rates over all weeks in [from, to]: share per level and forward TWII drawdown, plus alert-run hit rate. */
export function baseRates(ctx, from, to = ctx.lastDate, minLevel = 2) {
  const weeks = history(ctx, from, to);
  const share = LEVELS.map((_, k) => weeks.filter(w => w.level === k).length);
  const runs = [];
  for (let i = 0; i < weeks.length; i++) {
    if (weeks[i].level >= minLevel && (i === 0 || weeks[i - 1].level < minLevel)) {
      let j = i;
      while (j + 1 < weeks.length && weeks[j + 1].level >= minLevel) j++;
      runs.push({ start: weeks[i].date, end: weeks[j].date, weeks: j - i + 1, maxLevel: Math.max(...weeks.slice(i, j + 1).map(w => w.level)), fwd: forwardDrawdown(ctx, weeks[i].date) });
    }
  }
  const fwdAll = weeks.map(w => forwardDrawdown(ctx, w.date)).filter(finite);
  const fwdAlert = weeks.filter(w => w.level >= minLevel).map(w => forwardDrawdown(ctx, w.date)).filter(finite);
  const hit = arr => (arr.length ? arr.filter(x => x <= -P.ddHit).length / arr.length : null);
  const done = runs.filter(r => finite(r.fwd));
  return { from, to, weeks: weeks.length, share, runs, hitAll: hit(fwdAll), hitAlert: hit(fwdAlert), nAll: fwdAll.length, nAlert: fwdAlert.length,
    runHit: done.length ? done.filter(r => r.fwd <= -P.ddHit).length / done.length : null, runsComplete: done.length };
}
