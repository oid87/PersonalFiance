"""Offline unit tests for scripts/fetch_finra_short.py's pure parsing functions.
No network access."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fetch_finra_short import parse_shortvol_text, parse_short_interest  # noqa: E402


class TestParseShortvolText(unittest.TestCase):
    def test_only_spy_qqq_kept_and_values_rounded(self):
        text = (
            "Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market\n"
            "20260925|SPY|6373542.318262|6303|12170952.290403|B,Q,N\n"
            "20260925|QQQ|6030070.440289|12244|10451204.556374|B,Q,N\n"
            "20260925|AAPL|1234567.5|100|2000000.4|B,Q,N\n"
        )
        result = parse_shortvol_text(text)
        self.assertEqual(set(result.keys()), {"SPY", "QQQ"})
        self.assertEqual(result["SPY"], {"sv": 6373542, "tv": 12170952})
        self.assertEqual(result["QQQ"], {"sv": 6030070, "tv": 10451205})
        # values must be plain ints (rounded), not floats
        self.assertIsInstance(result["SPY"]["sv"], int)
        self.assertIsInstance(result["SPY"]["tv"], int)

    def test_missing_symbol_absent_from_result(self):
        text = (
            "Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market\n"
            "20260925|SPY|6373542.318262|6303|12170952.290403|B,Q,N\n"
        )
        result = parse_shortvol_text(text)
        self.assertEqual(set(result.keys()), {"SPY"})
        self.assertNotIn("QQQ", result)

    def test_empty_text_returns_empty_dict(self):
        self.assertEqual(parse_shortvol_text(""), {})

    def test_header_only_returns_empty_dict(self):
        text = "Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market\n"
        self.assertEqual(parse_shortvol_text(text), {})

    def test_malformed_row_skipped(self):
        text = (
            "Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market\n"
            "20260925|SPY|not_a_number|6303|12170952.290403|B,Q,N\n"
            "20260925|QQQ|6030070.440289|12244|10451204.556374|B,Q,N\n"
        )
        result = parse_shortvol_text(text)
        self.assertNotIn("SPY", result)
        self.assertIn("QQQ", result)


class TestParseShortInterest(unittest.TestCase):
    def test_sorted_output_and_null_fill_for_missing_symbol(self):
        rows_spy = [
            {"settlementDate": "2020-04-30", "currentShortPositionQuantity": 200000000, "daysToCoverQuantity": 1.6},
            {"settlementDate": "2020-04-15", "currentShortPositionQuantity": 226045276, "daysToCoverQuantity": 1.52},
        ]
        rows_qqq = [
            {"settlementDate": "2020-04-15", "currentShortPositionQuantity": 50000000, "daysToCoverQuantity": 2.1},
            # no QQQ record for 2020-04-30
        ]
        result = parse_short_interest(rows_spy, rows_qqq)
        dates = [r["date"] for r in result]
        self.assertEqual(dates, sorted(dates))
        self.assertEqual(dates, ["2020-04-15", "2020-04-30"])

        row_0415 = result[0]
        self.assertEqual(row_0415["SPY_si"], 226045276)
        self.assertEqual(row_0415["SPY_dtc"], 1.52)
        self.assertEqual(row_0415["QQQ_si"], 50000000)
        self.assertEqual(row_0415["QQQ_dtc"], 2.1)

        row_0430 = result[1]
        self.assertEqual(row_0430["SPY_si"], 200000000)
        self.assertIsNone(row_0430["QQQ_si"])
        self.assertIsNone(row_0430["QQQ_dtc"])

    def test_empty_inputs_return_empty_list(self):
        self.assertEqual(parse_short_interest([], []), [])

    def test_rows_missing_settlement_date_are_skipped(self):
        rows_spy = [{"currentShortPositionQuantity": 100, "daysToCoverQuantity": 1.0}]
        result = parse_short_interest(rows_spy, [])
        self.assertEqual(result, [])


if __name__ == "__main__":
    unittest.main()
