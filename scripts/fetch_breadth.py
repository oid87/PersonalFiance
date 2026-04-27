"""Compute S&P 500 market breadth: % of stocks above 50-day and 200-day MA.

Output: data/breadth.json
Strategy:
  - No existing file → full backfill (download 3 years of history)
  - Stale existing   → incremental (download last 350 cal. days, recompute tail)
  - Fresh existing   → skip
"""
from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path

import requests
from io import StringIO

import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
OUT_PATH = DATA_DIR / "breadth.json"

FRESHNESS_DAYS    = 4     # same as isDataFresh() in frontend
FULL_BACKFILL_CAL = 2555  # ~7 calendar years → ~1820 trading days → ~1620 valid after 200-day warmup
INCREMENTAL_CAL   = 350   # enough to compute 200-day MA for recent dates


def get_sp500_tickers() -> list[str]:
    url  = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
    html = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=30).text
    tables  = pd.read_html(StringIO(html), header=0)
    tickers = tables[0]["Symbol"].tolist()
    return [t.replace(".", "-") for t in tickers]  # BRK.B → BRK-B for yfinance


def load_existing() -> list[dict]:
    if not OUT_PATH.exists():
        return []
    try:
        return json.loads(OUT_PATH.read_text()).get("data", [])
    except Exception:
        return []


def fetch_prices(tickers: list[str], start: str) -> pd.DataFrame:
    end = (date.today() + timedelta(days=1)).isoformat()
    print(f"  Downloading {len(tickers)} tickers from {start} to {end} ...")
    df = yf.download(
        tickers,
        start=start,
        end=end,
        auto_adjust=True,
        progress=False,
        threads=True,
    )
    if df.empty:
        raise RuntimeError("yfinance returned empty DataFrame")
    # Multi-level columns: (field, ticker) → keep only "Close"
    if isinstance(df.columns, pd.MultiIndex):
        df = df["Close"]
    df = df.sort_index()
    print(f"  Got {len(df)} trading days × {df.shape[1]} tickers")
    return df


def compute_breadth(price_df: pd.DataFrame) -> list[dict]:
    """Vectorized rolling MA breadth computation."""
    ma50  = price_df.rolling(50,  min_periods=50).mean()
    ma200 = price_df.rolling(200, min_periods=200).mean()

    valid50  = price_df.notna() & ma50.notna()
    valid200 = price_df.notna() & ma200.notna()

    above50  = (price_df > ma50).where(valid50,  False).sum(axis=1)
    above200 = (price_df > ma200).where(valid200, False).sum(axis=1)

    n50  = valid50.sum(axis=1)
    n200 = valid200.sum(axis=1)

    records: list[dict] = []
    for dt in price_df.index:
        v50 = int(n50[dt])
        if v50 == 0:
            continue
        a50  = int(above50[dt])
        v200 = int(n200[dt])
        a200 = int(above200[dt]) if v200 > 0 else None

        records.append({
            "date":           dt.strftime("%Y-%m-%d"),
            "above50_count":  a50,
            "above50_pct":    round(a50 / v50 * 100, 1),
            "above200_count": a200,
            "above200_pct":   round(a200 / v200 * 100, 1) if (v200 > 0 and a200 is not None) else None,
            "total":          v50,
        })
    return records


def merge(existing: list[dict], new_records: list[dict]) -> list[dict]:
    by_date = {r["date"]: r for r in existing}
    for r in new_records:
        by_date[r["date"]] = r
    return sorted(by_date.values(), key=lambda r: r["date"])


def main() -> None:
    existing = load_existing()
    tickers  = get_sp500_tickers()
    print(f"S&P 500 constituent count: {len(tickers)}")

    today = date.today()

    if existing:
        last_date  = existing[-1]["date"]
        days_stale = (today - date.fromisoformat(last_date)).days
        if days_stale <= FRESHNESS_DAYS:
            print(f"Data is fresh (last: {last_date}), skipping.")
            return
        start           = (today - timedelta(days=INCREMENTAL_CAL)).isoformat()
        recompute_from  = (date.fromisoformat(last_date) - timedelta(days=30)).isoformat()
        print(f"Incremental update: download from {start}, recompute from {recompute_from}")
    else:
        start          = (today - timedelta(days=FULL_BACKFILL_CAL)).isoformat()
        recompute_from = None
        print(f"Full backfill: download from {start}")

    prices      = fetch_prices(tickers, start)
    all_records = compute_breadth(prices)

    new_records = (
        [r for r in all_records if r["date"] >= recompute_from]
        if recompute_from else all_records
    )

    merged = merge(existing, new_records)

    payload = {
        "updated": today.isoformat(),
        "data":    merged,
    }
    OUT_PATH.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    print(f"Wrote {len(merged)} rows → {OUT_PATH.name}")
    if merged:
        last = merged[-1]
        print(
            f"Latest ({last['date']}): "
            f"above50={last['above50_pct']}%  "
            f"above200={last.get('above200_pct')}%  "
            f"total={last['total']}"
        )


if __name__ == "__main__":
    main()
