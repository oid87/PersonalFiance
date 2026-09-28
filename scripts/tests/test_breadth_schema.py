"""Offline breadth schema checks with synthetic prices and temporary output files."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import Mock, patch

import pandas as pd

SCRIPTS = Path(__file__).resolve().parents[1]
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import _breadth


def prices_ending(end, periods=300):
    return pd.DataFrame(
        {"OLD": [float(i + 1) for i in range(periods)]},
        index=pd.date_range(end=end, periods=periods),
    )


def legacy_row(day):
    return {
        "date": day.isoformat(), "above20_count": 1, "above20_pct": 100.0,
        "above50_count": 1, "above50_pct": 100.0,
        "above200_count": None, "above200_pct": None,
        "new_hi_count": None, "bear_count": None, "total": 1,
    }


class BreadthCountsTests(unittest.TestCase):
    def test_different_windows_use_actual_valid_counts_and_original_formula(self):
        frame = prices_ending("2020-12-31")
        frame["IPO60"] = [None] * 240 + list(range(60))
        frame["IPO25"] = [None] * 275 + list(range(25))
        frame["GAP"] = list(range(300))
        frame.iloc[-30, frame.columns.get_loc("GAP")] = None
        rows = _breadth.compute_breadth(frame, min_coverage=100)
        last = rows[-1]
        self.assertEqual([last[f"above{w}_total"] for w in (20, 50, 200)], [4, 2, 1])
        for row in rows:
            dt = pd.Timestamp(row["date"])
            for window in (20, 50, 200):
                moving = frame.loc[:dt].tail(window)
                valid = moving.notna().sum().eq(window) if len(moving) == window else pd.Series(False, index=frame.columns)
                n = int(valid.sum())
                count = int((frame.loc[dt, valid] > moving.loc[:, valid].mean()).sum()) if n else None
                self.assertEqual(row[f"above{window}_total"], n)
                self.assertEqual(row[f"above{window}_count"], count)
                self.assertEqual(row[f"above{window}_pct"], round(count / n * 100, 1) if n else None)
                self.assertIs(type(row[f"above{window}_total"]), int)
            self.assertEqual(row["total"], row["above50_total"])

    def test_zero_200_denominator_is_zero_and_percentage_null(self):
        rows = _breadth.compute_breadth(prices_ending("2020-12-31", 60), min_coverage=1)
        self.assertTrue(rows)
        self.assertEqual(rows[-1]["above200_total"], 0)
        self.assertIsNone(rows[-1]["above200_count"])
        self.assertIsNone(rows[-1]["above200_pct"])

    def test_existing_zero_50_and_recent_low_coverage_filters_remain(self):
        self.assertEqual(_breadth.compute_breadth(prices_ending(date.today(), 40), min_coverage=1), [])
        rows = _breadth.compute_breadth(prices_ending(date.today(), 80), min_coverage=2)
        cutoff = (date.today() - timedelta(days=_breadth.RECENT_WINDOW_DAYS)).isoformat()
        self.assertTrue(rows)
        self.assertTrue(all(row["date"] < cutoff for row in rows))


class BreadthRunTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "breadth.json"
        self.tickers = Mock(return_value=["OLD"])

    def seed(self, rows):
        self.path.write_text(json.dumps({"updated": "2000-01-01", "data": rows}) + "\n")
        return self.path.read_bytes()

    def run_breadth(self):
        _breadth.run(get_tickers=self.tickers, out_path=self.path, min_coverage=1, label="Test index")

    def test_fresh_legacy_schema_skips_download_and_does_not_rewrite(self):
        before = self.seed([legacy_row(date.today() - timedelta(days=2))])
        with patch.object(_breadth, "fetch_prices") as fetch:
            self.run_breadth()
        fetch.assert_not_called()
        self.tickers.assert_not_called()
        self.assertEqual(self.path.read_bytes(), before)

    def test_missing_new_totals_uses_incremental_recompute_and_preserves_old_row(self):
        old = legacy_row(date.today() - timedelta(days=500))
        recent = legacy_row(date.today() - timedelta(days=10))
        self.seed([old, recent])
        frame = prices_ending(date.today() - timedelta(days=1))
        with patch.object(_breadth, "fetch_prices", return_value=frame) as fetch, patch.object(_breadth, "compute_breadth", wraps=_breadth.compute_breadth) as compute:
            self.run_breadth()
        fetch.assert_called_once_with(["OLD"], (date.today() - timedelta(days=_breadth.INCREMENTAL_CAL)).isoformat())
        compute.assert_called_once()
        result = json.loads(self.path.read_text())
        self.assertEqual(result["data"][0], old)
        self.assertNotIn("above20_total", result["data"][0])
        self.assertNotIn("above200_total", result["data"][0])
        boundary = (date.fromisoformat(recent["date"]) - timedelta(days=30)).isoformat()
        self.assertEqual(result["data"][1]["date"], boundary)
        self.assertTrue(all("above20_total" in row for row in result["data"][1:]))
        self.assertEqual(result["schemaVersion"], 2)
        self.assertEqual(result["updated"], date.today().isoformat())
        self.assertEqual(result["meta"], {
            "label": "Test index", "priceBasis": "yfinance-auto-adjusted",
            "constituentsBasis": "current-snapshot-backfill-mixed-vintages",
            "lastDate": result["data"][-1]["date"],
            "denominatorPolicy": "per-window-valid-count",
            "legacyDenominators": "unknown-for-20-and-200",
        })
        self.assertNotEqual(result["updated"], result["meta"]["lastDate"])

    def test_initial_backfill_and_empty_merged_last_date(self):
        with patch.object(_breadth, "fetch_prices", return_value=prices_ending("2020-12-31", 40)) as fetch:
            self.run_breadth()
        fetch.assert_called_once_with(["OLD"], (date.today() - timedelta(days=_breadth.FULL_BACKFILL_CAL)).isoformat())
        result = json.loads(self.path.read_text())
        self.assertEqual(result["data"], [])
        self.assertIsNone(result["meta"]["lastDate"])

    def test_failed_or_empty_download_preserves_original_file(self):
        before = self.seed([legacy_row(date.today() - timedelta(days=10))])
        for effect in (RuntimeError("download failed"), pd.DataFrame()):
            with self.subTest(effect=type(effect).__name__):
                options = {"side_effect": effect} if isinstance(effect, Exception) else {"return_value": effect}
                with patch.object(_breadth, "fetch_prices", **options), self.assertRaises(RuntimeError):
                    self.run_breadth()
                self.assertEqual(self.path.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
