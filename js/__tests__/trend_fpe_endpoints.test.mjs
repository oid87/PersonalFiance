import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { interpFpe } from '../tabs/trend_calc.mjs';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/trend-fpe-endpoints.json', import.meta.url)));
const legacy = readFileSync(new URL('./fixtures/calculations-three/trend.js', import.meta.url), 'utf8');
const old = vm.runInNewContext(legacy.slice(legacy.indexOf('function _interpFpe(arr)'), legacy.indexOf('const dateFrom')) + '\n_interpFpe');
const plain = x => JSON.parse(JSON.stringify(x));

test('valid FPE endpoints preserve legacy UTC dates, rounding and negative arithmetic', () => {
  for (const rows of [[], fixtures.valid, fixtures.negative,
    [{ date: '2024-01-02', fpe: 20.0014 }],
    [{ date: '2024-01-02', fpe: -6 }, { date: '2024-01-08', fpe: 6 }],
    [{ date: '2024-01-02', fpe: 20 }, { date: '2024-07-02', fpe: 26 }],
  ]) assert.deepEqual(interpFpe(rows), plain(old(rows)));
  // Existing interpolation can cross zero between finite negative/positive
  // endpoints. Do not turn the approved input-zero rule into a new sign model.
  assert.deepEqual(interpFpe(fixtures.negative), [
    ['2024-01-02', -6], ['2024-01-03', -5], ['2024-01-04', -4], ['2024-01-05', -3],
  ]);
});

test('all valid committed QQQ FPE observations retain the historical interpolation result', () => {
  const data = JSON.parse(readFileSync(new URL('../../data/QQQ_valuation.json', import.meta.url))).data;
  const valid = data.filter(r => typeof r.fpe === 'number' && Number.isFinite(r.fpe) && r.fpe !== 0);
  assert.ok(valid.length > 2);
  assert.deepEqual(interpFpe(valid), plain(old(valid)));
});

test('valid/missing combinations keep observed endpoints and emit explicit null interiors', () => {
  assert.deepEqual(interpFpe(fixtures.validMissing), [
    ['2024-01-02', 20], ['2024-01-03', null], ['2024-01-04', null], ['2024-01-05', null],
  ]);
  assert.deepEqual(interpFpe(fixtures.missingValid), [
    ['2024-01-02', null], ['2024-01-03', null], ['2024-01-04', null], ['2024-01-05', 23],
  ]);
  assert.deepEqual(interpFpe(fixtures.missingMissing), [
    ['2024-01-02', null], ['2024-01-03', null], ['2024-01-04', null], ['2024-01-05', null],
  ]);
});

test('zero, missing, nonfinite and malformed values never enter endpoint arithmetic', () => {
  for (const invalid of [0, -0, null, undefined, NaN, Infinity, -Infinity, '', '21', 'bad', false, true, {}, []]) {
    const rows = [{ date: '2024-01-02', fpe: 20 }, { date: '2024-01-05', fpe: invalid }, { date: '2024-01-08', fpe: 23 }];
    assert.deepEqual(interpFpe(rows), [
      ['2024-01-02', 20], ['2024-01-03', null], ['2024-01-04', null], ['2024-01-05', null],
      ['2024-01-06', null], ['2024-01-07', null], ['2024-01-08', 23],
    ]);
    assert.deepEqual(interpFpe([rows[1]]), [['2024-01-05', null]]);
  }
  assert.deepEqual(interpFpe(fixtures.zero).filter(([, v]) => v !== null), [['2024-01-02', 20], ['2024-01-08', 23]]);
  assert.deepEqual(interpFpe(null), []);
  assert.deepEqual(interpFpe(undefined), []);
  assert.deepEqual(interpFpe([]), []);
});

test('trend wires the tested endpoint calculation and explicitly renders broken segments', () => {
  const source = readFileSync(new URL('../tabs/trend.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ interpFpe \} from '\.\/trend_calc\.mjs';/);
  assert.doesNotMatch(source, /function _interpFpe/);
  assert.match(source, /const fpeInterp = interpFpe\(trendFpeData\)/);
  assert.match(source, /name: "QQQ FPE"[\s\S]*?connectNulls: false/);
});
