"""Compute 臺灣50 (0050) market breadth: % of stocks above 50-day and 200-day MA.

Output: data/breadth_tw50.json
Strategy:
  - No existing file → full backfill (download 3 years of history)
  - Stale existing   → incremental (download last 350 cal. days, recompute tail)
  - Fresh existing   → skip
"""
from __future__ import annotations

import json
import re
from datetime import date
from io import StringIO
from pathlib import Path

import pandas as pd
import requests

import _breadth

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
OUT_PATH = DATA_DIR / "breadth_tw50.json"

MIN_COVERAGE = 45    # ~90% of 50 TW50 constituents; drop RECENT days below this.
                      # yfinance hasn't filled all ~50 names yet → shrunk denominator spikes %).

TW50_MEMBERS_PATH  = DATA_DIR / "tw50_members.json"   # cached constituent list (committed)
MEMBERS_STALE_DAYS = 90    # 臺灣50 半年審核一次;季度重抓,日常跑 reuse cache(1 request 而已但避免依賴外站每日可用)
TW50_SIZE = 50

# Static fallback = 臺灣50 constituents (2026-07-09 Wikipedia snapshot). Refresh after the
# semi-annual (3月/9月) index review. Used only if the Wikipedia scrape fails/returns too few.
TW50_FALLBACK = [
    "2345.TW", "3661.TW", "3017.TW", "6919.TW", "5871.TW", "2412.TW", "2308.TW", "2383.TW",
    "4904.TW", "6505.TW", "2881.TW", "2207.TW", "2883.TW", "3008.TW", "2454.TW", "1303.TW",
    "4938.TW", "2382.TW", "5876.TW", "5880.TW", "2330.TW", "1216.TW", "2615.TW", "6669.TW",
    "2609.TW", "2395.TW", "3711.TW", "2357.TW", "2882.TW", "2002.TW", "2891.TW", "2884.TW",
    "2603.TW", "2892.TW", "1301.TW", "2317.TW", "2880.TW", "2059.TW", "2301.TW", "2886.TW",
    "3034.TW", "2912.TW", "2379.TW", "2890.TW", "3045.TW", "2887.TW", "2303.TW", "3231.TW",
    "2327.TW", "2885.TW",
]


def _load_cached_members() -> list[str] | None:
    if not TW50_MEMBERS_PATH.exists():
        return None
    try:
        obj = json.loads(TW50_MEMBERS_PATH.read_text())
        if (date.today() - date.fromisoformat(obj["updated"])).days > MEMBERS_STALE_DAYS:
            return None
        members = obj.get("tickers", [])
        return members if len(members) >= TW50_SIZE - 5 else None
    except Exception:
        return None


def get_tw50_tickers() -> list[str]:
    """0050 = 臺灣50指數 constituents (50 largest TWSE names). Scrape the zh.wikipedia
    constituent table (股票代號 columns, 值形如「臺證所:2330」), append .TW; cache 90 days;
    static fallback on failure."""
    cached = _load_cached_members()
    if cached:
        print(f"  Using cached TW50 members ({len(cached)}) from {TW50_MEMBERS_PATH.name}")
        return cached
    try:
        url  = "https://zh.wikipedia.org/wiki/臺灣50指數"
        html = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=30).text
        tables = pd.read_html(StringIO(html))
        table  = next(t for t in tables if any("股票代號" in str(c) for c in t.columns))
        codes: list[str] = []
        for col in [c for c in table.columns if "股票代號" in str(c)]:
            for v in table[col].tolist():
                m = re.search(r"(\d{4})", str(v))
                if m:
                    code = m.group(1) + ".TW"
                    if code not in codes:
                        codes.append(code)
        if len(codes) < TW50_SIZE - 3:
            raise RuntimeError(f"only {len(codes)} codes parsed from Wikipedia")
        codes = codes[:TW50_SIZE]
        TW50_MEMBERS_PATH.write_text(
            json.dumps({"updated": date.today().isoformat(), "tickers": codes},
                       ensure_ascii=False) + "\n")
        print(f"  Parsed {len(codes)} 臺灣50 constituents from Wikipedia "
              f"(cached to {TW50_MEMBERS_PATH.name})")
        return codes
    except Exception as exc:
        print(f"  Wikipedia TW50 parse failed ({exc}); using static fallback list")
        return TW50_FALLBACK


if __name__ == "__main__":
    _breadth.run(
        get_tickers=get_tw50_tickers,
        out_path=OUT_PATH,
        min_coverage=MIN_COVERAGE,
        label="TW50",
    )
