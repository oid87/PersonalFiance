"""Fetch Nasdaq-100 forward PE from QQQ top-20 holdings and append to data/QQQ_valuation.json.

Method: arithmetic weighted average of constituent forwardPE, using fixed approximate weights.
  Stocks with forwardPE missing or > FPE_CAP (e.g. TSLA during hype) are excluded;
  remaining weights are renormalized. This arithmetic approach (vs harmonic/aggregate)
  happens to track MacroMicro's NASDAQ-100 Forward PE more closely in practice.
"""
from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "QQQ_valuation.json"

# Top-20 QQQ holdings with approximate weights (Invesco, ~quarterly updated).
HOLDINGS: dict[str, float] = {
    "MSFT":  8.5, "AAPL":  8.0, "NVDA":  7.5, "AMZN":  5.5, "META":  4.8,
    "TSLA":  4.0, "GOOGL": 3.8, "GOOG":  3.7, "AVGO":  3.5, "COST":  2.6,
    "NFLX":  2.4, "AMD":   2.0, "QCOM":  1.5, "TXN":   1.3, "ISRG":  1.2,
    "BKNG":  1.0, "AMAT":  0.9, "PEP":   0.8, "REGN":  0.7, "PANW":  0.7,
}

FPE_CAP = 60.0   # exclude hype/loss-making extremes (TSLA 158x etc.)
MIN_STOCKS = 10


def _ntm_pe(sym: str) -> float | None:
    """Compute NTM (Next Twelve Months) PE from analyst earnings estimates.

    NTM EPS = (m/12) × current_FY_EPS + ((12-m)/12) × next_FY_EPS
    where m = months remaining in current fiscal year.

    This matches the NTM methodology used by MacroMicro / institutional sources,
    unlike yfinance forwardPE which uses next-FY only (higher EPS → lower PE).
    """
    try:
        t = yf.Ticker(sym)
        info = t.info
        price = info.get("currentPrice") or info.get("regularMarketPrice")
        lfy_str = info.get("lastFiscalYearEnd")  # e.g. "2026-01-26"
        if not price or not lfy_str:
            return None

        ee = t.earnings_estimate
        if ee is None or ee.empty or "0y" not in ee.index or "+1y" not in ee.index:
            return None

        eps_0y = float(ee.loc["0y", "avg"])
        eps_1y = float(ee.loc["+1y", "avg"])
        if eps_0y <= 0 or eps_1y <= 0:
            return None

        # Months remaining in current FY (0–12)
        # lastFiscalYearEnd is a UNIX timestamp (int) in yfinance
        import datetime as _dt
        lfy_date = (_dt.date.fromtimestamp(lfy_str) if isinstance(lfy_str, int)
                    else _dt.date.fromisoformat(str(lfy_str)[:10]))
        # Current FY ends exactly 1 year after the last FY ended
        try:
            current_fy_end = lfy_date.replace(year=lfy_date.year + 1)
        except ValueError:
            current_fy_end = lfy_date.replace(year=lfy_date.year + 1, day=28)
        today_d = date.today()
        # Whole months from today to current FY end (0 = FY about to end / just ended)
        m = max(0, (current_fy_end.year - today_d.year) * 12
                   + (current_fy_end.month - today_d.month))
        m = min(m, 12)  # cap at 12

        # NTM EPS blend: m months of 0y + (12-m) months of +1y
        ntm_eps = (m / 12) * eps_0y + ((12 - m) / 12) * eps_1y
        return float(price) / ntm_eps

    except Exception as e:
        print(f"    [{sym}] NTM error: {e}")
        return None


def calc_fpe() -> float | None:
    valid: list[tuple[float, float]] = []  # (ntm_pe, weight)
    for sym, weight in HOLDINGS.items():
        pe = _ntm_pe(sym)
        if pe and 5 < pe <= FPE_CAP:
            valid.append((pe, weight))
            print(f"  [{sym}] NTM PE={pe:.1f}x")
        else:
            print(f"  [{sym}] NTM PE={pe} — excluded (cap {FPE_CAP}x or invalid)")

    if len(valid) < MIN_STOCKS:
        print(f"  Only {len(valid)} valid — skipping.")
        return None

    total_w = sum(w for _, w in valid)
    weighted = sum(pe * w for pe, w in valid) / total_w
    print(f"  NTM forward PE: {weighted:.2f}x  ({len(valid)}/{len(HOLDINGS)} stocks, w={total_w:.1f}%)")
    return round(weighted, 2)


def calc_tpe() -> float | None:
    """Trailing PE straight from the QQQ ETF."""
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
    print(f"Fetching QQQ top-20 arithmetic forward PE for {today} ...")

    fpe = calc_fpe()
    tpe = calc_tpe()
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
        "Nasdaq-100 估值。fpe=forward（前20大持股 NTM 加權算術平均，排除 PE>60x；"
        "NTM=(m/12)×當FY EPS+(12-m)/12×次FY EPS，追蹤 MacroMicro NASDAQ-100 Forward PE）；"
        "tpe=trailing（QQQ ETF）。"
    )
    payload = {"updated": today, "note": note, "data": merged}
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    print(f"  Wrote {len(merged)} entries -> {OUT.name}")


if __name__ == "__main__":
    main()
