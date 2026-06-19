"""Fetch Nasdaq-100 (QQQ) forward & trailing PE and append to data/QQQ_valuation.json.

Forward PE (fpe):
  Weight fetch priority:
    1. yfinance funds_data.top_holdings  (live Invesco QQQ top-10 weights)  → src="calc-live"
    2. HOLDINGS_FALLBACK                  (hardcoded, update ~quarterly)      → src="calc"
  Forward PE = weighted arithmetic mean of constituent NTM PEs.
  NTM (Next Twelve Months) EPS = (m/12)×current_FY_EPS + ((12-m)/12)×next_FY_EPS
  where m = months remaining in current fiscal year. Matches MacroMicro methodology.
  Stocks with NTM PE missing, <= 5x, or > FPE_CAP (TSLA hype etc.) are excluded;
  remaining weights are renormalized.

Trailing PE (tpe):
  Straight from the QQQ ETF (yfinance exposes trailingPE for the fund).
"""
from __future__ import annotations

import datetime as _dt
import json
import time
from datetime import date
from pathlib import Path

import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "QQQ_valuation.json"

# Fallback weights (Invesco QQQ, ~quarterly). Only used if live fetch fails.
HOLDINGS_FALLBACK: dict[str, float] = {
    "NVDA":  8.2, "AAPL":  7.3, "MSFT":  5.3, "AMZN":  4.6, "MU":    4.8,
    "AMD":   3.7, "GOOGL": 3.5, "TSLA":  3.5, "AVGO":  3.4, "GOOG":  3.3,
    "META":  3.0, "COST":  2.6, "NFLX":  2.4, "QCOM":  1.5, "TXN":   1.3,
}

FPE_CAP = 60.0   # exclude hype/loss-making extremes (TSLA 158x etc.)
MIN_STOCKS = 6   # need at least this many valid constituents


def fetch_live_weights(ticker: str) -> dict[str, float] | None:
    """Live top-10 holdings weights from yfinance funds_data.top_holdings.

    The DataFrame (yfinance 1.x) is indexed by Symbol with a 'Holding Percent'
    column (fraction). Older builds exposed 'symbol'/'holdingPercent' columns —
    handle both. Returns {SYM: weight_pct} or None on failure.
    """
    try:
        top = yf.Ticker(ticker).funds_data.top_holdings
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

    This matches the NTM methodology used by MacroMicro / institutional sources,
    unlike yfinance forwardPE which uses next-FY only (higher EPS → lower PE).
    """
    for attempt in range(retries):
        try:
            time.sleep(0.5)
            t = yf.Ticker(sym)
            info = t.info
            price = info.get("currentPrice") or info.get("regularMarketPrice")
            lfy_raw = info.get("lastFiscalYearEnd")  # UNIX ts (int) or ISO str
            if not price or not lfy_raw:
                return None

            ee = t.earnings_estimate
            if ee is None or ee.empty or "0y" not in ee.index or "+1y" not in ee.index:
                return None

            eps_0y = float(ee.loc["0y", "avg"])
            eps_1y = float(ee.loc["+1y", "avg"])
            if eps_0y <= 0 or eps_1y <= 0:
                return None

            lfy_date = (_dt.date.fromtimestamp(lfy_raw) if isinstance(lfy_raw, int)
                        else _dt.date.fromisoformat(str(lfy_raw)[:10]))
            try:
                current_fy_end = lfy_date.replace(year=lfy_date.year + 1)
            except ValueError:
                current_fy_end = lfy_date.replace(year=lfy_date.year + 1, day=28)
            today_d = date.today()
            m = max(0, min(12, (current_fy_end.year - today_d.year) * 12
                               + (current_fy_end.month - today_d.month)))

            ntm_eps = (m / 12) * eps_0y + ((12 - m) / 12) * eps_1y
            return float(price) / ntm_eps

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
    valid: list[tuple[float, float]] = []  # (ntm_pe, weight)
    for sym, weight in holdings.items():
        pe = _ntm_pe(sym)
        if pe and 5 < pe <= FPE_CAP:
            valid.append((pe, weight))
            print(f"  [{sym}] NTM PE={pe:.1f}x  (w={weight:.1f}%)")
        else:
            print(f"  [{sym}] NTM PE={pe} — excluded (cap {FPE_CAP}x or invalid)")

    if len(valid) < MIN_STOCKS:
        print(f"  Only {len(valid)} valid (<{MIN_STOCKS}) — skipping forward.")
        return None

    total_w = sum(w for _, w in valid)
    weighted = sum(pe * w for pe, w in valid) / total_w
    print(f"  NTM forward PE: {weighted:.2f}x  ({len(valid)}/{len(holdings)} stocks, w={total_w:.1f}%)")
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
    print(f"Fetching QQQ forward (NTM) + trailing PE for {today} ...")

    live = fetch_live_weights("QQQ")
    if live:
        print(f"  Using live weights from yfinance ({len(live)} holdings): "
              + ", ".join(f"{s} {w:.1f}%" for s, w in live.items()))
        holdings = live
        src_label = "calc-live"
    else:
        print("  Live weights unavailable — falling back to hardcoded weights")
        holdings = HOLDINGS_FALLBACK
        src_label = "calc"

    fpe = calc_fpe(holdings)
    tpe = calc_tpe()
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
        "Nasdaq-100 估值。fpe=forward（每日動態抓 QQQ 前10大持股權重 × 各股 NTM 加權算術平均，"
        "排除 PE>60x；NTM=(m/12)×當FY EPS+(12-m)/12×次FY EPS，追蹤 MacroMicro NASDAQ-100 Forward PE）；"
        "tpe=trailing（QQQ ETF 實際 trailingPE）。歷史段（src=seed）為估計值。"
    )
    payload = {"updated": today, "note": note, "data": merged}
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    print(f"  Wrote {len(merged)} entries -> {OUT.name}  (src={src_label})")


if __name__ == "__main__":
    main()
