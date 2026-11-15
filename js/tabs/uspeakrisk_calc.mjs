// 美股高檔風險研究頁的純函式（無 DOM）。研究數字只搬運、不重算模型；
// 價格探索器只做描述性計算（均線、距 252 日高點回撤、標準化、相對強弱），不產生任何訊號或績效。

export const CATS = ['sox_first', 'sync', 'target_first', 'no_follow'];
export const CAT_LABEL = { sox_first: 'SOX 先轉弱', sync: '同步轉弱', target_first: '目標指數先轉弱', no_follow: '目標沒有跟跌' };
export const TARGET_LABEL = { ndx: 'Nasdaq-100', spx: 'S&P 500' };

export const median = xs => {
  const a = xs.filter(Number.isFinite).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

export function catCounts(events, t) {
  const out = { total: 0 };
  for (const c of CATS) out[c] = 0;
  for (const e of events) if (e.t === t && e.c in out) { out[e.c]++; out.total++; }
  return out;
}

/** 領先天數：lag = 目標在 ±40 日內最早一次跌破 50MA 相對 SOX 的交易日（負＝目標先）。 */
export function lagStats(events, t) {
  const all = events.filter(e => e.t === t && Number.isFinite(e.lag)).map(e => e.lag);
  const soxFirst = events.filter(e => e.t === t && e.c === 'sox_first' && Number.isFinite(e.lag)).map(e => e.lag);
  return { all, soxFirst, medianAll: median(all), medianSoxFirst: median(soxFirst) };
}

export function histogram(values, lo = -40, hi = 40, width = 5) {
  const bins = [];
  for (let a = lo; a < hi; a += width) bins.push({ from: a, to: a + width - 1, n: 0 });
  bins[bins.length - 1].to = hi;
  for (const v of values) {
    if (!Number.isFinite(v) || v < lo || v > hi) continue;
    const i = Math.min(bins.length - 1, Math.floor((v - lo) / width));
    bins[i].n++;
  }
  return bins;
}

export function filterEvents(events, { t, from = null, to = null, cat = 'all', dd10 = 'all' } = {}) {
  return events.filter(e => (!t || e.t === t) &&
    (from == null || e.d.slice(0, 4) >= String(from)) && (to == null || e.d.slice(0, 4) <= String(to)) &&
    (cat === 'all' || e.c === cat) &&
    (dd10 === 'all' || (dd10 === 'yes' ? e.dd10 === true : dd10 === 'no' ? e.dd10 === false : e.dd10 == null)));
}

// ── 價格探索器（使用網站既有公開資料檔，僅描述性計算）──────────────────
export function closes(json) {
  const rows = Array.isArray(json?.data) ? json.data : [];
  return rows.filter(r => r && typeof r.date === 'string' && Number.isFinite(r.close)).map(r => [r.date, r.close]);
}

export function sma(series, n) {
  const out = new Array(series.length).fill(null); let s = 0;
  for (let i = 0; i < series.length; i++) {
    s += series[i][1];
    if (i >= n) s -= series[i - n][1];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

/** 距 t 日已知 252 日最高收盤的回撤（與研究的高檔定義同口徑）；不足 252 日 → null。 */
export function drawdown252(series) {
  const out = new Array(series.length).fill(null); const dq = [];
  for (let i = 0; i < series.length; i++) {
    while (dq.length && series[dq.at(-1)][1] <= series[i][1]) dq.pop();
    dq.push(i);
    if (dq[0] <= i - 252) dq.shift();
    if (i >= 251) out[i] = series[i][1] / series[dq[0]][1] - 1;
  }
  return out;
}

export function sliceRange(series, from, to) {
  return series.map((r, i) => [r, i]).filter(([r]) => r[0] >= from && r[0] <= to).map(([, i]) => i);
}

/** a/b 收盤比，對齊共同日期，期初 = 1。 */
export function relStrength(a, b, from, to) {
  const mb = new Map(b.map(r => [r[0], r[1]]));
  const pts = a.filter(r => r[0] >= from && r[0] <= to && mb.has(r[0])).map(r => [r[0], r[1] / mb.get(r[0])]);
  if (!pts.length) return [];
  const base = pts[0][1];
  return pts.map(([d, v]) => [d, v / base]);
}

// ── 模型比較 ──────────────────────────────────────────────────────────
export const HORIZONS = [
  { id: 'h10k10', h: 10, k: 0.1, label: '10 日內 −10%' },
  { id: 'h20k10', h: 20, k: 0.1, label: '20 日內 −10%' },
  { id: 'h40k10', h: 40, k: 0.1, label: '40 日內 −10%' },
  { id: 'h60k20', h: 60, k: 0.2, label: '60 日內 −20%' },
  { id: 'h120k20', h: 120, k: 0.2, label: '120 日內 −20%' },
  { id: 'h252k20', h: 252, k: 0.2, label: '252 日內 −20%' },
];

export function findModel(models, { t, x, h, k }) {
  return models.find(m => m.t === t && m.x === x && m.h === h && Math.abs(m.k - k) < 1e-9) || null;
}

/** 森林圖列：每個（目標×加入指標）一列；CI 只取危機區塊（EA）版，危機群 <5 不估計 → null。 */
export function forestRows(models, hz) {
  const out = [];
  for (const t of ['ndx', 'spx']) for (const x of ['sox', 'rsp']) {
    const m = findModel(models, { t, x, h: hz.h, k: hz.k });
    out.push({ t, x, label: `${TARGET_LABEL[t]}＋${x === 'sox' ? 'SOX' : 'RSP/SPY'}`, m,
      d: m && Number.isFinite(m.dauc) ? m.dauc : null, ci: m?.ci_crisis || null });
  }
  return out;
}

export const ciCrossesZero = ci => Array.isArray(ci) && ci[0] <= 0 && ci[1] >= 0;

// ── 分享狀態（hash 參數）────────────────────────────────────────────────
const STATE_KEYS = { t: ['ndx', 'spx'], hz: HORIZONS.map(h => h.id), pair: ['sox-ndx', 'sox-spx', 'ndx-spx', 'rsp-spy'], mode: ['norm', 'dd'] };
export function parseState(hash) {
  const p = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const s = {};
  for (const [k, ok] of Object.entries(STATE_KEYS)) if (ok.includes(p.get(k))) s[k] = p.get(k);
  if (/^[a-z0-9-]{1,20}$/.test(p.get('ev') || '')) s.ev = p.get('ev');
  return s;
}
export function stateHash(state) {
  const p = new URLSearchParams({ tab: 'uspeakrisk' });
  for (const k of ['t', 'hz', 'ev', 'pair', 'mode']) if (state[k]) p.set(k, state[k]);
  return '#' + p.toString();
}
