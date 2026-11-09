// 無觀察類股回測（指數＋無觀察類股，近 10 年）的純計算。訊號規則沿用過往觀察（nonnormalhist_calc.mjs），
// 這裡只加：五個市場的統一介面、任意一天進場的基準、跌深版（訊號日距一年高點 ≤ DEEP）、和基準比較的結論。
import * as H from './nonnormalhist_calc.mjs';
import { NO_OBS } from './nonnormal_calc.mjs';

const finite = v => typeof v === 'number' && Number.isFinite(v);
export const YEARS = 10;
export const DEEP = -0.10;
export const HORIZONS = H.HORIZONS;

// kind: tw＝全市場（近 22 日無觀察天數 ≥ 3）；tw50＝0050 成分股（近 22 日觀察股 ≤ 2 次）；us＝每 100 檔近 22 日 ≤ 4 次
export const MARKETS = Object.freeze({
  tw: { label: '加權（全市場）', price: 'TWII', kind: 'tw', ind: '近 22 日無觀察天數', th: NO_OBS.start, dir: '≥' },
  tw50: { label: '0050', price: '0050.TW', kind: 'tw50', ind: '0050 成分股近 22 日觀察股次數', th: H.TW50_LOW, dir: '≤' },
  qqq: { label: 'QQQ', price: 'QQQ', kind: 'us', ind: '每 100 檔近 22 日觀察股次數', th: H.RATE_LOW, dir: '≤' },
  voo5: { label: 'VOO', price: 'VOO', kind: 'us', ind: '每 100 檔近 22 日觀察股次數（前五大板塊）', th: H.RATE_LOW, dir: '≤' },
  soxx: { label: 'SOXX', price: 'SOXX', kind: 'us', ind: '每 100 檔近 22 日觀察股次數（半導體）', th: H.RATE_LOW, dir: '≤' },
});

/** 起算日：資料最後一天往前 YEARS 年。 */
export function startDate(last, years = YEARS) {
  const d = new Date(last + 'T00:00:00Z');
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

/** 指標序列 [{date, v, hit}]。tw／tw50 用 dailyRows()，us 用 usRows()。 */
export function indicator(key, twRows, usRows) {
  const m = MARKETS[key];
  if (!m) throw new Error('unknown market ' + key);
  const pick = m.kind === 'tw' ? r => r.noObs : m.kind === 'tw50' ? r => r.tw50 : r => r[`${key}_rate`];
  const src = m.kind === 'us' ? usRows : twRows;
  return src.map(r => {
    const v = pick(r);
    return { date: r.date, v: finite(v) ? v : null, hit: finite(v) && (m.dir === '≥' ? v >= m.th : v <= m.th) };
  });
}

/** 歷次訊號（只留 from 之後開始的）。 */
export function episodesFor(key, twRows, usRows, px, from) {
  const m = MARKETS[key];
  const list = m.kind === 'us' ? H.usEpisodes(usRows, px, key) : H.episodes(twRows, px, m.kind === 'tw' ? 'obs3' : 'tw50');
  return list.filter(e => !from || e.date >= from);
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

/** 訊號 vs 基準：60 與 120 日中位數都贏基準＝較好；都輸＝較差；其餘＝差不多。樣本 < 5 標註樣本少。 */
export function verdict(sig, base) {
  const diffs = [60, 120].map(h => (finite(sig[h].median) && finite(base[h].median) ? sig[h].median - base[h].median : null));
  const n = sig[60].n;
  const level = diffs.some(d => d == null) ? 'na' : diffs.every(d => d > 0.01) ? 'better' : diffs.every(d => d < -0.01) ? 'worse' : 'same';
  return { level, diff60: diffs[0], diff120: diffs[1], n, few: n < 5 };
}

/** 一個市場的完整結果。 */
export function analyze(key, twRows, usRows, px, from) {
  const all = episodesFor(key, twRows, usRows, px, from);
  const deep = all.filter(e => finite(e.fromHigh) && e.fromHigh <= DEEP);
  const base = baseline(px, from);
  const sAll = summary(all), sDeep = summary(deep);
  return { key, all, deep, base, sAll, sDeep, vAll: verdict(sAll, base), vDeep: verdict(sDeep, base) };
}
