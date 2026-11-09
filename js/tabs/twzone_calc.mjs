// 台股底部區域：加權＋無觀察類股＋0050 成分股均線廣度（20／50／200 日線）＋台指 VIX 的純計算。
// 訊號定義沿用 noobs_calc.mjs（同一套門檻），這裡只做逐日對齊、同時成立數、區域分段、已實現波動。
import * as N from './noobs_calc.mjs';

const finite = v => typeof v === 'number' && Number.isFinite(v);
export const KEYS = ['obs', 'b20', 'b50', 'b200'];
export const LABELS = { obs: '無觀察類股', b20: '20 日線廣度', b50: '50 日線廣度', b200: '200 日線廣度' };
export const RV_WIN = 20;

/** 以加權交易日為軸：[{date, close, hits:{key:bool|null}, count, v:{key:value}}]。 */
export function align(px, src) {
  const maps = Object.fromEntries(KEYS.map(k => [k, new Map(N.indicator(k, src).map(r => [r.date, r]))]));
  return px.map(p => {
    const hits = {}, v = {};
    let count = 0;
    for (const k of KEYS) {
      const r = maps[k].get(p.date);
      hits[k] = r && finite(r.v) ? r.hit : null;
      v[k] = r && finite(r.v) ? r.v : null;
      if (hits[k]) count += 1;
    }
    return { date: p.date, close: p.close, hits, v, count };
  });
}

/** 連續 count ≥ 1 的日子合成一段：[{from, to, max}]（max＝段內最多同時成立數）。 */
export function zones(days) {
  const out = [];
  let cur = null;
  for (const d of days) {
    if (d.count > 0) {
      if (!cur) { cur = { from: d.date, to: d.date, max: d.count }; out.push(cur); }
      cur.to = d.date; cur.max = Math.max(cur.max, d.count);
    } else cur = null;
  }
  return out;
}

/** 20 日已實現波動（年化 %），對數報酬標準差 × √252 × 100；不足視窗為 null。 */
export function realizedVol(px, win = RV_WIN) {
  const r = px.map((p, i) => (i && px[i - 1].close > 0 ? Math.log(p.close / px[i - 1].close) : null));
  return px.map((p, i) => {
    if (i < win) return { date: p.date, rv: null };
    const w = r.slice(i - win + 1, i + 1);
    const m = w.reduce((a, b) => a + b, 0) / win;
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / (win - 1));
    return { date: p.date, rv: sd * Math.sqrt(252) * 100 };
  });
}
