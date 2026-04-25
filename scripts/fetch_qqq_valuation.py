"""Fetch Nasdaq-100 forward PE from QQQ top-10 holdings and append to data/QQQ_valuation.json.

Forward PE = weighted average of constituent forward PEs.
Stocks with forwardPE missing or > 60x are excluded (e.g. TSLA during loss/hype periods).
Weights are renormalized after exclusions.
"""
from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "QQQ_valuation.json"

# Top-10 QQQ holdings with approximate weights (Invesco, ~quarterly updated)
HOLDINGS: dict[str, float] = {
    "MSFT":  8.5,
    "AAPL":  8.0,
    "NVDA":  7.5,
    "AMZN":  5.5,
    "META":  4.8,
    "TSLA":  4.0,
    "GOOGL": 3.8,
    "GOOG":  3.7,
    "AVGO":  3.5,
    "COST":  2.6,
}

FPE_CAP = 60.0  # exclude stocks with forward PE above this threshold


def calc_fpe() -> float | None:
    valid: list[tuple[float, float]] = []  # (fpe, weight)
    for sym, weight in HOLDINGS.items():
        info = yf.Ticker(sym).info
        fpe = info.get("forwardPE")
        if fpe and isinstance(fpe, (int, float)) and 5 < fpe <= FPE_CAP:
            valid.append((fpe, weight))
        else:
            print(f"  [{sym}] forwardPE={fpe} — excluded")

    if not valid:
        return None

    total_w = sum(w for _, w in valid)
    weighted = sum(fpe * w for fpe, w in valid) / total_w
    print(f"  Weighted forward PE: {weighted:.2f}x  (from {len(valid)} stocks, total weight {total_w:.1f}%)")
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
    print(f"Fetching QQQ top-10 forward PE for {today} ...")

    fpe = calc_fpe()
    if fpe is None:
        print("  No valid forward PE data — skipping update.")
        return

    existing = load_existing()

    # Replace today's entry if it exists, else append
    by_date = {r["date"]: r for r in existing}
    by_date[today] = {"date": today, "fpe": fpe, "src": "calc"}
    merged = sorted(by_date.values(), key=lambda r: r["date"])

    note = (
        "Nasdaq-100 forward PE. 2026-04-25 之前為估計值（基於公開分析資料）；"
        "之後為加權計算值（前10大持股，排除 PE>60x 者）。"
    )
    payload = {"updated": today, "note": note, "data": merged}
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    print(f"  Wrote {len(merged)} entries -> {OUT.name}")


if __name__ == "__main__":
    main()
