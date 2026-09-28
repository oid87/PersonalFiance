import { mean, percentile } from './math.js';

export const HORIZONS = Object.freeze([5, 10, 21, 42, 63, 126, 252]);

function validDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const time = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date;
}

function integer(value, name, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) throw new TypeError(`${name} must be an integer >= ${minimum}`);
}

function validatePrices(prices) {
  if (!Array.isArray(prices)) throw new TypeError('prices must be an array');
  const indexes = new Map();
  prices.forEach((row, i) => {
    if (!row || !validDate(row.date)) throw new TypeError('Invalid price date');
    if (i && row.date <= prices[i - 1].date) throw new TypeError('Price dates must be strictly increasing and unique');
    if (row.close !== null && (typeof row.close !== 'number' || !Number.isFinite(row.close) || row.close <= 0)) {
      throw new TypeError('Price close must be null or finite and positive');
    }
    indexes.set(row.date, i);
  });
  return indexes;
}

function summarize(outcomes) {
  const complete = outcomes.filter(o => o.status === 'complete');
  const result = { n: complete.length };
  for (const [field, avg, med, worst] of [
    ['forwardReturnPct', 'mean', 'median', null],
    ['maxLossPct', 'meanMaxLoss', 'medianMaxLoss', 'worstMaxLoss'],
    ['mddPct', 'meanMdd', 'medianMdd', 'worstMdd'],
  ]) {
    const values = complete.map(o => o[field]).sort((a, b) => a - b);
    result[avg] = mean(values);
    result[med] = percentile(values, 0.5);
    if (worst) result[worst] = values.length ? values[0] : null;
  }
  result.winRate = complete.length ? 100 * complete.filter(o => o.forwardReturnPct > 0).length / complete.length : null;
  return result;
}

function outcome(prices, index, horizon) {
  const end = index + horizon;
  const result = { status: 'incomplete', exitDate: prices[end]?.date ?? null,
    forwardReturnPct: null, maxLossPct: null, mddPct: null };
  if (end >= prices.length) return result;
  const path = prices.slice(index, end + 1).map(row => row.close);
  if (path.some(close => close === null)) return { ...result, status: 'missingPrice' };
  const anchor = path[0];
  let peak = anchor, loss = 0, drawdown = 0;
  for (const close of path) {
    peak = Math.max(peak, close);
    loss = Math.min(loss, close / anchor - 1);
    drawdown = Math.min(drawdown, close / peak - 1);
  }
  return { ...result, status: 'complete', forwardReturnPct: 100 * (path.at(-1) / anchor - 1),
    maxLossPct: 100 * loss, mddPct: 100 * drawdown };
}

/** Descriptive close-price outcomes on the supplied ETF session axis. */
export function evaluateEventStudy({ prices, events, eligibleDates, horizons = HORIZONS,
  from = null, to = null, cooldownSessions = 20, pathHorizon = 63 }) {
  const indexes = validatePrices(prices);
  integer(cooldownSessions, 'cooldownSessions');
  integer(pathHorizon, 'pathHorizon');
  if (!Array.isArray(horizons) || new Set(horizons).size !== horizons.length) throw new TypeError('horizons must be a unique array');
  horizons.forEach(h => integer(h, 'horizon', 1));
  for (const bound of [from, to]) if (bound !== null && !validDate(bound)) throw new TypeError('Invalid study range date');
  if (from !== null && to !== null && from > to) throw new RangeError('from must be <= to');
  const inRange = date => (from === null || date >= from) && (to === null || date <= to);
  if (!Array.isArray(eligibleDates) || !Array.isArray(events)) throw new TypeError('events and eligibleDates must be arrays');
  const eligible = new Set();
  for (const date of eligibleDates) {
    if (!validDate(date) || !indexes.has(date)) throw new TypeError('Eligible date must be on the price axis');
    eligible.add(date);
  }
  const unique = new Map();
  for (const event of events) {
    if (!event || !validDate(event.date) || !indexes.has(event.date)) throw new TypeError('Event date must be on the price axis');
    if (eligible.has(event.date) && !unique.has(event.date)) unique.set(event.date, event);
  }
  const raw = [...unique.values()].sort((a, b) => a.date.localeCompare(b.date));
  let previous = -Infinity;
  const kept = raw.filter(event => {
    const index = indexes.get(event.date);
    if (index - previous < cooldownSessions) return false;
    previous = index;
    return true;
  }).filter(event => inRange(event.date));
  const evaluated = kept.map(event => ({ ...event, outcomes: Object.fromEntries(
    horizons.map(h => [h, outcome(prices, indexes.get(event.date), h)])) }));
  const baselineIndexes = [...eligible].filter(inRange).map(date => indexes.get(date)).sort((a, b) => a - b);
  const stats = horizons.map(horizon => {
    const outcomes = evaluated.map(event => event.outcomes[horizon]);
    const completeIndexes = evaluated.filter(event => event.outcomes[horizon].status === 'complete').map(event => indexes.get(event.date));
    let overlapPairs = 0;
    for (let i = 1; i < completeIndexes.length; i++) if (completeIndexes[i] < completeIndexes[i - 1] + horizon) overlapPairs++;
    return { horizon, ...summarize(outcomes),
      baseline: summarize(baselineIndexes.map(index => outcome(prices, index, horizon))),
      overlapPairs, possiblePairs: Math.max(completeIndexes.length - 1, 0),
      excluded: { incomplete: outcomes.filter(o => o.status === 'incomplete').length,
        missingPrice: outcomes.filter(o => o.status === 'missingPrice').length } };
  });
  const individual = kept.map(event => {
    const index = indexes.get(event.date), anchor = prices[index].close;
    let broken = anchor === null;
    const values = Array.from({ length: pathHorizon + 1 }, (_, offset) => {
      const close = prices[index + offset]?.close ?? null;
      if (close === null) broken = true;
      return broken ? null : offset === 0 ? 100 : 100 * close / anchor;
    });
    return { date: event.date, complete: !broken, values };
  });
  const cohort = individual.filter(path => path.complete);
  const points = Array.from({ length: pathHorizon + 1 }, (_, offset) => {
    const values = cohort.map(path => path.values[offset]).sort((a, b) => a - b);
    return { offset, n: values.length, median: percentile(values, 0.5), p25: percentile(values, 0.25), p75: percentile(values, 0.75) };
  });
  return { rawN: raw.filter(event => inRange(event.date)).length, keptN: kept.length,
    events: evaluated, stats, paths: { horizon: pathHorizon, n: cohort.length, points, individual } };
}
