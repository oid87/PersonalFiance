import assert from "node:assert/strict";
import test from "node:test";

const dataModule = await import("../data.js");
const { loaded } = await import("../../state.js");

test.afterEach(() => {
  globalThis.fetch = undefined;
  for (const key of Object.keys(loaded)) delete loaded[key];
});

test("hung request aborts and clears its timeout", async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let timeoutToken;
  let cleared;
  globalThis.setTimeout = fn => {
    timeoutToken = { fn };
    queueMicrotask(fn);
    return timeoutToken;
  };
  globalThis.clearTimeout = token => { cleared = token; };
  globalThis.fetch = (_url, options) => new Promise((_, reject) => {
    options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
  try {
    await assert.rejects(() => dataModule.fetchJSON("hung.json"), /timed out after 15000ms/);
    assert.equal(cleared, timeoutToken);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test("failed stale refresh preserves the last known cache", async () => {
  const old = [["2020-01-01", 42]];
  loaded.TEST = old;
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(
    () => dataModule.loadSeries({ key: "TEST", file: "test.json" }),
    /TEST: HTTP 503/,
  );
  assert.equal(loaded.TEST, old);
});

test("invalid JSON is an explicit failure", async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => { throw new SyntaxError("bad json"); },
  });
  await assert.rejects(() => dataModule.fetchJSON("bad.json"), /invalid JSON/);
});

test("missing, empty, and malformed series rows are rejected", async t => {
  for (const [name, payload, pattern] of [
    ["missing", {}, /missing or empty data rows/],
    ["empty", { data: [] }, /missing or empty data rows/],
    ["bad value", { data: [{ date: "2026-01-01", close: null }] }, /invalid row 1/],
    ["bad date", { data: [{ date: "2026-02-30", close: 1 }] }, /invalid row 1/],
  ]) {
    await t.test(name, async () => {
      globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => payload });
      await assert.rejects(
        () => dataModule.loadSeries({ key: "TEST", file: "test.json" }),
        pattern,
      );
      assert.equal(loaded.TEST, undefined);
    });
  }
});

test("ensureLoaded rejects an unknown key", async () => {
  await assert.rejects(() => dataModule.ensureLoaded("NOT_REGISTERED"), /Unknown series/);
});


test("failed calendar refresh preserves existing events", async () => {
  const { state } = await import('../../state.js');
  const events = [{ date: '2026-09-10', ticker: 'NVDA' }];
  state.loadedEarnings = events;
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  await dataModule.loadEarnings();
  assert.equal(state.loadedEarnings, events);
});
