"""Offline contract tests for raw CSV, versions, and system-seen query."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import _macro_data as m  # noqa: E402


def csv_rows(series_id, vals, start="2025-09"):
    month = start
    lines = [f"observation_date,{series_id}"]
    for val in vals:
        lines.append(f"{month}-01,{val}")
        month = m.month_next(month)
    return ("\n".join(lines) + "\n").encode()


class MacroDataTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def accept(self, vals, stamp, series_id="UNRATE", start="2025-09"):
        rows = m.parse_csv(series_id, csv_rows(series_id, vals, start))
        return m.commit_batch(self.data, {series_id: (rows, stamp)}, {}, attempt_at=stamp)

    def test_vectors_and_strict_parser(self):
        row = m.parse_csv("ISRATIO", csv_rows("ISRATIO", ["1.30"], "2026-07"))[0]
        self.assertEqual(m.digest(m.canonical({"observation_date": row["observation_date"], "raw_lexeme": row["raw_lexeme"], "series_id": "ISRATIO"})), "sha256:cec71019756d7a64a89d30347210bb2f2afbb14afdfec0e85aa77c0bf2943c08")
        fp = m.fingerprint("ISRATIO", [row])
        self.assertEqual(fp, "sha256:ead6824b5908f87a14b8933dbee70f9e3cde3178c943ba250bfa4057cd9c93fe")
        event = m.make_event("ISRATIO", row, "2026-09-26T00:00:00Z", fp, None)
        self.assertEqual(event["event_sha256"], "sha256:1a4f399e9e13dd047adb8a18e2742c1aa66f03e25c790a579eda445dc123feb6")
        self.assertEqual(m.digest(m.canonical(event) + b"\n"), "sha256:2c64d8ed22888e2ef6dd9e4d3dadaa0d5ed7ba6dbe609cc566a68b1b8f23ea5e")
        for body in (b"<html>ok</html>", b"observation_date,ISRATIO\n2026-01-01,x\n",
                     b"observation_date,ISRATIO\n2026-01-01,1\n2026-03-01,2\n",
                     b"observation_date,ISRATIO\n2026-01-01,1 \n", b"observation_date,ISRATIO\n2026-01-01,NaN\n",
                     b"observation_date,ISRATIO\n2026-01-01,1\n2026-01-01,2\n"):
            with self.subTest(body=body), self.assertRaises(m.SourceError):
                m.parse_csv("ISRATIO", body)

    def test_import_missing_revision_dedupe_revert_and_cutoff(self):
        t1, t2, t3, t4 = "2026-09-26T00:00:00Z", "2026-09-26T00:00:01Z", "2026-09-26T00:00:02Z", "2026-09-26T00:00:03Z"
        self.accept(["4.0", "", "4.2"], t1)
        first, latest, _ = m.load_archive(self.data)
        self.assertEqual(first["source_status"]["UNRATE"]["last_attempt_status"], "partial")
        self.assertEqual(first["source_status"]["UNRATE"]["missing_months"], ["2025-10"])
        self.assertIsNone(m.build_summary(first, latest)["indicators"]["UNRATE"]["observations"][1]["value"])
        self.assertEqual(len(m.system_snapshot(self.data, "2026-09-25T23:59:59Z")["observations"]["UNRATE"]), 0)
        before_events = sum(x["rows"] for x in first["segments"])
        self.accept(["4.00", "", "4.2"], t2)
        same, latest, _ = m.load_archive(self.data)
        self.assertEqual(sum(x["rows"] for x in same["segments"]), before_events)
        self.assertEqual(latest["UNRATE"]["2025-09"]["retrieved_at"], t1)
        self.accept(["4.1", "", "4.2"], t3)
        revised, _, _ = m.load_archive(self.data)
        self.assertEqual(sum(x["rows"] for x in revised["segments"]), before_events + 1)
        self.accept(["4.0", "", "4.2"], t4)
        reverted, _, history = m.load_archive(self.data)
        self.assertEqual(len(history["UNRATE"]["2025-09"]), 3)
        self.assertEqual(m.system_snapshot(self.data, t1)["observations"]["UNRATE"][0]["value"], 4.0)
        self.assertEqual(m.system_snapshot(self.data, t2)["observations"]["UNRATE"][0]["value"], 4.0)
        self.assertEqual(m.system_snapshot(self.data, t3)["observations"]["UNRATE"][0]["value"], 4.1)
        self.assertEqual(m.system_snapshot(self.data, t4)["observations"]["UNRATE"][0]["value"], 4.0)
        self.assertEqual(m.query(self.data, "historical_market_known"), {"view": "historical_market_known", "status": "unsupported"})
        self.assertEqual(reverted["source_status"]["UNRATE"]["last_complete_retrieved_at"], None)

    def test_disappeared_history_and_timestamp_collision_preserve_old(self):
        t = "2026-09-26T00:00:00Z"
        self.accept(["1", "2", "3"], t, "PAYEMS")
        manifest_path = self.data / "us_macro_archive" / "manifest.json"
        before = manifest_path.read_bytes()
        for vals, start in [(["2", "3"], "2025-10"), (["1", "2"], "2025-09")]:
            with self.subTest(vals=vals), self.assertRaises(m.SourceError):
                self.accept(vals, "2026-09-26T00:00:01Z", "PAYEMS", start)
            self.assertEqual(manifest_path.read_bytes(), before)
        with self.assertRaises(m.SourceError):
            self.accept(["4", "2", "3"], t, "PAYEMS")
        self.assertEqual(manifest_path.read_bytes(), before)

    def test_trailing_36_calendar_months_and_recent_missing(self):
        vals = [str(i) for i in range(40)]
        vals[-3] = ""
        self.accept(vals, "2026-09-26T00:00:00Z", "PCEC96", "2023-01")
        summary = m.query(self.data, "latest_revised")
        obs = summary["indicators"]["PCEC96"]["observations"]
        self.assertEqual(len(obs), 36)
        self.assertEqual(obs[0]["reference_month"], "2023-05")
        self.assertIsNone(obs[-3]["value"])
        self.assertEqual(obs[-3]["status"], "source_missing")
        self.assertEqual(summary["coverage"]["common_month"], None)

    def test_failed_attempt_retains_value_and_marks_not_fresh(self):
        self.accept(["1"], "2026-09-26T00:00:00Z", "INDPRO")
        m.commit_batch(self.data, {}, {"INDPRO": "HTTP 503"}, attempt_at="2026-09-26T00:01:00Z")
        payload = m.query(self.data, "latest_revised")
        self.assertEqual(payload["indicators"]["INDPRO"]["value"], 1.0)
        self.assertTrue(payload["indicators"]["INDPRO"]["stale"])
        self.assertEqual(payload["source_status"]["INDPRO"]["last_attempt_status"], "failed")
        self.assertEqual(payload["source_status"]["INDPRO"]["last_accepted_retrieved_at"], "2026-09-26T00:00:00Z")
        self.assertEqual(payload["source_status"]["INDPRO"]["error"], "HTTP 503")

    def test_initial_source_failure_is_explicitly_unavailable(self):
        m.commit_batch(self.data, {}, {"PCEC96": "HTTP 503"}, attempt_at="2026-09-26T00:00:00Z")
        payload = m.query(self.data, "latest_revised")
        self.assertIsNone(payload["indicators"]["PCEC96"]["value"])
        self.assertTrue(payload["indicators"]["PCEC96"]["stale"])
        self.assertEqual(payload["source_status"]["PCEC96"]["last_attempt_status"], "failed")
        self.assertIsNone(payload["source_status"]["PCEC96"]["last_accepted_retrieved_at"])

    def test_time_guards_reject_before_recovery_or_writes(self):
        rows = m.parse_csv("PCEC96", csv_rows("PCEC96", ["100"], "2026-08"))
        def files():
            return {str(path.relative_to(self.data)): path.read_bytes() for path in self.data.rglob("*") if path.is_file()}

        before = files()
        with self.assertRaisesRegex(m.SourceError, "retrieval time exceeds attempt"):
            m.commit_batch(self.data, {"PCEC96": (rows, "2026-09-26T12:00:00Z")}, {}, attempt_at="2026-09-26T11:00:00Z")
        self.assertEqual(files(), before)

        m.commit_batch(self.data, {"PCEC96": (rows, "2026-09-26T11:00:00Z")}, {}, attempt_at="2026-09-26T11:00:00Z")
        summary = self.data / "us_macro_diagnostic.json"
        original_summary = summary.read_bytes()
        summary.write_bytes(b"stale summary after crash")
        before = files()
        with self.assertRaisesRegex(m.SourceError, "attempt time precedes committed"):
            m.commit_batch(self.data, {}, {"PCEC96": "network failed"}, attempt_at="2026-09-26T10:00:00Z")
        self.assertEqual(files(), before)
        with self.assertRaisesRegex(m.SourceError, "retrieval time precedes last accepted"):
            m.commit_batch(self.data, {"PCEC96": (rows, "2026-09-26T10:00:00Z")}, {}, attempt_at="2026-09-26T12:00:00Z")
        self.assertEqual(files(), before)

        summary.write_bytes(original_summary)
        m.commit_batch(self.data, {"PCEC96": (rows, "2026-09-26T11:00:00Z")}, {}, attempt_at="2026-09-26T12:00:00Z")
        manifest, latest, _ = m.load_archive(self.data)
        self.assertEqual(len(latest["PCEC96"]), 1)  # same-second, same-value reread is valid
        self.assertEqual(manifest["source_status"]["PCEC96"]["last_accepted_retrieved_at"], "2026-09-26T11:00:00Z")


if __name__ == "__main__":
    unittest.main()
