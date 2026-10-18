// 美股去槓桿三層監控研究引擎（純函式；無 DOM、無網路）。
//   Layer 1 月：FINRA margin debt（用實際公布日，不是月底）
//   Layer 2 週：CFTC TFF Leveraged Funds（ES/NQ/RTY 期貨）、Chicago Fed NFCI leverage/risk/credit
//   Layer 3 日：VIX、VXN、VIX 期限結構、HY 信用（OAS 或 HYG/LQD 代理）、SPY/QQQ 回撤、市場廣度、CNN 恐懼貪婪
//
// 研究原則（寫死在程式裡，不是事後挑的）：
//  - 每個訊號只在「資料實際可得日」之後的交易日才可交易：進場最早為可得日的下一個交易日開盤。
//  - CFTC：報告日為週二、公開日為週五（遇假日順延到下一交易日）；NFCI：週五資料於下週三公布；
//    FINRA：用 Wayback 快照推得的公布日區間，預設取上界（最晚才知道＝保守）。
//  - CFTC 期貨轉倉：季度到期週（第三個週五）與其後一週的報告被標記為「轉倉污染」，
//    不發訊號，變動量改以「前一個乾淨報告 → 本報告」計算（跨週數記錄在 span）。
//  - NFCI 是整段歷史會被重估的指數：本引擎吃的是「最新版」，沒有 ALFRED 逐期版本（見報告限制）。
//  - 不假設任何指標有效；所有門檻先固定在 DEFAULTS，不以回測結果反向調整。

export const DEFAULTS = Object.freeze({
  start: '2020-01-01',
  end: '2026-10-16',
  entry: 'nextOpen',               // 訊號可得日的下一交易日開盤
  horizons: [5, 10, 20, 60],
  cooldown: 10,                    // 同一訊號相隔 > cooldown 個交易日才算新事件
  lookback: 120,                   // 回撤高點窗
  waveEnter: 8, waveExit: 3,       // 客觀下跌波段（美股指數：回撤≥8% 進入、<3% 結束）
  // 可得性
  finraBound: 'model',             // 'model'＝月底+finraLagDays，夾在 (not_yet, known_by]；'upper'＝首次被快照看到（最晚）；'lower'＝前一快照日+1（最早）
  finraLagDays: 25,                // 緊括號月份（括號寬≤10天）的公布延遲：14～29 天、中位 22、p75≈25 → 取 25（偏保守）
  cftcExtraLagTd: 0, nfciExtraLagTd: 0,
  rollOffsets: [0, 1],             // 以季度到期週為 0 的報告偏移（週）；落在此集合的報告視為轉倉污染
  // Layer 2
  cftcGrossTh: [4, 6, 8],          // 單一商品槓桿基金 gross 曝險單期收縮 ≥ x%
  nfciZ: 1.5, nfciZWindow: 52,     // NFCI 變動 z-score 門檻（只用過去 52 週）
  // Layer 1
  finraMoM: [-2, -3, -5],
  // Layer 3
  vixHi: 25, vxnHi: 28, tsBack: 1.0, hyProxy20: -2.5, breadth50Lo: 35,
  stressCount: 2,
  vixCalmFrac: 0.85, vixCalmWin: 10,
  fearThr: 15,
  slowdownGross: 3,                // 前期收縮 ≥ x% 後，本期收縮放緩
});

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

export function median(vals) {
  const s = vals.filter(isNum).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length;
  return m % 2 ? s[(m - 1) / 2] : (s[m / 2 - 1] + s[m / 2]) / 2;
}
export const avg = vals => { const v = vals.filter(isNum); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
export function pearson(x, y) {
  const p = [];
  for (let i = 0; i < x.length; i++) if (isNum(x[i]) && isNum(y[i])) p.push([x[i], y[i]]);
  const n = p.length;
  if (n < 8) return { r: null, n };
  const mx = p.reduce((a, b) => a + b[0], 0) / n, my = p.reduce((a, b) => a + b[1], 0) / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [a, b] of p) { sxx += (a - mx) ** 2; syy += (b - my) ** 2; sxy += (a - mx) * (b - my); }
  return { r: sxx && syy ? sxy / Math.sqrt(sxx * syy) : null, n };
}

// ── 日期工具（全部用 UTC 字串運算，不受本地時區影響）──────────────
export const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
export const dayDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
export function thirdFriday(y, m) {            // m: 1..12
  const first = new Date(Date.UTC(y, m - 1, 1));
  const offset = (5 - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(y, m - 1, 1 + offset + 14)).toISOString().slice(0, 10);
}
/** 報告日相對最近一個季度到期日（3/6/9/12 第三個週五）的週數偏移；0＝到期週，1＝到期後一週 */
export function rollOffsetWeeks(reportDate) {
  const y = +reportDate.slice(0, 4);
  let best = null;
  for (const yy of [y - 1, y, y + 1]) for (const m of [3, 6, 9, 12]) {
    const e = thirdFriday(yy, m);
    const wk = Math.round(dayDiff(e, reportDate) / 7);
    if (best === null || Math.abs(dayDiff(e, reportDate)) < Math.abs(best.days)) best = { days: dayDiff(e, reportDate), wk };
  }
  return best.wk + 0;   // 避免 -0
}

// ── 市場日曆與日頻特徵 ──────────────────────────────────────────────
function cleanOhlc(rows) {
  const out = new Map();
  for (const r of rows || []) {
    if (r && typeof r.date === 'string' && [r.open, r.high, r.low, r.close].every(v => isNum(v) && v > 0)) out.set(r.date, r);
  }
  return out;
}
function rollingMax(values, L) {
  const out = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let best = -Infinity, bi = i;
    for (let j = Math.max(0, i - L + 1); j <= i; j++) if (values[j] >= best) { best = values[j]; bi = j; }
    out[i] = { max: best, idx: bi };
  }
  return out;
}

export function buildMarket(raw, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const spy = cleanOhlc(raw.spy), qqq = cleanOhlc(raw.qqq);
  const cal = [...spy.keys()].filter(d => qqq.has(d)).sort();
  const idx = new Map(cal.map((d, i) => [d, i]));
  const N = cal.length;
  const mkSym = m => ({ o: cal.map(d => m.get(d).open), h: cal.map(d => m.get(d).high), l: cal.map(d => m.get(d).low), c: cal.map(d => m.get(d).close) });
  const sym = { SPY: mkSym(spy), QQQ: mkSym(qqq) };
  for (const s of Object.values(sym)) {
    const hi = rollingMax(s.c, c.lookback);
    s.dd = s.c.map((v, i) => (1 - v / hi[i].max) * 100);
    s.peakIdx = hi.map(x => x.idx);
  }
  const byDateMap = (rows, f) => { const m = new Map(); for (const r of rows || []) if (r && typeof r.date === 'string' && isNum(f(r))) m.set(r.date, f(r)); return m; };
  const vixM = byDateMap(raw.vix, r => r.close), vxnM = byDateMap(raw.vxn, r => r.close);
  const tsM = new Map(); for (const r of raw.vixTerm || []) if (r && isNum(r.vix) && isNum(r.vix3m) && r.vix3m > 0) tsM.set(r.date, r.vix / r.vix3m);
  const oasM = byDateMap(raw.creditSpread, r => r.hy);
  const hygM = byDateMap(raw.hyg, r => r.close), lqdM = byDateMap(raw.lqd, r => r.close);
  const brM = byDateMap(raw.breadth, r => r.above50_pct);
  const fgM = byDateMap(raw.fearGreed, r => r.value);
  const pick = m => cal.map(d => (m.has(d) ? m.get(d) : null));
  const vix = pick(vixM), vxn = pick(vxnM), ts = pick(tsM), oas = pick(oasM), breadth50 = pick(brM), fg = pick(fgM);
  // HY 代理：HYG/LQD 比價的 20 日變動（%）。兩者皆 ETF 收盤，非利差；只在缺 OAS 的年份當代理。
  const ratio = cal.map(d => (hygM.has(d) && lqdM.has(d) ? hygM.get(d) / lqdM.get(d) : null));
  const hyp20 = ratio.map((v, i) => (i >= 20 && isNum(v) && isNum(ratio[i - 20]) ? (v / ratio[i - 20] - 1) * 100 : null));
  // OAS 5 日變動（百分點）
  const oas5 = oas.map((v, i) => (i >= 5 && isNum(v) && isNum(oas[i - 5]) ? v - oas[i - 5] : null));
  const si = cal.findIndex(d => d >= c.start);
  let ei = N - 1; while (ei > 0 && cal[ei] > c.end) ei--;
  return { cfg: c, cal, idx, N, sym, vix, vxn, ts, oas, oas5, hyp20, breadth50, fg, si: Math.max(0, si), ei };
}

/** 第一個 >= date 的交易日 index；超出範圍回 null */
export function idxOnOrAfter(mk, date) {
  let lo = 0, hi = mk.N - 1, res = null;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (mk.cal[mid] >= date) { res = mid; hi = mid - 1; } else lo = mid + 1; }
  return res;
}
export function idxOnOrBefore(mk, date) {
  let lo = 0, hi = mk.N - 1, res = null;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (mk.cal[mid] <= date) { res = mid; lo = mid + 1; } else hi = mid - 1; }
  return res;
}

// ── Layer 2：CFTC ──────────────────────────────────────────────────
/**
 * 每個商品：依報告日排序；標記轉倉污染；變動量以「前一個乾淨報告」為基準。
 * availIdx＝公開日（報告日+3＝週五；非交易日則順延）所在交易日，之後再加 extraLag。
 */
export function prepCftc(mk, instruments, cfg = mk.cfg) {
  const out = {};
  for (const ins of instruments) {
    const seen = new Set();
    const rows = (ins.rows || []).filter(r => typeof r?.date === 'string' && !seen.has(r.date) && seen.add(r.date)
      && [r.lev_long, r.lev_short, r.open_interest].every(v => isNum(v) && v >= 0)).sort(byDate);
    const recs = rows.map(r => {
      const wk = rollOffsetWeeks(r.date);
      const roll = cfg.rollOffsets.includes(wk);
      const rel = idxOnOrAfter(mk, addDays(r.date, 3));
      const availIdx = rel === null ? null : Math.min(mk.N - 1, rel + cfg.cftcExtraLagTd);
      return { date: r.date, availIdx: rel === null ? null : (rel + cfg.cftcExtraLagTd < mk.N ? rel + cfg.cftcExtraLagTd : null), rollWk: wk, roll,
        long: r.lev_long, short: r.lev_short, gross: r.lev_long + r.lev_short, net: r.lev_long - r.lev_short, oi: r.open_interest,
        gChg: null, lChg: null, sChg: null, nChgOi: null, span: null };
    });
    let prev = null;
    for (const r of recs) {
      if (r.roll) continue;
      if (prev && prev.gross > 0) {
        r.span = Math.round(dayDiff(prev.date, r.date) / 7);
        r.gChg = (r.gross / prev.gross - 1) * 100;
        r.lChg = prev.long > 0 ? (r.long / prev.long - 1) * 100 : null;
        r.sChg = prev.short > 0 ? (r.short / prev.short - 1) * 100 : null;
        r.nChgOi = (r.net - prev.net) / r.oi * 100;     // 淨部位變動占 OI 的百分點（正＝偏多）
      }
      prev = r;
    }
    out[ins.id] = recs;
  }
  return out;
}

/** 把多個商品的乾淨報告以報告日對齊，產生週表（availIdx 取各商品最大者） */
export function cftcWeekly(cf, ids = ['sp500', 'nasdaq100', 'russell2000']) {
  const dates = [...new Set(ids.flatMap(id => (cf[id] || []).map(r => r.date)))].sort();
  const maps = Object.fromEntries(ids.map(id => [id, new Map((cf[id] || []).map(r => [r.date, r]))]));
  return dates.map(d => {
    const rec = { date: d, per: {} };
    let avail = null;
    for (const id of ids) {
      const r = maps[id].get(d);
      if (r) { rec.per[id] = r; if (r.availIdx !== null) avail = avail === null ? r.availIdx : Math.max(avail, r.availIdx); }
    }
    rec.availIdx = avail;
    rec.roll = ids.some(id => maps[id].get(d)?.roll);
    const g = ids.map(id => rec.per[id]?.gChg).filter(isNum);
    rec.avgG = g.length ? g.reduce((a, b) => a + b, 0) / g.length : null;
    rec.sp = rec.per.sp500 || null; rec.nq = rec.per.nasdaq100 || null; rec.ru = rec.per.russell2000 || null;
    return rec;
  });
}

// ── Layer 2：NFCI ──────────────────────────────────────────────────
export function prepNfci(mk, rows, cfg = mk.cfg) {
  const seen = new Set();
  const r = (rows || []).filter(x => typeof x?.date === 'string' && !seen.has(x.date) && seen.add(x.date) && isNum(x.leverage) && isNum(x.risk) && isNum(x.credit)).sort(byDate);
  const out = r.map(x => ({ date: x.date, lev: x.leverage, risk: x.risk, credit: x.credit, nfci: x.nfci,
    availIdx: (() => { const i = idxOnOrAfter(mk, addDays(x.date, 5)); return i === null || i + cfg.nfciExtraLagTd >= mk.N ? null : i + cfg.nfciExtraLagTd; })() }));
  for (let i = 1; i < out.length; i++) {
    out[i].dLev = out[i].lev - out[i - 1].lev; out[i].dRisk = out[i].risk - out[i - 1].risk; out[i].dCredit = out[i].credit - out[i - 1].credit;
  }
  const z = (key, i) => {                      // 只用過去 W 週（不含當週）
    const w = [];
    for (let j = Math.max(1, i - cfg.nfciZWindow); j < i; j++) if (isNum(out[j][key])) w.push(out[j][key]);
    if (w.length < 26) return null;
    const m = w.reduce((a, b) => a + b, 0) / w.length;
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / w.length);
    return sd > 0 ? (out[i][key] - m) / sd : null;
  };
  for (let i = 1; i < out.length; i++) { out[i].zLev = z('dLev', i); out[i].zRisk = z('dRisk', i); out[i].zCredit = z('dCredit', i); }
  return out;
}

export function monthEnd(ym) {
  const y = +ym.slice(0, 4), m = +ym.slice(5, 7);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
/** 緊括號（not_yet→known_by ≤ maxWidth 天）月份的公布延遲分佈，用來校準 finraLagDays */
export function finraLagStats(release, since = '2020-01', maxWidth = 10) {
  const lags = [];
  for (const [m, r] of Object.entries(release || {})) {
    if (m < since || r.left_censored || !r.not_yet) continue;
    if (dayDiff(r.not_yet, r.known_by) <= maxWidth) lags.push(dayDiff(monthEnd(m), r.known_by));
  }
  lags.sort((a, b) => a - b);
  const q = p => (lags.length ? lags[Math.floor(p * (lags.length - 1))] : null);
  return { n: lags.length, min: lags[0] ?? null, median: median(lags), p75: q(0.75), max: lags.at(-1) ?? null };
}

// ── Layer 1：FINRA ─────────────────────────────────────────────────
/** rows: [{date:'YYYY-MM-01', margin_balance}]；release: finra_release_dates.json 的 release 欄 */
export function prepFinra(mk, rows, release, cfg = mk.cfg) {
  const seen = new Set();
  const r = (rows || []).filter(x => typeof x?.date === 'string' && !seen.has(x.date) && seen.add(x.date) && isNum(x.margin_balance) && x.margin_balance > 0).sort(byDate);
  const out = r.map((x, i) => {
    const key = x.date.slice(0, 7);
    const rel = release?.[key];
    let known = null;
    let unbracketed = false;
    if (!rel) {                      // 快照沒有這個月（頁面缺列或太新）：只能用模型延遲，標記無括號
      known = addDays(monthEnd(key), cfg.finraLagDays);
      unbracketed = true;
    } else {
      const lo = rel.not_yet ? addDays(rel.not_yet, 1) : null;
      if (cfg.finraBound === 'upper') known = rel.known_by;
      else if (cfg.finraBound === 'lower') known = lo ?? rel.known_by;
      else {
        known = addDays(monthEnd(key), cfg.finraLagDays);
        if (lo && known < lo) known = lo;
        if (known > rel.known_by) known = rel.known_by;
      }
    }
    const ai = known ? idxOnOrAfter(mk, known) : null;
    const rec = { month: key, date: x.date, debit: x.margin_balance, unbracketed, knownDate: known, notYet: rel?.not_yet ?? null, leftCensored: !!rel?.left_censored, availIdx: ai,
      mom: i > 0 ? (x.margin_balance / r[i - 1].margin_balance - 1) * 100 : null,
      m3: i > 2 ? (x.margin_balance / r[i - 3].margin_balance - 1) * 100 : null };
    return rec;
  });
  // 與同月 SPY/QQQ 的月報酬（日曆月：上月最後交易日收 → 本月最後交易日收）
  const lastIdx = new Map();
  mk.cal.forEach((d, i) => lastIdx.set(d.slice(0, 7), i));
  for (let i = 1; i < out.length; i++) {
    const a = lastIdx.get(out[i - 1].month), b = lastIdx.get(out[i].month);
    if (a !== undefined && b !== undefined) {
      out[i].retSPY = (mk.sym.SPY.c[b] / mk.sym.SPY.c[a] - 1) * 100;
      out[i].retQQQ = (mk.sym.QQQ.c[b] / mk.sym.QQQ.c[a] - 1) * 100;
    }
  }
  return out;
}

// ── 事件、警報後表現 ────────────────────────────────────────────────
export function clusterEvents(idxs, cooldown) {
  const ev = [];
  for (const i of idxs) {
    const last = ev.at(-1);
    if (last && i - last.lastIdx <= cooldown) { last.lastIdx = i; last.signals += 1; }
    else ev.push({ idx: i, lastIdx: i, signals: 1 });
  }
  return ev;
}

/** 訊號在 i 日收盤後才可得 → 進場 i+1 開盤；持有 h 日（出場 i+h 收盤）。 */
export function forward(mk, sym, i, cfg = mk.cfg) {
  const s = mk.sym[sym];
  const e = i + 1;
  if (e >= mk.N) return null;
  const entry = cfg.entry === 'nextClose' ? s.c[e] : s.o[e];
  const first = cfg.entry === 'nextClose' ? e + 1 : e;
  const out = { entryDate: mk.cal[e], h: {} };
  for (const h of cfg.horizons) {
    const exit = cfg.entry === 'nextClose' ? e + h : e + h - 1;
    if (exit >= mk.N) { out.h[h] = null; continue; }
    let lo = Infinity, hi = -Infinity, loIdx = first, brk = false;
    for (let j = first; j <= exit; j++) {
      if (s.l[j] < lo) { lo = s.l[j]; loIdx = j; }
      if (s.h[j] > hi) hi = s.h[j];
      if (s.l[j] < s.l[i]) brk = true;
    }
    out.h[h] = { ret: (s.c[exit] / entry - 1) * 100, mdd: Math.min(0, (lo / entry - 1) * 100), rally: Math.max(0, (hi / entry - 1) * 100), breakLow: brk, daysToLow: loIdx - i };
  }
  return out;
}

export function summarize(rows, horizons) {
  const res = {};
  for (const h of horizons) {
    const v = rows.map(r => r?.h?.[h]).filter(Boolean);
    res[h] = {
      n: v.length, retMean: avg(v.map(x => x.ret)), retMedian: median(v.map(x => x.ret)),
      win: v.length ? v.filter(x => x.ret > 0).length / v.length * 100 : null,
      mddMedian: median(v.map(x => x.mdd)), mddWorst: v.length ? Math.min(...v.map(x => x.mdd)) : null,
      rallyMedian: median(v.map(x => x.rally)),
      breakPct: v.length ? v.filter(x => x.breakLow).length / v.length * 100 : null,
    };
  }
  return res;
}

export function inRange(mk, i) { return i !== null && i >= mk.si && i <= mk.ei; }

/** flags（訊號可得日 index，可重複）→ 獨立事件 + 兩個指數的警報後表現 */
export function evaluate(mk, flags, cfg = mk.cfg, cooldown = cfg.cooldown) {
  const uniq = [...new Set(flags.filter(i => inRange(mk, i)))].sort((a, b) => a - b);
  const events = clusterEvents(uniq, cooldown);
  const fw = { SPY: events.map(e => forward(mk, 'SPY', e.idx, cfg)), QQQ: events.map(e => forward(mk, 'QQQ', e.idx, cfg)) };
  return { flagDays: uniq.length, events, fwd: fw, sum: { SPY: summarize(fw.SPY, cfg.horizons), QQQ: summarize(fw.QQQ, cfg.horizons) } };
}

export function baseline(mk, filter, cfg = mk.cfg) {
  const rows = { SPY: [], QQQ: [] };
  let n = 0;
  for (let i = mk.si; i <= mk.ei; i++) if (filter(i)) { n++; rows.SPY.push(forward(mk, 'SPY', i, cfg)); rows.QQQ.push(forward(mk, 'QQQ', i, cfg)); }
  return { n, SPY: summarize(rows.SPY, cfg.horizons), QQQ: summarize(rows.QQQ, cfg.horizons) };
}

// ── 客觀下跌波段 ────────────────────────────────────────────────────
export function findWaves(mk, symName, cfg = mk.cfg) {
  const s = mk.sym[symName];
  const waves = [];
  let cur = null;
  for (let i = mk.si; i <= mk.ei; i++) {
    if (!cur && s.dd[i] >= cfg.waveEnter) cur = { startIdx: i, lowIdx: i };
    if (cur) {
      if (s.c[i] < s.c[cur.lowIdx]) cur.lowIdx = i;
      if (s.dd[i] < cfg.waveExit || i === mk.ei) { cur.endIdx = i; cur.open = !(s.dd[i] < cfg.waveExit); waves.push(cur); cur = null; }
    }
  }
  return waves.map(w => {
    const pk = s.peakIdx[w.startIdx];
    return { ...w, sym: symName, peakIdx: pk, peakDate: mk.cal[pk], startDate: mk.cal[w.startIdx], lowDate: mk.cal[w.lowIdx], endDate: mk.cal[w.endIdx],
      maxDd: s.dd[w.lowIdx], lowClose: s.c[w.lowIdx] };
  });
}

/** 事件（可得日 index）對波段：每波第一次出現的事件、領先低點幾個交易日；以及波段外（假警報）事件數 */
export function waveCoverage(mk, events, waves) {
  const per = waves.map(w => {
    const first = events.find(e => e.idx >= w.peakIdx && e.idx <= w.endIdx);
    if (!first) return { wave: w, hit: false };
    const s = mk.sym[w.sym];
    return { wave: w, hit: true, idx: first.idx, date: mk.cal[first.idx], lead: w.lowIdx - first.idx, remaining: (w.lowClose / s.c[first.idx] - 1) * 100, dd: s.dd[first.idx] };
  });
  const hits = per.filter(p => p.hit);
  const outside = events.filter(e => !waves.some(w => e.idx >= w.peakIdx && e.idx <= w.endIdx)).length;
  // 波段窗內的日數占比＝「隨機一天落在波段窗內」的機率（precision 的比較基準）
  let inDays = 0;
  for (let i = mk.si; i <= mk.ei; i++) if (waves.some(w => i >= w.peakIdx && i <= w.endIdx)) inDays++;
  const baseShare = inDays / (mk.ei - mk.si + 1) * 100;
  // 近底命中：事件落在「波段低點前 10 個交易日～低點當日」
  const nearLow = waves.filter(w => events.some(e => e.idx >= w.lowIdx - 10 && e.idx <= w.lowIdx)).length;
  return { per, baseShare, nearLow, hit: hits.length, total: waves.length, leadMedian: median(hits.map(p => p.lead)), remainingMedian: median(hits.map(p => p.remaining)),
    outside, inside: events.length - outside, precision: events.length ? (events.length - outside) / events.length * 100 : null };
}

// ── 訊號目錄 ────────────────────────────────────────────────────────
const flagWeekly = (w, f) => w.filter(f).map(x => x.availIdx).filter(i => i !== null);

export function signalCatalog(mk, data, cfg = mk.cfg) {
  const { weekly, nfci, finra } = data;
  const sigs = [];
  const add = (id, layer, label, flags) => sigs.push({ id, layer, label, flags });
  for (const t of cfg.cftcGrossTh) {
    add(`cftc_sp_g${t}`, 'W', `ES 槓桿基金 gross 單期收縮≥${t}%`, flagWeekly(weekly, w => !w.roll && isNum(w.sp?.gChg) && w.sp.gChg <= -t));
    add(`cftc_nq_g${t}`, 'W', `NQ 槓桿基金 gross 單期收縮≥${t}%`, flagWeekly(weekly, w => !w.roll && isNum(w.nq?.gChg) && w.nq.gChg <= -t));
    add(`cftc_both_g${t}`, 'W', `ES 與 NQ 同週 gross 收縮≥${t}%（集中）`, flagWeekly(weekly, w => !w.roll && isNum(w.sp?.gChg) && isNum(w.nq?.gChg) && w.sp.gChg <= -t && w.nq.gChg <= -t));
    add(`cftc_three_g${t}`, 'W', `ES/NQ/RTY 至少 2 個同週 gross 收縮≥${t}%`, flagWeekly(weekly, w => !w.roll && [w.sp, w.nq, w.ru].filter(x => isNum(x?.gChg) && x.gChg <= -t).length >= 2));
  }
  add('cftc_long_l8', 'W', 'ES 槓桿基金多單單期收縮≥8%', flagWeekly(weekly, w => !w.roll && isNum(w.sp?.lChg) && w.sp.lChg <= -8));
  add('nfci_lev_up', 'W', `NFCI-leverage 週變動 z≥${cfg.nfciZ}`, nfci.filter(r => isNum(r.zLev) && r.zLev >= cfg.nfciZ).map(r => r.availIdx).filter(i => i !== null));
  add('nfci_lev_down', 'W', `NFCI-leverage 週變動 z≤-${cfg.nfciZ}`, nfci.filter(r => isNum(r.zLev) && r.zLev <= -cfg.nfciZ).map(r => r.availIdx).filter(i => i !== null));
  add('nfci_risk_up', 'W', `NFCI-risk 週變動 z≥${cfg.nfciZ}`, nfci.filter(r => isNum(r.zRisk) && r.zRisk >= cfg.nfciZ).map(r => r.availIdx).filter(i => i !== null));
  add('nfci_credit_up', 'W', `NFCI-credit 週變動 z≥${cfg.nfciZ}`, nfci.filter(r => isNum(r.zCredit) && r.zCredit >= cfg.nfciZ).map(r => r.availIdx).filter(i => i !== null));
  for (const m of cfg.finraMoM) add(`finra_mom${-m}`, 'M', `FINRA margin debt 月減≥${-m}%（公布後）`, finra.filter(r => isNum(r.mom) && r.mom <= m).map(r => r.availIdx).filter(i => i !== null));
  // Layer 3 日頻
  const daily = f => { const o = []; for (let i = mk.si; i <= mk.ei; i++) if (f(i)) o.push(i); return o; };
  add('vix25', 'D', `VIX 收盤≥${cfg.vixHi}`, daily(i => isNum(mk.vix[i]) && mk.vix[i] >= cfg.vixHi));
  add('vix30', 'D', 'VIX 收盤≥30', daily(i => isNum(mk.vix[i]) && mk.vix[i] >= 30));
  add('vxn', 'D', `VXN 收盤≥${cfg.vxnHi}`, daily(i => isNum(mk.vxn[i]) && mk.vxn[i] >= cfg.vxnHi));
  add('ts_back', 'D', 'VIX/VIX3M ≥1（期限結構倒掛）', daily(i => isNum(mk.ts[i]) && mk.ts[i] >= cfg.tsBack));
  return sigs;
}

// ── Layer 3 狀態（每日布林）───────────────────────────────────────
export function stressFlags(mk, cfg = mk.cfg) {
  const n = mk.N;
  const comp = { vix: new Array(n).fill(false), vxn: new Array(n).fill(false), ts: new Array(n).fill(false), hy: new Array(n).fill(false), br: new Array(n).fill(false) };
  const count = new Array(n).fill(0), known = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const t = (key, ok, v) => { if (isNum(v)) { known[i] += 1; if (ok) { comp[key][i] = true; count[i] += 1; } } };
    t('vix', mk.vix[i] >= cfg.vixHi, mk.vix[i]);
    t('vxn', mk.vxn[i] >= cfg.vxnHi, mk.vxn[i]);
    t('ts', mk.ts[i] >= cfg.tsBack, mk.ts[i]);
    // HY：有 OAS（2023-06 起）用 5 日 +0.5pp；否則用 HYG/LQD 20 日 ≤ -2.5% 當代理
    const hyV = isNum(mk.oas5[i]) ? mk.oas5[i] : mk.hyp20[i];
    t('hy', isNum(mk.oas5[i]) ? mk.oas5[i] >= 0.5 : mk.hyp20[i] <= cfg.hyProxy20, hyV);
    t('br', mk.breadth50[i] <= cfg.breadth50Lo, mk.breadth50[i]);
  }
  return { comp, count, known, stress: count.map(v => v >= cfg.stressCount) };
}

/** VIX 回落（平靜化）：低於高檔、且較 5 日前下降、且 ≤ 近 W 日高點×frac */
export function vixCalm(mk, i, cfg = mk.cfg) {
  const v = mk.vix[i];
  if (!isNum(v) || i < cfg.vixCalmWin) return false;
  let mx = -Infinity;
  for (let j = i - cfg.vixCalmWin; j <= i; j++) if (isNum(mk.vix[j]) && mk.vix[j] > mx) mx = mk.vix[j];
  return v <= mx * cfg.vixCalmFrac && isNum(mk.vix[i - 5]) && v < mk.vix[i - 5];
}
