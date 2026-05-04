"""Fetch US Treasury yield data (10Y, 2Y) from FRED public CSV API.

No API key required. Data updated daily on business days.
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

SERIES = {
    "DGS10": "US10Y",  # 10-Year Treasury Constant Maturity Rate
    "DGS2":  "US2Y",   # 2-Year Treasury Constant Maturity Rate
    "M2SL":  "M2",     # M2 Money Stock, seasonally adjusted, billions USD, monthly
}


def fetch_fred(series_id: str) -> list[dict]:
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}"
    resp = requests.get(url, timeout=30, headers={"User-Agent": "PersonalFiance/1.0"})
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


def main() -> None:
    print(f"Fetching {len(SERIES)} yield series from FRED ...")
    for series_id, stem in SERIES.items():
        try:
            rows = fetch_fred(series_id)
            out  = DATA_DIR / f"{stem}.json"
            out.write_text(json.dumps({
                "symbol":  stem,
                "updated": date.today().isoformat(),
                "data":    rows,
            }, ensure_ascii=False) + "\n")
            print(f"  [{series_id}] wrote {len(rows)} rows -> {out.name}")
        except Exception as exc:
            print(f"  [{series_id}] FAILED: {exc}")
            continue


if __name__ == "__main__":
    main()
