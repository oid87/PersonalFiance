import { loaded, state } from '../state.js';

// ECharts time-axis parses "YYYY-MM-DD" as local midnight, not UTC.
// Always use this helper (not toISOString) when turning an ECharts timestamp
// back into a date string.
export function tsToLocalDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

export function presetStart(preset) {
  const d = new Date();
  if      (preset === "6M")   d.setMonth(d.getMonth() - 6);
  else if (preset === "1Y")   d.setFullYear(d.getFullYear() - 1);
  else if (preset === "1Y6M") { d.setFullYear(d.getFullYear() - 1); d.setMonth(d.getMonth() - 6); }
  else if (preset === "3.5Y") { d.setFullYear(d.getFullYear() - 3); d.setMonth(d.getMonth() - 6); }
  else if (preset === "5Y")   d.setFullYear(d.getFullYear() - 5);
  else if (preset === "10Y")  d.setFullYear(d.getFullYear() - 10);
  else if (preset === "20Y")  d.setFullYear(d.getFullYear() - 20);
  else return null;
  return d.toISOString().slice(0, 10);
}

// 「今天往回 N 年」的 range cutoff(key: 1Y/3Y/5Y/10Y/MAX,未命中回 3 年)。
// 9 個 macro tab(inflation / money_market / net_liquidity / putcall / real_rates /
// relstrength / vix_term / vxnvix / yield_curve)原本各自逐字複製這一份。
// **逐字搬過來,不要「順手」擴充 key 集合或
// 換 MAX 哨兵** —— 呼叫端是拿回傳值做字串比較(row.date >= cut),`"0000-00-00"`
// 就是靠「小於任何真日期」達成「全部通過」,換成 null 或別的哨兵會改行為。
// ⚠️ 與 presetStart 是**不同**的東西:presetStart 的 key 集合是 6M/1Y/1Y6M/3.5Y/
// 5Y/10Y/20Y 且未命中回 null;這裡未命中回 3 年。別把兩者合併。
export function cutoffDate(key) {
  if (key === "MAX") return "0000-00-00";
  const d = new Date();
  const yrs = { "1Y": 1, "3Y": 3, "5Y": 5, "10Y": 10 }[key] ?? 3;
  d.setFullYear(d.getFullYear() - yrs);
  return d.toISOString().slice(0, 10);
}

export function currentWindow() {
  if (state.customFrom) return { from: state.customFrom, to: state.customTo || new Date().toISOString().slice(0,10) };
  return { from: presetStart(state.rangePreset), to: null };
}

export function filterRange(rows) {
  const { from, to } = currentWindow();
  let r = from ? rows.filter(r => r[0] >= from) : rows;
  if (to) r = r.filter(row => row[0] <= to);
  return r;
}

export function dateAddDays(dateStr, n) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

export function closestOnOrAfter(key, dateStr) {
  const data = loaded[key];
  if (!data) return null;
  for (const [d, c] of data) if (d >= dateStr) return c;
  return null;
}

export function minBetween(key, t0, t1) {
  const data = loaded[key];
  if (!data) return null;
  let min = Infinity, minDate = null;
  for (const [d, c] of data) {
    if (d > t1) break;
    if (d >= t0 && c < min) { min = c; minDate = d; }
  }
  return min === Infinity ? null : { price: min, date: minDate };
}

// Binary search: last entry where arr[i][0] <= date
export function lookupLE(arr, date) {
  let lo = 0, hi = arr.length - 1, result = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid][0] <= date) { result = arr[mid]; lo = mid + 1; }
    else hi = mid - 1;
  }
  return result;
}

export function toWeekly(dailyData) {
  const byWeek = new Map();
  for (const [date, close] of dailyData) {
    const d = new Date(date + "T00:00:00Z");
    const day = d.getUTCDay();
    const diff = day === 0 ? -6 : 1 - day;
    const mon = new Date(d);
    mon.setUTCDate(d.getUTCDate() + diff);
    const key = mon.toISOString().slice(0, 10);
    byWeek.set(key, [date, close]);
  }
  return [...byWeek.values()].sort((a, b) => a[0] < b[0] ? -1 : 1);
}

export function toWeeklyHLC(dailyHLC) {
  const byWeek = new Map();
  for (const [date, high, low, close] of dailyHLC) {
    const d = new Date(date + "T00:00:00Z");
    const diff = d.getUTCDay() === 0 ? -6 : 1 - d.getUTCDay();
    const mon = new Date(d); mon.setUTCDate(d.getUTCDate() + diff);
    const key = mon.toISOString().slice(0, 10);
    const ex = byWeek.get(key);
    if (ex) { ex[0] = date; ex[1] = Math.max(ex[1], high); ex[2] = Math.min(ex[2], low); ex[3] = close; }
    else byWeek.set(key, [date, high, low, close]);
  }
  return [...byWeek.values()].sort((a, b) => a[0] < b[0] ? -1 : 1);
}
