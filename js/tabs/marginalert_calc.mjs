// 台股融資去槓桿警報 — 純函式回測引擎（無 DOM、無 fetch；tab 與 CLI 共用同一份）。
//
// 資料契約（皆為上市 only、融資金額單位＝億元）：
//   twii   [{date, open, high, low, close}]            data/TWII.json（不含股息的加權指數）
//   margin [{date, margin_money}]                      data/taiwan_margin_total.json（FinMind 大盤融資餘額）
//   ratio  [{date, ratio}]                             TWSE MI_MARGN×MI_INDEX 重建的維持率（非官方，非券商整戶口徑）
//
// 防未來函數原則：
//   - 每一個特徵（回撤、融資變動、維持率高點）只用「訊號日收盤當下已知」的資料。
//   - 滾動高點、維持率高點以訊號日往前 lookback 根（含當日）計；暖機期使用 start 之前的真實歷史，
//     不是把區間截短後才算。
//   - 訊號收盤後才產生 → 進場最早為下一交易日（entry='nextOpen' 開盤、'nextClose' 收盤）。
// 不補造資料：TWII 缺而融資有的日期（如 2021-04-06）不進入訊號日；回報在 gaps。

import { mean } from '../utils/math.js';

export const DEFAULTS = Object.freeze({
  start: '2020-01-01',
  end: '2026-10-16',
  lookback: 120,          // 滾動高點窗（交易日，含當日）
  cooldown: 10,           // 兩個觸發日相隔 > cooldown 個交易日 → 視為新獨立事件
  entry: 'nextOpen',      // 'nextOpen' | 'nextClose'
  horizons: [5, 10, 20, 60],
  thresholds: [2, 3, 4, 5],        // 單日融資減幅 %
  minIdxDrop: 1,                   // R 定義的最低有效指數跌幅 %
  windows: [1, 2, 3, 5],
  ruleDd: 15,                      // 規則 A：回撤 ≥ 15%
  ruleRatioDrop: 30,               // 規則 B：維持率自 lookback 高點降 ≥ 30 個百分點
  ruleAbsDrop: 100,                // 規則 C：單日融資減少 ≥ 100 億
  ruleCooldown: 20,
  waveEnter: 10,                   // 客觀「下跌波段」：回撤 ≥ 10% 進入
  waveExit: 5,                     // 回撤收斂到 < 5% 結束
  fearThr: 15,                     // 恐懼貪婪 < 此值視為恐懼區（可調 5～25）
  ratioWindow: 20,                 // 「四週內」維持率高點窗（交易日，含當日）
});

export const DD_BANDS = [5, 10, 12, 15, 18, 20, 25];

export const CASES = [
  { id: 'A', label: 'Case A 2024/7～8', from: '2024-07-11', to: '2024-08-09', lowHint: '2024-08-05', main: true },
  { id: 'B', label: 'Case B 2026/7～8', from: '2026-07-01', to: '2026-08-07', lowHint: '2026-07-30', main: true },
  { id: 'S1', label: '壓力測試 2020/3 疫情', from: '2020-02-17', to: '2020-04-15', lowHint: null, main: false },
  { id: 'S2', label: '壓力測試 2025/4 關稅戰', from: '2025-03-10', to: '2025-05-09', lowHint: null, main: false },
];

// ── 小工具 ──────────────────────────────────────────────────────────
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

export function median(vals) {
  const s = vals.filter(isNum).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length;
  return m % 2 ? s[(m - 1) / 2] : (s[m / 2 - 1] + s[m / 2]) / 2;
}
export const avg = vals => {
  const v = vals.filter(isNum);
  return v.length ? mean(v) : null;
};
const pct = x => (isNum(x) ? x * 100 : null);

// ── 資料整理 ────────────────────────────────────────────────────────
function cleanRows(rows, valueKeys) {
  const out = [];
  const seen = new Set();
  for (const r of rows || []) {
    if (!r || typeof r.date !== 'string' || seen.has(r.date)) continue;
    if (!valueKeys.every(k => isNum(r[k]) && r[k] > 0)) continue;
    seen.add(r.date);
    out.push(r);
  }
  return out.sort(byDate);
}

// 滾動最大（含當日、至多 L 根）；回傳 [{max, idx}]
function rollingMax(values, L) {
  const out = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let best = -Infinity, bi = i;
    for (let j = Math.max(0, i - L + 1); j <= i; j++) {
      if (values[j] >= best) { best = values[j]; bi = j; }
    }
    out[i] = { max: best, idx: bi };
  }
  return out;
}

/** 維持率合併：mm（ratio_all，2004～）與 recon（2022-12～）重疊區間數值一致；以 recon 為準。 */
export function mergeRatio(mm = [], recon = []) {
  const m = new Map();
  for (const r of mm) if (isNum(r?.ratio_all)) m.set(r.date, { date: r.date, ratio: r.ratio_all });
  let overlap = 0, maxAbsDiff = 0;
  for (const r of recon) {
    if (!isNum(r?.ratio)) continue;
    if (m.has(r.date)) { overlap += 1; maxAbsDiff = Math.max(maxAbsDiff, Math.abs(m.get(r.date).ratio - r.ratio)); }
    m.set(r.date, { date: r.date, ratio: r.ratio });
  }
  return { rows: [...m.values()].sort(byDate), overlap, maxAbsDiff };
}

/**
 * 組出所有特徵。回傳 { tw, days, gaps, ratioSeries }。
 *  tw   : 整段 TWII（含暖機），每根有 dd(回撤 %，正數＝跌幅)、peakIdx、idxN
 *  days : 訊號日（TWII ∩ 融資 ∩ [start,end]），含融資特徵與規則特徵
 */
export function buildDataset({ twii, margin, ratio = [], fearGreed = [] }, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const tw = cleanRows(twii, ['open', 'high', 'low', 'close']);
  const rawCounts = { twii: (twii || []).length, twiiKept: tw.length, margin: (margin || []).length };
  const mg = cleanRows(margin, ['margin_money']);
  rawCounts.marginKept = mg.length;
  const rt = cleanRows(ratio.map(r => ({ date: r.date, ratio: r.ratio })), ['ratio']);

  // 恐懼貪婪（CNN，0–100）：只用「當日或之前最近一筆」（最多往前 4 天，不補未來、不內插）
  const fgSeen = new Set();
  const fgRows = (fearGreed || []).filter(r => typeof r?.date === 'string' && isNum(r.value) && r.value >= 0 && r.value <= 100 && !fgSeen.has(r.date) && fgSeen.add(r.date))
    .map(r => ({ date: r.date, value: r.value })).sort(byDate);
  const fgIdx = new Map(fgRows.map((r, i) => [r.date, i]));
  const twIdx = new Map(tw.map((r, i) => [r.date, i]));
  const mgIdx = new Map(mg.map((r, i) => [r.date, i]));
  const rtIdx = new Map(rt.map((r, i) => [r.date, i]));

  // 指數：回撤＝(1 - close/rollingHigh)×100，用 close 的 lookback 根高點（含當日）
  const closes = tw.map(r => r.close);
  const hi = rollingMax(closes, c.lookback);
  const hi252 = rollingMax(closes, 252);
  tw.forEach((r, i) => {
    r.dd = (1 - r.close / hi[i].max) * 100;
    r.peakIdx = hi[i].idx;
    r.dd252 = (1 - r.close / hi252[i].max) * 100;
  });

  // 維持率：自身日曆上的 lookback 高點
  const rtHi = rollingMax(rt.map(r => r.ratio), c.lookback);
  rt.forEach((r, i) => { r.ratioDrop = rtHi[i].max - r.ratio; r.ratioHigh = rtHi[i].max; });
  // 四週（ratioWindow 個交易日，含當日）內維持率高點：值、日期、現在與高點的差（點）
  const rtHi4 = rollingMax(rt.map(r => r.ratio), c.ratioWindow);
  rt.forEach((r, i) => { r.r4 = { high: rtHi4[i].max, date: rt[rtHi4[i].idx].date, diff: r.ratio - rtHi4[i].max }; });

  const days = [];
  const twiiOnly = [], marginOnly = [];
  for (const r of tw) if (r.date >= c.start && r.date <= c.end && !mgIdx.has(r.date)) twiiOnly.push(r.date);
  for (const r of mg) if (r.date >= c.start && r.date <= c.end && !twIdx.has(r.date)) marginOnly.push(r.date);

  for (const m of mg) {
    if (m.date < c.start || m.date > c.end) continue;
    const ti = twIdx.get(m.date);
    if (ti === undefined) continue;
    const mi = mgIdx.get(m.date);
    const d = { date: m.date, ti, mi, close: tw[ti].close, low: tw[ti].low, high: tw[ti].high, open: tw[ti].open,
      margin: m.margin_money, dd: tw[ti].dd, dd252: tw[ti].dd252, m: {}, x: {}, dm1: null, ratio: null, ratioDrop: null, r4: null, fg: null };
    for (const N of [1, 2, 3, 5, ...c.windows]) {
      // 融資在自身日曆上回推 N 個交易日；指數同理（兩邊日曆只差 2021-04-06，見 gaps）
      d.m[N] = mi - N >= 0 ? (m.margin_money / mg[mi - N].margin_money - 1) * 100 : null;
      d.x[N] = ti - N >= 0 ? (tw[ti].close / tw[ti - N].close - 1) * 100 : null;
    }
    d.dm1 = mi >= 1 ? m.margin_money - mg[mi - 1].margin_money : null;
    const fi = fgIdx.get(m.date);
    if (fi !== undefined) d.fg = fgRows[fi].value;
    const ri = rtIdx.get(m.date);
    if (ri !== undefined) { d.ratio = rt[ri].ratio; d.ratioDrop = rt[ri].ratioDrop; d.r4 = rt[ri].r4; }
    days.push(d);
  }

  const ratioMissing = days.filter(d => d.ratio === null).map(d => d.date);
  return {
    cfg: c, tw, mg, rt, days, rawCounts, fgRows,
    gaps: {
      twiiOnly, marginOnly, ratioMissing,
      twiiRange: [tw[0]?.date, tw.at(-1)?.date],
      marginRange: [mg[0]?.date, mg.at(-1)?.date],
      ratioRange: [rt[0]?.date, rt.at(-1)?.date],
      fgRange: [fgRows[0]?.date, fgRows.at(-1)?.date],
      fgMissingDays: days.filter(d => d.fg === null).length,
    },
  };
}

// ── 事件聚合 ────────────────────────────────────────────────────────
/** flagIdx：days 內被觸發的位置（升冪）。相鄰觸發相隔 > cooldown 根 → 新事件。 */
export function clusterEvents(flagIdx, cooldown) {
  const ev = [];
  for (const i of flagIdx) {
    const last = ev.at(-1);
    if (last && i - last.lastIdx <= cooldown) { last.lastIdx = i; last.triggerDays += 1; last.idxs.push(i); }
    else ev.push({ startIdx: i, lastIdx: i, triggerDays: 1, idxs: [i] });
  }
  return ev;
}

// ── 警報後表現 ──────────────────────────────────────────────────────
/** 以 TWII 日曆（ti）為準，訊號日 t（收盤後）→ 進場 t+1。 */
export function forwardStats(ds, day, cfg = ds.cfg) {
  const { tw } = ds;
  const t = day.ti;
  const e = t + 1;
  if (e >= tw.length) return null;
  const entryPrice = cfg.entry === 'nextClose' ? tw[e].close : tw[e].open;
  const firstWin = cfg.entry === 'nextClose' ? e + 1 : e; // 持有期間內可被「看見」的 bar 起點
  const out = { entryDate: tw[e].date, entryPrice, h: {} };
  for (const h of cfg.horizons) {
    const exit = cfg.entry === 'nextClose' ? e + h : e + h - 1; // h 個交易日持有
    if (exit >= tw.length) { out.h[h] = null; continue; }
    let lo = Infinity, hi = -Infinity, loIdx = firstWin, brk = false;
    for (let j = firstWin; j <= exit; j++) {
      if (tw[j].low < lo) { lo = tw[j].low; loIdx = j; }
      if (tw[j].high > hi) hi = tw[j].high;
      if (tw[j].low < day.low) brk = true;
    }
    out.h[h] = {
      ret: (tw[exit].close / entryPrice - 1) * 100,
      mdd: Math.min(0, (lo / entryPrice - 1) * 100),   // 持有期間最大回撤（相對進場價；0 表示未低於進場價）
      rally: Math.max(0, (hi / entryPrice - 1) * 100),
      breakLow: brk,                                       // 是否跌破警報日最低點
      daysToLow: loIdx - t,                                // 後續最低點距警報日（交易日）
    };
  }
  return out;
}

export function summarizeForward(rows, horizons) {
  const res = {};
  for (const h of horizons) {
    const v = rows.map(r => r?.h?.[h]).filter(Boolean);
    res[h] = {
      n: v.length,
      retMean: avg(v.map(x => x.ret)), retMedian: median(v.map(x => x.ret)),
      winRate: v.length ? v.filter(x => x.ret > 0).length / v.length * 100 : null,
      mddMean: avg(v.map(x => x.mdd)), mddMedian: median(v.map(x => x.mdd)),
      mddWorst: v.length ? Math.min(...v.map(x => x.mdd)) : null,
      rallyMean: avg(v.map(x => x.rally)), rallyMedian: median(v.map(x => x.rally)),
      breakLowPct: v.length ? v.filter(x => x.breakLow).length / v.length * 100 : null,
      daysToLowMedian: median(v.map(x => x.daysToLow)),
    };
  }
  return res;
}

/** 給一組 flags(days 位置) → 每日訊號統計 + 獨立事件 + 事件後表現 */
export function evaluateFlags(ds, flagIdx, cfg = ds.cfg, cooldown = cfg.cooldown) {
  const events = clusterEvents(flagIdx, cooldown).map(ev => {
    const day = ds.days[ev.startIdx];
    const fwd = forwardStats(ds, day, cfg);
    return { ...ev, date: day.date, day, fwd };
  });
  return {
    flagDays: flagIdx.length,
    events,
    clusters2plus: events.filter(e => e.triggerDays >= 2).length,
    forward: summarizeForward(events.map(e => e.fwd), cfg.horizons),
  };
}

/** 基準：全部訊號日 / 條件日（例如回撤 ≥10%）的 forward，用來判斷警報有沒有超額效果。 */
export function baselineForward(ds, filter = () => true, cfg = ds.cfg) {
  const rows = [];
  ds.days.forEach(d => { if (filter(d)) rows.push(forwardStats(ds, d, cfg)); });
  return { n: rows.length, forward: summarizeForward(rows, cfg.horizons) };
}

// ── B 單日融資減幅警報 ─────────────────────────────────────────────
export function singleDayFlags(ds, thPct) {
  const idx = [];
  ds.days.forEach((d, i) => { if (isNum(d.m[1]) && d.m[1] <= -thPct) idx.push(i); });
  return idx;
}

export function annualStats(ds, cfg = ds.cfg) {
  const years = [...new Set(ds.days.map(d => d.date.slice(0, 4)))];
  const rows = [];
  for (const y of years) {
    const yd = ds.days.filter(d => d.date.startsWith(y));
    const row = { year: y, tradingDays: yd.length, byTh: {}, maxDrop: null };
    let worst = null;
    for (const d of yd) if (isNum(d.m[1]) && (!worst || d.m[1] < worst.m[1])) worst = d;
    if (worst) row.maxDrop = { date: worst.date, pct: worst.m[1], idx1: worst.x[1], dd: worst.dd };
    for (const th of cfg.thresholds) {
      const flags = [];
      yd.forEach((d, i) => { if (isNum(d.m[1]) && d.m[1] <= -th) flags.push(i); });
      const ev = clusterEvents(flags, cfg.cooldown);
      row.byTh[th] = { days: flags.length, events: ev.length, multiDay: ev.filter(e => e.triggerDays >= 2).length };
    }
    rows.push(row);
  }
  return rows;
}

/** 各門檻：觸發日當日指數跌幅、距高點回撤、整體事件與後續表現 */
export function thresholdComparison(ds, cfg = ds.cfg) {
  const out = {};
  for (const th of cfg.thresholds) {
    const flags = singleDayFlags(ds, th);
    const ev = evaluateFlags(ds, flags, cfg);
    const days = flags.map(i => ds.days[i]);
    out[th] = {
      ...ev,
      idx1Mean: avg(days.map(d => d.x[1])), idx1Median: median(days.map(d => d.x[1])),
      idxUpDays: days.filter(d => d.x[1] > 0).length,
      ddMean: avg(days.map(d => d.dd)), ddMedian: median(days.map(d => d.dd)),
      ddFirstEventMean: avg(ev.events.map(e => e.day.dd)),
      ddFirstEventMedian: median(ev.events.map(e => e.day.dd)),
      ddFirstEventLt10: ev.events.filter(e => e.day.dd < 10).length,
    };
  }
  return out;
}

// ── 回撤區間 vs 融資清洗 ────────────────────────────────────────────
export function drawdownBandTable(ds, cfg = ds.cfg, key = 'dd') {
  const edges = [0, ...DD_BANDS, Infinity];
  const rows = [];
  for (let b = 0; b < edges.length - 1; b++) {
    const lo = edges[b], hi = edges[b + 1];
    const idxs = [];
    ds.days.forEach((d, i) => { if (d[key] >= lo && d[key] < hi) idxs.push(i); });
    const sel = idxs.map(i => ds.days[i]);
    const sh = f => (sel.length ? sel.filter(f).length / sel.length * 100 : null);
    const two = i => isNum(ds.days[i].m[1]) && ds.days[i].m[1] <= -2;
    const consec = sel.filter(d => {
      const i = ds.days.indexOf(d);
      return two(i) && i > 0 && two(i - 1);
    }).length;
    // 後續波段低點：未來 60 根 TWII 最低收盤 / 當日收盤（只用來事後描述，非訊號）
    const remain = [], daysTo = [];
    for (const d of sel) {
      let lo2 = Infinity, li = d.ti;
      for (let j = d.ti + 1; j <= Math.min(d.ti + 60, ds.tw.length - 1); j++) if (ds.tw[j].close < lo2) { lo2 = ds.tw[j].close; li = j; }
      if (d.ti + 60 < ds.tw.length) { remain.push(Math.min(0, (lo2 / d.close - 1) * 100)); daysTo.push(li - d.ti); }
    }
    rows.push({
      label: hi === Infinity ? `≥${lo}%` : `${lo}%～<${hi}%`, lo, hi, n: sel.length,
      p2: sh(d => isNum(d.m[1]) && d.m[1] <= -2),
      p3: sh(d => isNum(d.m[1]) && d.m[1] <= -3),
      p4: sh(d => isNum(d.m[1]) && d.m[1] <= -4),
      consec2: sel.length ? consec / sel.length * 100 : null,
      m3_5: sh(d => isNum(d.m[3]) && d.m[3] <= -5),
      m5_8: sh(d => isNum(d.m[5]) && d.m[5] <= -8),
      remainMedian: median(remain), remainMean: avg(remain), daysToLowMedian: median(daysTo), remainN: remain.length,
    });
  }
  return rows;
}

// ── N 日累積收縮 / R / D ───────────────────────────────────────────
export function rdMetrics(day, N, minIdxDrop) {
  const mN = day.m[N], xN = day.x[N];
  if (!isNum(mN) || !isNum(xN)) return { kind: 'na' };
  if (xN > 0 && mN < 0) return { kind: 'rebound', mN, xN };           // 反彈中的去槓桿：不套用 R 定義
  if (xN <= -minIdxDrop && mN < 0) {
    return { kind: 'fall', mN, xN, R: Math.abs(mN) / Math.abs(xN), D: Math.abs(mN) - Math.abs(xN) };
  }
  return { kind: 'none', mN, xN };                                    // 指數跌幅不足或融資未減少
}

export function rdSummary(ds, cfg = ds.cfg, minIdxDrop = cfg.minIdxDrop) {
  const out = {};
  for (const N of cfg.windows) {
    const fall = [], rebound = [];
    ds.days.forEach(d => {
      const r = rdMetrics(d, N, minIdxDrop);
      if (r.kind === 'fall') fall.push({ d, ...r });
      else if (r.kind === 'rebound') rebound.push({ d, ...r });
    });
    const bucket = f => fall.filter(f);
    const fwd20 = arr => median(arr.map(x => forwardStats(ds, x.d, cfg)?.h?.[20]?.ret));
    out[N] = {
      validFall: fall.length, rebound: rebound.length,
      RMedian: median(fall.map(x => x.R)), DMedian: median(fall.map(x => x.D)),
      R_ge1: bucket(x => x.R >= 1).length, R_ge15: bucket(x => x.R >= 1.5).length, R_ge2: bucket(x => x.R >= 2).length,
      fwd20_all: fwd20(fall), fwd20_R1: fwd20(bucket(x => x.R >= 1)), fwd20_R15: fwd20(bucket(x => x.R >= 1.5)),
      fwd20_rebound: fwd20(rebound),
    };
  }
  return out;
}

/** 累積窗口警報：N 日融資累積減幅 ≤ -th（%） */
export function windowFlags(ds, N, thPct) {
  const idx = [];
  ds.days.forEach((d, i) => { if (isNum(d.m[N]) && d.m[N] <= -thPct) idx.push(i); });
  return idx;
}

export const WINDOW_CANDIDATES = [
  { N: 1, ths: [2, 3, 4] }, { N: 2, ths: [3, 4, 5] }, { N: 3, ths: [4, 5, 6] }, { N: 5, ths: [6, 8, 10] },
];

export function windowComparison(ds, cfg = ds.cfg) {
  const rows = [];
  for (const { N, ths } of WINDOW_CANDIDATES) {
    for (const th of ths) {
      const ev = evaluateFlags(ds, windowFlags(ds, N, th), cfg);
      rows.push({ N, th, flagDays: ev.flagDays, events: ev.events.length, forward: ev.forward,
        ddFirstEventMedian: median(ev.events.map(e => e.day.dd)) });
    }
  }
  return rows;
}

// ── 客觀下跌波段（回撤進入/退出以當時已知高點定義）────────────────
export function findWaves(ds, cfg = ds.cfg) {
  const waves = [];
  let cur = null;
  ds.days.forEach((d, i) => {
    if (!cur && d.dd >= cfg.waveEnter) cur = { startIdx: i, lowIdx: i };
    if (cur) {
      if (d.close < ds.days[cur.lowIdx].close) cur.lowIdx = i;
      if (d.dd < cfg.waveExit || i === ds.days.length - 1) {
        cur.endIdx = i; cur.open = !(d.dd < cfg.waveExit);
        waves.push(cur); cur = null;
      }
    }
  });
  return waves.map(w => {
    const s = ds.days[w.startIdx], l = ds.days[w.lowIdx];
    const peakIdx = ds.tw[s.ti].peakIdx;
    return { ...w, startDate: s.date, lowDate: l.date, endDate: ds.days[w.endIdx].date,
      peakDate: ds.tw[peakIdx].date, peakClose: ds.tw[peakIdx].close,
      lowClose: l.close, maxDd: l.dd };
  });
}

// ── 2/3 規則比較 ────────────────────────────────────────────────────
export const RULE_VARIANTS = [
  { id: 'orig',  label: '原始 A+B+C(100億)',   c: d => isNum(d.dm1) && d.dm1 <= -100 },
  { id: 'p2',    label: 'C→單日 -2%',          c: d => isNum(d.m[1]) && d.m[1] <= -2 },
  { id: 'p3',    label: 'C→單日 -3%',          c: d => isNum(d.m[1]) && d.m[1] <= -3 },
  { id: 'p4',    label: 'C→單日 -4%',          c: d => isNum(d.m[1]) && d.m[1] <= -4 },
  { id: 'w3',    label: 'C→3日累積 -5%',       c: d => isNum(d.m[3]) && d.m[3] <= -5 },
  { id: 'w5',    label: 'C→5日累積 -8%',       c: d => isNum(d.m[5]) && d.m[5] <= -8 },
];

export function ruleFlags(ds, variant, cfg = ds.cfg, mode = '2of3') {
  const idx = [];
  ds.days.forEach((d, i) => {
    const A = d.dd >= cfg.ruleDd;
    const B = isNum(d.ratioDrop) && d.ratioDrop >= cfg.ruleRatioDrop;
    const C = variant.c(d);
    const n = (A ? 1 : 0) + (B ? 1 : 0) + (C ? 1 : 0);
    if (mode === '2of3' ? n >= 2 : mode === 'AC' ? (A && C) : false) idx.push(i);
  });
  return idx;
}

/** 每個客觀波段（波段高點→結束日）內第一次觸發：距波段低點幾個交易日、之後到低點還剩多少 */
export function waveCoverage(ds, flags, waves, cfg = ds.cfg) {
  const perWave = waves.map(w => {
    const first = flags.find(i => ds.days[i].date >= w.peakDate && i <= w.endIdx);
    if (first === undefined) return { wave: w, hit: false };
    const d = ds.days[first];
    return { wave: w, hit: true, date: d.date, dd: d.dd,
      daysBeforeLow: ds.days[w.lowIdx].ti - d.ti,          // 負值＝低點已過
      remainingPct: (w.lowClose / d.close - 1) * 100,     // 觸發後到波段低點還剩多少（<0 表示之後還會再跌）
      fwd: forwardStats(ds, d, cfg) };
  });
  const hits = perWave.filter(p => p.hit);
  return {
    perWave, waveHit: hits.length, waveTotal: waves.length,
    leadMedian: median(hits.map(p => p.daysBeforeLow)),
    remainingMedian: median(hits.map(p => p.remainingPct)),
    ddAtFirstMedian: median(hits.map(p => p.dd)),
  };
}

export function ruleComparison(ds, cfg = ds.cfg, mode = '2of3') {
  const waves = findWaves(ds, cfg);
  return RULE_VARIANTS.map(v => {
    const flags = ruleFlags(ds, v, cfg, mode);
    const ev = evaluateFlags(ds, flags, cfg, cfg.ruleCooldown);
    return {
      id: v.id, label: v.label, flagDays: flags.length, events: ev.events.length,
      dupRatio: ev.events.length ? flags.length / ev.events.length : null,
      forward: ev.forward, evList: ev.events,
      ...waveCoverage(ds, flags, waves, cfg),
    };
  });
}

/** 融資減幅門檻 × 指數回撤閘門（警報日當時已知的回撤 ≥ gate%） */
export const GATES = [0, 5, 10, 15];
export function gatedComparison(ds, cfg = ds.cfg, ths = [2, 3, 4]) {
  const waves = findWaves(ds, cfg);
  const rows = [];
  for (const th of ths) for (const gate of GATES) {
    const flags = [];
    ds.days.forEach((d, i) => { if (isNum(d.m[1]) && d.m[1] <= -th && d.dd >= gate) flags.push(i); });
    const ev = evaluateFlags(ds, flags, cfg);
    rows.push({ th, gate, flagDays: flags.length, events: ev.events.length, forward: ev.forward, ...waveCoverage(ds, flags, waves, cfg) });
  }
  return rows;
}

// ── 個案分析 ────────────────────────────────────────────────────────
export function caseAnalysis(ds, c, cfg = ds.cfg) {
  const rows = ds.days.filter(d => d.date >= c.from && d.date <= c.to);
  if (!rows.length) return null;
  let low = rows[0];
  for (const d of rows) if (d.close < low.close) low = d;
  let lowLow = rows[0];
  for (const d of rows) if (d.low < lowLow.low) lowLow = d;
  const peak = ds.tw[ds.tw[low.ti].peakIdx];
  const first = {};
  for (const th of [2, 3, 4, 5]) {
    const d = rows.find(r => isNum(r.m[1]) && r.m[1] <= -th);
    first[th] = d ? {
      date: d.date, m1: d.m[1], idx1: d.x[1], dd: d.dd,
      tdBeforeLow: low.ti - d.ti,
      closeToLowPct: (low.close / d.close - 1) * 100,
      fwd: forwardStats(ds, d, cfg),
    } : null;
  }
  // 波段高點早於指定窗口起點時（例：Case B 高點 6/22、窗口 7/1），另列「自波段高點起」的首次觸發
  const firstSincePeak = {};
  if (peak.date < c.from) {
    const rows2 = ds.days.filter(d => d.date >= peak.date && d.date <= c.to);
    for (const th of [2, 3, 4, 5]) {
      const d = rows2.find(r => isNum(r.m[1]) && r.m[1] <= -th);
      firstSincePeak[th] = d ? { date: d.date, m1: d.m[1], idx1: d.x[1], dd: d.dd, tdBeforeLow: low.ti - d.ti,
        closeToLowPct: (low.close / d.close - 1) * 100, fwd: forwardStats(ds, d, cfg) } : null;
    }
  }
  const firstW = {};
  for (const [N, th] of [[3, 5], [5, 8]]) {
    const d = rows.find(r => isNum(r.m[N]) && r.m[N] <= -th);
    firstW[`${N}d`] = d ? { date: d.date, val: d.m[N], tdBeforeLow: low.ti - d.ti, closeToLowPct: (low.close / d.close - 1) * 100, dd: d.dd } : null;
  }
  // 融資累計：從窗內融資高點到最低
  let mHi = rows[0], mLo = rows[0];
  for (const d of rows) { if (d.margin > mHi.margin) mHi = d; if (d.margin < mLo.margin) mLo = d; }
  const mgnPeakToLow = rows.filter(d => d.date >= mHi.date).reduce((a, d) => (d.margin < a.margin ? d : a), mHi);
  // 第一次回撤跨過 10/15/20%
  const ddCross = {};
  for (const lvl of [5, 10, 15, 20]) { const d = rows.find(r => r.dd >= lvl); ddCross[lvl] = d ? { date: d.date, td: low.ti - d.ti } : null; }
  // 跌幅收斂：-3% 首次警報日 t，比較「t-4..t」與「t+1..t+5」的指數日跌幅
  let converge = null;
  const f3 = first[3];
  if (f3) {
    const t = ds.days.find(d => d.date === f3.date).ti;
    const seg = (a0, a1) => { const v = []; for (let j = a0; j <= a1 && j < ds.tw.length; j++) v.push((ds.tw[j].close / ds.tw[j - 1].close - 1) * 100); return v; };
    const before = seg(t - 4, t), after = seg(t + 1, t + 5);
    converge = {
      beforeMean: avg(before), afterMean: avg(after),
      beforeWorst: Math.min(...before), afterWorst: after.length ? Math.min(...after) : null,
      beforeDown2: before.filter(v => v <= -2).length, afterDown2: after.filter(v => v <= -2).length, afterN: after.length,
    };
  }
  const rangeDays = rows.map(d => ({
    date: d.date, close: d.close, x1: d.x[1], dd: d.dd, margin: d.margin, m1: d.m[1], dm1: d.dm1, m3: d.m[3], m5: d.m[5], ratio: d.ratio, r4: d.r4,
  }));
  return {
    ...c, rows: rangeDays, peak: { date: peak.date, close: peak.close },
    low: { date: low.date, close: low.close, dd: low.dd, intradayLowDate: lowLow.date, intradayLow: lowLow.low },
    peakToLowPct: (low.close / peak.close - 1) * 100,
    marginHigh: { date: mHi.date, v: mHi.margin }, marginLow: { date: mgnPeakToLow.date, v: mgnPeakToLow.margin },
    marginPeakToLowPct: (mgnPeakToLow.margin / mHi.margin - 1) * 100,
    first, firstSincePeak, firstW, ddCross, converge,
    lowDateMatchesHint: c.lowHint ? c.lowHint === low.date : null,
  };
}

// ── 恐懼貪婪 × 去槓桿 ───────────────────────────────────────────────
export const FEAR_RANGE = [5, 25];
export const clampFear = v => Math.min(FEAR_RANGE[1], Math.max(FEAR_RANGE[0], Math.round(Number(v) || 15)));

/**
 * 恐懼貪婪 < thr 的日子與融資去槓桿警報是否「相對」：
 *  - 條件機率：P(警報日|恐懼日) vs P(警報日|非恐懼日)，lift＝前者/後者
 *  - 警報事件首日：當日（或前 lead 個交易日內）是否已在恐懼區
 *  - 每個客觀波段：F&G 最低點日期 vs 波段低點、首次進入恐懼區 vs 首次警報
 * 只用當日已知值；F&G 缺值的日子不計入分母。
 */
export function fearAnalysis(ds, thr, flagIdx, cfg = ds.cfg, lead = 5) {
  const t = clampFear(thr);
  const days = ds.days;
  const flagSet = new Set(flagIdx);
  let fearN = 0, fearAlarm = 0, nonN = 0, nonAlarm = 0, alarmWithFg = 0, alarmFear = 0;
  days.forEach((d, i) => {
    if (!isNum(d.fg)) return;
    const alarm = flagSet.has(i);
    if (alarm) alarmWithFg += 1;
    if (d.fg < t) { fearN += 1; if (alarm) { fearAlarm += 1; alarmFear += 1; } } else { nonN += 1; if (alarm) nonAlarm += 1; }
  });
  const pF = fearN ? fearAlarm / fearN * 100 : null, pN = nonN ? nonAlarm / nonN * 100 : null;
  const events = clusterEvents(flagIdx, cfg.cooldown);
  const evRows = events.map(e => {
    const i = e.startIdx;
    let nearFear = null;
    for (let k = 0; k <= lead && i - k >= 0; k++) if (isNum(days[i - k].fg) && days[i - k].fg < t) { nearFear = k; break; }
    return { date: days[i].date, fg: days[i].fg, nearFear };
  });
  const evKnown = evRows.filter(r => isNum(r.fg));
  const waves = findWaves(ds, cfg).map(w => {
    const seg = days.slice(w.startIdx - 0, w.endIdx + 1).filter(d => isNum(d.fg));
    const from = days.findIndex(d => d.date >= w.peakDate);
    const win = days.slice(from, w.endIdx + 1).filter(d => isNum(d.fg));
    let mn = null; for (const d of win) if (!mn || d.fg < mn.fg) mn = d;
    const firstFear = win.find(d => d.fg < t) || null;
    const firstAlarm = flagIdx.find(i => days[i].date >= w.peakDate && i <= w.endIdx);
    const lowTi = days[w.lowIdx].ti;
    return {
      peakDate: w.peakDate, lowDate: w.lowDate, maxDd: w.maxDd, seg: seg.length,
      fgMin: mn ? mn.fg : null, fgMinDate: mn ? mn.date : null, fgMinToLowTd: mn ? mn.ti - lowTi : null,
      firstFearDate: firstFear ? firstFear.date : null, firstFearToLowTd: firstFear ? lowTi - firstFear.ti : null,
      firstAlarmDate: firstAlarm !== undefined ? days[firstAlarm].date : null,
      firstAlarmToLowTd: firstAlarm !== undefined ? lowTi - days[firstAlarm].ti : null,
      fearDaysInWave: win.filter(d => d.fg < t).length, alarmDaysInWave: flagIdx.filter(i => days[i].date >= w.peakDate && i <= w.endIdx).length,
    };
  });
  return {
    thr: t, fgDays: fearN + nonN, fearDays: fearN, fearShare: fearN + nonN ? fearN / (fearN + nonN) * 100 : null,
    pAlarmGivenFear: pF, pAlarmGivenNot: pN, lift: pF !== null && pN ? pF / pN : null,
    alarmDays: alarmWithFg, alarmDaysInFear: alarmFear, pFearGivenAlarm: alarmWithFg ? alarmFear / alarmWithFg * 100 : null,
    events: evRows, eventsInFear: evKnown.filter(r => r.fg < t).length, eventsNearFear: evKnown.filter(r => r.nearFear !== null).length, eventsKnown: evKnown.length,
    fgMedianAtEvent: median(evKnown.map(r => r.fg)), lead, waves,
  };
}

// ── 全部一次跑 ──────────────────────────────────────────────────────
export function runFullBacktest(raw, cfg = {}) {
  const ds = buildDataset(raw, cfg);
  const c = ds.cfg;
  const cmp = thresholdComparison(ds, c);
  const base = baselineForward(ds, () => true, c);
  const baseDd10 = baselineForward(ds, d => d.dd >= 10, c);
  const baseDd15 = baselineForward(ds, d => d.dd >= 15, c);
  return {
    cfg: c, ds,
    gaps: ds.gaps,
    annual: annualStats(ds, c),
    thresholds: cmp,
    baseline: { all: base, dd10: baseDd10, dd15: baseDd15 },
    bands120: drawdownBandTable(ds, c, 'dd'),
    bands252: drawdownBandTable(ds, c, 'dd252'),
    rd: { 1: rdSummary(ds, c, 1), 0.5: rdSummary(ds, c, 0.5) },
    windows: windowComparison(ds, c),
    waves: findWaves(ds, c),
    rules2of3: ruleComparison(ds, c, '2of3'),
    rulesAC: ruleComparison(ds, c, 'AC'),
    gated: gatedComparison(ds, c),
    fear: fearAnalysis(ds, c.fearThr, singleDayFlags(ds, c.thresholds.includes(3) ? 3 : c.thresholds[0]), c),
    cases: CASES.map(k => caseAnalysis(ds, k, c)),
  };
}
