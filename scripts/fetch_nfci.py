"""Fetch the Chicago Fed National Financial Conditions Index → data/nfci.json

NFCI (Federal Reserve Bank of Chicago) — a genuine *financial conditions* index,
distinct from the OFR FSI already covered by the 「金融壓力」tab: FSI only departs
from zero when markets are disorderly (a coincident stress gauge), while NFCI spans
the whole tight↔loose spectrum, including the "too loose" asset-bubble-building
phase that FSI is blind to. Free, no key, weekly (Friday) back to ~1971.

Five FRED series, all free/no-key:
  NFCI          headline (subindexes do NOT sum to this — see note below)
  ANFCI         adjusted for economic conditions — a separate line, NOT part of the sum
  NFCIRISK      risk subindex (volatility / funding risk)
  NFCICREDIT    credit subindex (credit conditions)
  NFCILEVERAGE  leverage subindex (debt/equity measures)

0 = each variable at its historical average; >0 = tighter than average financial
conditions, <0 = looser than average (incl. bubble-era over-easing).

Output (data/nfci.json), idempotent merge by date (new overwrites old), inner-join
across the five series (only dates where all five have a value are kept):
  {source, note, updated,
   data: [{date, nfci, anfci, risk, credit, leverage}]}   # weekly (Friday)
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
OUT = DATA_DIR / "nfci.json"

FRED_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}"
UA = {"User-Agent": "PersonalFiance/1.0"}

# FRED series id → output key
SERIES = OrderedDict([
    ("NFCI",         "nfci"),
    ("ANFCI",        "anfci"),
    ("NFCIRISK",     "risk"),
    ("NFCICREDIT",   "credit"),
    ("NFCILEVERAGE", "leverage"),
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
            print(f"  [{sid:12}] {len(per_series[key])} weeks · latest {last_d} = {per_series[key][last_d]:+.4f}")

        # inner join: only dates where all five series have a value
        common_dates = set(per_series["nfci"])
        for key in SERIES.values():
            common_dates &= set(per_series[key])
        fresh = OrderedDict(
            (d, {"date": d, **{key: per_series[key][d] for key in SERIES.values()}})
            for d in sorted(common_dates)
        )
    except Exception as exc:
        if existing:
            print(f"  [NFCI] FAILED ({exc}); keeping {len(existing)} existing rows")
            fresh = OrderedDict()
        else:
            raise

    merged = OrderedDict(existing)
    for d, rec in fresh.items():
        merged[d] = rec  # new overwrites old (idempotent)
    data = [merged[d] for d in sorted(merged)]

    if not data:
        raise RuntimeError("no NFCI data available (fresh fetch failed and no existing data)")

    last = data[-1]
    drivers = sorted(
        (("風險", last["risk"]), ("信用", last["credit"]), ("槓桿", last["leverage"])),
        key=lambda kv: -kv[1],
    )
    top = drivers[0]
    print(f"  [NFCI] {len(data)} weeks · latest {last['date']} = {last['nfci']:+.3f} "
          f"(ANFCI {last['anfci']:+.3f}, top driver {top[0]} {top[1]:+.3f})")

    # sanity: risk + credit + leverage vs headline NFCI. NOTE (verified against Chicago Fed's
    # own FAQ, chicagofed.org nfci-faqs-pdf): each subindex is INDEPENDENTLY renormalized to
    # mean 0 / std 1 over the 1971+ sample, so — unlike OFR FSI's five categories, which are
    # literal additive contributions to its headline — the three NFCI subindexes do NOT sum
    # to the headline even approximately; the gap widens in stress periods (e.g. ~-5.8 in
    # 2008-11). This is a structural property of the index, not a data-quality problem, so we
    # only print an informational warning and never raise on it.
    recon = last["risk"] + last["credit"] + last["leverage"]
    if abs(recon - last["nfci"]) > 0.05:
        print(f"  ⚠ subindex sum {recon:+.3f} ≠ headline {last['nfci']:+.3f} — expected: NFCI "
              f"subindexes are independently normalized (mean 0/std 1 each) and do NOT sum to "
              f"the headline by construction, per Chicago Fed FAQ. Not a data error.")

    payload = {
        "source": "Chicago Fed National Financial Conditions Index (FRED NFCI/ANFCI/NFCIRISK/NFCICREDIT/NFCILEVERAGE)",
        "note": ("Weekly (Friday). Risk/credit/leverage subindexes are each independently "
                 "normalized to mean 0 / std 1 (Chicago Fed FAQ) and do NOT sum to the "
                 "headline NFCI — unlike OFR FSI's categories, they are directional/relative "
                 "decomposition only, not additive contributions. 0 = historical average "
                 "financial conditions; >0 tighter-than-average, <0 looser-than-average. "
                 "ANFCI = adjusted for economic conditions (separate line, not part of the sum)."),
        "updated": date.today().isoformat(),
        "data": data,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    print(f"Wrote {OUT.name}: {len(data)} weekly rows")


if __name__ == "__main__":
    main()
