import test from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, gauss, gbmLevels, leverageFromLevels, maxDrawdown,
  longestUnderwater, drawdownEpisodes, crashLevels, applyContrib,
  buildBacktestPure } from '../tabs/leverage_calc.mjs';

test('leveraged curves retain daily reset, seeded RNG and crash presets', () => {
  assert.equal(mulberry32(42)(), mulberry32(42)());
  assert.ok(Math.abs(gauss(() => 0.5) + Math.sqrt(2 * Math.log(2))) < 1e-12);
  assert.deepEqual(gbmLevels(2, 0, 0, mulberry32(1)), [1, 1, 1]);
  const curve = leverageFromLevels([1, 1.1, 1], 2, 0);
  assert.equal(curve[1], 1.2000000000000002); // Legacy daily-reset result.
  assert.ok(Math.abs(curve[1] - 1.2) < 1e-12);
  assert.ok(Math.abs(curve[2] - 1.2 * (1 + 2 * (1 / 1.1 - 1))) < 1e-12);
  assert.ok(crashLevels('vshape').length > 20);
});

test('drawdown and contribution outputs use original calendar and monthly rules', () => {
  assert.equal(maxDrawdown([1, 2, 1]), -0.5);
  const dates = ['2026-01-01', '2026-01-02', '2026-02-02'];
  assert.equal(longestUnderwater(dates, [1, 0.5, 0.6]), 32);
  assert.equal(drawdownEpisodes(dates, [1, 0.5, 1])[0].depth, -0.5);
  const result = applyContrib(dates, [1, 1, 2], [1, 1, 1],
    { initial: 100, dca: true, dcaAmount: 20 });
  assert.equal(result.contributed, 120);
  assert.equal(result.levVal.at(-1), 220);
});

test('history uses real ETF returns after inception', () => {
  const bundle = { etfs: [{ id: 'T', underlying: 'U', leverage: 2, inception: '2026-01-02',
    expense: 0, financing: 0, real: [['2026-01-02', 100], ['2026-01-03', 110]] }],
  underlyings: { U: { name: 'Underlying', data: [['2026-01-01', 100],
    ['2026-01-02', 110], ['2026-01-03', 121]] } } };
  const result = buildBacktestPure(bundle, { etf: 'T', initial: 100, dca: false });
  assert.equal(result.synthDays, 1);
  assert.ok(Math.abs(result.levNav.at(-1) - 1.32) < 1e-12);
});
