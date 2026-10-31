// QQQ 盤中急跌 × 恐慌背離回測引擎（純函式，無 DOM）。
// 與 scripts/research/backtest_qqq_panic.mjs 共用；Python 獨立複核 scripts/research/verify_qqq_panic.py。
// 時間切分（防偷看）：事前窗 T-60～T-1、事件日 T（盤後才完整可知）、未來窗 T+1～T+60；三段互不重疊。
// 缺資料一律回 null，不補值；視窗不足的 horizon 不計入統計。

export const DEFAULTS = Object.freeze({
  start: '2015-01-01',
  end: '2026-10-30',
  thresholds: [-2, -3, -4, -5],        // 盤中跌幅門檻 %（Low_T / Close_{T-1} − 1）
  main: -3,
  compare: [-2, -4],
  appendix: [-5],
  preWin: 60,
  postWin: 60,
  horizons: [5, 20, 60],
  groupWin: 20,                        // 錨定法：群組第一筆起算 20 個交易日（含當日）
  vixPanic: 30,                        // VIX High ≥ 30
  fgPanic: 15,                         // Fear & Greed < 15
  vxnAux: 40,                          // VXN High ≥ 40（僅輔助）
  volLookback: 20,
  volSurge: 1.5,                       // 爆量：當日量 ≥ 前 20 日均量 × 1.5
  volSensitivity: [1.2, 2.0],
  mas: [125, 150, 300],
  maConfirm: 0.025,                    // 站回確認：收盤 > MA × 1.025
  bootstrap: { iters: 5000, seed: 20261030, alpha: 0.05 },
});

// 事前定義的特殊區間；extra=true 為補充對照（非使用者指定清單）。
export const PERIODS = Object.freeze([
  { id: '2015-08', label: '2015/8 人民幣貶值閃崩', from: '2015-08-01', to: '2015-09-30' },
  { id: '2016-01', label: '2016/1 油價＋中國', from: '2016-01-01', to: '2016-02-29' },
  { id: '2022', label: '2022 升息熊市', from: '2022-01-01', to: '2022-12-31' },
  { id: '2024-08', label: '2024/8 日圓套利平倉', from: '2024-07-15', to: '2024-09-13' },
  { id: '2026-07~10', label: '2026/7～10', from: '2026-07-01', to: '2026-10-30' },
  { id: '2018-Q4', label: '2018 Q4 修正（補充）', from: '2018-10-01', to: '2018-12-31', extra: true },
  { id: '2020-COVID', label: '2020/2～4 疫情（補充）', from: '2020-02-15', to: '2020-04-30', extra: true },
  { id: '2025-04', label: '2025/2～4 關稅（補充）', from: '2025-02-15', to: '2025-04-30', extra: true },
  { id: '2026-03', label: '2026/2～4 前一波恐慌（補充）', from: '2026-02-15', to: '2026-04-30', extra: true },
  { id: '2026-06', label: '2026/6 前導（補充）', from: '2026-06-01', to: '2026-06-30', extra: true },
]);

const finite = v => typeof v === 'number' && Number.isFinite(v);
const pctOf = (a, b) => (finite(a) && finite(b) && b !== 0 ? (a / b - 1) * 100 : null);

// ── frame ───────────────────────────────────────────────────────────────
// raw = { QQQ:[{date,open,high,low,close,volume}], VIX:[...], VXN:[...], FG:[{date,value}] }
export function buildFrame(raw, cfg = DEFAULTS) {
  const q = [...raw.QQQ].filter(r => r && r.date).sort((a, b) => (a.date < b.date ? -1 : 1));
  const map = (rows, f) => new Map((rows || []).filter(r => r && r.date).map(r => [r.date, f(r)]));
  const vix = map(raw.VIX, r => r), vxn = map(raw.VXN, r => r), fg = map(raw.FG, r => (finite(r.value) ? r.value : null));
  const num = v => (finite(v) ? v : null);
  const n = q.length;
  const F = {
    cfg, n, date: q.map(r => r.date),
    o: q.map(r => num(r.open)), h: q.map(r => num(r.high)), l: q.map(r => num(r.low)), c: q.map(r => num(r.close)), v: q.map(r => num(r.volume)),
    vixH: [], vixL: [], vixC: [], vxnH: [], vxnL: [], vxnC: [], fg: [], ma: {}, volAvg: [],
  };
  F.index = new Map(F.date.map((d, i) => [d, i]));
  for (const d of F.date) {
    const a = vix.get(d), b = vxn.get(d);
    F.vixH.push(num(a?.high)); F.vixL.push(num(a?.low)); F.vixC.push(num(a?.close));
    F.vxnH.push(num(b?.high)); F.vxnL.push(num(b?.low)); F.vxnC.push(num(b?.close));
    F.fg.push(fg.has(d) ? fg.get(d) : null);
  }
  for (const p of cfg.mas) F.ma[p] = sma(F.c, p);
  F.volAvg = F.v.map((_, i) => {
    if (i < cfg.volLookback) return null;
    let s = 0;
    for (let k = i - cfg.volLookback; k < i; k++) { if (!finite(F.v[k])) return null; s += F.v[k]; }
    return s / cfg.volLookback;
  });
  F.startIdx = F.date.findIndex(d => d >= cfg.start);
  let e = -1; for (let i = 0; i < n; i++) if (F.date[i] <= cfg.end) e = i;
  F.endIdx = e;
  return F;
}

export function sma(arr, p) {
  const out = new Array(arr.length).fill(null);
  let s = 0, bad = 0;
  for (let i = 0; i < arr.length; i++) {
    if (!finite(arr[i])) bad++; else s += arr[i];
    if (i >= p) { if (!finite(arr[i - p])) bad--; else s -= arr[i - p]; }
    if (i >= p - 1 && bad === 0) out[i] = s / p;
  }
  return out;
}

// ── day-level helpers ───────────────────────────────────────────────────
export const intradayDrop = (F, i) => (i >= 1 ? pctOf(F.l[i], F.c[i - 1]) : null);
export function isEvent(F, i, thr) {
  if (i < 1 || !finite(F.l[i]) || !finite(F.c[i - 1])) return false;
  return F.l[i] / F.c[i - 1] - 1 <= thr / 100;
}
export function panicClass(vixHigh, fg, cfg = DEFAULTS) {
  const vixP = finite(vixHigh) ? vixHigh >= cfg.vixPanic : null;
  const fgP = finite(fg) ? fg < cfg.fgPanic : null;
  if (vixP === true || fgP === true) return { cls: 'B', vixP, fgP, detail: vixP && fgP ? 'VIX+FG' : vixP ? 'VIX only' : 'FG only' };
  if (vixP === false && fgP === false) return { cls: 'A', vixP, fgP, detail: 'none' };
  return { cls: 'U', vixP, fgP, detail: 'missing' };   // 有缺值且已知部分未成立 → 不歸 A，也不歸 B
}
const isPanicDay = (F, j) => (finite(F.vixH[j]) && F.vixH[j] >= F.cfg.vixPanic) || (finite(F.fg[j]) && F.fg[j] < F.cfg.fgPanic);

function windowStat(arr, from, to, fn) {   // inclusive indices; returns {value, idx, count}
  let best = null, idx = null, count = 0;
  for (let k = from; k <= to; k++) {
    const x = arr[k]; if (!finite(x)) continue;
    count++;
    if (best === null || fn(x, best)) { best = x; idx = k; }
  }
  return { value: best, idx, count };
}
const wMax = (arr, a, b) => windowStat(arr, a, b, (x, y) => x > y);
const wMin = (arr, a, b) => windowStat(arr, a, b, (x, y) => x < y);
function firstIdx(from, to, pred) { for (let k = from; k <= to; k++) if (pred(k)) return k; return null; }

// ── event row ───────────────────────────────────────────────────────────
export function eventRow(F, i, cfg = F.cfg) {
  const P = cfg.preWin, W = cfg.postWin;
  const avail = Math.max(0, Math.min(W, F.endIdx - i));
  const d = F.date, at = k => (k === null ? null : d[k]);
  const pre0 = i - P, pre1 = i - 1, post0 = i + 1, post1 = i + avail;
  const preOk = pre0 >= 0;
  const preHigh = preOk ? wMax(F.h, pre0, pre1) : { value: null, idx: null, count: 0 };
  const pc = panicClass(F.vixH[i], F.fg[i], cfg);
  const r = {
    date: d[i], idx: i,
    prevClose: F.c[i - 1], open: F.o[i], high: F.h[i], low: F.l[i], close: F.c[i], volume: F.v[i],
    dropLow: intradayDrop(F, i),
    hlRange: pctOf(F.l[i], F.h[i]),                    // 當日 High → Low（≤ 0）
    closeChg: pctOf(F.c[i], F.c[i - 1]),               // 前日 Close → 當日 Close
    closeFromLow: pctOf(F.c[i], F.l[i]),               // 盤中低點收回幅度（≥ 0）
    volRatio: finite(F.volAvg[i]) && F.volAvg[i] > 0 && finite(F.v[i]) ? F.v[i] / F.volAvg[i] : null,
    vixHigh: F.vixH[i], vixClose: F.vixC[i], vxnHigh: F.vxnH[i], vxnClose: F.vxnC[i], fg: F.fg[i],
    panic: pc.cls, panicDetail: pc.detail, vixPanic: pc.vixP, fgPanic: pc.fgP,
    vxnAux: finite(F.vxnH[i]) ? F.vxnH[i] >= cfg.vxnAux : null,
    // 事前窗 T-60～T-1
    preHigh: preHigh.value, preHighDate: at(preHigh.idx),
    preHighAgo: preHigh.idx === null ? null : i - preHigh.idx,
    eventDD: pctOf(F.l[i], preHigh.value),             // 事件日波段回撤（≤ 0）
    pre: preOk ? {
      fgMax: wMax(F.fg, pre0, pre1).value, fgMin: wMin(F.fg, pre0, pre1).value, fgCount: wMax(F.fg, pre0, pre1).count,
      vixHMax: wMax(F.vixH, pre0, pre1).value, vixLMin: wMin(F.vixL, pre0, pre1).value,
      vxnHMax: wMax(F.vxnH, pre0, pre1).value, vxnLMin: wMin(F.vxnL, pre0, pre1).value,
    } : null,
    avail, complete: avail >= W,
    ma: {}, h: {},
  };
  r.volSurge = finite(r.volRatio) ? r.volRatio >= cfg.volSurge : null;

  // 均線狀態（事件日收盤 vs MA）＋ 往後首次站回
  for (const p of cfg.mas) {
    const ma = F.ma[p], m = ma[i];
    const o = { value: m, dist: pctOf(F.c[i], m) };
    if (!finite(m)) o.status = 'unavailable';
    else if (F.c[i] >= m) o.status = 'above';
    else {
      const k = firstIdx(post0, post1, j => finite(ma[j]) && F.c[j] > ma[j]);
      const kc = firstIdx(post0, post1, j => finite(ma[j]) && F.c[j] > ma[j] * (1 + cfg.maConfirm));
      o.status = k !== null ? 'reclaimed' : avail >= W ? 'not_within' : 'censored';
      o.reclaimDate = at(k); o.reclaimDays = k === null ? null : k - i;
      o.confirmDate = at(kc); o.confirmDays = kc === null ? null : kc - i;
      o.confirmStatus = kc !== null ? 'confirmed' : avail >= W ? 'not_within' : 'censored';
    }
    if (p === 300 && finite(m)) {
      o.touchedOnEvent = F.l[i] <= m;
      const k = firstIdx(post0, post1, j => finite(ma[j]) && F.l[j] <= ma[j]);
      o.touchDate = at(k); o.touchDays = k === null ? null : k - i;
      o.touchStatus = k !== null ? 'touched' : avail >= W ? 'not_within' : 'censored';
    }
    r.ma[p] = o;
  }

  // 未來窗 T+1～T+h
  const entryOpen = avail >= 1 ? F.o[post0] : null, entryClose = F.c[i];
  r.entryOpen = entryOpen; r.entryOpenDate = avail >= 1 ? d[post0] : null;
  for (const hz of cfg.horizons) {
    if (avail < hz) { r.h[hz] = null; continue; }
    const lo = wMin(F.l, post0, i + hz), hi = wMax(F.h, post0, i + hz);
    const extraRaw = pctOf(lo.value, F.l[i]);
    r.h[hz] = {
      minLow: lo.value, minLowDate: at(lo.idx), minLowDays: lo.idx === null ? null : lo.idx - i,
      rebreak: finite(lo.value) && finite(F.l[i]) ? lo.value < F.l[i] : null,
      extraRaw, extra: finite(extraRaw) ? Math.min(0, extraRaw) : null,
      totalDD: pctOf(lo.value, preHigh.value),
      retOpen: pctOf(F.c[i + hz], entryOpen), retClose: pctOf(F.c[i + hz], entryClose),
      maeOpen: finite(lo.value) ? Math.min(0, pctOf(lo.value, entryOpen)) : null,
      maeClose: finite(lo.value) ? Math.min(0, pctOf(lo.value, entryClose)) : null,
      maxHigh: hi.value, maxHighDate: at(hi.idx),
      mfeOpen: finite(hi.value) ? Math.max(0, pctOf(hi.value, entryOpen)) : null,
    };
  }
  const reb = firstIdx(post0, post1, j => finite(F.l[j]) && F.l[j] < F.l[i]);
  r.firstRebreakDate = at(reb); r.firstRebreakDays = reb === null ? null : reb - i;
  const rec = finite(preHigh.value) ? firstIdx(post0, post1, j => finite(F.h[j]) && F.h[j] >= preHigh.value) : null;
  r.recoverPreHighDate = at(rec); r.recoverPreHighDays = rec === null ? null : rec - i;

  // 恐慌指標的未來窗（觀察到哪就算到哪；complete 旗標另記）
  if (avail >= 1) {
    const fgMax = wMax(F.fg, post0, post1), fgMin = wMin(F.fg, post0, post1);
    const fg15 = firstIdx(post0, post1, j => finite(F.fg[j]) && F.fg[j] < cfg.fgPanic);
    const vix30 = firstIdx(post0, post1, j => finite(F.vixH[j]) && F.vixH[j] >= cfg.vixPanic);
    const anyP = firstIdx(post0, post1, j => isPanicDay(F, j));
    r.post = {
      fgMax: fgMax.value, fgMin: fgMin.value, fgMinDate: at(fgMin.idx), fgCount: fgMax.count,
      vixHMax: wMax(F.vixH, post0, post1).value, vixLMin: wMin(F.vixL, post0, post1).value,
      vxnHMax: wMax(F.vxnH, post0, post1).value, vxnLMin: wMin(F.vxnL, post0, post1).value,
      fgBelow15Date: at(fg15), fgBelow15Days: fg15 === null ? null : fg15 - i,
      vix30Date: at(vix30), vix30Days: vix30 === null ? null : vix30 - i,
      panicDate: at(anyP), panicDays: anyP === null ? null : anyP - i,
    };
  } else r.post = null;
  return r;
}

// ── events / groups ─────────────────────────────────────────────────────
export function rawEvents(F, thr) {
  const out = [];
  for (let i = Math.max(1, F.startIdx); i <= F.endIdx; i++) if (isEvent(F, i, thr)) out.push(i);
  return out;
}
// 錨定法：新群組從第一筆起算 groupWin 個交易日（含當日），之後的事件開新群組。
export function groupEvents(idxs, groupWin = DEFAULTS.groupWin) {
  const groups = [];
  for (const i of idxs) {
    const g = groups.at(-1);
    if (g && i - g.anchor < groupWin) g.members.push(i);
    else groups.push({ anchor: i, members: [i] });
  }
  return groups;
}

export function runThreshold(F, thr) {
  const idxs = rawEvents(F, thr);
  const rows = idxs.map(i => eventRow(F, i));
  const byIdx = new Map(rows.map(r => [r.idx, r]));
  const groups = groupEvents(idxs, F.cfg.groupWin).map((g, k) => {
    const members = g.members.map(i => byIdx.get(i));
    const gid = `${thr}#${String(k + 1).padStart(3, '0')}`;
    members.forEach((m, j) => { m.groupId = gid; m.groupRank = j + 1; m.isRep = j === 0; });
    const rep = members[0];
    return {
      id: gid, threshold: thr, anchorDate: rep.date, lastDate: members.at(-1).date, count: members.length,
      memberDates: members.map(m => m.date), rep,
      anyPanicB: members.some(m => m.panic === 'B'),
      laterPanicInGroup: rep.panic !== 'B' && members.slice(1).some(m => m.panic === 'B'),
      groupMinLow: Math.min(...members.map(m => m.low)),
      deepestDrop: Math.min(...members.map(m => m.dropLow)),
    };
  });
  return { threshold: thr, rows, groups, reps: groups.map(g => g.rep) };
}

// ── stats ───────────────────────────────────────────────────────────────
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function quantile(sortedAsc, p) {   // linear interpolation（numpy 預設）
  const n = sortedAsc.length; if (!n) return null;
  const x = (n - 1) * p, lo = Math.floor(x), hi = Math.ceil(x);
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (x - lo);
}
const sortNum = a => a.filter(finite).sort((x, y) => x - y);
export const median = a => quantile(sortNum(a), 0.5);
const mean = a => { const s = a.filter(finite); return s.length ? s.reduce((x, y) => x + y, 0) / s.length : null; };
const share = a => { const s = a.filter(v => v === true || v === false); return s.length ? s.filter(Boolean).length / s.length : null; };

// 指標定義：kind = 'median'（數值，回中位數）或 'share'（布林，回比例）
export const METRICS = Object.freeze([
  { key: 'rebreak20', label: '20 日內再破事件日低點', kind: 'share', get: r => r.h[20]?.rebreak },
  { key: 'rebreak60', label: '60 日內再破事件日低點', kind: 'share', get: r => r.h[60]?.rebreak },
  { key: 'extra20', label: '20 日相對事件日 Low 額外跌幅 %', kind: 'median', get: r => r.h[20]?.extra },
  { key: 'extra60', label: '60 日相對事件日 Low 額外跌幅 %', kind: 'median', get: r => r.h[60]?.extra },
  { key: 'eventDD', label: '事件日波段回撤 %', kind: 'median', get: r => r.eventDD },
  { key: 'totalDD60', label: '未來 60 日最大總回撤 %（相對事前高點）', kind: 'median', get: r => r.h[60]?.totalDD },
  { key: 'ret5', label: '5 日報酬 %（T+1 開盤進場）', kind: 'median', get: r => r.h[5]?.retOpen },
  { key: 'ret20', label: '20 日報酬 %（T+1 開盤進場）', kind: 'median', get: r => r.h[20]?.retOpen },
  { key: 'ret60', label: '60 日報酬 %（T+1 開盤進場）', kind: 'median', get: r => r.h[60]?.retOpen },
  { key: 'mae20', label: '20 日最大不利 %（T+1 開盤）', kind: 'median', get: r => r.h[20]?.maeOpen },
  { key: 'mae60', label: '60 日最大不利 %（T+1 開盤）', kind: 'median', get: r => r.h[60]?.maeOpen },
  { key: 'panicLater20', label: '20 日內出現極端恐慌（VIX H≥30 或 F&G<15）', kind: 'share', get: r => (r.post && (r.post.panicDays !== null ? r.post.panicDays <= 20 : r.avail >= 20 ? false : null)) },
  { key: 'panicLater60', label: '60 日內出現極端恐慌', kind: 'share', get: r => (r.post && (r.post.panicDays !== null ? true : r.complete ? false : null)) },
  { key: 'reclaim150', label: '低於 150MA 者 60 日內站回', kind: 'share', get: r => (r.ma[150]?.status === 'reclaimed' ? true : r.ma[150]?.status === 'not_within' ? false : null) },
]);
export const metric = key => METRICS.find(m => m.key === key);

// Wilson 95% 區間：比例為 0% 或 100% 時 percentile bootstrap 會退化成單點，另附此區間。
export function wilson(k, n, z = 1.959964) {
  if (!n) return { lo: null, hi: null };
  const p = k / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return { lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}

export function bootstrapCI(values, kind, cfg = DEFAULTS.bootstrap, seedOffset = 0) {
  const vals = kind === 'share' ? values.filter(v => v === true || v === false).map(v => (v ? 1 : 0)) : values.filter(finite);
  const n = vals.length;
  if (n < 2) return { n, lo: null, hi: null };
  const rnd = mulberry32(cfg.seed + seedOffset), est = [], buf = new Array(n);
  for (let b = 0; b < cfg.iters; b++) {
    for (let k = 0; k < n; k++) buf[k] = vals[Math.floor(rnd() * n)];
    est.push(kind === 'share' ? buf.reduce((x, y) => x + y, 0) / n : quantile([...buf].sort((x, y) => x - y), 0.5));
  }
  est.sort((x, y) => x - y);
  return { n, lo: quantile(est, cfg.alpha / 2), hi: quantile(est, 1 - cfg.alpha / 2) };
}
// 兩組差（B − A）的 bootstrap：各組獨立重抽。
export function bootstrapDiff(va, vb, kind, cfg = DEFAULTS.bootstrap, seedOffset = 0) {
  const prep = v => (kind === 'share' ? v.filter(x => x === true || x === false).map(x => (x ? 1 : 0)) : v.filter(finite));
  const a = prep(va), b = prep(vb);
  if (a.length < 2 || b.length < 2) return { lo: null, hi: null, est: null };
  const stat = s => (kind === 'share' ? s.reduce((x, y) => x + y, 0) / s.length : quantile([...s].sort((x, y) => x - y), 0.5));
  const rnd = mulberry32(cfg.seed + 7919 + seedOffset), est = [];
  const draw = s => Array.from({ length: s.length }, () => s[Math.floor(rnd() * s.length)]);
  for (let k = 0; k < cfg.iters; k++) est.push(stat(draw(b)) - stat(draw(a)));
  est.sort((x, y) => x - y);
  return { est: stat(b) - stat(a), lo: quantile(est, cfg.alpha / 2), hi: quantile(est, 1 - cfg.alpha / 2) };
}

export function describe(rows, keys = METRICS.map(m => m.key), { ci = false, cfg = DEFAULTS } = {}) {
  const out = { n: rows.length, m: {} };
  keys.forEach((key, j) => {
    const M = metric(key), vals = rows.map(M.get);
    const valid = M.kind === 'share' ? vals.filter(v => v === true || v === false) : vals.filter(finite);
    const o = { n: valid.length, value: M.kind === 'share' ? share(vals) : median(vals) };
    if (M.kind === 'median') { const s = sortNum(vals); o.mean = mean(vals); o.p10 = quantile(s, 0.1); o.p90 = quantile(s, 0.9); o.min = s[0] ?? null; o.max = s.at(-1) ?? null; }
    else { o.count = valid.filter(Boolean).length; o.wilson = wilson(o.count, valid.length); }
    if (ci) Object.assign(o, { ci: bootstrapCI(vals, M.kind, cfg.bootstrap, j * 101) });
    out.m[key] = o;
  });
  return out;
}

export const AB_KEYS = ['rebreak20', 'rebreak60', 'extra20', 'extra60', 'totalDD60', 'ret20', 'ret60', 'mae20', 'mae60', 'panicLater20', 'panicLater60'];
// B 組事件日當天已是極端恐慌，「之後是否出現極端恐慌」只反映持續性，不與 A 比較。
export const A_ONLY_KEYS = new Set(['panicLater20', 'panicLater60']);
export function compareAB(rows, cfg = DEFAULTS) {
  const A = rows.filter(r => r.panic === 'A'), B = rows.filter(r => r.panic === 'B'), U = rows.filter(r => r.panic === 'U');
  const dA = describe(A, AB_KEYS, { ci: true, cfg }), dB = describe(B, AB_KEYS, { ci: true, cfg });
  const diff = {};
  AB_KEYS.forEach((key, j) => { const M = metric(key); diff[key] = A_ONLY_KEYS.has(key) ? null : bootstrapDiff(A.map(M.get), B.map(M.get), M.kind, cfg.bootstrap, j * 31); });
  const days = A.map(r => r.post?.panicDays).filter(finite);
  // 分母只算「60 日觀察完整，或已觀察到恐慌」的 A 事件；觀察不足者不當成「沒出現」。
  const of = A.filter(r => r.complete || finite(r.post?.panicDays)).length;
  return { A: dA, B: dB, U: U.length, diff, aPanicDays: { n: days.length, of, censored: A.length - of, median: median(days), values: days } };
}

// ── 分層 ────────────────────────────────────────────────────────────────
export const STRATA = Object.freeze([
  { key: 'panic', label: '恐慌分類', fn: r => ({ A: 'A 無極端恐慌', B: 'B VIX≥30 或 F&G<15', U: '缺 F&G（未分類）' })[r.panic] },
  { key: 'panicDetail', label: '恐慌來源', fn: r => r.panicDetail },
  { key: 'vol', label: '爆量（≥1.5× 前 20 日均量）', fn: r => (r.volSurge === null ? '缺量' : r.volSurge ? '爆量' : '未爆量') },
  { key: 'ma150', label: '事件日相對 150MA', fn: r => (r.ma[150]?.status === 'above' ? '在 150MA 上' : r.ma[150]?.status === 'unavailable' ? '無 MA' : '在 150MA 下') },
  { key: 'dd', label: '事件日波段回撤', fn: r => (!finite(r.eventDD) ? '缺' : r.eventDD > -10 ? '淺（> -10%）' : r.eventDD > -20 ? '中（-10～-20%）' : '深（≤ -20%）') },
  { key: 'vxn', label: 'VXN High ≥ 40（輔助）', fn: r => (r.vxnAux === null ? '缺' : r.vxnAux ? 'VXN≥40' : 'VXN<40') },
]);
export function stratify(rows, strat, keys = ['rebreak20', 'rebreak60', 'extra60', 'ret20', 'ret60', 'mae60']) {
  const S = STRATA.find(s => s.key === strat), buckets = new Map();
  for (const r of rows) { const k = S.fn(r); if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(r); }
  return [...buckets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, rs]) => ({ bucket: k, ...describe(rs, keys) }));
}

// ── 區間輪廓（regime profile）：只用區間內與之前的資料 ─────────────────
export function periodProfile(F, from, to, runs) {
  const i0 = F.date.findIndex(d => d >= from);
  let i1 = -1; for (let i = 0; i < F.n; i++) if (F.date[i] <= to && i <= F.endIdx) i1 = i;
  if (i0 < 0 || i1 < i0) return null;
  const idx = []; for (let i = i0; i <= i1; i++) idx.push(i);
  const ma150 = F.ma[150], ma300 = F.ma[300];
  let maxDD = 0, ddDate = null;
  for (const i of idx) {
    const hi = wMax(F.h, Math.max(0, i - 251), i).value, dd = pctOf(F.l[i], hi);
    if (finite(dd) && dd < maxDD) { maxDD = dd; ddDate = F.date[i]; }
  }
  const cnt = fn => idx.filter(fn).length;
  const fgVals = idx.map(i => F.fg[i]).filter(finite);
  const ev = {};
  for (const run of runs) {
    const inR = run.rows.filter(r => r.date >= from && r.date <= to), g = run.groups.filter(x => x.anchorDate >= from && x.anchorDate <= to);
    ev[run.threshold] = {
      raw: inR.length, groups: g.length, A: inR.filter(r => r.panic === 'A').length, B: inR.filter(r => r.panic === 'B').length, U: inR.filter(r => r.panic === 'U').length,
      volSurge: inR.filter(r => r.volSurge).length, aVolSurge: inR.filter(r => r.panic === 'A' && r.volSurge).length,
    };
  }
  return {
    from: F.date[i0], to: F.date[i1], days: idx.length,
    ret: pctOf(F.c[i1], F.c[i0 - 1]), maxDD252: maxDD, maxDDDate: ddDate,
    belowMa150: cnt(i => finite(ma150[i]) && F.c[i] < ma150[i]) / idx.length,
    belowMa300: cnt(i => finite(ma300[i]) && F.c[i] < ma300[i]) / idx.length,
    ma150Slope: pctOf(ma150[i1], ma150[i0]),
    touch300: cnt(i => finite(ma300[i]) && F.l[i] <= ma300[i]),
    vixHMax: wMax(F.vixH, i0, i1).value, vxnHMax: wMax(F.vxnH, i0, i1).value,
    vixPanicDays: cnt(i => finite(F.vixH[i]) && F.vixH[i] >= F.cfg.vixPanic),
    fgMin: fgVals.length ? Math.min(...fgVals) : null, fgMedian: median(fgVals), fgPanicDays: cnt(i => finite(F.fg[i]) && F.fg[i] < F.cfg.fgPanic), fgMissing: idx.length - fgVals.length,
    newLow60: cnt(i => i >= 60 && finite(F.c[i]) && F.c[i] < wMin(F.c, i - 60, i - 1).value),
    events: ev,
  };
}

export function run(raw, cfg = DEFAULTS) {
  const F = buildFrame(raw, cfg);
  const runs = cfg.thresholds.map(t => runThreshold(F, t));
  return { F, runs, byThr: Object.fromEntries(runs.map(r => [r.threshold, r])) };
}
