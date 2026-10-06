#!/usr/bin/env python3
"""Validate the independent VOO/QQQ JSONL and derived chart payloads."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from validate_data import validate_forward_pe, validate_object

ROOT = Path(__file__).resolve().parent.parent


def validate(data_dir: Path) -> list[str]:
    failures = []
    for ticker in ("voo", "qqq"):
        series_path = data_dir / f"forward_pe_{ticker}.jsonl"
        chart_path = data_dir / f"chart_{ticker}.json"
        if not series_path.exists() or not chart_path.exists():
            failures.append(f"{ticker}: JSONL or chart missing")
            continue
        validate_forward_pe(series_path, failures)
        try:
            rows = [json.loads(line) for line in series_path.read_text().splitlines()]
            chart = json.loads(chart_path.read_text())
            validate_object(chart, chart_path.name, failures)
            if chart.get("labels") != [r["date"] for r in rows if isinstance(r, dict) and "date" in r]:
                failures.append(f"{ticker}: chart labels do not match JSONL dates")
            if chart.get("meta", {}).get("ticker") != ticker.upper():
                failures.append(f"{ticker}: chart ticker metadata mismatch")
        except (ValueError, KeyError, TypeError) as exc:
            failures.append(f"{ticker}: invalid chart/JSONL relationship ({exc})")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    args = parser.parse_args()
    errors = validate(args.data_dir)
    for error in errors:
        print("FAIL:", error)
    if not errors:
        print("Forward P/E validation passed.")
    return bool(errors)


if __name__ == "__main__":
    sys.exit(main())
