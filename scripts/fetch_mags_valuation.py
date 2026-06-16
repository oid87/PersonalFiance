"""Fetch Magnificent 7 (MAGS) forward + trailing PE and append to data/MAGS_valuation.json.

MAGS = Roundhill Magnificent Seven ETF, equal-weight (~14.3% each) of the 7 mega-caps,
rebalanced quarterly. yfinance does NOT expose forwardPE/trailingPE for the MAGS ETF
itself, so we compute an equal-weighted average of the 7 constituents.

  fpe = equal-weighted mean of constituent forwardPE  (exclude > FPE_CAP, e.g. TSLA hype)
  tpe = equal-weighted mean of constituent trailingPE (exclude > TPE_CAP)
Weights are renormalized after exclusions.
"""
from __future__ import annotations

import json
import time
from datetime import date
from pathlib import Path

import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "MAGS_valuation.json"

# Magnificent 7, equal weight (MAGS methodology)
MAG7 = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"]

FPE_CAP = 60.0   # exclude forward PE above this (TSLA during loss/hype periods)
TPE_CAP = 80.0   # exclude trailing PE above this


def _get_info(sym: str, retries: int = 3) -> dict | None:
    for attempt in range(retries):
        try:
            time.sleep(0.8)
            return yf.Ticker(sym).info
        except Exception as e:
            if attempt < retries - 1:
                wait = 30 * (attempt + 1)
                print(f"  [{sym}] error ({e}), retry in {wait}s...")
                time.sleep(wait)
            else:
                print(f"  [{sym}] failed after {retries} attempts: {e}")
                return None
    return None


def calc() -> tuple[float | None, float | None]:
    fwd: list[float] = []
    trl: list[float] = []
    for sym in MAG7:
        info = _get_info(sym)
        if not info:
            continue
        fpe = info.get("forwardPE")
        tpe = info.get("trailingPE")
        if isinstance(fpe, (int, float)) and 5 < fpe <= FPE_CAP:
            fwd.append(float(fpe))
        else:
            print(f"  [{sym}] forwardPE={fpe} — excluded")
        if isinstance(tpe, (int, float)) and 3 < tpe <= TPE_CAP:
            trl.append(float(tpe))
        else:
            print(f"  [{sym}] trailingPE={tpe} — excluded")

    fpe_avg = round(sum(fwd) / len(fwd), 2) if fwd else None
    tpe_avg = round(sum(trl) / len(trl), 2) if trl else None
    print(f"  Equal-weighted forward PE: {fpe_avg}x ({len(fwd)} stocks)")
    print(f"  Equal-weighted trailing PE: {tpe_avg}x ({len(trl)} stocks)")
    return fpe_avg, tpe_avg


def load_existing() -> list[dict]:
    if not OUT.exists():
        return []
    try:
        return json.loads(OUT.read_text()).get("data", [])
    except Exception:
        return []


def main() -> None:
    today = date.today().isoformat()
    print(f"Fetching MAGS (Mag7 equal-weight) forward/trailing PE for {today} ...")

    fpe, tpe = calc()
    if fpe is None and tpe is None:
        print("  No valid PE data — skipping update.")
        return

    existing = load_existing()
    by_date = {r["date"]: r for r in existing}
    entry = {"date": today, "src": "calc"}
    if fpe is not None:
        entry["fpe"] = fpe
    if tpe is not None:
        entry["tpe"] = tpe
    by_date[today] = {**by_date.get(today, {}), **entry}
    merged = sorted(by_date.values(), key=lambda r: r["date"])

    note = (
        "Magnificent 7（MAGS）本益比，七巨頭等權平均（AAPL/MSFT/GOOGL/AMZN/NVDA/META/TSLA）。"
        "fpe=forward、tpe=trailing；排除離群值（forward>60x、trailing>80x，主要為 TSLA）。"
        "MAGS ETF 本身 yfinance 不提供 PE，故由成分股計算。歷史值為估計。"
    )
    payload = {"updated": today, "note": note, "data": merged}
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    print(f"  Wrote {len(merged)} entries -> {OUT.name}")


if __name__ == "__main__":
    main()
