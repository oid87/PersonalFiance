"""Compute Nasdaq-100 market breadth: % of stocks above 50-day and 200-day MA.

Output: data/breadth_ndx.json
Strategy:
  - No existing file → full backfill (download 3 years of history)
  - Stale existing   → incremental (download last 350 cal. days, recompute tail)
  - Fresh existing   → skip
"""
from __future__ import annotations

from io import StringIO
from pathlib import Path

import pandas as pd
import requests

import _breadth

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
OUT_PATH = DATA_DIR / "breadth_ndx.json"

MIN_COVERAGE = 95    # ~95% of Nasdaq-100 (~101 tickers); drop RECENT days below this (yfinance
                      # often hasn't filled all names yet → shrunk denominator spikes %).


def get_nasdaq100_tickers() -> list[str]:
    # The "Nasdaq-100" article no longer carries the components table (broke 2026-07);
    # the constituents live on this separate list page (same "Ticker" column).
    url  = "https://en.wikipedia.org/wiki/List_of_NASDAQ-100_companies"
    html = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=30).text
    tables = pd.read_html(StringIO(html), header=0)
    table  = next(t for t in tables if "Ticker" in t.columns)
    tickers = table["Ticker"].tolist()
    return [t.replace(".", "-") for t in tickers]


if __name__ == "__main__":
    _breadth.run(
        get_tickers=get_nasdaq100_tickers,
        out_path=OUT_PATH,
        min_coverage=MIN_COVERAGE,
        label="Nasdaq-100",
    )
