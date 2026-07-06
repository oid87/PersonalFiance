"""Fetch monthly liquidity-panel data → data/liquidity.json

Two engines, monthly cadence (macro = 環境理解，非交易觸發):
  • Net liquidity (Fed-supplied "fuel")  = WALCL − TGA − RRP   — FRED, no API key
  • US margin debt (private leverage)                          — FINRA Margin Statistics xlsx

FRED net-liquidity components come in MIXED native units and are normalized to
USD billions here (see UNIT_TO_B) — the classic net-liquidity mistake is
subtracting millions from billions. A magnitude sanity-check guards against it.

M2 / US2Y are already fetched by fetch_yields.py; DXY by fetch_stocks.py — this
script only adds what nothing else provides: the net-liquidity components and the
FINRA margin-debt series. Each section degrades gracefully: if one source is down
the previously-committed section is kept rather than wiped.

Output (units documented in payload "note"):
  {source, note, updated,
   netliq:     [{date, value}],                       # USD billions, date = month-start YYYY-MM-01
   components: {walcl, tga, rrp: [{date, value}]},    # USD billions
   margin:     [{date, debit, cash, margin}]}         # USD millions (raw FINRA)
"""
from __future__ import annotations

import csv
import io
import json
import re
from collections import OrderedDict
from datetime import date
from pathlib import Path

import pandas as pd
import requests

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)
OUT = DATA_DIR / "liquidity.json"

# FRED net-liquidity components — native units differ, normalize to USD billions.
#   WALCL      Fed total assets (Wednesday level)  — native Millions  → ÷1000
#   WTREGEN    Treasury General Account (TGA)       — native Millions  → ÷1000
#   RRPONTSYD  Overnight reverse repo (ON RRP)      — native Billions  → ×1
# Factors verified empirically at build time via the per-series magnitude print
# below + the netliq sanity band; adjust here if FRED ever changes a series' unit.
FRED = OrderedDict([("WALCL", "walcl"), ("WTREGEN", "tga"), ("RRPONTSYD", "rrp")])
UNIT_TO_B = {"WALCL": 1 / 1000, "WTREGEN": 1 / 1000, "RRPONTSYD": 1.0}

FINRA_URL = "https://www.finra.org/sites/default/files/2021-03/margin-statistics.xlsx"
FINRA_PAGE = "https://www.finra.org/rules-guidance/key-topics/margin-accounts/margin-statistics"
UA = {"User-Agent": "PersonalFiance/1.0"}


def month_start(date_str: str) -> str:
    return date_str[:7] + "-01"


def fetch_fred_monthly(series_id: str) -> "OrderedDict[str, float]":
    """Return {YYYY-MM-01: value_in_billions}, keeping each month's LAST observation."""
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}"
    resp = requests.get(url, timeout=30, headers=UA)
    resp.raise_for_status()
    factor = UNIT_TO_B[series_id]
    by_month: "OrderedDict[str, float]" = OrderedDict()
    for row in csv.DictReader(io.StringIO(resp.text)):
        d = row.get("observation_date", "").strip()
        v = row.get(series_id, "").strip()
        if not d or v in (".", ""):
            continue
        try:
            by_month[month_start(d)] = round(float(v) * factor, 2)  # later row (same month) wins
        except ValueError:
            continue
    return by_month


def _get_finra_xlsx() -> bytes:
    """Fetch the FINRA margin-statistics xlsx; fall back to scraping the page link.

    The direct URL has a Drupal upload folder ('2021-03') baked into the path —
    its content updates monthly, but if FINRA ever moves the file the path 404s.
    On a non-xlsx response we scrape the public page for the current .xlsx href.
    """
    r = requests.get(FINRA_URL, timeout=30, headers=UA)
    if r.status_code == 200 and r.content[:2] == b"PK":  # PK = zip = xlsx magic
        return r.content
    page = requests.get(FINRA_PAGE, timeout=30, headers=UA)
    page.raise_for_status()
    m = re.search(r'href="([^"]*margin-statistics[^"]*\.xlsx)"', page.text)
    if not m:
        raise RuntimeError(f"FINRA xlsx unreachable ({r.status_code}) and no link on page")
    href = m.group(1)
    if href.startswith("/"):
        href = "https://www.finra.org" + href
    r2 = requests.get(href, timeout=30, headers=UA)
    r2.raise_for_status()
    print(f"  [margin]  direct URL failed; recovered link from page: {href}")
    return r2.content


def fetch_margin_debt() -> list[dict]:
    """FINRA Margin Statistics → [{date, debit, cash, margin}] in USD millions, month-start dates.

    Columns (positional, robust to header wording):
      0 Year-Month | 1 Debit Balances | 2 Free Credit Cash | 3 Free Credit Securities Margin
    """
    df = pd.read_excel(io.BytesIO(_get_finra_xlsx()), engine="openpyxl")
    ym, debit, cash, margin = df.columns[:4]
    rows = []
    for _, r in df.iterrows():
        ymv = str(r[ym]).strip()
        if not re.match(r"^\d{4}-\d{2}", ymv):
            continue
        try:
            rows.append({
                "date":   ymv[:7] + "-01",
                "debit":  int(round(float(r[debit]))),
                "cash":   int(round(float(r[cash]))),
                "margin": int(round(float(r[margin]))),
            })
        except (ValueError, TypeError):
            continue
    return sorted(rows, key=lambda x: x["date"])


def load_seed_margin() -> list[dict]:
    """Static pre-2010 FINRA margin history — the live xlsx no longer serves it."""
    p = DATA_DIR / "finra_margin_early.json"
    return json.loads(p.read_text())["data"]


def load_existing() -> dict:
    if not OUT.exists():
        return {}
    try:
        return json.loads(OUT.read_text())
    except Exception:
        return {}


def main() -> None:
    existing = load_existing()

    # ── 1. FRED net-liquidity components (monthly, billions) ─────────────────
    netliq: list[dict] = existing.get("netliq", [])
    components: dict = existing.get("components", {})
    try:
        comp = {}
        for sid, stem in FRED.items():
            comp[stem] = fetch_fred_monthly(sid)
            last = next(reversed(comp[stem]))
            print(f"  [{sid:9}] {len(comp[stem])} months · latest {last} = {comp[stem][last]:,.1f} B")

        # Net liquidity over the contiguous WALCL∩TGA span (both monthly back to 2003);
        # ON RRP only became material in 2013, so absent RRP months count as 0 — this
        # keeps a continuous line instead of holes where the early RRP series is sparse.
        months = sorted(set(comp["walcl"]) & set(comp["tga"]))
        netliq = [{"date": m, "value": round(comp["walcl"][m] - comp["tga"][m] - comp["rrp"].get(m, 0.0), 2)}
                  for m in months]
        components = {k: [{"date": m, "value": v} for m, v in comp[k].items()] for k in comp}
        if netliq:
            nl = netliq[-1]
            print(f"  [netliq]   {len(netliq)} months · latest {nl['date']} = {nl['value'] / 1000:,.2f} T")
            if not (2000 <= nl["value"] <= 9000):  # post-2013 net liquidity lives in ~$3–8T
                print(f"  ⚠ netliq {nl['value']} B outside sane 2000–9000 B band — CHECK FRED UNITS")
    except Exception as exc:
        if not netliq:
            raise
        print(f"  [FRED]    FAILED ({exc}); keeping {len(netliq)} existing netliq months")

    # ── 2. FINRA margin debt (monthly, millions) ─────────────────────────────
    margin: list[dict] = existing.get("margin", [])
    try:
        live = fetch_margin_debt()
        seed = load_seed_margin()
        merged = {r["date"]: r for r in seed}
        merged.update({r["date"]: r for r in live})  # live 覆蓋 seed（若日期重疊）
        margin = sorted(merged.values(), key=lambda x: x["date"])
        md = margin[-1]
        print(f"  [margin]   {len(margin)} months (含 {len(seed)} 筆回補) · latest {md['date']} debit = {md['debit']:,} M "
              f"(${md['debit'] / 1e6:.3f} T)")
    except Exception as exc:
        if not margin:
            raise
        print(f"  [FINRA]   FAILED ({exc}); keeping {len(margin)} existing margin months")

    payload = {
        "source": "FRED WALCL/WTREGEN/RRPONTSYD (net liquidity) + FINRA Margin Statistics (US margin debt)",
        "note": ("Monthly. netliq & components in USD billions "
                 "(WALCL native millions ÷1000; TGA/RRP native billions). "
                 "margin debit/cash/margin in USD millions (raw FINRA). "
                 "Net liquidity = Fed total assets − TGA − ON RRP."),
        "updated": date.today().isoformat(),
        "netliq": netliq,
        "components": components,
        "margin": margin,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    print(f"Wrote {OUT.name}: netliq {len(netliq)} · margin {len(margin)} months")


if __name__ == "__main__":
    main()
