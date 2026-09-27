"""Strict, append-only storage for eight FRED monthly observations.

The v0.1 event contract also accepts official API provenance and its literal
missing value ".". Existing CSV events and immutable segment bytes remain valid.
"""
from __future__ import annotations

import calendar
import csv
import hashlib
import io
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path

SCHEMA_VERSION = 1
METHOD_VERSION = "macro-data-v0.1"
IDS = ("PCEC96", "DSPIC96", "NEWORDER", "INDPRO", "PAYEMS", "UNRATE", "PERMIT", "ISRATIO")
CORE_IDS = ("PCEC96", "DSPIC96", "INDPRO", "PAYEMS", "UNRATE")
META = {
    "PCEC96": ("consumption", "BEA", "Billions of Chained 2017 Dollars, SAAR", "real"),
    "DSPIC96": ("real_income", "BEA", "Billions of Chained 2017 Dollars, SAAR", "real"),
    "NEWORDER": ("equipment_orders", "Census", "Millions of Dollars, SA", "nominal"),
    "INDPRO": ("industrial_output", "Federal Reserve", "Index 2017=100, SA", "physical_index"),
    "PAYEMS": ("labor", "BLS CES", "Thousands of Persons, SA", "persons"),
    "UNRATE": ("labor", "BLS CPS", "Percent, SA", "rate"),
    "PERMIT": ("housing", "Census/HUD", "Thousands of Units, SAAR", "units"),
    "ISRATIO": ("inventory_sales", "Census", "Ratio", "ratio"),
}
MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
UTC_RE = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
HASH_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
EVENT_KEYS = {"schema_version", "indicator_id", "reference_period_start", "reference_period_end",
              "raw_lexeme", "raw_value", "status", "source_url", "units", "release_at",
              "release_precision", "release_timezone", "source_vintage", "retrieved_at",
              "snapshot_id", "source_row_sha256", "previous_event_sha256", "event_sha256"}
STATUS_KEYS = {"last_accepted_retrieved_at", "last_complete_retrieved_at", "last_attempt_at",
               "last_attempt_status", "error", "missing_months", "fingerprint"}


class IntegrityError(ValueError):
    """Committed data are corrupt and must be left untouched."""


class SourceError(ValueError):
    """Downloaded source is invalid; committed data remain authoritative."""


def canonical(obj):
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def digest(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def archive_types(obj):
    if obj is None or type(obj) in (str, int, bool):
        return
    if isinstance(obj, list):
        for item in obj:
            archive_types(item)
        return
    if isinstance(obj, dict) and all(type(key) is str for key in obj):
        for item in obj.values():
            archive_types(item)
        return
    raise IntegrityError("archive contains noncanonical value type")


def source_url(series_id):
    require_id(series_id)
    return f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}"


def api_source_url(series_id):
    require_id(series_id)
    return f"https://api.stlouisfed.org/fred/series/observations?series_id={series_id}&file_type=json"


def require_id(series_id):
    if series_id not in IDS:
        raise ValueError(f"unsupported series_id: {series_id!r}")


def now_utc():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def utc_value(value):
    if not isinstance(value, str) or not UTC_RE.fullmatch(value):
        raise ValueError("expected second-precision UTC timestamp")
    dt = datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    return dt.replace(tzinfo=timezone.utc)


def month_next(month):
    year, number = map(int, month.split("-"))
    return f"{year + (number == 12):04d}-{number % 12 + 1:02d}"


def month_bounds(month):
    if not MONTH_RE.fullmatch(month):
        raise ValueError(f"invalid reference month: {month}")
    year, number = map(int, month.split("-"))
    return f"{month}-01", f"{month}-{calendar.monthrange(year, number)[1]:02d}"


def normalize(lexeme, *, api=False):
    if lexeme == "" or api and lexeme == ".":
        return None
    if not isinstance(lexeme, str) or lexeme != lexeme.strip():
        raise ValueError("numeric lexeme has surrounding whitespace")
    try:
        number = Decimal(lexeme)
    except InvalidOperation as exc:
        raise ValueError(f"invalid numeric lexeme: {lexeme!r}") from exc
    if not number.is_finite():
        raise ValueError("nonfinite numeric lexeme")
    return "0" if number == 0 else format(number.normalize(), "f")


def parse_csv(series_id, body, *, source=None):
    """Return complete, continuous monthly rows while retaining exact CSV value lexemes."""
    require_id(series_id)
    source = source or source_url(series_id)
    if source not in (source_url(series_id), api_source_url(series_id)):
        raise SourceError("unsupported source URL")
    try:
        text = body.decode("utf-8-sig") if isinstance(body, bytes) else body
        if not isinstance(text, str) or not text or "\x00" in text:
            raise ValueError("empty or binary response")
        reader = csv.reader(io.StringIO(text, newline=""), strict=True)
        header = next(reader)
        if header != ["observation_date", series_id]:
            raise ValueError(f"unexpected CSV header: {header!r}")
        rows = []
        previous = None
        for cells in reader:
            if len(cells) != 2:
                raise ValueError(f"expected two columns: {cells!r}")
            observation_date, lexeme = cells
            month = observation_date[:7]
            start, _ = month_bounds(month)
            if observation_date != start:
                raise ValueError(f"not an observation month start: {observation_date!r}")
            if previous and month != month_next(previous):
                raise ValueError(f"missing, duplicate, or unordered month after {previous}: {month}")
            value = normalize(lexeme, api=source == api_source_url(series_id))
            rows.append({"reference_month": month, "observation_date": observation_date,
                         "raw_lexeme": lexeme, "raw_value": value, "source_url": source})
            previous = month
        if not rows:
            raise ValueError("no observations")
        return rows
    except (csv.Error, StopIteration, UnicodeError, ValueError) as exc:
        raise SourceError(str(exc)) from exc


def fingerprint(series_id, rows):
    return digest(canonical({"series_id": series_id, "source_vintage": None,
                             "rows": [{"reference_month": row["reference_month"],
                                       "raw_value": row["raw_value"]} for row in rows]}))


def segment_path(series_id, year, data):
    require_id(series_id)
    if not re.fullmatch(r"\d{4}", year):
        raise ValueError("invalid segment year")
    return f"observations/{series_id}/{year}/{hashlib.sha256(data).hexdigest()}.jsonl"


def empty_status():
    return {"last_accepted_retrieved_at": None, "last_complete_retrieved_at": None,
            "last_attempt_at": None, "last_attempt_status": "unavailable", "error": None,
            "missing_months": [], "fingerprint": None}


def generation_id(manifest):
    return digest(canonical({key: manifest[key] for key in ("schema_version", "method_version",
                                                       "segments", "source_status")}))


def empty_manifest(as_of=None):
    manifest = {"schema_version": SCHEMA_VERSION, "method_version": METHOD_VERSION,
                "segments": [], "source_status": {series_id: empty_status() for series_id in IDS},
                "as_of": as_of or now_utc()}
    manifest["generation_id"] = generation_id(manifest)
    return manifest


def strict_json(path):
    try:
        data = path.read_bytes()
        obj = json.loads(data)
        archive_types(obj)
        if data != canonical(obj):
            raise ValueError("noncanonical JSON bytes")
        return obj
    except (OSError, ValueError, TypeError) as exc:
        raise IntegrityError(f"{path}: {exc}") from exc


def _event_valid(event, previous):
    if not isinstance(event, dict) or set(event) not in (EVENT_KEYS, EVENT_KEYS | {"source_missing_reason"}):
        raise IntegrityError("event fields differ from schema")
    series_id = event["indicator_id"]
    require_id(series_id)
    month = event["reference_period_start"][:7]
    start, end = month_bounds(month)
    if event["schema_version"] != 1 or event["reference_period_start"] != start or event["reference_period_end"] != end:
        raise IntegrityError("invalid event period/schema")
    if event["source_url"] not in (source_url(series_id), api_source_url(series_id)) or event["units"] != META[series_id][2]:
        raise IntegrityError("invalid event source/units")
    if any(event[k] is not None for k in ("release_at", "release_precision", "release_timezone", "source_vintage")):
        raise IntegrityError("unsupported release or vintage claim")
    utc_value(event["retrieved_at"])
    missing = event["raw_value"] is None
    if event["raw_value"] != normalize(event["raw_lexeme"], api=event["source_url"] == api_source_url(series_id)):
        raise IntegrityError("event raw value differs from lexeme")
    if missing:
        if event["status"] != "source_missing" or "source_missing_reason" not in event or event["source_missing_reason"] is not None and not isinstance(event["source_missing_reason"], str):
            raise IntegrityError("invalid source missing event")
    elif event["status"] != "latest_revised_import" or "source_missing_reason" in event:
        raise IntegrityError("invalid value event status")
    row_hash = digest(canonical({"observation_date": start, "series_id": series_id,
                                 "raw_lexeme": event["raw_lexeme"]}))
    if event["source_row_sha256"] != row_hash:
        raise IntegrityError("source row hash mismatch")
    if not HASH_RE.fullmatch(event["snapshot_id"]):
        raise IntegrityError("invalid snapshot hash")
    if event["previous_event_sha256"] != (previous["event_sha256"] if previous else None):
        raise IntegrityError("event chain mismatch")
    if previous and event["retrieved_at"] <= previous["retrieved_at"]:
        raise IntegrityError("event time not strictly increasing")
    if previous and event["raw_value"] == previous["raw_value"]:
        raise IntegrityError("unchanged observation was stored as a new event")
    payload = {key: value for key, value in event.items() if key != "event_sha256"}
    if event["event_sha256"] != digest(canonical(payload)):
        raise IntegrityError("event hash mismatch")


def load_archive(data_dir):
    """Validate committed manifest, every segment and event, then return latest and history."""
    archive = Path(data_dir) / "us_macro_archive"
    path = archive / "manifest.json"
    if not path.exists():
        if summary_path(data_dir).exists():
            raise IntegrityError("summary exists without committed manifest")
        return None, {series_id: {} for series_id in IDS}, {series_id: {} for series_id in IDS}
    manifest = strict_json(path)
    if not isinstance(manifest, dict) or set(manifest) != {"schema_version", "method_version", "segments", "source_status", "as_of", "generation_id"}:
        raise IntegrityError("invalid manifest schema")
    if manifest["schema_version"] != 1 or manifest["method_version"] != METHOD_VERSION or not isinstance(manifest["segments"], list):
        raise IntegrityError("invalid manifest version/segments")
    try:
        utc_value(manifest["as_of"])
        if manifest["generation_id"] != generation_id(manifest):
            raise IntegrityError("manifest generation mismatch")
        statuses = manifest["source_status"]
        if not isinstance(statuses, dict) or set(statuses) != set(IDS):
            raise IntegrityError("invalid source status IDs")
        for item in statuses.values():
            if not isinstance(item, dict) or not STATUS_KEYS.issubset(item):
                raise IntegrityError("invalid source status")
            for field in ("last_accepted_retrieved_at", "last_complete_retrieved_at", "last_attempt_at"):
                if item[field] is not None:
                    utc_value(item[field])
                    if item[field] > manifest["as_of"]:
                        raise IntegrityError(f"{field} exceeds manifest as_of")
            if item["last_accepted_retrieved_at"] is not None and (item["last_attempt_at"] is None or item["last_accepted_retrieved_at"] > item["last_attempt_at"]):
                raise IntegrityError("accepted time exceeds last attempt")
            if item["last_complete_retrieved_at"] is not None and (item["last_accepted_retrieved_at"] is None or item["last_complete_retrieved_at"] > item["last_accepted_retrieved_at"]):
                raise IntegrityError("complete time exceeds accepted time")
            if item["last_attempt_status"] not in ("success", "partial", "failed", "unavailable"):
                raise IntegrityError("invalid attempt status")
            if item["error"] is not None and not isinstance(item["error"], str):
                raise IntegrityError("invalid source error")
            if not isinstance(item["missing_months"], list) or any(not MONTH_RE.fullmatch(x) for x in item["missing_months"]):
                raise IntegrityError("invalid missing months")
            if item["fingerprint"] is not None and not HASH_RE.fullmatch(item["fingerprint"]):
                raise IntegrityError("invalid fingerprint")
        histories = {series_id: {} for series_id in IDS}
        latest = {series_id: {} for series_id in IDS}
        events = []
        seen_paths = set()
        for segment in manifest["segments"]:
            if not isinstance(segment, dict) or set(segment) != {"path", "sha256", "rows", "byte_size"}:
                raise IntegrityError("invalid segment metadata")
            if type(segment["rows"]) is not int or segment["rows"] < 1 or type(segment["byte_size"]) is not int or segment["byte_size"] < 1:
                raise IntegrityError("invalid segment row/byte counts")
            rel = segment["path"]
            match = re.fullmatch(r"observations/([A-Z0-9]+)/([0-9]{4})/([0-9a-f]{64})\.jsonl", rel) if isinstance(rel, str) else None
            if not match or match.group(1) not in IDS or rel in seen_paths or segment["sha256"] != "sha256:" + match.group(3):
                raise IntegrityError("invalid, duplicate, or traversing segment path")
            seen_paths.add(rel)
            target = archive / rel
            if target.is_symlink() or target.resolve().is_relative_to(archive.resolve()) is False:
                raise IntegrityError("segment path escapes archive")
            data = target.read_bytes()
            if digest(data) != segment["sha256"] or len(data) != segment["byte_size"] or not data.endswith(b"\n") or b"\r" in data:
                raise IntegrityError("segment bytes/hash mismatch")
            lines = data.splitlines(keepends=True)
            if len(lines) != segment["rows"] or not lines:
                raise IntegrityError("segment row count mismatch")
            part = []
            for line in lines:
                event = json.loads(line)
                archive_types(event)
                if line != canonical(event) + b"\n" or event["indicator_id"] != match.group(1) or event["reference_period_start"][:4] != match.group(2):
                    raise IntegrityError("noncanonical or misfiled event")
                part.append(event)
            if part != sorted(part, key=lambda e: (e["indicator_id"], e["reference_period_start"], e["retrieved_at"], e["event_sha256"])):
                raise IntegrityError("segment order mismatch")
            events.extend(part)
        # Validate globally by retrieval batch; yearly segments split a single snapshot.
        groups = {}
        for event in events:
            key = (event["indicator_id"], event["retrieved_at"], event["snapshot_id"])
            groups.setdefault(key, []).append(event)
        for (series_id, retrieved_at, snapshot_id), batch in sorted(groups.items(), key=lambda kv: (kv[0][1], kv[0][0])):
            if retrieved_at > manifest["as_of"]:
                raise IntegrityError("event retrieval exceeds manifest as_of")
            if any(key[0] == series_id and key[1] == retrieved_at and key[2] != snapshot_id for key in groups):
                raise IntegrityError("same-second snapshot collision")
            for event in sorted(batch, key=lambda e: e["reference_period_start"]):
                month = event["reference_period_start"][:7]
                prior = latest[series_id].get(month)
                _event_valid(event, prior)
                histories[series_id].setdefault(month, []).append(event)
                latest[series_id][month] = event
            rows = [{"reference_month": month, "raw_value": event["raw_value"]}
                    for month, event in sorted(latest[series_id].items())]
            if snapshot_id != fingerprint(series_id, rows):
                raise IntegrityError("snapshot fingerprint mismatch")
        for series_id in IDS:
            status = statuses[series_id]
            rows = [{"reference_month": month, "raw_value": event["raw_value"]}
                    for month, event in sorted(latest[series_id].items())]
            computed = fingerprint(series_id, rows) if rows else None
            if status["fingerprint"] != computed:
                raise IntegrityError("committed fingerprint mismatch")
            if bool(rows) != bool(status["last_accepted_retrieved_at"]):
                raise IntegrityError("accepted time does not match committed observations")
            if rows and status["last_accepted_retrieved_at"] < max(event["retrieved_at"] for event in latest[series_id].values()):
                raise IntegrityError("accepted time precedes observation")
            if status["last_complete_retrieved_at"] and (not rows or status["last_complete_retrieved_at"] > status["last_accepted_retrieved_at"]):
                raise IntegrityError("invalid complete time")
            missing = [row["reference_month"] for row in rows if row["raw_value"] is None]
            if status["fingerprint"] is not None and status["missing_months"] != missing:
                raise IntegrityError("committed missing-month status mismatch")
            if rows and any(month_next(rows[i]["reference_month"]) != rows[i+1]["reference_month"] for i in range(len(rows)-1)):
                raise IntegrityError("committed history has missing month")
        return manifest, latest, histories
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        if isinstance(exc, IntegrityError):
            raise
        raise IntegrityError(f"archive invalid: {exc}") from exc


def make_event(series_id, row, retrieved_at, snapshot_id, previous):
    month = row["reference_month"]
    start, end = month_bounds(month)
    event = {"schema_version": 1, "indicator_id": series_id, "reference_period_start": start,
             "reference_period_end": end, "raw_lexeme": row["raw_lexeme"],
             "raw_value": row["raw_value"], "status": "source_missing" if row["raw_value"] is None else "latest_revised_import",
             "source_url": row.get("source_url", source_url(series_id)), "units": META[series_id][2],
             "release_at": None, "release_precision": None, "release_timezone": None,
             "source_vintage": None, "retrieved_at": retrieved_at, "snapshot_id": snapshot_id,
             "source_row_sha256": digest(canonical({"observation_date": row["observation_date"],
                                                    "series_id": series_id, "raw_lexeme": row["raw_lexeme"]})),
             "previous_event_sha256": previous["event_sha256"] if previous else None}
    if row["raw_value"] is None:
        event["source_missing_reason"] = "BLS did not collect CPS estimates during October 2025" if series_id == "UNRATE" and month == "2025-10" else None
    event["event_sha256"] = digest(canonical(event))
    return event


def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".macro-", delete=False) as temp:
        temp.write(data)
        temp.flush()
        os.fsync(temp.fileno())
        name = temp.name
    try:
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def install_segment(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if path.read_bytes() != data:
            raise IntegrityError("content-addressed segment collision")
        return
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".macro-", delete=False) as temp:
        temp.write(data)
        temp.flush()
        os.fsync(temp.fileno())
        name = temp.name
    try:
        os.link(name, path)  # never overwrite a committed or orphaned immutable segment
    finally:
        os.unlink(name)


def age_months(month, as_of):
    if month is None:
        return None
    dt = utc_value(as_of)
    complete_year, complete_month = (dt.year - 1, 12) if dt.month == 1 else (dt.year, dt.month - 1)
    year, number = map(int, month.split("-"))
    return max(0, (complete_year - year) * 12 + complete_month - number)


def build_summary(manifest, latest, *, as_of=None):
    stamp = as_of or manifest["as_of"]
    utc_value(stamp)
    indicators = {}
    for series_id in IDS:
        events = latest[series_id]
        last_month = max(events) if events else None
        last = events.get(last_month)
        status = manifest["source_status"][series_id]
        age = age_months(last_month, stamp)
        family, institution, units, basis = META[series_id]
        window = sorted(events)[-36:]
        indicators[series_id] = {
            "reference_month": last_month, "value": float(Decimal(last["raw_value"])) if last and last["raw_value"] is not None else None,
            "units": units, "source_url": last["source_url"] if last else source_url(series_id),
            "retrieved_at": last["retrieved_at"] if last else None, "release_at": None,
            "source_vintage": None, "age_months": age,
            "stale": last is None or age > (3 if series_id == "ISRATIO" else 2) or status["last_attempt_status"] in ("failed", "unavailable"),
            "formula": None, "method_version": METHOD_VERSION,
            "evidence_hash": last["event_sha256"] if last else None,
            "metadata": {"family": family, "institution": institution, "frequency": "monthly",
                         "seasonal_adjustment": "SAAR" if series_id in ("PCEC96", "DSPIC96", "PERMIT") else "SA",
                         "price_basis": basis,
                         "metadata_url": f"https://fred.stlouisfed.org/series/{series_id}"},
            "observations": [{"reference_month": month,
                              "value": float(Decimal(events[month]["raw_value"])) if events[month]["raw_value"] is not None else None,
                              "raw_value": events[month]["raw_value"],
                              "retrieved_at": events[month]["retrieved_at"],
                              "event_sha256": events[month]["event_sha256"], "status": events[month]["status"]}
                             for month in window]
        }
    month_sets = [set(month for month, event in latest[series_id].items() if event["raw_value"] is not None) for series_id in CORE_IDS]
    common = max(set.intersection(*month_sets)) if all(month_sets) and set.intersection(*month_sets) else None
    coverage = {"core_ids": list(CORE_IDS), "common_month": common,
                "available_core_series_count": sum(bool(months) for months in month_sets),
                "required_core_series_count": len(CORE_IDS),
                "families": {family: {"series_ids": ids, "available": all(bool(latest[series_id]) for series_id in ids)}
                             for family, ids in {"consumption": ["PCEC96"], "real_income": ["DSPIC96"],
                                                 "industrial_output": ["INDPRO"], "labor": ["PAYEMS", "UNRATE"]}.items()}}
    return {"schema_version": 1, "method_version": METHOD_VERSION, "generation_id": manifest["generation_id"],
            "as_of": stamp, "view": "latest_revised", "coverage": coverage, "indicators": indicators,
            "diagnostics": {"status": "pending_c", "historical_dashboard": "unsupported",
                            "divergence_duration": None, "temporal_scope": "not_pit"},
            "source_status": manifest["source_status"]}


def summary_path(data_dir):
    return Path(data_dir) / "us_macro_diagnostic.json"


def summary_bytes(summary):
    return canonical(summary) + b"\n"


def recover_summary(data_dir, manifest, latest):
    if manifest is None:
        return
    path = summary_path(data_dir)
    expected = summary_bytes(build_summary(manifest, latest))
    if not path.exists() or path.read_bytes() != expected:
        atomic_write(path, expected)


def commit_batch(data_dir, accepted, failures, *, attempt_at=None):
    """Commit validated parsed rows; failures map ID to error text. Time can be injected by tests."""
    data_dir = Path(data_dir)
    old, latest, _ = load_archive(data_dir)  # integrity gate before any write
    attempt_at = attempt_at or now_utc()
    utc_value(attempt_at)
    if old and attempt_at < old["as_of"]:
        raise SourceError("attempt time precedes committed manifest as_of")
    for series_id, (_, retrieved_at) in accepted.items():
        require_id(series_id)
        utc_value(retrieved_at)
        if retrieved_at > attempt_at:
            raise SourceError(f"{series_id}: retrieval time exceeds attempt time")
        previous = old["source_status"][series_id]["last_accepted_retrieved_at"] if old else None
        if previous and retrieved_at < previous:
            raise SourceError(f"{series_id}: retrieval time precedes last accepted time")
    manifest = json.loads(json.dumps(old)) if old else empty_manifest(attempt_at)
    new_segments = []
    for series_id in IDS:
        state = manifest["source_status"][series_id]
        state["last_attempt_at"] = attempt_at
        if series_id not in accepted:
            state["last_attempt_status"] = "failed" if series_id in failures else state["last_attempt_status"]
            state["error"] = failures.get(series_id, state["error"])
            continue
        rows, retrieved_at = accepted[series_id]
        utc_value(retrieved_at)
        if not rows:
            raise SourceError("accepted source has no rows")
        old_months = set(latest[series_id])
        new_months = {row["reference_month"] for row in rows}
        if not old_months.issubset(new_months):
            raise SourceError(f"{series_id}: committed month disappeared")
        if old_months and max(new_months) < max(old_months):
            raise SourceError(f"{series_id}: series endpoint regressed")
        fp = fingerprint(series_id, rows)
        changed = [row for row in rows if row["reference_month"] not in latest[series_id] or row["raw_value"] != latest[series_id][row["reference_month"]]["raw_value"]]
        if changed and state["last_accepted_retrieved_at"] and retrieved_at <= state["last_accepted_retrieved_at"]:
            raise SourceError(f"{series_id}: timestamp collision or time regression")
        if fp != state["fingerprint"] and not changed:
            raise IntegrityError("fingerprint changed without value changes")
        by_year = {}
        for row in changed:
            event = make_event(series_id, row, retrieved_at, fp, latest[series_id].get(row["reference_month"]))
            by_year.setdefault(row["reference_month"][:4], []).append(event)
            latest[series_id][row["reference_month"]] = event
        for year, part in by_year.items():
            part.sort(key=lambda e: (e["indicator_id"], e["reference_period_start"], e["retrieved_at"], e["event_sha256"]))
            data = b"".join(canonical(event) + b"\n" for event in part)
            rel = segment_path(series_id, year, data)
            new_segments.append((rel, data, {"path": rel, "sha256": digest(data), "rows": len(part), "byte_size": len(data)}))
        missing = [row["reference_month"] for row in rows if row["raw_value"] is None]
        state["fingerprint"] = fp
        state["last_accepted_retrieved_at"] = retrieved_at
        if not missing:
            state["last_complete_retrieved_at"] = retrieved_at
        state["last_attempt_status"] = "partial" if missing else "success"
        state["missing_months"] = missing
        state["error"] = None
    manifest["segments"].extend(meta for _, _, meta in new_segments)
    manifest["as_of"] = attempt_at
    manifest["generation_id"] = generation_id(manifest)
    # Validate staged generation in a private tree before publishing anything.
    with tempfile.TemporaryDirectory() as temp:
        staged = Path(temp)
        for item in manifest["segments"]:
            rel = item["path"]
            if any(new_rel == rel for new_rel, _, _ in new_segments):
                data = next(blob for new_rel, blob, _ in new_segments if new_rel == rel)
            else:
                data = (data_dir / "us_macro_archive" / rel).read_bytes()
            target = staged / "us_macro_archive" / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        mp = staged / "us_macro_archive" / "manifest.json"
        mp.parent.mkdir(parents=True, exist_ok=True)
        mp.write_bytes(canonical(manifest))
        checked, checked_latest, _ = load_archive(staged)
        build_summary(checked, checked_latest)
    for rel, data, _ in new_segments:
        install_segment(data_dir / "us_macro_archive" / rel, data)
    atomic_write(data_dir / "us_macro_archive" / "manifest.json", canonical(manifest))
    atomic_write(summary_path(data_dir), summary_bytes(build_summary(manifest, latest)))
    return manifest


def system_snapshot(data_dir, as_of):
    """Return only archived raw observations visible by retrieval cutoff."""
    utc_value(as_of)
    _, _, histories = load_archive(data_dir)
    observations = {}
    for series_id in IDS:
        observations[series_id] = [
            {"reference_month": month, "raw_value": chosen["raw_value"],
             "value": float(Decimal(chosen["raw_value"])) if chosen["raw_value"] is not None else None,
             "retrieved_at": chosen["retrieved_at"], "event_sha256": chosen["event_sha256"],
             "status": chosen["status"]}
            for month, versions in sorted(histories[series_id].items())
            if (chosen := next((event for event in reversed(versions) if event["retrieved_at"] <= as_of), None)) is not None]
    return {"view": "system_snapshot", "as_of": as_of, "observations": observations,
            "attempt_status_at_as_of": "unknown", "method_at_as_of": "unknown",
            "derived_diagnostics": "unsupported", "historical_dashboard": "unsupported"}


def query(data_dir, view, as_of=None):
    if view == "historical_market_known":
        return {"view": view, "status": "unsupported"}
    if view == "system_snapshot":
        if as_of is None:
            raise ValueError("system_snapshot requires as_of")
        return system_snapshot(data_dir, as_of)
    if view != "latest_revised":
        raise ValueError(f"unsupported view: {view}")
    manifest, latest, _ = load_archive(data_dir)
    if manifest is None:
        return build_summary(empty_manifest(), latest)
    return build_summary(manifest, latest)
