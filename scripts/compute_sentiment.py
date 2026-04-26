"""Compute composite market sentiment score from 4 daily indicators.

Indicators (all daily-updated, no scrapers required):
  1. VIX level           — implied vol; high = fear (inverted)
  2. HYG / LQD ratio     — credit-spread proxy; low ratio = wide spread = fear (inverted)
  3. SPY vs 200-day MA   — trend; below MA = fear (inverted)
  4. TLT 20-day return   — flight-to-safety; positive = fear (inverted)

Each indicator is expanding-window percentile-ranked (0–100), inverted where
needed so that 0 = extreme fear and 100 = extreme greed.  The composite is
the simple average of the four percentile scores.

Point-in-time safety: expanding rank at row i only uses rows 0..i, so there
is no look-ahead bias.  The first ~200 rows are dropped because the SPY 200-day
MA requires at least 200 trading days.
"""
from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"

# --- helpers ----------------------------------------------------------------

def load_close(stem: str) -> pd.Series:
    path = DATA_DIR / f"{stem}.json"
    rows = json.loads(path.read_text())["data"]
    df = pd.DataFrame(rows)[["date", "close"]]
    df["date"] = pd.to_datetime(df["date"])
    df = df.set_index("date")["close"].astype(float)
    return df.sort_index()


ROLL_WIN = 756   # 3-year rolling window (~252 trading days × 3)
MIN_PER  = 60    # need at least 60 days before ranking is meaningful

def rolling_pct_rank(series: pd.Series) -> pd.Series:
    """Percentile rank within a 3-year rolling window (point-in-time safe)."""
    return series.rolling(ROLL_WIN, min_periods=MIN_PER).rank(pct=True) * 100


# --- main -------------------------------------------------------------------

def main() -> None:
    vix = load_close("VIX")
    spy = load_close("SPY")
    gld = load_close("GCF")   # Gold futures — longer history than GLD ETF, works in both
    hyg = load_close("HYG")   # risk-off AND inflationary panics
    lqd = load_close("LQD")

    df = pd.DataFrame({
        "vix": vix,
        "spy": spy,
        "gld": gld,
        "hyg": hyg,
        "lqd": lqd,
    }).sort_index().dropna(subset=["hyg", "lqd"])

    # Derived indicators
    df["hyg_lqd"] = df["hyg"] / df["lqd"]
    df["spy_ma200"] = df["spy"].rolling(200, min_periods=200).mean()
    df["spy_vs_ma"] = (df["spy"] / df["spy_ma200"] - 1) * 100
    df["gld_ret20"] = df["gld"].pct_change(20) * 100   # gold surge = fear

    df = df.dropna(subset=["spy_vs_ma", "gld_ret20"])

    # 3-year rolling percentile rank; invert fear indicators
    df["vix_pct"]    = 100 - rolling_pct_rank(df["vix"])       # high VIX = fear
    df["credit_pct"] = rolling_pct_rank(df["hyg_lqd"])         # low ratio = fear
    df["trend_pct"]  = rolling_pct_rank(df["spy_vs_ma"])       # below MA = fear
    df["safety_pct"] = 100 - rolling_pct_rank(df["gld_ret20"]) # gold surge = fear

    sub_cols = ["vix_pct", "credit_pct", "trend_pct", "safety_pct"]
    df["composite"] = df[sub_cols].mean(axis=1).round(1)

    df = df.dropna(subset=["composite"])

    # --- backtest: SPY forward returns after extreme signals ----------------

    spy_series = spy.sort_index()

    def spy_fwd_ret(signal_date: pd.Timestamp, td: int) -> float | None:
        target = signal_date + pd.Timedelta(days=td)
        future = spy_series[spy_series.index >= target]
        if future.empty:
            return None
        p0 = spy_series.get(signal_date)
        p1 = float(future.iloc[0])
        if p0 is None or np.isnan(p0):
            return None
        return round((p1 / float(p0) - 1) * 100, 2)

    def dedup_signals(mask: pd.Series, gap_days: int = 30) -> list[pd.Timestamp]:
        signals: list[pd.Timestamp] = []
        last: pd.Timestamp | None = None
        for d in df[mask].index:
            if last is None or (d - last).days >= gap_days:
                signals.append(d)
                last = d
        return signals

    fear_dates  = dedup_signals(df["composite"] < 25)
    greed_dates = dedup_signals(df["composite"] > 85)

    def build_signals(dates: list[pd.Timestamp]) -> list[dict]:
        out = []
        for d in dates:
            row = df.loc[d]
            out.append({
                "date":        d.strftime("%Y-%m-%d"),
                "composite":   row["composite"],
                "spy_ret_1m":  spy_fwd_ret(d, 21),
                "spy_ret_3m":  spy_fwd_ret(d, 63),
                "spy_ret_6m":  spy_fwd_ret(d, 126),
                "spy_ret_1y":  spy_fwd_ret(d, 252),
            })
        return out

    def avg_rets(signals: list[dict]) -> dict:
        keys = ["spy_ret_1m", "spy_ret_3m", "spy_ret_6m", "spy_ret_1y"]
        return {
            k: round(sum(s[k] for s in signals if s[k] is not None)
                     / max(1, sum(1 for s in signals if s[k] is not None)), 2)
            for k in keys
        }

    fear_signals  = build_signals(fear_dates)
    greed_signals = build_signals(greed_dates)

    # --- output rows --------------------------------------------------------
    latest_row = df.iloc[-1]
    latest = {
        "date":        df.index[-1].strftime("%Y-%m-%d"),
        "composite":   float(latest_row["composite"]),
        "vix_pct":     round(float(latest_row["vix_pct"]), 1),
        "credit_pct":  round(float(latest_row["credit_pct"]), 1),
        "trend_pct":   round(float(latest_row["trend_pct"]), 1),
        "safety_pct":  round(float(latest_row["safety_pct"]), 1),
    }

    output_rows = [
        {
            "date":        d.strftime("%Y-%m-%d"),
            "composite":   float(row["composite"]),
            "vix_pct":     round(float(row["vix_pct"]), 1),
            "credit_pct":  round(float(row["credit_pct"]), 1),
            "trend_pct":   round(float(row["trend_pct"]), 1),
            "safety_pct":  round(float(row["safety_pct"]), 1),
        }
        for d, row in df[["composite"] + sub_cols].iterrows()
    ]

    payload = {
        "updated": date.today().isoformat(),
        "indicators": {
            "vix":    "VIX 恐懼指數（反向）",
            "credit": "HYG/LQD 信用利差代理（反向）",
            "trend":  "SPY vs 200日均線",
            "safety": "黃金20日報酬（避險資金流向）（反向）",
        },
        "latest":   latest,
        "backtest": {
            "fear_signals":  fear_signals,
            "greed_signals": greed_signals,
            "fear_stats":    avg_rets(fear_signals),
            "greed_stats":   avg_rets(greed_signals),
        },
        "data": output_rows,
    }

    out_path = DATA_DIR / "sentiment.json"
    out_path.write_text(json.dumps(payload, ensure_ascii=False) + "\n")

    print(f"Wrote {len(output_rows)} rows -> {out_path.name}")
    print(f"Latest ({latest['date']}): composite={latest['composite']}")
    print(f"  VIX={latest['vix_pct']}  Credit={latest['credit_pct']}"
          f"  Trend={latest['trend_pct']}  Safety={latest['safety_pct']}")
    print(f"Fear signals: {len(fear_signals)}  |  Greed signals: {len(greed_signals)}")
    if fear_signals:
        fs = avg_rets(fear_signals)
        print(f"Avg SPY after fear: 1M={fs['spy_ret_1m']}%  3M={fs['spy_ret_3m']}%"
              f"  6M={fs['spy_ret_6m']}%  1Y={fs['spy_ret_1y']}%")


if __name__ == "__main__":
    main()
