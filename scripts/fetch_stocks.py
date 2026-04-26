"""Fetch daily OHLCV for tracked tickers and merge into data/<TICKER>.json.

First run backfills from each ticker's start date; subsequent runs fetch the
last ~14 days and merge by date to stay idempotent.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from pathlib import Path

import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)

GLOBAL_START = "2000-01-01"

# ticker -> (filename stem, listing start date)
TICKERS: dict[str, tuple[str, str]] = {
    "0050.TW": ("0050.TW", "2003-06-30"),
    "VOO":     ("VOO",     "2010-09-09"),
    "QQQ":     ("QQQ",     "1999-03-10"),
    "SPY":     ("SPY",     "1993-01-29"),
    "^VIX":    ("VIX",     "1990-01-02"),
    "GLD":     ("GLD",     "2004-11-18"),
    "GC=F":    ("GCF",     "2000-01-01"),  # Gold Futures (continuous) — 3資產模式用，比GLD早
    "BTC-USD": ("BTC",     "2014-09-17"),
    "TLT":     ("TLT",     "2002-07-30"),  # iShares 20+ Year Treasury Bond ETF
    # Credit spread proxy — used in 情緒 tab
    "HYG":     ("HYG",     "2007-04-11"),  # iShares HY Corporate Bond ETF
    "LQD":     ("LQD",     "2002-07-30"),  # iShares IG Corporate Bond ETF
    # US Sector ETFs (SPDR) — used in 產業輪動 tab
    "XLK":     ("XLK",     "1998-12-22"),  # Technology
    "XLF":     ("XLF",     "1998-12-22"),  # Financials
    "XLV":     ("XLV",     "1998-12-22"),  # Health Care
    "XLE":     ("XLE",     "1998-12-22"),  # Energy
    "XLI":     ("XLI",     "1998-12-22"),  # Industrials
    "XLY":     ("XLY",     "1998-12-22"),  # Consumer Discretionary
    "XLP":     ("XLP",     "1998-12-22"),  # Consumer Staples
    "XLU":     ("XLU",     "1998-12-22"),  # Utilities
    "XLRE":    ("XLRE",    "2015-10-09"),  # Real Estate
    "XLB":     ("XLB",     "1998-12-22"),  # Materials
    "XLC":     ("XLC",     "2018-06-18"),  # Communication Services
    # Semiconductor ETF — used in 五線譜 tab
    "SOXX":    ("SOXX",    "2001-07-10"),  # iShares PHLX Semiconductor ETF
}


def load_existing(path: Path) -> list[dict]:
    if not path.exists():
        return []
    try:
        return json.loads(path.read_text()).get("data", [])
    except Exception:
        return []


def fetch_range(ticker: str, start: str) -> pd.DataFrame:
    df = yf.download(
        ticker,
        start=start,
        end=(date.today() + timedelta(days=1)).isoformat(),
        auto_adjust=False,
        progress=False,
        threads=False,
    )
    if df.empty:
        return df
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    df = df.rename(columns=str.lower).reset_index()
    df["date"] = df["Date"].dt.strftime("%Y-%m-%d")
    return df[["date", "open", "high", "low", "close", "volume"]]


def to_rows(df: pd.DataFrame) -> list[dict]:
    rows: list[dict] = []
    for _, r in df.iterrows():
        if pd.isna(r["close"]):
            continue
        rows.append({
            "date":   r["date"],
            "open":   round(float(r["open"]),   4),
            "high":   round(float(r["high"]),   4),
            "low":    round(float(r["low"]),    4),
            "close":  round(float(r["close"]),  4),
            "volume": int(r["volume"]) if not pd.isna(r["volume"]) else 0,
        })
    return rows


def merge(existing: list[dict], new: list[dict]) -> list[dict]:
    by_date = {row["date"]: row for row in existing}
    for row in new:
        by_date[row["date"]] = row  # new overrides old
    return sorted(by_date.values(), key=lambda r: r["date"])


def update_ticker(ticker: str, stem: str, listing_start: str) -> None:
    out = DATA_DIR / f"{stem}.json"
    existing = load_existing(out)

    if existing:
        last = existing[-1]["date"]
        start = (datetime.fromisoformat(last) - timedelta(days=14)).date().isoformat()
        print(f"  [{ticker}] incremental from {start} ({len(existing)} existing rows)")
    else:
        start = max(GLOBAL_START, listing_start)
        print(f"  [{ticker}] backfill from {start}")

    df = fetch_range(ticker, start)
    if df.empty:
        print(f"  [{ticker}] no rows returned, skipping")
        return

    new_rows = to_rows(df)
    merged = merge(existing, new_rows)

    payload = {
        "symbol":  stem,
        "updated": date.today().isoformat(),
        "data":    merged,
    }
    out.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    print(f"  [{ticker}] wrote {len(merged)} rows -> {out.name}")


def main() -> None:
    print(f"Fetching {len(TICKERS)} tickers ...")
    for ticker, (stem, listing_start) in TICKERS.items():
        try:
            update_ticker(ticker, stem, listing_start)
        except Exception as exc:
            print(f"  [{ticker}] FAILED: {exc}")
            raise


if __name__ == "__main__":
    main()
