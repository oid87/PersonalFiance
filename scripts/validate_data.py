#!/usr/bin/env python3
"""Read-only data integrity guard for heterogeneous product payloads."""
from __future__ import annotations

import argparse
from datetime import date, datetime
import json
import math
from pathlib import Path
import subprocess
import sys
from source_contracts import expand_contracts

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
CONFLICT_MARKERS = ("<<<<<<<", ">>>>>>>")
SHRINK_RATIO = 0.5
MIN_PREV_ROWS = 10


def row_count(obj) -> int:
    if isinstance(obj, list):
        return len(obj)
    if isinstance(obj, dict):
        if isinstance(obj.get("data"), list):
            return len(obj["data"])
        return len(obj)
    return 0


def git_show_head(rel: str) -> str | None:
    try:
        return subprocess.run(["git", "show", f"HEAD:{rel}"], cwd=ROOT,
                              capture_output=True, text=True, check=True).stdout
    except subprocess.CalledProcessError:
        return None


def iso_day(value, path: str, failures: list[str]) -> str | None:
    if not isinstance(value, str):
        failures.append(f"{path}: date must be an ISO string")
        return None
    try:
        parsed = date.fromisoformat(value)
        if parsed.isoformat() != value:
            raise ValueError("non-canonical")
    except ValueError:
        failures.append(f"{path}: invalid ISO date {value!r}")
        return None
    return value


def finite_numbers(value, path: str, failures: list[str]) -> None:
    if isinstance(value, bool) or value is None:
        return
    if isinstance(value, (int, float)):
        if not math.isfinite(value):
            failures.append(f"{path}: non-finite number")
    elif isinstance(value, dict):
        for key, item in value.items():
            finite_numbers(item, f"{path}.{key}", failures)
    elif isinstance(value, list):
        for index, item in enumerate(value):
            finite_numbers(item, f"{path}[{index}]", failures)


def validate_dated_rows(rows: list, label: str, failures: list[str], *, ohlcv=False,
                        key_fields: tuple[str, ...] = ("date",),
                        required_fields: tuple[str, ...] = ("date",),
                        numeric_fields: tuple[str, ...] = ()) -> None:
    previous = None
    seen = set()
    for i, row in enumerate(rows):
        where = f"{label}.data[{i}]"
        if not isinstance(row, dict):
            failures.append(f"{where}: expected object")
            continue
        for field in required_fields:
            if row.get(field) is None:
                failures.append(f"{where}.{field}: required non-null field")
        for field in numeric_fields:
            value = row.get(field)
            if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)):
                failures.append(f"{where}.{field}: expected finite number or null")
        day = iso_day(row.get("date"), where, failures)
        key_valid = True
        for field in key_fields:
            if field != "date" and (not isinstance(row.get(field), str) or not row[field].strip()):
                failures.append(f"{where}.{field}: key must be a nonempty string")
                key_valid = False
        if day is not None:
            if key_valid:
                key = tuple(row.get(field) for field in key_fields)
                if key in seen:
                    failures.append(f"{where}: duplicate key {key}")
                seen.add(key)
            if previous is not None and day < previous:
                failures.append(f"{where}: unsorted date {day} after {previous}")
            previous = day
        if ohlcv:
            for field in ("open", "high", "low", "close", "volume"):
                v = row.get(field)
                if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
                    failures.append(f"{where}.{field}: required finite number")
        finite_numbers(row, where, failures)


def validate_object(obj, label: str, failures: list[str], contract: dict | None = None) -> None:
    if not isinstance(obj, (dict, list)):
        failures.append(f"{label}: root must be an object or array")
        return
    if isinstance(obj, dict):
        if obj.get("updated") is not None:
            stamp = obj["updated"]
            try:
                if "T" in stamp:
                    datetime.fromisoformat(stamp)
                else:
                    date.fromisoformat(stamp)
            except (TypeError, ValueError):
                failures.append(f"{label}.updated: invalid ISO timestamp")
        rows = obj.get("data")
        profile = (contract or {}).get("profile")
        if profile in ("dated_rows", "ohlcv") and not isinstance(rows, list):
            failures.append(f"{label}: expected data array for {profile}")
        if isinstance(rows, list):
            if profile in ("dated_rows", "ohlcv") or (
                rows and isinstance(rows[0], dict) and "date" in rows[0]
            ):
                if profile in ("dated_rows", "ohlcv") and not rows and not (contract or {}).get("allow_empty", False):
                    failures.append(f"{label}: required data rows are empty")
                ohlcv = profile == "ohlcv"
                composite = tuple((contract or {}).get("key_fields") or
                                  {"WSJ_PE.json": ("date", "ticker"),
                                   "earnings.json": ("date", "ticker", "type"),
                                   "margin_global_cn.json": ("date", "exchange")}.get(label, ("date",)))
                required = tuple((contract or {}).get("required_fields") or composite)
                validate_dated_rows(rows, label, failures, ohlcv=ohlcv,
                                    key_fields=composite, required_fields=required,
                                    numeric_fields=tuple((contract or {}).get("numeric_fields", ())))
            elif rows and any(isinstance(r, dict) and "date" in r for r in rows):
                failures.append(f"{label}: inconsistent date row schema")
        # Some source contracts use a map of symbol -> rows; others use data=null
        # while retaining separately named collections. They are heterogeneous.
        unit = (contract or {}).get("unit_metadata")
        if unit and unit["contains"] not in str(obj.get(unit["field"], "")):
            failures.append(f"{label}: wrong unit metadata (expected {unit['contains']})")
        meta = obj.get("meta")
        if isinstance(meta, dict) and "points" in meta and isinstance(obj.get("labels"), list):
            if meta["points"] != len(obj["labels"]):
                failures.append(f"{label}: coverage metadata points disagrees with labels")
    finite_numbers(obj, label, failures)


def validate_forward_pe_rows(rows: list[dict], label: str, failures: list[str]) -> None:
    previous = None
    seen_dates = set()
    seen_asof = set()
    required = ("date", "ticker", "price_asof", "forward_pe", "forward_pe_fy2", "forward_pe_ntm",
                "coverage_fy2", "coverage_ntm", "constituents_used_fy2", "constituents_used_ntm",
                "constituents_total", "valid_fy2", "valid_ntm", "valid")
    for i, row in enumerate(rows):
        where = f"{label}:{i+1}"
        if not isinstance(row, dict):
            failures.append(f"{where}: expected object")
            continue
        missing = set(required) - row.keys()
        if missing:
            failures.append(f"{where}: missing {sorted(missing)}")
            continue
        day = iso_day(row["date"], where, failures)
        if day:
            if day in seen_dates:
                failures.append(f"{where}: duplicate date")
            if previous is not None and day < previous:
                failures.append(f"{where}: unsorted date")
            seen_dates.add(day)
            previous = day
        asof = row["price_asof"]
        if asof is not None:
            if iso_day(asof, f"{where}.price_asof", failures):
                if asof in seen_asof:
                    failures.append(f"{where}: duplicate price_asof")
                seen_asof.add(asof)
        ticker = row["ticker"]
        if not isinstance(ticker, str) or ticker not in ("VOO", "QQQ") or ticker.lower() not in label:
            failures.append(f"{where}: ticker/path mismatch")
        coverage_ok = {}
        for field in ("coverage_fy2", "coverage_ntm", "fx_failed_weight"):
            value = row.get(field)
            # fetch_forward_pe.compute() sums source weights without renormalizing;
            # scraped percentages can sum to 100.05%, as in the current QQQ cache.
            cap = 1.01 if field.startswith("coverage_") else 1.0
            ok = isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and 0 <= value <= cap
            if field != "fx_failed_weight" or value is not None:
                coverage_ok[field] = ok
            if not ok and (field != "fx_failed_weight" or value is not None):
                failures.append(f"{where}.{field}: expected source weight in [0,{cap}]")
        for field in ("forward_pe", "forward_pe_fy2", "forward_pe_ntm"):
            value = row[field]
            if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)):
                failures.append(f"{where}.{field}: expected finite number or null")
        total = row["constituents_total"]
        if isinstance(total, bool) or not isinstance(total, int) or total < 0:
            failures.append(f"{where}.constituents_total: invalid count")
        else:
            for basis in ("fy2", "ntm"):
                used = row[f"constituents_used_{basis}"]
                if isinstance(used, bool) or not isinstance(used, int) or not 0 <= used <= total:
                    failures.append(f"{where}.constituents_used_{basis}: invalid coverage count")
                valid = row[f"valid_{basis}"]
                pe = row[f"forward_pe_{basis}"]
                coverage = row[f"coverage_{basis}"]
                if not isinstance(valid, bool) or (valid and (
                    not coverage_ok.get(f"coverage_{basis}", False) or coverage < 0.95
                    or isinstance(pe, bool) or not isinstance(pe, (int, float)) or not math.isfinite(pe)
                )):
                    failures.append(f"{where}.valid_{basis}: conflicts with 0.95 coverage rule")
        if any(not isinstance(row[f], bool) for f in ("valid", "valid_fy2", "valid_ntm")):
            failures.append(f"{where}: valid flags must be boolean")
        finite_numbers(row, where, failures)


def validate_forward_pe(path: Path, failures: list[str]) -> None:
    rows = []
    for i, line in enumerate(path.read_text().splitlines(), 1):
        if not line.strip():
            failures.append(f"{path.name}:{i}: blank JSONL line")
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError as exc:
            failures.append(f"{path.name}:{i}: invalid JSONL ({exc})")
    validate_forward_pe_rows(rows, path.name, failures)


def validate_directory(data_dir: Path, *, shrink_from_head: bool = False,
                       baseline_dir: Path | None = None, macro: bool = True,
                       allow_partial: bool = False) -> tuple[int, list[str]]:
    failures: list[str] = []
    if not data_dir.is_dir():
        return 0, [f"{data_dir}: data directory does not exist"]
    manifest = json.loads((ROOT / "scripts/source_manifest.json").read_text())
    try:
        contracts, required = expand_contracts(ROOT, manifest)
    except (ValueError, OSError, SyntaxError, KeyError) as exc:
        return 0, [f"source contracts: {exc}"]
    files = sorted(data_dir.glob("*.json"))
    if not files:
        failures.append(f"{data_dir}: no root JSON files")
    names = {path.name for path in files}
    if not allow_partial:
        failures.extend(f"{name}: required stock output missing" for name in sorted(required - names))
    if baseline_dir is not None:
        if not baseline_dir.is_dir():
            failures.append(f"{baseline_dir}: baseline directory does not exist")
        else:
            failures.extend(f"{name}: missing from current data (present in baseline)"
                            for name in sorted({path.name for path in baseline_dir.glob('*.json')} - names))
    for path in files:
        label = path.name
        raw = path.read_text()
        if any(line.startswith(CONFLICT_MARKERS) for line in raw.splitlines()):
            failures.append(f"{label}: git conflict marker found")
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError as exc:
            failures.append(f"{label}: invalid JSON ({exc})")
            continue
        validate_object(obj, label, failures, contracts.get(label))
        previous = None
        if baseline_dir and (baseline_dir / label).exists():
            try:
                previous = (baseline_dir / label).read_text()
            except OSError as exc:
                failures.append(f"{label}: cannot read baseline ({exc})")
        elif shrink_from_head:
            previous = git_show_head(f"data/{label}")
        if previous is not None:
            try:
                prev_rows = row_count(json.loads(previous))
                current = row_count(obj)
                if prev_rows >= MIN_PREV_ROWS and current < prev_rows * SHRINK_RATIO:
                    failures.append(f"{label}: row count collapsed {prev_rows} -> {current}")
            except json.JSONDecodeError:
                failures.append(f"{label}: invalid baseline JSON")
    for path in sorted(data_dir.glob("forward_pe_*.jsonl")):
        validate_forward_pe(path, failures)
    if macro and (data_dir / "us_macro_archive/manifest.json").exists():
        try:
            import validate_us_macro
            validate_us_macro.validate(data_dir)
        except Exception as exc:
            failures.append(f"us_macro_archive: {type(exc).__name__}: {exc}")
    return len(files), failures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=DATA_DIR)
    parser.add_argument("--baseline-dir", type=Path)
    parser.add_argument("--no-shrink", action="store_true", help="skip comparison with HEAD")
    parser.add_argument("--allow-partial", action="store_true", help="validate existing known files without requiring all stock outputs (fixtures only)")
    args = parser.parse_args()
    count, failures = validate_directory(args.data_dir, shrink_from_head=not args.no_shrink,
                                         baseline_dir=args.baseline_dir,
                                         allow_partial=args.allow_partial)
    for failure in failures:
        print("FAIL:", failure)
    if not failures:
        print(f"Data validation passed ({count} root JSON files, JSONL and macro archive if present).")
    return bool(failures)


if __name__ == "__main__":
    sys.exit(main())
