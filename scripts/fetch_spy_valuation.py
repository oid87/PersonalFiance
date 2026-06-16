"""Fetch S&P 500 forward PE from SPY top-20 holdings and append to data/SPY_valuation.json.

Weight fetch priority:
  1. yfinance funds_data.top_holdings  (live Yahoo Finance weights)
  2. HOLDINGS_FALLBACK                 (hardcoded top-20, update ~quarterly)

Forward PE = weighted arithmetic mean of constituent forward PEs.
Stocks with forwardPE missing or > 50x are excluded.
Weights are renormalized after exclusions.
"""
from __future__ import annotations

import json
import time
from datetime import date
from pathlib import Path

import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "SPY_valuation.json"

# Fallback: top-20 SPY holdings, weights as of 2026-06 (State Street)
# Update this dict after each quarterly rebalance if live fetch fails.
HOLDINGS_FALLBACK: dict[str, float] = {
    "AAPL":  7.0,
    "MSFT":  6.5,
    "NVDA":  6.0,
    "AMZN":  3.8,
    "META":  2.8,
    "GOOGL": 2.5,
    "GOOG":  2.2,
    "BRK-B": 1.9,
    "TSLA":  1.8,
    "AVGO":  1.7,
    "JPM":   1.5,
    "LLY":   1.4,
    "V":     1.2,
    "UNH":   1.2,
    "XOM":   1.1,
    "COST":  1.0,
    "MA":    1.0,
    "NFLX":  0.9,
    "HD":    0.8,
    "JNJ":   0.7,
}

FPE_CAP = 50.0


def fetch_live_weights() -> dict[str, float] | None:
    """Try to get live SPY holdings weights from yfinance funds_data."""
    try:
        spy = yf.Ticker("SPY")
        top = spy.funds_data.top_holdings
        if top is None or top.empty:
            return None
        holdings = {}
        for _, row in top.iterrows():
            sym = str(row.get("symbol", "")).upper()
            pct = row.get("holdingPercent", 0)
            if sym and pct:
                holdings[sym] = float(pct) * 100
        return holdings if holdings else None
    except Exception as e:
        print(f"  [live weights] failed: {e}")
        return None


def _get_forward_pe(sym: str, retries: int = 3) -> float | None:
    for attempt in range(retries):
        try:
            time.sleep(0.8)
            info = yf.Ticker(sym).info
            fpe = info.get("forwardPE")
            if fpe and isinstance(fpe, (int, float)):
                return float(fpe)
            return None
        except Exception as e:
            if attempt < retries - 1:
                wait = 30 * (attempt + 1)
                print(f"  [{sym}] error ({e}), retry in {wait}s...")
                time.sleep(wait)
            else:
                print(f"  [{sym}] failed after {retries} attempts: {e}")
                return None
    return None


def calc_fpe(holdings: dict[str, float]) -> float | None:
    valid: list[tuple[float, float]] = []
    for sym, weight in holdings.items():
        fpe = _get_forward_pe(sym)
        if fpe and 5 < fpe <= FPE_CAP:
            valid.append((fpe, weight))
        else:
            print(f"  [{sym}] forwardPE={fpe} — excluded")

    if not valid:
        return None

    total_w = sum(w for _, w in valid)
    weighted = sum(fpe * w for fpe, w in valid) / total_w
    print(f"  Weighted forward PE: {weighted:.2f}x  ({len(valid)} stocks, coverage {total_w:.1f}%)")
    return round(weighted, 2)


def load_existing() -> list[dict]:
    if not OUT.exists():
        return []
    try:
        return json.loads(OUT.read_text()).get("data", [])
    except Exception:
        return []


def main() -> None:
    today = date.today().isoformat()
    print(f"Fetching SPY top-20 forward PE for {today} ...")

    live = fetch_live_weights()
    if live:
        print(f"  Using live weights from yfinance ({len(live)} holdings)")
        holdings = live
        src_label = "calc-live"
    else:
        print(f"  Falling back to hardcoded top-20 weights")
        holdings = HOLDINGS_FALLBACK
        src_label = "calc"

    fpe = calc_fpe(holdings)

    # Trailing PE straight from the SPY ETF (yfinance exposes it)
    tpe = None
    try:
        t = yf.Ticker("SPY").info.get("trailingPE")
        if t and isinstance(t, (int, float)):
            tpe = round(float(t), 2)
            print(f"  SPY ETF trailing PE: {tpe}x")
    except Exception as e:
        print(f"  trailing PE fetch failed: {e}")

    if fpe is None and tpe is None:
        print("  No valid PE data — skipping update.")
        return

    existing = load_existing()
    by_date = {r["date"]: r for r in existing}
    entry = {"date": today, "src": src_label}
    if fpe is not None:
        entry["fpe"] = fpe
    if tpe is not None:
        entry["tpe"] = tpe
    by_date[today] = {**by_date.get(today, {}), **entry}
    merged = sorted(by_date.values(), key=lambda r: r["date"])

    note = (
        "S&P 500 估值。fpe=forward（前20大持股加權，排除 PE>50x；歷史為 FactSet/Yardeni 估計）；"
        "tpe=trailing（SPY ETF）。圖表 trailing 線另疊 multpl.com 長期歷史（SP500_PE.json）。"
    )
    payload = {"updated": today, "note": note, "data": merged}
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    print(f"  Wrote {len(merged)} entries -> {OUT.name}")


if __name__ == "__main__":
    main()
