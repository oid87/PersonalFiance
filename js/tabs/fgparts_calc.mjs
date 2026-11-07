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

/** 簡單移動平均：values 依序（可含 null），不足 n 筆有效值或當日缺值回 null。n 夾在 [2, 400]。 */
export function movingAverage(values, n) {
  const k = Math.min(400, Math.max(2, Math.round(n) || 125));
  const out = new Array(values.length).fill(null);
  let sum = 0, cnt = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isFinite(v)) { sum += v; cnt++; }
    if (i >= k) { const o = values[i - k]; if (Number.isFinite(o)) { sum -= o; cnt--; } }
    if (Number.isFinite(v) && cnt === k) out[i] = sum / k;
  }
  return out;
}

/** 價格來源：SPX 用 CNN 資料裡的 S&P 500 指數；SPY／VOO 用 data/<x>.json 收盤。 */
export const PRICE_SOURCES = { SPX: 'S&P 500 指數', SPY: 'SPY', VOO: 'VOO' };

/** 七指標 101（給完全沒概念的人）：比喻、怎麼看、例子。today(r) 給最新原始讀數的白話。 */
export const ELI5 = {
  momentum: { like: '看全班最近的成績，是不是比過去半年的平均好。',
    how: 'S&P 500 高於 125 日均線越多 → 越貪婪；跌破均線越深 → 越恐懼。',
    eg: '指數 6,000、125 日均線 5,700，高出 5% → 偏貪婪。',
    today: r => `S&P 500 ${fmtN(r.sp500, 0)}，125 日均線 ${fmtN(r.sp125, 0)}，${pct(r.sp500 / r.sp125 - 1)}` },
  strength: { like: '數一數有幾位同學考出「一年來最好成績」，再扣掉考出「一年來最差」的。',
    how: '創 52 週新高的股票比新低多 → 貪婪；新低比較多 → 恐懼。',
    eg: '今天 300 檔創新高、100 檔創新低，淨值為正 → 偏貪婪。',
    today: r => `淨新高比例 ${fmtN(r.strength, 2)}%` },
  breadth: { like: '是全班都在進步，還是只有幾個資優生撐場面。',
    how: '上漲股的成交量比下跌股多（McClellan 成交量總和指標往上）→ 貪婪；反之 → 恐懼。',
    eg: '指數漲，但多數股票的量是在下跌股 → 廣度差，指數上漲靠少數權值股。',
    today: r => `McClellan 成交量總和 ${fmtN(r.breadth, 0)}` },
  putcall: { like: '大家買保險的多寡。越多人買保險，代表越怕出事。',
    how: 'Put 成交量 ÷ Call 成交量，取 5 日平均。分數看的是「跟近半年自己比」偏高多少，不是看絕對數字：比平常高 → 恐懼；比平常低 → 貪婪。',
    eg: '近半年平均約 0.74。今天 0.86 看起來不算誇張，但已經是近半年最高附近，所以分數掉到個位數。反過來，降到 0.6 左右就會被算成貪婪。',
    more: `<p><b>Call（買權）</b>：花一小筆權利金，換「未來可以用約定價格<b>買</b>」的權利。股價漲，它就值錢 → 買 Call 的人在賭漲。</p>
      <p><b>Put（賣權）</b>：花一小筆權利金，換「未來可以用約定價格<b>賣</b>」的權利。股價跌，它就值錢 → 像幫股票買保險，或直接賭跌。</p>
      <p><b>Put/Call 比</b>：當天 Put 成交量 ÷ Call 成交量。0.8 代表每 10 口 Call 就有 8 口 Put。</p>
      <p><b>那「賣」Put／Call 呢？</b>每一口選擇權都有一個買方、一個賣方，成交量只算一次，所以這個比例<b>分不出</b>是誰主動。這裡預設把成交量當成「買保險／買看漲」的人氣：Put 多 → 怕跌的人多。賣 Put（收權利金、願意跌了接股票）其實偏樂觀，賣 Call 偏保守，但這個指標看不到這層，是它的盲點。</p>`,
    today: r => `5 日平均 Put/Call ${fmtN(r.put_call, 2)}` },
  junk: { like: '借錢給信用比較差的同學，你要多收多少利息才肯借。',
    how: '垃圾債比好公司債多出的殖利率（利差）縮小 → 大家敢冒險 → 貪婪；利差擴大 → 恐懼。',
    eg: '利差從 2.0 個百分點拉到 3.0 → 投資人要求更多補償 → 偏恐懼。',
    today: r => `垃圾債減投資級殖利率差 ${fmtN(r.junk, 2)} 個百分點` },
  vix: { like: '教室裡的緊張程度。考前大家越慌，溫度計越高。',
    how: 'VIX（市場預期的波動）高於自己 50 日均線越多 → 越恐懼；低於均線 → 貪婪。',
    eg: 'VIX 從平常 15 跳到 25，比 50 日均線高很多 → 恐懼。',
    today: r => `VIX ${fmtN(r.vix, 2)}，50 日均線 ${fmtN(r.vix50, 2)}，${pct(r.vix / r.vix50 - 1)}` },
  safehaven: { like: '大家是往遊樂場（股票）跑，還是躲進避難所（公債）。',
    how: '近 20 個交易日股票報酬贏公債越多 → 貪婪；公債贏股票（資金躲避險）→ 恐懼。',
    eg: '20 天股票 +3%、公債 −1%，差 +4 個百分點 → 貪婪。',
    today: r => `股票減公債 20 日報酬差 ${fmtN(r.safe_haven, 2)} 個百分點` },
};

function fmtN(v, d) { return Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—'; }
function pct(v) { return Number.isFinite(v) ? `${v >= 0 ? '高於' : '低於'}均線 ${Math.abs(v * 100).toFixed(1)}%` : '—'; }

export const DISPLAY_FROM = '2009-01-01';

/** 代理資料（CNN 首日之前）＋ CNN 原始讀數 → 一條依日期排序的列；同日以 CNN 為準。每列標 proxy。 */
export function mergeProxy(proxyRows = [], cnnRows = []) {
  const first = cnnRows.reduce((m, r) => (r?.date && (!m || r.date < m) ? r.date : m), null);
  const out = proxyRows.filter(r => r?.date && (!first || r.date < first)).map(r => ({ ...r, proxy: true }));
  for (const r of cnnRows) if (r?.date) out.push({ ...r, proxy: false });
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** [{date, close}] → { dates, close, ma }（ma 用整段歷史計算，再截到 from 之後）。 */
export function priceWithMA(rows, n, from = DISPLAY_FROM) {
  const s = [...rows].filter(r => r?.date && Number.isFinite(r.close)).sort((a, b) => (a.date < b.date ? -1 : 1));
  const ma = movingAverage(s.map(r => r.close), n);
  const i0 = s.findIndex(r => r.date >= from);
  if (i0 < 0) return { dates: [], close: [], ma: [] };
  return { dates: s.slice(i0).map(r => r.date), close: s.slice(i0).map(r => r.close), ma: ma.slice(i0) };
}

// VIX（30 日）＋ 20／50 日均線，與 VIX3M（3 個月）對齊同一組日期；ratio = VIX / VIX3M，>1 表示近端比遠端貴（逆價差）。
export function vixTerm(vixRows, termRows, from = DISPLAY_FROM) {
  const v = priceWithMA(vixRows, 20, from), v50 = priceWithMA(vixRows, 50, from);
  const m3 = new Map(termRows.filter(r => Number.isFinite(r?.vix3m)).map(r => [r.date, r.vix3m]));
  const vix3m = v.dates.map(d => m3.get(d) ?? null);
  return { dates: v.dates, vix: v.close, ma20: v.ma, ma50: v50.ma, vix3m,
    ratio: v.close.map((x, i) => (Number.isFinite(vix3m[i]) ? x / vix3m[i] : null)) };
}

// VXN（Nasdaq-100 的 30 日預期波動）＋ 20／50 日均線，並對齊同日 VIX；ratio = VXN / VIX、spread = VXN − VIX。
export function vxnView(vxnRows, vixRows, from = DISPLAY_FROM) {
  const v = priceWithMA(vxnRows, 20, from), v50 = priceWithMA(vxnRows, 50, from);
  const m = new Map(vixRows.filter(r => Number.isFinite(r?.close)).map(r => [r.date, r.close]));
  const vix = v.dates.map(d => m.get(d) ?? null);
  return { dates: v.dates, main: v.close, ma20: v.ma, ma50: v50.ma, other: vix,
    ratio: v.close.map((x, i) => (Number.isFinite(vix[i]) ? x / vix[i] : null)),
    spread: v.close.map((x, i) => (Number.isFinite(vix[i]) ? x - vix[i] : null)) };
}
