// fgparts_calc.mjs — CNN 恐懼貪婪七分項：原始讀數 → 0–100 近似分數 → 等權總分。
//
// CNN 只公開「今天」每一項的 0–100 分數；歷史只給各項原始讀數（data/fear_greed_components.json，
// 約 2020-09 起）。CNN 的方法說明是：每項看「目前讀數偏離自己平均多少、相對平常的波動」，
// 換成 0–100，七項等權平均成總分。精確視窗與換算未公開，本檔用：
//   方向調整後的讀數 x → 近 126 交易日 z 分數 → 標準常態累積機率 ×100。
// 126 日是對 2020-09 起 CNN 實際總分試 63／126／252／504 日、z 與百分位後，相關最高（≈0.95）的組合。

export const WINDOW = 126;
export const MIN_OBS = 63;

/** 七分項：x(row) 回傳「越大越貪婪」的讀數；raw 是畫原始值用的欄位。 */
export const PARTS = [
  { id: 'momentum', label: '股市動能', note: 'S&P 500 相對 125 日均線', raw: 'sp500',
    x: r => (r.sp500 > 0 && r.sp125 > 0 ? r.sp500 / r.sp125 - 1 : null), score: 'sp500' },
  { id: 'strength', label: '股價強度', note: 'NYSE 52 週新高減新低（%）', raw: 'strength', x: r => r.strength, score: 'strength' },
  { id: 'breadth', label: '股價廣度', note: 'McClellan 成交量總和指標', raw: 'breadth', x: r => r.breadth, score: 'breadth' },
  { id: 'putcall', label: 'Put/Call', note: '5 日平均 Put/Call，越高越恐懼', raw: 'put_call', x: r => neg(r.put_call), score: 'put_call' },
  { id: 'junk', label: '垃圾債需求', note: '垃圾債減投資級殖利率差，越大越恐懼', raw: 'junk', x: r => neg(r.junk), score: 'junk' },
  { id: 'vix', label: '市場波動度', note: 'VIX 相對 50 日均線，越高越恐懼', raw: 'vix',
    x: r => (r.vix > 0 && r.vix50 > 0 ? 1 - r.vix / r.vix50 : null), score: 'vix' },
  { id: 'safehaven', label: '避險需求', note: '股票減公債 20 日報酬差', raw: 'safe_haven', x: r => r.safe_haven, score: 'safe_haven' },
];

function neg(v) { return Number.isFinite(v) ? -v : null; }

/** 標準常態累積分佈（Abramowitz–Stegun 7.1.26，誤差 < 1.5e-7）。 */
export function normCdf(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t
    * Math.exp(-z * z / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** 依序的讀數 → 每點 0–100 近似分數（含當日的近 window 筆，有效值 < minObs 時 null）。 */
export function rollingScore(values, window = WINDOW, minObs = MIN_OBS) {
  return values.map((v, i) => {
    if (!Number.isFinite(v)) return null;
    const w = values.slice(Math.max(0, i - window + 1), i + 1).filter(Number.isFinite);
    if (w.length < minObs) return null;
    const m = w.reduce((a, b) => a + b, 0) / w.length;
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / (w.length - 1));
    if (!(sd > 0)) return 50;
    return 100 * normCdf((v - m) / sd);
  });
}

/** 等權平均；任一項缺值就回 null（不拿六項硬湊）。 */
export function equalWeight(scores) {
  if (!scores.length || scores.some(s => !Number.isFinite(s))) return null;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

/** rows（依日期排序）→ { dates, parts: {id: {raw, score}}, composite } */
export function buildParts(rows) {
  const sorted = [...rows].filter(r => r?.date).sort((a, b) => (a.date < b.date ? -1 : 1));
  const dates = sorted.map(r => r.date);
  const parts = {};
  for (const p of PARTS) {
    const raw = sorted.map(r => (Number.isFinite(r[p.raw]) ? r[p.raw] : null));
    parts[p.id] = { raw, score: rollingScore(sorted.map(r => { const v = p.x(r); return Number.isFinite(v) ? v : null; })) };
  }
  const composite = dates.map((_, i) => equalWeight(PARTS.map(p => parts[p.id].score[i])));
  return { dates, parts, composite };
}

/** 估算總分與 CNN 實際總分（[{date,value}]）在重疊日的相關與平均絕對誤差。 */
export function compareWithCnn(dates, composite, fgRows) {
  const cnn = new Map(fgRows.map(r => [r.date, r.value]));
  const a = [], b = [];
  dates.forEach((d, i) => { const c = cnn.get(d); if (Number.isFinite(composite[i]) && Number.isFinite(c)) { a.push(composite[i]); b.push(c); } });
  if (a.length < 2) return null;
  const ma = a.reduce((s, v) => s + v, 0) / a.length, mb = b.reduce((s, v) => s + v, 0) / b.length;
  let sab = 0, saa = 0, sbb = 0, mae = 0;
  for (let i = 0; i < a.length; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; mae += Math.abs(a[i] - b[i]); }
  return { n: a.length, corr: sab / Math.sqrt(saa * sbb), mae: mae / a.length };
}

/** CNN 當日官方分項分數快照 → 七項列表與等權平均，和 CNN 公布總分對照。 */
export function officialSnapshot(snap) {
  if (!snap) return null;
  const items = PARTS.map(p => ({ id: p.id, label: p.label, score: snap[p.score] }));
  return { date: snap.date, items, mean: equalWeight(items.map(i => i.score)), composite: snap.composite };
}

export function zoneOf(score) {
  if (!Number.isFinite(score)) return '—';
  return score < 25 ? '極度恐懼' : score < 45 ? '恐懼' : score < 55 ? '中性' : score < 75 ? '貪婪' : '極度貪婪';
}
