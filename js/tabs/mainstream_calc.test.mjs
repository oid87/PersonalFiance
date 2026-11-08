import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from './mainstream_calc.mjs';

const row = (date, c = [], lock = 0) => ({ date, n: 1800, lock, c });
const S = (code, ind, ret = 5, vr = 3, hi = 60) => [code, ret, vr, hi, ind];

test('candidate filters: 60-day high, 2× volume, ≥ 3% gain — all three required', () => {
  const d = M.judgeDay(row('2025-01-02', [S('1', 'A'), S('2', 'A', 2.9), S('3', 'A', 5, 1.9), S('4', 'A', 5, 3, 40)]));
  assert.equal(d.cands, 1);
  assert.equal(d.level, 1, 'one candidate, no group → 稍微有');
});

test('≥ 3 in one industry → 有, group list sorted; empty industry never forms a group', () => {
  const d = M.judgeDay(row('2025-01-02', [S('1', '半導體'), S('2', '半導體'), S('3', '半導體'), S('4', '光電'), S('5', ''), S('6', ''), S('7', '')]));
  assert.equal(d.level, 0);
  assert.deepEqual(d.groups, [{ ind: '半導體', n: 3, codes: ['1', '2', '3'] }]);
  assert.equal(M.judgeDay(row('x', [])).level, 2);
});

test('locked-at-open exception: 完全沒有 but many limit-up locks → strong, not counted', () => {
  const d = M.judgeDay(row('x', [], 25));
  assert.equal(d.level, 2);
  assert.equal(d.strong, true);
  assert.equal(d.none, false);
});

test('22-day count, streak ≥ 3, turn from none → 有, tiers', () => {
  const g = [S('1', 'A'), S('2', 'A'), S('3', 'A')];
  const rows = ['01', '02', '03', '06', '07'].map((x, i) => row(`2025-01-${x}`, i < 3 ? [] : i === 3 ? g : []));
  const j = M.judgeAll(rows);
  assert.deepEqual(j.map(x => x.count), [1, 2, 3, 3, 4]);
  assert.deepEqual(j.map(x => x.streak), [1, 2, 3, 0, 1]);
  assert.equal(j[2].streak3, true);
  assert.deepEqual(j.map(x => x.turn), [false, false, false, true, false]);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(M.countTier), [0, 1, 2, 3, 3, 4, 4]);
  assert.deepEqual(M.noneIn(j, '2025-01-02', '2025-01-06'), { days: 2, dates: ['2025-01-02', '2025-01-03'] });
  assert.equal(M.summary(j).label, '完全沒有');
});

test('params can be overridden for calibration', () => {
  const r = row('x', [S('1', 'A', 2.5, 1.6, 20), S('2', 'A', 2.5, 1.6, 20)]);
  assert.equal(M.judgeDay(r).level, 2);
  assert.equal(M.judgeDay(r, { ...M.MAINSTREAM, minRet: 2, volMult: 1.5, hiDays: 20, groupMin: 2 }).level, 0);
});
