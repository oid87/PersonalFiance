// Fixture — verbatim extract, do not modify.
// Source: git show 9b8b32121aa0d4ebb8b5d23571b9d7e12d1ee85a:js/tabs/wkrev.js
// (full SHA resolved from "e997537e^", the parent of the commit that moved
// toWeeklyOHLC into js/utils/dates.js), lines 28-62 of that historical file.
// Extracted verbatim; do not edit by hand.
function toWeeklyOHLC(daily) {
  // daily: [[date, open, high, low, close, volume], ...] ascending
  const byWeek = new Map();
  const order = [];
  for (const [date, open, high, low, close, volume] of daily) {
    const d = new Date(date + "T00:00:00Z");
    const day = d.getUTCDay();
    const diff = day === 0 ? -6 : 1 - day;
    const mon = new Date(d);
    mon.setUTCDate(d.getUTCDate() + diff);
    // check_reuse: keep — toWeeklyOHLC 是第三種變體(回 OHLCV 物件帶 weekStart/weekEndDate),非 dates.toWeekly([date,close]) 也非 toWeeklyHLC([date,h,l,c])
    const key = mon.toISOString().slice(0, 10);
    let w = byWeek.get(key);
    if (!w) {
      w = { weekStart: key, weekEndDate: date, open, high, low, close, volume: volume || 0 };
      byWeek.set(key, w);
      order.push(key);
    } else {
      w.high = Math.max(w.high, high);
      w.low = Math.min(w.low, low);
      w.close = close;
      w.weekEndDate = date;
      w.volume += volume || 0;
    }
  }
  const weeks = order.map(k => byWeek.get(k)).sort((a, b) => a.weekStart < b.weekStart ? -1 : 1);
  // partial: 只有「資料末端那一週」且該週最後交易日不是週五(UTC getUTCDay()===5) 才算
  if (weeks.length) {
    const last = weeks[weeks.length - 1];
    const lastDow = new Date(last.weekEndDate + "T00:00:00Z").getUTCDay();
    last.partial = lastDow !== 5;
  }
  for (let i = 0; i < weeks.length - 1; i++) weeks[i].partial = false;
  return weeks;
}
