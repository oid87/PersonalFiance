// 台股「融資水位 × 斷頭壓力」拖曳選區統計與殺爆判讀(純函式,供 twsentiment.js 使用)。
// 序列皆為升冪 [[date, value], ...];日期字串 'YYYY-MM-DD' 可直接比較。

// 殺爆門檻(校準視窗 ≤ 10 個交易日,見 CALIB_WINDOW_TD)。
// 融資餘額 = 融資金額(券商借出的錢),股價跌不會讓它變少,只有還款或斷頭賣股還款才會減少,
// 所以「指數大跌 + 融資金額大減」同時出現才視為強制賣出。
export const KILL_RULE = Object.freeze({ idxPct: -8, mgnPct: -10 });
export const BIG_KILL_RULE = Object.freeze({ idxPct: -10, mgnPct: -20 });
export const CALIB_WINDOW_TD = 10;

// 最後一筆 date <= target 的索引;沒有則 -1
function lastIdxLE(rows, target) {
  let lo = 0, hi = rows.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid][0] <= target) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

function pctChange(a, b) {
  if (a == null || b == null || a === 0) return null;
  return (b / a - 1) * 100;
}

export function classifyForcedSell(s) {
  if (!s || s.tradingDays < 1 || s.idxPct == null || s.mgnPct == null) {
    return { level: 'na', label: '區間不足或資料缺漏，無法判定' };
  }
  if (s.idxPct <= BIG_KILL_RULE.idxPct && s.mgnPct <= BIG_KILL_RULE.mgnPct) {
    return { level: 'big', label: '大殺爆融資' };
  }
  if (s.idxPct <= KILL_RULE.idxPct && s.mgnPct <= KILL_RULE.mgnPct) {
    return { level: 'kill', label: '殺爆融資' };
  }
  if (s.idxPct <= KILL_RULE.idxPct) {
    return { level: 'no', label: '指數重挫但融資沒有明顯縮減，未達殺爆' };
  }
  return { level: 'none', label: '未達殺爆門檻' };
}

// 兩個日期之間(含端點,端點取「當日或之前最近一筆」)的指數 / 融資餘額 / 融資維持率變化。
// twii 以加權指數交易日為基準;融資與維持率各自取不晚於端點的最近一筆(缺值時會落到更早的交易日),
// 因此回傳 mrDate0 / mrDate1 讓 UI 標出實際使用的維持率資料日。
// 回傳 null 代表 d0 早於指數資料起點。
export function forcedRangeStats({ twii, margin, ratio }, dateA, dateB) {
  const [dStart, dEnd] = dateA <= dateB ? [dateA, dateB] : [dateB, dateA];
  const i0 = lastIdxLE(twii, dStart), i1 = lastIdxLE(twii, dEnd);
  if (i0 < 0 || i1 < 0) return null;
  const d0 = twii[i0][0], d1 = twii[i1][0];

  const m0 = lastIdxLE(margin, d0), m1 = lastIdxLE(margin, d1);
  const mg0 = m0 >= 0 ? margin[m0][1] : null;
  const mg1 = m1 >= 0 ? margin[m1][1] : null;

  const r0i = lastIdxLE(ratio, d0), r1i = lastIdxLE(ratio, d1);
  const r0 = r0i >= 0 ? ratio[r0i] : null;
  const r1 = r1i >= 0 ? ratio[r1i] : null;

  const idx0 = twii[i0][1], idx1 = twii[i1][1];
  const stats = {
    d0, d1,
    tradingDays: i1 - i0,
    idx0, idx1,
    idxPts: idx1 - idx0,
    idxPct: pctChange(idx0, idx1),
    mg0, mg1,
    mgnAmt: mg0 == null || mg1 == null ? null : mg1 - mg0,
    mgnPct: pctChange(mg0, mg1),
    mr0: r0 ? r0[1] : null,
    mr1: r1 ? r1[1] : null,
    mrDate0: r0 ? r0[0] : null,
    mrDate1: r1 ? r1[0] : null,
    mrPts: r0 && r1 ? r1[1] - r0[1] : null,
    mrPct: r0 && r1 ? pctChange(r0[1], r1[1]) : null,
  };
  stats.calibrated = stats.tradingDays <= CALIB_WINDOW_TD;
  stats.verdict = classifyForcedSell(stats);
  return stats;
}
