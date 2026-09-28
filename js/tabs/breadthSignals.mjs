import { mean } from '../utils/math.js';

function validateRows(rows, name, checkClose = false) {
  if (!Array.isArray(rows)) throw new TypeError(`${name} must be an array`);
  rows.forEach((row, i) => {
    const date = row?.date;
    const time = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date) throw new TypeError(`Invalid ${name} date`);
    if (i && date <= rows[i - 1].date) throw new TypeError(`${name} dates must be strictly increasing and unique`);
    if (checkClose && row.close !== null && (typeof row.close !== 'number' || !Number.isFinite(row.close) || row.close <= 0)) {
      throw new TypeError('Price close must be null or finite and positive');
    }
  });
}

function validateWindow(window) {
  if (![20, 50, 200].includes(window)) throw new RangeError('MA window must be 20, 50 or 200');
}

function positiveInteger(value) { return Number.isInteger(value) && value > 0; }
function validPct(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100; }

export function getBreadthDenominator(row, window) {
  validateWindow(window);
  const explicit = row?.[`above${window}_total`];
  if (positiveInteger(explicit)) return explicit;
  return window === 50 && positiveInteger(row?.total) ? row.total : null;
}

/** Signal confirmation uses adjacent ETF sessions and full historical warmup. */
export function buildBreadthContext(rows, prices, maWindow = 50) {
  validateWindow(maWindow);
  validateRows(rows, 'Breadth');
  validateRows(prices, 'Price', true);
  const byDate = new Map(rows.map(row => [row.date, row]));
  const signals = { down: [], up: [], divergence: [] }, eligibleDates = [];
  const maByDate = {}, peakByDate = {}, hindenburgDates = [];
  const sessions = prices.map((price, index) => {
    const row = byDate.get(price.date) ?? null;
    const pct = validPct(row?.[`above${maWindow}_pct`]) ? row[`above${maWindow}_pct`] : null;
    const window = prices.slice(Math.max(0, index - maWindow + 1), index + 1);
    const ma = window.length === maWindow && window.every(p => p.close !== null) ? mean(window.map(p => p.close)) : null;
    maByDate[price.date] = ma;
    const aboveMA = price.close !== null && ma !== null ? price.close > ma : null;
    return { date: price.date, close: price.close, ma, pct, denominator: getBreadthDenominator(row, maWindow), row,
      aboveMA, divergent: aboveMA !== null && pct !== null ? aboveMA && pct < 50 : null, eligible: false };
  });
  let current = null, currentIndex = -1;
  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i], previous = sessions[i - 1];
    const valid = s => s && s.pct !== null && s.close !== null && s.ma !== null;
    session.eligible = Boolean(valid(session) && valid(previous));
    if (session.row && session.close !== null) { current = session; currentIndex = i; }
    if (session.eligible) {
      eligibleDates.push(session.date);
      const evidence = { date: session.date, pct: session.pct, previousPct: previous.pct,
        close: session.close, ma: session.ma, denominator: session.denominator };
      if (previous.pct >= 50 && session.pct < 50) signals.down.push({ ...evidence });
      if (previous.pct < 50 && session.pct >= 50) signals.up.push({ ...evidence });
      if (session.divergent && previous.divergent === false) signals.divergence.push({ ...evidence });
    }
    const peakWindow = sessions.slice(Math.max(0, i - 89), i + 1);
    peakByDate[session.date] = peakWindow.length === 90 && peakWindow.every(s => s.pct !== null) ? Math.max(...peakWindow.map(s => s.pct)) : null;
    const row = session.row, prior = sessions[i - 50];
    if (row && positiveInteger(row.hl_total) && [row.new_hi_count, row.new_lo_count].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)
      && row.new_hi_count * 1000 > 22 * row.hl_total && row.new_lo_count * 1000 > 22 * row.hl_total
      && Math.max(row.new_hi_count, row.new_lo_count) <= 2 * Math.min(row.new_hi_count, row.new_lo_count)
      && session.close !== null && prior?.close != null && session.close > prior.close) hindenburgDates.push(session.date);
  }
  const peakNow = current ? peakByDate[current.date] : null;
  const peakPrior = currentIndex >= 90 ? peakByDate[sessions[currentIndex - 90].date] : null;
  const momentum = peakNow !== null && peakPrior !== null ? { peakNow, peakPrior, diff: peakNow - peakPrior } : null;
  const cutoff = currentIndex >= 0 ? sessions[Math.max(0, currentIndex - 29)].date : null;
  const hindenburgRecentCount = current ? hindenburgDates.filter(date => date >= cutoff && date <= current.date).length : 0;
  return { sessions, signals, eligibleDates, maByDate, peakByDate, current,
    latestBreadthDate: rows.at(-1)?.date ?? null, latestPriceDate: prices.at(-1)?.date ?? null,
    commonDate: current?.date ?? null, momentum, hindenburgDates, hindenburgRecentCount };
}
