// 主流族群每日判定（「無主流日」）— 純函式引擎（無 DOM、無 fetch）。
// 規則原文：每天盤面上突破、帶量、創短期新高的個股或族群＝觀察類股；整天沒有＝市場沒有新的主流與續航力；分「完全沒有」和「只有稍微有」兩級。
//   當月第 1 次提高注意、第 2 次檢視 ETF 走勢與位階、第 3 次保持追蹤可開始分批、5 次（約四分之一交易日）極度恐慌；
//   連續三次對應融資 T+2 斷頭；由沒有轉成有＝情緒回溫；強勢股開盤就漲停、沒有進場點的日子不代表市場弱。
// 本專案定義：量化門檻（下方 MAINSTREAM）。原始事實由 scripts/fetch_tw_mainstream.py 產生（data/tw_mainstream.json）。
const finite = v => typeof v === 'number' && Number.isFinite(v);

export const MAINSTREAM = Object.freeze({
  hiDays: 60,        // 收盤創 60 日新高（不含當天）
  volMult: 2,        // 成交量 ≥ 前 20 日均量 × 2
  minRet: 3,         // 當日漲幅 ≥ 3%
  groupMin: 3,       // 同產業當日候選 ≥ 3 檔＝主流族群
  lockMin: 20,       // 開盤即鎖漲停 ≥ 20 檔＝「強勢、無進場點」（本專案定義，待校準）
  window: 22,        // 近 22 個交易日（約一個月）
  streak: 3,         // 連續 3 天完全沒有
});

export const LEVELS = ['有', '稍微有', '完全沒有'];   // 0／1／2
export const COUNT_TIERS = [
  { min: 0, label: '0 次', text: '近一個月沒有出現完全沒有主流的日子' },
  { min: 1, label: '1 次', text: '規則原文：提高注意' },
  { min: 2, label: '2 次', text: '規則原文：檢視要配置的 ETF 走勢和位階' },
  { min: 3, label: '3–4 次', text: '規則原文：保持追蹤，月底可以開始分批' },
  { min: 5, label: '≥ 5 次', text: '規則原文：約四分之一的交易日，極度恐慌' },
];
export const countTier = n => (finite(n) ? COUNT_TIERS.findLastIndex(t => n >= t.min) : -1);

/** 一天的判定。row：{date, n, lock, c:[[code, ret, vr, hi, ind]]}。p 可覆蓋參數（校準用）。 */
export function judgeDay(row, p = MAINSTREAM) {
  const cands = (row?.c || []).filter(([, ret, vr, hi]) => ret >= p.minRet && vr >= p.volMult && hi >= p.hiDays);
  const by = new Map();
  for (const x of cands) if (x[4]) { const a = by.get(x[4]) || []; a.push(x[0]); by.set(x[4], a); }
  const groups = [...by].filter(([, a]) => a.length >= p.groupMin).map(([ind, codes]) => ({ ind, n: codes.length, codes }))
    .sort((a, b) => b.n - a.n || (a.ind < b.ind ? -1 : 1));
  const level = groups.length ? 0 : cands.length ? 1 : 2;
  const strong = (row?.lock ?? 0) >= p.lockMin;
  return { date: row.date, level, strong, none: level === 2 && !strong, cands: cands.length, groups, lock: row?.lock ?? 0, n: row?.n ?? 0 };
}

/** 整段：每日判定＋近 window 日「完全沒有」次數、連續天數、轉折（前一天完全沒有 → 今天有）。 */
export function judgeAll(rows = [], p = MAINSTREAM) {
  const days = [...rows].filter(r => r && typeof r.date === 'string').sort((a, b) => (a.date < b.date ? -1 : 1)).map(r => judgeDay(r, p));
  let streak = 0;
  return days.map((d, i) => {
    streak = d.none ? streak + 1 : 0;
    const win = days.slice(Math.max(0, i - p.window + 1), i + 1);
    const count = win.filter(x => x.none).length;
    const countNoGroup = win.filter(x => x.level >= 1 && !x.strong).length;   // 參考：沒有主流族群（含稍微有）
    const turn = i > 0 && days[i - 1].none && d.level === 0;
    return { ...d, count, countNoGroup, streak, streak3: streak >= p.streak, turn, tier: countTier(count) };
  });
}

/** 校準：某段期間內「完全沒有」的天數與日期。 */
export function noneIn(judged, from, to) {
  const ds = judged.filter(d => d.date >= from && d.date <= to && d.none).map(d => d.date);
  return { days: ds.length, dates: ds };
}

/** 給其他分頁讀的精簡輸出（綜合訊號預留）。 */
export function summary(judged) {
  const t = judged.at(-1);
  if (!t) return null;
  return { date: t.date, level: t.level, label: LEVELS[t.level], strong: t.strong, count22: t.count, streak: t.streak, streak3: t.streak3, turn: t.turn,
    groups: t.groups.map(g => ({ ind: g.ind, n: g.n, codes: g.codes })) };
}
