import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBundle, runStudy, confirmationAt, latestOverview, rollContaminated } from './usrisk_calc.mjs';

const HASH = 'a'.repeat(64);
const row = (date, values, observed_at = `${date}T21:00:00Z`, published_at = null) => ({ date, values, observed_at, published_at, source_hash: HASH });
const bar = (close = 100) => ({ open: close, high: close * 1.01, low: close * .99, close });
function fixture(n = 190) {
  const dates = []; let t = Date.parse('2023-01-02');
  while (dates.length < n) { const d = new Date(t); if (![0, 6].includes(d.getUTCDay())) dates.push(d.toISOString().slice(0, 10)); t += 86400000; }
  const series = {};
  for (const id of ['SPY', 'QQQ', 'SOXX']) series[id] = { meta: { frequency: 'daily' }, records: dates.map(d => row(d, bar())) };
  for (const id of ['VIX', 'VXN', 'VIX3M']) series[id] = { meta: { frequency: 'daily' }, records: dates.map(d => row(d, { value: id === 'VIX3M' ? 20 : 30 })) };
  return { schema_version: 1, generated_at: `${dates.at(-1)}T23:00:00Z`, series };
}
const cfg = { gate: 0, from: '2023-01-01', horizon: 5 };
function weekly(bundle, records) { bundle.series.CFTC_ES = { meta: { frequency: 'weekly' }, records }; return bundle; }

test('schema rejects empty core, impossible dates, non-UTC timestamps and missing provenance', () => {
  const b = fixture(); assert.equal(validateBundle(b), b);
  for (const change of [b => b.series.SPY.records = [], b => b.series.SPY.records[0].date = '2023-02-30', b => b.series.SPY.records[0].observed_at = '2023-01-01T20:00:00', b => delete b.series.SPY.records[0].source_hash]) { const x = structuredClone(b); change(x); assert.throws(() => validateBundle(x)); }
});
test('first import cannot create strict historical observations', () => {
  const b = fixture(); for (const s of Object.values(b.series)) for (const r of s.records) r.observed_at = b.generated_at;
  const strict = runStudy(b, cfg), hist = runStudy(b, { ...cfg, dataMode: 'historical' });
  assert.equal(strict.events.length, 1); assert.equal(strict.events[0].date, b.series.SPY.records.at(-1).date);
  assert.ok(hist.events.length > strict.events.length); assert.equal(hist.diagnostics.historicalNonPIT, true);
});
test('publication and observed time both gate availability with summer/winter NY midnight', () => {
  const b = weekly(fixture(), [row('2023-03-10', { long: 100, short: 10 }, '2023-03-13T03:59:59Z')]);
  assert.ok(confirmationAt(b, '2023-03-12').CFTC_ES);
  b.series.CFTC_ES.records[0].observed_at = '2023-03-13T04:00:00Z'; assert.equal(confirmationAt(b, '2023-03-12').CFTC_ES, null);
  b.generated_at = '2023-12-01T23:00:00Z';
  b.series.CFTC_ES.records = [row('2023-11-03', { long: 1, short: 1 }, '2023-11-06T04:59:59Z', '2023-11-06T05:00:00Z')];
  assert.equal(confirmationAt(b, '2023-11-05').CFTC_ES, null); assert.ok(confirmationAt(b, '2023-11-06').CFTC_ES);
});
test('vintages preserve value known on decision day, historical still strict on confirmation', () => {
  const b = weekly(fixture(), [row('2023-02-07', { long: 10, short: 10 }), row('2023-02-07', { long: 90, short: 90 }, '2023-03-01T20:00:00Z')]);
  assert.equal(confirmationAt(b, '2023-02-08').CFTC_ES.gross, 20); assert.equal(confirmationAt(b, '2023-03-02').CFTC_ES.gross, 180);
  const e = runStudy(b, { ...cfg, dataMode: 'historical' }).events[0]; assert.equal(e.confirmation.CFTC_ES.gross, 180);
});
test('same day term ratio never forward fills denominator', () => {
  const b = fixture(), date = b.series.SPY.records[130].date;
  b.series.VIX3M.records = b.series.VIX3M.records.filter(r => r.date !== date);
  const result = runStudy(b, { ...cfg, mode: 'term' }); assert.equal(result.days.find(d => d.date === date).indicator, null);
  b.series.VIX3M.records.push(row(date, { value: 0 })); assert.equal(runStudy(b, { ...cfg, mode: 'term' }).days.find(d => d.date === date).indicator, null);
});
test('percentile excludes today/future and requires 126 valid prior values', () => {
  const b = fixture(); b.series.VIX.records[126].values.value = 1000;
  const r = runStudy(b, { ...cfg, thresholdMode: 'percentile' });
  assert.equal(r.days.find(d => d.index === 125).eligible, false); assert.equal(r.days.find(d => d.index === 126).threshold, 30);
});
test('cooldown is measured on supplied asset sessions, starts fixed at accepted event', () => {
  const r = runStudy(fixture(), cfg); assert.equal(r.events[1].index - r.events[0].index, 10);
  const r11 = runStudy(fixture(), { ...cfg, cooldown: 11 }); assert.equal(r11.events[1].index - r11.events[0].index, 11);
  const long = runStudy(fixture(), { ...cfg, horizon: 20 }); assert.equal(long.stats.nonOverlapping[1].index - long.stats.nonOverlapping[0].index, 20);
});
test('next-open horizon includes entry bar; bad OHLC retains axis and censoring is explicit', () => {
  const b = fixture(125); const r = runStudy(b, cfg); assert.equal(r.events[0].entryDate, b.series.SPY.records[120].date); assert.equal(r.events[0].outcome.status, 'complete'); assert.equal(r.events[0].outcome.return, 0); assert.ok(Math.abs(r.events[0].outcome.maxLoss + 1) < 1e-10);
  b.series.QQQ.records[122].values.open = 200;
  const bad = runStudy(b, cfg); assert.equal(bad.events[0].outcome.status, 'badPrice'); assert.equal(bad.days[122].index, 122);
  const small = runStudy(fixture(124), cfg); assert.equal(small.events[0].outcome.status, 'rightCensored');
});
test('roll mask spans expiry week plus subsequent week; change requires adjacent clean reports', () => {
  assert.equal(rollContaminated('2023-03-13'), true); assert.equal(rollContaminated('2023-03-26'), true); assert.equal(rollContaminated('2023-03-27'), false);
  const b = weekly(fixture(), [row('2023-03-21', { long: 80, short: 20 }), row('2023-03-28', { long: 40, short: 10 }), row('2023-04-04', { long: 20, short: 5 })]);
  assert.equal(confirmationAt(b, '2023-03-29').CFTC_ES.change, null); assert.equal(confirmationAt(b, '2023-04-05').CFTC_ES.change, -50);
  b.series.CFTC_ES.records.shift(); b.series.CFTC_ES.records.shift(); assert.equal(confirmationAt(b, '2023-04-05').CFTC_ES.change, null);
});
test('all baselines share exact eligibility and forbidden breadth is unavailable', () => {
  const b = fixture(); b.series.VIX.records.splice(130, 1);
  const r = runStudy(b, cfg); for (const v of Object.values(r.baselines)) assert.equal(v.stats.eligibleN, r.stats.eligibleN);
  b.series.NDX_BREADTH = { meta: { frequency: 'daily', history_eligible: false }, records: b.series.VIX.records };
  assert.equal(runStudy(b, { ...cfg, mode: 'breadth' }).coverage.eligibleDays, 0);
  b.series.NDX_BREADTH.meta.history_eligible = true;
  assert.equal(runStudy(b, { ...cfg, mode: 'breadth', dataMode: 'historical' }).coverage.eligibleDays, 0);
});
test('open wave is censored and cannot be counted as missed', () => {
  const b = fixture(); for (let i = 140; i < 190; i++) b.series.QQQ.records[i].values = bar(90);
  const r = runStudy(b, { ...cfg, threshold: 999 }); assert.equal(r.episodes.length, 1); assert.equal(r.episodes[0].censored, true); assert.equal(r.episodes[0].missed, null); assert.equal(r.diagnostics.evaluatedEpisodes, 0);
});
test('latest uses effective date for age; fixed bundle/config reproducible without mutation', () => {
  const b = fixture(), before = JSON.stringify(b), a = runStudy(b, cfg), other = runStudy(b, cfg);
  assert.deepEqual(a, other); assert.equal(JSON.stringify(b), before);
  const latest = latestOverview(b); assert.equal(latest.SPY.date, b.series.SPY.records.at(-1).date); assert.equal(latest.SPY.age, 0);
});
test('first later import selects latest effective confirmation, never oldest seed row', () => {
  const b = fixture(); const importTime = b.generated_at;
  weekly(b, [row('2023-02-07', { long: 1, short: 1 }, importTime), row('2023-07-04', { long: 4, short: 4 }, importTime)]);
  const e = runStudy(b, { ...cfg, dataMode: 'historical' }).events[0];
  assert.equal(e.confirmation.CFTC_ES, null); assert.equal(e.laterConfirmation.CFTC_ES.date, '2023-07-04');
});
test('as-of daily revisions affect neither earlier signal nor its prior lookback', () => {
  const b = fixture(); const date = b.series.VIX.records[130].date;
  b.series.VIX.records[130].values.value = 10;
  b.series.VIX.records.push(row(date, { value: 100 }, b.generated_at));
  assert.equal(runStudy(b, cfg).days.find(d => d.date === date).indicator, 10);
  assert.equal(runStudy(b, { ...cfg, dataMode: 'historical' }).days.find(d => d.date === date).indicator, 100);
});
test('relative weakness uses same-day valid OHLC and twenty asset sessions', () => {
  const b = fixture(); const date = b.series.QQQ.records[140].date;
  b.series.QQQ.records[140].values = bar(90);
  const r = runStudy(b, { ...cfg, mode: 'relative' }); assert.ok(Math.abs(r.days.find(d => d.date === date).indicator + 10) < 1e-9);
  b.series.SPY.records = b.series.SPY.records.filter(v => v.date !== date);
  assert.equal(runStudy(b, { ...cfg, mode: 'relative' }).days.find(d => d.date === date).indicator, null);
});
test('archive rejects future observations, duplicate version keys and nonfinite numbers', () => {
  for (const change of [b => b.series.SPY.records[0].observed_at = '2030-01-01T00:00:00Z', b => b.series.SPY.records.push(structuredClone(b.series.SPY.records[0])), b => b.series.VIX.records[0].values.value = Infinity, b => b.series.VIX.records[0].values.value = '30']) { const b = fixture(); change(b); assert.throws(() => validateBundle(b)); }
  const b = fixture(); b.series.VIX.records[0].values.value = null; assert.equal(validateBundle(b), b);
});
test('rebreak compares alert low from signal-time vintage, not later revision', () => {
  const b = fixture(); const original = b.series.QQQ.records[119];
  original.values.low = 80;
  b.series.QQQ.records.push(row(original.date, { ...original.values, low: 99.5 }, b.generated_at));
  const result = runStudy(b, cfg); assert.equal(result.events[0].outcome.rebreak, false);
});

test('a missing entire asset row cannot shorten an outcome window', () => {
  const b = fixture(130), missing = b.series.QQQ.records[122].date;
  b.series.QQQ.records.splice(122, 1);
  const r = runStudy(b, cfg);
  assert.equal(r.events[0].outcome.status, 'badPrice');
  assert.equal(r.days.find(d => d.date === missing).index, 122);
  assert.equal(r.days.find(d => d.date === missing).eligible, false);
});

test('an episode first observed after unknown prior drawdowns is left-censored', () => {
  const b = fixture(190), observed = b.series.QQQ.records[140].observed_at;
  for (const s of Object.values(b.series)) for (const r of s.records) if (r.observed_at < observed) r.observed_at = observed;
  for (let i = 140; i < 160; i++) b.series.QQQ.records[i].values = bar(90);
  const result = runStudy(b, cfg);
  assert.equal(result.episodes[0].leftCensored, true);
  assert.equal(result.episodes[0].censored, true);
  assert.equal(result.diagnostics.evaluatedEpisodes, 0);
});

test('even non-PIT reconstruction cannot use a release after the frozen bundle time', () => {
  const b = fixture(), date = b.series.VIX.records[130].date;
  b.series.VIX.records[130].published_at = '2027-01-01T00:00:00Z';
  const r = runStudy(b, { ...cfg, dataMode: 'historical' });
  assert.equal(r.days.find(d => d.date === date).indicator, null);
});
