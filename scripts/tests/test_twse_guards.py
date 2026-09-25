"""Offline unit tests for the Spec Y (N1/N2) response-integrity guards added to
fetch_margin_ratio_mm.py and fetch_twse_mktcap.py. No network calls — all
requests.Session.get / helper functions are patched.
"""
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


mm = load("fetch_margin_ratio_mm")
mktcap = load("fetch_twse_mktcap")


# ── N1: fetch_margin_ratio_mm.fetch_day date-integrity guard ────────────────

def _margn_tables(codes_lots, margin_money):
    """codes_lots: [(code, lots), ...]. margin_money: 融資金額(仟元) 字串."""
    rows = [[c, "", "", "", "", "", str(lots)] for c, lots in codes_lots]
    return [
        {"data": rows},
        {"data": [["融資金額(仟元)合計", "", "", margin_money]]},
    ]


def _mindex_tables(codes_closes):
    fields = ["證券代號", "證券名稱", "收盤價"]
    data = [[c, "name", str(px)] for c, px in codes_closes]
    return [{"fields": fields, "data": data}]


class MarginRatioMmDateGuardTests(unittest.TestCase):
    YMD_ISO = "2025-09-24"
    YMD = "20250924"

    def _fake_get_json(self, mg_date="__match__", px_date="__match__",
                        mg_has_date=True, px_has_date=True):
        codes_lots = [("2330", 100), ("0050", 50)]
        codes_closes = [("2330", 500), ("0050", 100)]
        margn = {"stat": "OK", "tables": _margn_tables(codes_lots, "1000000")}
        if mg_has_date:
            margn["date"] = self.YMD if mg_date == "__match__" else mg_date
        mindex = {"stat": "OK", "tables": _mindex_tables(codes_closes)}
        if px_has_date:
            mindex["date"] = self.YMD if px_date == "__match__" else px_date

        def fake(url, params, tries=4):
            if url == mm.MARGN:
                return margn
            if url == mm.MINDEX:
                return mindex
            raise AssertionError(f"unexpected url {url}")
        return fake

    def test_same_day_response_produces_a_row(self):
        with patch.object(mm, "get_json", side_effect=self._fake_get_json()), \
             patch.object(mm.time, "sleep"):
            row = mm.fetch_day(self.YMD_ISO)
        self.assertIsNotNone(row)
        self.assertEqual(row["date"], self.YMD_ISO)

    def test_mi_margn_wrong_date_rejected(self):
        with patch.object(mm, "get_json", side_effect=self._fake_get_json(mg_date="20250101")), \
             patch.object(mm.time, "sleep"):
            row = mm.fetch_day(self.YMD_ISO)
        self.assertIsNone(row)

    def test_mi_index_wrong_date_rejected(self):
        with patch.object(mm, "get_json", side_effect=self._fake_get_json(px_date="20250101")), \
             patch.object(mm.time, "sleep"):
            row = mm.fetch_day(self.YMD_ISO)
        self.assertIsNone(row)

    def test_mi_margn_missing_date_field_rejected(self):
        with patch.object(mm, "get_json", side_effect=self._fake_get_json(mg_has_date=False)), \
             patch.object(mm.time, "sleep"):
            row = mm.fetch_day(self.YMD_ISO)
        self.assertIsNone(row)

    def test_mi_index_missing_date_field_rejected(self):
        with patch.object(mm, "get_json", side_effect=self._fake_get_json(px_has_date=False)), \
             patch.object(mm.time, "sleep"):
            row = mm.fetch_day(self.YMD_ISO)
        self.assertIsNone(row)


# ── N2a: fetch_twse_mktcap.ensure_weekly_snapshot count-drop guard ──────────

class EnsureWeeklySnapshotGuardTests(unittest.TestCase):
    def _write_snapshots(self, path: Path, snapshots):
        path.write_text(json.dumps({"snapshots": snapshots}))

    def test_existing_1000_new_1_code_rejected_file_untouched(self):
        old_shares = {f"S{i}": 1.0 for i in range(1000)}
        with tempfile.TemporaryDirectory() as d:
            shares_out = Path(d) / "snap.json"
            self._write_snapshots(shares_out, [{"date": "2020-01-01", "shares": old_shares}])
            before = shares_out.read_text()
            with patch.object(mktcap, "SHARES_OUT", shares_out), \
                 patch.object(mktcap, "fetch_shares", return_value={"S1": 1.0}):
                result = mktcap.ensure_weekly_snapshot()
            self.assertEqual(len(result), 1)
            self.assertEqual(shares_out.read_text(), before)

    def test_existing_1000_new_950_codes_accepted(self):
        old_shares = {f"S{i}": 1.0 for i in range(1000)}
        new_shares = {f"S{i}": 1.0 for i in range(950)}
        with tempfile.TemporaryDirectory() as d:
            shares_out = Path(d) / "snap.json"
            self._write_snapshots(shares_out, [{"date": "2020-01-01", "shares": old_shares}])
            with patch.object(mktcap, "SHARES_OUT", shares_out), \
                 patch.object(mktcap, "fetch_shares", return_value=new_shares):
                result = mktcap.ensure_weekly_snapshot()
            self.assertEqual(len(result), 2)
            on_disk = json.loads(shares_out.read_text())
            self.assertEqual(len(on_disk["snapshots"]), 2)

    def test_no_existing_snapshot_799_codes_rejected(self):
        new_shares = {f"S{i}": 1.0 for i in range(799)}
        with tempfile.TemporaryDirectory() as d:
            shares_out = Path(d) / "snap.json"
            with patch.object(mktcap, "SHARES_OUT", shares_out), \
                 patch.object(mktcap, "fetch_shares", return_value=new_shares):
                result = mktcap.ensure_weekly_snapshot()
            self.assertEqual(result, [])
            self.assertFalse(shares_out.exists())

    def test_no_existing_snapshot_800_codes_accepted(self):
        new_shares = {f"S{i}": 1.0 for i in range(800)}
        with tempfile.TemporaryDirectory() as d:
            shares_out = Path(d) / "snap.json"
            with patch.object(mktcap, "SHARES_OUT", shares_out), \
                 patch.object(mktcap, "fetch_shares", return_value=new_shares):
                result = mktcap.ensure_weekly_snapshot()
            self.assertEqual(len(result), 1)
            self.assertTrue(shares_out.exists())


# ── N2b: fetch_twse_mktcap.fetch_day match-ratio guard ──────────────────────

class FetchDayMatchRatioGuardTests(unittest.TestCase):
    def _snapshot(self, n):
        return {"date": "2025-01-01", "shares": {f"S{i}": 1.0 for i in range(n)}}

    def test_89_percent_match_rejected(self):
        snap = self._snapshot(100)
        closes = {f"S{i}": 10.0 for i in range(89)}  # 89/100 = 89% < 90%
        with patch.object(mktcap, "fetch_close", return_value=closes):
            row = mktcap.fetch_day("2025-01-02", [snap])
        self.assertIsNone(row)

    def test_90_percent_match_accepted(self):
        snap = self._snapshot(100)
        closes = {f"S{i}": 10.0 for i in range(90)}  # 90/100 = 90% >= 90%
        with patch.object(mktcap, "fetch_close", return_value=closes):
            row = mktcap.fetch_day("2025-01-02", [snap])
        self.assertIsNotNone(row)
        self.assertEqual(row["n"], 90)

    def test_rejected_day_leaves_output_untouched_via_main(self):
        """Integration-level check: a rejected day must not get written to
        data/twse_mktcap.json, and missing_trading_days will retry it next run
        because by_date is keyed on days that were actually written. (save()
        always rewrites the 'updated' timestamp, so we compare the `data`
        rows, not the raw bytes.)"""
        snap = self._snapshot(100)
        closes = {f"S{i}": 10.0 for i in range(50)}  # well under 90%
        existing_row = {"date": "2024-12-31", "mktcap_yi": 1.0,
                         "mktcap_exetf_yi": 1.0, "n": 100, "n_etf": 0,
                         "shares_snapshot_date": "2024-12-01"}
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "mktcap.json"
            out.write_text(json.dumps({"data": [existing_row]}))
            with patch.object(mktcap, "OUT", out), \
                 patch.object(mktcap, "ensure_weekly_snapshot", return_value=[snap]), \
                 patch.object(mktcap, "ONLY", ["2025-01-02"]), \
                 patch.object(mktcap, "fetch_close", return_value=closes), \
                 patch.object(mktcap.time, "sleep"):
                mktcap.main()
            after = json.loads(out.read_text())
            self.assertEqual(after["data"], [existing_row])


if __name__ == "__main__":
    unittest.main()
