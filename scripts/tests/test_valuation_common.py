"""Offline unit tests for scripts/_valuation.py (no network calls). spec_V.md V2/first layer."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import _common  # noqa: E402
import _valuation  # noqa: E402


class LoadRowsTests(unittest.TestCase):
    def test_missing_file_returns_empty_list(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "nope.json"
            self.assertEqual(_common.load_rows(path), [])

    def test_corrupt_json_returns_empty_list(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "bad.json"
            path.write_text("{not json")
            self.assertEqual(_common.load_rows(path), [])

    def test_normal_case_returns_data_list(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "data.json"
            rows = [{"date": "2020-01-01", "fpe": 20.0}, {"date": "2020-01-02", "fpe": 21.0}]
            path.write_text(json.dumps({"updated": "2020-01-02", "note": "n", "data": rows}))
            self.assertEqual(_common.load_rows(path), rows)

    def test_missing_data_key_returns_empty_list(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "data.json"
            path.write_text(json.dumps({"updated": "2020-01-01"}))
            self.assertEqual(_common.load_rows(path), [])


class WeightedMeansTests(unittest.TestCase):
    def test_known_values_match_original_formula(self):
        # Same numbers as the SOXX docstring example: arithmetic 23.87 vs harmonic 18.88.
        pairs = [(30.0, 20.0), (15.0, 60.0), (50.0, 20.0)]
        total_w = sum(w for _, w in pairs)
        expected_arith = sum(v * w for v, w in pairs) / total_w
        expected_harmonic = total_w / sum(w / v for v, w in pairs)
        arith, harmonic = _valuation.weighted_means(pairs)
        self.assertAlmostEqual(arith, expected_arith)
        self.assertAlmostEqual(harmonic, expected_harmonic)

    def test_single_pair_both_means_equal_value(self):
        arith, harmonic = _valuation.weighted_means([(25.0, 100.0)])
        self.assertAlmostEqual(arith, 25.0)
        self.assertAlmostEqual(harmonic, 25.0)

    def test_equal_values_both_means_equal(self):
        pairs = [(20.0, 1.0), (20.0, 5.0), (20.0, 3.0)]
        arith, harmonic = _valuation.weighted_means(pairs)
        self.assertAlmostEqual(arith, 20.0)
        self.assertAlmostEqual(harmonic, 20.0)

    def test_empty_raises_zero_division(self):
        with self.assertRaises(ZeroDivisionError):
            _valuation.weighted_means([])


class WriteDailySnapshotTests(unittest.TestCase):
    def _old_style_write(self, out_path, today, entry, note):
        """The pre-refactor tail, verbatim (e.g. fetch_qqq_valuation.py main())."""
        existing = _common.load_rows(out_path)
        by_date = {r["date"]: r for r in existing}
        by_date[today] = {**by_date.get(today, {}), **entry}
        merged = sorted(by_date.values(), key=lambda r: r["date"])
        payload = {"updated": today, "note": note, "data": merged}
        out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
        return merged

    def test_new_file_matches_old_style_bytes(self):
        with tempfile.TemporaryDirectory() as d:
            p_old = Path(d) / "old.json"
            p_new = Path(d) / "new.json"
            entry = {"date": "2026-09-25", "src": "calc", "fpe": 22.5}
            self._old_style_write(p_old, "2026-09-25", entry, "note text")
            _valuation.write_daily_snapshot(p_new, "2026-09-25", entry, "note text")
            self.assertEqual(p_old.read_bytes(), p_new.read_bytes())

    def test_merge_with_existing_same_day_preserves_untouched_keys(self):
        with tempfile.TemporaryDirectory() as d:
            p_old = Path(d) / "old.json"
            p_new = Path(d) / "new.json"
            seed = {"updated": "2026-09-24", "note": "n", "data": [
                {"date": "2026-09-24", "src": "calc", "fpe": 10.0, "tpe": 15.0},
            ]}
            p_old.write_text(json.dumps(seed))
            p_new.write_text(json.dumps(seed))
            # Today re-runs with only fpe present (tpe omitted, as when tpe fetch failed)
            entry = {"date": "2026-09-24", "src": "calc", "fpe": 11.0}
            expected = self._old_style_write(p_old, "2026-09-24", entry, "note text")
            actual = _valuation.write_daily_snapshot(p_new, "2026-09-24", entry, "note text")
            self.assertEqual(expected, actual)
            self.assertEqual(p_old.read_bytes(), p_new.read_bytes())
            # tpe from the old entry must survive since this entry didn't include it
            self.assertEqual(actual[0]["tpe"], 15.0)

    def test_appends_new_date_sorted(self):
        with tempfile.TemporaryDirectory() as d:
            p_old = Path(d) / "old.json"
            p_new = Path(d) / "new.json"
            seed = {"updated": "2026-09-24", "note": "n", "data": [
                {"date": "2026-09-23", "src": "calc", "fpe": 10.0},
            ]}
            p_old.write_text(json.dumps(seed))
            p_new.write_text(json.dumps(seed))
            entry = {"date": "2026-09-25", "src": "calc", "fpe": 12.0}
            self._old_style_write(p_old, "2026-09-25", entry, "note text")
            _valuation.write_daily_snapshot(p_new, "2026-09-25", entry, "note text")
            self.assertEqual(p_old.read_bytes(), p_new.read_bytes())

    def test_returns_merged_list(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "x.json"
            merged = _valuation.write_daily_snapshot(
                p, "2026-09-25", {"date": "2026-09-25", "src": "calc", "fpe": 1.0}, "note",
            )
            self.assertEqual(merged, [{"date": "2026-09-25", "src": "calc", "fpe": 1.0}])


if __name__ == "__main__":
    unittest.main()
