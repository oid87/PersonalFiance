"""Fetch BDC (Business Development Company) P/NAV ratios as private credit stress proxy.

BDCs are listed vehicles investing in private credit (direct lending to middle-market firms).
When they trade at discount to NAV, the market is pricing in risk that stated NAV > fair value —
the same opacity/liquidity-mismatch concern as unlisted private credit funds like BCRED or HPS CLF.

Tickers: ARCC (Ares) · OBDC (Blue Owl) · BXSL (Blackstone) · FSK (FS KKR) · MAIN (Main Street)

Output:
  data/bdc_nav.json  — daily P/NAV ratios (3Y history), equal-weight average
"""
from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path

import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)

BDC_TICKERS = ["ARCC", "OBDC", "BXSL", "FSK", "MAIN"]
LOOKBACK_DAYS = 1200  # ~3.3 years to cover 3Y view comfortably


def main() -> None:
    print("Fetching BDC P/NAV data...")

    nav_per_share: dict[str, float] = {}
    nav_date: dict[str, str] = {}
    price_map: dict[str, dict[str, float]] = {}  # ticker -> {date: price}

    start = (date.today() - timedelta(days=LOOKBACK_DAYS)).isoformat()

    for ticker in BDC_TICKERS:
        try:
            t = yf.Ticker(ticker)
            info = t.info

            book = info.get("bookValue")
            if not book or book <= 0:
                print(f"  {ticker}: no valid bookValue in yfinance info, skip")
                continue
            nav_per_share[ticker] = round(float(book), 4)

            ts = info.get("mostRecentQuarter")
            if ts:
                try:
                    nav_date[ticker] = date.fromtimestamp(int(ts)).isoformat()
                except Exception:
                    nav_date[ticker] = ""
            else:
                nav_date[ticker] = ""

            hist = t.history(start=start, auto_adjust=False)
            if hist.empty:
                print(f"  {ticker}: empty history")
                continue

            prices: dict[str, float] = {}
            for idx, row in hist.iterrows():
                close = float(row["Close"]) if "Close" in row.index else None
                if close and close > 0:
                    prices[idx.date().isoformat()] = round(close, 4)

            price_map[ticker] = prices
            print(f"  {ticker}: NAV={nav_per_share[ticker]:.4f}, {len(prices)} days, Q={nav_date.get(ticker, '?')}")

        except Exception as exc:
            print(f"  {ticker} FAILED: {exc}")

    if not nav_per_share:
        print("  No BDC data fetched, aborting")
        return

    # Build date union
    all_dates: set[str] = set()
    for prices in price_map.values():
        all_dates.update(prices.keys())

    # MAIN consistently trades at premium (best-in-class dividend growth BDC since 2007)
    # so avg4 (ex-MAIN) is a cleaner private credit stress gauge
    STRESS_TICKERS = [t for t in BDC_TICKERS if t != "MAIN"]

    new_rows: list[dict] = []
    for d in sorted(all_dates):
        row: dict = {"date": d}
        ratios: list[float] = []
        stress_ratios: list[float] = []
        for ticker in BDC_TICKERS:
            if ticker not in price_map or ticker not in nav_per_share:
                continue
            price = price_map[ticker].get(d)
            if price is None:
                continue
            p_nav = round(price / nav_per_share[ticker], 4)
            row[ticker] = p_nav
            ratios.append(p_nav)
            if ticker in STRESS_TICKERS:
                stress_ratios.append(p_nav)
        if ratios:
            row["avg"] = round(sum(ratios) / len(ratios), 4)
        if stress_ratios:
            row["avg4"] = round(sum(stress_ratios) / len(stress_ratios), 4)
        if ratios:
            new_rows.append(row)

    # Idempotent merge with existing data
    out = DATA_DIR / "bdc_nav.json"
    existing: dict[str, dict] = {}
    if out.exists():
        try:
            for r in json.loads(out.read_text()).get("data", []):
                existing[r["date"]] = r
        except Exception:
            pass
    for r in new_rows:
        existing[r["date"]] = r
    merged = sorted(existing.values(), key=lambda r: r["date"])

    out.write_text(json.dumps({
        "updated": date.today().isoformat(),
        "note": (
            "BDC P/NAV = price / book-value-per-share (NAV from latest 10-Q via yfinance). "
            "Tickers: ARCC OBDC BXSL FSK MAIN. avg = equal-weight mean. "
            "Discount to NAV (<1.0) signals market concern about private credit opacity."
        ),
        "nav_per_share": nav_per_share,
        "nav_date": nav_date,
        "tickers": BDC_TICKERS,
        "data": merged,
    }, ensure_ascii=False) + "\n")
    print(f"  bdc_nav.json: {len(merged)} rows total")


if __name__ == "__main__":
    main()
