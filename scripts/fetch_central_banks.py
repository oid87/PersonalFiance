"""Fetch major central bank balance sheet data from FRED public CSV API (no API key required).

Outputs:
  data/central_banks.json — Fed / ECB / BOJ total assets (mixed frequency, raw units)

⚠️ Units/currency differ across the three series and must NOT be summed directly:
  - fed: Federal Reserve total assets, millions of USD, weekly (FRED: WALCL)
  - ecb: ECB total assets, millions of EUR, weekly (FRED: ECBASSETSW)
  - boj: Bank of Japan total assets, 100 millions of JPY (億円), monthly (FRED: JPNASSETS)
  Frontend consumers must rebase each series to an index (base=100) before comparing.
  Frequencies also differ (fed/ecb weekly, boj monthly).
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

NOTE = (
    "Central bank total assets, raw units (not directly comparable): "
    "fed=Federal Reserve total assets in millions of USD (weekly, FRED WALCL); "
    "ecb=ECB total assets in millions of EUR (weekly, FRED ECBASSETSW); "
    "boj=Bank of Japan total assets in 100 millions of JPY / oku-yen (monthly, FRED JPNASSETS). "
    "Currencies and units differ across series — do NOT sum directly. "
    "Frontend must rebase each series to an index (base=100) before comparing. "
    "Frequencies also differ: fed/ecb are weekly, boj is monthly."
)


def fetch_fred(series_id: str) -> list[dict]:
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}"
    resp = requests.get(url, timeout=30, headers=HEADERS)
    resp.raise_for_status()
    rows = []
    reader = csv.DictReader(io.StringIO(resp.text))
    for row in reader:
        date_str = row.get("observation_date", "").strip()
        val_str = row.get(series_id, "").strip()
        if not date_str or val_str in (".", ""):
            continue
        try:
            rows.append({"date": date_str, "value": round(float(val_str), 4)})
        except ValueError:
            continue
    return sorted(rows, key=lambda r: r["date"])


def merge_three(fed_rows: list[dict], ecb_rows: list[dict], boj_rows: list[dict]) -> list[dict]:
    """Union-join three series by date. Missing values are null (no forward-fill)."""
    fed_map = {r["date"]: r["value"] for r in fed_rows}
    ecb_map = {r["date"]: r["value"] for r in ecb_rows}
    boj_map = {r["date"]: r["value"] for r in boj_rows}
    all_dates = set(fed_map) | set(ecb_map) | set(boj_map)
    result = []
    for d in sorted(all_dates):
        result.append({
            "date": d,
            "fed": fed_map.get(d),
            "ecb": ecb_map.get(d),
            "boj": boj_map.get(d),
        })
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
    print("Fetching central bank balance sheet data from FRED ...")

    today_str = date.today().isoformat()

    try:
        fed = fetch_fred("WALCL")        # Fed total assets, millions USD, weekly
        ecb = fetch_fred("ECBASSETSW")   # ECB total assets, millions EUR, weekly
        boj = fetch_fred("JPNASSETS")    # BOJ total assets, 100 millions JPY, monthly

        print(f"  WALCL (fed): {len(fed)} rows")
        print(f"  ECBASSETSW (ecb): {len(ecb)} rows")
        print(f"  JPNASSETS (boj): {len(boj)} rows")

        new_rows = merge_three(fed, ecb, boj)

        # Filter out any future-dated rows (FRED sometimes has forward-looking entries)
        new_rows = [r for r in new_rows if r["date"] <= today_str]

        out = DATA_DIR / "central_banks.json"
        merged = idempotent_merge(out, new_rows)
        merged = [r for r in merged if r["date"] <= today_str]

        out.write_text(json.dumps({
            "source": "FRED (WALCL / ECBASSETSW / JPNASSETS)",
            "note": NOTE,
            "updated": today_str,
            "data": merged,
        }, ensure_ascii=False) + "\n")

        print(f"  central_banks.json: {len(merged)} rows")
        if merged:
            last = merged[-1]
            print(f"  last row: {last}")
    except Exception as exc:
        print(f"  central_banks FAILED: {exc}")


if __name__ == "__main__":
    main()
