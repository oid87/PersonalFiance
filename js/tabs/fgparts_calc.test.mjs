import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as F from './fgparts_calc.mjs';

test('normCdf matches known values', () => {
  assert.ok(Math.abs(F.normCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(F.normCdf(1.96) - 0.975) < 1e-4);
  assert.ok(Math.abs(F.normCdf(-1) - 0.158655) < 1e-5);
});

test('rollingScore: null until minObs, 50 for flat, high for a jump above the window', () => {
  const s = F.rollingScore([1, 2, 3, null, 10], 5, 3);
  assert.equal(s[0], null); assert.equal(s[1], null); assert.equal(s[3], null);
  assert.ok(s[2] > 50 && s[4] > 80);
  assert.equal(F.rollingScore([5, 5, 5], 3, 3)[2], 50);
});

test('fear-side indicators are inverted: higher put/call, junk spread, VIX vs MA → lower score', () => {
  const rows = Array.from({ length: 80 }, (_, i) => ({ date: `2024-01-${String(i).padStart(3, '0')}`,
    sp500: 100, sp125: 100, strength: 0, breadth: 0, safe_haven: 0,
    put_call: 0.7 + (i % 5) * 0.01 + (i === 79 ? 0.5 : 0), junk: 2 + (i % 3) * 0.01 + (i === 79 ? 1 : 0),
    vix: 15 + (i % 4) * 0.1 + (i === 79 ? 10 : 0), vix50: 15 }));
  const b = F.buildParts(rows);
  for (const id of ['putcall', 'junk', 'vix']) assert.ok(b.parts[id].score.at(-1) < 5, id);
});

test('equalWeight is the plain mean of seven and refuses partial input', () => {
  assert.equal(F.equalWeight([10, 20, 30, 40, 50, 60, 70]), 40);
  assert.equal(F.equalWeight([10, null, 30]), null);
});

test('officialSnapshot: CNN today scores average close to its published composite', () => {
  const p = new URL('../../data/fear_greed_components.json', import.meta.url);
  if (!existsSync(p)) return;
  const d = JSON.parse(readFileSync(p, 'utf8'));
  const o = F.officialSnapshot(d.scores.at(-1));
  assert.equal(o.items.length, 7);
  assert.ok(Math.abs(o.mean - o.composite) < 3, `mean ${o.mean} vs ${o.composite}`);
});

test('approximate composite tracks the real CNN index (corr > 0.9)', () => {
  const p = new URL('../../data/fear_greed_components.json', import.meta.url);
  const q = new URL('../../data/fear_greed.json', import.meta.url);
  if (!existsSync(p) || !existsSync(q)) return;
  const b = F.buildParts(JSON.parse(readFileSync(p, 'utf8')).data);
  const c = F.compareWithCnn(b.dates, b.composite, JSON.parse(readFileSync(q, 'utf8')).data);
  assert.ok(c.n > 500 && c.corr > 0.9 && c.mae < 8, JSON.stringify(c));
});

test('zoneOf uses CNN boundaries', () => {
  assert.deepEqual([10, 25, 50, 60, 80, null].map(F.zoneOf), ['極度恐懼', '恐懼', '中性', '貪婪', '極度貪婪', '—']);
});

test('movingAverage: exact window, null until full, clamps n', () => {
  assert.deepEqual(F.movingAverage([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
  assert.deepEqual(F.movingAverage([1, null, 3], 2), [null, null, null]);
  assert.equal(F.movingAverage([1, 2, 3], 1)[1], 1.5);
});

test('ELI5 covers all seven parts with a readable today line', () => {
  const r = { sp500: 6000, sp125: 5700, strength: 1, breadth: 500, put_call: 0.8, junk: 2, vix: 20, vix50: 16, safe_haven: 3 };
  for (const p of F.PARTS) {
    const e = F.ELI5[p.id];
    assert.ok(e && e.like && e.how && e.eg, p.id);
    assert.doesNotMatch(e.today(r), /—|NaN/, p.id);
  }
  assert.match(F.ELI5.momentum.today(r), /高於均線 5\.3%/);
});

test('mergeProxy keeps proxy rows only before CNN starts and CNN wins on the same day', () => {
  const m = F.mergeProxy([{ date: '2020-07-30', vix: 1 }, { date: '2020-08-03', vix: 2 }], [{ date: '2020-08-03', vix: 3 }, { date: '2020-08-04', vix: 4 }]);
  assert.deepEqual(m.map(r => [r.date, r.vix, r.proxy]), [['2020-07-30', 1, true], ['2020-08-03', 3, false], ['2020-08-04', 4, false]]);
});

test('priceWithMA computes the MA on full history before clipping to the display start', () => {
  const rows = [{ date: '2008-12-30', close: 1 }, { date: '2008-12-31', close: 3 }, { date: '2009-01-02', close: 5 }];
  const p = F.priceWithMA(rows, 2);
  assert.deepEqual(p.dates, ['2009-01-02']);
  assert.deepEqual(p.ma, [4]);
});

test('proxy backfill reaches 2009 and every part scores there', () => {
  const p = new URL('../../data/fear_greed_proxy.json', import.meta.url);
  const q = new URL('../../data/fear_greed_components.json', import.meta.url);
  if (!existsSync(p) || !existsSync(q)) return;
  const b = F.buildParts(F.mergeProxy(JSON.parse(readFileSync(p, 'utf8')).data, JSON.parse(readFileSync(q, 'utf8')).data));
  const i = b.dates.findIndex(d => d >= '2009-03-01');
  for (const part of F.PARTS) assert.ok(Number.isFinite(b.parts[part.id].score[i]), part.id);
});

test('vixTerm 對齊 VIX3M 並算 20/50 均線與比值', async () => {
  const { vixTerm } = await import('./fgparts_calc.mjs');
  const vix = Array.from({ length: 60 }, (_, i) => ({ date: `2020-0${1 + Math.floor(i / 28)}-${String(1 + (i % 28)).padStart(2, '0')}`, close: 20 }));
  const r = vixTerm(vix, [{ date: vix[59].date, vix3m: 25 }], '2000-01-01');
  assert.equal(r.ma20.at(-1), 20); assert.equal(r.ma50.at(-1), 20);
  assert.equal(r.ratio.at(-1), 0.8); assert.equal(r.vix3m[0], null);
});
