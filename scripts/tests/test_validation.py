"""Synthetic corruption cases for the read-only product data guard."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
import subprocess

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from validate_data import validate_directory, validate_object
from source_contracts import stock_stems

ROOT = Path(__file__).resolve().parents[2]


class ValidationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name) / "data"
        self.data.mkdir()

    def write(self, name, rows, **meta):
        (self.data / name).write_text(json.dumps({"updated": "2026-09-30", "data": rows, **meta}))

    def errors(self):
        return validate_directory(self.data, macro=False, allow_partial=True)[1]

    def full_stock_fixture(self):
        stems = stock_stems(ROOT)
        self.assertEqual(len(stems), 41)
        for stem in stems:
            self.write(f'{stem}.json', [{"date": "2026-09-30", "open": 1, "high": 2,
                                        "low": 1, "close": 1.5, "volume": 10}])
        return stems

    def test_bad_date_unsorted_duplicate_and_null_close(self):
        self.write("SPY.json", [
            {"date": "2026-09-30", "open": 1, "high": 2, "low": 1, "close": 1, "volume": 10},
            {"date": "2026-09-31", "open": 1, "high": 2, "low": 1, "close": 1, "volume": 10},
            {"date": "2026-09-29", "open": 1, "high": 2, "low": 1, "close": None, "volume": 10},
            {"date": "2026-09-29", "open": 1, "high": 2, "low": 1, "close": 1, "volume": 10},
        ])
        errors = '\n'.join(self.errors())
        for expected in ("invalid ISO date", "unsorted date", "required finite number", "duplicate key"):
            self.assertIn(expected, errors)

    def test_wrong_unit_metadata(self):
        self.write("margin_global_us.json", [{"date": "2026-09-30", "margin_balance": 100}], note="USD billions")
        self.assertIn("wrong unit metadata", '\n'.join(self.errors()))

    def test_shrink(self):
        baseline = Path(self.temp.name) / "baseline"
        baseline.mkdir()
        (baseline / "CAPE.json").write_text(json.dumps({"data": [{"date": f"2020-01-{i:02d}", "value": i} for i in range(1, 21)]}))
        self.write("CAPE.json", [{"date": "2020-01-01", "value": 1}])
        errors = validate_directory(self.data, baseline_dir=baseline, macro=False, allow_partial=True)[1]
        self.assertIn("row count collapsed", '\n'.join(errors))

    def test_contract_rejects_missing_date_nonobject_and_mixed_rows(self):
        contract = {"profile": "ohlcv", "key_fields": ["date"],
                    "required_fields": ["date", "close"]}
        for data, expected in [
            ([{"close": 10}], "required non-null field"),
            ([7], "expected object"),
            ([{"date": "2026-09-30", "close": 10}, {"close": 11}], "date must be an ISO string"),
        ]:
            with self.subTest(data=data):
                failures = []
                validate_object({"data": data}, "synthetic.json", failures, contract)
                self.assertIn(expected, '\n'.join(failures))

    def test_invalid_composite_key_type_and_empty_policy(self):
        contract = {"profile": "dated_rows", "key_fields": ["date", "ticker"],
                    "required_fields": ["date", "ticker"]}
        failures = []
        validate_object({"data": [{"date": "2026-09-30", "ticker": ["SPY"]}]},
                        "synthetic.json", failures, contract)
        self.assertIn("key must be a nonempty string", '\n'.join(failures))
        failures = []
        validate_object({"data": []}, "synthetic.json", failures, contract)
        self.assertIn("required data rows are empty", '\n'.join(failures))
        failures = []
        validate_object({"data": []}, "synthetic.json", failures, dict(contract, allow_empty=True))
        self.assertEqual(failures, [])

    def test_full_stock_contracts_and_known_filename_shape(self):
        self.full_stock_fixture()
        self.assertEqual(validate_directory(self.data, macro=False)[1], [])
        self.write('QQQ.json', [{"close": "invalid"}])
        errors = '\n'.join(validate_directory(self.data, macro=False)[1])
        self.assertIn('QQQ.json.data[0].date', errors)
        self.assertIn('QQQ.json.data[0].close: required finite number', errors)

    def test_missing_required_stock_and_explicit_partial_fixture(self):
        self.full_stock_fixture()
        (self.data / 'SP500.json').unlink()
        self.assertIn('SP500.json: required stock output missing', '\n'.join(validate_directory(self.data, macro=False)[1]))
        self.assertEqual(validate_directory(self.data, macro=False, allow_partial=True)[1], [])
        self.write('QQQ.json', [{"close": "invalid"}])
        self.assertIn('QQQ.json.data[0].date', '\n'.join(validate_directory(self.data, macro=False, allow_partial=True)[1]))

    def test_empty_absent_and_unknown_nonstock(self):
        self.assertIn('no root JSON files', '\n'.join(validate_directory(self.data, macro=False)[1]))
        self.assertIn('does not exist', '\n'.join(validate_directory(self.data / 'missing', macro=False, allow_partial=True)[1]))
        (self.data / 'unknown_nonstock.json').write_text(json.dumps({'data': [{'date': '2026-09-30', 'open': 1}]}))
        self.assertEqual(validate_directory(self.data, macro=False, allow_partial=True)[1], [])

    def test_baseline_deleted_file_fails_even_in_partial_mode(self):
        baseline = Path(self.temp.name) / 'baseline'
        baseline.mkdir()
        self.write('QQQ.json', [{"date": "2026-09-30", "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 10}])
        (baseline / 'QQQ.json').write_bytes((self.data / 'QQQ.json').read_bytes())
        (baseline / 'custom_optional.json').write_text('{"data": []}')
        errors = '\n'.join(validate_directory(self.data, baseline_dir=baseline, macro=False, allow_partial=True)[1])
        self.assertIn('custom_optional.json: missing from current data', errors)

    def test_cli_full_and_partial_modes(self):
        self.write('QQQ.json', [{"date": "2026-09-30", "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 10}])
        command = [sys.executable, str(ROOT / 'scripts/validate_data.py'), '--data-dir', str(self.data), '--no-shrink']
        self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)
        self.assertEqual(subprocess.run(command + ['--allow-partial'], capture_output=True).returncode, 0)


if __name__ == '__main__':
    unittest.main()
