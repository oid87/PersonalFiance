"""Compute S&P 500 Top-50 (XLG) market breadth: % of stocks above 50-day and 200-day MA.

Output: data/breadth_xlg.json
Strategy:
  - No existing file → full backfill (download 3 years of history)
  - Stale existing   → incremental (download last 350 cal. days, recompute tail)
  - Fresh existing   → skip
"""
from __future__ import annotations

import json
from datetime import date
from io import StringIO
from pathlib import Path

import pandas as pd
import requests
import yfinance as yf

import _breadth

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
OUT_PATH = DATA_DIR / "breadth_xlg.json"

MIN_COVERAGE = 45    # ~90% of 50 XLG constituents; drop RECENT days below this.
                      # hasn't filled all ~500 names yet → shrunk denominator spikes %).

XLG_MEMBERS_PATH  = DATA_DIR / "xlg_members.json"   # cached top-50 selection (committed)
MEMBERS_STALE_DAYS = 30   # re-rank monthly; daily runs reuse cache (avoids 500 market-cap calls/day)
XLG_SIZE = 50

# Static fallback = current XLG (S&P 500 Top-50) constituents. Used only if Wikipedia OR the
# market-cap ranking fails. Refresh after the annual June S&P reconstitution.
XLG_FALLBACK = [
    "NVDA", "AAPL", "MSFT", "AMZN", "GOOGL", "GOOG", "AVGO", "META", "TSLA", "BRK-B",
    "LLY", "JPM", "WMT", "V", "MA", "XOM", "JNJ", "ORCL", "UNH", "HD",
    "PG", "COST", "NFLX", "BAC", "AMD", "KO", "CVX", "CRM", "MU", "WFC",
    "ABBV", "CSCO", "PM", "LIN", "IBM", "MRK", "GE", "T", "ABT", "INTC",
    "PEP", "ISRG", "AMAT", "CAT", "GS", "MCD", "LRCX", "VZ", "BX", "NOW",
]


def get_sp500_tickers() -> list[str]:
    url  = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
    html = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=30).text
    tables = pd.read_html(StringIO(html), header=0)
    table  = next(t for t in tables if "Symbol" in t.columns)
    return [str(s).replace(".", "-") for s in table["Symbol"].tolist()]


def _load_cached_members() -> list[str] | None:
    if not XLG_MEMBERS_PATH.exists():
        return None
    try:
        obj = json.loads(XLG_MEMBERS_PATH.read_text())
        if (date.today() - date.fromisoformat(obj["updated"])).days > MEMBERS_STALE_DAYS:
            return None
        members = obj.get("tickers", [])
        return members if len(members) >= XLG_SIZE - 5 else None
    except Exception:
        return None


def get_xlg_tickers() -> list[str]:
    """XLG = S&P 500 Top-50 by float-adjusted market cap. Rank S&P 500 by market cap,
    cache the selection (30-day TTL) so daily runs don't re-rank; static fallback on failure."""
    cached = _load_cached_members()
    if cached:
        print(f"  Using cached XLG members ({len(cached)}) from {XLG_MEMBERS_PATH.name}")
        return cached
    try:
        sp500 = get_sp500_tickers()
        caps: dict[str, float] = {}
        for t in sp500:
            try:
                mc = yf.Ticker(t).fast_info["market_cap"]
                if mc:
                    caps[t] = float(mc)
            except Exception:
                continue
        if len(caps) < XLG_SIZE:
            raise RuntimeError(f"only {len(caps)} market caps fetched (< {XLG_SIZE})")
        top = sorted(caps, key=caps.get, reverse=True)[:XLG_SIZE]
        XLG_MEMBERS_PATH.write_text(
            json.dumps({"updated": date.today().isoformat(), "tickers": top},
                       ensure_ascii=False) + "\n")
        print(f"  Ranked {len(caps)} S&P 500 names by market cap → top {XLG_SIZE} "
              f"(cached to {XLG_MEMBERS_PATH.name})")
        return top
    except Exception as exc:
        print(f"  Market-cap ranking failed ({exc}); using static fallback list")
        return XLG_FALLBACK


if __name__ == "__main__":
    _breadth.run(
        get_tickers=get_xlg_tickers,
        out_path=OUT_PATH,
        min_coverage=MIN_COVERAGE,
        label="XLG",
    )
