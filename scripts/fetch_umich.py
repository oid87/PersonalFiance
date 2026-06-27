"""Fetch University of Michigan Consumer Sentiment (UMCSENT) + NBER recessions + SPY monthly
→ data/umich.json

Sources (all free, no API key):
  FRED UMCSENT  — monthly CSI, 1978-01 to present
  FRED USREC    — monthly NBER recession indicator (1=recession), 1854-01 to present
  yfinance SPY  — adjusted monthly close, 1993-01 to present

Output data/umich.json:
  {source, note, updated,
   umich: [{date, csi}],              # monthly, 1978+
   recessions: [{start, end}],        # NBER periods overlapping UMCSENT range
   spy: [{date, close}]}              # monthly SPY adj close, 1993+
"""
from __future__ import annotations

import csv
import io
import json
from collections import OrderedDict
from datetime import date, timedelta
from pathlib import Path

import requests
import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)
OUT = DATA_DIR / "umich.json"

UA = {"User-Agent": "PersonalFiance/1.0"}
FRED_CSV = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={id}"


def fetch_fred(series_id: str) -> "OrderedDict[str, float]":
    url = FRED_CSV.format(id=series_id)
    resp = requests.get(url, timeout=30, headers=UA)
    resp.raise_for_status()
    result: "OrderedDict[str, float]" = OrderedDict()
    reader = csv.DictReader(io.StringIO(resp.text))
    date_col = reader.fieldnames[0] if reader.fieldnames else "DATE"
    val_col  = reader.fieldnames[1] if len(reader.fieldnames or []) > 1 else series_id
    for row in reader:
        d = (row.get(date_col) or "").strip()
        v = (row.get(val_col)  or "").strip()
        if len(d) == 10 and v not in ("", "."):
            try:
                result[d] = float(v)
            except ValueError:
                pass
    return result


def recessions_from_usrec(usrec: "OrderedDict[str, float]") -> list[dict]:
    """Convert USREC 0/1 monthly series into [{start, end}] pairs."""
    periods: list[dict] = []
    in_rec = False
    start = ""
    for d, v in usrec.items():
        if v == 1 and not in_rec:
            in_rec = True
            start = d
        elif v == 0 and in_rec:
            in_rec = False
            # end = first month *after* recession (exclusive upper bound for markArea)
            periods.append({"start": start, "end": d})
    if in_rec:
        # ongoing recession — end = today
        periods.append({"start": start, "end": date.today().isoformat()})
    return periods


def fetch_spy_monthly() -> list[dict]:
    ticker = yf.Ticker("SPY")
    hist = ticker.history(start="1993-01-01", interval="1mo", auto_adjust=True)
    rows: list[dict] = []
    for ts, row in hist.iterrows():
        d = ts.strftime("%Y-%m-%d")
        c = round(float(row["Close"]), 2)
        if c > 0:
            rows.append({"date": d, "close": c})
    return sorted(rows, key=lambda r: r["date"])


def load_existing() -> dict:
    if not OUT.exists():
        return {}
    try:
        return json.loads(OUT.read_text())
    except Exception:
        return {}


def main() -> None:
    existing = load_existing()

    try:
        umcsent = fetch_fred("UMCSENT")
        usrec   = fetch_fred("USREC")
        spy_monthly = fetch_spy_monthly()
    except Exception as exc:
        if existing:
            print(f"  [UMich] FAILED ({exc}); keeping existing data")
            return
        raise

    umich_rows = [{"date": d, "csi": round(v, 2)} for d, v in umcsent.items()]
    recessions  = recessions_from_usrec(usrec)

    # merge spy: existing by date → update with fresh
    old_spy = {r["date"]: r["close"] for r in existing.get("spy", [])}
    for r in spy_monthly:
        old_spy[r["date"]] = r["close"]
    spy_rows = [{"date": d, "close": c} for d, c in sorted(old_spy.items())]

    last = umich_rows[-1]
    prev_year = next((r["csi"] for r in reversed(umich_rows[:-13]) if True), None)

    payload = {
        "source": (
            "FRED UMCSENT (University of Michigan Consumer Sentiment, monthly) · "
            "FRED USREC (NBER recession indicator) · "
            "yfinance SPY adjusted monthly close"
        ),
        "note": (
            "UMCSENT: monthly survey of ~500 US households, base 1966:Q1=100. "
            "USREC: 1=NBER-defined recession. "
            "SPY: total-return adjusted monthly close (1993+). "
            "All three are aligned to month-start dates."
        ),
        "updated": date.today().isoformat(),
        "umich": umich_rows,
        "recessions": recessions,
        "spy": spy_rows,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    print(f"  [UMich] {len(umich_rows)} months · latest {last['date']} CSI={last['csi']}"
          f" · {len(recessions)} recession periods · {len(spy_rows)} SPY months")


if __name__ == "__main__":
    main()
