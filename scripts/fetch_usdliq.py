"""Fetch USD liquidity stack: FRED H.4.1 (reserves/TGA/swaps) + NY Fed Markets API
(rate corridor TGCR/BGCR, ON RRP counterparties, securities lending, primary
dealer fails) + Treasury Fiscal Data (daily TGA) + TreasuryDirect (bill/note
auctions).

Outputs:
  data/usdliq.json — eight-layer USD liquidity dataset (daily rate corridor +
  ON RRP, weekly H.4.1 balance-sheet levels, seclending, Treasury auctions,
  primary-dealer fails).

Each source is fetched independently inside its own try/except so a single
source failing does not prevent the others from writing data.
"""
from __future__ import annotations

import csv
import io
import json
import time
from datetime import date
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)

HEADERS = {"User-Agent": "PersonalFiance/1.0"}
OUT_PATH = DATA_DIR / "usdliq.json"
TODAY = date.today().isoformat()
DAILY_START = "2013-09-23"  # ON RRP facility start date

DAILY_FIELDS = [
    "date", "sofr", "sofr1", "sofr25", "sofr75", "sofr99", "sofrvol",
    "effr", "effrvol", "obfr", "tgcr", "bgcr", "iorb", "onrrp",
    "onrrp_cpty", "tga", "cp90",
]
WEEKLY_FIELDS = ["date", "reserves", "tga_w", "primary_credit", "swaps", "foreign_rrp"]
SECLENDING_FIELDS = ["date", "submitted", "accepted"]
AUCTION_FIELDS = ["date", "term", "offered", "btc", "high_rate"]
FAILS_FIELDS = ["date", "ftd", "ftr"]

FRED_DAILY = {
    "SOFR": "sofr", "SOFR1": "sofr1", "SOFR25": "sofr25", "SOFR75": "sofr75",
    "SOFR99": "sofr99", "SOFRVOL": "sofrvol", "EFFR": "effr",
    "EFFRVOL": "effrvol", "OBFR": "obfr", "IORB": "iorb",
    "RRPONTSYD": "onrrp", "RIFSPPFAAD90NB": "cp90",
}
FRED_WEEKLY = {
    "WRESBAL": "reserves", "WDTGAL": "tga_w", "WLCFLPCL": "primary_credit",
    "SWPT": "swaps", "WLRRAL": "foreign_rrp",
}


def fetch_fred(series_id: str) -> list[tuple[str, float]]:
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}"
    resp = requests.get(url, timeout=60, headers=HEADERS)
    resp.raise_for_status()
    rows = []
    reader = csv.DictReader(io.StringIO(resp.text))
    for row in reader:
        d = row.get("observation_date", "").strip()
        v = row.get(series_id, "").strip()
        if not d or v in (".", ""):
            continue
        try:
            rows.append((d, float(v)))
        except ValueError:
            continue
    return rows


def year_ranges(start: str, end: str) -> list[tuple[str, str]]:
    """Split [start, end] into per-calendar-year (startDate, endDate) segments."""
    start_year = int(start[:4])
    end_year = int(end[:4])
    ranges = []
    for y in range(start_year, end_year + 1):
        seg_start = start if y == start_year else f"{y}-01-01"
        seg_end = end if y == end_year else f"{y}-12-31"
        ranges.append((seg_start, seg_end))
    return ranges


def idempotent_merge(existing_rows: list[dict], new_rows: list[dict], key_fields: list[str], all_fields: list[str]) -> list[dict]:
    """Field-level merge keyed by key_fields. new_rows only need to carry the
    fields their source actually fetched (plus key fields); any field a row
    already has on disk is preserved unless this run's new_rows explicitly
    supplies a (possibly null) value for it."""
    merged: dict[tuple, dict] = {}
    for r in existing_rows:
        key = tuple(r.get(k) for k in key_fields)
        merged[key] = dict(r)
    for r in new_rows:
        key = tuple(r.get(k) for k in key_fields)
        if key in merged:
            merged[key].update(r)
        else:
            merged[key] = dict(r)
    out = []
    for row in merged.values():
        full = {f: row.get(f) for f in all_fields}
        out.append(full)
    out.sort(key=lambda r: tuple(r[k] for k in key_fields))
    return out


def load_existing() -> dict:
    if OUT_PATH.exists():
        try:
            return json.loads(OUT_PATH.read_text())
        except Exception:
            pass
    return {}


def main() -> None:
    print("Fetching USD liquidity stack ...")
    existing = load_existing()

    daily_acc: dict[str, dict] = {}
    weekly_acc: dict[str, dict] = {}
    seclending_acc: dict[str, dict] = {}
    auctions_acc: dict[tuple, dict] = {}
    fails_acc: dict[str, dict] = {}

    # ---- A. FRED daily rate-corridor / ON RRP / CP series -----------------
    for series_id, field in FRED_DAILY.items():
        try:
            rows = fetch_fred(series_id)
            n = 0
            for d, v in rows:
                if d < DAILY_START or d > TODAY:
                    continue
                daily_acc.setdefault(d, {"date": d})[field] = round(v, 6)
                n += 1
            print(f"  FRED {series_id} -> {field}: {n} rows")
        except Exception as exc:
            print(f"  FRED {series_id} FAILED: {exc}")

    # ---- A2. FRED weekly H.4.1 series (millions -> billions) --------------
    for series_id, field in FRED_WEEKLY.items():
        try:
            rows = fetch_fred(series_id)
            n = 0
            for d, v in rows:
                weekly_acc.setdefault(d, {"date": d})[field] = round(v / 1000.0, 6)
                n += 1
            print(f"  FRED {series_id} -> weekly.{field}: {n} rows")
        except Exception as exc:
            print(f"  FRED {series_id} (weekly) FAILED: {exc}")

    # ---- B1. NY Fed Markets API — TGCR/BGCR --------------------------------
    try:
        url = "https://markets.newyorkfed.org/api/rates/all/search.json"
        params = {"startDate": "2018-04-02", "endDate": TODAY}
        resp = requests.get(url, params=params, timeout=60, headers=HEADERS)
        resp.raise_for_status()
        refrates = resp.json().get("refRates", [])
        n = 0
        for r in refrates:
            t = r.get("type")
            if t not in ("TGCR", "BGCR"):
                continue
            d = r.get("effectiveDate")
            v = r.get("percentRate")
            if not d or v is None or d < DAILY_START:
                continue
            field = "tgcr" if t == "TGCR" else "bgcr"
            daily_acc.setdefault(d, {"date": d})[field] = v
            n += 1
        print(f"  NY Fed TGCR/BGCR: {n} rows")
    except Exception as exc:
        print(f"  NY Fed TGCR/BGCR FAILED: {exc}")

    # ---- B2. NY Fed Markets API — ON RRP counterparty count ----------------
    # Correct endpoint is /api/rp/results/search.json (the "Repo and Reverse
    # Repo Operations / Filter operations" endpoint per markets-api.yml), not
    # /api/rp/reverserepo/propositions/search.json (that one lacks term and
    # acceptedCpty entirely). The operationTypes query filter is not actually
    # honored by the live API (it still returns both Repo and Reverse Repo
    # rows), so operationType=="Reverse Repo" is filtered client-side; verified
    # 2026-07-13 -> acceptedCpty == 2 via this endpoint.
    try:
        total_rows = 0
        for seg_start, seg_end in year_ranges(DAILY_START, TODAY):
            try:
                url = "https://markets.newyorkfed.org/api/rp/results/search.json"
                params = {
                    "startDate": seg_start,
                    "endDate": seg_end,
                    "operationTypes": "Reverse Repo",
                    "term": "overnight",
                }
                resp = requests.get(url, params=params, timeout=60, headers=HEADERS)
                resp.raise_for_status()
                ops = resp.json().get("repo", {}).get("operations", [])
                for op in ops:
                    if op.get("operationType") != "Reverse Repo":
                        continue
                    if op.get("term") != "Overnight":
                        continue
                    d = op.get("operationDate")
                    cpty = op.get("acceptedCpty")
                    if not d:
                        continue
                    if cpty is not None:
                        daily_acc.setdefault(d, {"date": d})["onrrp_cpty"] = cpty
                    total_rows += 1
            except Exception as exc:
                print(f"    ON RRP results {seg_start}..{seg_end} FAILED: {exc}")
            time.sleep(0.3)
        print(f"  NY Fed ON RRP results (acceptedCpty): {total_rows} matching operations")
    except Exception as exc:
        print(f"  NY Fed ON RRP results FAILED: {exc}")

    # ---- B3. NY Fed Markets API — securities lending -----------------------
    SECLENDING_START = "2010-01-01"
    try:
        total_rows = 0
        for seg_start, seg_end in year_ranges(SECLENDING_START, TODAY):
            try:
                url = "https://markets.newyorkfed.org/api/seclending/all/results/summary/search.json"
                params = {"startDate": seg_start, "endDate": seg_end}
                resp = requests.get(url, params=params, timeout=60, headers=HEADERS)
                resp.raise_for_status()
                ops = resp.json().get("seclending", {}).get("operations", [])
                for op in ops:
                    d = op.get("operationDate")
                    submitted = op.get("totalParAmtSubmitted")
                    accepted = op.get("totalParAmtAccepted")
                    if not d:
                        continue
                    row = seclending_acc.setdefault(d, {"date": d})
                    if submitted is not None:
                        row["submitted"] = round(submitted / 1e9, 6)
                    if accepted is not None:
                        row["accepted"] = round(accepted / 1e9, 6)
                    total_rows += 1
            except Exception as exc:
                print(f"    seclending {seg_start}..{seg_end} FAILED: {exc}")
            time.sleep(0.3)
        print(f"  NY Fed seclending: {total_rows} operations")
    except Exception as exc:
        print(f"  NY Fed seclending FAILED: {exc}")

    # ---- B4. NY Fed Markets API — primary dealer fails ---------------------
    for pd_series, field in (("PDFTD-UST", "ftd"), ("PDFTR-UST", "ftr")):
        try:
            url = f"https://markets.newyorkfed.org/api/pd/get/{pd_series}.json"
            resp = requests.get(url, timeout=60, headers=HEADERS)
            resp.raise_for_status()
            ts = resp.json().get("pd", {}).get("timeseries", [])
            n = 0
            for r in ts:
                d = r.get("asofdate")
                v = r.get("value")
                if not d or v is None:
                    continue
                try:
                    val = float(v) / 1000.0
                except (TypeError, ValueError):
                    continue
                fails_acc.setdefault(d, {"date": d})[field] = round(val, 6)
                n += 1
            print(f"  NY Fed {pd_series} -> fails.{field}: {n} rows")
        except Exception as exc:
            print(f"  NY Fed {pd_series} FAILED: {exc}")

    # ---- C. Treasury Fiscal Data — daily TGA -------------------------------
    try:
        url = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/dts/operating_cash_balance"
        params = {
            "fields": "record_date,account_type,open_today_bal",
            "filter": "account_type:eq:Treasury General Account (TGA) Closing Balance,record_date:gte:2022-01-01",
            "sort": "-record_date",
            "page[size]": 10000,
        }
        resp = requests.get(url, params=params, timeout=60, headers=HEADERS)
        resp.raise_for_status()
        rows = resp.json().get("data", [])
        n = 0
        for r in rows:
            d = r.get("record_date")
            v = r.get("open_today_bal")
            if not d or v in (None, "", "null"):
                continue
            try:
                val = float(v) / 1000.0
            except (TypeError, ValueError):
                continue
            daily_acc.setdefault(d, {"date": d})["tga"] = round(val, 6)
            n += 1
        print(f"  Treasury DTS TGA: {n} rows")
    except Exception as exc:
        print(f"  Treasury DTS TGA FAILED: {exc}")

    # ---- D. TreasuryDirect auctions (Bill + Note) --------------------------
    # NOTE: /TA_WS/securities/auctioned?pagesize=... is NOT a real pager — it
    # always returns the same ~89 most-recent-year rows regardless of
    # pagesize/pagenum (verified live: pagesize=50 -> 50 rows, pagesize=500 or
    # pagenum=2 -> still 89 rows, spanning only ~2025-08 to today). The real
    # history lives behind /TA_WS/securities/search?startDate=&endDate=,
    # confirmed to return full data back to 2013 (segmented-by-year total ==
    # single-wide-range total == 4103 rows for Bill+Note 2013-09-23..today,
    # cross-checked two ways). Segmented per year here for smaller responses.
    def to_float(x):
        if x in (None, ""):
            return None
        try:
            return float(x)
        except (TypeError, ValueError):
            return None

    AUCTION_START = DAILY_START  # 2013-09-23, aligned with daily section
    for sec_type in ("Bill", "Note"):
        total_n = 0
        for seg_start, seg_end in year_ranges(AUCTION_START, TODAY):
            try:
                url = "https://www.treasurydirect.gov/TA_WS/securities/search"
                params = {
                    "format": "json",
                    "type": sec_type,
                    "startDate": seg_start,
                    "endDate": seg_end,
                }
                resp = requests.get(url, params=params, timeout=60, headers=HEADERS)
                resp.raise_for_status()
                rows = resp.json()
                for r in rows:
                    auction_date = (r.get("auctionDate") or "").split("T")[0]
                    term = r.get("securityTerm")
                    if not auction_date or not term:
                        continue
                    offered = r.get("offeringAmount")
                    btc = r.get("bidToCoverRatio")
                    high_rate = r.get("highDiscountRate") or r.get("highYield")
                    offered_v = to_float(offered)
                    row = {
                        "date": auction_date,
                        "term": term,
                        "offered": round(offered_v / 1e9, 6) if offered_v is not None else None,
                        "btc": round(to_float(btc), 6) if to_float(btc) is not None else None,
                        "high_rate": round(to_float(high_rate), 6) if to_float(high_rate) is not None else None,
                    }
                    auctions_acc[(auction_date, term)] = row
                    total_n += 1
            except Exception as exc:
                print(f"    TreasuryDirect {sec_type} {seg_start}..{seg_end} FAILED: {exc}")
            time.sleep(0.3)
        print(f"  TreasuryDirect {sec_type} auctions (search, full history): {total_n} rows")

    # ---- Merge + write ------------------------------------------------------
    daily_new = [{k: v for k, v in row.items()} for row in daily_acc.values()]
    weekly_new = list(weekly_acc.values())
    seclending_new = list(seclending_acc.values())
    auctions_new = list(auctions_acc.values())
    fails_new = list(fails_acc.values())

    daily_merged = idempotent_merge(existing.get("daily", []), daily_new, ["date"], DAILY_FIELDS)
    daily_merged = [r for r in daily_merged if r["date"] <= TODAY]
    weekly_merged = idempotent_merge(existing.get("weekly", []), weekly_new, ["date"], WEEKLY_FIELDS)
    seclending_merged = idempotent_merge(existing.get("seclending", []), seclending_new, ["date"], SECLENDING_FIELDS)
    auctions_merged = idempotent_merge(existing.get("auctions", []), auctions_new, ["date", "term"], AUCTION_FIELDS)
    fails_merged = idempotent_merge(existing.get("fails", []), fails_new, ["date"], FAILS_FIELDS)

    out = {
        "source": "FRED / NY Fed Markets API / Treasury Fiscal Data / TreasuryDirect",
        "note": (
            "美元流動性八層;weekly=H.4.1(週三);daily=利率走廊與ON RRP;"
            "單位:金額皆為十億美元(B),利率為%"
        ),
        "updated": TODAY,
        "daily": daily_merged,
        "weekly": weekly_merged,
        "seclending": seclending_merged,
        "auctions": auctions_merged,
        "fails": fails_merged,
    }
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False) + "\n")
    print(
        f"  usdliq.json: daily={len(daily_merged)} weekly={len(weekly_merged)} "
        f"seclending={len(seclending_merged)} auctions={len(auctions_merged)} "
        f"fails={len(fails_merged)}"
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"usdliq FAILED: {exc}")
