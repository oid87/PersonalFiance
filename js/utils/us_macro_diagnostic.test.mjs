import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { MACRO_DIAGNOSTIC_METHOD_VERSION as METHOD, LEGACY_MACRO_DIAGNOSTIC_METHOD_VERSION as LEGACY, diagnoseUsMacro, canonicalJSON, sha256, verifyDiagnosticSnapshot, deriveDivergenceHistory, isSupportedMacroDiagnosticMethodVersion } from './us_macro_diagnostic.js';
import { captureUsMacroDiagnostic } from '../../scripts/capture_us_macro_diagnostic.mjs';
import { validateUsMacroDiagnosticSnapshots } from '../../scripts/validate_us_macro_diagnostic_snapshots.mjs';

const IDS = ['PCEC96', 'DSPIC96', 'NEWORDER', 'INDPRO', 'PAYEMS', 'UNRATE', 'PERMIT', 'ISRATIO'];
const ASOF = '2026-09-26T03:13:47Z';
const hash = `sha256:${'a'.repeat(64)}`;
const month = (base, n) => { const d = new Date(`${base}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };
const clone = x => structuredClone(x);
function fixture({ asOf = ASOF, levels = {}, price = 100, priceCount = 150 } = {}) {
  const first = '2025-06';
  const indicators = Object.fromEntries(IDS.map(id => {
    const base = id === 'UNRATE' ? 4 : id === 'ISRATIO' ? 1.2 : 100;
    const observations = Array.from({ length: 14 }, (_, i) => {
      const reference_month = month(first, i);
      const value = levels[id]?.[reference_month] ?? base;
      return { reference_month, value, raw_value: value === null ? null : String(value), retrieved_at: '2026-09-20T00:00:00Z', event_sha256: hash, status: 'latest_revised_import' };
    });
    return [id, { observations, units: id === 'UNRATE' ? '%' : id === 'ISRATIO' ? 'ratio' : 'index' }];
  }));
  const macroSummary = { schema_version: 1, method_version: 'macro-data-v0.1', as_of: asOf, view: 'latest_revised', generation_id: hash,
    coverage: { common_month: '2026-07' }, source_status: Object.fromEntries(IDS.map(id => [id, { last_attempt_status: 'success' }])), indicators };
  const end = Date.parse(`${asOf.slice(0, 10)}T00:00:00Z`) - 86400000;
  const data = Array.from({ length: priceCount }, (_, i) => ({ date: new Date(end - (priceCount - 1 - i) * 86400000).toISOString().slice(0, 10), close: typeof price === 'function' ? price(i) : price }));
  const cpiData = Array.from({ length: 4 }, (_, i) => ({ date: `${month('2026-03', i)}-01`, yoy: 3 }));
  const hyData = Array.from({ length: 21 }, (_, i) => ({ date: new Date(end - (20 - i) * 86400000).toISOString().slice(0, 10), hy: 3 }));
  return { asOf, methodVersion: METHOD, macroSummary, prices: { SPY: { data }, QQQ: { data: clone(data) } }, cpi: { components: [{ key: 'headline', data: cpiData }, { key: 'core', data: clone(cpiData) }] }, creditSpread: { data: hyData } };
}
function setAt(input, id, monthKey, value) { const r = input.macroSummary.indicators[id].observations.find(x => x.reference_month === monthKey); r.value = value; r.raw_value = value === null ? null : String(value); }
function positive(input, ids, t = '2026-07') { for (const id of ids) setAt(input, id, t, id === 'UNRATE' ? 3.5 : 105); }
function negative(input, ids, t = '2026-07') { for (const id of ids) setAt(input, id, t, id === 'UNRATE' ? 4.5 : 95); }
function run(input) { return diagnoseUsMacro(input); }
function priceMode(input, mode) {
  const data = input.prices.SPY.data;
  for (let i = 0; i < data.length; i++) data[i].close = mode === 'above' ? (i === data.length - 1 ? 110 : 100) : mode === 'below' ? (i === data.length - 1 ? 90 : 100) : 100;
  input.prices.QQQ.data = clone(data);
}
async function snapshot(input, capturedAt = input.asOf) {
  const output = run(input);
  return { schema_version: 1, method_version: input.methodVersion, macro_data_method_version: 'macro-data-v0.1', as_of: input.asOf, captured_at: capturedAt,
    local_date_Taipei: new Date(Date.parse(input.asOf) + 8 * 3600000).toISOString().slice(0, 10), generation_id: input.macroSummary.generation_id,
    view: 'latest_revised_not_pit', source_file_sha256: { macro_summary: hash, SPY: hash, QQQ: hash, cpi: hash, credit_spread: hash },
    diagnostic_input: input, diagnostic_output: output, input_sha256: await sha256(input), output_sha256: await sha256(output) };
}

test('four-family matrices keep SPY and QQQ separate', () => {
  const x = fixture(); positive(x, ['PCEC96', 'DSPIC96', 'INDPRO', 'PAYEMS', 'UNRATE']);
  priceMode(x, 'below');
  const a = run(x); assert.equal(a.macro.direction, 'improving'); assert.equal(a.comparison.SPY.code, 'divergence_price_weak');
  assert.equal(a.comparison.QQQ.code, 'divergence_price_weak');
  const y = fixture(); positive(y, ['PCEC96', 'DSPIC96', 'INDPRO', 'PAYEMS', 'UNRATE']); priceMode(y, 'above');
  y.prices.QQQ.data.at(-1).close = 90;
  const b = run(y); assert.equal(b.comparison.SPY.code, 'aligned_support'); assert.equal(b.comparison.QQQ.code, 'divergence_price_weak');
});
test('deteriorating and mixed price matrix', () => {
  const x = fixture(); negative(x, ['PCEC96', 'DSPIC96', 'INDPRO', 'PAYEMS', 'UNRATE']); priceMode(x, 'above');
  assert.equal(run(x).comparison.SPY.code, 'divergence_macro_weak');
  priceMode(x, 'below'); assert.equal(run(x).comparison.SPY.code, 'aligned_weak');
  priceMode(x, 'equal'); assert.equal(run(x).comparison.SPY.code, 'neutral_price');
  const y = fixture(); for (const [mode, code] of [['above', 'mixed_macro'], ['below', 'mixed_macro'], ['equal', 'mixed_macro_and_price']]) {
    priceMode(y, mode); assert.equal(run(y).comparison.SPY.code, code);
  }
});
test('insufficient axes follow matrix without borrowing old state', () => {
  const x = fixture(); setAt(x, 'PAYEMS', '2026-05', null); priceMode(x, 'above');
  assert.equal(run(x).comparison.SPY.code, 'insufficient_macro');
  x.prices.SPY.data = []; assert.equal(run(x).comparison.SPY.code, 'insufficient_both');
  const y = fixture(); positive(y, ['PCEC96', 'DSPIC96', 'INDPRO', 'PAYEMS', 'UNRATE']); y.prices.SPY.data = [];
  assert.equal(run(y).comparison.SPY.code, 'insufficient_price');
});
test('labor divergence, fixed denominator, and broad weakening', () => {
  const x = fixture(); positive(x, ['PCEC96', 'PAYEMS']); negative(x, ['UNRATE']);
  const a = run(x); assert.equal(a.macro.families.labor.direction, 'divergent'); assert.equal(a.macro.counts.denominator, 4); assert.equal(a.macro.direction, 'mixed');
  const y = fixture(); negative(y, ['PCEC96', 'DSPIC96', 'INDPRO', 'PAYEMS', 'UNRATE']);
  negative(y, ['PCEC96', 'DSPIC96'], '2026-06'); assert.equal(run(y).macro.broad_weakening, true);
  negative(y, ['INDPRO', 'PAYEMS', 'UNRATE'], '2026-06'); assert.equal(run(y).macro.broad_weakening, false);
  setAt(y, 'INDPRO', '2026-03', null); assert.equal(run(y).macro.broad_weakening, null);
});
test('threshold equality and EPS, YoY gap independent of three-month direction', () => {
  const x = fixture(); setAt(x, 'UNRATE', '2026-04', 4.1); setAt(x, 'UNRATE', '2026-07', 4.3);
  assert.equal(run(x).macro.indicators.UNRATE.direction, 'neutral');
  setAt(x, 'UNRATE', '2026-07', 4.3 + 1e-10); assert.equal(run(x).macro.indicators.UNRATE.direction, 'neutral');
  setAt(x, 'UNRATE', '2026-07', 4.3 + 1e-7); assert.equal(run(x).macro.indicators.UNRATE.direction, 'negative');
  setAt(x, 'PCEC96', '2025-11', null); positive(x, ['PCEC96']);
  const r = run(x).macro.indicators.PCEC96; assert.equal(r.yoy, null); assert.equal(r.direction, 'positive');
  setAt(x, 'ISRATIO', '2026-07', 1.3); assert.equal(run(x).macro.indicators.ISRATIO.direction, 'unclassified'); assert.equal(run(x).macro.indicators.ISRATIO.movement, 'rising');
});
test('CPI and HY use percentage-point changes; stale is isolated', () => {
  const x = fixture(); x.cpi.components[0].data[0].yoy = 2.7; x.creditSpread.data[0].hy = 2.5;
  let y = run(x); assert.equal(y.background.cpi.headline.direction, 'stable'); assert.equal(y.background.hy.direction, 'stable');
  x.cpi.components[0].data[0].yoy = 2.699999; x.creditSpread.data[0].hy = 2.499999;
  y = run(x); assert.equal(y.background.cpi.headline.direction, 'rising'); assert.equal(y.background.hy.direction, 'widening');
  x.creditSpread.data.at(-1).date = '2026-09-15'; assert.throws(() => run(x), /descending/);
  x.creditSpread = null; assert.equal(run(x).background.hy.status, 'insufficient'); assert.equal(run(x).macro.direction, 'mixed');
});
test('price needs contiguous last 150 rows, date and non-null close', () => {
  const a = fixture({ priceCount: 149 }); assert.equal(run(a).prices.SPY.state, 'insufficient');
  const b = fixture(); b.prices.SPY.data[30].close = null; assert.equal(run(b).prices.SPY.state, 'insufficient');
  const c = fixture(); c.prices.SPY.data.at(-1).date = c.prices.SPY.data.at(-2).date; assert.throws(() => run(c), /duplicate/);
  const d = fixture(); d.prices.SPY.data.at(-1).close = 0; assert.throws(() => run(d), /invalid close/);
  const e = fixture(); e.prices.SPY.data.splice(0, 1); e.prices.SPY.data.push({ date: '2026-10-01', close: 999 }); assert.equal(run(e).prices.SPY.state, 'insufficient');
});
test('future price and background rows do not change current output', () => {
  const x = fixture(), expected = run(x);
  x.prices.SPY.data.push({ date: '2026-10-01', close: 1000 });
  x.prices.QQQ.data.push({ date: '2026-09-26', close: -1 });
  x.cpi.components[0].data.push({ date: '2026-09-01', yoy: 100 });
  x.creditSpread.data.push({ date: '2026-09-26', hy: 100 });
  assert.deepEqual(run(x), expected);
});
test('invalid B time, version, shape, and used retrieval time fail', () => {
  const x = fixture(); x.macroSummary.as_of = '2026-09-27T00:00:00Z'; assert.throws(() => run(x), /mismatch/);
  x.macroSummary.as_of = ASOF; x.macroSummary.indicators.PCEC96.observations.at(-1).retrieved_at = '2026-09-27T00:00:00Z'; assert.throws(() => run(x), /retrieved after/);
  x.macroSummary.indicators.PCEC96.observations.at(-1).retrieved_at = '2026-09-20T00:00:00Z'; delete x.macroSummary.indicators.PCEC96; assert.throws(() => run(x), /missing PCEC96/);
});
test('B source status is required; failed fresh data remain usable only in v0.2', () => {
  const x = fixture(); delete x.macroSummary.source_status.PCEC96;
  assert.throws(() => run(x), /PCEC96 source status invalid/);
  x.macroSummary.source_status.PCEC96 = { last_attempt_status: 'unknown' };
  assert.throws(() => run(x), /PCEC96 source status invalid/);
  x.macroSummary.source_status.PCEC96.last_attempt_status = 'failed';
  let r = run(x); assert.equal(r.macro.indicators.PCEC96.level, 100); assert.equal(r.macro.indicators.PCEC96.stale, false);
  assert.equal(r.macro.indicators.PCEC96.source_status, 'failed'); assert.equal(r.macro.indicators.PCEC96.direction, 'neutral');
  const old = clone(x); old.methodVersion = LEGACY;
  const legacy = run(old); assert.equal(legacy.macro.indicators.PCEC96.stale, true);
  assert.equal(legacy.macro.indicators.PCEC96.direction, 'insufficient'); assert.equal(legacy.macro.direction, 'insufficient');
  x.macroSummary.source_status.PCEC96.last_attempt_status = 'partial';
  r = run(x); assert.equal(r.macro.indicators.PCEC96.direction, 'neutral');
});
test('v0.2 stale records age alone even when source is unavailable', () => {
  const x = fixture(); x.macroSummary.source_status.PCEC96.last_attempt_status = 'unavailable';
  let indicator = run(x).macro.indicators.PCEC96;
  assert.equal(indicator.source_status, 'unavailable');
  assert.equal(indicator.direction, 'insufficient');
  assert.equal(indicator.stale, false);
  x.macroSummary.coverage.common_month = '2026-04';
  indicator = run(x).macro.indicators.PCEC96;
  assert.equal(indicator.direction, 'insufficient');
  assert.equal(indicator.stale, true);
});
test('noncore latest null is not replaced with an older observation', () => {
  const x = fixture(); setAt(x, 'NEWORDER', '2026-07', null);
  const r = run(x).macro.indicators.NEWORDER;
  assert.equal(r.reference_month, '2026-07'); assert.equal(r.level, null); assert.equal(r.direction, 'insufficient');
});
test('transmission evidence preserves original raw lexemes and comparison months', () => {
  const x = fixture();
  const row = x.macroSummary.indicators.DSPIC96.observations.at(-1); row.raw_value = '100.000';
  const link = run(x).transmission.links[0];
  assert.equal(link.id, 'real_income'); assert.equal(link.evidence.length, 13);
  assert.equal(link.evidence.at(-1).raw_value, '100.000');
  assert.equal(link.evidence[0].reference_month, '2025-07');
  assert.equal(link.evidence.at(-1).reference_month, '2026-07');
  assert.equal(new Set(link.evidence.map(e => e.reference_month)).size, 13);
});
test('nominal orders and output differing by neutral direction trigger a next check', () => {
  const x = fixture(); positive(x, ['NEWORDER']);
  const checks = run(x).transmission.next_checks;
  assert.equal(checks[0].id, 'orders_to_output');
  assert.deepEqual(checks[0].evidence_ids, ['NEWORDER', 'INDPRO']);
});
test('diagnosis does not mutate its inputs', () => { const x = fixture(); const before = clone(x); run(x); assert.deepEqual(x, before); });

test('writer no-op, conflict, validator, stale asOf, missing sources, and corruption', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'macro-c-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const x = fixture();
  for (const [name, value] of Object.entries({ us_macro_diagnostic: x.macroSummary, SPY: x.prices.SPY, QQQ: x.prices.QQQ, cpi: x.cpi, credit_spread: x.creditSpread })) await writeFile(path.join(dir, `${name}.json`), JSON.stringify(value));
  const now = () => Date.parse(ASOF) + 1000;
  const first = await captureUsMacroDiagnostic({ dataDir: dir, asOf: ASOF, now }); assert.equal(first.status, 'written');
  assert.deepEqual(first.snapshot.diagnostic_input.macroSummary, x.macroSummary);
  assert.equal(first.snapshot.diagnostic_input.prices.SPY.data.length, 150);
  assert.equal(first.snapshot.diagnostic_input.cpi.components[0].data.length, 4);
  assert.equal(first.snapshot.diagnostic_input.creditSpread.data.length, 21);
  const original = await readFile(first.path);
  assert.deepEqual(await validateUsMacroDiagnosticSnapshots({ dataDir: dir }), { count: 1, status: 'observed' });
  const second = await captureUsMacroDiagnostic({ dataDir: dir, asOf: ASOF, now: () => now() + 60000 }); assert.equal(second.status, 'no-op');
  assert.deepEqual(await readFile(first.path), original);
  await writeFile(path.join(dir, 'SPY.json'), `${JSON.stringify(x.prices.SPY)}\n`);
  assert.equal((await captureUsMacroDiagnostic({ dataDir: dir, asOf: ASOF, now })).status, 'no-op');
  x.prices.SPY.data.at(-1).close = 101; await writeFile(path.join(dir, 'SPY.json'), JSON.stringify(x.prices.SPY));
  await assert.rejects(captureUsMacroDiagnostic({ dataDir: dir, asOf: ASOF, now }), /conflict/);
  await assert.rejects(captureUsMacroDiagnostic({ dataDir: dir, asOf: ASOF, now: () => Date.parse(ASOF) + 3 * 3600000 }), /two-hour/);
  await writeFile(first.path, '{}\n'); await assert.rejects(validateUsMacroDiagnosticSnapshots({ dataDir: dir }), /path\/date mismatch/);
  await assert.rejects(captureUsMacroDiagnostic({ dataDir: dir, asOf: ASOF, now }), /unsupported snapshot/);
  const empty = await mkdtemp(path.join(os.tmpdir(), 'macro-c-empty-')); t.after(() => rm(empty, { recursive: true, force: true }));
  assert.deepEqual(await validateUsMacroDiagnosticSnapshots({ dataDir: empty }), { count: 0, status: 'unsupported' });
});
test('writer records null missing sources in isolated data dir', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'macro-c-missing-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const x = fixture(); await writeFile(path.join(dir, 'us_macro_diagnostic.json'), JSON.stringify(x.macroSummary));
  const result = await captureUsMacroDiagnostic({ dataDir: dir, asOf: ASOF, now: () => Date.parse(ASOF) + 1000 });
  assert.equal(result.snapshot.source_file_sha256.SPY, null); assert.equal(result.snapshot.diagnostic_output.prices.SPY.state, 'insufficient');
  await verifyDiagnosticSnapshot(result.snapshot);
});

test('snapshot index binds canonical saved bytes and no-op repairs interruption', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'macro-index-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const x = fixture();
  await writeFile(path.join(dir, 'us_macro_diagnostic.json'), JSON.stringify(x.macroSummary));
  const now = () => Date.parse(ASOF) + 1000;
  const first = await captureUsMacroDiagnostic({ dataDir: dir, asOf: ASOF, now });
  const root = path.join(dir, 'us_macro_diagnostic_snapshots');
  const indexPath = path.join(root, 'index.json');
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  assert.equal(index.schema_version, 1); assert.equal(index.entries.length, 1);
  assert.deepEqual(index.entries[0], { path: `2026/2026-09-26.json`, sha256: `sha256:${createHash('sha256').update(await readFile(first.path)).digest('hex')}`,
    as_of: ASOF, captured_at: first.snapshot.captured_at, method_version: METHOD });
  const saved = await readFile(first.path);
  await rm(indexPath);
  await assert.rejects(validateUsMacroDiagnosticSnapshots({ dataDir: dir }), /index missing/);
  assert.equal((await captureUsMacroDiagnostic({ dataDir: dir, asOf: ASOF, now })).status, 'no-op');
  assert.deepEqual(await readFile(first.path), saved);
  assert.equal((await validateUsMacroDiagnosticSnapshots({ dataDir: dir })).count, 1);
  for (const entries of [[], [{ ...index.entries[0], sha256: hash }], [{ ...index.entries[0], as_of: '2026-09-26T03:13:48Z' }],
    [index.entries[0], { ...index.entries[0], path: '2026/2026-09-27.json', as_of: '2026-09-27T03:13:47Z' }]]) {
    await writeFile(indexPath, `${canonicalJSON({ schema_version: 1, entries })}\n`);
    await assert.rejects(validateUsMacroDiagnosticSnapshots({ dataDir: dir }), /index/);
  }
  await captureUsMacroDiagnostic({ dataDir: dir, asOf: ASOF, now });
  assert.equal((await validateUsMacroDiagnosticSnapshots({ dataDir: dir })).count, 1);
});

test('snapshot validator distinguishes legal temp, orphan, and empty index', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'macro-index-empty-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'us_macro_diagnostic_snapshots');
  await mkdir(path.join(root, '2026'), { recursive: true });
  await writeFile(path.join(root, 'index.json'), `${canonicalJSON({ schema_version: 1, entries: [] })}\n`);
  await writeFile(path.join(root, '.index.00000000-0000-0000-0000-000000000000.tmp'), 'unfinished');
  await writeFile(path.join(root, '2026', '.2026-09-26.00000000-0000-0000-0000-000000000000.tmp'), 'unfinished');
  assert.deepEqual(await validateUsMacroDiagnosticSnapshots({ dataDir: dir }), { count: 0, status: 'unsupported' });
  await writeFile(path.join(root, '2026', 'orphan.tmp'), 'bad');
  await assert.rejects(validateUsMacroDiagnosticSnapshots({ dataDir: dir }), /unexpected snapshot file/);
});
test('snapshot hash and recomputation are independently checked', async () => {
  const s = await snapshot(fixture()); await verifyDiagnosticSnapshot(s);
  s.diagnostic_output.macro.direction = 'improving'; await assert.rejects(verifyDiagnosticSnapshot(s), /output hash mismatch/);
  s.output_sha256 = await sha256(s.diagnostic_output); await assert.rejects(verifyDiagnosticSnapshot(s), /recomputation mismatch/);
});
test('snapshot source hashes are bound to saved source presence', async () => {
  const s = await snapshot(fixture());
  s.source_file_sha256.macro_summary = null;
  await assert.rejects(verifyDiagnosticSnapshot(s), /source hashes invalid/);
  s.source_file_sha256.macro_summary = hash;
  s.source_file_sha256.SPY = null;
  await assert.rejects(verifyDiagnosticSnapshot(s), /source hashes invalid/);
  s.source_file_sha256.SPY = hash;
  s.diagnostic_input.cpi = null;
  s.input_sha256 = await sha256(s.diagnostic_input);
  s.source_file_sha256.cpi = hash;
  await assert.rejects(verifyDiagnosticSnapshot(s), /source hashes invalid/);
});
test('history first observation, persistence, gap, pending, and convergence', async () => {
  const x = fixture({ asOf: '2026-09-22T03:00:00Z' }); positive(x, ['PCEC96', 'DSPIC96', 'INDPRO', 'PAYEMS', 'UNRATE']); priceMode(x, 'below');
  const a = await snapshot(x, '2026-09-22T03:01:00Z');
  const bInput = clone(x); bInput.asOf = bInput.macroSummary.as_of = '2026-09-23T03:00:00Z';
  const b = await snapshot(bInput, '2026-09-23T03:01:00Z');
  let h = await deriveDivergenceHistory([a], a, '2026-09-24T00:00:00Z');
  assert.equal(h.SPY.phase, 'observed_start'); assert.equal(h.SPY.left_censored, true);
  h = await deriveDivergenceHistory([a, b], b, '2026-09-24T00:00:00Z'); assert.equal(h.SPY.phase, 'persistent'); assert.equal(h.SPY.observed_snapshots, 2);
  const pendingInput = clone(x); pendingInput.asOf = pendingInput.macroSummary.as_of = '2026-09-24T03:00:00Z';
  const pendingSnapshot = await snapshot(pendingInput, '2026-09-24T03:01:00Z');
  h = await deriveDivergenceHistory([a, b], pendingSnapshot, '2026-09-24T00:00:00Z');
  assert.equal(h.SPY.status, 'pending_capture'); assert.equal(h.SPY.observed_snapshots, 2);
  const dInput = clone(x); dInput.asOf = dInput.macroSummary.as_of = '2026-09-24T03:00:00Z'; priceMode(dInput, 'above');
  const d = await snapshot(dInput, '2026-09-24T03:01:00Z');
  h = await deriveDivergenceHistory([a, b, d], d, '2026-09-25T00:00:00Z');
  assert.equal(h.SPY.phase, 'converged'); assert.equal(h.SPY.previous_episode.snapshots, 2);
  const gapInput = clone(x); gapInput.asOf = gapInput.macroSummary.as_of = '2026-09-24T03:00:00Z';
  const gap = await snapshot(gapInput, '2026-09-24T03:01:00Z');
  h = await deriveDivergenceHistory([a, gap], gap, '2026-09-25T00:00:00Z'); assert.equal(h.SPY.phase, 'observed_start'); assert.equal(h.SPY.left_censored, true);
});
test('history without snapshots is unsupported and tampering fails', async () => {
  assert.equal((await deriveDivergenceHistory([], null, ASOF)).SPY.status, 'unsupported');
  const s = await snapshot(fixture()); s.input_sha256 = hash;
  await assert.rejects(deriveDivergenceHistory([s], null, ASOF), /input hash mismatch/);
});
test('history rejects malformed captured_at even when its value would sort after cutoff', async () => {
  const s = await snapshot(fixture());
  for (const broken of [null, {}, { ...s, captured_at: undefined }, { ...s, captured_at: '2099-01-01' }]) {
    await assert.rejects(deriveDivergenceHistory([broken], null, ASOF), /invalid snapshot object|invalid UTC second/);
  }
  const future = { ...s, captured_at: '2099-01-01T00:00:00Z', input_sha256: hash };
  assert.equal((await deriveDivergenceHistory([future], null, ASOF)).SPY.status, 'unsupported');
});
test('Saturday to Tuesday is contiguous; missed Wednesday breaks the chain', async () => {
  const aInput = fixture({ asOf: '2026-09-26T03:00:00Z' }); positive(aInput, ['PCEC96', 'DSPIC96', 'INDPRO', 'PAYEMS', 'UNRATE']); priceMode(aInput, 'below');
  const a = await snapshot(aInput, '2026-09-26T03:01:00Z');
  const bInput = fixture({ asOf: '2026-09-29T03:00:00Z' }); positive(bInput, ['PCEC96', 'DSPIC96', 'INDPRO', 'PAYEMS', 'UNRATE']); priceMode(bInput, 'below');
  const b = await snapshot(bInput, '2026-09-29T03:01:00Z');
  let h = await deriveDivergenceHistory([a, b], b, '2026-09-30T00:00:00Z');
  assert.equal(h.SPY.phase, 'persistent'); assert.equal(h.SPY.observed_snapshots, 2);
  const cInput = fixture({ asOf: '2026-10-01T03:00:00Z' }); positive(cInput, ['PCEC96', 'DSPIC96', 'INDPRO', 'PAYEMS', 'UNRATE']); priceMode(cInput, 'below');
  const c = await snapshot(cInput, '2026-10-01T03:01:00Z');
  h = await deriveDivergenceHistory([a, b, c], c, '2026-10-02T00:00:00Z');
  assert.equal(h.SPY.phase, 'observed_start'); assert.equal(h.SPY.left_censored, true);
});
test('history distinguishes unresolved, insufficient, and changed-type endings', async () => {
  const aInput = fixture({ asOf: '2026-09-22T03:00:00Z' }); positive(aInput, ['PCEC96', 'DSPIC96', 'INDPRO', 'PAYEMS', 'UNRATE']); priceMode(aInput, 'below');
  const a = await snapshot(aInput, '2026-09-22T03:01:00Z');
  const mixedInput = fixture({ asOf: '2026-09-23T03:00:00Z' }); priceMode(mixedInput, 'below');
  const mixed = await snapshot(mixedInput, '2026-09-23T03:01:00Z');
  let h = await deriveDivergenceHistory([a, mixed], mixed, '2026-09-24T00:00:00Z');
  assert.equal(h.SPY.phase, 'ended_unresolved'); assert.equal(h.SPY.previous_episode.snapshots, 1);
  const insufficientInput = clone(mixedInput); insufficientInput.prices.SPY.data = [];
  const insufficient = await snapshot(insufficientInput, '2026-09-23T03:01:00Z');
  h = await deriveDivergenceHistory([a, insufficient], insufficient, '2026-09-24T00:00:00Z');
  assert.equal(h.SPY.phase, 'insufficient'); assert.equal(h.SPY.previous_episode, null);
  const oppositeInput = fixture({ asOf: '2026-09-23T03:00:00Z' }); negative(oppositeInput, ['PCEC96', 'DSPIC96', 'INDPRO', 'PAYEMS', 'UNRATE']); priceMode(oppositeInput, 'above');
  const opposite = await snapshot(oppositeInput, '2026-09-23T03:01:00Z');
  h = await deriveDivergenceHistory([a, opposite], opposite, '2026-09-24T00:00:00Z');
  assert.equal(h.SPY.phase, 'changed_type'); assert.equal(h.SPY.observed_snapshots, 1); assert.equal(h.SPY.previous_episode.code, 'divergence_price_weak');
});

test('frozen v0.1 replays after shared math changes; v0.2 live bytes stay identical', async t => {
  const oldInput = fixture(); oldInput.methodVersion = LEGACY;
  oldInput.macroSummary.source_status.PCEC96.last_attempt_status = 'failed';
  const oldSnapshot = await snapshot(oldInput);
  const liveInput = fixture(); const liveBytes = canonicalJSON(run(liveInput));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'macro-frozen-')); t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of ['us_macro_diagnostic.js', 'us_macro_diagnostic_v01.js']) await copyFile(new URL(name, import.meta.url), path.join(dir, name));
  await writeFile(path.join(dir, 'package.json'), '{"type":"module"}\n');
  await writeFile(path.join(dir, 'math.js'), 'export function computeMA() { throw new Error("shared math changed"); }\n');
  const changed = await import(pathToFileURL(path.join(dir, 'us_macro_diagnostic.js')).href);
  assert.equal(await changed.verifyDiagnosticSnapshot(oldSnapshot), true);
  assert.equal(changed.canonicalJSON(changed.diagnoseUsMacro(liveInput)), liveBytes);
  assert.equal(changed.canonicalJSON(changed.diagnoseUsMacro(oldInput)), canonicalJSON(oldSnapshot.diagnostic_output));
});

test('unknown method is rejected in live, snapshot and index with its name', async t => {
  assert.equal(isSupportedMacroDiagnosticMethodVersion(LEGACY), true);
  assert.equal(isSupportedMacroDiagnosticMethodVersion(METHOD), true);
  assert.equal(isSupportedMacroDiagnosticMethodVersion('macro-diagnostic-v9'), false);
  const x = fixture(); x.methodVersion = 'macro-diagnostic-v9';
  assert.throws(() => run(x), /macro-diagnostic-v9/);
  const s = await snapshot(fixture()); s.method_version = 'macro-diagnostic-v9';
  await assert.rejects(verifyDiagnosticSnapshot(s), /macro-diagnostic-v9/);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'macro-unknown-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'us_macro_diagnostic_snapshots'); await mkdir(root);
  const entry = { path: '2026/2026-09-26.json', sha256: hash, as_of: ASOF, captured_at: ASOF, method_version: 'macro-diagnostic-v9' };
  await writeFile(path.join(root, 'index.json'), `${canonicalJSON({ schema_version: 1, entries: [entry] })}\n`);
  await assert.rejects(validateUsMacroDiagnosticSnapshots({ dataDir: dir }), /macro-diagnostic-v9/);
});

test('capture keeps at most 16 calendar months per series and preserves old level', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'macro-compact-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const x = fixture();
  for (const item of Object.values(x.macroSummary.indicators)) {
    const prior = Array.from({ length: 22 }, (_, i) => ({ reference_month: month('2023-08', i), value: 100, raw_value: '100', retrieved_at: '2026-09-20T00:00:00Z', event_sha256: hash, status: 'latest_revised_import' }));
    item.observations.unshift(...prior);
  }
  x.macroSummary.indicators.NEWORDER.observations = x.macroSummary.indicators.NEWORDER.observations.filter(r => r.reference_month <= '2025-04');
  x.macroSummary.indicators.ISRATIO.observations = x.macroSummary.indicators.ISRATIO.observations.filter(r => r.reference_month !== '2026-01');
  for (const [name, value] of Object.entries({ us_macro_diagnostic: x.macroSummary, SPY: x.prices.SPY, QQQ: x.prices.QQQ, cpi: x.cpi, credit_spread: x.creditSpread })) await writeFile(path.join(dir, `${name}.json`), JSON.stringify(value));
  const result = await captureUsMacroDiagnostic({ dataDir: dir, asOf: ASOF, now: () => Date.parse(ASOF) + 1000 });
  const compact = result.snapshot.diagnostic_input;
  for (const [id, item] of Object.entries(compact.macroSummary.indicators)) {
    assert.ok(item.observations.length <= 16, `${id} rows exceed 16`);
    const dates = item.observations.map(row => row.reference_month);
    if (dates.length) assert.ok((Number(dates.at(-1).slice(0, 4)) * 12 + Number(dates.at(-1).slice(5))) - (Number(dates[0].slice(0, 4)) * 12 + Number(dates[0].slice(5))) <= 15, `${id} exceeds 16 calendar months`);
  }
  assert.equal(compact.macroSummary.indicators.NEWORDER.observations.at(-1).reference_month, '2025-04');
  assert.equal(compact.macroSummary.indicators.ISRATIO.observations.length, 15);
  assert.equal(result.snapshot.diagnostic_output.macro.indicators.NEWORDER.level, run(x).macro.indicators.NEWORDER.level);
  assert.equal(canonicalJSON(result.snapshot.diagnostic_output), canonicalJSON(run(x)));
  assert.equal(await verifyDiagnosticSnapshot(result.snapshot), true);
  const fullInput = { ...compact, macroSummary: x.macroSummary };
  assert.ok(Buffer.byteLength(canonicalJSON(compact)) < Buffer.byteLength(canonicalJSON(fullInput)));
});
