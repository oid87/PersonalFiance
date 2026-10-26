import test from 'node:test';
import assert from 'node:assert/strict';
import * as H from './nonnormalhist_calc.mjs';
import * as N from './nonnormal_calc.mjs';

const day = i => new Date(Date.UTC(2015, 0, 1) + i * 86400000).toISOString().slice(0, 10);
const daily = flags => flags.map((f, i) => ({ date: day(i), limit_down: 5, no_obs: f }));
const twLine = (n, f) => Array.from({ length: n }, (_, i) => ({ date: day(i), close: f(i) }));

test('dailyRows: 22-row rolling no-observation count, null until the window is full or when a value is missing', () => {
  const rows = H.dailyRows(daily([...Array(21).fill(0), 1, 1, null, 0]));
  assert.equal(rows[20].noObs, null);
  assert.deepEqual(rows.slice(21, 23).map(r => r.noObs), [1, 2]);
  assert.equal(rows[23].noObs, null, 'missing no_obs inside the window');
  assert.equal(rows[23].flag, null);
});

test('episodes: first day the trigger holds, a new episode only after GAP quiet trading days, peaks within the episode', () => {
  const flags = Array(300).fill(0);
  [30, 31, 32, 33, 34, 50].forEach(i => { flags[i] = 1; });   // 第一次：達 3 天在 32
  [60, 61, 62].forEach(i => { flags[i] = 1; });                 // 上一次條件在 51 結束，相隔不到 20 日 → 同一次
  [100, 101, 102].forEach(i => { flags[i] = 1; });              // 相隔超過 20 日 → 新的一次
  [250, 251, 252].forEach(i => { flags[i] = 1; });              // 新的一次
  const rows = H.dailyRows(daily(flags));
  rows[40].limitDown = 450;
  const tw = twLine(300, i => (i <= 32 ? 100 - i : 70 + (i - 32) * 0.1));
  const ep = H.episodes(rows, tw, 'obs3');
  assert.deepEqual(ep.map(e => e.date), [day(32), day(102), day(252)]);
  assert.equal(ep[0].peakNoObs, 6);
  assert.equal(ep[0].maxLimitDown, 450);
  assert.ok(Math.abs(ep[0].fromHigh - (68 / 100 - 1)) < 1e-9);
  assert.ok(Math.abs(ep[0].ret[20] - (70 + 2 - 68) / 68) < 1e-9);
  assert.equal(ep[2].ret[60], null, 'not enough future days');
  assert.equal(H.episodes(rows, tw, 'ld300').length, 1);
  assert.throws(() => H.episodes(rows, tw, 'nope'));
});

test('summarize and yearly', () => {
  const s = H.summarize([{ ret: { 20: 0.1, 60: -0.2, 120: null } }, { ret: { 20: 0.3, 60: 0.1, 120: null } }]);
  assert.deepEqual([s[20].n, s[20].median, s[20].up], [2, 0.2, 1]);
  assert.deepEqual([s[60].median.toFixed(2), s[60].up, s[120].n], ['-0.05', 0.5, 0]);
  const y = H.yearly([{ date: '2015-01-02', flag: 1, limitDown: 320 }, { date: '2015-01-05', flag: 0, limitDown: 4 }, { date: '2016-01-04', flag: null, limitDown: null }]);
  assert.deepEqual(y.map(r => [r.year, r.days, r.noObs, r.ldDays, r.maxLimitDown]), [['2015', 2, 1, 1, 320], ['2016', 1, 0, 0, null]]);
});

test('main dashboard only uses daily stats from NO_OBS.from; the rolling count still sees the days before it', () => {
  const rows = ['2019-12-30', '2019-12-31', '2020-01-02', '2020-01-03'].map((date, i) => ({ date, limit_down: 400 + i, no_obs: 1 }));
  const ctx = N.buildContext({ daily: rows });
  assert.deepEqual(ctx.s.LIMIT_DOWN.dates, ['2020-01-02', '2020-01-03']);
  assert.deepEqual(ctx.s.NO_OBS.close, [3, 4]);
  assert.deepEqual(ctx.s.NO_OBS.flags, [1, 1]);
});

test('0050 version: rolling 22-day count of constituent breakouts, trigger and yearly column', () => {
  const rows = H.dailyRows(Array.from({ length: 30 }, (_, i) => ({ date: day(i), limit_down: 1, no_obs: 0, obs50: i < 10 ? 1 : 0 })));
  assert.equal(rows[20].tw50, null);
  assert.deepEqual([rows[21].tw50, rows[29].tw50], [10, 2]);
  assert.equal(H.TRIGGERS.tw50.test(rows[29]), true);
  assert.equal(H.TRIGGERS.tw50.test(rows[28]), false);
  assert.equal(H.yearly(rows)[0].tw50Days, 1);
});

test('US groups: per-100 rate over 22 days, episodes on the ETF price, yearly counts', () => {
  const data = Array.from({ length: 60 }, (_, i) => ({ date: day(i), qqq_n: 100, qqq_obs: i < 30 ? 2 : 0, voo5_n: 200, voo5_obs: 10, soxx_n: 20, soxx_obs: 1 }));
  const rows = H.usRows(data);
  assert.equal(rows[20].qqq_rate, null);
  assert.equal(rows[21].qqq_rate, 44);                 // 22 天 × 2 次 ÷ 100 檔 × 100
  assert.equal(rows[59].qqq_rate, 0);
  assert.ok(Math.abs(rows[59].voo5_rate - 110) < 1e-9);
  const px = twLine(60, i => 100 + i);
  const ep = H.usEpisodes(rows, px, 'qqq');
  assert.equal(ep.length, 1);
  assert.equal(ep[0].minRate, 0);
  assert.ok(rows.find(r => r.date === ep[0].date).qqq_rate <= H.RATE_LOW);
  assert.equal(H.usYearly(rows)[0].voo5, 0);
  assert.ok(H.usYearly(rows)[0].qqq > 0);
  assert.throws(() => H.usEpisodes(rows, px, 'nope'));
});
