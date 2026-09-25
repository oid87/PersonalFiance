"""Compute S&P 500 market breadth: % of stocks above 50-day and 200-day MA.

Output: data/breadth.json
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
OUT_PATH = DATA_DIR / "breadth.json"

MIN_COVERAGE = 480   # ~95% of S&P 500; drop RECENT days below this (yfinance often
                      # hasn't filled all ~500 names yet → shrunk denominator spikes %).


def get_sp500_tickers() -> list[str]:
    url  = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
    html = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=30).text
    tables  = pd.read_html(StringIO(html), header=0)
    tickers = tables[0]["Symbol"].tolist()
    return [t.replace(".", "-") for t in tickers]  # BRK.B → BRK-B for yfinance


if __name__ == "__main__":
    _breadth.run(
        get_tickers=get_sp500_tickers,
        out_path=OUT_PATH,
        min_coverage=MIN_COVERAGE,
        label="S&P 500",
    )
