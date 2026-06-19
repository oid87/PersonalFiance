"""One-off backfill: build MAGS (Mag7 equal-weight) PE history from yfinance.

Method:
  1. Fetch annual diluted EPS for each of the 7 stocks (yfinance income_stmt, ~4 FY).
  2. Fetch monthly close prices (yfinance history, up to 10y).
  3. At each month-end: trailing PE = price / most-recent fiscal-year EPS.
     (Uses annual EPS — same convention as TWSE official Taiwan PE.)
  4. Equal-weight across valid stocks (cap outliers; skip negative EPS).
  5. Realized/hindsight forward PE: fpe(t) = tpe(t+12m) × px(t) / px(t+12m).
  6. Merge with any existing daily calc/calc-live entries from fetch_mags_valuation.py.

Depth: yfinance typically has 4 fiscal years of annual EPS → ~2022 onwards.
This covers 2022 bear market, 2023 recovery, 2024–2026 AI cycle.
"""
from __future__ import annotations

import json
import time
from datetime import date
from pathlib import Path

import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "MAGS_valuation.json"

MAG7 = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"]
TPE_CAP = 80.0   # TSLA hype-era cap
MIN_STOCKS = 4   # need at least 4/7 valid to compute a point


def fetch_annual_eps(sym: str) -> dict[str, float]:
    """Return {YYYY-MM-DD: diluted_EPS} from annual income_stmt. Skip NaN / negative."""
    try:
        stmt = yf.Ticker(sym).income_stmt
        if stmt is None or stmt.empty:
            return {}
        if "Diluted EPS" not in stmt.index:
            return {}
        series = stmt.loc["Diluted EPS"].dropna()
        out = {}
        for ts, eps in series.items():
            if isinstance(eps, (int, float)) and eps > 0:
                out[str(ts.date())] = float(eps)
        print(f"  [{sym}] {len(out)} annual EPS: {sorted(out)}")
        return out
    except Exception as e:
        print(f"  [{sym}] annual EPS error: {e}")
        return {}


def fetch_monthly_prices(sym: str) -> dict[str, float]:
    """Return {YYYY-MM: month-end close price}."""
    try:
        hist = yf.Ticker(sym).history(period="10y", interval="1mo", auto_adjust=True)
        if hist.empty:
            return {}
        out = {}
        for ts, row in hist.iterrows():
            ym = str(ts.date())[:7]
            out[ym] = float(row["Close"])
        print(f"  [{sym}] {len(out)} monthly prices: {sorted(out)[0]} → {sorted(out)[-1]}")
        return out
    except Exception as e:
        print(f"  [{sym}] prices error: {e}")
        return {}


def most_recent_eps(eps_map: dict[str, float], ym: str) -> float | None:
    """Return the most recent annual EPS whose fiscal year-end is <= month ym."""
    ym_day = ym + "-31"  # compare as string YYYY-MM-DD
    candidates = [(d, v) for d, v in eps_map.items() if d[:7] <= ym_day[:7]]
    if not candidates:
        return None
    return max(candidates, key=lambda x: x[0])[1]


def compute_monthly_tpe(
    all_eps: dict[str, dict[str, float]],
    all_px: dict[str, dict[str, float]],
) -> list[dict]:
    """Compute equal-weighted monthly trailing PE across all months with data."""
    all_months = sorted({ym for px in all_px.values() for ym in px})
    records = []

    for ym in all_months:
        valid: list[float] = []
        for sym in MAG7:
            px = all_px[sym].get(ym)
            eps = most_recent_eps(all_eps.get(sym, {}), ym)
            if not px or not eps or px <= 0 or eps <= 0:
                continue
            tpe = px / eps
            if 3 < tpe <= TPE_CAP:
                valid.append(tpe)

        if len(valid) < MIN_STOCKS:
            continue

        tpe_avg = round(sum(valid) / len(valid), 2)
        records.append({"date": ym + "-01", "tpe": tpe_avg, "src": "backfill"})

    return records


def add_realized_forward(records: list[dict], all_px: dict[str, dict[str, float]]) -> None:
    """Add hindsight fpe(t) = tpe(t+12m) × avg_px(t) / avg_px(t+12m)."""
    tpe_by_ym = {r["date"][:7]: r["tpe"] for r in records}

    # Average price across available Mag7 stocks each month (as index proxy)
    avg_px: dict[str, float] = {}
    all_months = sorted({ym for px in all_px.values() for ym in px})
    for ym in all_months:
        prices = [v for sym in MAG7 if (v := all_px[sym].get(ym))]
        if prices:
            avg_px[ym] = sum(prices) / len(prices)

    for r in records:
        ym = r["date"][:7]
        y, m = map(int, ym.split("-"))
        fym = f"{y + 1}-{m:02d}"
        if fym in tpe_by_ym and ym in avg_px and fym in avg_px and avg_px[fym]:
            r["fpe"] = round(tpe_by_ym[fym] * avg_px[ym] / avg_px[fym], 2)


def main() -> None:
    print("Backfilling MAGS PE history from yfinance annual EPS + monthly prices ...")
    all_eps: dict[str, dict[str, float]] = {}
    all_px: dict[str, dict[str, float]] = {}

    for sym in MAG7:
        time.sleep(0.5)
        all_eps[sym] = fetch_annual_eps(sym)
        all_px[sym] = fetch_monthly_prices(sym)

    records = compute_monthly_tpe(all_eps, all_px)
    if not records:
        print("  No records produced — aborting.")
        return
    print(f"\n  Built {len(records)} monthly TPE points: {records[0]['date']} → {records[-1]['date']}")

    add_realized_forward(records, all_px)
    fpe_count = sum(1 for r in records if "fpe" in r)
    print(f"  Added realized forward PE to {fpe_count} months.")

    # Merge: keep recent daily calc/calc-live entries (daily fetch wins over backfill)
    existing = json.loads(OUT.read_text()).get("data", []) if OUT.exists() else []
    keep = {r["date"]: r for r in existing if r.get("src") in ("calc", "calc-live")}
    by_date = {r["date"]: r for r in records}
    by_date.update(keep)
    merged = sorted(by_date.values(), key=lambda r: r["date"])

    note = (
        "Magnificent 7（MAGS）本益比，七巨頭等權平均（AAPL/MSFT/GOOGL/AMZN/NVDA/META/TSLA）。"
        "tpe=trailing：年度稀釋 EPS（yfinance income_stmt，fiscal year-end），月末股價除以最近年報 EPS，"
        "等同 TWSE 年報 EPS 慣例；排除 TSLA 等 EPS≤0 或 PE>80x 期間。"
        "fpe=後見 forward（hindsight）：同台指方法，fpe(t)=tpe(t+12m)×px(t)/px(t+12m)。"
        "歷史底：TSLA排除期間 Mag6 平均約 20–25x（2022）；近期含 TSLA 約 28x（2026）。"
    )
    payload = {"updated": date.today().isoformat(), "note": note, "data": merged}
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    print(f"  Wrote {len(merged)} entries -> {OUT.name}")


if __name__ == "__main__":
    main()
