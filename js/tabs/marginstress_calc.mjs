// 台股融資維持率壓力推估 — 純函式（無 DOM、無 fetch；marginalert 頁與 CLI 共用）。
//
// 定位：Margin Alert 判斷「現在是否進入恐慌區」；這裡根據歷史敏感度做「情境推估」。
// 推估結果是歷史經驗，不是支撐位、不是底部預測，也不改動任何既有警報規則。
//
// 核心定義（區間累計跌幅比值；不是迴歸斜率）：
//   IndexDecline  = (P0 - P1) / P0
//   MarginDecline = (M0 - M1) / M0            （維持率的「相對」跌幅，不是百分點）
//   Beta          = MarginDecline / IndexDecline
//   RequiredDecline = (M0 - Mt) / M0 / Beta;  ProjectedIndex = P0 × (1 - RequiredDecline)
//   ProjectedMargin = M0 × (1 - Beta × IndexDecline)
//
// 資料契約（上市 only）：
//   twii   [{date, close}]            data/TWII.json
//   ratio  [{date, ratio}]            mergeRatio().rows（TWSE 逐檔重建，非官方、非券商整戶口徑）
//   margin [{date, margin_money}]     data/taiwan_margin_total.json（億元）
// 日期一律精確對齊：維持率或融資在指定日期沒有值就回報缺失，不用鄰近日期補、不補零。

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

export const MA_PERIODS = Object.freeze([60, 100, 120, 125, 150, 200, 240, 300]);
export const TARGET_RATIOS = Object.freeze([180, 170, 160, 150, 130]);
export const KEY_DROP_PTS = 30;            // 使用者既有觀察條件：維持率自參考高點 -30 個百分點
export const DEPTHS = Object.freeze([5, 10, 15, 20]);
export const MANUAL_BETAS = Object.freeze({ low: 1.3, base: 1.47, high: 1.7 });   // 手動情境參數，非統計信賴區間
export const WAVE_DEFAULTS = Object.freeze({ lookback: 120, enter: 10, exit: 5 });

// ── 小工具 ──────────────────────────────────────────────────────────
function clean(rows, key, positive = true) {
  const seen = new Set();
  const out = [];
  for (const r of rows || []) {
    if (!r || typeof r.date !== 'string' || seen.has(r.date) || !isNum(r[key]) || (positive && !(r[key] > 0))) continue;
    seen.add(r.date);
    out.push({ date: r.date, v: r[key] });
  }
  return out.sort(byDate);
}
const toMap = rows => new Map(rows.map(r => [r.date, r.v]));
export function quantile(sorted, p) {
  if (!sorted.length) return null;
  const x = (sorted.length - 1) * p;
  const lo = Math.floor(x), hi = Math.ceil(x);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (x - lo);
}
export const medianOf = vals => quantile(vals.filter(isNum).sort((a, b) => a - b), 0.5);
const meanOf = vals => { const v = vals.filter(isNum); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

// ── 1. Beta ─────────────────────────────────────────────────────────
/**
 * 區間累計敏感度。要求 P1 < P0（確實下跌）且四個值皆為有限正數；否則 ok=false 並說明原因。
 * 回傳 ptsDrop＝維持率下降的百分點（M0-M1），與相對跌幅分開存放避免混淆。
 */
export function sensitivity({ p0, p1, m0, m1 } = {}) {
  const bad = (reason) => ({ ok: false, reason, beta: null, indexDecline: null, marginDecline: null, ptsDrop: null });
  if (![p0, p1, m0, m1].every(v => isNum(v) && v > 0)) return bad('missing');
  if (!(p1 < p0)) return bad('no-index-decline');
  const indexDecline = (p0 - p1) / p0;
  const marginDecline = (m0 - m1) / m0;
  return { ok: true, reason: null, indexDecline, marginDecline, ptsDrop: m0 - m1, beta: marginDecline / indexDecline };
}

// ── 2. 反推指數 ─────────────────────────────────────────────────────
/**
 * 目標維持率 Mt → 需要的指數跌幅與推估指數。
 * status：ok｜invalid（缺值或非正）｜bad-beta（≤0 或非有限）｜target-not-below（Mt ≥ M0，不需下跌）｜
 *         out-of-range（需跌幅 ≥100%，不可能）。非 ok 時 projected 一律為 null，不產生假預測。
 */
export function projectIndex({ p0, m0, mt, beta } = {}) {
  const out = (status, extra = {}) => ({ status, requiredDecline: null, projected: null, ...extra });
  if (![p0, m0, mt].every(v => isNum(v) && v > 0)) return out('invalid');
  if (!isNum(beta) || !(beta > 0)) return out('bad-beta');
  if (!(mt < m0)) return out('target-not-below');
  const requiredDecline = (m0 - mt) / m0 / beta;
  if (!(requiredDecline < 1)) return out('out-of-range', { requiredDecline });
  return { status: 'ok', requiredDecline, projected: p0 * (1 - requiredDecline) };
}

// ── 3. 反推維持率 ───────────────────────────────────────────────────
/** 目標指數 Pt → 推估維持率。Pt ≥ P0（沒有下跌）回 status='not-below' 且不推估。推估 ≤0 視為 out-of-range。 */
export function projectMargin({ p0, m0, pt, beta } = {}) {
  const out = (status, extra = {}) => ({ status, indexDecline: null, projected: null, ...extra });
  if (![p0, m0, pt].every(v => isNum(v) && v > 0)) return out('invalid');
  if (!isNum(beta) || !(beta > 0)) return out('bad-beta');
  if (!(pt < p0)) return out('not-below');
  const indexDecline = (p0 - pt) / p0;
  const projected = m0 * (1 - beta * indexDecline);
  if (!(projected > 0)) return out('out-of-range', { indexDecline });
  return { status: 'ok', indexDecline, projected };
}

// ── 波段與 Beta 歷史 ────────────────────────────────────────────────
/**
 * 指數下跌波段：回撤（對過去 lookback 日最高收盤，含當日）≥ enter 進入、< exit 結束。
 * 與 marginalert_calc.findWaves 同一定義（該函式只看「有融資資料的日子」；這裡只看指數，
 * 才能涵蓋融資資料之前就有維持率的 2004～2007）。peak 為進入當日的 lookback 高點。
 */
export function findIndexWaves(twii, cfg = {}) {
  const c = { ...WAVE_DEFAULTS, ...cfg };
  const tw = clean(twii, 'close');
  const closes = tw.map(r => r.v);
  const waves = [];
  let cur = null;
  for (let i = 0; i < tw.length; i++) {
    let hi = -Infinity, hiIdx = i;
    for (let j = Math.max(0, i - c.lookback + 1); j <= i; j++) if (closes[j] >= hi) { hi = closes[j]; hiIdx = j; }
    const dd = (1 - closes[i] / hi) * 100;
    if (!cur && dd >= c.enter && i >= c.lookback - 1) cur = { startIdx: i, lowIdx: i, peakIdx: hiIdx };
    if (cur) {
      if (closes[i] < closes[cur.lowIdx]) cur.lowIdx = i;
      const last = i === tw.length - 1;
      if (dd < c.exit || last) {
        waves.push({
          peakDate: tw[cur.peakIdx].date, peakClose: closes[cur.peakIdx], startDate: tw[cur.startIdx].date,
          lowDate: tw[cur.lowIdx].date, lowClose: closes[cur.lowIdx], endDate: tw[i].date, open: !(dd < c.exit),
          maxDd: (1 - closes[cur.lowIdx] / closes[cur.peakIdx]) * 100,
        });
        cur = null;
      }
    }
  }
  return waves;
}

/** 日期 d 之後（含）第一個 close ≤ 門檻的 TWII 列；超出波段終點則回 null。 */
function firstAtOrBelow(tw, fromDate, toDate, level) {
  for (const r of tw) {
    if (r.date < fromDate) continue;
    if (r.date > toDate) break;
    if (r.v <= level) return r;
  }
  return null;
}

/**
 * 每個波段的敏感度紀錄。參考高點／低點＝指數波段的高點日／低點日；維持率與融資都取「同一日期」，
 * 缺值則 ok=false（reason）。另列：期間內維持率最低值、融資餘額高→低變化、期間融資最大跌幅
 * （餘額自身的峰谷，不等於兩端日期差）、抵押品市值變化（由 M=抵押品/融資餘額 推算）。
 */
export function buildBetaHistory({ twii, ratio, margin }, cfg = {}) {
  const tw = clean(twii, 'close');
  const rMap = toMap(clean(ratio, 'ratio'));
  const mRows = clean(margin, 'margin_money');
  const mMap = toMap(mRows);
  const waves = findIndexWaves(twii, cfg);
  // 同一個高點可能先後出現兩段（跌破→反彈到 <exit→再破）；統計與回測只留該高點最深的一段，避免重複計數
  const deepest = new Map();
  for (const w of waves) if (!deepest.has(w.peakDate) || w.maxDd > deepest.get(w.peakDate).maxDd) deepest.set(w.peakDate, w);
  return waves.map(w => {
    const m0 = rMap.get(w.peakDate), m1 = rMap.get(w.lowDate);
    const s = sensitivity({ p0: w.peakClose, p1: w.lowClose, m0, m1 });
    const inWave = [...rMap].filter(([d]) => d >= w.peakDate && d <= w.lowDate);
    const rMin = inWave.length ? inWave.reduce((a, b) => (b[1] < a[1] ? b : a)) : null;
    const l0 = mMap.get(w.peakDate), l1 = mMap.get(w.lowDate);
    let burn = null;
    if (isNum(l0)) {
      const seg = mRows.filter(r => r.date >= w.peakDate && r.date <= w.lowDate);
      let peak = -Infinity, peakDate = null, worst = 0, troughDate = null, pDate = null;
      for (const r of seg) {
        if (r.v > peak) { peak = r.v; peakDate = r.date; }
        const d = r.v / peak - 1;
        if (d < worst) { worst = d; troughDate = r.date; pDate = peakDate; }
      }
      burn = worst < 0 ? { pct: worst * 100, from: pDate, to: troughDate } : { pct: 0, from: null, to: null };
    }
    const marginChange = isNum(l0) && isNum(l1) ? (l1 / l0 - 1) * 100 : null;
    const collateralChange = s.ok && isNum(l0) && isNum(l1) ? ((m1 / m0) * (l1 / l0) - 1) * 100 : null;
    return {
      ...w, independent: deepest.get(w.peakDate) === w, ok: s.ok, reason: s.reason, tradingDays: tw.filter(r => r.date >= w.peakDate && r.date <= w.lowDate).length - 1,
      m0: m0 ?? null, m1: m1 ?? null, indexDecline: s.indexDecline, marginDecline: s.marginDecline, ptsDrop: s.ptsDrop, beta: s.beta,
      ratioMin: rMin ? rMin[1] : null, ratioMinDate: rMin ? rMin[0] : null,
      margin0: l0 ?? null, margin1: l1 ?? null, marginChange, marginMaxBurn: burn, collateralChange,
    };
  });
}

/** 波段在指數第一次回撤到 depth% 的那天量到的 Beta（用當天實際跌幅，不是 depth）。 */
export function betaAtDepth({ twii, ratio }, wave, depth) {
  const tw = clean(twii, 'close');
  const rMap = toMap(clean(ratio, 'ratio'));
  const hit = firstAtOrBelow(tw, wave.peakDate, wave.lowDate, wave.peakClose * (1 - depth / 100));
  if (!hit) return null;
  const m0 = rMap.get(wave.peakDate), m1 = rMap.get(hit.date);
  const s = sensitivity({ p0: wave.peakClose, p1: hit.v, m0, m1 });
  return s.ok ? { date: hit.date, beta: s.beta, indexDecline: s.indexDecline, marginDecline: s.marginDecline } : null;
}

/**
 * 「同一批波段」在各深度的 Beta：只取回撤達到最大深度的波段，比較同一波在 5%→20% 的 Beta 是否下降，
 * 排除「越深的樣本本來就是另一批波段」的組成效應。
 */
export function betaDepthPaired(data, records, depths = DEPTHS) {
  const deepest = depths.at(-1);
  const waves = records.filter(r => r.maxDd >= deepest);
  const cols = depths.map(d => waves.map(w => betaAtDepth(data, w, d)?.beta ?? null));
  const complete = waves.map((_, i) => cols.every(c => isNum(c[i])));
  const idx = complete.map((ok, i) => (ok ? i : -1)).filter(i => i >= 0);
  const med = c => medianOf(idx.map(i => c[i]));
  return {
    n: idx.length, depths: [...depths], medians: cols.map(med),
    declined: idx.filter(i => cols.at(-1)[i] < cols[0][i] - 0.01).length,   // 容差 0.01，避免浮點雜訊算成「下降」
  };
}

export function betaStats(records) {
  const b = records.filter(r => r.ok && isNum(r.beta)).map(r => r.beta).sort((a, c) => a - c);
  if (!b.length) return { n: 0, median: null, mean: null, min: null, max: null, p25: null, p75: null, cv: null };
  const mean = meanOf(b);
  const sd = b.length > 1 ? Math.sqrt(b.reduce((s, x) => s + (x - mean) ** 2, 0) / (b.length - 1)) : null;
  return { n: b.length, median: quantile(b, 0.5), mean, min: b[0], max: b.at(-1), p25: quantile(b, 0.25), p75: quantile(b, 0.75), cv: sd === null ? null : sd / mean };
}

/** 各回撤深度（5/10/15/20）：參與的波段數與 Beta 統計。深度越大是否越敏感，由 median 隨深度的走向回答。 */
export function betaByDepth(data, records, depths = DEPTHS) {
  return depths.map(depth => {
    const rows = records.filter(r => r.maxDd >= depth)
      .map(w => ({ w, x: betaAtDepth(data, w, depth) })).filter(o => o.x);
    return { depth, ...betaStats(rows.map(o => ({ ok: true, beta: o.x.beta }))), waves: rows.map(o => ({ peakDate: o.w.peakDate, date: o.x.date, beta: o.x.beta })) };
  });
}

// ── 歷史回測（walk-forward，避免 look-ahead）──────────────────────
/**
 * 對時間排序後的每一波 k（k≥1）：Beta 只用 k 之前「已經結束」的波段（上一波，或之前各波中位數）。
 *  - 預測維持率：用第 k 波的實際指數跌幅（P0→P1）＋ M0 → 與實際 M1 比較。
 *  - 反推指數：目標＝M0-30 點、150%。若該波（高點日到波段結束）維持率從未到達目標，標「未觸及」，不算成功也不算失敗；
 *    到達者以「維持率第一次 ≤ 目標的那天」的實際指數與推估指數比較。
 * 「已結束」＝endDate < 第 k 波的 peakDate（不用同時間重疊的資料）。
 */
export function walkForward(data, records, { minPrior = 1 } = {}) {
  const tw = clean(data.twii, 'close');
  const rRows = clean(data.ratio, 'ratio');
  const recs = records.filter(r => r.ok && !r.open && r.independent).sort((a, b) => (a.peakDate < b.peakDate ? -1 : 1));
  const out = [];
  for (const w of recs) {
    const prior = recs.filter(p => p.endDate < w.peakDate);
    if (prior.length < minPrior) { out.push({ wave: w, skipped: 'no-prior' }); continue; }
    const betas = { prev: prior.at(-1).beta, median: medianOf(prior.map(p => p.beta)) };
    const row = { wave: w, priorN: prior.length, betas, predictions: {} };
    for (const [name, beta] of Object.entries(betas)) {
      const predM = projectMargin({ p0: w.peakClose, m0: w.m0, pt: w.lowClose, beta });
      const pm = predM.projected;
      const targets = [];
      for (const t of [{ key: 'm0-30', mt: w.m0 - KEY_DROP_PTS }, { key: '150', mt: 150 }]) {
        if (!(t.mt < w.m0)) { targets.push({ ...t, status: 'target-not-below' }); continue; }
        const touch = rRows.find(r => r.date >= w.peakDate && r.date <= w.endDate && r.v <= t.mt);
        const proj = projectIndex({ p0: w.peakClose, m0: w.m0, mt: t.mt, beta });
        if (!touch) { targets.push({ ...t, status: 'not-touched', projected: proj.projected }); continue; }
        const idx = tw.find(r => r.date === touch.date);
        targets.push({
          ...t, status: proj.status, touchDate: touch.date, actualIndex: idx ? idx.v : null, projected: proj.projected,
          errPts: idx && proj.projected !== null ? proj.projected - idx.v : null,
          errPct: idx && proj.projected !== null ? (proj.projected / idx.v - 1) * 100 : null,
        });
      }
      // 反向：用實際低點指數推維持率，與實際維持率比
      const lowIdxProjected = projectIndex({ p0: w.peakClose, m0: w.m0, mt: w.m1, beta });
      row.predictions[name] = {
        beta, predMargin: pm, actualMargin: w.m1,
        errMarginPts: pm === null ? null : pm - w.m1,
        errMarginPct: pm === null ? null : (pm / w.m1 - 1) * 100,
        impliedLowIndex: lowIdxProjected.projected,
        errIndexPct: lowIdxProjected.projected === null ? null : (lowIdxProjected.projected / w.lowClose - 1) * 100,
        targets,
      };
    }
    out.push(row);
  }
  return out;
}

export function errorSummary(rows, name) {
  const v = rows.filter(r => r.predictions?.[name]);
  const e = v.map(r => r.predictions[name].errMarginPts).filter(isNum);
  const p = v.map(r => r.predictions[name].errMarginPct).filter(isNum);
  const ix = v.map(r => r.predictions[name].errIndexPct).filter(isNum);
  const abs = a => a.map(Math.abs);
  return {
    name, n: v.length,
    marginErrPtsMedAbs: medianOf(abs(e)), marginErrPtsMean: meanOf(e), marginErrPctMedAbs: medianOf(abs(p)),
    indexErrPctMedAbs: medianOf(abs(ix)), indexErrPctMean: meanOf(ix),
    within5pts: e.length ? e.filter(x => Math.abs(x) <= 5).length : 0,
  };
}

/** 情境用的 Beta：歷史波段 n≥minN 時用中位數／P25／P75；否則回手動值並標 manual。 */
export function scenarioBetas(stats, { minN = 5 } = {}) {
  if (stats && stats.n >= minN && isNum(stats.median) && isNum(stats.p25) && isNum(stats.p75)) {
    return { source: 'historical', n: stats.n, low: stats.p25, base: stats.median, high: stats.p75, note: `歷史 ${stats.n} 波的 P25／中位數／P75（統計描述，非信賴區間）` };
  }
  return { source: 'manual', n: stats?.n ?? 0, ...MANUAL_BETAS, note: '手動設定的情境參數，非統計信賴區間（歷史樣本不足）' };
}

// ── 現況、反推表、均線 ──────────────────────────────────────────────
/** 參考日：'idxHigh'＝最近 lookback 個（指數∩維持率共同）交易日的最高收盤；'latest'；或 YYYY-MM-DD（須有指數與維持率）。 */
export function pickReference({ twii, ratio }, mode = 'idxHigh', { lookback = 120 } = {}) {
  const tw = clean(twii, 'close');
  const rMap = toMap(clean(ratio, 'ratio'));
  const both = tw.filter(r => rMap.has(r.date));
  if (!both.length) return { ok: false, reason: 'no-overlap' };
  let row;
  if (mode === 'latest') row = both.at(-1);
  else if (mode === 'idxHigh') row = both.slice(-lookback).reduce((a, b) => (b.v >= a.v ? b : a));
  else {
    row = both.find(r => r.date === mode);
    if (!row) return { ok: false, reason: 'date-missing', date: mode };
  }
  return { ok: true, date: row.date, p0: row.v, m0: rMap.get(row.date), latestDate: both.at(-1).date, latestP: both.at(-1).v, latestM: rMap.get(both.at(-1).date) };
}

/** 目標維持率表：預設 180/170/160/150/130 與「參考高點 -30 點」；Beta 區間上下限同列。 */
export function targetTable({ p0, m0, pNow, betas, targets = TARGET_RATIOS }) {
  const list = [...targets.map(t => ({ key: String(t), label: `${t}%`, mt: t })), { key: 'drop30', label: `參考高點 -${KEY_DROP_PTS} 點`, mt: m0 - KEY_DROP_PTS }];
  return list.map(t => {
    const at = b => projectIndex({ p0, m0, mt: t.mt, beta: b });
    const base = at(betas.base), lowB = at(betas.low), highB = at(betas.high);   // Beta 大 → 需要跌得少 → 指數較高
    const pt = base.projected;
    return {
      ...t, status: base.status, projected: pt,
      // 指數區間：Beta 小(保守)＝要跌更深＝較低；Beta 大＝較高
      rangeLow: lowB.projected, rangeHigh: highB.projected,
      fromRefPct: pt === null ? null : (pt / p0 - 1) * 100,
      fromNowPts: pt === null || !isNum(pNow) ? null : pt - pNow,
      fromNowPct: pt === null || !isNum(pNow) ? null : (pt / pNow - 1) * 100,
    };
  });
}

export function sma(twii, period) {
  const c = clean(twii, 'close');
  if (c.length < period) return null;
  let s = 0;
  for (let i = c.length - period; i < c.length; i++) s += c[i].v;
  return { value: s / period, date: c.at(-1).date };
}

/** 跌到各條均線（以最新日期的固定值試算）時，由參考基準推估的維持率；資料不足的週期略過並列在 skipped。 */
export function maTable({ twii, p0, m0, pNow, betas, periods = MA_PERIODS }) {
  const rows = [], skipped = [];
  for (const period of periods) {
    const m = sma(twii, period);
    if (!m) { skipped.push(period); continue; }
    const at = b => projectMargin({ p0, m0, pt: m.value, beta: b });
    const base = at(betas.base);
    rows.push({
      period, ma: m.value, asOf: m.date,
      fromNowPct: isNum(pNow) ? (m.value / pNow - 1) * 100 : null,
      fromRefPct: (m.value / p0 - 1) * 100,
      status: base.status, base: base.projected,
      // Beta 小 → 維持率掉得少 → 較高；Beta 大 → 較低
      rangeHigh: at(betas.low).projected, rangeLow: at(betas.high).projected,
      belowMa: isNum(pNow) ? pNow <= m.value : null,
    });
  }
  return { rows, skipped };
}

// ── 融資去槓桿觀察 ──────────────────────────────────────────────────
/**
 * 融資餘額的單日／5日／10日變化、自參考日以來的變化與峰谷。只描述，不認定「殺完」或「斷頭」。
 * flag：維持率自參考高點降幅 ≥ KEY_DROP_PTS 的 1/2 以上且融資沒有下降 → 'ratio-down-margin-not-down'（中性提示）。
 */
export function deleverObservation({ margin, ratio }, refDate) {
  const mRows = clean(margin, 'margin_money');
  const rRows = clean(ratio, 'ratio');
  if (!mRows.length) return { ok: false, reason: 'no-margin' };
  const n = mRows.length - 1, last = mRows[n];
  const chg = k => (n - k >= 0 ? { pct: (last.v / mRows[n - k].v - 1) * 100, amt: last.v - mRows[n - k].v, from: mRows[n - k].date } : null);
  const ref = mRows.find(r => r.date === refDate) ?? null;
  const since = mRows.filter(r => r.date >= refDate);
  const peak = since.length ? since.reduce((a, b) => (b.v > a.v ? b : a)) : null;
  const rLast = rRows.at(-1);
  const rRef = rRows.find(r => r.date === refDate);
  const ratioPts = rLast && rRef ? rLast.v - rRef.v : null;
  const sinceRef = ref ? { pct: (last.v / ref.v - 1) * 100, amt: last.v - ref.v } : null;
  const peakDrop = peak ? { pct: (last.v / peak.v - 1) * 100, peak: peak.v, peakDate: peak.date } : null;
  let flag = null;
  if (ratioPts !== null && sinceRef && ratioPts <= -KEY_DROP_PTS / 2 && sinceRef.pct >= 0) flag = 'ratio-down-margin-not-down';
  return { ok: true, date: last.date, margin: last.v, d1: chg(1), d5: chg(5), d10: chg(10), sinceRef, peakDrop, ratioPts, flag };
}

// ── 訊號相關性（只研究、不改規則）──────────────────────────────────
/**
 * 規則 A（回撤≥ruleDd）與 B（維持率自 lookback 高點降≥ruleRatioDrop 點）有多常同時成立？
 * 同時成立時，融資餘額自 lookback 高點下降多少（<10% 視為「沒有明顯下降」）？
 * ds＝marginalert_calc.buildDataset 的結果（含 start 之前的暖機）。
 */
export function signalOverlap(ds, { ruleDd = 15, ruleRatioDrop = 30, lookback = 120, marginMin = 10, cooldown = 20 } = {}) {
  const mg = ds.mg.map(r => r.margin_money);
  const mgIdx = new Map(ds.mg.map((r, i) => [r.date, i]));
  const days = ds.days.filter(d => d.ratio !== null);
  const A = days.map(d => d.dd >= ruleDd);
  const B = days.map(d => d.ratioDrop >= ruleRatioDrop);
  const cnt = { days: days.length, A: 0, B: 0, both: 0, either: 0, Aonly: 0, Bonly: 0 };
  days.forEach((d, i) => {
    if (A[i]) cnt.A++;
    if (B[i]) cnt.B++;
    if (A[i] && B[i]) cnt.both++;
    if (A[i] || B[i]) cnt.either++;
    if (A[i] && !B[i]) cnt.Aonly++;
    if (!A[i] && B[i]) cnt.Bonly++;
  });
  // 「A∧B」事件：相隔 > cooldown 才算新事件；事件首日量融資自 lookback 高點的降幅
  const events = [];
  let lastIdx = -Infinity;
  days.forEach((d, i) => {
    if (!(A[i] && B[i])) return;
    if (i - lastIdx > cooldown) {
      const mi = mgIdx.get(d.date);
      let hi = -Infinity;
      for (let j = Math.max(0, mi - lookback + 1); j <= mi; j++) hi = Math.max(hi, mg[j]);
      const firstA = [...days.keys()].slice(Math.max(0, i - lookback), i + 1).find(k => A[k]);
      const firstB = [...days.keys()].slice(Math.max(0, i - lookback), i + 1).find(k => B[k]);
      events.push({
        date: d.date, dd: d.dd, ratioDrop: d.ratioDrop, marginDropPct: (1 - mg[mi] / hi) * 100,
        noClearMarginDrop: (1 - mg[mi] / hi) * 100 < marginMin,
        lagDays: firstA !== undefined && firstB !== undefined ? Math.abs(firstB - firstA) : null,
      });
    }
    lastIdx = i;
  });
  return {
    counts: cnt,
    pBgivenA: cnt.A ? cnt.both / cnt.A * 100 : null,
    pAgivenB: cnt.B ? cnt.both / cnt.B * 100 : null,
    jaccard: cnt.either ? cnt.both / cnt.either * 100 : null,
    events,
    eventsNoClearMarginDrop: events.filter(e => e.noClearMarginDrop).length,
  };
}

// ── 回測誤差：依融資是否大幅去槓桿分群（描述「哪些環境容易偏差」）──────────
/** 以「期間融資最大跌幅」是否 ≤ heavyAt（預設 -25%）分群，回傳各群用中位 Beta 預測維持率的誤差。無融資資料的波段略過。 */
export function errorByRegime(wf, { heavyAt = -25, name = 'median' } = {}) {
  const grp = { heavy: [], light: [] };
  for (const r of wf) {
    const burn = r.wave?.marginMaxBurn?.pct;
    const e = r.predictions?.[name]?.errMarginPts;
    if (!isNum(burn) || !isNum(e)) continue;
    (burn <= heavyAt ? grp.heavy : grp.light).push(e);
  }
  const sum = a => ({ n: a.length, meanErr: meanOf(a), medAbs: medianOf(a.map(Math.abs)) });
  return { heavyAt, name, heavy: sum(grp.heavy), light: sum(grp.light) };
}

// ── 全部一次跑 ──────────────────────────────────────────────────────
/**
 * 依「期間融資最大跌幅」把波段分成大幅去槓桿（≤ heavyAt）與輕度（> heavyAt），各自的 Beta 統計。
 * Beta 與去槓桿程度高度相關（融資戶賣股還款會把維持率拉回，Beta 變低），所以融資還沒明顯下降時，
 * 全體中位數會低估敏感度。無融資資料的波段（2008 以前）不分群。
 */
export function betaByRegime(records, { heavyAt = -25 } = {}) {
  const withBurn = records.filter(r => r.ok && isNum(r.marginMaxBurn?.pct));
  const heavy = withBurn.filter(r => r.marginMaxBurn.pct <= heavyAt);
  const light = withBurn.filter(r => r.marginMaxBurn.pct > heavyAt);
  return { heavyAt, heavy: betaStats(heavy), light: betaStats(light), lightWaves: light.map(r => r.peakDate), heavyWaves: heavy.map(r => r.peakDate) };
}

function scenarioLight(r, { minN = 5 } = {}) {
  const l = r.light;
  if (l.n >= minN) return { source: 'historical-light', n: l.n, low: l.p25, base: l.median, high: l.p75, note: `融資未大幅去槓桿（期間融資最大跌幅 > ${r.heavyAt}%）的 ${l.n} 個歷史波段` };
  return null;
}

/** 歷史部分（與參考日、情境 Beta 無關，可快取）。 */
export function analyzeHistory(data, { minDd = 10 } = {}) {
  const hist = buildBetaHistory(data);
  const usable = hist.filter(r => r.ok && !r.open && r.independent && r.maxDd >= minDd);
  const stats = betaStats(usable);
  const wf = walkForward(data, hist);
  const betaRegime = betaByRegime(usable);
  return {
    history: hist, usable, stats, depth: betaByDepth(data, usable), depthPaired: betaDepthPaired(data, usable), walkForward: wf,
    errors: { prev: errorSummary(wf, 'prev'), median: errorSummary(wf, 'median') },
    regime: errorByRegime(wf), scenario: scenarioBetas(stats),
    betaRegime, scenarioLight: scenarioLight(betaRegime),
    coverage: {
      waves: hist.length, withRatio: hist.filter(r => r.ok).length, usable: usable.length,
      firstUsable: usable[0]?.peakDate ?? null, lastUsable: usable.at(-1)?.peakDate ?? null,
      noRatio: hist.filter(r => !r.ok).length,
    },
  };
}

/**
 * 情境部分（隨參考日／Beta 變動）。
 * beta：{low, base, high} 使用者自訂，缺漏／非正值的欄位退回歷史情境；source 以 'user' 標示。
 * alignment：指數／維持率／融資三者最新日期；不一致就回 aligned=false，由頁面顯示警告。
 */
export function scenarioView(data, h, { refMode = 'idxHigh', beta = null, scenario = 'hist' } = {}) {
  let betas = scenario === 'light' && h.scenarioLight ? h.scenarioLight : h.scenario;
  if (beta) {
    const ok = k => isNum(beta[k]) && beta[k] > 0;
    const l = ok('low') ? beta.low : betas.low, b0 = ok('base') ? beta.base : betas.base, hgh = ok('high') ? beta.high : betas.high;
    // 區間上下限取三者的最小／最大，確保基準一定落在區間內（輸入順序錯了也不會反過來）
    betas = { source: 'user', n: betas.n, note: '使用者自訂 Beta（未經回測驗證）', low: Math.min(l, b0, hgh), base: b0, high: Math.max(l, b0, hgh) };
  }
  const ref = pickReference(data, refMode);
  const last = a => clean(a, a === data.ratio ? 'ratio' : a === data.margin ? 'margin_money' : 'close').at(-1)?.date ?? null;
  const alignment = { twii: last(data.twii), ratio: last(data.ratio), margin: last(data.margin) };
  alignment.aligned = !!alignment.twii && alignment.twii === alignment.ratio && alignment.ratio === alignment.margin;
  const out = { betas, ref, alignment, targets: null, ma: null, delever: null, realized: null };
  if (!ref.ok) return out;
  const b = betas;
  out.targets = targetTable({ p0: ref.p0, m0: ref.m0, pNow: ref.latestP, betas: b });
  out.ma = maTable({ twii: data.twii, p0: ref.p0, m0: ref.m0, pNow: ref.latestP, betas: b });
  out.delever = deleverObservation(data, ref.date);
  // 參考日→最新的實際倍數，以及各 Beta 在最新價位的隱含維持率（用來檢查模型現在偏多少）
  const s = sensitivity({ p0: ref.p0, p1: ref.latestP, m0: ref.m0, m1: ref.latestM });
  out.realized = {
    ...s, latestP: ref.latestP, latestM: ref.latestM, latestDate: ref.latestDate,
    implied: Object.fromEntries(['low', 'base', 'high'].map(k => [k, projectMargin({ p0: ref.p0, m0: ref.m0, pt: ref.latestP, beta: b[k] }).projected])),
  };
  return out;
}

/** 頁面與 CLI 共用的一次跑。任何一步缺資料只讓該區塊回 null／ok=false，不丟例外。 */
export function runStress(data, { refMode = 'idxHigh', minDd = 10, beta = null } = {}) {
  const h = analyzeHistory(data, { minDd });
  const v = scenarioView(data, h, { refMode, beta });
  return { ...h, scenarioView: v, betas: v.betas, ref: v.ref, targets: v.targets, ma: v.ma, delever: v.delever };
}
