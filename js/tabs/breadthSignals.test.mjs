import test from 'node:test';
import assert from 'node:assert/strict';
import { getBreadthDenominator, buildBreadthContext } from './breadthSignals.mjs';

const dates = n => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10));
function fixture(n, pct = 60) {
  const ds = dates(n);
  return { prices: ds.map((date, i) => ({ date, close: 100 + i })), rows: ds.map(date => ({ date, above20_pct: pct, above50_pct: pct, above200_pct: pct, total: 100 })) };
}
const context = ({ rows, prices }, win = 20) => buildBreadthContext(rows, prices, win);

test('denominators prefer positive explicit integers; only 50 accepts legacy total', () => {
  const row = { total: 100, above20_total: 70, above50_total: 80, above200_total: 90 };
  assert.deepEqual([20, 50, 200].map(w => getBreadthDenominator(row, w)), [70, 80, 90]);
  assert.deepEqual([20, 50, 200].map(w => getBreadthDenominator({ total: 100 }, w)), [null, 100, null]);
  for (const bad of [0, -1, null, NaN, Infinity, 1.5, '90']) {
    assert.equal(getBreadthDenominator({ above20_total: bad, total: 100 }, 20), null);
    assert.equal(getBreadthDenominator({ above50_total: bad, total: 100 }, 50), 100);
  }
  assert.equal(getBreadthDenominator(null, 50), null);
  assert.throws(() => getBreadthDenominator(row, 90));
});

test('all MA windows require full warmup and null slots invalidate the entire window', () => {
  for (const win of [20, 50, 200]) {
    const f = fixture(win + 3);
    const result = context(f, win);
    assert.equal(result.sessions[win - 2].ma, null);
    assert.equal(result.sessions[win - 1].ma, 100 + (win - 1) / 2);
    assert.equal(result.sessions[win - 1].eligible, false);
    assert.equal(result.sessions[win].eligible, true);
    f.prices[win - 1].close = null;
    const broken = context(f, win);
    assert.equal(broken.sessions[win + 2].ma, null);
    assert.equal(broken.sessions[win - 1].aboveMA, null);
  }
  const f = fixture(42); f.prices[20].close = null;
  const result = context(f);
  assert.equal(result.sessions[39].ma, null); assert.notEqual(result.sessions[40].ma, null);
  assert.equal(result.sessions[40].eligible, false); assert.equal(result.sessions[41].eligible, true);
});

test('crosses include threshold equality; divergence fires once on first valid onset', () => {
  const f = fixture(26);
  [50, 49, 48, 50, 49, 49].forEach((pct, j) => { f.rows[20 + j].above20_pct = pct; });
  const result = context(f);
  assert.deepEqual(result.signals.down.map(e => e.date), [f.rows[21].date, f.rows[24].date]);
  assert.deepEqual(result.signals.up.map(e => e.date), [f.rows[23].date]);
  assert.deepEqual(result.signals.divergence.map(e => e.date), [f.rows[21].date, f.rows[24].date]);
  assert.deepEqual(result.signals.divergence[0], { date: f.rows[21].date, pct: 49, previousPct: 50, close: 121, ma: 111.5, denominator: null });
  const flat = fixture(22, 40); flat.prices.forEach(p => { p.close = 100; });
  assert.equal(context(flat).current.aboveMA, false); assert.equal(context(flat).signals.divergence.length, 0);
});

test('missing breadth and invalid percentages never bridge across ETF sessions', () => {
  for (const bad of [null, undefined, NaN, Infinity, -1, 101, '60']) {
    const f = fixture(24); f.rows[21].above20_pct = bad; f.rows[22].above20_pct = 40;
    const result = context(f);
    assert.equal(result.sessions[21].pct, null); assert.equal(result.sessions[22].eligible, false);
    assert.equal(result.signals.down.length, 0); assert.equal(result.signals.divergence.length, 0);
  }
  const f = fixture(24); f.rows.splice(21, 1); f.rows.find(r => r.date === f.prices[22].date).above20_pct = 40;
  const result = context(f);
  assert.equal(result.sessions[21].row, null); assert.equal(result.sessions[22].eligible, false);
  assert.equal(result.signals.down.length, 0);
});

test('peak and momentum use full 90/180-session windows and reject gaps', () => {
  const f = fixture(180, 40); f.rows.slice(0, 90).forEach(r => { r.above20_pct = 80; });
  const result = context(f);
  assert.equal(result.peakByDate[f.rows[88].date], null); assert.equal(result.peakByDate[f.rows[89].date], 80);
  assert.deepEqual(result.momentum, { peakNow: 40, peakPrior: 80, diff: -40 });
  assert.equal(context({ prices: f.prices.slice(0, 179), rows: f.rows.slice(0, 179) }).momentum, null);
  f.rows[30].above20_pct = null; assert.equal(context(f).momentum, null);
  assert.equal(context(f).peakByDate[f.rows[119].date], null);
  assert.equal(context(f).peakByDate[f.rows[120].date], 80);
});

test('current and source dates preserve mismatched tails and unknown breadth/MA', () => {
  const f = fixture(22); f.rows[20].above20_pct = null;
  f.rows.pop(); f.prices[21].close = null;
  f.rows.push({ date: '2026-01-01', above20_pct: 40 });
  const result = context(f);
  assert.equal(result.current.date, f.prices[20].date); assert.equal(result.current.pct, null);
  assert.equal(result.commonDate, f.prices[20].date);
  assert.equal(result.latestPriceDate, f.prices[21].date); assert.equal(result.latestBreadthDate, '2026-01-01');
  assert.equal(context(fixture(3)).current.ma, null);
  const empty = context({ rows: [], prices: [] });
  assert.equal(empty.current, null); assert.equal(empty.momentum, null); assert.equal(empty.commonDate, null);
});

test('Hindenburg uses hl_total, strict 2.2%, fifty ETF sessions and exactly thirty recent sessions', () => {
  const f = fixture(100);
  for (const i of [50, 69, 70, 99]) Object.assign(f.rows[i], { new_hi_count: 3, new_lo_count: 3, hl_total: 100 });
  const result = context(f);
  assert.deepEqual(result.hindenburgDates, [50, 69, 70, 99].map(i => f.rows[i].date));
  assert.equal(result.hindenburgRecentCount, 2);
  for (const patch of [{ hl_total: undefined }, { new_hi_count: 2.2 }, { new_lo_count: null }, { new_hi_count: 7 }, { new_hi_count: '3' }]) {
    const altered = fixture(51); Object.assign(altered.rows[50], { new_hi_count: 3, new_lo_count: 3, hl_total: 100 }, patch);
    assert.equal(context(altered).hindenburgDates.length, 0);
  }
  f.prices[0].close = null;
  assert.ok(!context(f).hindenburgDates.includes(f.rows[50].date));
  const sparse = fixture(60); sparse.rows.splice(0, 20); Object.assign(sparse.rows.at(-1), { new_hi_count: 3, new_lo_count: 3, hl_total: 100 });
  assert.deepEqual(context(sparse).hindenburgDates, [sparse.rows.at(-1).date]);
});

test('recent Hindenburg count never includes future ETF rows after current common date', () => {
  const f = fixture(101); Object.assign(f.rows[99], { new_hi_count: 3, new_lo_count: 3, hl_total: 100 });
  f.rows[100].new_hi_count = 3; f.rows[100].new_lo_count = 3; f.rows[100].hl_total = 100;
  f.prices[100].close = null;
  const result = context(f);
  assert.equal(result.commonDate, f.rows[99].date); assert.equal(result.hindenburgRecentCount, 1);
});

test('malformed, duplicated and unordered dates, invalid prices and unsupported MA reject', () => {
  const f = fixture(22);
  assert.throws(() => context(f, 90));
  assert.throws(() => context({ ...f, rows: [f.rows[0], f.rows[0]] }));
  assert.throws(() => context({ ...f, rows: [...f.rows].reverse() }));
  assert.throws(() => context({ ...f, prices: [f.prices[0], f.prices[0]] }));
  assert.throws(() => context({ ...f, prices: [...f.prices].reverse() }));
  assert.throws(() => context({ ...f, rows: [{ date: '2026-02-30' }] }));
  for (const close of [0, -1, Infinity, NaN, undefined, '100']) {
    assert.throws(() => context({ ...f, prices: [{ date: f.prices[0].date, close }] }));
  }
});
