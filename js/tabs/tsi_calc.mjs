// TSI 逆向訊號：純函式（不重算公式，只整理 data/tsi_weekly.json 的計算結果）。
export const KINDS = {
  purple: { label: '紫點', color: '#a371f7',
    tip: '紫點＝警戒／準備：週線 Stochastic %K 由 25 以上跌破 25，進入超賣區。不是買點，代表「接下來等綠點確認」。' },
  buy: { label: '綠點（買進事件）', color: '#3fb950',
    tip: '綠點＝買進事件：前一週 %K 還在 25 以下，這週 %K 由下往上穿越 %D，超賣區開始回升。F1、F2 都相同，是唯一算「新交易」的綠點。' },
  cont: { label: '綠點續亮（F2 狀態）', color: '#3fb950',
    tip: '空心綠圈＝F2 續亮：買進事件之後，%K 仍低於 25 且比前一週高，綠點維持亮著。只是狀態延續，不是新的買進。F1 不顯示。' },
  sell: { label: '紅點', color: '#ef4444',
    tip: '紅點＝轉弱：週線 MACD 由上往下穿越 Signal，且 %K 比前一週低。代表動能轉弱，不等於要全部出場。' },
};

// model: 'F1' | 'F2'。F2 才帶續亮；續亮永遠是 STATE，不是新的買進事件。
export function eventsOf(rows, model) {
  const out = [];
  for (const r of rows) {
    for (const k of ['purple', 'buy', 'cont', 'sell']) {
      if (!r[k] || (k === 'cont' && model !== 'F2')) continue;
      out.push({ week: r.week, kind: k, type: k === 'cont' ? 'STATE' : 'EVENT', row: r });
    }
  }
  return out;
}

export function lastWeekOf(rows, key) {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i][key]) return rows[i].week;
  return null;
}

export function latestStatus(rows) {
  const r = rows[rows.length - 1];
  if (!r) return null;
  return {
    row: r,
    lastPurple: lastWeekOf(rows, 'purple'),
    lastBuy: lastWeekOf(rows, 'buy'),
    lastCont: lastWeekOf(rows, 'cont'),
    lastSell: lastWeekOf(rows, 'sell'),
    buyNow: !!r.buy,
    contNow: !!r.cont,
  };
}

export const PERIODS = {
  all: ['0000', '9999'], p2020: ['2020-01-01', '9999'], p2010: ['2010-01-01', '2019-12-31'], p2000: ['1999-01-01', '2009-12-31'],
};

export function filterEvents(events, kind, period) {
  const [a, b] = PERIODS[period] || PERIODS.all;
  return events.filter(e => (kind === 'all' || e.kind === kind) && e.week >= a && e.week <= b);
}

// 作者證據：只認研究專案登錄的狀態；沒有就是 UNKNOWN。非週線證據（weekly_scoring_eligible=false）不能升級成 MATCH/MISS。
export function evidenceLabel(row) {
  const d = row?.author_detail;
  if (!d) return 'UNKNOWN';
  if (d.status) return d.eligible === false && ['MATCH', 'MISS'].includes(d.status) ? 'UNKNOWN' : d.status;
  return d.ground_truth ? `作者週線圖：${d.ground_truth}` : 'UNKNOWN';
}

export const SERIES_TIPS = {
  'NDX 週K': 'Nasdaq-100 指數週 K 棒（週一到週五，最後交易日收盤確認）。',
  '%K': 'Stochastic(14,3,3) 的 %K：近 14 週收盤在高低區間的位置（0–100），25 以下為超賣區。',
  '%D': '%K 的 3 週平均，用來判斷 %K 上穿／下穿。',
  MACD: 'MACD(12,26,9)：12 週 EMA − 26 週 EMA，反映中期動能。',
  Signal: 'MACD 的 9 週 EMA；MACD 跌破它是紅點條件之一。',
  Histogram: 'MACD − Signal，正值紅、負值綠。',
  'QQQ 週收盤（對照）': 'QQQ ETF 週收盤，只供價格對照，不參與訊號計算（右軸）。',
};
export function seriesTip(name) {
  const k = Object.values(KINDS).find(x => x.label === name);
  return k ? k.tip : SERIES_TIPS[name] || '';
}

// 資料多久沒有更新成功（天）；無法解析時視為過期。
export function staleDays(updatedIso, now = Date.now()) {
  const t = Date.parse(updatedIso || '');
  return Number.isFinite(t) ? (now - t) / 864e5 : Infinity;
}
