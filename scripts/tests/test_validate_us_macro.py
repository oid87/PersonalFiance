"""Offline archive integrity, crash recovery, and validator tests."""
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
import validate_us_macro as v  # noqa: E402


class ValidatorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = Path(self.tmp.name)
        rows = m.parse_csv("ISRATIO", b"observation_date,ISRATIO\n2026-06-01,1.2\n2026-07-01,1.30\n")
        m.commit_batch(self.data, {"ISRATIO": (rows, "2026-09-26T00:00:00Z")}, {}, attempt_at="2026-09-26T00:00:00Z")
        self.archive = self.data / "us_macro_archive"

    def tearDown(self):
        self.tmp.cleanup()

    def test_valid_and_summary_generation_tampering(self):
        self.assertEqual(v.validate(self.data)["events"], 2)
        summary = self.data / "us_macro_diagnostic.json"
        old = summary.read_bytes()
        payload = json.loads(old)
        payload["generation_id"] = "sha256:" + "0" * 64
        summary.write_bytes(m.summary_bytes(payload))
        with self.assertRaises(m.IntegrityError):
            v.validate(self.data)
        self.assertEqual(summary.read_bytes(), m.summary_bytes(payload))  # validator is read-only
        manifest, latest, _ = m.load_archive(self.data)
        m.recover_summary(self.data, manifest, latest)  # restart after manifest commit
        self.assertEqual(summary.read_bytes(), old)
        v.validate(self.data)

    def test_event_hash_or_field_tamper_cannot_be_hidden_by_rehashing_segment(self):
        manifest_path = self.archive / "manifest.json"
        manifest = json.loads(manifest_path.read_bytes())
        seg = manifest["segments"][0]
        path = self.archive / seg["path"]
        events = [json.loads(line) for line in path.read_bytes().splitlines()]
        events[0]["raw_value"] = "9"
        altered = b"".join(m.canonical(event) + b"\n" for event in events)
        path.write_bytes(altered)
        with self.assertRaises(m.IntegrityError):
            v.validate(self.data)
        # An invalid committed archive stops fetch writes, preserving damage for repair.
        before = manifest_path.read_bytes()
        with self.assertRaises(m.IntegrityError):
            m.commit_batch(self.data, {}, {}, attempt_at="2026-09-26T00:01:00Z")
        self.assertEqual(before, manifest_path.read_bytes())

    def test_rehashed_event_still_fails_semantic_validation(self):
        manifest_path = self.archive / "manifest.json"
        manifest = json.loads(manifest_path.read_bytes())
        segment = manifest["segments"][0]
        events = [json.loads(line) for line in (self.archive / segment["path"]).read_bytes().splitlines()]
        events[0]["raw_value"] = "9"  # leave the source lexeme at 1.2
        events[0]["event_sha256"] = m.digest(m.canonical({k: val for k, val in events[0].items() if k != "event_sha256"}))
        data = b"".join(m.canonical(event) + b"\n" for event in events)
        rel = m.segment_path("ISRATIO", "2026", data)
        target = self.archive / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        segment.update(path=rel, sha256=m.digest(data), rows=len(events), byte_size=len(data))
        manifest["generation_id"] = m.generation_id(manifest)
        manifest_path.write_bytes(m.canonical(manifest))
        with self.assertRaisesRegex(m.IntegrityError, "raw value differs"):
            v.validate(self.data)

    def test_rehashed_future_event_exceeds_manifest_as_of(self):
        manifest_path = self.archive / "manifest.json"
        manifest = json.loads(manifest_path.read_bytes())
        segment = manifest["segments"][0]
        events = [json.loads(line) for line in (self.archive / segment["path"]).read_bytes().splitlines()]
        for event in events:
            event["retrieved_at"] = "2026-09-26T01:00:00Z"
            event["event_sha256"] = m.digest(m.canonical({k: val for k, val in event.items() if k != "event_sha256"}))
        data = b"".join(m.canonical(event) + b"\n" for event in events)
        rel = m.segment_path("ISRATIO", "2026", data)
        target = self.archive / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        segment.update(path=rel, sha256=m.digest(data), rows=len(events), byte_size=len(data))
        manifest["generation_id"] = m.generation_id(manifest)
        manifest_path.write_bytes(m.canonical(manifest))
        with self.assertRaisesRegex(m.IntegrityError, "event retrieval exceeds manifest"):
            v.validate(self.data)

    def test_rehashed_manifest_rejects_future_status_and_ordering(self):
        manifest_path = self.archive / "manifest.json"
        baseline = json.loads(manifest_path.read_bytes())
        def forged(field, value):
            manifest = json.loads(json.dumps(baseline))
            manifest["source_status"]["ISRATIO"][field] = value
            manifest["generation_id"] = m.generation_id(manifest)
            manifest_path.write_bytes(m.canonical(manifest))

        for field in ("last_attempt_at", "last_accepted_retrieved_at", "last_complete_retrieved_at"):
            with self.subTest(field=field):
                forged(field, "2026-09-26T01:00:00Z")
                with self.assertRaisesRegex(m.IntegrityError, "exceeds manifest as_of"):
                    v.validate(self.data)
        forged("last_attempt_at", "2026-09-25T23:00:00Z")
        with self.assertRaisesRegex(m.IntegrityError, "accepted time exceeds last attempt"):
            v.validate(self.data)
        forged("last_complete_retrieved_at", "2026-09-26T00:00:01Z")
        # as_of is also 00:00:00 here, so use a later manifest as_of to isolate ordering.
        manifest = json.loads(manifest_path.read_bytes())
        manifest["as_of"] = "2026-09-26T00:01:00Z"
        manifest["generation_id"] = m.generation_id(manifest)
        manifest_path.write_bytes(m.canonical(manifest))
        with self.assertRaisesRegex(m.IntegrityError, "complete time exceeds accepted"):
            v.validate(self.data)

    def test_manifest_invalid_json_and_chain_break(self):
        manifest_path = self.archive / "manifest.json"
        old = manifest_path.read_bytes()
        manifest_path.write_bytes(b"{broken")
        with self.assertRaises(m.IntegrityError):
            v.validate(self.data)
        self.assertEqual(manifest_path.read_bytes(), b"{broken")
        manifest_path.write_bytes(old)
        manifest = json.loads(old)
        manifest["segments"][0]["path"] = "observations/ISRATIO/../../etc/passwd.jsonl"
        manifest["generation_id"] = m.generation_id(manifest)
        manifest_path.write_bytes(m.canonical(manifest))
        with self.assertRaises(m.IntegrityError):
            v.validate(self.data)

    def test_orphan_segment_ignored_and_summary_rebuilt(self):
        manifest_path = self.archive / "manifest.json"
        committed = manifest_path.read_bytes()
        orphan_dir = self.archive / "observations" / "ISRATIO" / "2027"
        orphan_dir.mkdir(parents=True)
        (orphan_dir / ("0" * 64 + ".jsonl")).write_text("orphan")
        (self.data / "us_macro_diagnostic.json").unlink()
        manifest, latest, _ = m.load_archive(self.data)
        m.recover_summary(self.data, manifest, latest)
        self.assertEqual(manifest_path.read_bytes(), committed)
        self.assertEqual(v.validate(self.data)["events"], 2)

    def test_source_snapshot_value_and_chain_after_revision(self):
        rows = m.parse_csv("ISRATIO", b"observation_date,ISRATIO\n2026-06-01,1.1\n2026-07-01,1.30\n")
        m.commit_batch(self.data, {"ISRATIO": (rows, "2026-09-26T00:00:01Z")}, {}, attempt_at="2026-09-26T00:00:01Z")
        self.assertEqual(v.validate(self.data)["events"], 3)
        _, _, histories = m.load_archive(self.data)
        first, second = histories["ISRATIO"]["2026-06"]
        self.assertEqual(second["previous_event_sha256"], first["event_sha256"])
        self.assertEqual(m.system_snapshot(self.data, "2026-09-26T00:00:00Z")["observations"]["ISRATIO"][0]["value"], 1.2)


if __name__ == "__main__":
    unittest.main()
