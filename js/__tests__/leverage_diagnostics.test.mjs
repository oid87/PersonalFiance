import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { computeVolatilityPair, WINDOWS } from '../tabs/levvol_calc.mjs';
import { buildLeverageDiagnostics } from '../tabs/leverage_diagnostics.mjs';

// Frozen exact helper bytes from committed levvol.js at 7904738 (before extraction).
// Independent from the shared runtime calculator; no DOM/request/tab activation.
const helperSource = fs.readFileSync(new URL('./fixtures/levvol-legacy-7904738.txt', import.meta.url), 'utf8');
const plain = value => Array.isArray(value) ? Array.from(value, plain)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]))
    : value;
function legacyPair(bundle, etf) {
  const context = vm.createContext({ BUNDLE: bundle, WINDOWS: [5, 21, 63, 126, 252] });
  vm.runInContext(helperSource + '\nglobalThis.compute = computePair;', context);
  return plain(context.compute(etf));
}

function fixture(n = 265) {
  let price = 100;
  const under = Array.from({ length: n }, (_, i) => {
    price *= Math.exp((i % 7 - 3) / 1000);
    return [new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10), price];
  });
  return { updated: '2025-09-22', etfs: [{ id: 'TQQQ', zh: 'fixture', underlying: 'QQQ',
    leverage: 3, inception: under[0][0], expense: 0, financing: 0,
    real: under.map(([date, p]) => [date, 100 * (p / 100) ** 3]) }],
  underlyings: { QQQ: { name: 'QQQ 含息', data: under } } };
}

test('isolated volatility calculations equal actual production on full and staggered history', () => {
  for (const variant of ['regular', 'missing-etf-date', 'missing-underlying-date', 'flat', 'invalid-real-price']) {
    const bundle = fixture(280);
    if (variant === 'missing-etf-date') bundle.etfs[0].real.splice(12, 1);
    if (variant === 'missing-underlying-date') bundle.underlyings.QQQ.data.splice(23, 1);
    if (variant === 'flat') {
      bundle.underlyings.QQQ.data.forEach(row => { row[1] = 100; });
      bundle.etfs[0].real.forEach(row => { row[1] = 100; });
    }
    // Preserve inherited positive-price filtering behavior rather than repair it.
    if (variant === 'invalid-real-price') bundle.etfs[0].real[15][1] = 0;
    const before = structuredClone(bundle);
    const etf = bundle.etfs[0];
    assert.deepEqual(computeVolatilityPair(bundle, etf), legacyPair(bundle, etf), variant);
    assert.deepEqual(bundle, before);
  }
});

test('original admission boundary, null windows and population volatility ratio remain intact', () => {
  const short = fixture(256);
  assert.equal(computeVolatilityPair(short, short.etfs[0]), null);
  const bundle = fixture(257);
  const result = computeVolatilityPair(bundle, bundle.etfs[0]);
  assert.deepEqual(result.windows.map(item => item.w), [5, 21, 63, 126, 252]);
  assert.deepEqual(WINDOWS, [5, 21, 63, 126, 252]);
  for (const window of result.windows) {
    assert.equal(window.series.length, 256);
    assert.equal(window.n, 257 - window.w);
    assert.equal(window.series.filter(([, value]) => value === null).length, window.w - 1);
    assert.ok(Math.abs(window.median - 3) < 1e-10);
    assert.ok(Math.abs(window.mean - 3) < 1e-10);
  }
  assert.ok(Math.abs(result.dailyBaseline - 3) < 1e-10);
  const missing = { ...bundle.etfs[0], underlying: 'MISSING' };
  assert.equal(computeVolatilityPair(bundle, missing), null);
});

test('backtest summary uses contribution return, NAV drawdown and calendar underwater days', () => {
  const bundle = { updated: '2026-02-02', etfs: [{ id: 'T', zh: 'fixture', underlying: 'U',
    leverage: 2, inception: '2026-01-01', expense: 0, financing: 0,
    real: [['2026-01-01', 100], ['2026-01-02', 50], ['2026-02-02', 60]] }],
  underlyings: { U: { name: '價格指數', priceOnly: true,
    data: [['2026-01-01', 100], ['2026-01-02', 100], ['2026-02-02', 100]] } } };
  const before = structuredClone(bundle);
  const result = buildLeverageDiagnostics(bundle, { etf: 'T', initial: 100, dca: true, dcaAmount: 20 });
  assert.equal(result.underlyingPriceOnly, true);
  assert.equal(result.backtest.contributed, 120);
  assert.ok(Math.abs(result.backtest.leveragedValue - 80) < 1e-12);
  assert.ok(Math.abs(result.backtest.leveragedReturn - (80 / 120 - 1)) < 1e-12);
  assert.equal(result.backtest.maxDrawdown, -0.5);
  assert.equal(result.backtest.longestUnderwaterDays, 32);
  assert.equal(result.backtest.recoveredContribution, false);
  assert.equal(result.backtest.syntheticDays, 0);
  assert.equal(result.volatility, null);
  assert.deepEqual(bundle, before);
});

test('selected backtest period stays separate from full-history volatility sample', () => {
  const bundle = fixture();
  const result = buildLeverageDiagnostics(bundle, { etf: 'TQQQ', initial: 100, dca: false,
    from: bundle.underlyings.QQQ.data[260][0], to: bundle.underlyings.QQQ.data[264][0] });
  assert.equal(result.backtest.observationCount, 5);
  assert.equal(result.volatility.dates.length, 264);
  assert.notEqual(result.backtest.startDate, result.volatility.startDate);
  assert.equal(buildLeverageDiagnostics(bundle, { etf: 'UNKNOWN' }), null);
});
