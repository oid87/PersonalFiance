"""Fetch US breakeven inflation expectations from FRED → data/inflation_exp.json

Series:
  T5YIE   — 5-Year Breakeven Inflation Rate (daily, 2003+)
  T10YIE  — 10-Year Breakeven Inflation Rate (daily, 2003+)
  T5YIFR  — 5-Year, 5-Year Forward Inflation Expectation Rate (daily, 2003+)

All derived from TIPS vs nominal Treasury spreads.
Free, no API key, FRED CSV endpoint.

Output: {source, note, updated,
         data: [{date, be5y, be10y, fwd5y5y}]}
"""
from __future__ import annotations

import csv
import io
import json
from collections import OrderedDict
from datetime import date
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)
OUT = DATA_DIR / "inflation_exp.json"

UA = {"User-Agent": "PersonalFiance/1.0"}

SERIES = OrderedDict([
    ("T5YIE",  "be5y"),
    ("T10YIE", "be10y"),
    ("T5YIFR", "fwd5y5y"),
])


def fetch_fred_csv(series_id: str) -> dict[str, float]:
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}"
    resp = requests.get(url, timeout=30, headers=UA)
    resp.raise_for_status()
    by_date: dict[str, float] = {}
    reader = csv.DictReader(io.StringIO(resp.text))
    for row in reader:
        d = (row.get("observation_date") or "").strip()
        v = (row.get(series_id) or "").strip()
        if len(d) != 10 or v in ("", "."):
            continue
        try:
            by_date[d] = round(float(v), 4)
        except ValueError:
            continue
    return by_date


def load_existing() -> OrderedDict[str, dict]:
    if not OUT.exists():
        return OrderedDict()
    try:
        payload = json.loads(OUT.read_text())
        return OrderedDict((r["date"], r) for r in payload.get("data", []) if r.get("date"))
    except Exception:
        return OrderedDict()


def main() -> None:
    existing = load_existing()
    print(f"Fetching {len(SERIES)} breakeven series from FRED ...")

    maps: dict[str, dict[str, float]] = {}
    for sid, key in SERIES.items():
        try:
            m = fetch_fred_csv(sid)
            maps[key] = m
            print(f"  [{sid}] {len(m)} daily rows")
        except Exception as exc:
            print(f"  [{sid}] FAILED: {exc}")
            maps[key] = {}

    all_dates = sorted(set().union(*(m.keys() for m in maps.values())))
    if not all_dates:
        if existing:
            print("  All fetches failed; keeping existing data")
            return
        raise RuntimeError("No data fetched from any series")

    merged = OrderedDict(existing)
    for d in all_dates:
        vals = {key: maps[key].get(d) for key in SERIES.values()}
        if all(v is None for v in vals.values()):
            continue
        rec = {"date": d}
        for key, v in vals.items():
            if v is not None:
                rec[key] = v
        if len(rec) > 1:
            merged[d] = rec

    data = [merged[d] for d in sorted(merged)]

    last = data[-1]
    parts = []
    for sid, key in SERIES.items():
        if key in last:
            parts.append(f"{sid}={last[key]:.2f}%")
    print(f"  Latest {last['date']}: {', '.join(parts)}")
    print(f"  Total: {len(data)} daily rows")

    payload = {
        "source": "FRED (St. Louis Fed) — TIPS-derived breakeven inflation rates",
        "note": ("Daily. T5YIE = 5-Year breakeven, T10YIE = 10-Year breakeven, "
                 "T5YIFR = 5-Year 5-Year forward. All in %. Higher = market expects "
                 "more inflation. 2003+."),
        "updated": date.today().isoformat(),
        "data": data,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    print(f"Wrote {OUT.name}: {len(data)} daily rows")


if __name__ == "__main__":
    main()
