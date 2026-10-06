// Pure global margin calculations extracted from marginglobal.js.
import { lookupLE } from '../utils/dates.js';

export function normalizeMarginRows(market, rawData) {
  if (!Array.isArray(rawData) || !rawData.length) return [];
  if (market.needsExchangeSum) {
    // SZSE 資料比 SSE 晚一天公布(實測現象),若某天只有部分交易所回報就加總,
    // 會把「當天沒公布的交易所」誤算成 0,讓最新一天看起來像腰斬。因此只保留
    // 「該資料集出現過的所有交易所都已回報」的日期,避免用不完整的加總誤導。
    const allExchanges = new Set(rawData.map(r => r.exchange).filter(Boolean));
    const byDate = new Map(); // date -> { sum, exchanges: Set }
    for (const r of rawData) {
      if (r.margin_balance == null || r.date == null) continue;
      if (!byDate.has(r.date)) byDate.set(r.date, { sum: 0, exchanges: new Set() });
      const entry = byDate.get(r.date);
      entry.sum += r.margin_balance;
      entry.exchanges.add(r.exchange);
    }
    return [...byDate.entries()]
      .filter(([, v]) => allExchanges.size === 0 || v.exchanges.size === allExchanges.size)
      .map(([date, v]) => [date, v.sum])
      .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }
  return rawData
    .map(r => [r.date, r[market.marginField]])
    .filter(([, v]) => v != null);
}


export function monthChange(rows) {
  if (!rows || rows.length < 2) return null;
  const latestDate = rows[rows.length - 1][0];
  const latestVal = rows[rows.length - 1][1];
  // 全程用 UTC 運算，避免 new Date("YYYY-MM-DD") 解析成 UTC 午夜、卻用本地
  // setMonth/getMonth 導致負時區(如 America/Los_Angeles)差一天。
  const d = new Date(latestDate + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() - 1);
  // check_reuse: keep — 全程 UTC 運算,tsToLocalDate 用本地 getFullYear/getMonth/getDate,套在這裡會重新引入本地時區的月份溢位問題(正是這次要修的 bug)
  const cutoffStr = d.toISOString().slice(0, 10);
  // 找「一個月前」最接近(不晚於)的一筆
  let prevVal = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i][0] <= cutoffStr) { prevVal = rows[i][1]; break; }
  }
  if (prevVal == null || prevVal === 0) return null;
  return (latestVal - prevVal) / Math.abs(prevVal);
}


export function rebaseToPercent(rows, anchor) {
  if (!rows || !rows.length || !anchor) return null;
  let anchorVal = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i][0] <= anchor) { anchorVal = rows[i][1]; break; }
  }
  if (anchorVal == null || anchorVal === 0) return null;
  return rows.filter(([d]) => d >= anchor).map(([d, v]) => [d, (v / anchorVal - 1) * 100]);
}

// 差值(槓桿堆積訊號)= 融資%變動 - 指數%變動,逐日期對齊,缺一邊就跳過(不插值)。
export function computeDivergence(marginPct, indexPct) {
  if (!marginPct || !indexPct) return [];
  const idxMap = new Map(indexPct.map(([d, v]) => [d, v]));
  const out = [];
  for (const [d, mv] of marginPct) {
    if (idxMap.has(d)) out.push([d, mv - idxMap.get(d)]);
  }
  return out;
}


export function computeVWAC(marginRows, indexRows) {
  if (!marginRows || !marginRows.length || !indexRows || !indexRows.length) return [];
  const out = [];
  let avgCost = null;
  let prevBalance = null;
  for (const [date, balance] of marginRows) {
    const idxEntry = lookupLE(indexRows, date);
    if (!idxEntry) continue; // 該日期早於指數資料起點,跳過(無法對照)
    const idxPrice = idxEntry[1];
    if (avgCost == null) {
      avgCost = idxPrice; // 初始化:資料集第一筆融資餘額,假設當下就是這個成本(已知限制,見info-panel揭露)
    } else {
      const delta = balance - prevBalance;
      if (delta > 0 && prevBalance > 0) {
        avgCost = (avgCost * prevBalance + delta * idxPrice) / balance;
      }
      // delta <= 0(淨還款)或 prevBalance<=0:avgCost 維持不變(比例攤還簡化假設)
    }
    out.push([date, avgCost]);
    prevBalance = balance;
  }
  return out;
}

// 目前畫面上實際顯示的指數序列:美股市場且選了非預設代理指數(QQQ/MAGS)時用代理指數,
// 否則用該市場預設指數。renderChart() 與拖曳量測都需要用「畫面上實際顯示的那條指數線」查值,
// 抽出來共用,避免兩處各寫一份同樣的判斷邏輯。

