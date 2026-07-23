"""Fetch St. Louis Fed Financial Stress Index (STLFSI4, weekly) and Kansas City
Fed Financial Stress Index (KCFSI, monthly) → data/stlfsi_kcfsi.json

Two more genuine *financial stress* gauges, complementary to the existing
「金融狀況」(NFCI) and 「金融壓力」(OFR FSI) tabs:
  STLFSI4  St. Louis Fed — weekly (Friday), 1993-12-31+
  KCFSI    Kansas City Fed — monthly (1st of month), 1990-02-01+

Both free, no key, via FRED CSV export.

IMPORTANT: the two series have different native frequencies (weekly vs
monthly) — their date strings almost never coincide, so they are NOT
inner-joined (that would yield an empty set). Instead this script stores the
UNION of dates each series has ever printed a value on; a given row typically
has only one of the two fields non-null, the other is JSON null. Front-end
overlay code must not assume both columns are populated on the same row.

Output (data/stlfsi_kcfsi.json), idempotent merge by date (new overwrites old):
  {source, note, updated,
   data: [{date, stlfsi4, kcfsi}]}   # stlfsi4/kcfsi each nullable
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
OUT = DATA_DIR / "stlfsi_kcfsi.json"

FRED_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}"
UA = {"User-Agent": "PersonalFiance/1.0"}

# FRED series id → output key
SERIES = OrderedDict([
    ("STLFSI4", "stlfsi4"),
    ("KCFSI",   "kcfsi"),
])


def fetch_series(series_id: str) -> "OrderedDict[str, float]":
    """Return {YYYY-MM-DD: value} for one FRED series, skipping missing ('.') obs."""
    resp = requests.get(FRED_URL.format(sid=series_id), timeout=30, headers=UA)
    resp.raise_for_status()
    by_date: "OrderedDict[str, float]" = OrderedDict()
    for row in csv.DictReader(io.StringIO(resp.text)):
        d = (row.get("observation_date") or "").strip()
        v = (row.get(series_id) or "").strip()
        if not d or v in ("", "."):
            continue
        try:
            by_date[d] = round(float(v), 4)
        except ValueError:
            continue
    return by_date


def load_existing() -> "OrderedDict[str, dict]":
    if not OUT.exists():
        return OrderedDict()
    try:
        payload = json.loads(OUT.read_text())
        return OrderedDict((r["date"], r) for r in payload.get("data", []) if r.get("date"))
    except Exception:
        return OrderedDict()


def main() -> None:
    existing = load_existing()
    try:
        per_series = {}
        for sid, key in SERIES.items():
            per_series[key] = fetch_series(sid)
            last_d = next(reversed(per_series[key]))
            print(f"  [{sid:8}] {len(per_series[key])} obs · latest {last_d} = {per_series[key][last_d]:+.4f}")

        # outer join: union of dates across both series (different native
        # frequencies — weekly vs monthly — so an inner join would be empty).
        all_dates = set(per_series["stlfsi4"]) | set(per_series["kcfsi"])
        fresh = OrderedDict(
            (d, {
                "date": d,
                "stlfsi4": per_series["stlfsi4"].get(d),
                "kcfsi": per_series["kcfsi"].get(d),
            })
            for d in sorted(all_dates)
        )
    except Exception as exc:
        if existing:
            print(f"  [STLFSI4/KCFSI] FAILED ({exc}); keeping {len(existing)} existing rows")
            fresh = OrderedDict()
        else:
            raise

    merged = OrderedDict(existing)
    for d, rec in fresh.items():
        merged[d] = rec  # new overwrites old (idempotent)
    data = [merged[d] for d in sorted(merged)]

    if not data:
        raise RuntimeError("no STLFSI4/KCFSI data available (fresh fetch failed and no existing data)")

    last = data[-1]
    print(f"  [STLFSI4/KCFSI] {len(data)} rows (union) · latest {last['date']} "
          f"(stlfsi4={last['stlfsi4']}, kcfsi={last['kcfsi']})")

    payload = {
        "source": "STLFSI4 (St. Louis Fed, FRED, weekly) + KCFSI (Kansas City Fed, FRED, monthly)",
        "note": ("STLFSI4 為週頻(週五);KCFSI 為月頻(每月月初)。兩者原生頻率不同,本檔案用日期"
                 "聯集(outer join)儲存,同一列裡通常只有其中一欄有值,另一欄是 null——前端疊圖時"
                 "各自用自己的日期,不假設兩欄同時有值。0 = 正常水準,>0 偏緊/壓力升高。"),
        "updated": date.today().isoformat(),
        "data": data,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    print(f"Wrote {OUT.name}: {len(data)} rows")


if __name__ == "__main__":
    main()
