"""One-off backfill: build historical PE for QQQ, SOXX, and SPY.

Method (upgraded from annual-EPS to quarterly TTM):
  1. Fetch quarterly Reported EPS via get_earnings_dates(limit=80) per constituent.
     This reaches back ~20 years (MSFT/AMD/QCOM to 2001, NVDA to 2006, META to 2012).
  2. Compute TTM EPS at each month-end = sum of last 4 reported quarters.
  3. trailing PE = price / TTM EPS  (true TTM, not annual-EPS step).
  4. Weighted arithmetic mean across valid constituents (renormalize after exclusions).
  5. Realized/hindsight forward PE: fpe(t) = tpe(t+12m) × avg_px(t) / avg_px(t+12m).
  6. Merge: seed anchors (pre-backfill) + backfill (TTM) + daily calc entries.

Depth achieved:
  QQQ  — ~2015 (limited by META IPO 2012, need 4 quarters → 2013 TTM)
  SOXX — ~2010 (AVGO IPO 2009)
  SPY  — trailing from SP500_PE.json (multpl, 1871); fpe backfill ~2015

Run once (or after a data reset):
    python backfill_etf_valuation.py
"""
from __future__ import annotations

import json
import time
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent

# ── ETF configs ─────────────────────────────────────────────────────────────
CONFIGS = {
    "QQQ": {
        "out": ROOT / "data" / "QQQ_valuation.json",
        "tpe_cap": 70.0,
        "min_coverage": 40.0,  # min weight% needed
        "holdings": {
            "MSFT": 8.5, "AAPL": 8.0, "NVDA": 7.5, "AMZN": 5.5,
            "META": 4.8, "TSLA": 4.0, "GOOGL": 3.8, "GOOG": 3.7,
            "AVGO": 3.5, "COST": 2.6,
        },
        "note": (
            "Nasdaq-100 (QQQ) 本益比，前10大持股市值加權代理。"
            "tpe=trailing（年度稀釋 EPS，annual-EPS 慣例）；"
            "fpe=後見 forward（hindsight）。排除 PE>70x 及負 EPS 期間。"
        ),
    },
    "SOXX": {
        "out": ROOT / "data" / "SOXX_valuation.json",
        "tpe_cap": 100.0,   # semis can spike; INTC/WOLF may be loss-making
        "min_coverage": 35.0,
        "holdings": {
            "NVDA": 20.0, "AVGO": 8.5, "AMD": 5.0, "QCOM": 5.0,
            "AMAT": 4.5, "MU": 4.5, "LRCX": 4.0, "KLAC": 4.0,
            "TXN": 3.5, "MRVL": 3.5, "INTC": 3.0, "ON": 2.5,
            "MPWR": 2.5, "TER": 2.0, "SMCI": 2.0, "ENTG": 1.8,
            "SWKS": 1.5, "MCHP": 1.4, "ADI": 1.3,
        },
        "note": (
            "費城半導體指數 (SOXX) 本益比，前19大半導體持股加權代理。"
            "tpe=trailing（年度稀釋 EPS）；fpe=後見 forward（hindsight）。"
            "INTC/WOLF 等虧損或 PE>100x 期間自動排除，權重重新歸一化。"
        ),
    },
    "SPY": {
        "out": ROOT / "data" / "SPY_valuation.json",
        "tpe_cap": 60.0,
        "min_coverage": 30.0,
        "holdings": {
            "AAPL": 7.0, "MSFT": 6.5, "NVDA": 6.0, "AMZN": 3.8,
            "META": 2.8, "GOOGL": 2.5, "GOOG": 2.2, "TSLA": 1.8,
            "AVGO": 1.7, "JPM": 1.5, "LLY": 1.4, "V": 1.2,
            "UNH": 1.2, "XOM": 1.1, "COST": 1.0, "MA": 1.0,
            "NFLX": 0.9, "HD": 0.8, "JNJ": 0.7,
        },
        "note": (
            "S&P 500 (SPY) 本益比，前19大持股加權代理（約30%市值）。"
            "tpe=trailing（年度稀釋 EPS）；fpe=後見 forward（hindsight）。"
            "BRK-B 無標準 EPS 故排除；排除 PE>60x 及負 EPS 期間。"
        ),
    },
}


# ── helpers ──────────────────────────────────────────────────────────────────

def fetch_quarterly_eps(sym: str, limit: int = 80) -> pd.DataFrame:
    """Return DataFrame with index=report_date, col='eps' (Reported EPS, quarterly).
    Uses get_earnings_dates which reaches back ~20 years.
    """
    try:
        t = yf.Ticker(sym)
        df = t.get_earnings_dates(limit=limit)
        if df is None or df.empty:
            return pd.DataFrame()
        df = df[df["Reported EPS"].notna()].copy()
        df.index = pd.to_datetime(df.index).tz_localize(None).normalize()
        df = df[["Reported EPS"]].rename(columns={"Reported EPS": "eps"})
        df = df[~df.index.duplicated(keep="last")].sort_index()
        return df
    except Exception as e:
        print(f"    [{sym}] quarterly EPS error: {e}")
        return pd.DataFrame()


def ttm_eps_series(qdf: pd.DataFrame, months: list[str]) -> dict[str, float]:
    """For each month-end in `months`, return TTM EPS = sum of last 4 reported quarters.
    Only returns entries where all 4 quarters are positive (avoid loss periods).
    """
    if qdf.empty:
        return {}
    out: dict[str, float] = {}
    for ym in months:
        # Use end-of-month as cutoff
        y, m = map(int, ym.split("-"))
        cutoff = pd.Timestamp(y, m, 28) + timedelta(days=4)  # past month-end
        past = qdf[qdf.index <= cutoff]
        if len(past) < 4:
            continue
        last4 = past["eps"].iloc[-4:]
        if (last4 <= 0).any():
            continue   # loss quarter in TTM → PE meaningless
        out[ym] = float(last4.sum())
    return out


def fetch_monthly_prices(sym: str) -> dict[str, float]:
    """Return {YYYY-MM: month-end close}, up to 20 years."""
    try:
        hist = yf.Ticker(sym).history(period="max", interval="1mo", auto_adjust=True)
        if hist.empty:
            return {}
        return {str(ts.date())[:7]: float(row["Close"]) for ts, row in hist.iterrows()}
    except Exception as e:
        print(f"    [{sym}] price error: {e}")
        return {}


def backfill_one(cfg_key: str, cfg: dict) -> None:
    holdings: dict[str, float] = cfg["holdings"]
    tpe_cap: float = cfg["tpe_cap"]
    min_cov: float = cfg["min_coverage"]
    out_path: Path = cfg["out"]

    print(f"\n── {cfg_key} ({len(holdings)} stocks) ──")
    all_ttm:  dict[str, dict[str, float]] = {}
    all_px:   dict[str, dict[str, float]] = {}

    for sym in holdings:
        time.sleep(0.5)
        qdf = fetch_quarterly_eps(sym)
        all_px[sym] = fetch_monthly_prices(sym)
        all_months_sym = sorted(all_px[sym])
        all_ttm[sym] = ttm_eps_series(qdf, all_months_sym) if not qdf.empty else {}
        n_q = len(qdf)
        n_ttm = len(all_ttm[sym])
        earliest = min(all_ttm[sym]) if all_ttm[sym] else "—"
        print(f"  [{sym}] {n_q} qtrs → {n_ttm} TTM months (from {earliest})")

    # Build monthly trailing PE
    all_months = sorted({ym for px in all_px.values() for ym in px})
    records: list[dict] = []
    for ym in all_months:
        valid_pe: list[float] = []
        valid_w:  list[float] = []
        for sym, w in holdings.items():
            px  = all_px[sym].get(ym)
            ttm = all_ttm[sym].get(ym)
            if not px or not ttm or px <= 0 or ttm <= 0:
                continue
            tpe = px / ttm
            if 3 < tpe <= tpe_cap:
                valid_pe.append(tpe)
                valid_w.append(w)

        total_w = sum(valid_w)
        if total_w < min_cov:
            continue
        tpe_avg = round(sum(p * w for p, w in zip(valid_pe, valid_w)) / total_w, 2)
        records.append({"date": ym + "-01", "tpe": tpe_avg, "src": "backfill"})

    if not records:
        print(f"  No records — skipping {cfg_key}.")
        return
    print(f"  → {len(records)} monthly TPE: {records[0]['date']} → {records[-1]['date']}")

    # Realized / hindsight forward PE
    avg_px: dict[str, float] = {}
    for ym in all_months:
        prices = [v for sym in holdings if (v := all_px[sym].get(ym))]
        if prices:
            avg_px[ym] = sum(prices) / len(prices)

    tpe_by_ym = {r["date"][:7]: r["tpe"] for r in records}
    fpe_added = 0
    for r in records:
        ym = r["date"][:7]
        y, m = map(int, ym.split("-"))
        fym = f"{y + 1}-{m:02d}"
        if fym in tpe_by_ym and ym in avg_px and fym in avg_px and avg_px[fym]:
            r["fpe"] = round(tpe_by_ym[fym] * avg_px[ym] / avg_px[fym], 2)
            fpe_added += 1
    print(f"  → {fpe_added} realized forward PE points added.")

    # Merge: seed (pre-cutoff) + backfill + daily calc (highest priority)
    import subprocess, json as _json
    ROOT = out_path.parent.parent
    COMMIT = "ae24e23"
    result = subprocess.run(
        ["git", "show", f"{COMMIT}:data/{out_path.name}"],
        capture_output=True, text=True, cwd=ROOT
    )
    seeds = []
    if result.returncode == 0:
        old = _json.loads(result.stdout)
        cutoff = records[0]["date"][:7] if records else "9999-99"
        seeds = [r for r in old.get("data", []) if r.get("src") == "seed" and r["date"][:7] < cutoff]

    existing = _json.loads(out_path.read_text()).get("data", []) if out_path.exists() else []
    keep_calc = {r["date"]: r for r in existing if r.get("src") in ("calc", "calc-live")}

    by_date = {r["date"]: r for r in seeds}
    for r in records:
        by_date[r["date"]] = r
    by_date.update(keep_calc)
    merged = sorted(by_date.values(), key=lambda r: r["date"])

    seed_ct = sum(1 for r in merged if r.get("src") == "seed")
    bf_ct   = sum(1 for r in merged if r.get("src") == "backfill")
    calc_ct = sum(1 for r in merged if r.get("src") in ("calc", "calc-live"))
    print(f"  seed={seed_ct} + backfill={bf_ct} + calc={calc_ct} = {len(merged)} total")

    payload = {"updated": date.today().isoformat(), "note": cfg["note"], "data": merged}
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    print(f"  Wrote {len(merged)} entries → {out_path.name}")


def main() -> None:
    print("Backfilling QQQ / SOXX / SPY PE — quarterly TTM EPS via get_earnings_dates ...")
    for key, cfg in CONFIGS.items():
        backfill_one(key, cfg)
    print("\nDone.")


if __name__ == "__main__":
    main()
