// pentagram_calc.mjs — unit tests.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const {
  ZONES,
  pentaZone,
  lastBands,
  periodStart,
  multiPeriodZones,
  computeDonchianBands,
  channelState,
  combinedSignal,
} = await import("./pentagram_calc.mjs");

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// pentaZone
// ---------------------------------------------------------------------------

test("pentaZone: xgreed when price above u2", () => {
  const b = { u2: 100, u1: 90, tr: 80, l1: 70, l2: 60 };
  assert.equal(pentaZone(110, b).key, "xgreed");
});

test("pentaZone: greed when price between u1 and u2", () => {
  const b = { u2: 100, u1: 90, tr: 80, l1: 70, l2: 60 };
  assert.equal(pentaZone(95, b).key, "greed");
});

test("pentaZone: neutral when price between l1 and u1", () => {
  const b = { u2: 100, u1: 90, tr: 80, l1: 70, l2: 60 };
  assert.equal(pentaZone(80, b).key, "neutral");
});

test("pentaZone: fear when price between l2 and l1", () => {
  const b = { u2: 100, u1: 90, tr: 80, l1: 70, l2: 60 };
  assert.equal(pentaZone(65, b).key, "fear");
});

test("pentaZone: xfear when price below l2", () => {
  const b = { u2: 100, u1: 90, tr: 80, l1: 70, l2: 60 };
  assert.equal(pentaZone(50, b).key, "xfear");
});

test("pentaZone: boundary price === u2 is xgreed", () => {
  const b = { u2: 100, u1: 90, tr: 80, l1: 70, l2: 60 };
  assert.equal(pentaZone(100, b).key, "xgreed");
});

test("pentaZone: boundary price === u1 is greed", () => {
  const b = { u2: 100, u1: 90, tr: 80, l1: 70, l2: 60 };
  assert.equal(pentaZone(90, b).key, "greed");
});

test("pentaZone: boundary price === l1 is fear", () => {
  const b = { u2: 100, u1: 90, tr: 80, l1: 70, l2: 60 };
  assert.equal(pentaZone(70, b).key, "fear");
});

test("pentaZone: boundary price === l2 is xfear", () => {
  const b = { u2: 100, u1: 90, tr: 80, l1: 70, l2: 60 };
  assert.equal(pentaZone(60, b).key, "xfear");
});

test("ZONES: five zones, high to low", () => {
  assert.deepEqual(ZONES.map(z => z.key), ["xgreed", "greed", "neutral", "fear", "xfear"]);
});

// ---------------------------------------------------------------------------
// lastBands
// ---------------------------------------------------------------------------

test("lastBands: null reg returns null", () => {
  assert.equal(lastBands(null), null);
});

test("lastBands: takes last point of each series", () => {
  const reg = {
    trend:  [["2026-01-01", 1], ["2026-01-02", 2]],
    upper1: [["2026-01-01", 3], ["2026-01-02", 4]],
    upper2: [["2026-01-01", 5], ["2026-01-02", 6]],
    lower1: [["2026-01-01", 7], ["2026-01-02", 8]],
    lower2: [["2026-01-01", 9], ["2026-01-02", 10]],
  };
  assert.deepEqual(lastBands(reg), { u2: 6, u1: 4, tr: 2, l1: 8, l2: 10 });
});

// ---------------------------------------------------------------------------
// periodStart
// ---------------------------------------------------------------------------

test("periodStart: 0.5Y from 2026-09-25", () => {
  assert.equal(periodStart("0.5Y", "2026-09-25"), "2026-03-25");
});

test("periodStart: 1.5Y from 2026-09-25", () => {
  assert.equal(periodStart("1.5Y", "2026-09-25"), "2025-03-25");
});

test("periodStart: 3.5Y from 2026-09-25", () => {
  assert.equal(periodStart("3.5Y", "2026-09-25"), "2023-03-25");
});

test("periodStart: 5Y from 2026-09-25", () => {
  assert.equal(periodStart("5Y", "2026-09-25"), "2021-09-25");
});

test("periodStart: unknown period throws", () => {
  assert.throws(() => periodStart("10Y", "2026-09-25"), Error);
});

// ---------------------------------------------------------------------------
// computeDonchianBands
// ---------------------------------------------------------------------------

function makeWeeklyHLC(n) {
  // [date, high, low, close]; date is a fake weekly key, values are simple ramps.
  const rows = [];
  for (let i = 0; i < n; i++) {
    const date = `2026-W${String(i).padStart(3, "0")}`;
    rows.push([date, 100 + i, 90 + i, 95 + i]);
  }
  return rows;
}

test("computeDonchianBands: n <= window returns empty arrays", () => {
  const rows = makeWeeklyHLC(20);
  const { mid, upper, lower } = computeDonchianBands(rows, 20);
  assert.deepEqual(mid, []);
  assert.deepEqual(upper, []);
  assert.deepEqual(lower, []);
});

test("computeDonchianBands: excludes current row (global max at last row doesn't appear as its own upper)", () => {
  const rows = makeWeeklyHLC(22); // 22 rows, n=20 -> i=20,21 produced
  const { mid, upper, lower } = computeDonchianBands(rows, 20);
  assert.equal(upper.length, 2);
  assert.equal(lower.length, 2);
  assert.equal(mid.length, 2);
  // Row i=21 (last) has the global max high = 90+21=111 (base 100+21=121 actually)
  // rows[21] = ["2026-W021", 121, 111, 116]; window for i=21 is rows[1..20]
  // window highs = 101..120 (rows[1]..rows[20] high = 100+i), max = 120
  const lastRow = rows[21];
  assert.equal(lastRow[1], 121); // sanity: row's own high is 121, the global max
  const upperForLast = upper[upper.length - 1][1];
  assert.notEqual(upperForLast, lastRow[1]);
  assert.equal(upperForLast, 120); // window rows[1..20], high = 100+i for i=1..20 -> max 120

  // window low for i=21: rows[1..20], low = 90+i for i=1..20 -> min 91
  const lowerForLast = lower[lower.length - 1][1];
  assert.equal(lowerForLast, 91);

  // mid = (upper+lower)/2
  const midForLast = mid[mid.length - 1][1];
  assert.equal(midForLast, (120 + 91) / 2);

  // date matches the i-th row's own date
  assert.equal(upper[upper.length - 1][0], lastRow[0]);
});

test("computeDonchianBands: first produced row (i=n) also excludes row i itself", () => {
  const rows = makeWeeklyHLC(22);
  const { upper, lower } = computeDonchianBands(rows, 20);
  // i=20: window = rows[0..19], highs = 100..119 -> max 119; row20 high = 120 (excluded)
  assert.equal(upper[0][1], 119);
  assert.equal(rows[20][1], 120);
  // lows = 90..109 -> min 90
  assert.equal(lower[0][1], 90);
});

// ---------------------------------------------------------------------------
// channelState
// ---------------------------------------------------------------------------

test("channelState: above upper", () => {
  assert.deepEqual(channelState(110, 100, 90), { key: "above", label: "突破上緣" });
});

test("channelState: below lower", () => {
  assert.deepEqual(channelState(80, 100, 90), { key: "below", label: "跌破下緣" });
});

test("channelState: inside channel", () => {
  assert.deepEqual(channelState(95, 100, 90), { key: "inside", label: "通道內" });
});

test("channelState: na when close is null", () => {
  assert.deepEqual(channelState(null, 100, 90), { key: "na", label: "—" });
});

test("channelState: na when upper is NaN", () => {
  assert.deepEqual(channelState(95, NaN, 90), { key: "na", label: "—" });
});

test("channelState: na when lower is null", () => {
  assert.deepEqual(channelState(95, 100, null), { key: "na", label: "—" });
});

// ---------------------------------------------------------------------------
// combinedSignal
// ---------------------------------------------------------------------------

test("combinedSignal: xgreed + above -> warn", () => {
  assert.deepEqual(combinedSignal("xgreed", "above"), {
    tone: "warn",
    text: "五線譜極度貪婪＋突破樂活上緣：股價可能將轉弱",
  });
});

test("combinedSignal: xgreed + inside -> info", () => {
  assert.deepEqual(combinedSignal("xgreed", "inside"), {
    tone: "info",
    text: "僅五線譜極度貪婪、樂活未突破上緣：有機會再漲一段",
  });
});

test("combinedSignal: xfear + below -> opportunity", () => {
  assert.deepEqual(combinedSignal("xfear", "below"), {
    tone: "opportunity",
    text: "五線譜極度恐懼＋跌破樂活下緣：底部訊號較強",
  });
});

test("combinedSignal: xfear + inside -> info", () => {
  assert.deepEqual(combinedSignal("xfear", "inside"), {
    tone: "info",
    text: "僅五線譜極度恐懼、樂活未跌破下緣：底部訊號較弱",
  });
});

test("combinedSignal: neutral zone -> null", () => {
  assert.equal(combinedSignal("neutral", "inside"), null);
  assert.equal(combinedSignal("greed", "above"), null);
  assert.equal(combinedSignal("fear", "below"), null);
});

// ---------------------------------------------------------------------------
// QQQ frozen fixture cross-check
// ---------------------------------------------------------------------------

test("multiPeriodZones: matches frozen QQQ fixture expectations", () => {
  const fixturePath = join(__dirname, "pentagram_calc.fixture.json");
  const daily = JSON.parse(readFileSync(fixturePath, "utf8"));
  const today = "2026-09-25";
  const periods = ["0.5Y", "1.5Y", "3.5Y", "5Y"];
  const out = multiPeriodZones(daily, periods, today, { weekly: false });

  const expected = {
    "0.5Y": { n: 128,  bands: [811.55, 778.82, 746.09, 713.35, 680.62], zone: "neutral" },
    "1.5Y": { n: 379,  bands: [794.21, 765.50, 736.78, 708.06, 679.34], zone: "neutral" },
    "3.5Y": { n: 879,  bands: [756.60, 728.65, 700.71, 672.77, 644.82], zone: "greed" },
    "5Y":   { n: 1255, bands: [765.12, 712.24, 659.35, 606.46, 553.57], zone: "greed" },
  };

  const TOL = 0.05;
  const mismatches = [];
  for (const row of out) {
    const exp = expected[row.period];
    if (row.n !== exp.n) {
      mismatches.push(`${row.period}: n actual=${row.n} expected=${exp.n}`);
    }
    const actualBands = row.bands ? [row.bands.u2, row.bands.u1, row.bands.tr, row.bands.l1, row.bands.l2] : null;
    if (!actualBands) {
      mismatches.push(`${row.period}: bands actual=null expected=${JSON.stringify(exp.bands)}`);
    } else {
      exp.bands.forEach((v, i) => {
        if (Math.abs(actualBands[i] - v) > TOL) {
          mismatches.push(`${row.period}: bands[${i}] actual=${actualBands[i]} expected=${v}`);
        }
      });
    }
    const actualZone = row.zone ? row.zone.key : null;
    if (actualZone !== exp.zone) {
      mismatches.push(`${row.period}: zone actual=${actualZone} expected=${exp.zone}`);
    }
  }

  assert.deepEqual(mismatches, [], mismatches.join("\n"));
});
