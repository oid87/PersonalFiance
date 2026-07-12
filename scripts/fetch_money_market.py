"""Fetch US overnight rate data from FRED public CSV API (no API key required).

Outputs:
  data/money_market.json — SOFR / IORB / EFFR overnight rates (daily, %) + sofr_iorb spread
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


def merge_three(sofr_rows: list[dict], iorb_rows: list[dict], effr_rows: list[dict]) -> list[dict]:
    """Union-join three series by date; compute sofr_iorb spread when both present."""
    sofr_map = {r["date"]: r["value"] for r in sofr_rows}
    iorb_map = {r["date"]: r["value"] for r in iorb_rows}
    effr_map = {r["date"]: r["value"] for r in effr_rows}
    all_dates = sorted(set(sofr_map) | set(iorb_map) | set(effr_map))
    result = []
    for d in all_dates:
        sofr = sofr_map.get(d)
        iorb = iorb_map.get(d)
        effr = effr_map.get(d)
        sofr_iorb = round(sofr - iorb, 4) if sofr is not None and iorb is not None else None
        result.append({
            "date": d,
            "sofr": sofr,
            "iorb": iorb,
            "effr": effr,
            "sofr_iorb": sofr_iorb,
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
    print("Fetching money market overnight rate data from FRED ...")

    try:
        sofr = fetch_fred("SOFR")   # Secured Overnight Financing Rate (%), 2018-04+
        iorb = fetch_fred("IORB")   # Interest Rate on Reserve Balances (%), 2021-07+ (earlier IOER not fetched)
        effr = fetch_fred("EFFR")   # Effective Federal Funds Rate (%), longest history
        print(f"  SOFR rows: {len(sofr)}, IORB rows: {len(iorb)}, EFFR rows: {len(effr)}")

        new_rows = merge_three(sofr, iorb, effr)
        today_str = date.today().isoformat()
        new_rows = [r for r in new_rows if r["date"] <= today_str]
        out = DATA_DIR / "money_market.json"
        merged = idempotent_merge(out, new_rows)
        merged = [r for r in merged if r["date"] <= today_str]
        out.write_text(json.dumps({
            "source": "FRED (SOFR, IORB, EFFR)",
            "note": (
                "Overnight rates (%). SOFR = Secured Overnight Financing Rate (FRED SOFR, "
                "2018-04+, collateralized). IORB = Interest Rate on Reserve Balances (FRED IORB, "
                "2021-07+; earlier period called IOER, not fetched here, so iorb is null before "
                "2021-07). EFFR = Effective Federal Funds Rate (FRED EFFR, longest history). "
                "sofr_iorb = SOFR - IORB, only computed when both have a value that day, else null. "
                "This is the primary stress signal: SOFR meaningfully above IORB (a spike, sofr_iorb > 0 "
                "and elevated) indicates secured overnight funding market stress / repo market strain "
                "(e.g. the September 2019 repo crisis type event)."
            ),
            "updated": date.today().isoformat(),
            "data": merged,
        }, ensure_ascii=False) + "\n")
        print(f"  money_market.json: {len(merged)} rows")
    except Exception as exc:
        print(f"  money_market FAILED: {exc}")


if __name__ == "__main__":
    main()
