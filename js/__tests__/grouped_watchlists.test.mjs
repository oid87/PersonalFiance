import test from 'node:test';
import assert from 'node:assert/strict';
import { WATCHLISTS_KEY, emptyWatchlists, normalizeWatchlists,
  readWatchlists, saveWatchlists, updateWatchlists } from '../utils/grouped_watchlists.mjs';

const keys = ['QQQ', 'SPY', '0050'];
const change = (state, action) => updateWatchlists(state, action, keys);

test('group lifecycle keeps symbols unique and separate; source state is immutable', () => {
  const empty = emptyWatchlists();
  let state = change(empty, { type: 'create', name: ' 美股 ' });
  state = change(state, { type: 'create', name: '台股' });
  state = change(state, { type: 'add', groupId: 'group-1', symbol: 'QQQ' });
  state = change(state, { type: 'add', groupId: 'group-1', symbol: 'QQQ' });
  state = change(state, { type: 'add', groupId: 'group-2', symbol: '0050' });
  assert.deepEqual(empty, { version: 1, groups: [] });
  assert.deepEqual(state.groups, [
    { id: 'group-1', name: '美股', symbols: ['QQQ'] },
    { id: 'group-2', name: '台股', symbols: ['0050'] },
  ]);
  const before = structuredClone(state);
  state = change(state, { type: 'rename', groupId: 'group-1', name: '核心' });
  state = change(state, { type: 'remove', groupId: 'group-2', symbol: '0050' });
  assert.deepEqual(before.groups[1].symbols, ['0050']);
  assert.deepEqual(state.groups[1].symbols, []);
  state = change(state, { type: 'delete', groupId: 'group-1' });
  assert.equal(state.groups.length, 1);
  assert.equal(state.groups[0].id, 'group-2');
  state = change(state, { type: 'create', name: '新群組' });
  assert.equal(new Set(state.groups.map(group => group.id)).size, 2);
});

test('invalid edits reject without admitting holdings or unknown instruments', () => {
  const state = change(emptyWatchlists(), { type: 'create', name: '核心' });
  assert.throws(() => change(state, { type: 'create', name: ' ' }));
  assert.throws(() => change(state, { type: 'rename', groupId: 'group-1', name: 'x'.repeat(81) }));
  assert.throws(() => change(state, { type: 'add', groupId: 'group-1', symbol: 'UNKNOWN' }));
  assert.throws(() => change(state, { type: 'rename', groupId: 'missing', name: '核心' }));
  assert.throws(() => change(state, { type: 'trade', groupId: 'group-1', quantity: 10 }));
  const normalized = normalizeWatchlists({ version: 1, groups: [{ id: 'group-1',
    name: '<img src=x onerror=alert(1)>', symbols: ['QQQ'], quantity: 20, cost: 100 }] }, keys).value;
  assert.deepEqual(Object.keys(normalized.groups[0]), ['id', 'name', 'symbols']);
  // Display escaping is the panel's textContent responsibility, not name mutation.
  assert.equal(normalized.groups[0].name, '<img src=x onerror=alert(1)>');
  assert.throws(() => normalizeWatchlists({ version: 1, groups: [
    { id: 'group-1', name: 'A', symbols: [] }, { id: 'group-1', name: 'B', symbols: [] },
  ] }, keys));
});

test('read does not write; unknown symbols and malformed/future data disable automatic persistence', () => {
  for (const raw of ['{bad', JSON.stringify({ version: 2, groups: [] }),
    JSON.stringify({ version: 1, groups: [{ id: 'group-1', name: 'core', symbols: ['QQQ', 'UNKNOWN', 'QQQ'] }] })]) {
    let writes = 0;
    const storage = { getItem: key => { assert.equal(key, WATCHLISTS_KEY); return raw; },
      setItem: () => { writes++; } };
    const loaded = readWatchlists(storage, keys);
    assert.equal(loaded.canPersist, false);
    assert.ok(loaded.message);
    assert.equal(writes, 0);
    if (loaded.value.groups.length) assert.deepEqual(loaded.value.groups[0].symbols, ['QQQ']);
  }
});

test('explicit persistence round trips; denied storage preserves the input state', () => {
  let saved;
  const storage = { getItem: () => saved ?? null, setItem: (key, raw) => {
    assert.equal(key, WATCHLISTS_KEY); saved = raw;
  } };
  const state = change(emptyWatchlists(), { type: 'create', name: '核心' });
  assert.equal(saveWatchlists(storage, state, keys).saved, true);
  const loaded = readWatchlists(storage, keys);
  assert.deepEqual(loaded.value, state);
  assert.equal(loaded.canPersist, true);
  const denied = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
  assert.equal(readWatchlists(denied, keys).canPersist, false);
  const before = structuredClone(state);
  assert.equal(saveWatchlists(denied, state, keys).saved, false);
  assert.deepEqual(state, before);
  assert.equal(saveWatchlists(undefined, state, keys).saved, false);
});
