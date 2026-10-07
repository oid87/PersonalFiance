import { SERIES, CK_ASSETS } from '../state.js';
import { monthlyReturnHeatmapModel } from '../tabs/monthly_return_heatmap.mjs';

// Existing price file catalogue only. No arbitrary URLs or provider fallback.
export const TOOL_INSTRUMENTS = Object.freeze([...new Map([
  ...SERIES.filter(item => !['VIX', 'F&G'].includes(item.key)), ...CK_ASSETS,
].map(item => [item.key, Object.freeze({ key: item.key, label: item.key, file: item.file })])).values()]);

export function latestPrice(payload) {
  if (!Array.isArray(payload?.data) || !payload.data.length) throw new Error('本地價格檔沒有觀測資料');
  const rows = payload.data.map(row => {
    if (!row || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !Number.isFinite(row.close)) throw new Error('本地價格觀測格式無效');
    return { date: row.date, close: row.close };
  }).sort((a, b) => a.date.localeCompare(b.date));
  return { ...rows.at(-1), updated: typeof payload.updated === 'string' ? payload.updated : null };
}

export function diagnosticSettings(values, availableIds) {
  const initial = Number(values.initial), dcaAmount = Number(values.dcaAmount);
  if (!availableIds.includes(values.etf)) throw new Error('請選擇本地 bundle 中的 ETF');
  const date = value => value === '' || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
  if (!date(values.from) || !date(values.to) || (values.from && values.to && values.from > values.to)) throw new Error('請提供有效且依序的起迄日期');
  if (!Number.isFinite(initial) || initial <= 0 || !Number.isFinite(dcaAmount) || dcaAmount < 0) throw new Error('初始投入須大於零；每月投入須為非負有限值');
  return { etf: values.etf, from: values.from, to: values.to, initial, dca: values.dca === true, dcaAmount };
}

export function suppliedMonthlyReturns(payload) {
  if (payload?.schemaVersion !== 1 || !['supplied', 'synthetic'].includes(payload.kind)
    || !['source', 'basis', 'calculationLabel'].every(key => typeof payload[key] === 'string' && payload[key].trim())) {
    throw new Error('需要 schemaVersion 1、kind、source、basis 與 calculationLabel');
  }
  const model = monthlyReturnHeatmapModel(payload.rows);
  return { kind: payload.kind, source: payload.source.trim(), basis: payload.basis.trim(),
    calculationLabel: payload.calculationLabel.trim(), model };
}

export const SYNTHETIC_MONTHLY_DEMO = Object.freeze({ schemaVersion: 1, kind: 'synthetic',
  source: '人工建立的合成示範，非市場資料', basis: '測試百分比，不代表任何金融標的',
  calculationLabel: '直接呈現示範輸入值；無金融報酬換算', rows: Object.freeze([
    Object.freeze({ month: '2025-01', returnPct: 2.25, partial: false, from: 'demo-start', to: 'demo-end' }),
    Object.freeze({ month: '2025-02', returnPct: -1.5, partial: false }),
    Object.freeze({ month: '2025-03', returnPct: 0, partial: false }),
    Object.freeze({ month: '2025-04', returnPct: null, partial: false }),
    Object.freeze({ month: '2025-06', returnPct: 0.5, partial: true }),
  ]) });

// Latest-result lifecycle independent of DOM. Destroy/next abort the prior consumer.
export function latestTask() {
  let version = 0, controller = null, disposed = false;
  return {
    async run(work, commit, fail) {
      if (disposed) return;
      const mine = ++version;
      controller?.abort();
      const current = new AbortController(); controller = current;
      try {
        const value = await work(current.signal);
        if (!disposed && mine === version && !current.signal.aborted) commit(value);
      } catch (error) {
        if (!disposed && mine === version && !current.signal.aborted) fail(error);
      }
    },
    destroy() { disposed = true; version++; controller?.abort(); },
  };
}
