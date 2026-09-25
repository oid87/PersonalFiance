// dates.toWeeklyOHLC — unit tests + old-vs-new equivalence check.
//
// Spec W2 (08): toWeeklyOHLC was duplicated verbatim in js/tabs/wkrev.js and
// js/tabs/qqqmacd.js; both now import the single copy living in
// js/utils/dates.js. This file: (a) exercises the basic behaviour (full week,
// partial trailing week, empty input, cross-year week), and (b) proves the
// new export is byte-for-byte identical to the old js/tabs/wkrev.js (pre-e997537e)
// local function on both synthetic and real (data/QQQ.json) input.
//
// Spec Y (N4): the old function body no longer comes from a live `git show`
// call (that made this test depend on git history and the local clone's
// object store being reachable, e.g. in a `git archive` tree with no .git).
// It is instead read from a pinned fixture file — see
// fixtures/old_toWeeklyOHLC.js for provenance (exact commit SHA + line range).
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { toWeeklyOHLC } = await import("../dates.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

// ── load the old (pre-refactor) toWeeklyOHLC body from the pinned fixture ──
function loadOldToWeeklyOHLC() {
  const fixturePath = path.join(__dirname, "fixtures", "old_toWeeklyOHLC.js");
  const fnSrc = fs.readFileSync(fixturePath, "utf8");
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${fnSrc}\nthis.toWeeklyOHLC = toWeeklyOHLC;`, sandbox);
  return sandbox.toWeeklyOHLC;
}

const oldToWeeklyOHLC = loadOldToWeeklyOHLC();

// ── fixtures ────────────────────────────────────────────────────────────
// [date, open, high, low, close, volume]
function mkRow(date, o, h, l, c, v = 1000) { return [date, o, h, l, c, v]; }

test("toWeeklyOHLC: full week (Mon-Fri) aggregates correctly, not partial", () => {
  const daily = [
    mkRow("2024-01-01", 10, 12, 9, 11), // Mon
    mkRow("2024-01-02", 11, 13, 10, 12), // Tue
    mkRow("2024-01-03", 12, 14, 11, 13), // Wed
    mkRow("2024-01-04", 13, 15, 12, 14), // Thu
    mkRow("2024-01-05", 14, 16, 13, 15), // Fri
  ];
  const weeks = toWeeklyOHLC(daily);
  assert.equal(weeks.length, 1);
  const w = weeks[0];
  assert.equal(w.weekStart, "2024-01-01");
  assert.equal(w.weekEndDate, "2024-01-05");
  assert.equal(w.open, 10);
  assert.equal(w.high, 16);
  assert.equal(w.low, 9);
  assert.equal(w.close, 15);
  assert.equal(w.volume, 5000);
  assert.equal(w.partial, false);
});

test("toWeeklyOHLC: incomplete trailing week (last day not Friday) → partial=true", () => {
  const daily = [
    mkRow("2024-01-01", 10, 12, 9, 11), // Mon (full week 1)
    mkRow("2024-01-02", 11, 13, 10, 12),
    mkRow("2024-01-03", 12, 14, 11, 13),
    mkRow("2024-01-04", 13, 15, 12, 14),
    mkRow("2024-01-05", 14, 16, 13, 15), // Fri — week 1 complete
    mkRow("2024-01-08", 15, 17, 14, 16), // Mon week 2
    mkRow("2024-01-09", 16, 18, 15, 17), // Tue — week 2 ends here (not Fri)
  ];
  const weeks = toWeeklyOHLC(daily);
  assert.equal(weeks.length, 2);
  assert.equal(weeks[0].partial, false);
  assert.equal(weeks[1].partial, true);
  assert.equal(weeks[1].weekEndDate, "2024-01-09");
});

test("toWeeklyOHLC: empty input → empty array", () => {
  const weeks = toWeeklyOHLC([]);
  assert.deepEqual(weeks, []);
});

test("toWeeklyOHLC: cross-year week (Mon Dec 30 2024 .. Fri Jan 3 2025) groups into one week", () => {
  const daily = [
    mkRow("2024-12-30", 1, 2, 0.5, 1.5), // Mon
    mkRow("2024-12-31", 1.5, 2.5, 1, 2), // Tue
    mkRow("2025-01-02", 2, 3, 1.5, 2.5), // Thu (Jan 1 holiday)
    mkRow("2025-01-03", 2.5, 3.5, 2, 3), // Fri
  ];
  const weeks = toWeeklyOHLC(daily);
  assert.equal(weeks.length, 1);
  assert.equal(weeks[0].weekStart, "2024-12-30");
  assert.equal(weeks[0].weekEndDate, "2025-01-03");
  assert.equal(weeks[0].partial, false);
  assert.equal(weeks[0].high, 3.5);
  assert.equal(weeks[0].low, 0.5);
});

// ── old vs new: synthetic multi-year, multi-partial-week series ──────────
test("toWeeklyOHLC: new export === old wkrev.js function (synthetic series)", () => {
  const daily = [];
  let d = new Date("2019-12-20T00:00:00Z"); // Fri, ahead of a Mon start
  let price = 100;
  for (let i = 0; i < 900; i++) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) { // skip weekends
      const o = price;
      const c = price + (i % 7 === 0 ? -1 : 1) * 0.3;
      const h = Math.max(o, c) + 0.5;
      const l = Math.min(o, c) - 0.5;
      daily.push(mkRow(d.toISOString().slice(0, 10), o, h, l, c, 1000 + i));
      price = c;
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  const oldOut = oldToWeeklyOHLC(daily);
  const newOut = toWeeklyOHLC(daily);
  assert.equal(JSON.stringify(newOut), JSON.stringify(oldOut));
});

// ── old vs new: real data/QQQ.json ───────────────────────────────────────
test("toWeeklyOHLC: new export === old wkrev.js function (real data/QQQ.json)", () => {
  const qqqPath = path.join(REPO_ROOT, "data", "QQQ.json");
  const raw = JSON.parse(fs.readFileSync(qqqPath, "utf8"));
  const daily = (raw.data || []).map(r => [r.date, r.open, r.high, r.low, r.close, r.volume || 0]);
  assert.ok(daily.length > 100, "expected real QQQ.json rows to build OHLCV from");
  const oldOut = oldToWeeklyOHLC(daily);
  const newOut = toWeeklyOHLC(daily);
  assert.equal(JSON.stringify(newOut), JSON.stringify(oldOut));
});
