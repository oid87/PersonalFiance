// 市場廣度與流動性預警：純計算（頁面與離線研究共用；不碰 DOM）。
// 時間規則：t 日的廣度、指標、訊號都只用 t 日收盤前（含）的資料；後續走勢從 t+1 日起算；進場一律訊號隔天開盤。
import { drawdown, pctRank, events, q, mean, wilson, rng } from './panicentry_calc.mjs';

export const UNIS = { tw50: '臺灣50', twse: '上市', tpex: '上櫃' };
export const MAS = [5, 10, 20, 60, 120, 200];
export const TARGETS = {
  d5: { label: '再跌 5% 以上', drop: 0.05 }, d10: { label: '再跌 10% 以上', drop: 0.10 }, d15: { label: '再跌 15% 以上', drop: 0.15 },
  dd20: { label: '跌到距高點 −20%', dd: -0.20 },
};

/** 把廣度檔 B 依日期對齊到價格檔 D（D.date 為主），回傳 { tw50:{a20:[…]…}, twse, tpex }。上櫃有效檔數不足 200 的日子視為無資料。 */
export function attach(D, B) {
  const pos = new Map(B.date.map((d, i) => [d, i])), out = {};
  for (const u of Object.keys(UNIS)) {
    out[u] = {};
    const minN = u === 'tw50' ? 30 : 200, nArr = B[u].n;
    for (const f of Object.keys(B[u])) out[u][f] = D.date.map(d => { const i = pos.get(d); return i == null || !(nArr[i] >= minN) ? null : B[u][f][i]; });
  }
  return out;
}

export const delta = (a, N) => a.map((x, i) => (i >= N && x != null && a[i - N] != null ? x - a[i - N] : null));
/** 加速度：最近 N 日變化 −（再之前 N 日變化）。負值＝惡化在加快。 */
export const accel = (a, N) => a.map((x, i) => (i >= 2 * N && x != null && a[i - N] != null && a[i - 2 * N] != null ? (x - a[i - N]) - (a[i - N] - a[i - 2 * N]) : null));

/** 指標序列。kind：level（站上均線比例）、speed（N 日變化）、accel（加速度）、newlow（創 20 日新低占比）、idxret（加權指數 N 日報酬 %，對照用）。 */
export function metric(D, Bx, { kind = 'speed', uni = 'tw50', ma = 60, N = 10 } = {}, cache = {}) {
  const key = [kind, uni, ma, N].join('|');
  if (cache[key]) return cache[key];
  const base = Bx[uni]['a' + ma];
  let s;
  if (kind === 'level') s = base;
  else if (kind === 'speed') s = delta(base, N);
  else if (kind === 'accel') s = accel(base, N);
  else if (kind === 'newlow') s = Bx[uni].nl20.map(x => (x == null ? null : -x));   // 取負號，讓「越小越糟」方向一致
  else if (kind === 'idxret') s = D.tw_c.map((c, i) => (i >= N ? (c / D.tw_c[i - N] - 1) * 100 : null));
  return (cache[key] = s);
}

/** 預警日：指標 ≤ 門檻（abs：level 用比例 %、speed／accel 用 −thr 個百分點；pct：落在過去 win 日的最低 thr%），可加「指數距高點不深於 nearHigh」。 */
export function warnDays(D, Bx, cond, cache = {}) {
  const s = metric(D, Bx, cond, cache), n = D.date.length, ok = new Array(n).fill(false);
  const dd = cache.dd || (cache.dd = drawdown(D, 'i252'));
  let pr = null;
  if (cond.mode === 'pct') { const k = 'pr|' + [cond.kind, cond.uni, cond.ma, cond.N, cond.win || 1260].join('|'); pr = cache[k] || (cache[k] = pctRank(s, cond.win || 1260)); }
  for (let i = 0; i < n; i++) {
    if (s[i] == null) continue;
    let hit;
    if (pr) hit = pr[i] != null && pr[i] <= cond.thr;
    else hit = cond.kind === 'level' ? s[i] <= cond.thr : s[i] <= -cond.thr;
    if (hit && cond.nearHigh != null && dd[i] < -cond.nearHigh) hit = false;
    ok[i] = hit;
  }
  return ok;
}

/** 每天往後 H 個交易日（t+1…t+H）的結果：fwdMin＝最低價相對 t 日收盤；toDD＝期間最深的距高點回撤。 */
export function forward(D, H, cache = {}) {
  const k = 'fw' + H; if (cache[k]) return cache[k];
  const n = D.date.length, dd = cache.dd || (cache.dd = drawdown(D, 'i252'));
  const fwdMin = new Array(n).fill(null), toDD = new Array(n).fill(null), minAt = new Array(n).fill(null);
  for (let i = 0; i + H < n; i++) {
    let m = Infinity, d = Infinity, at = null;
    for (let j = i + 1; j <= i + H; j++) { if (D.tw_l[j] < m) { m = D.tw_l[j]; at = j; } if (dd[j] < d) d = dd[j]; }
    fwdMin[i] = m / D.tw_c[i] - 1; toDD[i] = d; minAt[i] = at;
  }
  return (cache[k] = { fwdMin, toDD, minAt });
}

/** 目標標籤 y[t]：t 日之後 H 日內是否發生（null＝後面資料不足 H 日）。dd20 只在當天還沒跌破 −20% 時才算。 */
export function labels(D, target, H, cache = {}) {
  const T = TARGETS[target], fw = forward(D, H, cache), dd = cache.dd || (cache.dd = drawdown(D, 'i252'));
  return D.date.map((_, i) => (fw.fwdMin[i] == null ? null : T.drop ? fw.fwdMin[i] <= -T.drop : dd[i] > T.dd && fw.toDD[i] <= T.dd));
}

/** 目標事件的「發生日」清單（與訊號無關）：drop＝最低價比前 H 日內最高收盤低 ≥ drop 的第一天；dd＝回撤首次跌破門檻。相隔 40 日內併成同一場。 */
export function episodes(D, target, H, from = 0, to = Infinity, cache = {}) {
  const T = TARGETS[target], n = D.date.length, dd = cache.dd || (cache.dd = drawdown(D, 'i252')), hit = new Array(n).fill(false);
  for (let i = Math.max(from, H); i < Math.min(n, to + 1); i++) {
    if (T.drop) { let m = -Infinity; for (let j = i - H; j < i; j++) if (D.tw_c[j] > m) m = D.tw_c[j]; hit[i] = D.tw_l[i] <= m * (1 - T.drop); }
    else hit[i] = dd[i] <= T.dd;
  }
  const out = []; let last = -Infinity;
  for (let i = 0; i < n; i++) if (hit[i]) { if (i - last > 40) out.push(i); last = i; }
  return out;
}

/** 評估一組預警：事件層級的精確率／召回率／提前天數，日層級的誤報率，以及同期間「任一天」的基準發生率。 */
export function evaluate(D, ok, { target = 'd10', H = 20, cooldown = 20, from = 0, to = Infinity } = {}, cache = {}) {
  const y = labels(D, target, H, cache), fw = forward(D, H, cache), n = D.date.length;
  const inR = i => i >= from && i <= to && y[i] != null;
  const ev = events(ok.map((v, i) => v && i >= from && i <= to), cooldown), done = ev.filter(i => y[i] != null);
  const tp = done.filter(i => y[i]).length;
  let pos = 0, neg = 0, sigNeg = 0, sigDays = 0, days = 0;
  for (let i = 0; i < n; i++) if (inR(i)) { days++; if (y[i]) pos++; else { neg++; if (ok[i]) sigNeg++; } if (ok[i]) sigDays++; }
  const eps = episodes(D, target, H, from, to, cache), leads = []; let caught = 0;
  const epRows = eps.map(e => {
    let first = null;
    for (let j = Math.max(from, e - 40); j < e; j++) if (ok[j]) { first = j; break; }
    if (first != null) { caught++; leads.push(e - first); }
    return { onset: e, first, lead: first == null ? null : e - first };
  });
  // 同樣多的訊號日如果落在隨機位置（整串平移，保留連續性），能「抓到」幾成？
  let chance = null;
  if (eps.length && to > from + 300) {
    const hi = Math.min(to, n - 1), span = hi - from + 1, r = rng(11); let tot = 0; const K = 200;
    for (let k = 0; k < K; k++) { const sh = 60 + Math.floor(r() * (span - 120)); for (const e of eps) { for (let j = Math.max(from, e - 40); j < e; j++) if (ok[from + ((j - from - sh) % span + span) % span]) { tot++; break; } } }
    chance = tot / (K * eps.length);
  }
  const fm = done.map(i => fw.fwdMin[i]);
  return {
    events: ev, n: done.length, pending: ev.length - done.length, tp, precision: done.length ? tp / done.length : null, ci: done.length ? wilson(tp, done.length) : null,
    base: days ? pos / days : null, lift: done.length && pos ? (tp / done.length) / (pos / days) : null,
    fpr: neg ? sigNeg / neg : null, sigShare: days ? sigDays / days : null, perYear: days ? done.length / (days / 245) : null,
    episodes: epRows, nEp: eps.length, recall: eps.length ? caught / eps.length : null, chanceRecall: chance, leadMed: q(leads, .5), leadMean: mean(leads),
    fwdMed: q(fm, .5), fwdP10: q(fm, .1), fwdWorst: fm.length ? Math.min(...fm) : null,
  };
}

/** AUC：指標越低越危險；回傳「隨機挑一個之後出事的日子與一個沒事的日子，出事那天指標較低」的機率（0.5＝沒有辨識力）。 */
export function auc(s, y, keep = () => true) {
  const a = []; let P = 0, Nn = 0;
  for (let i = 0; i < s.length; i++) if (s[i] != null && y[i] != null && keep(i)) { a.push([s[i], y[i]]); y[i] ? P++ : Nn++; }
  if (!P || !Nn) return null;
  a.sort((x, z) => x[0] - z[0]);
  let rs = 0, i = 0;
  while (i < a.length) { let j = i; while (j < a.length && a[j][0] === a[i][0]) j++; const r = (i + j + 1) / 2; for (let k = i; k < j; k++) if (a[k][1]) rs += r; i = j; }
  return 1 - (rs - P * (P + 1) / 2) / (P * Nn);
}

// ── 融資：對齊到價格檔日期 ──
/** M＝[{date, margin_money（億）, margin_lots}]。回傳 { bal, lots, chg1（單日變化 %）, amt1（單日變化 億） }，缺值為 null。
 *  融資餘額當晚才公布：t 日的數字最早只能用在 t+1 日開盤。融資金額是借款餘額（不隨股價變動），減少＝賣出或現金償還，無法區分自願或被迫。 */
export function attachMargin(D, M) {
  const m = new Map(M.map(r => [r.date, r])), bal = D.date.map(d => m.get(d)?.margin_money ?? null), lots = D.date.map(d => m.get(d)?.margin_lots ?? null);
  const chg = (a, i, N) => (i >= N && a[i] != null && a[i - N] != null && a[i - N] > 0 ? (a[i] / a[i - N] - 1) * 100 : null);
  return { bal, lots, chg1: bal.map((_, i) => chg(bal, i, 1)), chg5: bal.map((_, i) => chg(bal, i, 5)), chg10: bal.map((_, i) => chg(bal, i, 10)),
    amt1: bal.map((x, i) => (i && x != null && bal[i - 1] != null ? x - bal[i - 1] : null)), lots1: lots.map((_, i) => chg(lots, i, 1)) };
}
/** 滾動百分位（只用當天以前 win 日；值越大百分位越高）。 */
export function rollPct(a, win = 1260, minN = 250) {
  return a.map((x, i) => { if (x == null) return null; let n = 0, le = 0; for (let j = Math.max(0, i - win + 1); j <= i; j++) if (a[j] != null) { n++; if (a[j] <= x) le++; } return n >= minN ? le / n : null; });
}
const rsum = (a, N) => a.map((_, i) => { if (i < N - 1) return null; let s = 0; for (let j = i - N + 1; j <= i; j++) { if (a[j] == null) return null; s += a[j]; } return s; });
/** 等權流動性壓力分數（0–1）：五個分項各取過去 1260 日百分位後直接平均，不估權重。
 *  分項：近 5 日曾跌停占比、低量跌停 3 日累計、融資 5 日減幅、臺灣50 站上 60 日線比例 10 日降幅、下跌成交值占比 5 日均。 */
export function stressScore(Bx, MGx, cache = {}) {
  if (cache.stress) return cache.stress;
  const t = Bx.twse, neg = a => a.map(x => (x == null ? null : -x));
  const parts = { ld5u: t.ld5u, ldq3: rsum(t.ldq, 3), mg5: neg(MGx.chg5), db10: neg(delta(Bx.tw50.a60, 10)), dnv5: rsum(t.dnv, 5) };
  const pr = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, rollPct(v)]));
  const keys = Object.keys(pr), score = t.ld.map((_, i) => { let s = 0; for (const k of keys) { if (pr[k][i] == null) return null; s += pr[k][i]; } return s / keys.length; });
  return (cache.stress = { score, pr, parts });
}

// ── 00631L：回撤事件後等「修復」再買 ──
const PX = { lev: 'lev', sim: 'sim', e50: 'e50' };
export const REPAIRS = {
  A: '直接買',
  B: '廣度回升 1 日', C: '廣度連 2 日回升', D: '廣度 5 日回升 ≥ 10 點',
  L1: '跌停占比連 2 日下降', L2: '跌停占比比高峰少一半', L3: '跌停占比回到 2% 以下',
  G1: '融資單日減幅縮到高峰的一半', G2: '融資連 2 日沒有大減（單日減 < 0.5%）', G3: '融資張數回升',
  X1: '跌停降溫（L2）＋廣度回升（B）', X2: '融資放緩（G2）＋廣度回升（B）', X3: '跌停降溫（L2）＋融資放緩（G2）',
  FB: '先買一半，廣度回升（B）再買一半', FL: '先買一半，跌停降溫（L2）再買一半', FG: '先買一半，融資放緩（G2）再買一半',
  T: '0050 站回 150 日線',
};
export const REPAIR_GROUPS = { direct: ['A'], breadth: ['B', 'C', 'D'], limit: ['L1', 'L2', 'L3'], margin: ['G1', 'G2', 'G3'], combo: ['X1', 'X2', 'X3'], split: ['FB', 'FL', 'FG'], trend: ['T'] };
const HALF = { FB: 'B', FL: 'L2', FG: 'G2' }, COMBO = { X1: ['L2', 'B'], X2: ['G2', 'B'], X3: ['L2', 'G2'] };
/** 事件日 i 之後第一個符合修復條件的日子（條件只用當天收盤／當晚已知的資料；找不到回 null）。
 *  ctx＝{ a（站上 20 日線比例）, ld（跌停占比 %）, chg1（融資單日變化 %）, lots（融資張數） }。
 *  「降溫」類規則若事件前 10 日到當天根本沒有跌停潮（高峰 < 1%）或融資沒有明顯減少（高峰 < 0.5%），視為當天就成立。 */
export function confirmDay(D, ctx, i, rule, win = 60, cache = {}) {
  if (Array.isArray(ctx)) ctx = { a: ctx };
  const n = D.date.length, { a, ld, chg1, lots } = ctx;
  if (rule === 'A') return i;
  if (COMBO[rule]) { const x = confirmDay(D, ctx, i, COMBO[rule][0], win, cache), y = confirmDay(D, ctx, i, COMBO[rule][1], win, cache); return x == null || y == null ? null : Math.max(x, y); }
  if (rule === 'T') {
    const ma = cache.ma150 || (cache.ma150 = D.e50_c.map((_, k) => { if (k < 149) return null; let s = 0; for (let j = k - 149; j <= k; j++) s += D.e50_c[j]; return s / 150; }));
    for (let j = i + 1; j <= Math.min(n - 1, i + 252); j++) if (ma[j] != null && D.e50_c[j] > ma[j]) return j;
    return null;
  }
  const end = Math.min(n - 1, i + win);
  if (rule === 'L1' || rule === 'L2' || rule === 'L3') {
    if (!ld) return null;
    let peak = 0; for (let j = Math.max(0, i - 10); j <= i; j++) if (ld[j] != null && ld[j] > peak) peak = ld[j];
    if (rule === 'L3' ? ld[i] != null && ld[i] < 2 : peak < 1) return i;
    for (let j = i + 1; j <= end; j++) {
      if (ld[j] == null) continue;
      if (ld[j] > peak) peak = ld[j];
      if (rule === 'L1' && j - 2 >= i && ld[j - 1] != null && ld[j - 2] != null && ld[j] < ld[j - 1] && ld[j - 1] < ld[j - 2]) return j;
      if (rule === 'L2' && ld[j] <= peak / 2) return j;
      if (rule === 'L3' && ld[j] < 2) return j;
    }
    return null;
  }
  if (rule === 'G1' || rule === 'G2') {
    if (!chg1) return null;
    let peak = 0; for (let j = Math.max(0, i - 10); j <= i; j++) if (chg1[j] != null && -chg1[j] > peak) peak = -chg1[j];
    if (peak < 0.5) return i;
    for (let j = i + 1; j <= end; j++) {
      if (chg1[j] == null) continue;
      if (-chg1[j] > peak) peak = -chg1[j];
      if (rule === 'G1' && -chg1[j] <= peak / 2) return j;
      if (rule === 'G2' && j - 1 >= i && chg1[j - 1] != null && chg1[j] > -0.5 && chg1[j - 1] > -0.5) return j;
    }
    return null;
  }
  if (rule === 'G3') { if (!lots) return null; for (let j = i + 1; j <= end; j++) if (lots[j] != null && lots[j - 1] != null && lots[j] > lots[j - 1]) return j; return null; }
  for (let j = i + (rule === 'E' ? 0 : 1); j <= end; j++) {
    if (a[j] == null) continue;
    if (rule === 'B' && a[j - 1] != null && a[j] > a[j - 1]) return j;
    if (rule === 'C' && a[j - 1] != null && a[j - 2] != null && a[j] > a[j - 1] && a[j - 1] > a[j - 2] && j - 2 >= i) return j;
    if (rule === 'D' && a[j - 5] != null && a[j] - a[j - 5] >= 10 && j - 5 >= i - 4) return j;
    if (rule === 'E' && a[j] >= 30) return j;
  }
  return null;
}
/** 多批進場的損益：legs=[{day（訊號日，隔天開盤買）, w}]；未投入部分為現金（報酬 0）。
 *  預設持有期從第一批進場日起算 H 日；給 anchor（事件日）時改成「事件隔天起固定 H 日」，等待期間算現金，沒進場＝整段現金。 */
export function tradeLegs(D, legs, H, asset = 'lev', anchor = null) {
  const p = PX[asset], O = D[p + '_o'], Hi = D[p + '_h'], L = D[p + '_l'], C = D[p + '_c'], n = D.date.length;
  const g = legs.filter(x => x.day != null && x.day + 1 < n && O[x.day + 1] > 0).map(x => ({ idx: x.day + 1, px: O[x.day + 1], w: x.w }));
  if (!g.length && anchor == null) return null;
  const e0 = anchor != null ? anchor + 1 : Math.min(...g.map(x => x.idx)), x = e0 + H - 1, end = Math.min(x, n - 1);
  let mae = 0, mfe = 0, ret = 0, rec = null, below = false;
  for (let j = e0; j <= end; j++) {
    if (C[j] == null) continue;
    const val = px => g.reduce((s, k) => s + (j >= k.idx ? k.w * (px / k.px - 1) : 0), 0);
    const lo = val(L[j] ?? C[j]), hi = val(Hi[j] ?? C[j]), cl = val(C[j]);
    if (lo < mae) mae = lo;
    if (hi > mfe) mfe = hi;
    if (cl < 0) below = true;
    if (rec == null && j > e0 && cl >= 0 && below) rec = j - e0;
    ret = cl;
  }
  if (!below) rec = 0;
  return { entryDate: g.length ? D.date[Math.min(...g.map(k => k.idx))] : null, entryPx: g.length ? g[0].px : null, ret, mae, mfe, rec, complete: x <= n - 1, invested: g.reduce((s, k) => s + (k.idx <= end ? k.w : 0), 0) };
}
/** 同一批回撤事件，各修復規則的結果（配對比較）。t＝進場後持有 H 日；cap＝事件隔天起固定 H 日、含等待期與沒進場的現金。
 *  missed＝修復進場價相對「直接買」進場價（正＝買貴了）。 */
export function repairCompare(D, Bx, { ddThr = -0.20, uni = 'tw50', H = 120, asset = 'lev', cooldown = 60, from = 0, win = 60, MGx = null, rules = Object.keys(REPAIRS) } = {}, cache = {}) {
  const dd = cache.dd || (cache.dd = drawdown(D, 'i252')), a = Bx[uni].a20, p = PX[asset], O = D[p + '_o'];
  const ctx = { a, ld: Bx.twse.ld, chg1: MGx?.chg1, lots: MGx?.lots };
  const ev = events(dd.map((x, i) => x <= ddThr && i >= from && D[p + '_c'][i] != null && a[i] != null), cooldown);
  const rows = {};
  for (const rule of rules) {
    rows[rule] = ev.map(i => {
      const half = HALF[rule], c = confirmDay(D, ctx, i, half || rule, win, cache);
      const legs = half ? [{ day: i, w: 0.5 }, { day: c, w: 0.5 }] : [{ day: c, w: 1 }];
      const t = c == null && !half ? null : tradeLegs(D, legs, H, asset);
      const cap = tradeLegs(D, legs, H, asset, i);
      const direct = i + 1 < D.date.length ? O[i + 1] : null;
      return { i, date: D.date[i], confirm: c, wait: c == null ? null : c - i, t, cap, missed: t && direct && !half ? t.entryPx / direct - 1 : null };
    });
  }
  return { ev, rows };
}
export function repairSummary(list) {
  const done = list.filter(r => r.t && r.t.complete), r = done.map(x => x.t.ret), m = done.map(x => x.t.mae), wins = r.filter(x => x > 0).length;
  const recs = done.map(x => x.t.rec).filter(x => x != null);
  const cd = list.filter(x => x.cap && x.cap.complete), cr = cd.map(x => x.cap.ret), cm = cd.map(x => x.cap.mae);
  return {
    nEv: list.length, noConfirm: list.filter(x => x.confirm == null).length, pending: list.filter(x => x.t && !x.t.complete).length, n: done.length,
    win: done.length ? wins / done.length : null, mean: mean(r), median: q(r, .5), worst: r.length ? Math.min(...r) : null,
    maeMed: q(m, .5), maeP90: q(m, .1), maeWorst: m.length ? Math.min(...m) : null, mfeMed: q(done.map(x => x.t.mfe), .5), recMed: q(recs, .5),
    waitMed: q(list.map(x => x.wait).filter(x => x != null), .5), missedMed: q(done.map(x => x.missed).filter(x => x != null), .5),
    capN: cd.length, capWin: cd.length ? cr.filter(x => x > 0).length / cd.length : null, capMean: mean(cr), capMedian: q(cr, .5), capWorst: cr.length ? Math.min(...cr) : null,
    capMaeMed: q(cm, .5), capMaeP90: q(cm, .1), capMaeWorst: cm.length ? Math.min(...cm) : null,
  };
}
