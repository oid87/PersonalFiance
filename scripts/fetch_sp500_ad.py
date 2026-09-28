"""Self-calculate current-constituent S&P 500 advance/decline → data/sp500_ad.json."""
from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

import _breadth
import _common
from fetch_breadth import get_sp500_tickers, MIN_COVERAGE

ROOT = Path(__file__).resolve().parent.parent
OUT_PATH = ROOT / "data" / "sp500_ad.json"
FULL_START = "2015-12-01"


def compute_ad(price_df: pd.DataFrame) -> list[dict]:
    """Compare adjacent sessions only; finite positive pairs contribute one count."""
    current = price_df.to_numpy(dtype=float)
    previous = current[:-1]
    current = current[1:]
    valid = np.isfinite(current) & np.isfinite(previous) & (current > 0) & (previous > 0)
    with np.errstate(invalid="ignore", over="ignore"):
        delta = current - previous
        flat = np.abs(delta) <= 1e-9 * previous
    advances = (valid & ~flat & (delta > 0)).sum(axis=1)
    declines = (valid & ~flat & (delta < 0)).sum(axis=1)
    unchanged = (valid & flat).sum(axis=1)
    records = []
    for dt, a, d, u in zip(price_df.index[1:], advances, declines, unchanged):
        total = int(a + d + u)
        records.append({"date": dt.strftime("%Y-%m-%d"),
                        "advances": int(a) if total else None,
                        "declines": int(d) if total else None,
                        "unchanged": int(u) if total else None,
                        "total": total if total else None})
    return records


def filter_recent_coverage(rows: list[dict], today: date) -> list[dict]:
    cutoff = (today - timedelta(days=_breadth.RECENT_WINDOW_DAYS)).isoformat()
    return [row for row in rows
            if row["date"] < cutoff or (row["total"] or 0) >= MIN_COVERAGE]


def main() -> None:
    today = date.today()
    existing = _common.load_rows(OUT_PATH)
    start = (date.fromisoformat(existing[-1]["date"]) - timedelta(days=45)).isoformat() if existing else FULL_START
    print(f"{'Incremental update' if existing else 'Full backfill'}: download from {start}")
    tickers = get_sp500_tickers()
    if not tickers:
        raise RuntimeError("No S&P 500 tickers; preserving existing file")
    prices = _breadth.fetch_prices(tickers, start)
    if prices.empty or set(tickers) - set(prices.columns):
        raise RuntimeError("Empty prices or missing downloaded ticker columns; preserving existing file")
    rows = compute_ad(prices)
    if not rows or not any(row["total"] is not None for row in rows):
        raise RuntimeError("No advance/decline rows; preserving existing file")
    filtered = filter_recent_coverage(rows, today)
    if not filtered:
        raise RuntimeError("No sufficiently covered advance/decline rows; preserving existing file")
    print(f"  Dropped {len(rows) - len(filtered)} recent low-coverage day(s)")
    merged = _common.idempotent_merge(OUT_PATH, filtered)
    payload = {"updated": today.isoformat(), "meta": {
        "source": "PersonalFiance 自算：yfinance 調整後收盤 vs 前一交易日",
        "constituentsBasis": "Wikipedia 現任 S&P 500 成分（每次執行當下抓取），非 point-in-time；含倖存者偏誤；舊列為過去各次執行時的成分快照",
        "priceBasis": "yfinance auto_adjust=True 收盤；|Δ|≤1e-9×前收視為平盤",
        "lastDate": merged[-1]["date"], "tickerCount": len(tickers)}, "data": merged}
    OUT_PATH.parent.mkdir(exist_ok=True)
    OUT_PATH.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    print(f"Wrote {len(merged)} rows → {OUT_PATH.name}")


if __name__ == "__main__":
    main()
