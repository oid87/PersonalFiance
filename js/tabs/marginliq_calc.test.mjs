import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { findLegs, legTable, hitStats, currentState, nsfStatus, cycleRows, cycleSummary, signalMap, signalMax4, regimeOf, marginMap, NSF_EVENTS } from './marginliq_calc.mjs';
import { mergeRatio } from './marginalert_calc.mjs';

const load = f => JSON.parse(fs.readFileSync(new URL(`../../data/${f}`, import.meta.url), 'utf8')).data;
const twii = load('TWII.json');
const margin = [...load('taiwan_margin_total_early.json'), ...load('taiwan_margin_total.json')];
const ratio = mergeRatio(load('taiwan_margin_ratio_mm.json'), load('taiwan_margin_ratio.json'), 'all').rows;
const signal = load('taiwan_business_signal.json');
const near = (a, b, eps) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

// ── 合成資料：公式與邊界 ─────────────────────────────────────────────
const bar = (date, high, low, close = low) => ({ date, high, low, close });
test('findLegs：跌 12% 才成段；反彈 12% 結束；最後一段未結束標 open', () => {
  const rows = [bar('2020-01-01', 100, 99), bar('2020-01-02', 99.5, 91), bar('2020-01-03', 95, 87), bar('2020-01-06', 98, 90), bar('2020-01-07', 99, 96), bar('2020-01-08', 97, 80)];
  const { legs } = findLegs(rows);
  assert.equal(legs.length, 2);
  assert.deepEqual([legs[0].peakDate, legs[0].lowDate, legs[0].open], ['2020-01-01', '2020-01-03', false]);
  near(legs[0].depth, -13, 1e-9);
  assert.deepEqual([legs[1].peakDate, legs[1].peak, legs[1].lowDate, legs[1].open], ['2020-01-07', 99, '2020-01-08', true]);
});
test('findLegs：跌不到 12% 不成段；缺 high／low 的列略過', () => {
  const { legs, rows } = findLegs([bar('a', 100, 99), { date: 'x', high: null, low: null }, bar('b', 100, 89)]);
  assert.equal(rows.length, 2);
  assert.equal(legs.length, 0);
});
test('currentState：三條線點位、是否觸及、距收盤', () => {
  const rows = [bar('2020-01-01', 100, 98, 99), bar('2020-01-02', 99, 85, 86), bar('2020-01-03', 90, 83, 88)];
  const s = currentState(rows, { lookback: 120 });
  assert.equal(s.hi, 100); assert.equal(s.hiDate, '2020-01-01'); assert.equal(s.lo, 83);
  near(s.l0.line, 86, 1e-9); near(s.l1.line, 84, 1e-9); near(s.l2.line, 76, 1e-9);
  assert.deepEqual([s.l0.touchDate, s.l1.touchDate, s.l2.touched], ['2020-01-02', '2020-01-03', false]);
  near(s.l2.needPct, (76 / 88 - 1) * 100, 1e-9);
  near(s.closePct, -12, 1e-9);
});
test('marginMap：單日變動 %，第一天為 null', () => {
  const m = marginMap([{ date: 'a', margin_money: 100 }, { date: 'b', margin_money: 97 }]);
  assert.equal(m.get('a').chg, null); near(m.get('b').chg, -3, 1e-9);
});
test('燈號：往前 4 個月最高分與分區', () => {
  const sm = signalMap([{ date: '2025-11-01', score: 37 }, { date: '2025-12-01', score: 38 }, { date: '2026-02-01', score: 29 }]);
  assert.equal(signalMax4(sm, '2026-02-15'), 38);
  assert.equal(signalMax4(sm, '2026-04-15'), 29);
  assert.equal(signalMax4(sm, '2027-01-01'), null);
  assert.deepEqual([regimeOf(30), regimeOf(29), regimeOf(24), regimeOf(null)], ['hot', 'mid', 'cold', null]);
});
test('國安基金名單：日期遞增、只有最後一筆可以沒有退場日', () => {
  NSF_EVENTS.forEach((e, i) => {
    if (i) assert.ok(e.decide > NSF_EVENTS[i - 1].decide);
    if (e.end === null) assert.equal(i, NSF_EVENTS.length - 1); else assert.ok(e.end >= e.decide);
  });
  assert.equal(nsfStatus('2020-06-01').active, true);
  assert.equal(nsfStatus('2021-06-01').active, false);
  assert.equal(nsfStatus('2021-06-01').event.n, NSF_EVENTS.at(-1).n);
});

// ── 真實資料：已核對過的歷史數字（資料只會往後加，這些波段不會變）───────────
const T = legTable({ twii, margin, ratio });
const leg = d => T.legs.find(l => l.peakDate === d);
test('2020/3：-16% 3/13、-24% 3/18，兩條線前後都有融資大減，國安基金 3/19', () => {
  const l = leg('2020-01-03');
  near(l.depth, -30.1, 0.1);
  assert.deepEqual([l.x1.date, l.x2.date, l.x1.hit, l.x2.hit], ['2020-03-13', '2020-03-18', true, true]);
  near(l.x1.chg, -8.3, 0.1); near(l.x2.ratio, 139.87, 0.05);
  assert.equal(l.nsf.decide, '2020-03-19'); near(l.nsf.lowPct, -30.1, 0.1);
});
test('2022：首次破 -16%（5/12）沒有融資大減；-24% 7/5；國安基金 7/12', () => {
  const l = leg('2022-01-05');
  assert.deepEqual([l.x1.date, l.x1.hit, l.x2.date, l.x2.hit, l.nsf.decide], ['2022-05-12', false, '2022-07-05', true, '2022-07-12']);
});
test('2024/8：只到 -19.5%，破 -16% 當天融資 -5.6%，沒有 -24%、沒有國安基金', () => {
  const l = leg('2024-07-11');
  near(l.depth, -19.5, 0.1); near(l.x1.chg, -5.6, 0.1);
  assert.equal(l.x2, null); assert.equal(l.nsf, null);
});
test('2025/4：-24% 4/8 當日維持率 135.3、融資 -10.0%，國安基金同日', () => {
  const l = leg('2025-01-07');
  assert.equal(l.x2.date, '2025-04-08'); near(l.x2.ratio, 135.31, 0.05); near(l.x2.chg, -10.0, 0.1);
  assert.equal(l.nsf.decide, '2025-04-08');
});
test('2021/5：沒跌到 -16%', () => {
  const l = leg('2021-04-29');
  near(l.depth, -14.4, 0.1); assert.equal(l.x1, null);
});
test('命中率：2020～2025 破 -16% 4 中 3、破 -24% 3 中 3 且國安基金 3 次；2001～2019 低很多', () => {
  const a = hitStats(T.legs, '2020-01-01', '2026-01-01');
  assert.deepEqual([a.n1, a.h1, a.n2, a.h2, a.nsf2], [4, 3, 3, 3, 3]);
  const b = hitStats(T.legs, '2001-02-01', '2020-01-01');
  assert.deepEqual([b.n1, b.h1], [16, 3]);
  assert.ok(b.h2 / b.n2 < 0.5);
});
test('週期表：景氣偏熱的第一波（2025 年底前）都沒超過前高 6%；偏冷的 2005、2018 大幅越過', () => {
  const c = cycleRows(twii, signal).filter(r => r.peakDate < '2026-01-01' && r.next);
  const hot = c.filter(r => r.regime === 'hot'), cold = c.filter(r => r.regime === 'cold');
  assert.deepEqual(hot.map(r => r.peakDate.slice(0, 7)), ['2000-02', '2004-03', '2007-07', '2010-01', '2011-02', '2021-04', '2024-07']);
  assert.ok(hot.every(r => r.next.capped));
  assert.deepEqual(cold.filter(r => !r.next.capped).map(r => r.peakDate.slice(0, 4)), ['2005', '2018']);
  const r21 = hot.find(r => r.peakDate === '2021-04-29');
  near(r21.next.upPct, 5.1, 0.1); near(r21.next.depth, -32.2, 0.1); assert.equal(r21.next.gap, 526);
  const s = cycleSummary(c).find(x => x.regime === 'hot');
  assert.deepEqual([s.n, s.capped], [7, 7]);
});
