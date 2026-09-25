"""Fetch Philadelphia Semiconductor Index (SOXX) forward PE from top-20 holdings.

Appends result to data/SOXX_valuation.json.

Weight fetch priority:
  1. yfinance funds_data.top_holdings  (live iShares SOXX weights)
  2. HOLDINGS_FALLBACK                 (hardcoded top-20, update ~quarterly)

Forward PE = weighted arithmetic mean of constituent NTM PEs.
NTM (Next Twelve Months) EPS = (m/12)×current_FY_EPS + ((12-m)/12)×next_FY_EPS
where m = months remaining in current fiscal year. Matches MacroMicro methodology.
Stocks with NTM PE missing, <= 5x, or > 70x are excluded.
Weights are renormalized after exclusions.
"""
from __future__ import annotations

from datetime import date
from pathlib import Path

import yfinance as yf

import _common
import _valuation

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
    """Live SOXX holdings weights from yfinance funds_data.top_holdings.

    The DataFrame (yfinance 1.x) is indexed by Symbol with a 'Holding Percent'
    column (fraction). Older builds exposed 'symbol'/'holdingPercent' columns —
    handle both. Returns {SYM: weight_pct} or None on failure.
    """
    try:
        top = yf.Ticker("SOXX").funds_data.top_holdings
        if top is None or top.empty:
            return None
        holdings: dict[str, float] = {}
        for idx, row in top.iterrows():
            sym = str(row.get("symbol") or idx or "").upper().strip()
            pct = row.get("Holding Percent")
            if pct is None:
                pct = row.get("holdingPercent")
            if sym and pct:
                holdings[sym] = float(pct) * 100
        return holdings or None
    except Exception as e:
        print(f"  [live weights] failed: {e}")
        return None


def _ntm_pe(sym: str, retries: int = 3) -> float | None:
    """Compute NTM (Next Twelve Months) PE from analyst earnings estimates.

    NTM EPS = (m/12) × current_FY_EPS + ((12-m)/12) × next_FY_EPS
    where m = months remaining in current fiscal year (0 = FY ending now → use +1y).
    """
    return _valuation.ntm_pe(sym, throttle=0.8, retries=retries)


def calc_fpe(holdings: dict[str, float]) -> tuple[float | None, float | None]:
    """Returns (arithmetic-weighted NTM PE, harmonic-weighted NTM PE).

    Arithmetic mean is the original/legacy metric (kept for continuity with
    the existing historical series). It gets skewed high by a handful of
    small-weight, high-PE outliers (e.g. INTC/MRVL/AMD) — realized 2026-09-13:
    arithmetic=23.87x vs harmonic=18.88x for the same SOXX basket, the latter
    much closer to Yardeni's independently published ~16.3x. Harmonic mean
    (= total_weight / Σ(weight/PE), equivalent to Σ(mv)/Σ(mv/PE) i.e. market-
    cap-weighted "aggregate P/E") is the more standard index-level metric and
    is not distorted by outliers the same way — see docs/forward_pe.md rule #1.
    """
    valid: list[tuple[float, float]] = []
    for sym, weight in holdings.items():
        pe = _ntm_pe(sym)
        if pe and 5 < pe <= FPE_CAP:
            valid.append((pe, weight))
        else:
            print(f"  [{sym}] NTM PE={pe} — excluded")

    if not valid:
        return None, None

    total_w = sum(w for _, w in valid)
    arith, harmonic = _valuation.weighted_means(valid)
    print(
        f"  NTM forward PE: arithmetic={arith:.2f}x harmonic={harmonic:.2f}x  "
        f"({len(valid)} stocks, coverage {total_w:.1f}%)"
    )
    return round(arith, 2), round(harmonic, 2)


def load_existing() -> list[dict]:
    return _common.load_rows(OUT)


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

    fpe, fpe_harmonic = calc_fpe(holdings)

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

    entry = {"date": today, "src": src_label}
    if fpe is not None:
        entry["fpe"] = fpe
    if fpe_harmonic is not None:
        entry["fpe_harmonic"] = fpe_harmonic
    if tpe is not None:
        entry["tpe"] = tpe

    note = (
        "Philadelphia Semiconductor Index (SOXX) 估值。"
        "fpe=forward（前20大持股 NTM 加權算術平均，排除 PE>70x 或負 EPS；NTM=(m/12)×當FY+(12-m)/12×次FY）；"
        "fpe_harmonic=同一籃子的NTM加權調和平均（= total_weight/Σ(weight/PE)，等價市值加權聚合PE，"
        "不受少數高PE小權重成分股扭曲，只從2026-09-13起提供，之前日期無此欄位）；"
        "tpe=trailing（SOXX ETF，每日累積）。半導體 PE 週期性強，熊市底部可壓縮至 14x，AI 高峰可達 32x+。"
    )
    merged = _valuation.write_daily_snapshot(OUT, today, entry, note)
    print(f"  Wrote {len(merged)} entries -> {OUT.name}")


if __name__ == "__main__":
    main()
