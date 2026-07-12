"""Fetch Fed net liquidity from FRED public CSV API (no API key required).

Net liquidity = WALCL (Fed total assets) - WTREGEN (Treasury General Account)
                - RRPONTSYD (overnight reverse repo, converted to $mm)

Series (all three FRED series turn out to have data back to 2003-02-07,
so that is the effective start date once forward-filled/intersected):
  WALCL      — Fed total assets (weekly, $millions)
  WTREGEN    — Treasury General Account balance (weekly, $millions)
  RRPONTSYD  — Overnight Reverse Repo, Treasury securities (daily, $billions)

⚠️ Unit trap: WALCL/WTREGEN are reported by FRED in $millions; RRPONTSYD is
reported in $billions. RRPONTSYD is multiplied by 1000 before subtracting so
all four output fields (walcl/tga/rrp/net_liq) are in $millions.

Weekly series (WALCL/WTREGEN) are forward-filled onto the daily date union
using "most recent value at or before that date". A date is only emitted
once all three series have at least one historical observation available
(i.e. we skip dates before the latest of the three series' first dates).

Output: data/net_liquidity.json
  {source, note, updated, data: [{date, walcl, tga, rrp, net_liq}]}
"""
from __future__ import annotations

import bisect
import csv
import io
import json
from datetime import date
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)
OUT = DATA_DIR / "net_liquidity.json"

UA = {"User-Agent": "PersonalFiance/1.0"}


def fetch_fred(series_id: str) -> list[dict]:
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}"
    resp = requests.get(url, timeout=30, headers=UA)
    resp.raise_for_status()
    rows = []
    reader = csv.DictReader(io.StringIO(resp.text))
    for row in reader:
        date_str = (row.get("observation_date") or "").strip()
        val_str = (row.get(series_id) or "").strip()
        if not date_str or val_str in (".", ""):
            continue
        try:
            rows.append({"date": date_str, "value": round(float(val_str), 4)})
        except ValueError:
            continue
    return sorted(rows, key=lambda r: r["date"])


def forward_fill_lookup(rows: list[dict]):
    """Return (dates_sorted, values_sorted) plus a lookup(date) -> last value at/before date, or None."""
    dates = [r["date"] for r in rows]
    values = [r["value"] for r in rows]

    def lookup(d: str):
        idx = bisect.bisect_right(dates, d) - 1
        if idx < 0:
            return None
        return values[idx]

    return lookup


def load_existing() -> dict[str, dict]:
    if not OUT.exists():
        return {}
    try:
        payload = json.loads(OUT.read_text())
        return {r["date"]: r for r in payload.get("data", []) if r.get("date")}
    except Exception:
        return {}


def idempotent_merge(existing: dict[str, dict], new_rows: list[dict]) -> list[dict]:
    merged = dict(existing)
    for r in new_rows:
        merged[r["date"]] = r
    return sorted(merged.values(), key=lambda r: r["date"])


def main() -> None:
    existing = load_existing()
    print("Fetching net liquidity series (WALCL, WTREGEN, RRPONTSYD) from FRED ...")

    try:
        walcl_rows = fetch_fred("WALCL")       # Fed total assets, weekly, $mm
        wtregen_rows = fetch_fred("WTREGEN")   # TGA balance, weekly, $mm
        rrp_rows = fetch_fred("RRPONTSYD")     # Overnight RRP, daily, $bn

        print(f"  WALCL: {len(walcl_rows)} rows, WTREGEN: {len(wtregen_rows)} rows, "
              f"RRPONTSYD: {len(rrp_rows)} rows")

        walcl_lookup = forward_fill_lookup(walcl_rows)
        wtregen_lookup = forward_fill_lookup(wtregen_rows)
        rrp_lookup = forward_fill_lookup(rrp_rows)

        all_dates = sorted(
            set(r["date"] for r in walcl_rows)
            | set(r["date"] for r in wtregen_rows)
            | set(r["date"] for r in rrp_rows)
        )

        new_rows = []
        for d in all_dates:
            walcl = walcl_lookup(d)
            tga = wtregen_lookup(d)
            rrp_bn = rrp_lookup(d)
            if walcl is None or tga is None or rrp_bn is None:
                continue  # skip until all three series have at least one historical value
            rrp_mm = round(rrp_bn * 1000, 4)
            net_liq = round(walcl - tga - rrp_mm, 4)
            new_rows.append({
                "date": d,
                "walcl": walcl,
                "tga": tga,
                "rrp": rrp_mm,
                "net_liq": net_liq,
            })

        merged = idempotent_merge(existing, new_rows)

        payload = {
            "source": "FRED (St. Louis Fed) — WALCL / WTREGEN / RRPONTSYD",
            "note": (
                "Net liquidity = WALCL - WTREGEN - RRPONTSYD. All four output fields "
                "(walcl/tga/rrp/net_liq) are in $millions. WALCL (Fed total assets) and "
                "WTREGEN (Treasury General Account) are reported by FRED in $millions and "
                "are weekly; forward-filled onto the daily date union using the most recent "
                "value at or before each date. RRPONTSYD (overnight reverse repo) is reported "
                "in $billions and daily — multiplied by 1000 to convert to $millions before "
                "subtracting. A date is only emitted once all three series have at least one "
                "historical observation."
            ),
            "updated": date.today().isoformat(),
            "data": merged,
        }
        OUT.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
        print(f"  net_liquidity.json: {len(merged)} rows")
        if merged:
            first, last = merged[0], merged[-1]
            print(f"  Window: {first['date']} ~ {last['date']}")
            print(f"  Latest: walcl={last['walcl']}, tga={last['tga']}, rrp={last['rrp']}, "
                  f"net_liq={last['net_liq']}")
    except Exception as exc:
        print(f"  net_liquidity FAILED: {exc}")
        if not existing:
            raise


if __name__ == "__main__":
    main()
