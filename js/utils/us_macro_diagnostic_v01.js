// Frozen v0.1 replay. Its full diagnostic dependencies stay here so future
// changes to the current method cannot alter already captured snapshots.
function computeMA(data, period) {
  const out = [];
  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j][1];
    out.push([data[i][0], +(sum / period).toFixed(4)]);
  }
  return out;
}

export const MACRO_DIAGNOSTIC_METHOD_VERSION = 'macro-diagnostic-v0.1';
export const MACRO_DATA_METHOD_VERSION = 'macro-data-v0.1';
const EPS = 1e-9;
const IDS = ['PCEC96', 'DSPIC96', 'NEWORDER', 'INDPRO', 'PAYEMS', 'UNRATE', 'PERMIT', 'ISRATIO'];
const CORE = ['PCEC96', 'DSPIC96', 'INDPRO', 'PAYEMS', 'UNRATE'];
const RULE = {
  PCEC96: { threshold: .25, kind: 'percent' }, DSPIC96: { threshold: .25, kind: 'percent' },
  NEWORDER: { threshold: 1.5, kind: 'percent' }, INDPRO: { threshold: .5, kind: 'percent' },
  PAYEMS: { threshold: .15, kind: 'percent' }, UNRATE: { threshold: .2, kind: 'difference' },
  PERMIT: { threshold: 2, kind: 'percent' }, ISRATIO: { threshold: .03, kind: 'difference' },
};
export const RULES = Object.freeze([
  { id: 'real_income', series_ids: ['DSPIC96'] },
  { id: 'consumption', series_ids: ['PCEC96'] },
  { id: 'nominal_orders', series_ids: ['NEWORDER'] },
  { id: 'industrial_output', series_ids: ['INDPRO'] },
  { id: 'labor', series_ids: ['PAYEMS', 'UNRATE'] },
  { id: 'purchasing_power_feedback', series_ids: ['DSPIC96', 'PCEC96'] },
  { id: 'housing_permits', series_ids: ['PERMIT'] },
  { id: 'inventory_sales_ratio', series_ids: ['ISRATIO'] },
]);

const assert = (ok, message) => { if (!ok) throw new Error(message); };
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function utcSeconds(s) {
  assert(typeof s === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(s) &&
    new Date(s).toISOString().replace('.000Z', 'Z') === s, `invalid UTC second: ${s}`);
  return Date.parse(s);
}
function day(s) {
  assert(typeof s === 'string' && /^\d{4}-\d\d-\d\d$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s, `invalid day: ${s}`);
  return Date.parse(`${s}T00:00:00Z`);
}
function month(s) { assert(typeof s === 'string' && /^\d{4}-\d\d$/.test(s), `invalid month: ${s}`); day(`${s}-01`); return s; }
function monthAdd(s, n) { const d = new Date(`${s}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); }
function monthDistance(a, b) { const [ay, am] = a.split('-').map(Number), [by, bm] = b.split('-').map(Number); return (by - ay) * 12 + bm - am; }
const finiteOrNull = v => v === null || (typeof v === 'number' && Number.isFinite(v));
function ordered(rows, dateKey, validator, label, cutoff) {
  assert(Array.isArray(rows), `${label} rows missing`);
  let prev = null;
  return rows.filter(row => {
    assert(row && typeof row === 'object', `${label} row invalid`);
    const date = row[dateKey];
    dateKey === 'reference_month' ? month(date) : day(date);
    if (date > cutoff) return false;
    assert(prev === null || prev < date, `${label} duplicate or descending date`);
    prev = date;
    validator(row);
    return true;
  });
}
function observationRows(summary, id, cutoff, asOf) {
  const item = summary.indicators[id];
  assert(item && typeof item === 'object' && Array.isArray(item.observations), `missing ${id}`);
  const rows = ordered(item.observations, 'reference_month', row => {
    assert(finiteOrNull(row.value), `${id} invalid value`);
    assert(row.value === null ? row.raw_value === null : typeof row.raw_value === 'string', `${id} invalid raw value`);
    utcSeconds(row.retrieved_at);
    assert(typeof row.event_sha256 === 'string' && /^sha256:[0-9a-f]{64}$/.test(row.event_sha256), `${id} invalid event hash`);
    assert(row.retrieved_at <= asOf, `${id} observation retrieved after asOf`);
  }, id, cutoff);
  return { item, map: new Map(rows.map(x => [x.reference_month, x])) };
}
function windowRows(map, t, n) { const rows = []; for (let i = n - 1; i >= 0; i--) { const x = map.get(monthAdd(t, -i)); if (!x || x.value === null) return null; rows.push(x); } return rows; }
function sign(delta, threshold) { return delta > threshold + EPS ? 'positive' : delta < -threshold - EPS ? 'negative' : 'neutral'; }
function indicatorAt(id, source, t, freshness, sourceStatus) {
  const { item, map } = source;
  const at = t && map.get(t);
  const blocked = sourceStatus === 'failed' || sourceStatus === 'unavailable';
  const result = { reference_month: t, level: at?.value ?? null, level_units: item.units ?? null,
    yoy: null, yoy_units: id === 'UNRATE' ? 'pp' : id === 'ISRATIO' ? 'ratio difference' : '%',
    change_3m: null, change_3m_units: RULE[id].kind === 'percent' ? '%' : id === 'UNRATE' ? 'pp' : 'ratio difference',
    direction: 'insufficient', stale: freshness || blocked, source_status: sourceStatus, evidence: [] };
  if (id === 'ISRATIO') result.movement = 'insufficient';
  if (!t || !at) return result;
  const year = windowRows(map, t, 13);
  if (year) {
    const first = year[0].value;
    if (RULE[id].kind !== 'percent' || first > 0) result.yoy = RULE[id].kind === 'percent' ? 100 * (at.value / first - 1) : at.value - first;
  }
  const quarter = windowRows(map, t, 4);
  result.evidence = quarter ? quarter.map(x => ({ reference_month: x.reference_month, value: x.value, event_sha256: x.event_sha256 })) : [];
  if (!quarter || freshness || blocked) return result;
  const first = quarter[0].value;
  if (RULE[id].kind === 'percent' && first <= 0) return result;
  const delta = RULE[id].kind === 'percent' ? 100 * (at.value / first - 1) : at.value - first;
  result.change_3m = delta;
  if (id === 'ISRATIO') { result.direction = 'unclassified'; result.movement = sign(delta, RULE[id].threshold).replace('positive', 'rising').replace('negative', 'falling').replace('neutral', 'stable'); }
  else { const s = sign(delta, RULE[id].threshold); result.direction = id === 'UNRATE' ? (s === 'positive' ? 'negative' : s === 'negative' ? 'positive' : s) : s; }
  return result;
}
function familyState(ind) {
  const labor = [ind.PAYEMS.direction, ind.UNRATE.direction];
  let laborDirection;
  if (labor.includes('insufficient')) laborDirection = 'insufficient';
  else if (labor[0] === labor[1]) laborDirection = labor[0];
  else if (labor.includes('neutral')) laborDirection = 'neutral';
  else laborDirection = 'divergent';
  return { consumption: { direction: ind.PCEC96.direction, indicators: ['PCEC96'] }, real_income: { direction: ind.DSPIC96.direction, indicators: ['DSPIC96'] },
    industrial_output: { direction: ind.INDPRO.direction, indicators: ['INDPRO'] }, labor: { direction: laborDirection, indicators: ['PAYEMS', 'UNRATE'], component_directions: { PAYEMS: labor[0], UNRATE: labor[1] } } };
}
function familyCounts(f) {
  const dirs = Object.values(f).map(x => x.direction);
  if (dirs.includes('insufficient')) return null;
  return { positive: dirs.filter(x => x === 'positive').length, negative: dirs.filter(x => x === 'negative').length,
    neutral: dirs.filter(x => x === 'neutral').length, divergent: dirs.filter(x => x === 'divergent').length, denominator: 4 };
}
function macroAxis(summary, asOf) {
  const latestComplete = monthAdd(asOf.slice(0, 7), -1);
  const sources = {};
  for (const id of IDS) sources[id] = observationRows(summary, id, latestComplete, asOf);
  const t = summary.coverage?.common_month;
  if (t !== null && t !== undefined) month(t);
  const common = t && t <= latestComplete ? t : null;
  const selected = {};
  for (const id of IDS) {
    const months = [...sources[id].map.keys()];
    selected[id] = CORE.includes(id) ? common : months.at(-1) ?? null;
  }
  const indicators = {};
  for (const id of IDS) {
    const age = selected[id] ? monthDistance(selected[id], latestComplete) : Infinity;
    indicators[id] = indicatorAt(id, sources[id], selected[id], age > (id === 'ISRATIO' ? 3 : 2), summary.source_status[id].last_attempt_status);
  }
  const families = familyState(indicators), counts = familyCounts(families);
  const direction = !counts ? 'insufficient' : counts.positive >= 3 && counts.negative === 0 ? 'improving' : counts.negative >= 3 && counts.positive === 0 ? 'deteriorating' : 'mixed';
  let broad = null, reason = 'previous_or_current_family_insufficient';
  if (counts && common) {
    const prior = {};
    for (const id of CORE) prior[id] = indicatorAt(id, sources[id], monthAdd(common, -1), false, 'success');
    const priorCounts = familyCounts(familyState(prior));
    if (priorCounts) { broad = counts.negative >= 3 && counts.negative > priorCounts.negative; reason = broad ? 'negative_families_expanded_to_at_least_three' : 'narrow_expansion_condition_not_met'; }
  }
  return { reference_month: common, families, counts, direction, broad_weakening: broad, broad_weakening_reason: reason, indicators };
}
function priceAxis(input, symbol, asOf) {
  const base = { reference_date: null, close: null, sma125: null, sma150: null, deviation125_pct: null, deviation150_pct: null,
    state: 'insufficient', stale: true, source: `data/${symbol}.json` };
  if (input === null) return base;
  assert(input && typeof input === 'object', `${symbol} invalid input`);
  const priorDay = new Date(day(asOf.slice(0, 10)) - 86400000).toISOString().slice(0, 10);
  const rows = ordered(input.data, 'date', r => assert(r.close === null || (typeof r.close === 'number' && Number.isFinite(r.close) && r.close > 0), `${symbol} invalid close`), symbol, priorDay);
  const last = rows.at(-1);
  if (!last) return base;
  base.reference_date = last.date; base.close = last.close;
  base.stale = (day(asOf.slice(0, 10)) - day(last.date)) / 86400000 > 7;
  const tail = rows.slice(-150);
  if (base.stale || tail.length < 150 || tail.some(r => r.close === null)) return base;
  const pairs = tail.map(r => [r.date, r.close]);
  base.sma125 = computeMA(pairs, 125).at(-1)[1]; base.sma150 = computeMA(pairs, 150).at(-1)[1];
  base.deviation125_pct = 100 * (last.close / base.sma125 - 1); base.deviation150_pct = 100 * (last.close / base.sma150 - 1);
  base.state = last.close > base.sma125 && last.close > base.sma150 ? 'above_both' : last.close < base.sma125 && last.close < base.sma150 ? 'below_both' : 'between_or_equal';
  return base;
}
function backgroundCpi(input, asOf) {
  const empty = () => ({ reference_date: null, level: null, change: null, change_units: 'pp', direction: 'insufficient', stale: true, evidence_dates: [], status: 'insufficient' });
  const result = { headline: empty(), core: empty() };
  if (input === null) return result;
  assert(input && Array.isArray(input.components), 'invalid cpi components');
  const latestComplete = monthAdd(asOf.slice(0, 7), -1), maps = {};
  const seen = new Set();
  for (const c of input.components) {
    if (!['headline', 'core'].includes(c.key)) continue;
    assert(!seen.has(c.key), 'duplicate CPI component'); seen.add(c.key);
    const rows = ordered(c.data, 'date', r => { assert(r.date.endsWith('-01') && finiteOrNull(r.yoy), 'invalid CPI row'); }, `cpi ${c.key}`, `${latestComplete}-01`);
    maps[c.key] = new Map(rows.map(r => [r.date.slice(0, 7), r]));
    const last = rows.at(-1);
    if (last) { result[c.key].reference_date = last.date; result[c.key].level = last.yoy; }
  }
  const sameMonth = result.headline.reference_date && result.headline.reference_date === result.core.reference_date;
  for (const key of ['headline', 'core']) {
    const out = result[key], t = out.reference_date?.slice(0, 7);
    if (!t) continue;
    out.stale = monthDistance(t, latestComplete) > 2 || !sameMonth;
    const w = maps[key] && windowRows(new Map([...maps[key]].map(([m, r]) => [m, { ...r, value: r.yoy }])), t, 4);
    if (!w || out.stale) continue;
    out.change = w.at(-1).value - w[0].value; out.evidence_dates = w.map(r => r.date);
    out.direction = out.change > .3 + EPS ? 'rising' : out.change < -.3 - EPS ? 'falling' : 'stable'; out.status = 'observed';
  }
  return result;
}
function backgroundHy(input, asOf) {
  const out = { reference_date: null, level: null, change: null, change_units: 'pp', direction: 'insufficient', stale: true, evidence_dates: [], status: 'insufficient' };
  if (input === null) return out;
  assert(input && typeof input === 'object', 'invalid credit spread');
  const priorDay = new Date(day(asOf.slice(0, 10)) - 86400000).toISOString().slice(0, 10);
  const rows = ordered(input.data, 'date', r => assert(finiteOrNull(r.hy), 'invalid HY value'), 'hy', priorDay);
  const last = rows.at(-1); if (!last) return out;
  out.reference_date = last.date; out.level = last.hy; out.stale = (day(asOf.slice(0, 10)) - day(last.date)) / 86400000 > 7;
  const w = rows.slice(-21);
  if (out.stale || w.length < 21 || w.some(r => r.hy === null) || w.some((r, i) => i && (day(r.date) - day(w[i - 1].date)) / 86400000 > 7)) return out;
  out.change = last.hy - w[0].hy; out.evidence_dates = w.map(r => r.date);
  out.direction = out.change > .5 + EPS ? 'widening' : out.change < -.5 - EPS ? 'narrowing' : 'stable'; out.status = 'observed'; return out;
}
const MATRIX = {
  improving: { above_both: 'aligned_support', below_both: 'divergence_price_weak', between_or_equal: 'neutral_price', insufficient: 'insufficient_price' },
  deteriorating: { above_both: 'divergence_macro_weak', below_both: 'aligned_weak', between_or_equal: 'neutral_price', insufficient: 'insufficient_price' },
  mixed: { above_both: 'mixed_macro', below_both: 'mixed_macro', between_or_equal: 'mixed_macro_and_price', insufficient: 'insufficient_price' },
  insufficient: { above_both: 'insufficient_macro', below_both: 'insufficient_macro', between_or_equal: 'insufficient_macro', insufficient: 'insufficient_both' },
};
function transmission(macro, prices, background, comparison, summary) {
  const links = RULES.map(rule => {
    const observation = rule.series_ids.map(id => {
      const { reference_month, level, yoy, change_3m, direction } = macro.indicators[id];
      return { series_id: id, reference_month, level, yoy, change_3m, direction };
    });
    const evidenceBySeriesMonth = new Map();
    for (const id of rule.series_ids) {
      const indicator = macro.indicators[id];
      const referenceMonths = indicator.evidence.map(e => e.reference_month);
      if (indicator.yoy !== null) {
        for (let offset = 12; offset >= 0; offset--) referenceMonths.push(monthAdd(indicator.reference_month, -offset));
      }
      for (const referenceMonth of referenceMonths) {
        const row = summary.indicators[id].observations.find(r => r.reference_month === referenceMonth);
        evidenceBySeriesMonth.set(`${id}:${referenceMonth}`, { series_id: id, reference_month: referenceMonth,
          event_sha256: row.event_sha256, raw_value: row.raw_value, units: indicator.level_units });
      }
    }
    const evidence = [...evidenceBySeriesMonth.values()].sort((a, b) => a.reference_month.localeCompare(b.reference_month) || rule.series_ids.indexOf(a.series_id) - rule.series_ids.indexOf(b.series_id));
    return { id: rule.id, observation, evidence, coverage: observation.every(x => x.direction !== 'insufficient') ? 'observed' : 'insufficient' };
  });
  const checks = [];
  const add = (id, condition, evidence_ids) => checks.push({ id, condition, evidence_ids });
  if (['negative', 'insufficient'].includes(macro.indicators.DSPIC96.direction)) add('income_to_consumption', 'real_income_negative_or_insufficient', ['DSPIC96', 'PCEC96']);
  const o = macro.indicators.NEWORDER.direction, p = macro.indicators.INDPRO.direction;
  if (['positive', 'negative', 'neutral'].includes(o) && ['positive', 'negative', 'neutral'].includes(p) && o !== p) add('orders_to_output', 'nominal_orders_and_output_disagree', ['NEWORDER', 'INDPRO']);
  if (macro.families.labor.direction === 'divergent') add('labor_split', 'labor_divergent', ['PAYEMS', 'UNRATE']);
  for (const symbol of ['SPY', 'QQQ']) {
    if (comparison[symbol].code === 'divergence_macro_weak') add(`macro_price_${symbol}`, 'macro_deteriorating_price_above_both', [...CORE, symbol]);
    if (comparison[symbol].code === 'divergence_price_weak') add(`macro_price_${symbol}`, 'macro_improving_price_below_both', [...CORE, symbol]);
  }
  if (background.hy.direction === 'widening') add('hy_spread', 'hy_widening', ['HY']);
  if (!checks.length) add('next_common_month', 'track_next_common_month_and_both_prices', [...CORE, 'SPY', 'QQQ']);
  return { links, uncovered: ['企業獲利', '估值', '信貸供給傳導', '政策至實體經濟時滯', '總需求因果識別'], next_checks: checks.slice(0, 3) };
}
export function diagnoseUsMacro({ asOf, methodVersion, macroSummary, prices, cpi, creditSpread }) {
  utcSeconds(asOf);
  assert(methodVersion === MACRO_DIAGNOSTIC_METHOD_VERSION, 'unsupported diagnostic method');
  assert(macroSummary && macroSummary.schema_version === 1 && macroSummary.method_version === MACRO_DATA_METHOD_VERSION && macroSummary.view === 'latest_revised' && macroSummary.as_of === asOf, 'B summary version/asOf mismatch');
  assert(typeof macroSummary.generation_id === 'string' && /^sha256:[0-9a-f]{64}$/.test(macroSummary.generation_id), 'B generation missing');
  assert(macroSummary.indicators && typeof macroSummary.indicators === 'object', 'B indicators missing');
  assert(macroSummary.source_status && typeof macroSummary.source_status === 'object' && !Array.isArray(macroSummary.source_status), 'B source_status missing');
  for (const id of IDS) assert(macroSummary.source_status[id] && ['success', 'partial', 'failed', 'unavailable'].includes(macroSummary.source_status[id].last_attempt_status), `B ${id} source status invalid`);
  assert(prices && hasOwn(prices, 'SPY') && hasOwn(prices, 'QQQ'), 'prices missing');
  const macro = macroAxis(macroSummary, asOf);
  const priceResults = { SPY: priceAxis(prices.SPY, 'SPY', asOf), QQQ: priceAxis(prices.QQQ, 'QQQ', asOf) };
  const background = { cpi: backgroundCpi(cpi, asOf), hy: backgroundHy(creditSpread, asOf) };
  const comparison = {};
  for (const symbol of ['SPY', 'QQQ']) comparison[symbol] = { code: MATRIX[macro.direction][priceResults[symbol].state], macro_reference_month: macro.reference_month,
    price_reference_date: priceResults[symbol].reference_date, as_of: asOf, macro_generation_id: macroSummary.generation_id, evidence_ids: [...CORE, symbol] };
  return { schema_version: 1, method_version: methodVersion, as_of: asOf, view: 'latest_revised_not_pit', generation_id: macroSummary.generation_id,
    macro, prices: priceResults, background, comparison, transmission: transmission(macro, priceResults, background, comparison, macroSummary),
    divergence_history: { status: 'unsupported', observed_since: null, observed_snapshots: null, reason: 'diagnostic_snapshots_not_supplied' } };
}
