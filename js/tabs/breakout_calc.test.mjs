import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as B from './breakout_calc.mjs';

function businessDays(start, n) {
  const out = []; let t = Date.parse(start);
  while (out.length < n) { const d = new Date(t); if (![0, 6].includes(d.getUTCDay())) out.push(d.toISOString().slice(0, 10)); t += 86400000; }
  return out;
}
const DATES = businessDays('2020-01-01', 400);
const rows = (close, volume) => DATES.map((date, i) => ({ date, close: close(i), volume: volume(i) }));

test('box = longest window whose prior high the close exceeds; ratio = volume ÷ prior 63-day average', () => {
  // 300 天在 100～110 之間盤整，第 300 天以 3 倍量突破
  const b = B.buildBars(rows(i => (i < 300 ? 100 + 10 * Math.abs(Math.sin(i / 7)) : 120), i => (i === 300 ? 3000 : 1000)));
  const e = B.breakoutDaily(b)[300];
  assert.equal(e.box, 252, '300 days of history: the 1-year box is the longest that fits');
  assert.equal(e.boxLabel, '1 年');
  assert.equal(e.ratio, 3);
  assert.equal(B.tierLabel(e.ratio), '3 倍');
  assert.equal(B.breakoutDaily(b)[301], null, 'flat at the new high is not another breakout');
});

test('no breakout when the close only ties the prior high; short box fails → longer boxes are not checked', () => {
  const b = B.buildBars(rows(i => (i === 100 ? 50 : 40), () => 1000));
  assert.equal(B.breakoutDaily(b)[100].box, 63);
  const tie = B.buildBars(rows(i => (i === 70 || i === 100 ? 50 : 40), () => 1000));
  assert.equal(B.breakoutDaily(tie)[100], null);
});

test('volume: zero/missing counts as no data; < 80% coverage → ratio null; volume taken from another series', () => {
  const b = B.buildBars(rows(i => (i === 200 ? 200 : 100), i => (i > 150 && i < 200 ? 0 : 1000)));
  assert.equal(B.breakoutDaily(b)[200].ratio, null);
  const price = DATES.map((date, i) => ({ date, close: i === 100 ? 2 : 1, volume: 0 }));
  const vol = DATES.map(date => ({ date, volume: 500 }));
  const merged = B.buildBars(B.withVolumeFrom(price, vol));
  assert.equal(B.breakoutDaily(merged)[100].ratio, 1);
});

test('tiers follow the rule text: ≥2 watch, ≥3/5/10 close watch', () => {
  assert.deepEqual([1.9, 2, 3, 4.9, 5, 10, 25].map(B.tierLabel), ['', '2 倍', '3 倍', '3 倍', '5 倍', '10 倍', '10 倍']);
});

test('breakoutNow / breakoutEvents: strongest recent event, no look-ahead, events merged within the gap', () => {
  const b = B.buildBars(rows(i => (i < 300 ? 100 : 100 + (i - 299)), i => (i === 300 ? 2500 : i === 305 ? 4000 : 1000)));
  const n = B.breakoutNow(b, DATES[310]);
  assert.equal(n.recent.date, DATES[305]);
  assert.equal(B.tierOf(n.recent.ratio), 2);
  assert.equal(B.breakoutNow(b, DATES[303]).recent.date, DATES[300], 'day 305 is not visible yet');
  const ev = B.breakoutEvents(b, { minRatio: 2 });
  assert.equal(ev.length, 1, 'day 305 is within 20 days of day 300');
  assert.equal(ev[0].fwd[20], b.close[320] / b.close[300] - 1);
  const later = B.buildBars(rows((i) => i, () => 1000));
  assert.deepEqual(B.breakoutDaily(later).slice(0, 64).filter(Boolean).map(e => e.box), [63]);
});

// 真實資料（2026-11-08 實算）：費半價格 ^SOX、量 SOXX；指數層級 ≥2 倍很少
const D = new URL('../../data/', import.meta.url);
const read = f => JSON.parse(readFileSync(new URL(f, D), 'utf8')).data;
test('data check: known breakouts and the current state', { skip: !['TWII.json', 'SOX.json', 'SOXX.json'].every(f => existsSync(new URL(f, D))) }, () => {
  const tw = B.buildBars(read('TWII.json'));
  const e = B.breakoutDaily(tw)[tw.dates.indexOf('2020-12-07')];
  assert.equal(e.boxLabel, '10 年');
  assert.ok(e.ratio >= 2 && e.ratio < 2.1, String(e.ratio));
  const sox = B.buildBars(B.withVolumeFrom(read('SOX.json'), read('SOXX.json')));
  assert.equal(B.breakoutNow(sox, '2026-11-06').recent, null, 'no breakout in the last 20 days');
});
