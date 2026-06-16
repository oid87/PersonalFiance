"""Fetch Philadelphia Semiconductor Index (SOXX) forward PE from top-20 holdings.

Appends result to data/SOXX_valuation.json.

Weight fetch priority:
  1. yfinance funds_data.top_holdings  (live iShares SOXX weights)
  2. HOLDINGS_FALLBACK                 (hardcoded top-20, update ~quarterly)

Forward PE = weighted arithmetic mean of constituent forward PEs.
Stocks with forwardPE missing, <= 5x, or > 70x are excluded (semis can spike during
earnings collapses; 70x cap filters obvious outliers without losing AI-premium names).
Weights are renormalized after exclusions.
"""
from __future__ import annotations

import json
import time
from datetime import date
from pathlib import Path

import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "SOXX_valuation.json"

# Fallback: top-20 SOXX holdings, weights as of 2026-06 (iShares)
# Update this dict after each quarterly rebalance if live fetch fails.
HOLDINGS_FALLBACK: dict[str, float] = {
    "NVDA":  20.0,
    "AVGO":  8.5,
    "AMD":   5.0,
    "QCOM":  5.0,
    "AMAT":  4.5,
    "MU":    4.5,
    "LRCX":  4.0,
    "KLAC":  4.0,
    "TXN":   3.5,
    "MRVL":  3.5,
    "INTC":  3.0,
    "ON":    2.5,
    "MPWR":  2.5,
    "TER":   2.0,
    "SMCI":  2.0,
    "ENTG":  1.8,
    "WOLF":  1.5,
    "SWKS":  1.5,
    "MCHP":  1.4,
    "ADI":   1.3,
}

FPE_CAP = 70.0


def fetch_live_weights() -> dict[str, float] | None:
    """Try to get live SOXX holdings weights from yfinance funds_data."""
    try:
        soxx = yf.Ticker("SOXX")
        top = soxx.funds_data.top_holdings
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
    print(f"Fetching SOXX top-20 forward PE for {today} ...")

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

    # Trailing PE straight from the SOXX ETF (yfinance exposes it)
    tpe = None
    try:
        t = yf.Ticker("SOXX").info.get("trailingPE")
        if t and isinstance(t, (int, float)):
            tpe = round(float(t), 2)
            print(f"  SOXX ETF trailing PE: {tpe}x")
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
        "Philadelphia Semiconductor Index (SOXX) 估值。"
        "fpe=forward（前20大持股加權，排除 PE>70x 或負值；歷史為估計）；tpe=trailing（SOXX ETF，每日累積）。"
        "半導體 PE 週期性強，熊市底部可壓縮至 14x，AI 高峰可達 32x+。"
    )
    payload = {"updated": today, "note": note, "data": merged}
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    print(f"  Wrote {len(merged)} entries -> {OUT.name}")


if __name__ == "__main__":
    main()
