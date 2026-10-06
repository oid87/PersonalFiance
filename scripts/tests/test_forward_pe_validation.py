import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from validate_data import validate_forward_pe, validate_forward_pe_rows


class ForwardPEValidationTest(unittest.TestCase):
    def test_bad_line_and_invalid_coverage(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "forward_pe_qqq.jsonl"
            good = {"date": "2026-09-30", "ticker": "QQQ", "price_asof": "2026-09-29",
                    "forward_pe": 20, "forward_pe_fy2": 20, "forward_pe_ntm": 20,
                    "coverage_fy2": 0.96, "coverage_ntm": 0.96,
                    "constituents_used_fy2": 90, "constituents_used_ntm": 90,
                    "constituents_total": 100, "valid_fy2": True, "valid_ntm": True, "valid": True}
            bad = dict(good, coverage_ntm=1.5, date="2026-09-29")
            path.write_text(json.dumps(good) + '\n{bad json\n' + json.dumps(bad) + '\n')
            errors = []
            validate_forward_pe(path, errors)
            message = '\n'.join(errors)
            self.assertIn('invalid JSONL', message)
            self.assertIn('unsorted date', message)
            self.assertIn('coverage_ntm', message)

    def test_malformed_coverage_and_key_types_accumulate_errors(self):
        entry = {"date": "2026-09-30", "ticker": "QQQ", "price_asof": "2026-09-29",
                 "forward_pe": 20, "forward_pe_fy2": 20, "forward_pe_ntm": 20,
                 "coverage_fy2": 0.96, "coverage_ntm": 0.96,
                 "constituents_used_fy2": 90, "constituents_used_ntm": 90,
                 "constituents_total": 100, "valid_fy2": True, "valid_ntm": True, "valid": True}
        rows = [dict(entry, coverage_fy2=None),
                dict(entry, date="2026-10-01", coverage_fy2="0.96", price_asof=["2026-09-30"]),
                dict(entry, date="2026-10-02", ticker=["QQQ"], coverage_ntm=False)]
        failures = []
        validate_forward_pe_rows(rows, "forward_pe_qqq.jsonl", failures)
        message = '\n'.join(failures)
        self.assertIn('coverage_fy2', message)
        self.assertIn('price_asof', message)
        self.assertIn('ticker/path mismatch', message)

    def test_cli_reports_malformed_coverage_without_traceback(self):
        with tempfile.TemporaryDirectory() as temp:
            data = Path(temp)
            row = {"date": "2026-09-30", "ticker": "QQQ", "price_asof": "2026-09-29",
                   "forward_pe": 20, "forward_pe_fy2": 20, "forward_pe_ntm": 20,
                   "coverage_fy2": None, "coverage_ntm": "bad",
                   "constituents_used_fy2": 90, "constituents_used_ntm": 90,
                   "constituents_total": 100, "valid_fy2": True, "valid_ntm": True, "valid": True}
            (data / "forward_pe_qqq.jsonl").write_text(json.dumps(row) + '\n')
            script = Path(__file__).resolve().parents[1] / 'validate_data.py'
            result = subprocess.run([sys.executable, str(script), '--data-dir', str(data), '--no-shrink'],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn('coverage_fy2', result.stdout)
            self.assertNotIn('Traceback', result.stderr)


if __name__ == '__main__':
    unittest.main()
