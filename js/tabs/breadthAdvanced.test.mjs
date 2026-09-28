import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBreadthImport, buildAdvancedContext, projectSp500Bundle } from './breadthAdvanced.mjs';
import { makeAdvancedFixture } from '../../scripts/fixtures/breadth_advanced_fixture.mjs';

function fixture(n = 650) {
  const dates = Array.from({ length: n }, (_, i) => new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10));
  const common = { source: 'TEST', constituentsBasis: 'TEST', priceBasis: 'TEST' };
  return { schemaVersion: 1,
    benchmark: { symbol: 'SP500', source: 'TEST', priceBasis: 'TEST', data: dates.map(date => ({ date, close: 100 })) },
    sp500: { ...common, universe: 'SP500', data: dates.map(date => ({ date, advances: 2, declines: 1, unchanged: 0 })) },
    nyse: { ...common, universe: 'NYSE', variant: 'raw',
      seed: { date: '2019-12-31', ema19: 0, ema39: 0, summation: 0, source: 'TEST', calibration: 'provider' },
      data: dates.map(date => ({ date, advances: 100, declines: 100, unchanged: 0 })) } };
}
const clone = value => structuredClone(value);
const indices = (ctx, name) => ctx.signals[name].map(e => ctx.sessions.findIndex(s => s.date === e.date));
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
function adShock(f, i) { Object.assign(f.sp500.data[i], { advances: 0, declines: 500 }); }
function mcShock(f, i) { Object.assign(f.nyse.data[i], { advances: 0, declines: 20000 }); }
function prefix(f, n) {
  const result = clone(f);
  for (const name of ['benchmark', 'sp500', 'nyse']) if (result[name]) result[name].data = result[name].data.slice(0, n);
  return result;
}

test('parser copies inputs, trims metadata, accepts JSON and single-universe imports', () => {
  const f = fixture(3), original = clone(f); f.benchmark.source = ' TEST ';
  const parsed = parseBreadthImport(f);
  assert.equal(parsed.benchmark.source, 'TEST');
  parsed.benchmark.data[0].close = 20; parsed.nyse.seed.ema19 = 10;
  assert.equal(f.benchmark.data[0].close, 100); assert.equal(f.nyse.seed.ema19, 0);
  assert.deepEqual(parseBreadthImport(JSON.stringify(original)), original);
  for (const removed of ['sp500', 'nyse']) {
    const single = clone(original); delete single[removed];
    const c = buildAdvancedContext(single);
    assert.equal(c.signals[removed === 'sp500' ? 'ad' : 'mc'].length, 0);
    assert.equal(c.signals.joint.length, 0);
    assert.equal(c.latest[removed], null);
  }
});

test('raw and ratio oscillator follow hand calculations with and without seed', () => {
  for (const variant of ['raw', 'ratio']) {
    const f = fixture(3); f.nyse.variant = variant; f.nyse.seed = null;
    [[60, 40], [70, 30], [80, 20]].forEach(([advances, declines], i) => Object.assign(f.nyse.data[i], { advances, declines }));
    const c = buildAdvancedContext(f), factor = variant === 'raw' ? 1 : 10;
    near(c.sessions[0].oscillator, 0); near(c.sessions[0].summation, 0);
    near(c.sessions[1].oscillator, factor); near(c.sessions[1].summation, factor);
    near(c.sessions[2].oscillator, 2.85 * factor); near(c.sessions[2].summation, 3.85 * factor);
    assert.equal(c.meta.calibrated, false); assert.deepEqual(c.signals.mc, []); assert.deepEqual(c.eligibleDates.mc, []);
    f.nyse.seed = { date: '2019-12-31', ema19: 10, ema39: 20, summation: 100, source: 'TEST', calibration: 'provider' };
    const s = buildAdvancedContext(f).sessions[0];
    const net = 20 * factor;
    near(s.oscillator, (0.1 * net + 9) - (0.05 * net + 19));
    near(s.summation, 100 + s.oscillator);
  }
});

test('warmup is 252 processed NYSE observations, eligibility needs another 252', () => {
  const f = fixture(510); f.nyse.data.splice(0, 3);
  const c = buildAdvancedContext(f);
  assert.equal(c.sessions[2].summation, null); assert.equal(c.sessions[253].mcReady, false);
  assert.equal(c.sessions[254].mcReady, true); assert.equal(c.sessions[254].mcCalibrated, true);
  assert.equal(c.eligibleDates.mc[0], c.sessions[506].date);
  assert.equal(c.diagnostics.mcInvalidated, false); assert.equal(c.diagnostics.missingNyse, 0);
  f.nyse.seed = null;
  const uncalibrated = buildAdvancedContext(f);
  assert.equal(uncalibrated.sessions[254].mcReady, true); assert.equal(uncalibrated.sessions[254].mcCalibrated, false);
  assert.deepEqual(uncalibrated.eligibleDates.mc, []);
});

test('AD200 and 252-session strict-above condition use contiguous full windows', () => {
  const f = fixture(453); adShock(f, 451);
  const c = buildAdvancedContext(f);
  assert.equal(c.sessions[198].adMA200, null); near(c.sessions[199].adMA200, 100.5);
  assert.equal(c.eligibleDates.ad[0], c.sessions[451].date);
  assert.deepEqual(indices(c, 'ad'), [451]);
  near(c.sessions[451].adMA200, c.sessions.slice(252, 452).reduce((sum, s) => sum + s.ad, 0) / 200);
  const early = fixture(452); adShock(early, 450); assert.deepEqual(indices(buildAdvancedContext(early), 'ad'), []);
  const equal = fixture(452);
  equal.sp500.data.slice(0, 200).forEach(r => Object.assign(r, { advances: 1, declines: 1 })); adShock(equal, 451);
  const ec = buildAdvancedContext(equal);
  assert.equal(ec.sessions[199].ad, ec.sessions[199].adMA200);
  assert.ok(ec.eligibleDates.ad.includes(ec.sessions[451].date)); assert.deepEqual(ec.signals.ad, []);
  const sameDayEqual = fixture(453);
  sameDayEqual.sp500.data.forEach(r => Object.assign(r, { advances: 1, declines: 1 }));
  assert.equal(buildAdvancedContext(sameDayEqual).signals.ad.length, 0);
});

test('MC equality qualifies prior history; current equality is not a signal; baseline is unscreened', () => {
  const f = fixture(506); f.nyse.seed.summation = -500; mcShock(f, 503);
  const c = buildAdvancedContext(f);
  assert.deepEqual(indices(c, 'mc'), [503]); assert.equal(c.eligibleDates.mc[0], c.sessions[503].date);
  assert.ok(c.eligibleDates.mc.includes(c.sessions[505].date));
  const equal = fixture(505); equal.nyse.seed.summation = -500;
  assert.deepEqual(buildAdvancedContext(equal).signals.mc, []);
  const early = fixture(505); mcShock(early, 502);
  assert.deepEqual(buildAdvancedContext(early).signals.mc, []);
});

test('P5 pairs same-day, lag5, both orderings; excludes lag6 and never backdates', () => {
  for (const lag of [0, 5, 6]) for (const reverse of [false, true]) {
    const f = fixture(); const adAt = reverse ? 600 + lag : 600, mcAt = reverse ? 600 : 600 + lag;
    adShock(f, adAt); mcShock(f, mcAt);
    const c = buildAdvancedContext(f);
    assert.deepEqual(indices(c, 'ad'), [adAt]); assert.deepEqual(indices(c, 'mc'), [mcAt]);
    assert.deepEqual(indices(c, 'joint'), lag <= 5 ? [600 + lag] : []);
    if (lag <= 5) {
      const event = c.signals.joint[0], s = c.sessions[600 + lag];
      assert.equal(event.adDate, c.sessions[adAt].date); assert.equal(event.mcDate, c.sessions[mcAt].date);
      assert.equal(event.lagSessions, lag); assert.equal(event.ad, s.ad);
      assert.equal(event.adMA200, s.adMA200); assert.equal(event.summation, s.summation);
      if (lag) assert.ok(!c.signals.joint.some(e => e.date === c.sessions[600].date));
    }
  }
});

test('joint requires six eligible consecutive sessions, including current close', () => {
  const f = fixture(); adShock(f, 600); mcShock(f, 605); f.benchmark.data[602].close = null;
  const c = buildAdvancedContext(f);
  assert.deepEqual(indices(c, 'ad'), [600]); assert.deepEqual(indices(c, 'mc'), [605]); assert.deepEqual(c.signals.joint, []);
  assert.ok(!c.eligibleDates.joint.includes(c.sessions[607].date)); assert.ok(c.eligibleDates.joint.includes(c.sessions[608].date));
  f.benchmark.data[605].close = null;
  assert.deepEqual(buildAdvancedContext(f).signals.mc, []);
});

test('AD resets its segment after missing rows/nulls; MC stops permanently after either', () => {
  for (const type of ['row', 'null']) {
    const f = fixture();
    for (const name of ['sp500', 'nyse']) {
      if (type === 'row') f[name].data.splice(300, 1);
      else Object.assign(f[name].data[300], { advances: null, declines: null, unchanged: null });
    }
    const c = buildAdvancedContext(f);
    assert.equal(c.sessions[300].ad, null); assert.equal(c.sessions[301].ad, 1);
    assert.equal(c.sessions[499].adMA200, null); assert.equal(c.sessions[500].adMA200, 100.5);
    assert.equal(c.sessions[299].summation, 0); assert.equal(c.sessions[300].summation, null);
    assert.equal(c.sessions[649].summation, null); assert.equal(c.sessions[649].mcCalibrated, false);
    assert.equal(c.diagnostics.mcInvalidated, true); assert.equal(c.diagnostics.missingNyse, 1);
    assert.equal(c.diagnostics.missingSp500, 1);
  }
});

test('ratio zero denominator invalidates; raw all-unchanged remains a zero observation', () => {
  const f = fixture(3); Object.assign(f.nyse.data[1], { advances: 0, declines: 0, unchanged: 100 });
  const raw = buildAdvancedContext(f); assert.equal(raw.sessions[2].summation, 0); assert.equal(raw.diagnostics.mcInvalidated, false);
  f.nyse.variant = 'ratio'; const ratio = buildAdvancedContext(f);
  assert.equal(ratio.sessions[0].summation, 0); assert.equal(ratio.sessions[1].summation, null);
  assert.equal(ratio.sessions[2].summation, null); assert.equal(ratio.diagnostics.mcInvalidated, true);
});

test('first missing NYSE observation invalidates, pre-start sessions do not; tails preserve prior events', () => {
  const f = fixture(); adShock(f, 600); mcShock(f, 600);
  f.nyse.data.pop(); f.sp500.data.pop();
  const c = buildAdvancedContext(f);
  assert.equal(c.sessions.at(-1).summation, null); assert.equal(c.sessions.at(-1).ad, null);
  assert.deepEqual(indices(c, 'joint'), [600]); assert.equal(c.diagnostics.mcInvalidated, true);
  assert.equal(c.latest.nyse, f.nyse.data.at(-1).date);
  const first = fixture(3); Object.assign(first.nyse.data[0], { advances: null, declines: null, unchanged: null });
  assert.ok(buildAdvancedContext(first).sessions.every(s => s.summation === null));
  const empty = fixture(3); empty.nyse.data = []; empty.sp500.data = [];
  const ec = buildAdvancedContext(empty); assert.equal(ec.diagnostics.mcInvalidated, false);
  assert.equal(ec.latest.nyse, null); assert.equal(ec.latest.sp500, null);
});

test('derived history, eligibility and evidence are prefix invariant', () => {
  const f = makeAdvancedFixture(), full = buildAdvancedContext(f);
  for (const n of [252, 451, 509, 524, 525, 1125, 1130, 1250]) {
    const c = buildAdvancedContext(prefix(f, n)), end = c.sessions.at(-1).date;
    assert.deepEqual(c.sessions, full.sessions.slice(0, n));
    for (const name of ['ad', 'mc', 'joint']) {
      assert.deepEqual(c.signals[name], full.signals[name].filter(e => e.date <= end));
      assert.deepEqual(c.eligibleDates[name], full.eligibleDates[name].filter(date => date <= end));
    }
  }
});

test('deterministic fixture provides both joint orderings and complete/tail horizons', () => {
  const f = makeAdvancedFixture(); assert.deepEqual(f, makeAdvancedFixture());
  assert.ok(f.benchmark.data.length >= 1100); assert.match(f.benchmark.source, /SYNTHETIC TEST ONLY/);
  assert.ok(f.benchmark.data.every(r => ![0, 6].includes(new Date(`${r.date}T00:00:00Z`).getUTCDay())));
  const c = buildAdvancedContext(f);
  assert.deepEqual(indices(c, 'ad'), [523, 1129]); assert.deepEqual(indices(c, 'mc'), [524, 1124]);
  assert.deepEqual(indices(c, 'joint'), [524, 1129]);
  assert.ok(524 + 252 < f.benchmark.data.length); assert.ok(1129 + 252 >= f.benchmark.data.length);
});

test('rejects malformed schema, metadata, enums, size, row count and dates', () => {
  for (const input of [null, [], 1, 'broken JSON', '{}']) assert.throws(() => parseBreadthImport(input));
  const changes = [f => { f.schemaVersion = '1'; }, f => { delete f.benchmark; }, f => { f.benchmark.symbol = 'SPY'; },
    f => { delete f.sp500; delete f.nyse; }, f => { f.sp500.universe = 'NYSE'; }, f => { f.nyse.universe = 'SP500'; },
    f => { f.nyse.variant = 'unknown'; }, f => { f.sp500 = null; }, f => { f.benchmark.data = []; },
    f => { f.benchmark.source = ' '; }, f => { f.sp500.constituentsBasis = 4; }, f => { f.nyse.priceBasis = 'x'.repeat(501); },
    f => { f.benchmark.data[0].date = '2020-02-30'; }, f => { f.benchmark.data[0].date = '2020-1-01'; },
    f => { f.sp500.data[1].date = f.sp500.data[0].date; }, f => { f.nyse.data.reverse(); },
    f => { f.benchmark.data.reverse(); }, f => { f.nyse.data[0].date = '2019-01-01'; },
    f => { f.sp500.data[0].date = '2019-01-01'; }, f => { f.benchmark.data = Array(20001).fill(f.benchmark.data[0]); }];
  for (const change of changes) { const f = fixture(3); change(f); assert.throws(() => parseBreadthImport(f)); assert.throws(() => buildAdvancedContext(f)); }
  assert.throws(() => parseBreadthImport(' '.repeat(10 * 1024 * 1024 + 1)), /10 MiB/);
  assert.throws(() => parseBreadthImport('é'.repeat(5 * 1024 * 1024 + 1)), /10 MiB/);
});

test('rejects nonfinite/coerced/unsafe prices and counts, mixed nulls and bad seeds', () => {
  for (const bad of [undefined, NaN, Infinity, -1, 0, '100']) {
    const f = fixture(3); f.benchmark.data[0].close = bad; assert.throws(() => parseBreadthImport(f));
  }
  for (const bad of [undefined, NaN, Infinity, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1, null]) {
    const f = fixture(3); f.sp500.data[0].advances = bad; assert.throws(() => parseBreadthImport(f));
  }
  for (const row of [{ advances: 0, declines: 0, unchanged: 0 }, { advances: Number.MAX_SAFE_INTEGER, declines: 1, unchanged: 0 }]) {
    const f = fixture(3); Object.assign(f.nyse.data[0], row); assert.throws(() => parseBreadthImport(f));
  }
  for (const patch of [{ date: '2020-01-01' }, { date: 'bad' }, { ema19: NaN }, { ema39: Infinity }, { summation: '0' },
    { calibration: 'guessed' }, { source: '' }]) {
    const f = fixture(3); Object.assign(f.nyse.seed, patch); assert.throws(() => parseBreadthImport(f));
  }
  const noSeed = fixture(3); delete noSeed.nyse.seed; assert.throws(() => parseBreadthImport(noSeed));
  const nullPrice = fixture(3); nullPrice.benchmark.data[1].close = null; assert.equal(parseBreadthImport(nullPrice).benchmark.data[1].close, null);
});


test('rejects unsafe derived A-D accumulation and rolling sums from individually safe counts', () => {
  const cumulative = fixture(2);
  Object.assign(cumulative.sp500.data[0], { advances: Number.MAX_SAFE_INTEGER, declines: 0 });
  Object.assign(cumulative.sp500.data[1], { advances: 1, declines: 0 });
  assert.doesNotThrow(() => parseBreadthImport(cumulative));
  assert.throws(() => buildAdvancedContext(cumulative), /cumulative value exceeds safe integer/);
  const rolling = fixture(2);
  Object.assign(rolling.sp500.data[0], { advances: Number.MAX_SAFE_INTEGER, declines: 0 });
  Object.assign(rolling.sp500.data[1], { advances: 1, declines: 1 });
  assert.doesNotThrow(() => parseBreadthImport(rolling));
  assert.throws(() => buildAdvancedContext(rolling), /rolling sum exceeds safe integer/);
});


test('missing diagnostics begin at each supplied series first row, with staggered histories', () => {
  const f = fixture(300);
  f.sp500.data = f.sp500.data.slice(100);
  f.nyse.data = f.nyse.data.slice(250);
  f.nyse.seed.date = f.benchmark.data[249].date;
  const complete = buildAdvancedContext(f);
  assert.deepEqual(complete.diagnostics, { missingSp500: 0, missingNyse: 0, mcInvalidated: false });
  assert.equal(complete.sessions[99].ad, null);
  assert.equal(complete.sessions[100].ad, 1);
  assert.equal(complete.sessions[249].summation, null);
  assert.equal(complete.sessions[250].summation, 0);
  for (const name of ['sp500', 'nyse']) {
    const start = name === 'sp500' ? 100 : 250;
    for (const boundary of ['first-null', 'middle-row', 'tail-row']) {
      const altered = clone(f);
      const rows = altered[name].data;
      let missingIndex;
      if (boundary === 'first-null') {
        Object.assign(rows[0], { advances: null, declines: null, unchanged: null });
        missingIndex = start;
      } else if (boundary === 'middle-row') {
        missingIndex = start + 10; rows.splice(10, 1);
      } else { missingIndex = 299; rows.pop(); }
      const c = buildAdvancedContext(altered);
      assert.equal(c.diagnostics.missingSp500, name === 'sp500' ? 1 : 0);
      assert.equal(c.diagnostics.missingNyse, name === 'nyse' ? 1 : 0);
      assert.equal(c.diagnostics.mcInvalidated, name === 'nyse');
      if (name === 'nyse') assert.ok(c.sessions.slice(missingIndex).every(s => s.summation === null));
      else {
        assert.equal(c.sessions[missingIndex].ad, null);
        if (missingIndex < 299) assert.equal(c.sessions[missingIndex + 1].ad, 1);
      }
    }
    const empty = clone(f); empty[name].data = [];
    const c = buildAdvancedContext(empty);
    assert.equal(c.diagnostics[name === 'sp500' ? 'missingSp500' : 'missingNyse'], 0);
    assert.equal(c.diagnostics.mcInvalidated, false);
  }
  const ratioZero = clone(f); ratioZero.nyse.variant = 'ratio';
  Object.assign(ratioZero.nyse.data[0], { advances: 0, declines: 0, unchanged: 100 });
  assert.deepEqual(buildAdvancedContext(ratioZero).diagnostics, { missingSp500: 0, missingNyse: 1, mcInvalidated: true });
});

test('project self-calculation preserves metadata and trims to the benchmark axis', () => {
  const ad = {meta: {source:'SELF', constituentsBasis:'CURRENT', priceBasis:'ADJUSTED'}, data:[
    {date:'2020-01-02', advances:1, declines:1, unchanged:0, total:2},
    {date:'2020-01-03', advances:null, declines:null, unchanged:null, total:null},
    {date:'2020-01-04', advances:2, declines:0, unchanged:0, total:2}]};
  const prices = {data:['2020-01-01','2020-01-02','2020-01-03','2020-01-05'].map(date => ({date,close:100,open:99}))};
  const before=structuredClone([ad,prices]);
  const {bundle,droppedDates}=projectSp500Bundle(ad,prices);
  assert.deepEqual(droppedDates,['2020-01-04']);
  assert.equal(bundle.benchmark.data[0].date,'2020-01-02');
  assert.equal(bundle.benchmark.data.at(-1).date,'2020-01-05');
  assert.equal(bundle.sp500.source,'SELF');assert.equal(bundle.sp500.priceBasis,'ADJUSTED');
  assert.ok(!('total' in bundle.sp500.data[0]));assert.ok(!('nyse' in bundle));
  assert.deepEqual(parseBreadthImport(bundle),bundle);assert.deepEqual([ad,prices],before);
  assert.equal(buildAdvancedContext(bundle).diagnostics.missingSp500,2);
  assert.throws(()=>projectSp500Bundle({...ad,data:[]},prices));
});
