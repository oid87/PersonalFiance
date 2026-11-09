// 無觀察類股回測（指數＋無觀察類股／均線廣度，近 10 年）的純計算。
// 無觀察類股規則沿用過往觀察（nonnormalhist_calc.mjs）；均線廣度＝臺灣50 成分股站上 20／50／100／200 日線占比（data/tw50_ma_breadth.json）。
// 這裡只加：訊號的統一介面、任意一天進場的基準、跌深版（訊號日距一年高點 ≤ DEEP）、和基準比較的結論。
import * as H from './nonnormalhist_calc.mjs';
import { NO_OBS } from './nonnormal_calc.mjs';

const finite = v => typeof v === 'number' && Number.isFinite(v);
export const YEARS = 10;
export const DEEP = -0.10;
export const HORIZONS = H.HORIZONS;

export const PRICES = Object.freeze({
  tw: { label: '加權', file: 'TWII' },
  tw50: { label: '0050', file: '0050.TW' },
});

// src: obs＝dailyRows()（無觀察類股），br＝tw50_ma_breadth 列；dir/th＝成立條件
export const SIGNALS = Object.freeze({
  obs: { label: '無觀察類股（全市場）', short: '無觀察・全市場', src: 'obs', field: 'noObs', dir: '≥', th: NO_OBS.start, unit: '天', ind: '近 22 日無觀察天數' },
  obs50: { label: '無觀察類股（0050 成分股）', short: '無觀察・0050', src: 'obs', field: 'tw50', dir: '≤', th: H.TW50_LOW, unit: '次', ind: '0050 成分股近 22 日觀察股次數' },
  b20: { label: '站上 20 日線 ≤ 10%', short: '廣度 20MA', src: 'br', field: 'p20', dir: '≤', th: 10, unit: '%', ind: '0050 成分股站上 20 日線 %' },
  b50: { label: '站上 50 日線 ≤ 15%', short: '廣度 50MA', src: 'br', field: 'p50', dir: '≤', th: 15, unit: '%', ind: '0050 成分股站上 50 日線 %' },
  b100: { label: '站上 100 日線 ≤ 20%', short: '廣度 100MA', src: 'br', field: 'p100', dir: '≤', th: 20, unit: '%', ind: '0050 成分股站上 100 日線 %' },
  b200: { label: '站上 200 日線 ≤ 30%', short: '廣度 200MA', src: 'br', field: 'p200', dir: '≤', th: 30, unit: '%', ind: '0050 成分股站上 200 日線 %' },
});

/** 起算日：資料最後一天往前 YEARS 年。 */
export function startDate(last, years = YEARS) {
  const d = new Date(last + 'T00:00:00Z');
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

/** 指標序列 [{date, v, hit}]；src＝{obs: dailyRows(), br: 廣度列}。 */
export function indicator(key, src) {
  const s = SIGNALS[key];
  if (!s) throw new Error('unknown signal ' + key);
  return (src[s.src] || []).map(r => {
    const v = r[s.field];
    return { date: r.date, v: finite(v) ? v : null, hit: finite(v) && (s.dir === '≥' ? v >= s.th : v <= s.th) };
  });
}

/** 歷次訊號（同 nonnormalhist：成立第一天進場，消失滿 20 日才算新的一次），只留 from 之後開始的。 */
export function episodesFor(key, src, px, from) {
  const ind = indicator(key, src);
  const list = H.scan(ind, r => r.hit, () => ({ peak: null }), (cur, r) => {
    if (!finite(r.v)) return;
    const s = SIGNALS[key];
    cur.peak = cur.peak == null ? r.v : s.dir === '≥' ? Math.max(cur.peak, r.v) : Math.min(cur.peak, r.v);
  });
  return H.withReturns(list, px).filter(e => !from || e.date >= from);
}

const median = xs => {
  const s = xs.filter(finite).sort((a, b) => a - b);
  if (!s.length) return null;
  const k = s.length >> 1;
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
};
const stat = xs => (xs.length ? { n: xs.length, median: median(xs), mean: xs.reduce((a, b) => a + b, 0) / xs.length, up: xs.filter(x => x > 0).length / xs.length, worst: Math.min(...xs) } : { n: 0, median: null, mean: null, up: null, worst: null });

/** 任意一天（from 起）買進、持有 h 個交易日的報酬分布。 */
export function baseline(px, from) {
  return Object.fromEntries(HORIZONS.map(h => {
    const xs = [];
    for (let i = 0; i + h < px.length; i++) if (!from || px[i].date >= from) xs.push(px[i + h].close / px[i].close - 1);
    return [h, stat(xs)];
  }));
}

/** 一組訊號的報酬分布。 */
export function summary(list) {
  return Object.fromEntries(HORIZONS.map(h => [h, stat(list.map(e => e.ret[h]).filter(finite))]));
}

/** 訊號 vs 基準：60 與 120 日中位數都贏基準 1 個百分點以上＝較好；都輸＝較差；其餘＝差不多。樣本 < 5 標註樣本少。 */
export function verdict(sig, base) {
  const diffs = [60, 120].map(h => (finite(sig[h].median) && finite(base[h].median) ? sig[h].median - base[h].median : null));
  const n = sig[60].n;
  const level = diffs.some(d => d == null) ? 'na' : diffs.every(d => d > 0.01) ? 'better' : diffs.every(d => d < -0.01) ? 'worse' : 'same';
  return { level, diff60: diffs[0], diff120: diffs[1], n, few: n < 5 };
}

/** 一個訊號 × 一個價格的完整結果。 */
export function analyze(key, src, px, from) {
  const all = episodesFor(key, src, px, from);
  const deep = all.filter(e => finite(e.fromHigh) && e.fromHigh <= DEEP);
  const base = baseline(px, from);
  const sAll = summary(all), sDeep = summary(deep);
  return { key, all, deep, base, sAll, sDeep, vAll: verdict(sAll, base), vDeep: verdict(sDeep, base) };
}
