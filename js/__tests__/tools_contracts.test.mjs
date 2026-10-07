import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_INSTRUMENTS, latestPrice, diagnosticSettings, suppliedMonthlyReturns, latestTask, SYNTHETIC_MONTHLY_DEMO } from '../utils/tools_contracts.mjs';
import { MACRO_CALENDAR_STATUS } from '../utils/macro_calendar_status.mjs';

test('tools catalogue routes only existing known price files; price display preserves the raw newest close', () => {
  assert.equal(new Set(TOOL_INSTRUMENTS.map(item => item.key)).size, TOOL_INSTRUMENTS.length);
  assert.ok(TOOL_INSTRUMENTS.some(item => item.key === '0050' && item.file === 'data/0050.TW.json'));
  assert.ok(!TOOL_INSTRUMENTS.some(item => ['VIX', 'F&G'].includes(item.key)));
  assert.ok(TOOL_INSTRUMENTS.every(item => /^data\/[\w.]+\.json$/.test(item.file)));
  const payload = { updated: 'snapshot stamp', data: [{ date: '2025-02-03', close: 1.23456789 }, { date: '2025-01-03', close: 0 }] };
  const before = structuredClone(payload);
  assert.deepEqual(latestPrice(payload), { date: '2025-02-03', close: 1.23456789, updated: 'snapshot stamp' });
  assert.deepEqual(payload, before);
  for (const bad of [{}, { data: [] }, { data: [{ date: 'x', close: 5 }] }, { data: [{ date: '2025-01-03', close: null }] }]) assert.throws(() => latestPrice(bad));
});

test('diagnostics controls forward original parameters and reject malformed input without financial thresholds', () => {
  const values = { etf: 'T', from: '', to: '', initial: '10000', dca: true, dcaAmount: '1000' };
  assert.deepEqual(diagnosticSettings(values, ['T']), { ...values, initial: 10000, dcaAmount: 1000 });
  for (const change of [{ etf: 'unknown' }, { from: '2025-02-30' }, { from: '2025-02-03', to: '2025-01-03' }, { initial: 0 }, { dcaAmount: -1 }, { initial: 'Infinity' }]) {
    assert.throws(() => diagnosticSettings({ ...values, ...change }, ['T']));
  }
});

test('supplied return contract preserves null, missing, zero, partial and metadata; synthetic status cannot be implicit', () => {
  const result = suppliedMonthlyReturns(SYNTHETIC_MONTHLY_DEMO);
  const cells = result.model.cells;
  assert.equal(result.kind, 'synthetic');
  assert.equal(cells[2].returnPct, 0); assert.equal(cells[3].provided, true); assert.equal(cells[3].returnPct, null);
  assert.equal(cells[4].provided, false); assert.equal(cells[5].partial, true);
  assert.equal(cells[0].from, 'demo-start');
  assert.throws(() => suppliedMonthlyReturns({ ...SYNTHETIC_MONTHLY_DEMO, kind: undefined }));
  assert.throws(() => suppliedMonthlyReturns({ ...SYNTHETIC_MONTHLY_DEMO, basis: '' }));
  assert.throws(() => suppliedMonthlyReturns({ ...SYNTHETIC_MONTHLY_DEMO, rows: [{ month: '2025-01', returnPct: 2 }] }));
});

test('future macro status contains zero events and explicit unavailable status rather than fabricated schedules', () => {
  assert.equal(MACRO_CALENDAR_STATUS.status, 'unavailable'); assert.deepEqual(MACRO_CALENDAR_STATUS.events, []);
  assert.ok(MACRO_CALENDAR_STATUS.references.every(item => item.href.startsWith('https://')));
});

test('superseded delayed result and error cannot overwrite current state; destroy aborts and prevents late commits', async () => {
  let resolveOld, rejectOld, oldSignal;
  const commits = [], errors = [], task = latestTask();
  const old = task.run(signal => { oldSignal = signal; return new Promise((yes, no) => { resolveOld = yes; rejectOld = no; }); }, value => commits.push(value), error => errors.push(error));
  await task.run(async () => 'new', value => commits.push(value), error => errors.push(error));
  assert.equal(oldSignal.aborted, true); resolveOld('stale'); await old;
  assert.deepEqual(commits, ['new']); assert.deepEqual(errors, []);
  const failedOld = task.run(() => new Promise((yes, no) => { rejectOld = no; }), value => commits.push(value), error => errors.push(error));
  await task.run(async () => 'latest', value => commits.push(value), error => errors.push(error));
  rejectOld(new Error('stale failure')); await failedOld; assert.deepEqual(errors, []);
  let finish, signal;
  const pending = task.run(s => { signal = s; return new Promise(yes => { finish = yes; }); }, value => commits.push(value), error => errors.push(error));
  task.destroy(); assert.equal(signal.aborted, true); finish('destroyed'); await pending;
  assert.deepEqual(commits, ['new', 'latest']);
  await task.run(async () => 'must not start', value => commits.push(value), error => errors.push(error));
  assert.deepEqual(commits, ['new', 'latest']);
});

test('active local-data failure remains observable and a subsequent explicit retry recovers', async () => {
  const task = latestTask(), seen = [];
  await task.run(async () => { throw new Error('invalid local JSON'); }, value => seen.push(value), error => seen.push(error.message));
  await task.run(async () => 'recovered', value => seen.push(value), error => seen.push(error.message));
  assert.deepEqual(seen, ['invalid local JSON', 'recovered']); task.destroy();
});
