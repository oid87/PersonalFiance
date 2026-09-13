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


cftc = load("fetch_cftc_positions")
cboe = load("fetch_cboe_putcall")
aaii = load("fetch_aaii")


class CftcTests(unittest.TestCase):
    HEADER = ("CFTC_Contract_Market_Code,FutOnly_or_Combined,Report_Date_as_YYYY-MM-DD,"
              "Lev_Money_Positions_Long_All,Lev_Money_Positions_Short_All,"
              "Asset_Mgr_Positions_Long_All,Asset_Mgr_Positions_Short_All,Open_Interest_All\n")

    def line(self, code, day="2026-09-08", long=10, short=4):
        return f"{code},FutOnly,{day},{long},{short},8,3,100\n"

    def test_exact_code_excludes_micro_and_preserves_contracts_on_same_date(self):
        data = cftc.parse_cftc_csv(self.HEADER + self.line("13874+") + self.line("13874A") + self.line("20974+"))
        self.assertEqual([r["lev_net"] for r in data["sp500"]], [6])
        self.assertEqual([r["lev_net"] for r in data["nasdaq100"]], [6])

    def test_rolling_minmax_has_no_lookahead_and_zero_range_is_null(self):
        rows = [{"date": f"2020-{i // 28 + 1:02d}-{i % 28 + 1:02d}", "lev_net": i} for i in range(156)]
        indexed = cftc.add_cot_index(rows)
        self.assertIsNone(indexed[154]["cot_index_3y"])
        self.assertEqual(indexed[155]["cot_index_3y"], 100.0)
        flat = cftc.add_cot_index([{**r, "lev_net": 7} for r in rows])
        self.assertIsNone(flat[-1]["cot_index_3y"])

    def test_incomplete_history_year_is_retried(self):
        from datetime import date
        old = {"completed_years": [2022, 2024, 2025, 2026]}
        self.assertEqual(cftc.years_to_fetch(old, date(2026, 9, 13)), [2023, 2026])

    def test_empty_success_response_cannot_mark_cache_fresh(self):
        old_row = {"date": "2026-09-01", "lev_long": 10, "lev_short": 4, "lev_net": 6,
                   "am_long": 8, "am_short": 3, "am_net": 5, "open_interest": 100}
        old = {"instruments": [{"id": "sp500", "rows": [old_row]}], "completed_years": [2022, 2023, 2024, 2025, 2026]}
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "cftc.json"
            output.write_text(json.dumps(old))
            with patch.object(cftc, "OUT", output), patch.object(cftc, "_fetch_year", return_value=self.HEADER):
                cftc.main()
            actual = json.loads(output.read_text())
            self.assertEqual(actual["status"], "stale")
            self.assertEqual(actual["instruments"][0]["rows"][0]["lev_net"], 6)
            self.assertIn("missing index records", actual["error"])

    def test_invalid_counts_rejected(self):
        with self.assertRaises(ValueError):
            cftc.parse_cftc_csv(self.HEADER + self.line("13874+", long=-1))

    def test_failed_refresh_retains_cached_instrument_rows(self):
        old_row = {"date": "2026-09-01", "lev_long": 10, "lev_short": 4, "lev_net": 6,
                   "am_long": 8, "am_short": 3, "am_net": 5, "open_interest": 100,
                   "cot_index_3y": None}
        existing = {"instruments": [{"id": "sp500", "rows": [old_row]}]}
        merged = cftc.merge_instruments(existing, {})
        self.assertEqual(merged[0]["rows"], [old_row])


class CboeTests(unittest.TestCase):
    PAGE = r'''{"data":{"optionsData":{"ratios":[
      {"name":"TOTAL PUT/CALL RATIO","value":"0.86"},
      {"name":"INDEX PUT/CALL RATIO","value":"1.06"},
      {"name":"EQUITY PUT/CALL RATIO","value":"0.58"},
      {"name":"SPX + SPXW PUT/CALL RATIO","value":"1.23"}]},
      "selectedDate":"2026-09-11","prevTradingDay":"2026-09-11"}}'''

    def test_exact_ratio_fields(self):
        row = cboe.parse_cboe_html(self.PAGE, "2026-09-11")
        self.assertEqual(row, {"date": "2026-09-11", "equity_pc": .58, "spx_pc": 1.23, "total_pc": .86, "index_pc": 1.06})

    def test_requested_fallback_date_refused(self):
        with self.assertRaisesRegex(ValueError, "returned 2026-09-11"):
            cboe.parse_cboe_html(self.PAGE, "2026-09-12")

    def test_partial_ratio_schema_is_error_not_holiday(self):
        malformed = self.PAGE.replace("EQUITY PUT/CALL RATIO", "CHANGED FIELD")
        with self.assertRaises(ValueError) as caught:
            cboe.parse_cboe_html(malformed, "2026-09-11")
        self.assertNotIsInstance(caught.exception, cboe.NoDataError)

    def test_merge_failure_retains_old(self):
        old = [{"date": "2026-09-10", "equity_pc": .7, "spx_pc": 1.1, "total_pc": .8, "index_pc": 1.0}]
        self.assertEqual(cboe.merge_rows(old, []), old)


class AaiiTests(unittest.TestCase):
    def test_spread_uses_rounded_components(self):
        row = aaii._row("2026-09-10", 40.76, 20.04, 30.34)
        self.assertEqual((row["bull"], row["bear"], row["spread"]), (40.8, 30.3, 10.5))


if __name__ == "__main__":
    unittest.main()
