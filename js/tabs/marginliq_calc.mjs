// 斷頭線（-16%／-24%）與國安基金 — 純函式引擎（網頁 marginalert 與測試共用）。
// 口徑：加權指數「盤中高點 → 盤中低點」。波段＝下跌 ≥12%（zigzag）；低點反彈 ≥12% 或創新高即結束。
// 這是歷史統計，不是預測：-16%／-24% 是使用者觀察到的兩條線，國安基金條例沒有跌幅門檻。

// 第一波區間 -14%～-16%（LV0～LV1）、第二波 -24%（LV2）
export const LV0 = 14, LV1 = 16, LV2 = 24, LEG_TH = 12, BIG_DROP = 3, NEAR_TD = 2;

// 國安基金歷次進場（手動維護）。decide＝委員會決議日；end＝退場日（null＝仍在護盤）。
// 來源：財政部／國安基金管理委員會新聞稿與各報整理；決議多在收盤後，實際買進最早為下一交易日。
export const NSF_UPDATED = '2026-11-11';
export const NSF_EVENTS = [
  { n: 1, decide: '2000-03-15', end: '2000-03-20', why: '總統大選、兩岸' },
  { n: 2, decide: '2000-10-02', end: '2000-11-15', why: '網路泡沫、政局' },
  { n: 3, decide: '2004-05-19', end: '2004-06-01', why: '319 事件後' },
  { n: 4, decide: '2008-09-18', end: '2008-12-17', why: '金融海嘯' },
  { n: 5, decide: '2011-12-20', end: '2012-04-20', why: '歐債危機' },
  { n: 6, decide: '2015-08-25', end: '2016-04-12', why: '人民幣貶值、全球股災' },
  { n: 7, decide: '2020-03-19', end: '2020-10-12', why: '新冠疫情' },
  { n: 8, decide: '2022-07-12', end: '2023-04-13', why: '升息、通膨' },
  { n: 9, decide: '2025-04-08', end: '2026-01-12', why: '美國對等關稅' },
  { n: 10, decide: '2026-11-06', end: null, why: '單週重挫' },
];

const num = v => typeof v === 'number' && Number.isFinite(v);
const usable = rows => rows.filter(r => r && typeof r.date === 'string' && num(r.high) && num(r.low) && r.high > 0 && r.low > 0);

/** zigzag 下跌波段。回傳 [{ pi, ti, peakDate, peak, lowDate, low, depth(%), open }]；open＝最後一段還沒被反彈 12% 或新高結束。 */
export function findLegs(twii, th = LEG_TH) {
  const tw = usable(twii), k = th / 100, legs = [];
  let up = true, pk = 0, pi = 0, tr = Infinity, ti = 0;
  const leg = open => ({ pi, ti, peakDate: tw[pi].date, peak: pk, lowDate: tw[ti].date, low: tr, depth: (tr / pk - 1) * 100, open });
  tw.forEach((r, i) => {
    if (up) {
      if (r.high >= pk) { pk = r.high; pi = i; }
      if (r.low <= pk * (1 - k)) { up = false; tr = r.low; ti = i; }
      return;
    }
    if (r.low < tr) { tr = r.low; ti = i; }
    if ((r.high >= tr * (1 + k) && i > ti) || r.high > pk) {
      legs.push(leg(false));
      up = true; pk = -Infinity;
      for (let j = ti; j <= i; j++) if (tw[j].high >= pk) { pk = tw[j].high; pi = j; }
    }
  });
  if (!up) legs.push(leg(true));
  return { rows: tw, legs };
}

/** 融資餘額列 → Map(date → { money, chg(單日%) }) */
export function marginMap(margin) {
  const m = new Map();
  let prev = null;
  for (const r of margin) {
    if (!r || !num(r.margin_money) || r.margin_money <= 0) continue;
    m.set(r.date, { money: r.margin_money, chg: prev ? (r.margin_money / prev - 1) * 100 : null });
    prev = r.margin_money;
  }
  return m;
}

/** 從高點算，第一個盤中低點 ≤ 高點×(1-lv%) 的那天（i0..i1 之間）；沒有則 null */
function crossIndex(rows, i0, i1, peak, lv) {
  const line = peak * (1 - lv / 100);
  for (let i = i0; i <= i1; i++) if (rows[i].low <= line) return i;
  return null;
}

/** 某條線被跌破那天的融資與維持率：當日值、前後 NEAR_TD 個交易日內最大單日融資減幅 */
export function touchInfo(rows, i, peak, mg, ratio) {
  if (i === null) return null;
  const d = rows[i].date;
  let worst = null, worstDate = null;
  for (let j = Math.max(0, i - NEAR_TD); j <= Math.min(rows.length - 1, i + NEAR_TD); j++) {
    const c = mg.get(rows[j].date)?.chg;
    if (num(c) && (worst === null || c < worst)) { worst = c; worstDate = rows[j].date; }
  }
  return {
    date: d, lowPct: (rows[i].low / peak - 1) * 100, closePct: (rows[i].close / peak - 1) * 100,
    ratio: ratio.get(d) ?? null, chg: mg.get(d)?.chg ?? null, worst, worstDate, hit: num(worst) && worst <= -BIG_DROP,
  };
}

/** 國安基金決議日落在 [peakDate, 低點後 15 個交易日] 內的那一次 */
function nsfInLeg(rows, leg) {
  const endDate = rows[Math.min(rows.length - 1, leg.ti + 15)].date;
  const e = NSF_EVENTS.find(x => x.decide >= leg.peakDate && x.decide <= endDate);
  if (!e) return null;
  const i = rows.findIndex(r => r.date >= e.decide);
  if (i < 0) return { ...e, lowPct: null, closePct: null };
  let lo = Infinity;
  for (let j = leg.pi; j <= i; j++) lo = Math.min(lo, rows[j].low);
  return { ...e, lowPct: (lo / leg.peak - 1) * 100, closePct: (rows[i].close / leg.peak - 1) * 100 };
}

/** 逐波段表：每段的 -16%／-24% 破位日（融資、維持率）與國安基金 */
export function legTable({ twii, margin, ratio }, th = LEG_TH) {
  const { rows, legs } = findLegs(twii, th);
  const mg = marginMap(margin);
  const rt = new Map((ratio ?? []).filter(r => num(r.ratio)).map(r => [r.date, r.ratio]));
  const out = legs.map(leg => {
    const c1 = crossIndex(rows, leg.pi, leg.ti, leg.peak, LV1), c2 = crossIndex(rows, leg.pi, leg.ti, leg.peak, LV2);
    return { ...leg, x1: touchInfo(rows, c1, leg.peak, mg, rt), x2: touchInfo(rows, c2, leg.peak, mg, rt), nsf: nsfInLeg(rows, leg), hasMargin: mg.has(leg.peakDate) || mg.has(leg.lowDate) };
  });
  return { rows, legs: out, mg, rt };
}

/** 命中率：某期間內，跌破該線的波段有幾段在前後 2 日內出現單日融資 ≤ -3%；以及跌破 -24% 的波段國安基金進場幾次 */
export function hitStats(legs, from, to = '9999') {
  const s = { n1: 0, h1: 0, n2: 0, h2: 0, nsf2: 0, r1: [], r2: [] };
  for (const l of legs) {
    if (!l.hasMargin || l.peakDate < from || l.peakDate >= to) continue;
    if (l.x1) { s.n1++; if (l.x1.hit) s.h1++; if (num(l.x1.ratio)) s.r1.push(l.x1.ratio); }
    if (l.x2) { s.n2++; if (l.x2.hit) s.h2++; if (l.nsf) s.nsf2++; if (num(l.x2.ratio)) s.r2.push(l.x2.ratio); }
  }
  return s;
}

/** 目前狀態：近 lookback 個交易日的盤中最高點當參考高點，-16%／-24% 兩條線的點位與是否已觸及 */
export function currentState(rowsIn, { lookback = 120, peakIndex = null, endIndex = null } = {}) {
  const rows = usable(rowsIn);
  if (!rows.length) return null;
  const last = endIndex ?? rows.length - 1;
  let hi = -Infinity, hj = -1;
  if (peakIndex !== null) { hj = peakIndex; hi = rows[hj].high; }
  else for (let j = Math.max(0, last - lookback + 1); j <= last; j++) if (rows[j].high >= hi) { hi = rows[j].high; hj = j; }
  let lo = Infinity, lj = hj;
  for (let j = hj; j <= last; j++) if (rows[j].low < lo) { lo = rows[j].low; lj = j; }
  const close = rows[last].close;
  const level = lv => {
    const line = hi * (1 - lv / 100);
    const i = crossIndex(rows, hj, last, hi, lv);
    return { lv, line, touched: i !== null, touchDate: i !== null ? rows[i].date : null, touchIndex: i, needPct: (line / close - 1) * 100, needPts: line - close };
  };
  return {
    date: rows[last].date, close, hi, hiDate: rows[hj].date, hiIndex: hj, lo, loDate: rows[lj].date, lowPct: (lo / hi - 1) * 100, closePct: (close / hi - 1) * 100,
    l0: level(LV0), l1: level(LV1), l2: level(LV2),
  };
}

/** 某日的國安基金狀態：{ active, event } */
export function nsfStatus(date) {
  const e = NSF_EVENTS.find(x => x.decide <= date && (x.end === null || x.end >= date));
  return { active: Boolean(e), event: e ?? NSF_EVENTS.at(-1) };
}

/** 景氣燈號：月分數 Map('YYYY-MM' → score)；某日往前含當月共 4 個月的最高分 */
export function signalMap(signal) {
  return new Map((signal ?? []).filter(r => r && typeof r.date === 'string' && num(r.score)).map(r => [r.date.slice(0, 7), r.score]));
}
export function signalMax4(sm, date) {
  let [y, m] = date.slice(0, 7).split('-').map(Number), best = null;
  for (let k = 0; k < 4; k++) {
    const v = sm.get(`${y}-${String(m).padStart(2, '0')}`);
    if (num(v) && (best === null || v > best)) best = v;
    if (--m === 0) { m = 12; y--; }
  }
  return best;
}
export const regimeOf = s => (!num(s) ? null : s >= 30 ? 'hot' : s >= 25 ? 'mid' : 'cold');

const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/** 週期表：第一波（高點同時是 250 日新高的波段）→ 之後的高點比前高多少 → 下一波。
 *  下一波的高點若沒超過前高 6%，視為「第二波」，不再當成新的第一波。 */
export function cycleRows(twii, signal, th = LEG_TH) {
  const { rows, legs } = findLegs(twii, th);
  const sm = signalMap(signal), used = new Set(), out = [];
  legs.forEach((l, j) => {
    if (used.has(j) || l.pi < 250) return;
    let prior = -Infinity;
    for (let i = l.pi - 250; i < l.pi; i++) prior = Math.max(prior, rows[i].high);
    if (l.peak < prior) return;
    const score = signalMax4(sm, l.peakDate), nx = legs[j + 1] ?? null;
    const r = { score, regime: regimeOf(score), peakDate: l.peakDate, peak: l.peak, lowDate: l.lowDate, depth: l.depth, days1: dayDiff(l.peakDate, l.lowDate), open: l.open, next: null };
    if (nx) {
      const up = (nx.peak / l.peak - 1) * 100;
      r.next = { peakDate: nx.peakDate, upPct: up, daysUp: dayDiff(l.lowDate, nx.peakDate), lowDate: nx.lowDate, depth: nx.depth, days2: dayDiff(nx.peakDate, nx.lowDate), gap: dayDiff(l.lowDate, nx.lowDate), capped: up <= 6, open: nx.open };
      if (r.next.capped) used.add(j + 1);
    }
    out.push(r);
  });
  return out;
}

/** 週期表依燈號分組的小計 */
export function cycleSummary(rows) {
  return ['hot', 'mid', 'cold'].map(k => {
    const g = rows.filter(r => r.regime === k && r.next);
    return { regime: k, n: g.length, capped: g.filter(r => r.next.capped).length };
  });
}
