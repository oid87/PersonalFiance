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


def calc_tpe() -> float | None:
    """Trailing PE straight from the QQQ ETF (yfinance exposes it for QQQ)."""
    try:
        tpe = yf.Ticker("QQQ").info.get("trailingPE")
        if tpe and isinstance(tpe, (int, float)):
            print(f"  QQQ ETF trailing PE: {tpe:.2f}x")
            return round(float(tpe), 2)
    except Exception as e:
        print(f"  trailing PE fetch failed: {e}")
    return None


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
    tpe = calc_tpe()
    if fpe is None and tpe is None:
        print("  No valid PE data — skipping update.")
        return

    existing = load_existing()

    # Replace today's entry if it exists, else append (preserve other fields)
    by_date = {r["date"]: r for r in existing}
    entry = {"date": today, "src": "calc"}
    if fpe is not None:
        entry["fpe"] = fpe
    if tpe is not None:
        entry["tpe"] = tpe
    by_date[today] = {**by_date.get(today, {}), **entry}
    merged = sorted(by_date.values(), key=lambda r: r["date"])

    note = (
        "Nasdaq-100 估值。fpe=forward（前10大持股加權，排除 PE>60x）；tpe=trailing（QQQ ETF）。"
        "2026-04-25 之前 forward 為估計值；trailing 自上線當日起每日累積。"
    )
    payload = {"updated": today, "note": note, "data": merged}
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    print(f"  Wrote {len(merged)} entries -> {OUT.name}")


if __name__ == "__main__":
    main()
