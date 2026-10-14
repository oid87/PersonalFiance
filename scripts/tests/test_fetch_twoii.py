"""Offline unit tests for scripts/fetch_twoii.py (FinMind TPEx -> data/TWOII.json).
No network access: requests.get and time.sleep are patched, OUT points to a tempfile."""
from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import requests  # noqa: E402

import fetch_twoii  # noqa: E402


def raw(date, close=378.44, vol=1_025_006_123, **kw):
    r = {"date": date, "stock_id": "TPEx", "Trading_Volume": vol, "Trading_money": 1,
         "open": 401.651, "max": 401.652, "min": 378.2049, "close": close,
         "spread": -1.0, "Trading_turnover": 1}
    r.update(kw)
    return r


def old_row(date, close=100.0, volume=5):
    return {"date": date, "open": 1.0, "high": 2.0, "low": 0.5, "close": close, "volume": volume}


class FakeResp:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload if payload is not None else {"status": 200, "msg": "success", "data": []}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.exceptions.HTTPError(f"{self.status_code} error", response=self)

    def json(self):
        return self._payload


def ok(data):
    return FakeResp(200, {"status": 200, "msg": "success", "data": data})


class TwoiiTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.out = Path(self.tmp.name) / "TWOII.json"
        for p in (mock.patch.object(fetch_twoii, "OUT", self.out),
                  mock.patch.object(fetch_twoii._common, "get_finmind_token", return_value="")):
            p.start()
            self.addCleanup(p.stop)
        sleep_patch = mock.patch("time.sleep")
        self.sleep = sleep_patch.start()
        self.addCleanup(sleep_patch.stop)

    def write_existing(self, rows):
        self.out.write_text(json.dumps({"symbol": "TWOII", "updated": "2026-09-15", "data": rows},
                                       ensure_ascii=False) + "\n")


class TestMapRows(unittest.TestCase):
    def test_field_mapping_units_and_rounding(self):
        rows = fetch_twoii.map_rows([raw("2026-07-17")])
        self.assertEqual(rows, [{
            "date": "2026-07-17", "open": 401.651, "high": 401.652, "low": 378.2049,
            "close": 378.44, "volume": 1_025_006,
        }])
        self.assertIsInstance(rows[0]["volume"], int)
        # four-decimal rounding
        r = fetch_twoii.map_rows([raw("2026-07-17", open=1.234567, max=2.345678,
                                      min=0.123449, close=1.99994)])[0]
        self.assertEqual((r["open"], r["high"], r["low"], r["close"]),
                         (1.2346, 2.3457, 0.1234, 1.9999))
        self.assertEqual(list(r), ["date", "open", "high", "low", "close", "volume"])

    def test_bad_close_rows_skipped(self):
        data = [
            raw("2026-07-20", close=0), raw("2026-07-21", close=-1.0),
            raw("2026-07-22", close=None), raw("2026-07-23", close=float("nan")),
            raw("2026-07-24", close=float("inf")), raw("2026-07-27", close="abc"),
            {"date": "2026-07-28", "open": 1, "max": 1, "min": 1},  # no close key
            raw("2026-07-29", close=380.0),
        ]
        rows = fetch_twoii.map_rows(data)
        self.assertEqual([r["date"] for r in rows], ["2026-07-29"])

    def test_bad_date_skipped(self):
        rows = fetch_twoii.map_rows([raw(None), raw("not-a-date"), raw("2026-07-29")])
        self.assertEqual([r["date"] for r in rows], ["2026-07-29"])

    def test_missing_volume_is_zero(self):
        self.assertEqual(fetch_twoii.map_rows([raw("2026-07-29", vol=None)])[0]["volume"], 0)

    def test_nonfinite_ohl_row_skipped_with_warning(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rows = fetch_twoii.map_rows([
                raw("2026-07-28", open=float("nan")), raw("2026-07-29", max=None),
                raw("2026-07-30", min="x"), raw("2026-07-31")])
        self.assertEqual([r["date"] for r in rows], ["2026-07-31"])
        out = buf.getvalue()
        self.assertIn("skipped 2026-07-28: non-finite open=nan", out)
        self.assertIn("skipped 2026-07-29: non-finite max=None", out)
        self.assertIn("skipped 2026-07-30: non-finite min='x'", out)

    def test_volume_parsing(self):
        m = lambda v: fetch_twoii.map_rows([raw("2026-07-29", vol=v)])[0]["volume"]
        self.assertEqual(m("1025006123.0"), 1_025_006)
        self.assertEqual(m(1_025_006_123.0), 1_025_006)
        self.assertEqual(m(float("nan")), 0)
        self.assertEqual(m(float("inf")), 0)
        self.assertEqual(m("abc"), 0)
        self.assertEqual(m(None), 0)
        self.assertIsInstance(m("1025006123.0"), int)

    def test_volume_warning_only_when_unparseable_or_nonfinite(self):
        def out(v):
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                fetch_twoii.map_rows([raw("2026-07-29", vol=v)])
            return buf.getvalue()
        self.assertIn("2026-07-29", out(float("nan")))
        self.assertIn("Trading_Volume", out("abc"))
        self.assertEqual(out(None), "")
        self.assertEqual(out(1_000_000), "")

    def test_non_strict_dates_skipped(self):
        rows = fetch_twoii.map_rows([raw("20260720"), raw("2026-7-20"), raw("2026-07-20T00:00:00"),
                                     raw("2026-02-30"), raw(20260720), raw("2026-07-21")])
        self.assertEqual([r["date"] for r in rows], ["2026-07-21"])


class TestMerge(unittest.TestCase):
    def test_new_overrides_old_sorted_unique(self):
        existing = [old_row("2026-07-01", 1), old_row("2026-07-03", 3), old_row("2026-07-02", 2)]
        new = [{"date": "2026-07-03", "open": 9, "high": 9, "low": 9, "close": 33, "volume": 7},
               old_row("2026-07-06", 6)]
        merged = fetch_twoii.merge(existing, new)
        self.assertEqual([r["date"] for r in merged],
                         ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-06"])
        self.assertEqual(merged[2]["close"], 33)   # overlap -> new value
        self.assertEqual(merged[0]["close"], 1)    # old-only date kept
        self.assertEqual(len({r["date"] for r in merged}), len(merged))


class TestMain(TwoiiTestBase):
    def run_main(self, side_effect):
        with mock.patch("requests.get", side_effect=side_effect) as g:
            fetch_twoii.main()
        return g

    def test_success_merges_and_payload_shape(self):
        self.write_existing([old_row("2026-07-01", 1), old_row("2026-07-16", 2), old_row("2026-07-17", 3),
                             old_row("2026-07-20", 4)])
        g = self.run_main([ok([raw("2026-07-17", close=378.44), raw("2026-07-20", close=380.5),
                               raw("2026-07-21", close=381.5)])])
        self.assertEqual(g.call_count, 1)
        text = self.out.read_text()
        self.assertTrue(text.endswith("\n"))
        self.assertEqual(text.count("\n"), 1)  # single-line JSON, no indent
        payload = json.loads(text)
        self.assertEqual(list(payload), ["symbol", "updated", "source", "volume_note", "data"])
        self.assertEqual(payload["symbol"], "TWOII")
        self.assertEqual(payload["source"], fetch_twoii.SOURCE)
        self.assertIn("2026-07-18", payload["source"])
        self.assertIn("//1000", payload["volume_note"])
        self.assertEqual([r["date"] for r in payload["data"]],
                         ["2026-07-01", "2026-07-16", "2026-07-17", "2026-07-20", "2026-07-21"])
        self.assertEqual(payload["data"][2], old_row("2026-07-17", 3))  # Yahoo-era row frozen
        self.assertEqual(payload["data"][3]["close"], 380.5)        # post-07-18 overlap: FinMind wins
        self.assertEqual(payload["data"][3]["volume"], 1_025_006)
        self.assertEqual(payload["data"][1], old_row("2026-07-16", 2))  # old-only row untouched
        self.assertEqual(payload["data"][4]["volume"], 1_025_006)

    def test_start_is_last_date_minus_14_days(self):
        self.write_existing([old_row("2026-07-01"), old_row("2026-07-17")])
        g = self.run_main([ok([raw("2026-07-20")])])
        params = g.call_args.kwargs["params"]
        self.assertEqual(params["start_date"], "2026-07-03")
        self.assertEqual(params["dataset"], "TaiwanStockPrice")
        self.assertEqual(params["data_id"], "TPEx")
        self.assertNotIn("token", params)  # anonymous when token is empty

    def test_token_passed_when_present(self):
        self.write_existing([old_row("2026-07-17")])
        with mock.patch.object(fetch_twoii._common, "get_finmind_token", return_value="T0K"):
            g = self.run_main([ok([raw("2026-07-20")])])
        self.assertEqual(g.call_args.kwargs["params"]["token"], "T0K")

    def test_bad_close_rows_not_written(self):
        self.write_existing([old_row("2026-07-17")])
        self.run_main([ok([raw("2026-07-20", close=0), raw("2026-07-21", close=None),
                           raw("2026-07-22", close=381.0)])])
        dates = [r["date"] for r in json.loads(self.out.read_text())["data"]]
        self.assertEqual(dates, ["2026-07-17", "2026-07-22"])

    def test_empty_response_raises_and_keeps_file(self):
        self.write_existing([old_row("2026-07-17")])
        before = self.out.read_bytes()
        with self.assertRaises(RuntimeError):
            self.run_main([ok([])])
        self.assertEqual(self.out.read_bytes(), before)

    def test_zero_rows_after_mapping_raises_and_keeps_file(self):
        self.write_existing([old_row("2026-07-17")])
        before = self.out.read_bytes()
        with self.assertRaises(RuntimeError):
            self.run_main([ok([raw("2026-07-20", close=0), raw("2026-07-21", close=None)])])
        self.assertEqual(self.out.read_bytes(), before)

    def test_missing_existing_file_raises_and_creates_nothing(self):
        with mock.patch("requests.get") as g:
            with self.assertRaises(RuntimeError):
                fetch_twoii.main()
        g.assert_not_called()
        self.assertFalse(self.out.exists())

    def test_empty_or_corrupt_existing_file_raises_untouched(self):
        for content in ('{"symbol": "TWOII", "data": []}\n', '{"symbol": "TWO'):
            self.out.write_text(content)
            with mock.patch("requests.get") as g:
                with self.assertRaises(RuntimeError):
                    fetch_twoii.main()
            g.assert_not_called()
            self.assertEqual(self.out.read_text(), content)

    def test_429_is_retried_then_succeeds(self):
        self.write_existing([old_row("2026-07-17")])
        g = self.run_main([FakeResp(429), FakeResp(503), ok([raw("2026-07-20")])])
        self.assertEqual(g.call_count, 3)
        self.assertEqual(json.loads(self.out.read_text())["data"][-1]["date"], "2026-07-20")

    def test_connection_error_is_retried(self):
        self.write_existing([old_row("2026-07-17")])
        g = self.run_main([requests.exceptions.ConnectionError("boom"),
                           requests.exceptions.Timeout("slow"), ok([raw("2026-07-20")])])
        self.assertEqual(g.call_count, 3)

    def test_persistent_429_raises_and_keeps_file(self):
        self.write_existing([old_row("2026-07-17")])
        before = self.out.read_bytes()
        with self.assertRaises(Exception) as cm:
            self.run_main([FakeResp(429)] * fetch_twoii.ATTEMPTS)
        self.assertIsInstance(cm.exception, fetch_twoii.RetryableFetchError)
        self.assertEqual(self.out.read_bytes(), before)

    def test_persistent_429_call_count_and_sleep_sequence(self):
        self.write_existing([old_row("2026-07-17")])
        with mock.patch("requests.get", side_effect=[FakeResp(429)] * 10) as g:
            with self.assertRaises(fetch_twoii.RetryableFetchError):
                fetch_twoii.main()
        self.assertEqual(g.call_count, fetch_twoii.ATTEMPTS)
        self.assertEqual([c.args[0] for c in self.sleep.call_args_list], [2, 4, 6])

    def test_status_600_not_retried(self):
        self.write_existing([old_row("2026-07-17")])
        before = self.out.read_bytes()
        with mock.patch("requests.get", side_effect=[FakeResp(600)] * 4) as g:
            with self.assertRaises(requests.exceptions.HTTPError):
                fetch_twoii.main()
        self.assertEqual(g.call_count, 1)
        bad = FakeResp(200, {"status": 600, "msg": "x", "data": []})
        with mock.patch("requests.get", side_effect=[bad] * 4) as g:
            with self.assertRaises(RuntimeError):
                fetch_twoii.main()
        self.assertEqual(g.call_count, 1)
        self.assertEqual(self.out.read_bytes(), before)
        self.sleep.assert_not_called()

    def test_5xx_payload_status_is_retried(self):
        self.write_existing([old_row("2026-07-17")])
        bad = FakeResp(200, {"status": 503, "msg": "busy", "data": []})
        g = self.run_main([bad, ok([raw("2026-07-20")])])
        self.assertEqual(g.call_count, 2)

    def test_other_4xx_not_retried(self):
        self.write_existing([old_row("2026-07-17")])
        before = self.out.read_bytes()
        with mock.patch("requests.get", side_effect=[FakeResp(403)] * 4) as g:
            with self.assertRaises(requests.exceptions.HTTPError):
                fetch_twoii.main()
        self.assertEqual(g.call_count, 1)
        self.assertEqual(self.out.read_bytes(), before)

    def test_payload_status_not_200_raises_and_keeps_file(self):
        self.write_existing([old_row("2026-07-17")])
        before = self.out.read_bytes()
        bad = FakeResp(200, {"status": 402, "msg": "Requests reach the upper limit", "data": []})
        with mock.patch("requests.get", side_effect=[bad] * 4) as g:
            with self.assertRaises(RuntimeError) as cm:
                fetch_twoii.main()
        self.assertIn("402", str(cm.exception))
        self.assertEqual(g.call_count, 1)  # not a transient status -> no retry
        self.assertEqual(self.out.read_bytes(), before)

    def test_bad_row_between_good_rows_does_not_block_update(self):
        self.write_existing([old_row("2026-07-17")])
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.run_main([ok([raw("2026-07-20", close=380.0),
                               raw("2026-07-21", open=float("nan")),
                               raw("2026-07-22", close=382.0)])])
        dates = [r["date"] for r in json.loads(self.out.read_text())["data"]]
        self.assertEqual(dates, ["2026-07-17", "2026-07-20", "2026-07-22"])
        self.assertIn("skipped 2026-07-21: non-finite open", buf.getvalue())

    def test_yahoo_era_rows_frozen(self):
        yahoo = [old_row("2026-07-10", 10, 111), old_row("2026-07-17", 17, 222)]
        self.write_existing(yahoo)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.run_main([ok([raw("2026-07-10", close=1.0), raw("2026-07-17", close=2.0),
                               raw("2026-07-18", close=377.77, vol=900_123_456),
                               raw("2026-07-20", close=380.5)])])
        data = json.loads(self.out.read_text())["data"]
        self.assertEqual(data[0], yahoo[0])
        self.assertEqual(data[1], yahoo[1])
        # boundary day itself (>= FINMIND_START) is written with the new FinMind values
        self.assertEqual(data[2], {"date": "2026-07-18", "open": 401.651, "high": 401.652,
                                   "low": 378.2049, "close": 377.77, "volume": 900_123})
        self.assertEqual(data[3], {"date": "2026-07-20", "open": 401.651, "high": 401.652,
                                   "low": 378.2049, "close": 380.5, "volume": 1_025_006})
        self.assertEqual(len(data), 4)
        self.assertIn("kept 2 pre-2026-07-18 Yahoo rows untouched (dropped 2 overlapping FinMind rows)",
                      buf.getvalue())

    def test_only_pre_cutoff_rows_raises_and_keeps_file(self):
        self.write_existing([old_row("2026-07-10", 10, 111), old_row("2026-07-17", 17, 222)])
        before = self.out.read_bytes()
        with self.assertRaises(RuntimeError):
            self.run_main([ok([raw("2026-07-10"), raw("2026-07-17")])])
        self.assertEqual(self.out.read_bytes(), before)

    def test_idempotent_second_run(self):
        self.write_existing([old_row("2026-07-01"), old_row("2026-07-17")])
        data = [raw("2026-07-17"), raw("2026-07-20")]
        self.run_main([ok(data)])
        first = json.loads(self.out.read_text())
        self.run_main([ok(data)])
        second = json.loads(self.out.read_text())
        self.assertEqual(first["data"], second["data"])


if __name__ == "__main__":
    unittest.main()
