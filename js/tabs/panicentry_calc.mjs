// 恐慌進場回測的計算引擎（Node 測試與瀏覽器共用，無相依套件）。
// 資料 data/panic_entry.json（scripts/fetch_panic_entry.py）是欄位式日線；prepare() 補上模擬正二、台積電跌幅上限、國安基金旗標。
// 原則：訊號只用當天收盤以前已知的資料；美國波動率指數是「台股當天開盤前已知的最近一個美股收盤」；預設訊號次日開盤進場。
import { NSF_EVENTS } from './marginliq_calc.mjs';

const NSF_INTRADAY = new Set(['2015-08-25']); // 盤中宣布；其餘盤後或時點不明 → 次一交易日才算已知
export function prepare(raw) {
  const D = { ...raw }, n = D.date.length, c = raw.meta?.sim_cost_annual ?? 0.034;
  D.sim_o = new Array(n).fill(null); D.sim_h = new Array(n).fill(null); D.sim_l = new Array(n).fill(null); D.sim_c = new Array(n).fill(null);
  let base = 100;
  for (let i = 0; i < n; i++) {
    const p = i ? D.e50_c[i - 1] : null;
    if (p == null || D.e50_c[i] == null) { D.sim_c[i] = base; D.sim_o[i] = D.sim_h[i] = D.sim_l[i] = base; continue; }
    const f = x => base * (1 + 2 * ((x ?? D.e50_c[i]) / p - 1));
    D.sim_o[i] = f(D.e50_o[i]); D.sim_h[i] = f(D.e50_h[i]); D.sim_l[i] = f(D.e50_l[i]);
    base = base * (1 + 2 * (D.e50_c[i] / p - 1) - c / 252); D.sim_c[i] = base;
  }
  // 個股跌幅上限：2015-06-01 起 10%，之前 7%；2008-10-13～10-24 跌幅減半 3.5%
  D.tsm_lim = D.date.map(d => (d >= '2008-10-13' && d <= '2008-10-24' ? 0.035 : d >= '2015-06-01' ? 0.10 : 0.07));
  D.nsf = new Array(n).fill(0);
  for (const e of NSF_EVENTS) {
    if (e.decide < D.date[0]) continue;
    const i = D.date.findIndex(d => (NSF_INTRADAY.has(e.decide) ? d >= e.decide : d > e.decide));
    if (i >= 0) D.nsf[i] = 1;
  }
  return D;
}

export const HORIZONS = [5, 10, 20, 40, 60, 120, 252];

// ---------- 回撤定義 ----------
// mode: 'c252' 收盤÷近252日最高收盤；'i252' 最低÷近252日盤中最高；'cath' 收盤÷歷史最高收盤；'iath' 最低÷歷史盤中最高
export function drawdown(D, mode = 'i252') {
  const n = D.date.length, out = new Array(n);
  const hiSrc = mode[0] === 'c' ? D.tw_c : D.tw_h, cur = mode[0] === 'c' ? D.tw_c : D.tw_l;
  const win = mode.endsWith('ath') ? Infinity : 252;
  let ath = -Infinity;
  for (let i = 0; i < n; i++) {
    let m;
    if (win === Infinity) { ath = Math.max(ath, hiSrc[i]); m = ath; }
    else { m = -Infinity; for (let j = Math.max(0, i - win + 1); j <= i; j++) if (hiSrc[j] > m) m = hiSrc[j]; }
    out[i] = cur[i] / m - 1;
  }
  return out;
}

// ---------- 波動率序列 ----------
// 鍵：tw=TWVIX 收盤；vix/vxn/vxsmh=美國指數（台股 t 日開盤前已知的最近一個美股收盤）；smhrv=SMH 21 日實現波動率（VXSMH 代理）；
export const VOL_KEYS = { tw: 'vix_c', vix: 'us_vix', vxn: 'us_vxn', vxsmh: 'us_vxsmh', smhrv: 'us_smhrv' };
export function volSeries(D, k) { return D[VOL_KEYS[k]]; }
// 滾動百分位：今天的值高於「之前 N 個有效交易日」中多少比例（不含今天；不足 N 筆為 null）→ 無前視
export function pctRank(arr, N) {
  const out = new Array(arr.length).fill(null), win = [];
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i]; if (v == null) continue;
    if (win.length >= N) { let c = 0; for (let j = win.length - N; j < win.length; j++) if (win[j] < v) c++; out[i] = c / N; }
    win.push(v);
  }
  return out;
}
// 回傳用來比門檻的序列：mode 'abs' → 原值；'p252'|'p504'|'p1260' → 滾動百分位（0–100）
export function volMetric(D, k, mode, cache = {}) {
  const key = 'vm_' + k + '_' + mode;
  if (cache[key]) return cache[key];
  const s = volSeries(D, k);
  return cache[key] = mode === 'abs' ? s : pctRank(s, +mode.slice(1)).map(x => x == null ? null : x * 100);
}
// 恐慌消退訊號：base[i]（完整條件成立）當天「點火」，之後 expire 日內第一個符合消退型態的日子才算訊號。
// type：down1 次日下降｜down2 連兩日下降｜off10 自點火後高點回落 10%｜ma5 加權收盤站回 5 日均線。只用到當天為止的資料。
export function afterPeak(D, base, series, type, expire = 40) {
  const n = base.length, out = new Array(n).fill(false);
  let armed = false, last = -1, armAt = -1, peak = null, p1 = null, p2 = null; // p1,p2：前一、前二個有效值
  for (let i = 0; i < n; i++) {
    const v = series[i];
    if (armed && i - last > expire) armed = false;
    let fire = false;
    if (armed && v != null) {
      if (v > peak) peak = v;
      if (type === 'down1') fire = p1 != null && v < p1;
      else if (type === 'down2') fire = p1 != null && p2 != null && v < p1 && p1 < p2 && armAt <= i - 2;
      else if (type === 'off10') fire = v <= peak * 0.9;
      else if (type === 'ma5') { let m = 0; for (let j = i - 4; j <= i; j++) m += D.tw_c[Math.max(0, j)]; fire = D.tw_c[i] > m / 5; }
    }
    if (fire && i > armAt) { out[i] = true; armed = false; }
    if (base[i]) { if (!armed) { armed = true; armAt = i; peak = v; } last = i; if (v != null && v > peak) peak = v; }
    if (v != null) { p2 = p1; p1 = v; }
  }
  return out;
}
// ---------- 訊號 ----------
// cond: {dd, ddMode, vix, vixMode:'c'|'h', tsm, tsmMode:'ret'|'limit'|'reopen', nsf:true}
// 回傳每日是否符合（缺 TWVIX 的日子在有 vix 條件時一律不符合）
export function signalDays(D, cond, cache = {}) {
  const n = D.date.length, ok = new Array(n).fill(true);
  if (cond.dd != null) {
    const key = 'dd_' + (cond.ddMode || 'i252');
    const dd = cache[key] || (cache[key] = drawdown(D, cond.ddMode || 'i252'));
    for (let i = 0; i < n; i++) if (!(dd[i] <= -cond.dd / 100)) ok[i] = false;
  }
  if (cond.vix != null) {
    const v = cond.vixMode === 'h' ? D.vix_h : D.vix_c;
    for (let i = 0; i < n; i++) if (!(v[i] != null && v[i] >= cond.vix)) ok[i] = false;
  }
  if (cond.tsm != null || cond.tsmMode === 'limit' || cond.tsmMode === 'reopen') {
    for (let i = 0; i < n; i++) {
      let t;
      if (cond.tsmMode === 'limit' || cond.tsmMode === 'reopen') {
        // 觸及跌停：盤中最低相對參考價 ≤ −(當時跌幅上限 − 0.6%)（升降單位進位容差）
        t = D.tsm_low_ret[i] != null && D.tsm_low_ret[i] <= -(D.tsm_lim[i] - 0.006);
        if (t && cond.tsmMode === 'reopen') t = D.tsm_ret[i] > D.tsm_low_ret[i] + 1e-9;
      } else t = D.tsm_ret[i] != null && D.tsm_ret[i] <= -cond.tsm / 100;
      if (!t) ok[i] = false;
    }
  }
  if (cond.nsf) for (let i = 0; i < n; i++) if (!D.nsf[i]) ok[i] = false;
  // vols: [{k, mode, thr}] 全部成立；valid: [{k, mode}] 這些指標當天必須有值（公平比較用的資料可用遮罩）
  for (const v of cond.vols || []) { const m = volMetric(D, v.k, v.mode || 'abs', cache); for (let i = 0; i < n; i++) if (!(m[i] != null && m[i] >= v.thr)) ok[i] = false; }
  for (const v of cond.valid || []) { const m = volMetric(D, v.k, v.mode || 'abs', cache); for (let i = 0; i < n; i++) if (m[i] == null) ok[i] = false; }
  if (cond.from) for (let i = 0; i < n; i++) if (D.date[i] < cond.from) ok[i] = false;
  if (cond.sigType && cond.sigType !== 'first') {
    const pk = cond.sigKey || (cond.vols && cond.vols[0] && cond.vols[0].k) || (cond.vix != null ? 'tw' : null);
    if (pk) return afterPeak(D, ok, volSeries(D, pk), cond.sigType);
  }
  return ok;
}

// 冷卻期分組：事件 = 符合日，且距離上一個事件起始日 ≥ cooldown 個交易日
export function events(ok, cooldown = 60) {
  const ev = []; let last = -Infinity;
  for (let i = 0; i < ok.length; i++) if (ok[i] && i - last >= cooldown) { ev.push(i); last = i; }
  return ev;
}

// ---------- 交易 ----------
const PX = { e50: 'e50', lev: 'lev', sim: 'sim', tw: 'tw' };
// entry: 'close'（訊號日收盤）| 'open'（次日開盤）| 'split'（次日開盤 50%，大盤回撤再多 5 個百分點後次日開盤加 50%）
export function trade(D, i, asset, entry, H, ddArr) {
  const p = PX[asset], O = D[p + '_o'], Hh = D[p + '_h'], L = D[p + '_l'], C = D[p + '_c'], n = D.date.length;
  let e0 = entry === 'close' ? i : i + 1;
  if (e0 >= n) return null;
  const px0 = entry === 'close' ? C[i] : O[e0];
  if (px0 == null || !(px0 > 0)) return null;
  const x = e0 + H - (entry === 'close' ? 0 : 1); // 持有 H 個交易日後收盤出場
  const end = Math.min(x, n - 1), complete = x <= n - 1;
  // 第二批
  let legs = [{ idx: e0, px: px0, w: entry === 'split' ? 0.5 : 1 }];
  if (entry === 'split' && ddArr) {
    for (let j = e0; j < end; j++) if (ddArr[j] <= ddArr[i] - 0.05 && O[j + 1] > 0) { legs.push({ idx: j + 1, px: O[j + 1], w: 0.5 }); break; }
  }
  // 逐日權益（未投入部分為現金）
  let mae = 0, mfe = 0, rec = null, below = false, ret = 0;
  for (let j = e0; j <= end; j++) {
    const val = (px) => legs.reduce((s, g) => s + (j >= g.idx ? g.w * (px / g.px - 1) : 0), 0);
    if (C[j] == null) continue;
    const lo = val(L[j] ?? C[j]), hi = val(Hh[j] ?? C[j]), cl = val(C[j]);
    if (lo < mae) mae = lo; if (hi > mfe) mfe = hi;
    if (cl < 0) below = true;
    if (rec == null && j > e0 && cl >= 0 && below) rec = j - e0;
    ret = cl;
  }
  if (!below) rec = 0;
  return { i, date: D.date[i], entryDate: D.date[e0], entryPx: px0, ret, mae, mfe, rec, complete, legs: legs.length, invested: legs.reduce((s, g) => s + g.w, 0) };
}

// 回本天數（不限持有期）：進場後收盤價回到成本之上所需交易日；一路未跌破為 0；至資料末仍未回本為 null
export function recoverDays(D, i, asset, entry) {
  const p = PX[asset], O = D[p + '_o'], C = D[p + '_c'], n = D.date.length;
  const e0 = entry === 'close' ? i : i + 1; if (e0 >= n) return null;
  const px0 = entry === 'close' ? C[i] : O[e0]; if (!(px0 > 0)) return null;
  let below = false, minC = px0, minIdx = e0;
  for (let j = e0; j < n; j++) {
    if (C[j] == null) continue;
    if (C[j] < px0) below = true;
    if (C[j] < minC) { minC = C[j]; minIdx = j; }
    if (below && C[j] >= px0) return { days: j - e0, maxDD: minC / px0 - 1, toLow: minIdx - e0 };
  }
  return below ? { days: null, maxDD: minC / px0 - 1, toLow: minIdx - e0 } : { days: 0, maxDD: 0, toLow: 0 };
}

// ---------- 統計 ----------
export const q = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), k = (s.length - 1) * p, f = Math.floor(k); return s[f] + (s[Math.min(f + 1, s.length - 1)] - s[f]) * (k - f); };
export const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
export function wilson(k, n, z = 1.96) {
  if (!n) return [null, null];
  const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(c - h) / d, (c + h) / d];
}
export function summarize(tr) {
  const t = tr.filter(x => x && x.complete), r = t.map(x => x.ret), n = r.length;
  if (!n) return { n: 0 };
  const wins = r.filter(x => x > 0).length;
  let streak = 0, maxStreak = 0; for (const x of r) { streak = x <= 0 ? streak + 1 : 0; if (streak > maxStreak) maxStreak = streak; }
  const recs = t.map(x => x.rec).filter(x => x != null);
  const sd = n > 1 ? Math.sqrt(r.reduce((s, x) => s + (x - mean(r)) ** 2, 0) / (n - 1)) : null;
  return {
    n, win: wins / n, ci: wilson(wins, n), mean: mean(r), median: q(r, .5), best: Math.max(...r), worst: Math.min(...r),
    p10: q(r, .1), p25: q(r, .25), p75: q(r, .75), p90: q(r, .9), sd,
    maeMean: mean(t.map(x => x.mae)), maeMed: q(t.map(x => x.mae), .5), maeWorst: Math.min(...t.map(x => x.mae)), maeP90: q(t.map(x => x.mae), .1),
    mfeMean: mean(t.map(x => x.mfe)), mfeMed: q(t.map(x => x.mfe), .5),
    recMed: q(recs, .5), recMax: recs.length ? Math.max(...recs) : null, notRec: t.length - recs.length,
    maxLoseStreak: maxStreak, retPerMae: mean(t.map(x => x.mae)) ? mean(r) / -mean(t.map(x => x.mae)) : null,
  };
}

// 對照組：期間內每一個交易日都進場（非獨立，僅供比較水準）
export function baseline(D, asset, entry, H, from, to) {
  const out = [];
  for (let i = 0; i < D.date.length; i++) if ((!from || D.date[i] >= from) && (!to || D.date[i] <= to)) { const t = trade(D, i, asset, entry, H); if (t && t.complete) out.push(t); }
  return out;
}

// 可重現的亂數（mulberry32）
export function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// 置換檢定：從對照組隨機抽 n 個日子（彼此相隔 ≥ cooldown），平均報酬 ≥ 觀察值的比例
export function permTest(baseTrades, obsMean, n, cooldown, iters = 5000, seed = 7) {
  if (!n || baseTrades.length < n * 2) return null;
  const R = rng(seed); let ge = 0, done = 0;
  for (let k = 0; k < iters; k++) {
    const pick = []; let guard = 0;
    while (pick.length < n && guard++ < 500) { const c = baseTrades[Math.floor(R() * baseTrades.length)]; if (pick.every(p => Math.abs(p.i - c.i) >= cooldown)) pick.push(c); }
    if (pick.length < n) continue;
    done++; if (mean(pick.map(p => p.ret)) >= obsMean) ge++;
  }
  return done ? ge / done : null;
}

export function run(D, cond, { asset = 'lev', entry = 'open', H = 60, cooldown = 60 } = {}, cache = {}) {
  const ok = signalDays(D, cond, cache), ev = events(ok, cooldown);
  const dd = cache['dd_' + (cond.ddMode || 'i252')] || (cache['dd_' + (cond.ddMode || 'i252')] = drawdown(D, cond.ddMode || 'i252'));
  const trades = ev.map(i => trade(D, i, asset, entry, H, dd)).filter(Boolean);
  return { days: ok.filter(Boolean).length, ev, trades, stats: summarize(trades) };
}
