import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NAV_ITEMS, createModuleLoader, registryEntries } from '../navigation-catalog.mjs';
import { parseTabHash, tabHash, readFavorites, visibleDialogGeometry } from '../navigation.js';

test('registry is lazy and boot has no static tab imports', () => {
  const entries = registryEntries();
  assert.equal(entries.length, 72);
  assert.deepEqual(entries.map(entry => entry.id), NAV_ITEMS.map(item => item.id));
  assert.ok(entries.every(entry => typeof entry.load === 'function'));
  const boot = readFileSync(new URL('../boot.js', import.meta.url), 'utf8');
  assert.doesNotMatch(boot, /from ['"]\.\/tabs\//);
  assert.doesNotMatch(boot, /import\s*\*\s*as/);
});

test('root fetch failure retries with one new URL and then caches success', async () => {
  const item = NAV_ITEMS.find(entry => entry.id === 'earnings');
  const calls = [];
  const module = { activate() {} };
  const load = createModuleLoader(item, async url => {
    calls.push(url);
    if (calls.length === 1) throw new TypeError('Failed to fetch dynamically imported module: ' + url);
    return module;
  });
  await assert.rejects(load(), /按重試/);
  assert.equal(load.needsReload(), false);
  assert.equal(await load(), module);
  assert.equal(await load(), module);
  assert.equal(calls.length, 2);
  assert.ok(!calls[0].includes('lazyRetry='));
  assert.ok(calls[1].includes('lazyRetry=1'));
});

test('dependency failure asks for a full reload without useless root retry', async () => {
  const item = NAV_ITEMS.find(entry => entry.id === 'pentagram');
  let calls = 0;
  const load = createModuleLoader(item, async () => {
    calls++;
    throw new TypeError('Failed to fetch dynamically imported module: ' +
      new URL('../tabs/pentagram_calc.mjs', import.meta.url).href);
  });
  await assert.rejects(load(), /重新載入頁面/);
  assert.equal(load.needsReload(), true);
  await assert.rejects(load(), /重新載入頁面/);
  assert.equal(calls, 1);
});

test('unknown failure is capped after one query retry', async () => {
  const item = NAV_ITEMS.find(entry => entry.id === 'earnings');
  let calls = 0;
  const load = createModuleLoader(item, async () => { calls++; throw new TypeError('Importing a module script failed.'); });
  await assert.rejects(load(), /按重試/);
  await assert.rejects(load(), /重新載入頁面/);
  await assert.rejects(load(), /重新載入頁面/);
  assert.equal(calls, 2);
});

test('deep links, invalid ids, favorites, and visible viewport stay bounded', () => {
  assert.deepEqual(parseTabHash('#tab=fsi'), { id: 'fsi', valid: true, rangeKey: null, range: null });
  assert.equal(parseTabHash('#tab=%E0%A4%A').id, 'trend');
  assert.equal(parseTabHash('#tab=no-such-tab').valid, false);
  assert.equal(tabHash('trend', { key: 'range', value: '1Y' }), '#tab=trend&rangeKey=range&range=1Y');
  assert.deepEqual([...readFavorites({ getItem: () => '["fsi","fsi","invalid"]' })], ['fsi']);
  assert.equal(readFavorites({ getItem: () => '{bad' }).size, 0);
  assert.equal(readFavorites({ getItem: () => { throw Error('blocked'); } }).size, 0);
  assert.equal(visibleDialogGeometry(null), null);
  const portraitKeyboard = visibleDialogGeometry({ width: 390, height: 190, offsetLeft: 0, offsetTop: 20 });
  assert.deepEqual({ top: portraitKeyboard.top, height: portraitKeyboard.height, compact: portraitKeyboard.compact },
    { top: 115, height: 174, compact: true });
  const landscapeKeyboard = visibleDialogGeometry({ width: 844, height: 400, offsetLeft: 0, offsetTop: 0 });
  assert.equal(landscapeKeyboard.height, 384);
  assert.equal(landscapeKeyboard.width, 620);
});
