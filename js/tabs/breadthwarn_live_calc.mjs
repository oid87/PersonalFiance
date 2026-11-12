// 盤中去槓桿壓力監測的純計算：融資維持率情境、盤後回放用的每分鐘指標。不碰 DOM。
// 規則依「證券商辦理有價證券買賣融資融券業務操作辦法」第 53–55 條（2026-10 版）：
//   整戶維持率＝擔保品市值 ÷ 融資金額（這裡只算單純融資、沒有融券與抵繳品的情況）
//   低於 130% 通知補繳，送達後 2 個營業日內補；陸續補足差額或回到 166% 以上取消追繳紀錄。
export const RULE = { call: 1.30, clear: 1.66, ratioMax: 0.6, days: 2 };
const fin = Number.isFinite;

// 以融資成數買進當下的維持率：成數 60% → 166.7%
export const initialMaint = ratio => (ratio > 0 ? 1 / ratio : NaN);

// 一個假設部位：目前維持率 m0，股價再變動 drop（−0.1＝再跌 10%），追繳門檻 thr。
// 金額一律以「目前股票市值＝100」表示。
export function marginSim({ m0, drop = 0, thr = RULE.call, clear = RULE.clear }) {
  if (!(m0 > 0) || !(thr > 0) || !fin(drop) || drop <= -1) return null;
  const loan = 100 / m0, value = 100 * (1 + drop), m1 = value / loan;
  const need = t => Math.max(0, loan - value / t);       // 還掉多少融資才回到維持率 t
  return {
    loan, value, m1,
    room: thr / m0 - 1,                 // 從現在算，再跌多少碰到門檻（負數；已低於門檻則為正）
    roomAfter: thr / m1 - 1,            // 跌完之後還剩多少空間
    called: m1 < thr,
    payCall: need(thr), payClear: need(clear),
    equity: value - loan,               // 自有資金剩多少（市值 − 融資）
  };
}

// 從買進價算起：成數 ratio 買進後，跌多少碰到門檻（60%、130% → −22%）
export const dropToCall = (ratio, thr = RULE.call) => thr * ratio - 1;

export const simTable = (m0, drops, thr) => drops.map(d => ({ drop: d, ...marginSim({ m0, drop: d, thr }) }));

// ── 盤後回放：每分鐘序列的指標（和 scripts/_tw_intraday.py 同定義） ──
export const MINUTES = 271;
export const hhmm = m => `${String(9 + Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const ratio = (a, b, k = 1) => (fin(a) && fin(b) && b !== 0 ? a / b * k : null);

export function indicators(day) {
  const n = day.bq.length, cimb = new Array(n).fill(null), fill = new Array(n).fill(null), vp = new Array(n).fill(null), bp = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const b = day.bq[i], s = day.sq[i];
    if (fin(b) && fin(s) && b + s > 0) cimb[i] = (s - b) / (s + b) * 100;
    fill[i] = ratio(day.tq[i], s, 100);
    if (day.vb) vp[i] = ratio(day.tv[i], day.vb[i]);
    if (day.bb) bp[i] = ratio(b, day.bb[i]);
  }
  return { cimb, fill, vp, bp };
}

// 實際有值的分鐘數與最長連續缺漏（缺的地方不補）
export function coverage(a) {
  let have = 0, gap = 0, run = 0;
  for (const v of a) { if (fin(v)) { have++; run = 0; } else { run++; if (run > gap) gap = run; } }
  return { have, missing: a.length - have, maxGap: gap };
}

// 回放資料是不是過期：最後一個回放日比日線資料的最新日期舊，就是排程沒跑成功。任一個日期缺就不判斷。
export const staleness = (lastIntraday, lastDaily) => ({ stale: !!(lastIntraday && lastDaily && lastIntraday < lastDaily), lastIntraday: lastIntraday || null, lastDaily: lastDaily || null });
