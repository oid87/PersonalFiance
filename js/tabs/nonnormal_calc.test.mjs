import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as N from './nonnormal_calc.mjs';

function businessDays(start, n) {
  const out = []; let t = Date.parse(start);
  while (out.length < n) { const d = new Date(t); if (![0, 6].includes(d.getUTCDay())) out.push(d.toISOString().slice(0, 10)); t += 86400000; }
  return out;
}
const rows = (dates, closes, field = 'close') => dates.map((date, i) => ({ date, [field]: closes[i] }));
const flat = (n, v) => new Array(n).fill(v);
const DATES = businessDays('2023-01-02', 320);
const last = DATES.at(-1);
/** Every series flat at a calm level; override per test. */
function rawWith(over = {}) {
  const base = {};
  for (const s of N.SERIES) base[s.id] = rows(DATES, flat(DATES.length, s.id === 'VIX' ? 14 : s.unit === '%' ? 4 : 100), s.field || 'close');
  base.marginMm = []; base.marginDaily = rows(DATES, flat(DATES.length, 170), 'ratio'); base.breadth = [];
  return { ...base, ...over };
}
const sig = (week, id) => week.signals.find(s => s.id === id);

test('buildSeries sorts, de-duplicates and drops non-finite rows instead of filling them', () => {
  const s = N.buildSeries([{ date: '2024-01-03', close: 3 }, { date: '2024-01-02', close: 2 }, { date: '2024-01-03', close: 9 }, { date: '2024-01-04', close: null }, { date: '2024-01-05', close: NaN }]);
  assert.deepEqual(s.dates, ['2024-01-02', '2024-01-03']);
  assert.deepEqual(s.close, [2, 3]);
});

test('calm flat market → every counted signal off, level 常態', () => {
  const w = N.evaluateWeek(N.buildContext(rawWith()), last);
  assert.equal(w.count, 0);
  assert.equal(w.level, 0);
  assert.equal(sig(w, 'breadth').state, 'na', 'no breadth data → unavailable, never off');
  assert.equal(sig(w, 'oil').state, 'off');
});

test('stale series → unavailable (na), not off', () => {
  const raw = rawWith({ OIL: rows(DATES.slice(0, 300), flat(300, 80)) });
  const w = N.evaluateWeek(N.buildContext(raw), last);
  assert.equal(sig(w, 'oil').state, 'na');
  assert.match(sig(w, 'oil').reason, /資料停在/);
});

test('levelOf: single signal is noise; alert needs ≥4 lit across ≥2 groups; high needs ≥6 and all three groups', () => {
  assert.equal(N.levelOf(1, 1), 0);
  assert.equal(N.levelOf(3, 3), 1);
  assert.equal(N.levelOf(5, 1), 1);
  assert.equal(N.levelOf(4, 2), 2);
  assert.equal(N.levelOf(7, 2), 2);
  assert.equal(N.levelOf(6, 3), 3);
});

test('tiers: VIX zones and margin-ratio tiers use the reference boundaries', () => {
  assert.deepEqual([14.99, 15, 19.99, 20, 30, 39.9, 40, 82].map(N.vixZone), [0, 1, 1, 2, 3, 3, 4, 4]);
  assert.equal(N.vixZone(null), -1);
  assert.deepEqual([200, 166, 165.9, 150, 149.9, 140, 139.9, 130, 129.9].map(N.marginTier), [0, 0, 1, 1, 2, 2, 3, 3, 4]);
});

test('SOX: a 15% drop from the 20-day high lights even while still above the 100-day average', () => {
  const c = DATES.map((_, i) => (i < 250 ? 100 + i : 350 + (i - 250) * 5));   // strong rally
  c[c.length - 1] = c[c.length - 2] * 0.84;                                    // −16% in one day, still far above MA60
  const w = N.evaluateWeek(N.buildContext(rawWith({ SOX: rows(DATES, c) })), last);
  assert.equal(sig(w, 'sox').state, 'on');
  assert.ok(sig(w, 'sox').tags.some(t => t.includes('急跌')));
  assert.ok(sig(w, 'sox').tags.some(t => t.includes('盤中')), 'a ≥5% single-day drop is annotated');
});

test('Nasdaq is a counted group-A signal with the S&P 500 rule; order is 費半 → 那斯達克 → S&P 500', () => {
  assert.deepEqual(N.SIGNALS.filter(s => s.group === 'A').map(s => s.id), ['sox', 'ndx', 'spx', 'kospi']);
  const closes = DATES.map((_, i) => (i < DATES.length - 10 ? 100 : 93));
  const w = N.evaluateWeek(N.buildContext(rawWith({ NDX: rows(DATES, closes) })), last);
  assert.equal(sig(w, 'ndx').state, 'on');
  assert.deepEqual(sig(w, 'ndx').tags, ['崩跌 > 5%']);
  assert.equal(sig(w, 'spx').state, 'off');
});

test('trendSlope: dipping under a still-rising 100-day average is not 轉弱 by default, is with trendSlope=false', () => {
  const c = DATES.map((_, i) => 100 + i * 0.05);
  c[c.length - 1] = c[c.length - 1] - 3;    // −2.6%: under the 100-day line while it still rises, no 5% shock   // just under MA60, MA60 still rising, drop < 5%
  const raw = rawWith({ SPX: rows(DATES, c) });
  assert.equal(sig(N.evaluateWeek(N.buildContext(raw), last), 'spx').state, 'off');
  assert.equal(sig(N.evaluateWeek(N.buildContext(raw, { trendSlope: false }), last), 'spx').state, 'on');
});

test('OTC lights on a close below the 100-day average regardless of trendSlope', () => {
  const c = DATES.map((_, i) => 100 + i * 0.05);
  c[c.length - 1] = c[c.length - 1] - 3;    // −2.6%: under the 100-day line while it still rises, no 5% shock
  const w = N.evaluateWeek(N.buildContext(rawWith({ TWOII: rows(DATES, c) })), last);
  assert.equal(sig(w, 'otc').state, 'on');
  assert.ok(sig(w, 'otc').tags.includes('先於加權'));
});

test('breadth divergence: weak breadth counts only while TWII is still above its 100-day average', () => {
  const breadth = DATES.map(date => ({ date, bull: 200, bear: 500, neutral: 300, n: 1000 }));
  const down = DATES.map((_, i) => 300 - i * 0.5);
  const strong = N.evaluateWeek(N.buildContext(rawWith({ breadth })), last);
  assert.equal(sig(strong, 'breadth').state, 'on');
  const weakIndex = rawWith({ breadth, TWII: rows(DATES, down) });
  assert.equal(sig(N.evaluateWeek(N.buildContext(weakIndex), last), 'breadth').state, 'off');
  assert.equal(sig(N.evaluateWeek(N.buildContext(weakIndex, { breadthDivergence: false }), last), 'breadth').state, 'on');
});

test('breadth is unavailable (not off) when TWII is missing or stale', () => {
  const breadth = DATES.map(date => ({ date, bull: 200, bear: 500, neutral: 300, n: 1000 }));
  for (const TWII of [[], rows(DATES.slice(0, 290), flat(290, 100))]) {
    const s = sig(N.evaluateWeek(N.buildContext(rawWith({ breadth, TWII })), last), 'breadth');
    assert.equal(s.state, 'na');
    assert.deepEqual(s.tags, []);
  }
});

test('gold spike counts only with VIX ≥ 20 (panic type)', () => {
  const g = flat(DATES.length, 100); g[g.length - 1] = 107;
  const calm = N.evaluateWeek(N.buildContext(rawWith({ GOLD: rows(DATES, g) })), last);
  assert.equal(sig(calm, 'gold').state, 'off');
  assert.ok(sig(calm, 'gold').tags[0].includes('非恐慌型'));
  const v = flat(DATES.length, 14); v[v.length - 1] = 24;
  const panic = N.evaluateWeek(N.buildContext(rawWith({ GOLD: rows(DATES, g), VIX: rows(DATES, v) })), last);
  assert.equal(sig(panic, 'gold').state, 'on');
  assert.equal(sig(panic, 'vix').state, 'on');
});

test('oil is two-sided: a 20% crash lights like a 20% spike', () => {
  for (const k of [1.22, 0.78]) {
    const o = flat(DATES.length, 80); o[o.length - 1] = 80 * k;
    assert.equal(sig(N.evaluateWeek(N.buildContext(rawWith({ OIL: rows(DATES, o) })), last), 'oil').state, 'on', String(k));
  }
});

test('DXY: a > 5 point jump within 20 trading days lights; a 5 point fall does not count as risk', () => {
  const up = flat(DATES.length, 100); up[up.length - 1] = 105.5;
  assert.equal(sig(N.evaluateWeek(N.buildContext(rawWith({ DXY: rows(DATES, up) })), last), 'dxy').state, 'on');
  const dn = flat(DATES.length, 100); dn[dn.length - 1] = 94.5;
  const w = N.evaluateWeek(N.buildContext(rawWith({ DXY: rows(DATES, dn) })), last);
  assert.equal(sig(w, 'dxy').state, 'off');
  assert.ok(sig(w, 'dxy').tags.some(t => t.includes('不計')));
});

test('10Y: +25bp off the 20-day low lights (float-safe); 2s10s inversion is only annotated', () => {
  const y = flat(DATES.length, 0.88); y[y.length - 1] = 1.13;   // 1.13 − 0.88 = 0.2499999999999999 in floating point
  assert.equal(sig(N.evaluateWeek(N.buildContext(rawWith({ US10Y: rows(DATES, y, 'value') })), last), 'us10y').state, 'on');
  y[y.length - 1] = 4.3; y.fill(4, 0, y.length - 1);
  const w = N.evaluateWeek(N.buildContext(rawWith({ US10Y: rows(DATES, y, 'value'), US2Y: rows(DATES, flat(DATES.length, 4.5), 'value') })), last);
  assert.equal(sig(w, 'us10y').state, 'on');
  assert.match(sig(w, 'us10y').tags[0], /倒掛 -20bp/);
});

test('margin: the lower of 上市 and 上櫃 decides; 上櫃 alone counts when 上市 is missing; stale 上櫃 is ignored', () => {
  const otcLow = rawWith({ tpex: rows(DATES.slice(-30), flat(30, 145), 'ratio_all') });
  const w = N.evaluateWeek(N.buildContext(otcLow), last), m = sig(w, 'margin');
  assert.equal(m.state, 'on');
  assert.match(m.text, /上市 170\.0%｜上櫃 145\.0%/);
  assert.match(m.tags[0], /^上櫃 < 150%/);
  const t = N.turnaround(N.buildContext(otcLow), last);
  assert.equal(t.margin.market, '上櫃');
  assert.equal(t.marginBelow140, false);
  assert.equal(sig(N.evaluateWeek(N.buildContext(rawWith({ marginDaily: [], tpex: rows(DATES.slice(-5), flat(5, 160), 'ratio_all') })), last), 'margin').state, 'off');
  const stale = rawWith({ tpex: rows(DATES.slice(-60, -40), flat(20, 120), 'ratio_all') });
  assert.equal(sig(N.evaluateWeek(N.buildContext(stale), last), 'margin').state, 'off');
});

test('quote: last value, day and week change, ~6-month window with 50/100-day averages from full history', () => {
  const closes = DATES.map((_, i) => 100 + i);
  const ctx = N.buildContext(rawWith({ SOX: rows(DATES, closes) }));
  const q = N.quote(ctx.s.SOX, last);
  assert.equal(q.last, 100 + DATES.length - 1);
  assert.equal(q.chg, 1);
  assert.equal(q.w1, 5, 'five business days back');
  assert.equal(q.dates[0], '2023-09-21');
  assert.ok(q.dates.length > 125 && q.dates.length < 135, String(q.dates.length));
  assert.equal(q.ma[50][0], q.close[0] - 24.5, 'MA50 defined on the window\'s first day');
  assert.equal(q.ma[100].at(-1), q.last - 49.5);
  assert.equal(q.stale, false);
  assert.equal(N.quote(ctx.s.SOX, '2022-01-01'), null);
});

test('no look-ahead: a week evaluated with or without later data is identical', () => {
  const c = DATES.map((_, i) => 100 + Math.sin(i / 9) * 20 - (i > 280 ? (i - 280) * 2 : 0));
  const full = rawWith({ SOX: rows(DATES, c), SPX: rows(DATES, c), KOSPI: rows(DATES, c), TWOII: rows(DATES, c) });
  const cut = DATES[290];
  const trimmed = Object.fromEntries(Object.entries(full).map(([k, v]) => [k, v.filter(r => r.date <= cut)]));
  const a = N.evaluateWeek(N.buildContext(full), cut), b = N.evaluateWeek(N.buildContext(trimmed), cut);
  assert.deepEqual(a, b);
});

test('leadLag reports OTC breaking the 100-day average 3 trading days before TWII', () => {
  const up = DATES.map((_, i) => 100 + i * 0.2);
  const two = up.slice(), tw = up.slice(), n = DATES.length;
  for (let i = n - 6; i < n; i++) two[i] = 50;      // OTC breaks first
  for (let i = n - 3; i < n; i++) tw[i] = 50;       // TWII three sessions later
  const ctx = N.buildContext(rawWith({ TWOII: rows(DATES, two), TWII: rows(DATES, tw) }));
  const q = N.leadLag(ctx, last).find(r => r.ma === N.P.maShort);
  assert.equal(q.otcBelowSince, DATES[n - 6]);
  assert.equal(q.twiiBelowSince, DATES[n - 3]);
  assert.equal(q.tradingGap, 3);
  assert.match(q.note, /櫃買早 3 日/);
});

test('weekDates are Fridays plus the last data date for the running week', () => {
  const ctx = { lastDate: '2026-10-21' };
  assert.deepEqual(N.weekDates(ctx, '2026-10-01'), ['2026-10-02', '2026-10-09', '2026-10-16', '2026-10-21']);
  assert.deepEqual(N.weekDates({ lastDate: '2026-10-16' }, '2026-10-10'), ['2026-10-16']);
  assert.deepEqual(N.weekDates({ lastDate: '2026-10-21' }, '2026-10-01', '2026-10-13'), ['2026-10-02', '2026-10-09'], 'a past `to` adds no off-cycle date');
  assert.deepEqual(N.weekDates({ lastDate: '2026-10-17' }, '2026-10-01'), ['2026-10-02', '2026-10-09', '2026-10-17'], 'Saturday session replaces its Friday');
  assert.deepEqual(N.weekDates({ lastDate: '2026-10-01' }, '2026-10-10'), []);
});

test('forwardDrawdown is null until the whole horizon has data', () => {
  const ctx = N.buildContext(rawWith());
  assert.equal(N.forwardDrawdown(ctx, last), null);
  assert.equal(N.forwardDrawdown(ctx, DATES[100]), 0);
});

// ── real repository data: the historical case dates ────────────────────────
const D = new URL('../../data/', import.meta.url);
const haveData = ['TWII.json', 'TWOII.json', 'SOX.json'].every(f => existsSync(new URL(f, D)));
function realContext() {
  const read = f => (existsSync(new URL(f, D)) ? JSON.parse(readFileSync(new URL(f, D), 'utf8')).data : []);
  const raw = Object.fromEntries(N.SERIES.map(s => [s.id, read(s.file)]));
  for (const [k, f] of Object.entries(N.EXTRA_FILES)) raw[k] = read(f);
  return N.buildContext(raw);
}

test('data check: 400-day line reproduces the 2025 case dates (OTC 2025-03-28, TWII 2025-04-07)', { skip: !haveData }, () => {
  const q = N.leadLag(realContext(), '2025-04-07').find(r => r.ma === 400);
  assert.equal(q.otcBelowSince, '2025-03-28');
  assert.equal(q.twiiBelowSince, '2025-04-07');
});

test('data check: 2026-07 OTC broke its 100-day line while TWII held', { skip: !haveData }, () => {
  const q = N.leadLag(realContext(), '2026-07-17').find(r => r.ma === 100);
  assert.equal(q.otcBelowSince, '2026-07-17');
  assert.equal(q.twiiBelowSince, null);
});

test('case 2022: multi-market alert well before TWII broke its 200-day average', { skip: !haveData }, () => {
  const r = N.caseResult(realContext(), N.CASES.find(c => c.id === '2022'));
  assert.ok(r.lastBefore.level >= 2);
  assert.ok(r.leadWeeks >= 4, `lead ${r.leadWeeks} weeks`);
});
