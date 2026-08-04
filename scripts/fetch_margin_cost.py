"""Fetch US margin-cost benchmark rates (daily) → data/margin_cost.json

Sources (FRED public CSV endpoint, no API key required — same helper style as
fetch_liquidity.py's fetch_fred_monthly, adapted here to DAILY granularity
since these are daily rate series, not monthly stock/flow series):
  SOFR    — Secured Overnight Financing Rate (collateralized, FRED since 2018-04)
  EFFR    — Effective Federal Funds Rate, NY Fed methodology (FRED since 2000-07)
  IORB    — Interest Rate on Reserve Balances (FRED since 2021-07; earlier period
            was called IOER, not fetched here — iorb is null before 2021-07)
  SOFR99  — SOFR 99th percentile, tail/stress read (FRED since 2018-04, same
            start as SOFR; confirmed reachable via direct fredgraph.csv probe,
            no fallback to SOFR75 needed)
  DFF     — Effective Federal Funds Rate, H.15 methodology (FRED since 1954-07)
            → field "ffr", the long-history margin-cost proxy used to extend
            coverage back to 1990 (added per follow-up spec: SOFR-only history
            is too short — only 2018+ — for the drawdown-vs-cost analysis in
            js/tabs/margincost.js to have enough independent market-low samples)

Output data/margin_cost.json:
  {source, note, updated,
   data: [{date, sofr, effr, iorb, sofr99, ffr, sofr_iorb_spread}]}

  sofr_iorb_spread = (sofr - iorb) * 100, in bp; null if either side is null.
  Data starts 1990-01-01. Before ~2000-07 (effr)/2018-04 (sofr/sofr99)/2021-07
  (iorb) those fields are null and only `ffr` (DFF) has a value — this is
  EXPECTED (DFF is the only series with history back to 1954), not a data gap.

Idempotent merge: existing rows are re-unioned with freshly-fetched rows by
date; if a series' fetch fails this run, its field falls back to the existing
row's value (or stays null) rather than wiping already-committed history. If
ALL fetches fail and there is no existing file, the exception propagates
(nothing to fall back to).
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
OUT = DATA_DIR / "margin_cost.json"

UA = {"User-Agent": "PersonalFiance/1.0"}
START_DATE = "1990-01-01"

# FRED series id → output field name
FRED_SERIES = OrderedDict([
    ("SOFR", "sofr"),
    ("EFFR", "effr"),
    ("IORB", "iorb"),
    ("SOFR99", "sofr99"),
    ("DFF", "ffr"),
])


def fetch_fred_daily(series_id: str) -> "OrderedDict[str, float]":
    """Return {YYYY-MM-DD: value} for a daily FRED series (no API key)."""
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}"
    resp = requests.get(url, timeout=30, headers=UA)
    resp.raise_for_status()
    out: "OrderedDict[str, float]" = OrderedDict()
    for row in csv.DictReader(io.StringIO(resp.text)):
        d = row.get("observation_date", "").strip()
        v = row.get(series_id, "").strip()
        if not d or v in (".", ""):
            continue
        try:
            out[d] = round(float(v), 4)
        except ValueError:
            continue
    return out


def load_existing_rows() -> "OrderedDict[str, dict]":
    if not OUT.exists():
        return OrderedDict()
    try:
        payload = json.loads(OUT.read_text())
        return OrderedDict((r["date"], r) for r in payload.get("data", []) if r.get("date"))
    except Exception:
        return OrderedDict()


def main() -> None:
    existing = load_existing_rows()

    series_data: dict[str, "OrderedDict[str, float]"] = {}
    any_ok = False
    for sid, field in FRED_SERIES.items():
        try:
            series_data[field] = fetch_fred_daily(sid)
            any_ok = True
            last = next(reversed(series_data[field])) if series_data[field] else None
            print(f"  [{sid:8}] {len(series_data[field])} obs"
                  + (f" · latest {last} = {series_data[field][last]}" if last else ""))
        except Exception as exc:
            series_data[field] = OrderedDict()
            print(f"  [{sid:8}] FAILED ({exc}); field '{field}' falls back to existing values this run")

    if not any_ok and not existing:
        raise RuntimeError("All FRED fetches failed and no existing margin_cost.json to fall back on")

    all_dates = set(existing)
    for d in series_data.values():
        all_dates.update(d)
    all_dates = {d for d in all_dates if d >= START_DATE}

    today_str = date.today().isoformat()
    merged: "OrderedDict[str, dict]" = OrderedDict()
    for d in sorted(all_dates):
        if d > today_str:
            continue
        old = existing.get(d, {})
        sofr = series_data["sofr"].get(d, old.get("sofr"))
        effr = series_data["effr"].get(d, old.get("effr"))
        iorb = series_data["iorb"].get(d, old.get("iorb"))
        sofr99 = series_data["sofr99"].get(d, old.get("sofr99"))
        ffr = series_data["ffr"].get(d, old.get("ffr"))
        spread = round((sofr - iorb) * 100, 2) if (sofr is not None and iorb is not None) else None
        merged[d] = {
            "date": d,
            "sofr": sofr,
            "effr": effr,
            "iorb": iorb,
            "sofr99": sofr99,
            "ffr": ffr,
            "sofr_iorb_spread": spread,
        }

    data = [merged[d] for d in sorted(merged)]
    payload = {
        "source": "FRED SOFR/EFFR/IORB/SOFR99/DFF (fredgraph.csv, no API key)",
        "note": (
            "Daily. sofr/effr/iorb/sofr99/ffr are annualized rates in percent. "
            "sofr_iorb_spread = (sofr - iorb) * 100, in bp; null if either side is null. "
            "ffr = DFF (Effective Federal Funds Rate, H.15 methodology, FRED since 1954-07) — "
            "the long-history margin-cost proxy. Data starts 1990-01-01; sofr/sofr99 are null "
            "before 2018-04, effr before 2000-07, iorb before 2021-07 (only ffr has values that "
            "far back) — this is expected, not a data gap. effr here is the NY Fed EFFR series "
            "(distinct source/methodology from ffr/DFF; the two track closely but are not identical)."
        ),
        "updated": today_str,
        "data": data,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    print(f"Wrote {OUT.name}: {len(data)} rows")


if __name__ == "__main__":
    main()
