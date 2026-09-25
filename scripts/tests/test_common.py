"""Offline unit tests for scripts/_common.py (no network calls)."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

SCRIPTS = Path(__file__).resolve().parents[1]
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import _common  # noqa: E402


def _fake_response(text: str):
    resp = MagicMock()
    resp.text = text
    resp.raise_for_status = MagicMock()
    return resp


class FetchFredCsvTests(unittest.TestCase):
    def test_normal_rows_ascending_order_and_headers_passed(self):
        csv_text = (
            "observation_date,MYID\n"
            "2020-02-01,2.5\n"
            "2020-01-01,1.5\n"
        )
        with patch("_common.requests.get", return_value=_fake_response(csv_text)) as mock_get:
            rows = _common.fetch_fred_csv("MYID", headers={"User-Agent": "x"})
        self.assertEqual(rows, [("2020-01-01", 1.5), ("2020-02-01", 2.5)])
        _, kwargs = mock_get.call_args
        self.assertEqual(kwargs["headers"], {"User-Agent": "x"})
        self.assertEqual(kwargs["timeout"], 30)

    def test_skips_dot_and_empty_values(self):
        csv_text = (
            "observation_date,MYID\n"
            "2020-01-01,.\n"
            "2020-01-02,\n"
            "2020-01-03,3.0\n"
        )
        with patch("_common.requests.get", return_value=_fake_response(csv_text)):
            rows = _common.fetch_fred_csv("MYID", headers={})
        self.assertEqual(rows, [("2020-01-03", 3.0)])

    def test_skips_non_numeric_value(self):
        csv_text = "observation_date,MYID\n2020-01-01,abc\n2020-01-02,4.0\n"
        with patch("_common.requests.get", return_value=_fake_response(csv_text)):
            rows = _common.fetch_fred_csv("MYID", headers={})
        self.assertEqual(rows, [("2020-01-02", 4.0)])

    def test_date_column_fallback_to_DATE(self):
        csv_text = "DATE,MYID\n2020-01-01,5.0\n"
        with patch("_common.requests.get", return_value=_fake_response(csv_text)):
            rows = _common.fetch_fred_csv("MYID", headers={})
        self.assertEqual(rows, [("2020-01-01", 5.0)])

    def test_not_rounded(self):
        csv_text = "observation_date,MYID\n2020-01-01,1.23456789\n"
        with patch("_common.requests.get", return_value=_fake_response(csv_text)):
            rows = _common.fetch_fred_csv("MYID", headers={})
        self.assertEqual(rows[0][1], 1.23456789)

    def test_timeout_passed_through(self):
        csv_text = "observation_date,MYID\n2020-01-01,1.0\n"
        with patch("_common.requests.get", return_value=_fake_response(csv_text)) as mock_get:
            _common.fetch_fred_csv("MYID", headers={}, timeout=60)
        self.assertEqual(mock_get.call_args.kwargs["timeout"], 60)


class LoadRowsByDateTests(unittest.TestCase):
    def test_missing_file_returns_empty(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "nope.json"
            self.assertEqual(_common.load_rows_by_date(path), {})

    def test_corrupt_json_returns_empty(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "bad.json"
            path.write_text("{not json")
            self.assertEqual(_common.load_rows_by_date(path), {})

    def test_rows_without_date_are_skipped(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "data.json"
            path.write_text(json.dumps({"data": [
                {"date": "2020-01-02", "v": 2},
                {"v": 99},
                {"date": "2020-01-01", "v": 1},
            ]}))
            rows = _common.load_rows_by_date(path)
        self.assertEqual(list(rows.keys()), ["2020-01-02", "2020-01-01"])

    def test_normal_case_preserves_file_order(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "data.json"
            path.write_text(json.dumps({"data": [
                {"date": "2020-01-01", "v": 1},
                {"date": "2020-01-02", "v": 2},
            ]}))
            rows = _common.load_rows_by_date(path)
        self.assertEqual(list(rows.items()), [
            ("2020-01-01", {"date": "2020-01-01", "v": 1}),
            ("2020-01-02", {"date": "2020-01-02", "v": 2}),
        ])


class GetFinmindTokenTests(unittest.TestCase):
    def test_env_wins(self):
        with tempfile.TemporaryDirectory() as d, \
                patch.object(_common, "ROOT", Path(d)), \
                patch.dict(os.environ, {"FINMIND_TOKEN": " envtok "}):
            self.assertEqual(_common.get_finmind_token(), "envtok")

    def test_repo_root_file_used_when_no_env(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / ".finmind_token").write_text("repotok\n")
            with patch.object(_common, "ROOT", root), \
                    patch.dict(os.environ, {}, clear=True):
                self.assertEqual(_common.get_finmind_token(), "repotok")

    def test_sibling_financial_work_file_used_when_no_env_or_repo_file(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "PersonalFiance"
            root.mkdir()
            sibling = Path(d) / "Financial_work"
            sibling.mkdir()
            (sibling / ".finmind_token").write_text("siblingtok\n")
            with patch.object(_common, "ROOT", root), \
                    patch.dict(os.environ, {}, clear=True):
                self.assertEqual(_common.get_finmind_token(), "siblingtok")

    def test_all_missing_returns_empty_string(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "PersonalFiance"
            root.mkdir()
            with patch.object(_common, "ROOT", root), \
                    patch.dict(os.environ, {}, clear=True):
                self.assertEqual(_common.get_finmind_token(), "")


if __name__ == "__main__":
    unittest.main()
