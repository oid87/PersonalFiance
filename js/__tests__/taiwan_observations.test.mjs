import test from 'node:test';
import assert from 'node:assert/strict';
import { taiwanObservationRows, unavailableTaiwanRows, loadTaiwanObservations,
  TAIWAN_OBSERVATION_SOURCES } from '../utils/taiwan_observations.mjs';
import { latestTask } from '../utils/tools_contracts.mjs';

// Synthetic contract fixtures only; these are not market observations.
const money = (changes = {}) => ({ updated: '2025-03-23', monthly: [{ date: '2025-02-01', freq: 'monthly',
  m1b_yoy: 7.18, m2_yoy: 6.92, spread: 0.26, ...changes }],
  annual: [{ date: '2025-12-31', freq: 'annual', m1b_yoy: 99, m2_yoy: 0, spread: 99 }] });
const daily = value => ({ updated: '2025-03-23', data: [{ date: '2025-03-21', close: value, ratio: value, margin_money: value }] });
const request = async file => file.includes('money_supply') ? money() : daily(0);

test('latest source rows preserve raw zero, independent dates, save stamps and snapshot scope without mutation', () => {
  const input = { updated: 'save stamp', data: [{ date: '2025-03-21', close: 0 }, { date: '2025-03-20', close: 123.456789 }] };
  const before = structuredClone(input), row = taiwanObservationRows('index', input)[0];
  assert.equal(row.value, 0); assert.equal(row.status, 'available'); assert.equal(row.observation, '2025-03-21');
  assert.equal(row.updated, 'save stamp'); assert.equal(row.unit, '點'); assert.deepEqual(input, before);
  const monetary = taiwanObservationRows('money', money());
  assert.equal(monetary.length, 3); assert.ok(monetary.every(item => item.observation === '2025-02' && item.frequency === 'monthly'));
  assert.equal(monetary[2].value, 0.26); assert.equal(monetary[2].unit, '百分點');
  assert.match(monetary[2].basis, /期底.*非日平均/);
  assert.match(taiwanObservationRows('maintenance', daily(199.12))[0].basis, /上市融資多頭.*重建代理/);
  assert.match(taiwanObservationRows('margin', daily(1))[0].basis, /不含上櫃/);
});

test('missing newest value stays missing instead of borrowing an older valid price', () => {
  for (const [value, reason] of [[null, 'null'], [undefined, '未提供'], ['2', '有限數值'], [Infinity, '有限數值']]) {
    const row = taiwanObservationRows('index', { data: [{ date: '2025-03-20', close: 10 },
      { date: '2025-03-21', close: value }] })[0];
    assert.equal(row.value, null); assert.equal(row.observation, '2025-03-21'); assert.match(row.reason, new RegExp(reason));
    assert.equal(row.updated, null);
  }
});

test('stored spread verifies direction and serialization precision, never generates a missing value', () => {
  assert.equal(taiwanObservationRows('money', money({ m1b_yoy: 0, m2_yoy: 0, spread: 0 }))[2].value, 0);
  assert.equal(taiwanObservationRows('money', money({ m1b_yoy: 1.2344, m2_yoy: 0, spread: 1.234 }))[2].value, 1.234);
  for (const change of [{ spread: -0.26 }, { spread: 0.261 }, { m1b_yoy: null }, { m2_yoy: undefined }]) {
    const rows = taiwanObservationRows('money', money(change));
    assert.equal(rows[2].value, null); assert.notEqual(rows[2].status, 'available');
    assert.equal(rows[1].value, change.m2_yoy === undefined && Object.hasOwn(change, 'm2_yoy') ? null : 6.92);
  }
  for (const spread of [null, undefined]) {
    const row = taiwanObservationRows('money', money({ spread }))[2];
    assert.equal(row.value, null); assert.equal(row.status, 'missing');
  }
});

test('monthly data cannot fall back to annual/latest metadata or silently admit duplicate or impossible dates', () => {
  for (const input of [{ ...money(), monthly: [] }, { ...money(), monthly: undefined },
    money({ freq: 'annual' }), money({ date: '2025-02-28' }), money({ date: '2025-02-30' })]) {
    assert.throws(() => taiwanObservationRows('money', input));
  }
  for (const data of [[], [{ date: '2025-02-30', close: 1 }],
    [{ date: '2025-03-21', close: 1 }, { date: '2025-03-21', close: 2 }]]) assert.throws(() => taiwanObservationRows('index', { data }));
});

test('source-local failure leaves other rows available and explicit retry forwards force only to fixed local files', async () => {
  const calls = [], invalid = [];
  const rows = await loadTaiwanObservations({ request: async (file, options) => {
    calls.push({ file, force: options.force });
    if (file.includes('money_supply')) return {};
    return request(file);
  }, onInvalid: file => invalid.push(file) });
  assert.equal(rows.length, 6); assert.equal(rows.filter(row => row.status === 'available').length, 3);
  assert.equal(rows.filter(row => row.status === 'unavailable').length, 3);
  assert.deepEqual(invalid, ['data/taiwan_money_supply.json']);
  assert.deepEqual(calls.map(call => call.file), TAIWAN_OBSERVATION_SOURCES.map(source => source.file));
  assert.ok(calls.every(call => call.force === false));
  const retried = await loadTaiwanObservations({ force: true, request: async (file, options) => {
    assert.equal(options.force, true); return request(file);
  } });
  assert.ok(retried.every(row => row.status === 'available'));
});

test('invalid stored spread discards validation cache but keeps its valid constituents visible', async () => {
  const invalid = [];
  const rows = await loadTaiwanObservations({ request: async file => file.includes('money_supply') ? money({ spread: -0.26 }) : daily(1),
    onInvalid: file => invalid.push(file) });
  assert.deepEqual(invalid, ['data/taiwan_money_supply.json']);
  assert.equal(rows.find(row => row.key === 'spread').status, 'invalid');
  assert.equal(rows.find(row => row.key === 'm1b').value, 7.18);
  assert.equal(rows.find(row => row.key === 'm2').value, 6.92);
});

test('all source failures retain six explicit unavailable rows; abort does not commit partial or stale results', async () => {
  const failed = await loadTaiwanObservations({ request: async () => { throw new Error('fixture unavailable'); } });
  assert.equal(failed.length, 6); assert.ok(failed.every(row => row.value === null && row.status === 'unavailable'));
  assert.match(unavailableTaiwanRows('money', 'fixture reason')[0].reason, /fixture reason/);
  const task = latestTask(), commits = [], errors = [], pending = [];
  const old = task.run(signal => loadTaiwanObservations({ signal, request: () => new Promise(resolve => pending.push(resolve)) }),
    rows => commits.push(rows), error => errors.push(error));
  await task.run(signal => loadTaiwanObservations({ signal, request }), rows => commits.push(rows), error => errors.push(error));
  pending.forEach((resolve, i) => resolve(i === 3 ? money() : daily(999))); await old;
  assert.equal(commits.length, 1); assert.equal(commits[0][0].value, 0); assert.deepEqual(errors, []);
  const pendingDestroyed = [];
  const last = task.run(signal => loadTaiwanObservations({ signal, request: () => new Promise(resolve => pendingDestroyed.push(resolve)) }),
    rows => commits.push(rows), error => errors.push(error));
  task.destroy(); pendingDestroyed.forEach((resolve, i) => resolve(i === 3 ? money() : daily(999))); await last;
  assert.equal(commits.length, 1); assert.deepEqual(errors, []);
});
