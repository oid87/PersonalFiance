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


class GetFredApiKeyTests(unittest.TestCase):
    def test_env_wins(self):
        with tempfile.TemporaryDirectory() as d, \
                patch.object(_common, "ROOT", Path(d)), \
                patch.dict(os.environ, {"FRED_API_KEY": " envkey "}):
            self.assertEqual(_common.get_fred_api_key(), "envkey")

    def test_repo_root_file_used_when_no_env(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / ".fred_api_key").write_text("repokey\n")
            with patch.object(_common, "ROOT", root), \
                    patch.dict(os.environ, {}, clear=True):
                self.assertEqual(_common.get_fred_api_key(), "repokey")

    def test_empty_string_env_treated_as_missing(self):
        # A GitHub secret that isn't set still comes through as env="" (not unset) —
        # that must fall back the same as a genuinely absent key, not be used as one.
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            with patch.object(_common, "ROOT", root), \
                    patch.dict(os.environ, {"FRED_API_KEY": ""}):
                self.assertIsNone(_common.get_fred_api_key())

    def test_all_missing_returns_none(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            with patch.object(_common, "ROOT", root), \
                    patch.dict(os.environ, {}, clear=True):
                self.assertIsNone(_common.get_fred_api_key())


class FredCsvTextTests(unittest.TestCase):
    def test_no_key_hits_fredgraph_csv(self):
        csv_text = "observation_date,MYID\n2020-01-01,1.5\n"
        with tempfile.TemporaryDirectory() as d, \
                patch.object(_common, "ROOT", Path(d)), \
                patch.dict(os.environ, {}, clear=True), \
                patch("_common.requests.get", return_value=_fake_response(csv_text)) as mock_get:
            text = _common.fred_csv_text("MYID", headers={"User-Agent": "x"})
        self.assertEqual(text, csv_text)
        args, kwargs = mock_get.call_args
        self.assertIn("fred.stlouisfed.org/graph/fredgraph.csv?id=MYID", args[0])
        self.assertEqual(kwargs["headers"], {"User-Agent": "x"})

    def test_with_key_hits_official_api_with_file_type_json(self):
        payload = {"observations": [
            {"date": "2020-01-01", "value": "1.5"},
            {"date": "2020-01-02", "value": "."},
        ]}
        resp = MagicMock()
        resp.raise_for_status = MagicMock()
        resp.json = MagicMock(return_value=payload)
        with tempfile.TemporaryDirectory() as d, \
                patch.object(_common, "ROOT", Path(d)), \
                patch.dict(os.environ, {"FRED_API_KEY": "secretkey123"}), \
                patch("_common.requests.get", return_value=resp) as mock_get:
            text = _common.fred_csv_text("MYID", headers={"User-Agent": "x"})
        args, kwargs = mock_get.call_args
        self.assertIn("api.stlouisfed.org/fred/series/observations", args[0])
        self.assertIn("file_type=json", args[0])
        self.assertIn("series_id=MYID", args[0])
        self.assertIn("api_key=secretkey123", args[0])
        self.assertEqual(text, "observation_date,MYID\n2020-01-01,1.5\n2020-01-02,.\n")

    def test_json_result_equivalent_to_csv_result_via_fetch_fred_csv(self):
        """fetch_fred_csv() built on top of the JSON path (with key) must produce the
        exact same [(date, value), ...] as the CSV path (no key) for equivalent input,
        including skipping "." missing observations."""
        csv_text = (
            "observation_date,MYID\n"
            "2020-01-01,1.5\n"
            "2020-01-02,.\n"
            "2020-01-03,2.25\n"
        )
        with tempfile.TemporaryDirectory() as d, \
                patch.object(_common, "ROOT", Path(d)), \
                patch.dict(os.environ, {}, clear=True), \
                patch("_common.requests.get", return_value=_fake_response(csv_text)):
            csv_rows = _common.fetch_fred_csv("MYID", headers={})

        payload = {"observations": [
            {"date": "2020-01-01", "value": "1.5"},
            {"date": "2020-01-02", "value": "."},
            {"date": "2020-01-03", "value": "2.25"},
        ]}
        resp = MagicMock()
        resp.raise_for_status = MagicMock()
        resp.json = MagicMock(return_value=payload)
        with tempfile.TemporaryDirectory() as d, \
                patch.object(_common, "ROOT", Path(d)), \
                patch.dict(os.environ, {"FRED_API_KEY": "secretkey123"}), \
                patch("_common.requests.get", return_value=resp):
            json_rows = _common.fetch_fred_csv("MYID", headers={})

        self.assertEqual(csv_rows, json_rows)
        self.assertEqual(csv_rows, [("2020-01-01", 1.5), ("2020-01-03", 2.25)])

    def test_api_error_message_does_not_contain_key(self):
        import requests as requests_module

        resp = MagicMock()
        resp.status_code = 400
        http_err = requests_module.exceptions.HTTPError(
            "400 Client Error: Bad Request for url: "
            "https://api.stlouisfed.org/fred/series/observations?series_id=MYID"
            "&api_key=secretkey123&file_type=json"
        )
        http_err.response = resp

        def _raise():
            raise http_err

        fake_resp = MagicMock()
        fake_resp.raise_for_status = MagicMock(side_effect=_raise)
        with tempfile.TemporaryDirectory() as d, \
                patch.object(_common, "ROOT", Path(d)), \
                patch.dict(os.environ, {"FRED_API_KEY": "secretkey123"}), \
                patch("_common.requests.get", return_value=fake_resp):
            with self.assertRaises(_common.FredApiError) as ctx:
                _common.fred_csv_text("MYID", headers={})
        self.assertNotIn("secretkey123", str(ctx.exception))


class IdempotentMergeTests(unittest.TestCase):
    def test_missing_file_starts_from_empty(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "nope.json"
            merged = _common.idempotent_merge(path, [{"date": "2020-01-02", "v": 2}])
        self.assertEqual(merged, [{"date": "2020-01-02", "v": 2}])

    def test_corrupt_json_starts_from_empty(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "bad.json"
            path.write_text("{not json")
            merged = _common.idempotent_merge(path, [{"date": "2020-01-01", "v": 1}])
        self.assertEqual(merged, [{"date": "2020-01-01", "v": 1}])

    def test_new_overwrites_old_and_sorts_by_key(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "data.json"
            path.write_text(json.dumps({"data": [
                {"date": "2020-01-01", "v": 1},
                {"date": "2020-01-03", "v": 3},
            ]}))
            merged = _common.idempotent_merge(path, [
                {"date": "2020-01-02", "v": 20},
                {"date": "2020-01-01", "v": 100},  # overwrites existing 2020-01-01
            ])
        self.assertEqual(merged, [
            {"date": "2020-01-01", "v": 100},
            {"date": "2020-01-02", "v": 20},
            {"date": "2020-01-03", "v": 3},
        ])

    def test_non_date_key_field(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "data.json"
            path.write_text(json.dumps({"data": [{"series_id": "B", "v": 1}]}))
            merged = _common.idempotent_merge(
                path, [{"series_id": "A", "v": 2}], key_field="series_id",
            )
        self.assertEqual(merged, [{"series_id": "A", "v": 2}, {"series_id": "B", "v": 1}])

    def test_row_missing_key_field_raises_and_keeps_earlier_rows_out_of_result(self):
        # Matches the old inline idempotent_merge()'s behavior: existing[r[key_field]]
        # raises KeyError as soon as a new_row lacks key_field, aborting the merge —
        # rows processed before the bad one are accumulated into the local `existing`
        # dict, but that dict is never returned because the exception propagates.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "data.json"
            path.write_text(json.dumps({"data": [{"date": "2020-01-01", "v": 1}]}))
            with self.assertRaises(KeyError):
                _common.idempotent_merge(path, [
                    {"date": "2020-01-02", "v": 2},  # processed fine
                    {"v": 99},                        # missing "date" -> KeyError
                    {"date": "2020-01-03", "v": 3},   # never reached
                ])


if __name__ == "__main__":
    unittest.main()
