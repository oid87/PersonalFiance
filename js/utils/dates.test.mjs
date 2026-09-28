// dates.toMonthlyLast — unit tests.
//
// Spec: docs/ndx_sox_forward_pe_spec.md 包 B。月頻重採樣純函式，取每月最後一筆
// 非 null 值；不插值（未達 minObs 的月份整月丟掉）；當月標 partial。
import assert from "node:assert/strict";
import test from "node:test";

const { toMonthlyLast } = await import("./dates.js");

test("toMonthlyLast: takes the last observation within each month", () => {
  const points = [
    ["2026-01-05", 10],
    ["2026-01-20", 12],
    ["2026-02-03", 20],
  ];
  const out = toMonthlyLast(points, { today: new Date("2026-06-15") });
  assert.deepEqual(out.map(r => [r.month, r.value, r.date]), [
    ["2026-01", 12, "2026-01-20"],
    ["2026-02", 20, "2026-02-03"],
  ]);
});

test("toMonthlyLast: null values are ignored", () => {
  const points = [
    ["2026-01-05", 10],
    ["2026-01-20", null],
    ["2026-02-03", null],
  ];
  const out = toMonthlyLast(points, { today: new Date("2026-06-15") });
  assert.deepEqual(out.map(r => r.month), ["2026-01"]);
  assert.equal(out[0].value, 10);
  assert.equal(out[0].n, 1);
});

test("toMonthlyLast: months below minObs are dropped, not interpolated", () => {
  const points = [
    ["2026-01-05", 10],
    ["2026-02-03", 20],
    ["2026-02-10", 21],
    ["2026-02-17", 22],
  ];
  const out = toMonthlyLast(points, { minObs: 3, today: new Date("2026-06-15") });
  assert.deepEqual(out.map(r => r.month), ["2026-02"]);
  assert.equal(out[0].n, 3);
});

test("toMonthlyLast: current month is marked partial", () => {
  const points = [
    ["2026-05-05", 10],
    ["2026-06-03", 20],
  ];
  const out = toMonthlyLast(points, { today: new Date("2026-06-15") });
  assert.deepEqual(out.map(r => [r.month, r.partial]), [
    ["2026-05", false],
    ["2026-06", true],
  ]);
});

test("toMonthlyLast: unsorted input still produces correct last-of-month + order", () => {
  const points = [
    ["2026-02-03", 20],
    ["2026-01-20", 12],
    ["2026-01-05", 10],
    ["2026-02-17", 22],
  ];
  const out = toMonthlyLast(points, { today: new Date("2026-06-15") });
  assert.deepEqual(out.map(r => [r.month, r.value, r.date]), [
    ["2026-01", 12, "2026-01-20"],
    ["2026-02", 22, "2026-02-17"],
  ]);
});
