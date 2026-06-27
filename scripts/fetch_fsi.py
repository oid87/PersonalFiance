"""Fetch the OFR Financial Stress Index → data/fsi.json

OFR FSI (US Office of Financial Research) — the exact series MacroMicro plots as
「美國/全球-金融壓力指數[FSI]」. Free, no key, daily back to 2000-01-03.

The index is built so the total = the sum of five category contributions, so the
five 細項 below decompose the headline number exactly (Credit + Equity valuation +
Safe assets + Funding + Volatility ≈ OFR FSI, to rounding). Zero = each variable at
its historical average; >0 = elevated financial stress, <0 = calm.

Source CSV columns:
  Date, OFR FSI, Credit, Equity valuation, Safe assets, Funding, Volatility,
  United States, Other advanced economies, Emerging markets

Output (data/fsi.json), idempotent merge by date (new overwrites old):
  {source, note, updated,
   data: [{date, fsi, credit, equity, safe, funding, vol}]}   # daily, total + 5 categories
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
OUT = DATA_DIR / "fsi.json"

FSI_URL = "https://www.financialresearch.gov/financial-stress-index/data/fsi.csv"
UA = {"User-Agent": "PersonalFiance/1.0"}

# CSV header → output key. Only the headline + the five category contributions;
# regional breakdown (US / advanced / emerging) is left out — the tab decomposes
# by category to match MacroMicro's 五大細項.
COLS = OrderedDict([
    ("OFR FSI", "fsi"),
    ("Credit", "credit"),
    ("Equity valuation", "equity"),
    ("Safe assets", "safe"),
    ("Funding", "funding"),
    ("Volatility", "vol"),
])


def fetch_rows() -> "OrderedDict[str, dict]":
    """Return {date: {date, fsi, credit, equity, safe, funding, vol}} keyed by date."""
    resp = requests.get(FSI_URL, timeout=30, headers=UA)
    resp.raise_for_status()
    by_date: "OrderedDict[str, dict]" = OrderedDict()
    reader = csv.DictReader(io.StringIO(resp.text))
    for row in reader:
        d = (row.get("Date") or "").strip()
        if len(d) != 10:
            continue
        rec = {"date": d}
        ok = True
        for src, key in COLS.items():
            v = (row.get(src) or "").strip()
            if v in ("", "."):
                ok = False
                break
            try:
                rec[key] = round(float(v), 4)
            except ValueError:
                ok = False
                break
        if ok:
            by_date[d] = rec
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
        fresh = fetch_rows()
    except Exception as exc:
        if existing:
            print(f"  [OFR FSI] FAILED ({exc}); keeping {len(existing)} existing rows")
            return
        raise

    merged = OrderedDict(existing)
    for d, rec in fresh.items():
        merged[d] = rec  # new overwrites old (idempotent)
    data = [merged[d] for d in sorted(merged)]

    last = data[-1]
    drivers = sorted(
        (("信用", last["credit"]), ("股票估值", last["equity"]), ("安全資產", last["safe"]),
         ("資金/流動性", last["funding"]), ("波動性", last["vol"])),
        key=lambda kv: -kv[1],
    )
    top = drivers[0]
    print(f"  [OFR FSI] {len(data)} days · latest {last['date']} = {last['fsi']:+.3f} "
          f"(top driver {top[0]} {top[1]:+.3f})")
    # sanity: the five categories should reconstruct the headline (to rounding)
    recon = last["credit"] + last["equity"] + last["safe"] + last["funding"] + last["vol"]
    if abs(recon - last["fsi"]) > 0.05:
        print(f"  ⚠ category sum {recon:+.3f} ≠ headline {last['fsi']:+.3f} — CHECK OFR COLUMNS")

    payload = {
        "source": "OFR Financial Stress Index (financialresearch.gov)",
        "note": ("Daily. Total OFR FSI plus its five category contributions "
                 "(credit / equity valuation / safe assets / funding / volatility), "
                 "which sum to the headline. 0 = historical average; >0 elevated stress."),
        "updated": date.today().isoformat(),
        "data": data,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    print(f"Wrote {OUT.name}: {len(data)} daily rows")


if __name__ == "__main__":
    main()
