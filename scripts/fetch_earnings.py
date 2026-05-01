"""Fetch historical + upcoming earnings dates for major large-cap stocks.

Outputs data/earnings.json: { updated, data: [{date, ticker, name, type}] }
type is always "earnings" here; "conference" entries are added by fetch_investor_conf.py.
Dates cover roughly 2 years back + 1 year forward (yfinance limit).
"""
from __future__ import annotations

import json
import time
from datetime import date
from pathlib import Path

import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)

# ticker -> display name shown in chart tooltip
EARNINGS_TICKERS: dict[str, str] = {
    "AAPL":    "Apple",
    "MSFT":    "Microsoft",
    "NVDA":    "NVIDIA",
    "AMZN":    "Amazon",
    "META":    "Meta",
    "TSLA":    "Tesla",
    "GOOGL":   "Alphabet",
    "AVGO":    "Broadcom",
    "TSM":     "TSMC",
    # Taiwan-listed (yfinance .TW suffix)
    "2308.TW": "台達電",
    "2454.TW": "聯發科",
    "2317.TW": "鴻海",
}


def fetch_earnings(ticker: str, name: str) -> list[dict]:
    t = yf.Ticker(ticker)
    ed = t.earnings_dates
    if ed is None or ed.empty:
        print(f"  [{ticker}] no earnings_dates returned")
        return []

    rows: list[dict] = []
    for dt_idx in ed.index:
        try:
            date_str = dt_idx.strftime("%Y-%m-%d")
            rows.append({"date": date_str, "ticker": ticker, "name": name, "type": "earnings"})
        except Exception:
            continue
    print(f"  [{ticker}] {len(rows)} dates")
    return rows


def main() -> None:
    out = DATA_DIR / "earnings.json"
    existing_by_key: dict[str, dict] = {}

    if out.exists():
        try:
            old = json.loads(out.read_text()).get("data", [])
            for r in old:
                existing_by_key[f"{r['ticker']}|{r['date']}"] = r
        except Exception:
            pass

    all_rows: list[dict] = []
    for ticker, name in EARNINGS_TICKERS.items():
        try:
            rows = fetch_earnings(ticker, name)
            all_rows.extend(rows)
        except Exception as exc:
            print(f"  [{ticker}] FAILED: {exc}")
        time.sleep(0.5)

    # merge with existing (new overrides old for same ticker+date)
    merged: dict[str, dict] = {**existing_by_key}
    for r in all_rows:
        merged[f"{r['ticker']}|{r['date']}"] = r

    result = sorted(merged.values(), key=lambda x: x["date"])

    payload = {
        "updated": date.today().isoformat(),
        "data": result,
    }
    out.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    print(f"Wrote {len(result)} earnings entries -> {out.name}")


if __name__ == "__main__":
    main()
