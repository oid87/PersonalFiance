// Existing snapshots only. No daily/monthly alignment, fallback series or financial signals.
export const TAIWAN_OBSERVATION_SOURCES = Object.freeze([
  Object.freeze({ key: 'index', file: 'data/TWII.json', basis: 'Yahoo/yfinance · 加權指數原始收盤 · 供應商資料',
    metrics: Object.freeze([{ key: 'twii', label: '加權指數', field: 'close', unit: '點' }]) }),
  Object.freeze({ key: 'maintenance', file: 'data/taiwan_margin_ratio.json',
    basis: 'TWSE 上市融資多頭 · 含配對 ETF · 擔保品／融資金額重建代理',
    metrics: Object.freeze([{ key: 'maintenance', label: '融資維持率（重建代理）', field: 'ratio', unit: '%' }]) }),
  Object.freeze({ key: 'margin', file: 'data/taiwan_margin_total.json', basis: 'FinMind · TWSE 上市融資金額 · 不含上櫃',
    metrics: Object.freeze([{ key: 'margin', label: '上市融資餘額', field: 'margin_money', unit: '新臺幣億元' }]) }),
  Object.freeze({ key: 'money', file: 'data/taiwan_money_supply.json', basis: '中央銀行 · 月頻期底 · 非日平均',
    metrics: Object.freeze([
      { key: 'm1b', label: 'M1B 年增率', field: 'm1b_yoy', unit: '%' },
      { key: 'm2', label: 'M2 年增率', field: 'm2_yoy', unit: '%' },
      { key: 'spread', label: 'M1B − M2 年增率差', field: 'spread', unit: '百分點' },
    ]) }),
]);

const validDate = date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
  && !Number.isNaN(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
const sourceByKey = key => {
  const source = TAIWAN_OBSERVATION_SOURCES.find(item => item.key === key);
  if (!source) throw new Error('未知台灣觀察來源');
  return source;
};
const baseRow = (source, metric) => ({ key: metric.key, label: metric.label, unit: metric.unit,
  file: source.file, basis: source.basis, frequency: source.key === 'money' ? 'monthly' : 'daily' });

export function unavailableTaiwanRows(key, reason) {
  const source = sourceByKey(key);
  return source.metrics.map(metric => ({ ...baseRow(source, metric), value: null,
    observation: null, updated: null, status: 'unavailable', reason }));
}

export function taiwanObservationRows(key, payload) {
  const source = sourceByKey(key);
  const data = key === 'money' ? payload?.monthly : payload?.data;
  if (!Array.isArray(data) || !data.length) throw new Error(key === 'money' ? '沒有月頻觀察；不以年資料替代' : '沒有觀察資料');
  const seen = new Set();
  for (const row of data) {
    if (!validDate(row?.date) || seen.has(row.date)) throw new Error('觀察日期無效或重複');
    if (key === 'money' && (row.freq !== 'monthly' || !row.date.endsWith('-01'))) throw new Error('貨幣資料不是既有月頻期底標記');
    seen.add(row.date);
  }
  const latest = [...data].sort((a, b) => a.date.localeCompare(b.date)).at(-1);
  const updated = typeof payload.updated === 'string' ? payload.updated : null;
  return source.metrics.map(metric => {
    const raw = latest[metric.field];
    const row = { ...baseRow(source, metric), observation: key === 'money' ? latest.date.slice(0, 7) : latest.date,
      updated, value: Number.isFinite(raw) ? raw : null, status: Number.isFinite(raw) ? 'available' : 'missing',
      reason: Number.isFinite(raw) ? '既有快照原值' : raw === null ? '最新觀察明示 null' : raw === undefined ? '最新觀察未提供此欄' : '最新觀察不是有限數值' };
    if (raw !== undefined && raw !== null && !Number.isFinite(raw)) row.status = 'invalid';
    if (metric.key === 'spread' && row.status === 'available') {
      // Producer serializes spread to three decimals. This verifies that stored value;
      // it never replaces or creates a missing spread or changes its direction.
      if (!Number.isFinite(latest.m1b_yoy) || !Number.isFinite(latest.m2_yoy)) {
        row.value = null; row.status = 'unavailable'; row.reason = '差值原值無法與缺失的 M1B／M2 核對';
      } else if (Math.abs(raw - (latest.m1b_yoy - latest.m2_yoy)) > 0.0005 + Number.EPSILON * Math.max(1, Math.abs(raw), Math.abs(latest.m1b_yoy), Math.abs(latest.m2_yoy))) {
        row.value = null; row.status = 'invalid'; row.reason = '儲存差值與同月 M1B − M2 不一致';
      } else row.reason = '既有 spread 原值；已核對同月 M1B − M2（三位小數儲存精度）';
    }
    return row;
  });
}

export async function loadTaiwanObservations({ request, signal, force = false, onInvalid = () => {} }) {
  const results = await Promise.allSettled(TAIWAN_OBSERVATION_SOURCES.map(async source => {
    const payload = await request(source.file, { signal, force });
    try {
      const rows = taiwanObservationRows(source.key, payload);
      if (rows.some(row => row.status === 'invalid') && !signal?.aborted) onInvalid(source.file);
      return rows;
    } catch (error) { if (!signal?.aborted) onInvalid(source.file); throw error; }
  }));
  if (signal?.aborted) throw signal.reason || new DOMException('Request aborted', 'AbortError');
  return results.flatMap((result, i) => result.status === 'fulfilled' ? result.value
    : unavailableTaiwanRows(TAIWAN_OBSERVATION_SOURCES[i].key, `來源不可用：${result.reason?.message ?? result.reason}`));
}
