import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, dayDiff, thirdFriday, rollOffsetWeeks, buildMarket, prepCftc, cftcWeekly, prepNfci, prepFinra, monthEnd, finraLagStats,
  forward, evaluate, findWaves, waveCoverage, clusterEvents, vixCalm, pearson, idxOnOrAfter,
} from './usdelever_calc.mjs';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

// 合成日曆：只含週一～週五，可剔除假日
function weekdays(from, n, skip = []) {
  const out = []; let d = from;
  while (out.length < n) {
    const wd = new Date(d + 'T00:00:00Z').getUTCDay();
    if (wd !== 0 && wd !== 6 && !skip.includes(d)) out.push(d);
    d = addDays(d, 1);
  }
  return out;
}
function mkRaw(dates, closes, opens) {
  const bar = (d, i) => ({ date: d, open: opens ? opens[i] : closes[i], high: closes[i] * 1.01, low: closes[i] * 0.99, close: closes[i] });
  return { spy: dates.map(bar), qqq: dates.map(bar) };
}

test('日期工具與第三個週五／轉倉週偏移', () => {
  assert.equal(addDays('2024-02-28', 2), '2024-03-01');
  assert.equal(dayDiff('2024-03-01', '2024-03-15'), 14);
  assert.equal(thirdFriday(2024, 3), '2024-03-15');
  assert.equal(thirdFriday(2026, 6), '2026-06-19');
  assert.equal(rollOffsetWeeks('2024-03-12'), 0);    // 到期週的週二
  assert.equal(rollOffsetWeeks('2024-03-19'), 1);    // 到期後一週
  assert.equal(rollOffsetWeeks('2024-03-05'), -1);
  assert.equal(rollOffsetWeeks('2026-06-16'), 0);
});

test('CFTC：轉倉週不發訊號，變動量對「前一個乾淨報告」計算並記錄 span；公開日＝週五（假日順延）', () => {
  const dates = weekdays('2024-02-01', 70, ['2024-03-29']);        // 2024-03-29 聖週五休市
  const mk = buildMarket(mkRaw(dates, dates.map(() => 100)), { start: '2024-02-01', end: '2024-05-01' });
  const rows = [['2024-03-05', 100], ['2024-03-12', 150], ['2024-03-19', 60], ['2024-03-26', 70]].map(([date, g]) => ({ date, lev_long: g, lev_short: g, open_interest: 1000 }));
  const cf = prepCftc(mk, [{ id: 'sp500', rows }]).sp500;
  assert.deepEqual(cf.map(r => r.roll), [false, true, true, false]);          // 3/12(偏移0)、3/19(偏移1) 為轉倉
  assert.equal(cf[1].gChg, null); assert.equal(cf[2].gChg, null);             // 不發訊號
  near(cf[3].gChg, (140 / 200 - 1) * 100);                                    // 3/26 對 3/05（乾淨）計算
  assert.equal(cf[3].span, 3);
  assert.equal(mk.cal[cf[3].availIdx], '2024-04-01');                          // 3/26+3＝3/29 休市 → 順延到下一交易日
  assert.equal(mk.cal[cf[0].availIdx], '2024-03-08');                          // 3/05+3＝3/08 週五
});

test('NFCI：z-score 只用過去 52 週（改未來不影響過去）；公布日＝週五+5', () => {
  const dates = weekdays('2023-01-02', 400);
  const mk = buildMarket(mkRaw(dates, dates.map(() => 100)), { start: '2023-06-01', end: '2024-06-01' });
  const fridays = []; let d = '2023-01-06';
  for (let i = 0; i < 80; i++) { fridays.push(d); d = addDays(d, 7); }
  const mkRows = bump => fridays.map((date, i) => ({ date, nfci: 0, leverage: Math.sin(i / 3) * 0.1 + (i === 70 ? bump : 0), risk: 0, credit: 0 }));
  const a = prepNfci(mk, mkRows(0)), b = prepNfci(mk, mkRows(5));
  for (let i = 1; i < 70; i++) assert.equal(a[i].zLev, b[i].zLev);              // 第 70 週之前完全相同
  assert.notEqual(a[70].zLev, b[70].zLev);
  assert.equal(mk.cal[a[0].availIdx], '2023-01-11');                              // 週五 1/6 → 週三 1/11
});

test('FINRA 公布日：模型＝月底+25 天夾在括號內；無括號純模型；upper/lower', () => {
  const dates = weekdays('2024-01-01', 400);
  const mk = buildMarket(mkRaw(dates, dates.map(() => 100)), { start: '2024-02-01', end: '2025-06-01' });
  const rows = [{ date: '2024-05-01', margin_balance: 100 }, { date: '2024-06-01', margin_balance: 90 }, { date: '2024-07-01', margin_balance: 95 }];
  const release = { '2024-06': { known_by: '2024-07-22', not_yet: '2024-07-16', left_censored: false }, '2024-05': { known_by: '2024-08-30', not_yet: '2024-05-31', left_censored: false } };
  const m = prepFinra(mk, rows, release, { ...mk.cfg, finraBound: 'model' });
  assert.equal(m[0].knownDate, '2024-06-25');                 // 5 月：月底 5/31+25，括號寬，保持模型
  assert.equal(m[1].knownDate, '2024-07-22');                 // 6 月：模型 7/25 超過 known_by → 夾到 7/22
  assert.equal(m[2].unbracketed, true); assert.equal(m[2].knownDate, '2024-08-25');   // 無括號
  near(m[1].mom, (90 / 100 - 1) * 100);
  assert.equal(prepFinra(mk, rows, release, { ...mk.cfg, finraBound: 'upper' })[1].knownDate, '2024-07-22');
  assert.equal(prepFinra(mk, rows, release, { ...mk.cfg, finraBound: 'lower' })[1].knownDate, '2024-07-17');
  assert.equal(monthEnd('2024-02'), '2024-02-29');
  const lagStats = finraLagStats({ '2024-06': { known_by: '2024-07-22', not_yet: '2024-07-16' }, '2024-05': { known_by: '2024-08-30', not_yet: '2024-05-31' } });
  assert.equal(lagStats.n, 1); assert.equal(lagStats.median, 22);    // 寬括號不納入
});

test('訊號可得日之後才能進場：下一交易日開盤；跌破訊號日最低點；資料不足回 null', () => {
  const dates = weekdays('2024-01-01', 40);
  const closes = [...Array(10).fill(100), 90, 95, 92, 80, 85, 99, ...Array(24).fill(100)];
  const opens = closes.map((c, i) => c + (i === 11 ? 2 : 0));
  const mk = buildMarket(mkRaw(dates, closes, opens), { start: '2024-01-01', end: '2025-01-01', horizons: [3] });
  const i = 10;                                                    // 訊號日：收 90，隔日(11)開盤 97
  const fw = forward(mk, 'SPY', i, mk.cfg);
  assert.equal(fw.entryDate, dates[11]);
  near(fw.h[3].ret, (closes[13] / opens[11] - 1) * 100);           // 持有 3 日：出場 e+h-1=13
  assert.equal(fw.h[3].breakLow, true);                            // 13 日最低 79.2 < 訊號日最低 89.1
  assert.equal(forward(mk, 'SPY', mk.N - 1, mk.cfg), null);
  const ev = evaluate(mk, [i, i], mk.cfg);                         // 重複旗標只算一次
  assert.equal(ev.events.length, 1);
});

test('客觀波段與命中／領先：領先為正＝早於低點', () => {
  const dates = weekdays('2024-01-01', 60);
  const closes = [...Array(20).fill(100), 96, 92, 88, 84, 90, 96, 99, 100, ...Array(32).fill(100)];
  const mk = buildMarket(mkRaw(dates, closes), { start: '2024-01-01', end: '2025-01-01', waveEnter: 8, waveExit: 3 });
  const waves = findWaves(mk, 'SPY', mk.cfg);
  assert.equal(waves.length, 1);
  assert.equal(waves[0].lowDate, dates[23]);
  const ev = clusterEvents([21, 22, 40], 3);
  const cov = waveCoverage(mk, ev, waves);
  assert.equal(cov.hit, 1); assert.equal(cov.per[0].lead, 23 - 21);
  assert.equal(cov.outside, 1);                                    // idx 40 在波段外
  assert.ok(cov.baseShare > 0 && cov.baseShare < 100);
});

test('vixCalm 與 pearson', () => {
  const dates = weekdays('2024-01-01', 40);
  const raw = { ...mkRaw(dates, dates.map(() => 100)), vix: dates.map((date, i) => ({ date, close: i < 20 ? 30 : i < 25 ? 30 - (i - 19) * 3 : 15 })) };
  const mk = buildMarket(raw, { start: '2024-01-01', end: '2025-01-01' });
  assert.equal(vixCalm(mk, 24), true);       // 15 ≤ 30×0.85 且低於 5 日前
  assert.equal(vixCalm(mk, 5), false);       // 暖機不足
  near(pearson([1, 2, 3, 4, 5, 6, 7, 8, 9], [2, 4, 6, 8, 10, 12, 14, 16, 18]).r, 1);
  assert.equal(pearson([1, 2], [1, 2]).r, null);   // n<8 不報
  assert.equal(idxOnOrAfter(mk, '2099-01-01'), null);
});
