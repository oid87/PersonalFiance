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
   data: [{date, fsi, credit, equity, safe, funding, vol, us, adv, em}]}
  # daily, total + 5 categories + 3 regional contributions (US / other advanced / emerging).
  # The 3 regions are a SEPARATE orthogonal decomposition from the 5 categories — they do
  # NOT sum to the headline `fsi` (max observed gap ~0.108, not rounding). Do not treat the
  # regional columns as an additive breakdown or plot them as a stacked area.
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

# CSV header → output key. Headline + the five category contributions (sum to headline,
# to rounding — MacroMicro's 五大細項).
COLS = OrderedDict([
    ("OFR FSI", "fsi"),
    ("Credit", "credit"),
    ("Equity valuation", "equity"),
    ("Safe assets", "safe"),
    ("Funding", "funding"),
    ("Volatility", "vol"),
])

# Regional breakdown — a SEPARATE orthogonal decomposition, NOT part of the 5-category
# sum above. Kept as its own mapping so a missing/renamed region column fails loudly
# (see the fieldnames check in fetch_rows) without touching the category sanity check.
REGION_COLS = OrderedDict([
    ("United States", "us"),
    ("Other advanced economies", "adv"),
    ("Emerging markets", "em"),
])


def fetch_rows() -> "OrderedDict[str, dict]":
    """Return {date: {date, fsi, credit, equity, safe, funding, vol, us, adv, em}} keyed by date."""
    resp = requests.get(FSI_URL, timeout=30, headers=UA)
    resp.raise_for_status()
    reader = csv.DictReader(io.StringIO(resp.text))
    fieldnames = reader.fieldnames or []
    # Regional columns are new (2026-07-25 addition) and OFR could rename/drop them without
    # notice; fail loudly instead of silently dropping the region fields for every row.
    missing = [src for src in REGION_COLS if src not in fieldnames]
    if missing:
        raise RuntimeError(f"OFR FSI CSV missing expected region columns {missing} (header={fieldnames})")

    by_date: "OrderedDict[str, dict]" = OrderedDict()
    for row in reader:
        d = (row.get("Date") or "").strip()
        if len(d) != 10:
            continue
        rec = {"date": d}
        ok = True
        for src, key in list(COLS.items()) + list(REGION_COLS.items()):
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

    # info only (NOT a sanity gate): the 3 regions are a different decomposition from the
    # 5 categories and do not sum to the headline (observed gap up to ~0.108, not rounding).
    recon_region = last["us"] + last["adv"] + last["em"]
    diff_region = recon_region - last["fsi"]
    print(f"  [OFR FSI] regional sum {recon_region:+.3f} vs headline {last['fsi']:+.3f} "
          f"(diff {diff_region:+.3f} — expected, regions are a separate non-additive decomposition)")

    payload = {
        "source": "OFR Financial Stress Index (financialresearch.gov)",
        "note": ("Daily. Total OFR FSI plus its five category contributions "
                 "(credit / equity valuation / safe assets / funding / volatility), "
                 "which sum to the headline (to rounding, max diff ~0.002). Also includes "
                 "three regional contributions (us / adv / em — United States / other advanced "
                 "economies / emerging markets): this is a SEPARATE orthogonal decomposition "
                 "and does NOT sum to the headline (max observed diff ~0.108, not rounding) — "
                 "do not treat it as an additive breakdown. 0 = historical average; "
                 ">0 elevated stress."),
        "updated": date.today().isoformat(),
        "data": data,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    print(f"Wrote {OUT.name}: {len(data)} daily rows")


if __name__ == "__main__":
    main()
