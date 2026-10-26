// 過往觀察（回測）的純計算：台股每日統計（跌停家數、無觀察類股）＋加權收盤 → 歷次訊號與訊號後的報酬。
// 規則與極端狀態儀表板相同（NO_OBS 門檻、近 22 個交易日視窗），只是把 2013 起的歷史攤開來看。
import { NO_OBS } from './nonnormal_calc.mjs';

const finite = v => typeof v === 'number' && Number.isFinite(v);

export const GAP = 20;                 // 條件消失滿 20 個交易日（約一個月）後再出現，才算新的一次
export const HORIZONS = [20, 60, 120]; // 訊號後幾個交易日的加權報酬
export const LOOKBACK = 250;           // 「距一年高點」看前 250 個交易日
export const TW50_LOW = 2;             // 0050 版：近 22 個交易日成分股觀察股合計 ≤ 2 次
export const TRIGGERS = Object.freeze({
  obs3: { label: `無觀察 ≥ ${NO_OBS.start} 天`, test: r => finite(r.noObs) && r.noObs >= NO_OBS.start },
  obs5: { label: '無觀察 ≥ 5 天', test: r => finite(r.noObs) && r.noObs >= 5 },
  ld300: { label: `跌停 ≥ ${NO_OBS.limitDownExtreme} 家`, test: r => finite(r.limitDown) && r.limitDown >= NO_OBS.limitDownExtreme },
  tw50: { label: `0050 近 22 日 ≤ ${TW50_LOW} 次`, test: r => finite(r.tw50) && r.tw50 <= TW50_LOW },
});

/** 近 22 列某欄位合計；視窗不滿 22 列或其中任一天缺值時為 null。 */
const rolling = (w, field) => (w.length === NO_OBS.window && w.every(x => finite(x[field])) ? w.reduce((a, x) => a + x[field], 0) : null);

/** 每日統計列 → [{date, limitDown, flag, noObs, obs50, tw50}]；noObs＝近 22 列 no_obs 合計；tw50＝近 22 列 0050 成分股觀察股合計（對照用）。 */
export function dailyRows(daily) {
  const rows = (daily || []).filter(r => typeof r?.date === 'string').sort((a, b) => (a.date < b.date ? -1 : 1));
  return rows.map((r, i) => {
    const w = rows.slice(Math.max(0, i - NO_OBS.window + 1), i + 1);
    return { date: r.date, limitDown: finite(r.limit_down) ? r.limit_down : null, flag: finite(r.no_obs) ? r.no_obs : null,
      noObs: rolling(w, 'no_obs'), obs50: finite(r.obs50) ? r.obs50 : null, tw50: rolling(w, 'obs50') };
  });
}

/** 依日期找第一個 ≥ date 的索引（rows 升序、有 date 欄位）；找不到回 -1。 */
function indexOnOrAfter(rows, date) {
  let lo = 0, hi = rows.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (rows[m].date < date) lo = m + 1; else hi = m; }
  return lo < rows.length ? lo : -1;
}

/**
 * 歷次訊號。rows＝dailyRows()；tw＝加權 [{date, close}] 升序。
 * 每一次：訊號第一天的日期與加權收盤、當時距一年高點、之後 60 個交易日內最低點、+20／60／120 日報酬（未來不足時 null），
 * 以及這一段（訊號出現到消失滿 GAP 日之前）的最多無觀察天數、最多跌停家數。
 */
export function episodes(rows, tw, key) {
  const test = TRIGGERS[key]?.test;
  if (!test) throw new Error('unknown trigger ' + key);
  const out = [];
  let cur = null, off = 0;
  for (const r of rows) {
    const hit = test(r);
    if (hit && !cur) { cur = { date: r.date, peakNoObs: null, maxLimitDown: null }; out.push(cur); }
    if (cur) {
      if (finite(r.noObs)) cur.peakNoObs = Math.max(cur.peakNoObs ?? 0, r.noObs);
      if (finite(r.limitDown)) cur.maxLimitDown = Math.max(cur.maxLimitDown ?? 0, r.limitDown);
      off = hit ? 0 : off + 1;
      if (off >= GAP) { cur.end = r.date; cur = null; off = 0; }
    }
  }
  return out.map(e => {
    const i = indexOnOrAfter(tw, e.date);
    if (i < 0) return { ...e, close: null, fromHigh: null, low60: null, ret: Object.fromEntries(HORIZONS.map(h => [h, null])) };
    const c = tw[i].close, prior = tw.slice(Math.max(0, i - LOOKBACK), i + 1).map(x => x.close);
    const next = tw.slice(i, i + 61).map(x => x.close);
    return {
      ...e, twDate: tw[i].date, close: c,
      fromHigh: c / Math.max(...prior) - 1,
      low60: next.length > 1 ? Math.min(...next) / c - 1 : null,
      ret: Object.fromEntries(HORIZONS.map(h => [h, tw[i + h] ? tw[i + h].close / c - 1 : null])),
    };
  });
}

const median = xs => {
  const s = xs.filter(finite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** 每個 horizon 的樣本數、中位數報酬、上漲比例。 */
export function summarize(list) {
  return Object.fromEntries(HORIZONS.map(h => {
    const xs = list.map(e => e.ret[h]).filter(finite);
    return [h, { n: xs.length, median: median(xs), up: xs.length ? xs.filter(x => x > 0).length / xs.length : null }];
  }));
}

/** 每年的無觀察類股天數、跌停 ≥ 門檻的天數、0050 版近 22 日 ≤ TW50_LOW 次的天數。 */
export function yearly(rows) {
  const by = new Map();
  for (const r of rows) {
    const y = r.date.slice(0, 4), o = by.get(y) || { year: y, days: 0, noObs: 0, ldDays: 0, tw50Days: 0, maxLimitDown: null };
    o.days += 1;
    if (r.flag === 1) o.noObs += 1;
    if (finite(r.tw50) && r.tw50 <= TW50_LOW) o.tw50Days += 1;
    if (finite(r.limitDown)) {
      if (r.limitDown >= NO_OBS.limitDownExtreme) o.ldDays += 1;
      o.maxLimitDown = Math.max(o.maxLimitDown ?? 0, r.limitDown);
    }
    by.set(y, o);
  }
  return [...by.values()];
}
