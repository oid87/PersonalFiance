import test from 'node:test';
import assert from 'node:assert/strict';
import * as Z from './twzone_calc.mjs';

test('align counts simultaneous signals and zones merge consecutive days', () => {
  const px = ['a', 'b', 'c', 'd'].map((date, i) => ({ date, close: 100 + i }));
  const src = { obs: [{ date: 'a', noObs: 3 }, { date: 'b', noObs: 0 }, { date: 'c', noObs: 4 }, { date: 'd', noObs: 0 }],
    br: [{ date: 'a', p20: 5, p50: 50, p200: 50 }, { date: 'b', p20: 5, p50: 10, p200: 50 }, { date: 'c', p20: 50, p50: 50, p200: 50 }, { date: 'd', p20: 50, p50: 50, p200: 50 }] };
  const d = Z.align(px, src);
  assert.deepEqual(d.map(x => x.count), [2, 2, 1, 0]);
  assert.deepEqual(Z.zones(d), [{ from: 'a', to: 'c', max: 2 }]);
});

test('realized vol is zero for a constant-growth series and null before the window', () => {
  const px = Array.from({ length: 30 }, (_, i) => ({ date: 'd' + i, close: 100 * 1.01 ** i }));
  const rv = Z.realizedVol(px);
  assert.equal(rv[19].rv, null);
  assert.ok(Math.abs(rv[25].rv) < 1e-9);
});
