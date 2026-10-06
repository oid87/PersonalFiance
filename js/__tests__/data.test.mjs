import assert from 'node:assert/strict';
import test from 'node:test';
import { requestJSON, clearRequestCache, clearRequestCacheForSignal, fetchJSON } from '../utils/data.js';

const originalFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = originalFetch; });
test.beforeEach(() => clearRequestCache());
const response = body => ({ ok: true, json: async () => body });

test('HTTP, JSON, network, timeout errors clear cache for retry', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: false, status: 500 }; };
  await assert.rejects(requestJSON('/bad'), /HTTP 500/);
  globalThis.fetch = async () => { calls++; return response({ data: [1] }); };
  assert.deepEqual(await requestJSON('/bad'), { data: [1] });
  assert.equal(calls, 2);
  clearRequestCache();
  globalThis.fetch = async () => ({ ok: true, json: async () => { throw new SyntaxError('bad'); } });
  await assert.rejects(requestJSON('/bad'), /invalid JSON/);
  globalThis.fetch = async () => { throw new TypeError('offline'); };
  await assert.rejects(requestJSON('/bad'), /offline/);
  globalThis.fetch = (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  await assert.rejects(requestJSON('/slow', { timeoutMs: 5 }), /timed out/);
});

test('concurrent canonical URLs share fetch; consumers receive isolated clones', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return response({ data: [{ value: 1 }] }); };
  const [a, b] = await Promise.all([requestJSON('/same'), requestJSON('http://localhost/same')]);
  a.data[0].value = 99;
  assert.equal(b.data[0].value, 1);
  assert.equal((await requestJSON('/same')).data[0].value, 1);
  assert.equal(calls, 1);
  assert.deepEqual(await fetchJSON('/same'), [{ value: 1 }]);
  assert.deepEqual(await fetchJSON('/same', { raw: true }), { data: [{ value: 1 }] });
});

test('consumer abort leaves shared request alive', async () => {
  let finish;
  globalThis.fetch = () => new Promise(resolve => { finish = () => resolve(response({ ok: 1 })); });
  const controller = new AbortController();
  const a = requestJSON('/shared', { signal: controller.signal });
  const b = requestJSON('/shared');
  controller.abort();
  await assert.rejects(a, /abort/i);
  finish();
  assert.deepEqual(await b, { ok: 1 });
});

test('TTL expiry and force generation do not let older completion overwrite newer', async () => {
  let now = 1000;
  const oldNow = Date.now;
  Date.now = () => now;
  try {
    let calls = 0;
    globalThis.fetch = async () => response({ n: ++calls });
    assert.equal((await requestJSON('/ttl', { ttlMs: 10 })).n, 1);
    assert.equal((await requestJSON('/ttl')).n, 1);
    now += 11;
    assert.equal((await requestJSON('/ttl')).n, 2);
    let oldFinish, newFinish;
    globalThis.fetch = () => ++calls === 3
      ? new Promise(resolve => { oldFinish = () => resolve(response({ n: 3 })); })
      : new Promise(resolve => { newFinish = () => resolve(response({ n: 4 })); });
    const old = requestJSON('/race', { force: true });
    const fresh = requestJSON('/race', { force: true });
    newFinish();
    assert.equal((await fresh).n, 4);
    oldFinish();
    assert.equal((await old).n, 3);
    assert.equal((await requestJSON('/race')).n, 4);
  } finally { Date.now = oldNow; }
});

test('already-aborted signal never starts a fetch', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return response({ ok: true }); };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(requestJSON('/aborted', { signal: controller.signal }), /abort/i);
  assert.equal(calls, 0);
});

test('failed activation clears only JSON entries touched by its signal', async () => {
  let calls = 0;
  globalThis.fetch = async url => response({ source: url, call: ++calls });
  const failed = new AbortController();
  const other = new AbortController();
  await requestJSON('/bad-shape', { signal: failed.signal });
  await requestJSON('/unrelated', { signal: other.signal });
  clearRequestCacheForSignal(failed.signal);
  assert.equal((await requestJSON('/bad-shape')).call, 3);
  assert.equal((await requestJSON('/unrelated')).call, 2);
  assert.equal(calls, 3);
});

test('old activation cleanup cannot delete a newer forced response', async () => {
  let calls = 0;
  globalThis.fetch = async () => response({ call: ++calls });
  const old = new AbortController();
  await requestJSON('/replacement', { signal: old.signal });
  await requestJSON('/replacement', { force: true });
  clearRequestCacheForSignal(old.signal);
  assert.equal((await requestJSON('/replacement')).call, 2);
  assert.equal(calls, 2);
});

test('timeout still rejects if a response body ignores abort', async () => {
  globalThis.fetch = async () => ({ ok: true, json: () => new Promise(resolve => setTimeout(() => resolve({ late: true }), 8)) });
  await assert.rejects(requestJSON('/late-body', { timeoutMs: 2 }), /timed out/);
});

test('late abort or stale generation never commits a series to global state', async () => {
  const { loadSeries } = await import('../utils/data.js');
  const { loaded, loadedHLC, loadedVol } = await import('../state.js');
  let finish;
  globalThis.fetch = () => new Promise(resolve => { finish = () => resolve(response({ data: [{ date: '2026-10-01', close: 7, high: 8, low: 6, volume: 9 }] })); });
  const controller = new AbortController();
  const pending = loadSeries({ key: 'TEST_LATE', file: '/late-series' }, { signal: controller.signal });
  controller.abort();
  finish();
  await assert.rejects(pending, /abort/i);
  assert.equal(loaded.TEST_LATE, undefined);
  assert.equal(loadedHLC.TEST_LATE, undefined);
  assert.equal(loadedVol.TEST_LATE, undefined);
  let current = true;
  const stale = loadSeries({ key: 'TEST_STALE', file: '/stale-series' }, { isCurrent: () => current });
  current = false;
  finish();
  await assert.rejects(stale, /abort/i);
  assert.equal(loaded.TEST_STALE, undefined);
});
