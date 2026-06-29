"""Fetch US credit market data from FRED public CSV API (no API key required).

Outputs:
  data/credit_spread.json  — ICE BofA HY/IG OAS (daily, 1996+, %)
  data/delinquency.json    — Credit card + real estate delinquency (quarterly, %)
"""
from __future__ import annotations

import csv
import io
import json
from datetime import date
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)

HEADERS = {"User-Agent": "PersonalFiance/1.0"}


def fetch_fred(series_id: str) -> list[dict]:
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}"
    resp = requests.get(url, timeout=30, headers=HEADERS)
    resp.raise_for_status()
    rows = []
    reader = csv.DictReader(io.StringIO(resp.text))
    for row in reader:
        date_str = row.get("observation_date", "").strip()
        val_str  = row.get(series_id, "").strip()
        if not date_str or val_str in (".", ""):
            continue
        try:
            rows.append({"date": date_str, "value": round(float(val_str), 4)})
        except ValueError:
            continue
    return sorted(rows, key=lambda r: r["date"])


def merge_two(a_rows: list[dict], b_rows: list[dict], a_key: str, b_key: str) -> list[dict]:
    """Inner-join two series by date."""
    b_map = {r["date"]: r["value"] for r in b_rows}
    result = []
    for r in a_rows:
        d = r["date"]
        if d in b_map:
            result.append({"date": d, a_key: r["value"], b_key: b_map[d]})
    return result


def idempotent_merge(existing_path: Path, new_rows: list[dict], key_field: str = "date") -> list[dict]:
    existing = {}
    if existing_path.exists():
        try:
            for r in json.loads(existing_path.read_text()).get("data", []):
                existing[r[key_field]] = r
        except Exception:
            pass
    for r in new_rows:
        existing[r[key_field]] = r
    return sorted(existing.values(), key=lambda r: r[key_field])


def main() -> None:
    print("Fetching credit market data from FRED ...")

    # 1. Daily HY + IG OAS spreads
    try:
        hy = fetch_fred("BAMLH0A0HYM2")   # ICE BofA US HY Option-Adjusted Spread (%)
        ig = fetch_fred("BAMLC0A0CM")      # ICE BofA US IG Option-Adjusted Spread (%)
        new_rows = merge_two(hy, ig, "hy", "ig")
        out = DATA_DIR / "credit_spread.json"
        merged = idempotent_merge(out, new_rows)
        out.write_text(json.dumps({
            "updated": date.today().isoformat(),
            "note": "ICE BofA HY/IG Option-Adjusted Spread (%). FRED BAMLH0A0HYM2 / BAMLC0A0CM",
            "data": merged,
        }, ensure_ascii=False) + "\n")
        print(f"  credit_spread.json: {len(merged)} rows")
    except Exception as exc:
        print(f"  credit_spread FAILED: {exc}")

    # 2. Quarterly delinquency rates
    try:
        cc = fetch_fred("DRCCLACBS")    # Credit Card Delinquency Rate (%)
        re = fetch_fred("DRSFRMACBS")   # Single-Family Residential Mortgage Delinquency (%)
        new_rows2 = merge_two(cc, re, "credit_card", "real_estate")
        out2 = DATA_DIR / "delinquency.json"
        merged2 = idempotent_merge(out2, new_rows2)
        out2.write_text(json.dumps({
            "updated": date.today().isoformat(),
            "note": "US Delinquency Rates (%). FRED DRCCLACBS / DRSFRMACBS (quarterly, SA)",
            "data": merged2,
        }, ensure_ascii=False) + "\n")
        print(f"  delinquency.json: {len(merged2)} rows")
    except Exception as exc:
        print(f"  delinquency FAILED: {exc}")


if __name__ == "__main__":
    main()
