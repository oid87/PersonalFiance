// 右側：帶量突破 — 純函式引擎（無 DOM、無 fetch）。極端狀態儀表板的右側區塊與回測共用。
// 規則原文：價格突破整理區間（箱子，3 個月到 10 年）時，量能 ≥ 2 倍區間均量要關注，3／5／10 倍要密切關注。
// 本專案定義：箱子＝收盤創 N 個交易日新高（不含當天）；同一天同時突破多個箱子時取最長的那個。
// 量能基準＝前 volDays（63）個交易日的平均成交量（不含當天），所有箱子共用：長箱子（例如 10 年）的區間均量會被
// 成交量的長期趨勢扭曲（QQQ 量在 2008 年前後最大、VOO 逐年成長），用同一段近 3 個月均量才可跨年代比較。只用當天以前的資料。
const finite = v => typeof v === 'number' && Number.isFinite(v);

export const BREAKOUT = Object.freeze({
  // [交易日數, 標籤]：3 個月＝63、半年＝126、1 年＝252、2 年＝504、5 年＝1260、10 年＝2520（約 21 日／月，本專案定義）
  boxes: [[63, '3 個月'], [126, '半年'], [252, '1 年'], [504, '2 年'], [1260, '5 年'], [2520, '10 年']],
  // 量能倍數分級（規則原文）：≥2 關注；≥3／5／10 密切關注
  tiers: [[10, '10 倍'], [5, '5 倍'], [3, '3 倍'], [2, '2 倍']],
  watch: 2,           // ≥ 2 倍＝關注
  close: 3,           // ≥ 3 倍＝密切關注
  volDays: 63,        // 量能基準：前 63 個交易日（約 3 個月）均量（本專案定義，理由見檔頭）
  volCover: 0.8,      // 區間內至少 80% 的日子有成交量，均量才算數（本專案定義）
  recentDays: 20,     // 「近期突破」：近 20 個交易日內（本專案定義）
});

/** rows [{date, close, volume}] → 依日期排序、去重的 { dates, close, volume }（volume 0 或缺＝null）。 */
export function buildBars(rows = []) {
  const pts = rows.filter(r => r && typeof r.date === 'string' && finite(r.close))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .filter((r, i, a) => i === 0 || r.date !== a[i - 1].date);
  return { dates: pts.map(r => r.date), close: pts.map(r => r.close), volume: pts.map(r => (finite(r.volume) && r.volume > 0 ? r.volume : null)) };
}

/** 價格用 priceRows、成交量用 volumeRows（同日期對齊；例如費半價格 ^SOX、量 SOXX）。 */
export function withVolumeFrom(priceRows = [], volumeRows = []) {
  const vol = new Map(volumeRows.filter(r => r && finite(r.volume)).map(r => [r.date, r.volume]));
  return priceRows.map(r => ({ ...r, volume: vol.get(r.date) ?? null }));
}

export const tierOf = ratio => (finite(ratio) ? BREAKOUT.tiers.findIndex(([k]) => ratio >= k) : -1);
export const tierLabel = ratio => { const k = tierOf(ratio); return k < 0 ? '' : BREAKOUT.tiers[k][1]; };

/** 每天的突破：最長的箱子（收盤 > 前 N 日最高收盤），以及當天量 ÷ 前 63 日均量。沒有突破＝null。快取在 bars 上。 */
export function breakoutDaily(bars) {
  if (bars._bo) return bars._bo;
  const n = bars.dates.length, out = new Array(n).fill(null);
  // 前綴和：區間均量與有量天數
  const vs = new Float64Array(n + 1), vc = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) { vs[i + 1] = vs[i] + (bars.volume[i] ?? 0); vc[i + 1] = vc[i] + (bars.volume[i] != null ? 1 : 0); }
  // 前 N 日最高收盤：用稀疏表做區間最大值查詢
  const LOG = Math.max(1, Math.ceil(Math.log2(n + 1))), sp = [Float64Array.from(bars.close)];
  for (let k = 1; k < LOG; k++) { const prev = sp[k - 1], cur = new Float64Array(n), h = 1 << (k - 1); for (let i = 0; i + (1 << k) <= n; i++) cur[i] = Math.max(prev[i], prev[i + h]); sp.push(cur); }
  const maxOf = (a, b) => { const k = 31 - Math.clz32(b - a); return Math.max(sp[k][a], sp[k][b - (1 << k)]); };   // [a, b)
  for (let i = 1; i < n; i++) {
    let best = null;
    for (const [len, label] of BREAKOUT.boxes) {
      if (i < len) break;
      if (bars.close[i] > maxOf(i - len, i)) best = { len, label };
      else break;   // 箱子由短到長：短的沒突破，長的也不會
    }
    if (!best) continue;
    const w = Math.min(BREAKOUT.volDays, i), cnt = vc[i] - vc[i - w], avg = cnt ? (vs[i] - vs[i - w]) / cnt : null;
    const ok = cnt >= w * BREAKOUT.volCover && finite(avg) && avg > 0 && bars.volume[i] != null;
    out[i] = { date: bars.dates[i], close: bars.close[i], box: best.len, boxLabel: best.label, ratio: ok ? bars.volume[i] / avg : null };
  }
  return (bars._bo = out);
}

/** 第一個 ≥ d 的索引之前（含 d）最後一筆。 */
function indexLE(dates, d) { let lo = 0, hi = dates.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (dates[m] <= d) { r = m; lo = m + 1; } else hi = m - 1; } return r; }

/** 評估日 d：近 recentDays 個交易日內最強的一次突破（量能倍數最高；同倍數取較新）＋今天是否突破。 */
export function breakoutNow(bars, d, recentDays = BREAKOUT.recentDays) {
  const i = indexLE(bars.dates, d);
  if (i < 0) return null;
  const bo = breakoutDaily(bars);
  let best = null;
  for (let j = Math.max(0, i - recentDays + 1); j <= i; j++) {
    const e = bo[j];
    if (e && (!best || (e.ratio ?? -1) >= (best.ratio ?? -1))) best = e;
  }
  let hi = -Infinity;
  for (let j = Math.max(0, i - BREAKOUT.boxes[0][0]); j < i; j++) hi = Math.max(hi, bars.close[j]);
  return { date: bars.dates[i], today: bo[i], recent: best, tier: tierOf(best?.ratio), toHigh3m: finite(hi) ? bars.close[i] / hi - 1 : null };
}

/** 帶量突破事件（ratio ≥ minRatio），連續 gap 個交易日內的併成一次（取第一天），附之後 h 日報酬。回測用。 */
export function breakoutEvents(bars, { minRatio = BREAKOUT.watch, minBox = BREAKOUT.boxes[0][0], from = '0000', gap = 20, horizons = [20, 60, 120] } = {}) {
  const bo = breakoutDaily(bars), out = [];
  let last = -Infinity;
  bo.forEach((e, i) => {
    if (!e || e.date < from || e.box < minBox || !(e.ratio >= minRatio)) return;
    if (i - last <= gap) { last = i; return; }
    last = i;
    out.push({ ...e, fwd: Object.fromEntries(horizons.map(h => [h, i + h < bars.close.length ? bars.close[i + h] / bars.close[i] - 1 : null])) });
  });
  return out;
}
