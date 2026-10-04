import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { interpFpe, fearZones, fearEpisodes, drawdownFromPriorPeak, scoreZones, signalSnapshot, buildSigMaps } from '../tabs/trend_calc.mjs';

const legacy = readFileSync(fileURLToPath(new URL('./fixtures/calculations-three/trend.js', import.meta.url)), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function block(start, end) { return legacy.slice(legacy.indexOf(start), legacy.indexOf(end, legacy.indexOf(start))); }
function legacyFn(start, end, name, context = {}) {
  return vm.runInNewContext(`${block(start, end)}\n${name}`, context);
}

const fg = [['2024-01-30', 30], ['2024-01-31', 18], ['2024-02-01', 12], ['2024-02-02', 24], ['2024-02-03', 10], ['2024-02-04', null], ['2024-02-05', 15]];
test('fear ranges and calendar-day episodes match snapshot oracle', () => {
  const loaded = { 'F&G': fg };
  const oldZones = legacyFn('function fearZones(threshold)', 'function fearEpisodes(threshold)', 'fearZones', { loaded });
  const oldEpisodes = legacyFn('function fearEpisodes(threshold)', 'function updateChartHeight()', 'fearEpisodes', { loaded });
  for (const threshold of [0, 15, 20, 30]) {
    assert.deepEqual(fearZones(fg, threshold), plain(oldZones(threshold)));
    assert.deepEqual(fearEpisodes(fg, threshold), plain(oldEpisodes(threshold)));
  }
  assert.deepEqual(fearZones(null, 20), []);
});

test('FPE UTC interpolation and rounding match snapshot oracle', () => {
  const old = legacyFn('function _interpFpe(arr)', 'const dateFrom', '_interpFpe');
  for (const rows of [[], [{ date: '2024-01-31', fpe: 20 }], [
    { date: '2024-01-30', fpe: 20.001 }, { date: '2024-02-02', fpe: 21.234 },
  ]]) assert.deepEqual(interpFpe(rows), plain(old(rows)));
});

test('prior-only drawdown, score zone and signal snapshot keep boundary semantics', () => {
  const qqq = Array.from({ length: 64 }, (_, i) => [`2024-03-${String(i + 1).padStart(2, '0')}`, 100 + i]);
  const oldBuildSource = block('function buildSigMaps()', 'export function renderSignalPanel(date)');
  const context = {
    loaded: { QQQ: qqq, 'F&G': fg, VIX: [], }, loadedHLC: {}, loadedVol: {}, state: {},
    toWeekly: x => x, toWeeklyHLC: x => x, computeKD: () => [], computeRSI: () => [],
    computeTDSetup: () => [], computeMA: x => x.map(r => [r[0], 110]),
    lookupLE: (arr, date) => [...arr].reverse().find(r => r[0] <= date),
    computeBounceSignals: () => ({ bounceSignals: [] }),
  };
  vm.runInNewContext(`${oldBuildSource}\nbuildSigMaps()`, context);
  const actual = buildSigMaps({ qqq, fg, vix: [], vol: [] }, context);
  assert.deepEqual(plain(actual), plain(context.state.sigMaps));
  assert.deepEqual(drawdownFromPriorPeak(qqq, 60), plain(context.state.sigMaps.ddArr));
  assert.deepEqual(scoreZones([['a', 3], ['b', 4], ['c', 5], ['d', 2], ['e', 4]]), [['b', 'c'], ['e', 'e']]);
  const snap = signalSnapshot(actual, qqq.at(-1)[0], context.lookupLE);
  assert.equal(snap.count, actual.scoreArr.at(-1)[1]);
});
