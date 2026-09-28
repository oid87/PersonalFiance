// math.sigmaBands — unit tests.
//
// Spec: docs/pe_sigma_bands_spec.md。μ±kσ 水平帶，σ 用母體標準差(ddof=0)；
// 輸入至少 2 個有限數才算，否則回 null。
import assert from "node:assert/strict";
import test from "node:test";

const { sigmaBands } = await import("./math.js");

test("sigmaBands: basic mean/sd/bands over [1,2,3,4,5]", () => {
  const out = sigmaBands([1, 2, 3, 4, 5]);
  assert.equal(out.n, 5);
  assert.equal(out.mu, 3);
  assert.ok(Math.abs(out.sd - Math.sqrt(2)) < 1e-12);
  assert.equal(out.bands.length, 4);
  assert.deepEqual(out.bands.map(b => b.k), [0.5, 1, 1.5, 2]);
  const k1 = out.bands.find(b => b.k === 1);
  assert.ok(Math.abs(k1.lo - (3 - Math.sqrt(2))) < 1e-12);
  assert.ok(Math.abs(k1.hi - (3 + Math.sqrt(2))) < 1e-12);
});

test("sigmaBands: null/NaN/Infinity values are filtered out", () => {
  const out = sigmaBands([1, null, 3, NaN, Infinity]);
  assert.equal(out.n, 2);
  assert.equal(out.mu, 2);
  assert.equal(out.sd, 1);
});

test("sigmaBands: fewer than 2 valid values returns null", () => {
  assert.equal(sigmaBands([]), null);
  assert.equal(sigmaBands([5]), null);
  assert.equal(sigmaBands([null, 7]), null);
});

test("sigmaBands: custom ks", () => {
  const out = sigmaBands([0, 2], [1]);
  assert.deepEqual(out.bands, [{ k: 1, lo: 0, hi: 2 }]);
});
