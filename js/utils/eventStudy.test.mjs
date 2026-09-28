import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateEventStudy, HORIZONS } from './eventStudy.mjs';

const dates = n => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10));
const pricesOf = closes => dates(closes.length).map((date, i) => ({ date, close: closes[i] }));
const study = (prices, options = {}) => evaluateEventStudy({ prices, events: [{ date: prices[0].date }],
  eligibleDates: prices.map(p => p.date), horizons: [1, 3], pathHorizon: 3, cooldownSessions: 0, ...options });
const near = (value, expected) => assert.ok(Math.abs(value - expected) < 1e-10, `${value} != ${expected}`);

test('return, signed anchor loss and running-peak drawdown are different', () => {
  const result = study(pricesOf([100, 120, 90, 110]));
  const outcome = result.events[0].outcomes[3];
  assert.equal(outcome.status, 'complete');
  near(outcome.forwardReturnPct, 10); near(outcome.maxLossPct, -10); near(outcome.mddPct, -25);
  near(result.stats[1].meanMaxLoss, -10); near(result.stats[1].worstMdd, -25);
  assert.equal(result.stats[1].winRate, 100);
  const up = study(pricesOf([100, 110, 120, 130]));
  assert.equal(up.events[0].outcomes[3].maxLossPct, 0);
  assert.equal(up.events[0].outcomes[3].mddPct, 0);
  const pullback = study(pricesOf([100, 120, 110]), { horizons: [2] });
  assert.equal(pullback.events[0].outcomes[2].maxLossPct, 0);
  near(pullback.events[0].outcomes[2].mddPct, -100 / 12);
});

test('tail and null exclusions are per horizon and retain null session positions', () => {
  const prices = pricesOf([100, 110, null, 130]);
  const result = study(prices, { events: [{ date: prices[0].date }, { date: prices[3].date }] });
  assert.equal(result.events[0].outcomes[1].status, 'complete');
  assert.equal(result.events[0].outcomes[3].status, 'missingPrice');
  assert.equal(result.events[0].outcomes[3].exitDate, prices[3].date);
  assert.equal(result.events[1].outcomes[1].status, 'incomplete');
  assert.equal(result.events[1].outcomes[1].exitDate, null);
  assert.deepEqual(result.stats[1].excluded, { incomplete: 1, missingPrice: 1 });
  assert.equal(result.stats[1].n, 0);
  for (const [key, value] of Object.entries(result.stats[1].baseline)) if (key !== 'n') assert.equal(value, null);
  const anchorNull = study(prices, { events: [{ date: prices[2].date }], horizons: [1] });
  assert.equal(anchorNull.events[0].outcomes[1].status, 'missingPrice');
});

test('empty samples remain null, zero returns are not wins, and no rounding precedes statistics', () => {
  const prices = pricesOf([100, 100.001, 100.003, 100.003]);
  const empty = study(prices, { events: [] });
  assert.equal(empty.rawN, 0); assert.equal(empty.stats[0].n, 0); assert.equal(empty.stats[0].mean, null);
  assert.ok(empty.paths.points.every(p => p.n === 0 && p.median === null));
  const precise = study(prices, { events: [{ date: prices[0].date }, { date: prices[1].date }, { date: prices[2].date }], horizons: [1] });
  const expected = [100 * (100.001 / 100 - 1), 100 * (100.003 / 100.001 - 1), 0];
  assert.equal(precise.stats[0].mean, expected.reduce((a, b) => a + b) / 3);
  near(precise.stats[0].winRate, 200 / 3);
  assert.equal(precise.stats[0].median, expected[0]);
  assert.deepEqual(HORIZONS, [5, 10, 21, 42, 63, 126, 252]);
});

test('dedupe and twenty-session cooldown run over full history before study range', () => {
  const prices = pricesOf(Array.from({ length: 45 }, (_, i) => 100 + i));
  const events = [20, 19, 0, 20, 39, 40].map(i => ({ date: prices[i].date, indexEvidence: i }));
  const result = study(prices, { events, cooldownSessions: 20, horizons: [1] });
  assert.equal(result.rawN, 5);
  assert.deepEqual(result.events.map(e => e.indexEvidence), [0, 20, 40]);
  const ranged = study(prices, { events, cooldownSessions: 20, horizons: [1], from: prices[19].date, to: prices[39].date });
  assert.equal(ranged.rawN, 3); assert.equal(ranged.keptN, 1);
  assert.equal(ranged.events[0].date, prices[20].date);
  assert.equal(ranged.stats[0].baseline.n, 21);
});

test('baseline uses eligible anchors and range, but to does not truncate future outcomes', () => {
  const prices = pricesOf([100, 110, 121, 133.1]);
  const eligibleDates = [prices[2].date, prices[3].date];
  const result = study(prices, { eligibleDates, events: [{ date: prices[0].date }, { date: prices[2].date }],
    horizons: [1], from: prices[2].date, to: prices[2].date });
  assert.equal(result.rawN, 1); assert.equal(result.stats[0].baseline.n, 1);
  near(result.stats[0].baseline.mean, 10);
  assert.equal(result.events[0].outcomes[1].exitDate, prices[3].date);
});

test('overlap counts adjacent complete-event anchors and respects strict horizon boundary', () => {
  const prices = pricesOf(Array.from({ length: 8 }, () => 100));
  const result = study(prices, { events: [0, 1, 4, 7].map(i => ({ date: prices[i].date })), horizons: [3] });
  assert.equal(result.stats[0].n, 3); assert.equal(result.stats[0].possiblePairs, 2); assert.equal(result.stats[0].overlapPairs, 1);
});

test('bands use a fixed complete cohort; partial paths stop permanently at first gap', () => {
  const prices = pricesOf([100, 110, 120, 100, 90, null, 150, 160]);
  const result = study(prices, { events: [0, 3, 6].map(i => ({ date: prices[i].date })), pathHorizon: 3 });
  assert.equal(result.paths.n, 1);
  assert.deepEqual(result.paths.points.map(p => p.n), [1, 1, 1, 1]);
  assert.deepEqual(result.paths.points.map(p => p.median), [100, 110, 120, 100]);
  assert.deepEqual(result.paths.individual[1].values, [100, 90, null, null]);
  assert.deepEqual(result.paths.individual[2].values, [100, 100 * 160 / 150, null, null]);
  const two = study(pricesOf([100, 110, 120, 100, 90, 80]), { events: [0, 3].map(i => ({ date: dates(6)[i] })), pathHorizon: 2 });
  assert.equal(two.paths.points[1].p25, 95); assert.equal(two.paths.points[1].p75, 105);
});

test('Friday + two sessions is Tuesday, not calendar Sunday aligned to Monday', () => {
  const prices = ['2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29'].map((date, i) => ({ date, close: [100, 101, 110, 120][i] }));
  const result = study(prices, { events: [{ date: prices[1].date }], horizons: [2] });
  assert.equal(result.events[0].outcomes[2].exitDate, '2026-09-29');
  near(result.events[0].outcomes[2].forwardReturnPct, 100 * (120 / 101 - 1));
});

test('invalid dates, axis order, prices, events, eligibility and options reject explicitly', () => {
  for (const close of [0, -1, NaN, Infinity, undefined, '100']) assert.throws(() => study(pricesOf([close, 100])));
  const prices = pricesOf([100, 101]);
  assert.throws(() => study([prices[0], prices[0]])); assert.throws(() => study([...prices].reverse()));
  assert.throws(() => study([{ date: '2026-02-30', close: 100 }]));
  for (const date of ['2026-02-30', '2026-01-09', '2026-1-1']) {
    assert.throws(() => study(prices, { events: [{ date }] }));
    assert.throws(() => study(prices, { eligibleDates: [date] }));
  }
  for (const options of [{ cooldownSessions: -1 }, { horizons: [1, 1] }, { horizons: [0] }, { pathHorizon: 1.2 }, { from: '2026-02-30' }, { from: '2026-02-01', to: '2026-01-01' }]) assert.throws(() => study(prices, options));
});
