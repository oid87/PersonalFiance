/** Descriptive risk event study. No trading recommendations; archive times are never backdated. */
import { percentile } from '../utils/math.js';

const DAY = 86400000;
const NY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const finite = v => typeof v === 'number' && Number.isFinite(v);
const validDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
const validTime = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|\+00:00)$/.test(s) && Number.isFinite(Date.parse(s)) && validDate(s.slice(0, 10));
const nyDate = t => { const p = Object.fromEntries(NY.formatToParts(new Date(t)).map(x => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}`; };
// Find next local midnight, including the spring/fall DST transitions, without host timezone assumptions.
function cutoff(date) {
  const next = new Date(Date.parse(date) + DAY).toISOString().slice(0, 10);
  let lo = Date.parse(next), hi = lo + DAY;
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (nyDate(mid) < next) lo = mid; else hi = mid; }
  return hi - 1;
}
const available = (r, t) => Date.parse(r.observed_at) <= t && (!r.published_at || Date.parse(r.published_at) <= t);
const goodBar = r => r && ['open', 'high', 'low', 'close'].every(k => finite(r.values[k]) && r.values[k] > 0) && r.values.low <= Math.min(r.values.open, r.values.close) && r.values.high >= Math.max(r.values.open, r.values.close);
const scalar = r => r && finite(r.values.value) ? r.values.value : null;
const byVersion = (a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at) || JSON.stringify(a.values).localeCompare(JSON.stringify(b.values));
function indexBundle(bundle) {
  return Object.fromEntries(Object.entries(bundle.series).map(([id, s]) => {
    const dates = new Map();
    for (const r of s.records) { if (!dates.has(r.date)) dates.set(r.date, []); dates.get(r.date).push(r); }
    for (const versions of dates.values()) versions.sort(byVersion);
    return [id, { meta: s.meta, dates, axis: [...dates.keys()].sort(), finalTime: Date.parse(bundle.generated_at) }];
  }));
}
function recordAt(ix, id, date, t, historical = false) {
  const rows = ix[id]?.dates.get(date) || [];
  for (let i = rows.length - 1; i >= 0; i--) if (available(rows[i], historical ? ix[id].finalTime : t)) return rows[i];
  return null;
}
function newest(ix, id, date, t) {
  const axis = ix[id]?.axis || [];
  for (let i = axis.length - 1; i >= 0; i--) if (axis[i] <= date) { const r = recordAt(ix, id, axis[i], t); if (r) return r; }
  return null;
}
export function validateBundle(bundle) {
  if (!bundle || bundle.schema_version !== 1 || !validTime(bundle.generated_at) || !bundle.series || typeof bundle.series !== 'object') throw new Error('Invalid US risk archive schema');
  for (const id of ['SPY', 'QQQ']) if (!bundle.series[id]?.records?.length) throw new Error(`Unavailable core source: ${id}`);
  for (const [id, s] of Object.entries(bundle.series)) {
    if (!s.meta || !['daily', 'weekly', 'monthly'].includes(s.meta.frequency) || !Array.isArray(s.records)) throw new Error(`Invalid series: ${id}`);
    const versions = new Set();
    for (const r of s.records) {
      const key = `${r.date}|${r.observed_at}`;
      if (versions.has(key) || Date.parse(r.observed_at) > Date.parse(bundle.generated_at)) throw new Error(`Invalid observation version: ${id}`);
      versions.add(key);
      if (!validDate(r.date) || !validTime(r.observed_at) || (r.published_at != null && !validTime(r.published_at)) || !r.values || typeof r.values !== 'object' || Array.isArray(r.values) || typeof r.source_hash !== 'string' || !/^[a-f\d]{64}$/i.test(r.source_hash)) throw new Error(`Invalid observation: ${id}`);
      if (Object.values(r.values).some(v => v !== null && !finite(v))) throw new Error(`Invalid numeric values: ${id}`);
    }
  }
  return bundle;
}
export function rollContaminated(date) {
  if (!validDate(date)) throw new Error('Invalid report date');
  const d = new Date(date), year = d.getUTCFullYear();
  return [2, 5, 8, 11].some(month => {
    const first = new Date(Date.UTC(year, month, 1));
    const friday = 1 + (5 - first.getUTCDay() + 7) % 7 + 14;
    const monday = Date.UTC(year, month, friday - 4);
    return +d >= monday && +d < monday + 14 * DAY;
  });
}
function confirmations(ix, date, t = cutoff(date)) {
  const out = {};
  for (const [id, s] of Object.entries(ix)) {
    if (!['weekly', 'monthly'].includes(s.meta.frequency)) continue;
    const r = newest(ix, id, date, t);
    if (!r) { out[id] = null; continue; }
    out[id] = { ...r };
    if (id.startsWith('CFTC_')) {
      const grossOf = v => v && finite(v.values.long) && v.values.long >= 0 && finite(v.values.short) && v.values.short >= 0 ? v.values.long + v.values.short : null;
      const priorDate = new Date(Date.parse(r.date) - 7 * DAY).toISOString().slice(0, 10);
      const prev = recordAt(ix, id, priorDate, t), gross = grossOf(r), prior = grossOf(prev), roll = rollContaminated(r.date);
      out[id] = { ...r, gross, rollContaminated: roll, change: !roll && !rollContaminated(priorDate) && prior > 0 && gross !== null ? (gross / prior - 1) * 100 : null };
    }
  }
  return out;
}
export function confirmationAt(bundle, date) { validateBundle(bundle); if (!validDate(date)) throw new Error('Invalid cutoff date'); return confirmations(indexBundle(bundle), date); }
export function latestOverview(bundle, asOf = bundle.generated_at) {
  validateBundle(bundle);
  if (!validTime(asOf)) throw new Error('Invalid overview cutoff');
  const ix = indexBundle(bundle), date = nyDate(asOf), out = {};
  for (const [id, s] of Object.entries(ix)) {
    const r = newest(ix, id, date, Date.parse(asOf)), age = r ? Math.floor((Date.parse(date) - Date.parse(r.date)) / DAY) : null;
    out[id] = { record: r, date: r?.date || null, observed_at: r?.observed_at || null, age, stale: age === null || age > ({ daily: 5, weekly: 14, monthly: 65 }[s.meta.frequency]), available: !!r, meta: s.meta };
  }
  return out;
}
function configuration(bundle, supplied) {
  const defaults = { vix: 30, vxn: 30, relative: -5, semis: -5, term: 1, breadth: 30 };
  const c = { asset: 'QQQ', dataMode: 'strict', mode: 'vix', gate: 8, thresholdMode: 'fixed', percentile: ['relative', 'semis', 'breadth'].includes(supplied.mode) ? 10 : 90, cooldown: 10, horizon: 20, from: '2020-01-01', to: nyDate(bundle.generated_at), ...supplied };
  c.threshold ??= defaults[c.mode];
  if (!['SPY', 'QQQ'].includes(c.asset) || !['strict', 'historical'].includes(c.dataMode) || !(c.mode in defaults) || !['fixed', 'percentile'].includes(c.thresholdMode) || ![0, 8, 10, 15].includes(c.gate) || ![5, 10, 20, 60].includes(c.horizon) || !Number.isInteger(c.cooldown) || c.cooldown < 1 || !finite(c.threshold) || !finite(c.percentile) || c.percentile < 0 || c.percentile > 100 || !validDate(c.from) || !validDate(c.to) || c.from > c.to || c.to > nyDate(bundle.generated_at)) throw new Error('Invalid study configuration');
  return c;
}
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b), q = p => sorted.length ? percentile(sorted, p) : null;
  return { N: sorted.length, median: q(.5), p10: q(.1), p25: q(.25), p75: q(.75), p90: q(.9), min: sorted[0] ?? null, max: sorted.at(-1) ?? null, values };
}
function accept(days, predicate, spacing) {
  const selected = []; let last = -Infinity;
  for (const d of days) if (d.eligible && predicate(d) && d.index - last >= spacing) { selected.push(d); last = d.index; }
  return selected;
}
function outcome(ix, axis, index, c, finalTime, alert) {
  const entryDate = axis[index + 1] || null;
  if (!entryDate || index + c.horizon >= axis.length || axis[index + c.horizon] > nyDate(finalTime)) return { entryDate, entryPrice: null, outcome: { status: 'rightCensored' } };
  const bars = axis.slice(index + 1, index + 1 + c.horizon).map(date => recordAt(ix, c.asset, date, Date.parse(finalTime)));
  if (!goodBar(alert) || bars.some(r => !goodBar(r))) return { entryDate, entryPrice: null, outcome: { status: 'badPrice' } };
  const entry = bars[0].values.open; let peak = entry, mdd = 0;
  for (const r of bars) { peak = Math.max(peak, r.values.close); mdd = Math.min(mdd, (r.values.close / peak - 1) * 100); }
  return { entryDate, entryPrice: entry, outcome: { status: 'complete', return: (bars.at(-1).values.close / entry - 1) * 100, maxLoss: Math.min(0, ...bars.map(r => (r.values.low / entry - 1) * 100)), mdd, rebreak: bars.some(r => r.values.low < alert.values.low) } };
}
function summarize(events, nonOverlapping, rawFlagDays, eligibleN) {
  const complete = events.filter(e => e.outcome.status === 'complete');
  return { N: complete.length, eligibleN, rawFlagDays, eventCount: events.length, nonOverlappingCount: nonOverlapping.length, complete: complete.length, rightCensored: events.filter(e => e.outcome.status === 'rightCensored').length, badPrice: events.filter(e => e.outcome.status === 'badPrice').length, return: distribution(complete.map(e => e.outcome.return)), maxLoss: distribution(complete.map(e => e.outcome.maxLoss)), mdd: distribution(complete.map(e => e.outcome.mdd)), rebreakRate: complete.length ? complete.filter(e => e.outcome.rebreak).length / complete.length * 100 : null, nonOverlapping };
}
export function runStudy(bundle, supplied = {}) {
  validateBundle(bundle);
  const config = configuration(bundle, supplied), c = config, ix = indexBundle(bundle), axis = [...new Set([...ix.SPY.axis, ...ix.QQQ.axis])].sort().filter(d => d <= nyDate(bundle.generated_at)), historical = c.dataMode === 'historical', generated = Date.parse(bundle.generated_at);
  const indicator = (i, t) => {
    const date = axis[i], get = (id, d = date) => recordAt(ix, id, d, t, historical), value = id => scalar(get(id));
    if (c.mode === 'vix' || c.mode === 'vxn') return value(c.mode.toUpperCase());
    if (c.mode === 'term') { const vix = value('VIX'), term = value('VIX3M'); return vix !== null && term > 0 ? vix / term : null; }
    if (c.mode === 'breadth') return !historical && ix.NDX_BREADTH?.meta.history_eligible === true ? value('NDX_BREADTH') : null;
    if (i < 20) return null;
    const [num, den] = c.mode === 'relative' ? ['QQQ', 'SPY'] : ['SOXX', 'QQQ'];
    const a = get(num), b = get(den), oldA = get(num, axis[i - 20]), oldB = get(den, axis[i - 20]);
    return [a, b, oldA, oldB].every(goodBar) ? (a.values.close / b.values.close / (oldA.values.close / oldB.values.close) - 1) * 100 : null;
  };
  const days = [];
  for (let i = 0; i < axis.length; i++) {
    const date = axis[i]; if (date < c.from || date > c.to) continue;
    const t = Math.min(cutoff(date), generated), bar = recordAt(ix, c.asset, date, t, historical), value = indicator(i, t);
    const lookback = axis.slice(Math.max(0, i - 119), i + 1).map(d => recordAt(ix, c.asset, d, t, historical));
    const drawdown = lookback.length === 120 && lookback.every(goodBar) ? (1 - bar.values.close / Math.max(...lookback.map(r => r.values.close))) * 100 : null;
    let threshold = c.threshold;
    if (c.thresholdMode === 'percentile') {
      const past = [];
      for (let j = Math.max(0, i - 252); j < i; j++) { const v = indicator(j, t); if (finite(v)) past.push(v); }
      threshold = past.length >= 126 ? percentile(past.sort((a, b) => a - b), c.percentile / 100) : null;
    }
    const eligible = !!goodBar(bar) && finite(drawdown) && finite(value) && finite(threshold), condition = eligible && (['relative', 'semis', 'breadth'].includes(c.mode) ? value <= threshold : value >= threshold);
    days.push({ date, index: i, close: goodBar(bar) ? bar.values.close : null, drawdown, indicator: value, threshold, eligible, condition, flag: condition && drawdown >= c.gate, reason: eligible ? null : !goodBar(bar) ? 'priceUnavailable' : drawdown === null ? 'lookbackUnavailable' : value === null ? 'indicatorUnavailable' : 'percentileHistoryUnavailable' });
  }
  const eligibleN = days.filter(d => d.eligible).length;
  const makeEvent = d => ({ date: d.date, index: d.index, drawdown: d.drawdown, indicator: d.indicator, threshold: d.threshold, ...outcome(ix, axis, d.index, c, bundle.generated_at, recordAt(ix, c.asset, d.date, Math.min(cutoff(d.date), generated), historical)) });
  const predicates = { all: () => true, drawdownMatched: d => d.drawdown >= c.gate, singleIndicator: d => d.condition, signal: d => d.flag };
  const groups = {};
  for (const [name, predicate] of Object.entries(predicates)) {
    const events = accept(days, predicate, c.cooldown).map(makeEvent), independent = accept(days, predicate, Math.max(c.cooldown, c.horizon)).map(makeEvent);
    groups[name] = { events, stats: summarize(events, independent, days.filter(d => d.eligible && predicate(d)).length, eligibleN) };
  }
  const events = groups.signal.events;
  for (const e of events) {
    e.confirmation = confirmations(ix, e.date, Math.min(cutoff(e.date), generated));
    e.laterConfirmation = {};
    const eventCutoff = cutoff(e.date), generatedDate = nyDate(generated);
    for (const [id, s] of Object.entries(ix)) {
      if (!['weekly', 'monthly'].includes(s.meta.frequency)) continue;
      const rows = [...s.dates.values()].flat().filter(r => r.date >= e.date && r.date <= generatedDate && Math.max(Date.parse(r.observed_at), r.published_at ? Date.parse(r.published_at) : 0) > eventCutoff && available(r, generated));
      rows.sort((a, b) => Math.max(Date.parse(a.observed_at), Date.parse(a.published_at || a.observed_at)) - Math.max(Date.parse(b.observed_at), Date.parse(b.published_at || b.observed_at)) || a.date.localeCompare(b.date));
      const firstTime = rows.length ? Math.max(Date.parse(rows[0].observed_at), Date.parse(rows[0].published_at || rows[0].observed_at)) : null;
      const later = firstTime === null ? null : newest(ix, id, nyDate(firstTime), firstTime);
      e.laterConfirmation[id] = later && later.date >= e.date ? later : null;
    }
  }
  const episodes = []; let wave = null;
  for (const [position, d] of days.entries()) {
    if (!wave && d.drawdown !== null && d.drawdown >= 8) wave = { start: d.date, startIndex: d.index, days: [], leftCensored: position === 0 || days[position - 1].drawdown === null };
    if (wave) { wave.days.push(d); if (d.drawdown !== null && d.drawdown < 3) { wave.end = d.date; episodes.push(wave); wave = null; } }
  }
  if (wave) { wave.end = null; episodes.push(wave); }
  for (const e of episodes) {
    e.coverage = e.days.filter(d => d.eligible).length / e.days.length;
    e.censored = !e.end || e.leftCensored || e.coverage !== 1;
    e.eventCount = events.filter(v => v.date >= e.start && (!e.end || v.date <= e.end)).length;
    e.missed = e.censored ? null : e.eventCount === 0;
    delete e.days;
  }
  const classified = episodes.filter(e => !e.censored), outside = events.filter(e => e.outcome.status === 'complete' && !episodes.some(w => e.date >= w.start && (!w.end || e.date <= w.end)));
  return { config, days, events, stats: groups.signal.stats, baselines: Object.fromEntries(['all', 'drawdownMatched', 'singleIndicator'].map(k => [k, groups[k]])), coverage: { totalDays: days.length, eligibleDays: eligibleN, ratio: days.length ? eligibleN / days.length : null }, diagnostics: { historicalNonPIT: historical, smallSample: groups.signal.stats.N < 30, missedEpisodes: classified.filter(e => e.missed).length, evaluatedEpisodes: classified.length, missedRate: classified.length ? classified.filter(e => e.missed).length / classified.length * 100 : null, falseAlarms: outside.length, falseAlarmDefinition: 'Accepted complete events outside observed drawdown episodes; not a bottom-prediction metric', falseAlarmDates: outside.map(e => e.date), outcomeAnchor: 'Next asset session open; horizon includes entry session; raw prices, no dividends or costs' }, episodes, latest: latestOverview(bundle) };
}
