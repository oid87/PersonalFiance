"""Fetch US Treasury yield curve + inversion spreads from FRED public CSV API (no API key required).

Outputs:
  data/yield_curve.json — Treasury yields across maturities + 10Y-2Y / 10Y-3M spreads (daily, %)
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

# (FRED series id, output field name)
CURVE_SERIES = [
    ("DGS3MO", "dgs3mo"),
    ("DGS2", "dgs2"),
    ("DGS5", "dgs5"),
    ("DGS10", "dgs10"),
    ("DGS30", "dgs30"),
    ("T10Y2Y", "t10y2y"),
    ("T10Y3M", "t10y3m"),
]


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


def merge_many(series_rows: dict[str, list[dict]]) -> list[dict]:
    """Union-join multiple series by date. Missing values -> None."""
    maps = {key: {r["date"]: r["value"] for r in rows} for key, rows in series_rows.items()}
    all_dates = sorted(set().union(*[m.keys() for m in maps.values()]))
    result = []
    for d in all_dates:
        row = {"date": d}
        for key in series_rows:
            row[key] = maps[key].get(d)
        result.append(row)
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
    print("Fetching yield curve data from FRED ...")

    try:
        series_rows = {}
        for series_id, key in CURVE_SERIES:
            series_rows[key] = fetch_fred(series_id)
            print(f"  {series_id} ({key}): {len(series_rows[key])} rows fetched")

        new_rows = merge_many(series_rows)
        out = DATA_DIR / "yield_curve.json"
        merged = idempotent_merge(out, new_rows)
        today_str = date.today().isoformat()
        merged = [r for r in merged if r["date"] <= today_str]  # 防來源前瞻公告未來日
        out.write_text(json.dumps({
            "source": "FRED (Federal Reserve Bank of St. Louis)",
            "note": (
                "US Treasury Constant Maturity yields (%, daily): "
                "dgs3mo=DGS3MO 3-Month, dgs2=DGS2 2-Year, dgs5=DGS5 5-Year, "
                "dgs10=DGS10 10-Year, dgs30=DGS30 30-Year. "
                "Inversion spreads (%, daily, can be negative): "
                "t10y2y=T10Y2Y (10Y minus 2Y Treasury yield), "
                "t10y3m=T10Y3M (10Y minus 3M Treasury yield). "
                "Missing values are null (no forward-fill; weekends/holidays have no data). "
                "Series start dates vary: DGS10 ~1962, T10Y2Y ~1976, T10Y3M ~1982 (earlier rows null)."
            ),
            "updated": date.today().isoformat(),
            "data": merged,
        }, ensure_ascii=False) + "\n")
        print(f"  yield_curve.json: {len(merged)} rows")
    except Exception as exc:
        print(f"  yield_curve FAILED: {exc}")


if __name__ == "__main__":
    main()
