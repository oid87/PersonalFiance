"""Fetch US TIPS real yield data from FRED public CSV API (no API key required).

Outputs:
  data/real_rates.json — TIPS real yields (5Y/10Y/30Y, daily, %)
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


def merge_three(a_rows: list[dict], b_rows: list[dict], c_rows: list[dict],
                 a_key: str, b_key: str, c_key: str) -> list[dict]:
    """Union-join three series by date; missing values become null."""
    a_map = {r["date"]: r["value"] for r in a_rows}
    b_map = {r["date"]: r["value"] for r in b_rows}
    c_map = {r["date"]: r["value"] for r in c_rows}
    all_dates = sorted(set(a_map) | set(b_map) | set(c_map))
    result = []
    for d in all_dates:
        result.append({
            "date": d,
            a_key: a_map.get(d),
            b_key: b_map.get(d),
            c_key: c_map.get(d),
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
    print("Fetching TIPS real yield data from FRED ...")

    try:
        dfii5 = fetch_fred("DFII5")    # 5-Year Treasury Inflation-Indexed Security, Real Yield (%)
        dfii10 = fetch_fred("DFII10")  # 10-Year Treasury Inflation-Indexed Security, Real Yield (%)
        dfii30 = fetch_fred("DFII30")  # 30-Year Treasury Inflation-Indexed Security, Real Yield (%)
        new_rows = merge_three(dfii5, dfii10, dfii30, "dfii5", "dfii10", "dfii30")
        out = DATA_DIR / "real_rates.json"
        merged = idempotent_merge(out, new_rows)
        out.write_text(json.dumps({
            "source": "FRED DFII5 / DFII10 / DFII30",
            "note": (
                "TIPS 實質殖利率(名目殖利率 - 通膨預期),單位 %,日頻。"
                "實質殖利率為正 = 貨幣政策實質偏緊;為負 = 實質偏鬆。"
                "dfii5=5年期、dfii10=10年期、dfii30=30年期,缺值為 null(非強制填補)。"
            ),
            "updated": date.today().isoformat(),
            "data": merged,
        }, ensure_ascii=False) + "\n")
        print(f"  real_rates.json: {len(merged)} rows")
    except Exception as exc:
        print(f"  real_rates FAILED: {exc}")


if __name__ == "__main__":
    main()
