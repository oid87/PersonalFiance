import assert from "node:assert/strict";
import test from "node:test";

const { toPoints, latestOf } = await import("../data.js");

const rows = [
  { date: "2026-01-01", fpe: 20, h: null },
  { date: "2026-01-02", fpe: null, h: 18 },
  { date: "2026-01-03", fpe: 22 },
];

test("toPoints keeps rows whose field is non-null, as [date, value]", () => {
  assert.deepEqual(toPoints(rows, "fpe"), [["2026-01-01", 20], ["2026-01-03", 22]]);
  assert.deepEqual(toPoints(rows, "h"), [["2026-01-02", 18]]);
});

test("toPoints tolerates null/undefined rows", () => {
  assert.deepEqual(toPoints(null, "fpe"), []);
  assert.deepEqual(toPoints(undefined, "fpe"), []);
});

test("latestOf returns the last point or null", () => {
  assert.deepEqual(latestOf(rows, "fpe"), ["2026-01-03", 22]);
  assert.equal(latestOf([], "fpe"), null);
  assert.equal(latestOf(rows, "missing"), null);
});
