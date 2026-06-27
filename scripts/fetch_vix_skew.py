"""VIX-SKEW Sequential Divergence Monitor

Output: data/vix_skew.json

信號邏輯（按序列式，非靜態）：
  Phase 1 — Sync Rise：VIX 和 SKEW 在 25 個交易日內同步上漲 (VIX >25%, SKEW >5%)
  Phase 2 — Divergence：VIX 從峰值回落 >15%，但 SKEW 仍在峰值 5% 以內
  加強項：SPY < 200MA（趨勢反轉）+ 市寬 < 50%

資料來源：
  ^SKEW, SPY: yfinance（1993+）
  VIX: 從 data/VIX_early.json + data/VIX.json 拼接（避免重複下載）
"""
from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import yfinance as yf

ROOT    = Path(__file__).resolve().parent.parent
DATA    = ROOT / "data"
OUT     = DATA / "vix_skew.json"

FRESHNESS_DAYS = 3
SYNC_WINDOW    = 25
VIX_SYNC_THR   = 0.25
SKEW_SYNC_THR  = 0.05
VIX_REV_THR    = -0.15
SKEW_HOLD_THR  = -0.05
GAP_DAYS       = 40
ROLL_WIN_PCT   = 504   # 2Y rolling for percentile rank


def is_fresh() -> bool:
    if not OUT.exists():
        return False
    try:
        d = json.loads(OUT.read_text())
        updated = d.get("updated", "")
        return (date.today() - date.fromisoformat(updated)).days <= FRESHNESS_DAYS
    except Exception:
        return False


def load_vix_from_cache() -> pd.Series:
    """Stitch VIX_early.json (1986-1999) + VIX.json (2000-now) → pd.Series indexed by date."""
    parts = []
    for fname in ("VIX_early.json", "VIX.json"):
        p = DATA / fname
        if not p.exists():
            continue
        rows = json.loads(p.read_text()).get("data", [])
        df = pd.DataFrame(rows)[["date", "close"]]
        df["date"] = pd.to_datetime(df["date"])
        parts.append(df.set_index("date")["close"].astype(float))
    if not parts:
        raise RuntimeError("VIX data files not found; run fetch_stocks.py first")
    combined = pd.concat(parts).sort_index()
    combined = combined[~combined.index.duplicated(keep="last")]
    return combined


def load_breadth() -> pd.Series | None:
    p = DATA / "breadth.json"
    if not p.exists():
        return None
    try:
        rows = json.loads(p.read_text()).get("data", [])
        df = pd.DataFrame(rows)[["date", "above200_pct"]].dropna()
        df["date"] = pd.to_datetime(df["date"])
        return df.set_index("date")["above200_pct"].astype(float)
    except Exception:
        return None


def roll_pct(s: pd.Series, win: int = ROLL_WIN_PCT) -> pd.Series:
    return s.rolling(win, min_periods=60).rank(pct=True) * 100


def expand_pct(s: pd.Series) -> pd.Series:
    return s.expanding(min_periods=60).rank(pct=True) * 100


def main() -> None:
    if is_fresh():
        print(f"vix_skew.json is fresh, skipping.")
        return

    print("Fetching SKEW + SPY …")
    raw = yf.download(["^SKEW", "SPY"], start="1993-01-01",
                      auto_adjust=True, progress=False)
    closes = raw["Close"].rename(columns={"^SKEW": "skew", "SPY": "spy"})

    vix = load_vix_from_cache()
    df = pd.DataFrame({"vix": vix, "skew": closes["skew"], "spy": closes["spy"]})
    df = df.dropna(subset=["vix", "skew", "spy"]).sort_index()
    print(f"  Combined: {len(df)} rows, {df.index[0].date()} – {df.index[-1].date()}")

    breadth = load_breadth()
    if breadth is not None:
        breadth = breadth.reindex(df.index, method="ffill")

    # ── Percentile ranks ──────────────────────────────────────────────────────
    df["vix_pct"]      = roll_pct(df["vix"])
    df["skew_pct"]     = roll_pct(df["skew"])
    df["skew_pct_all"] = expand_pct(df["skew"])   # all-history expanding
    df["div_score"]    = df["skew_pct"] - df["vix_pct"]

    # ── 200MA trend filter ────────────────────────────────────────────────────
    df["spy_ma200"]  = df["spy"].rolling(200, min_periods=200).mean()
    df["bear_trend"] = (df["spy"] < df["spy_ma200"]).astype(float)

    # ── Rolling metrics for sequential signal ─────────────────────────────────
    df["vix_ret25"]  = df["vix"].pct_change(SYNC_WINDOW)
    df["skew_ret25"] = df["skew"].pct_change(SYNC_WINDOW)
    df["sync_on"]    = (df["vix_ret25"] > VIX_SYNC_THR) & (df["skew_ret25"] > SKEW_SYNC_THR)

    df = df.dropna(subset=["vix_pct", "vix_ret25", "spy_ma200"])

    # ── Sequential signal detection ───────────────────────────────────────────
    spy_s = df["spy"]

    def fwd_ret(dt: pd.Timestamp, td: int) -> float | None:
        future = spy_s[spy_s.index > dt]
        if len(future) < td:
            return None
        return round((float(future.iloc[td - 1]) / float(spy_s[dt]) - 1) * 100, 2)

    signals: list[dict] = []
    last_signal: pd.Timestamp | None = None
    idxs = list(range(len(df)))

    for i in range(SYNC_WINDOW, len(df)):
        dt = df.index[i]
        if last_signal and (dt - last_signal).days < GAP_DAYS:
            continue

        lb = df.iloc[max(0, i - SYNC_WINDOW): i]
        if not lb["sync_on"].any():
            continue

        vix_peak  = float(lb["vix"].max())
        skew_peak = float(lb["skew"].max())
        spy_at    = float(df.iloc[i]["spy"])
        vix_now   = float(df.iloc[i]["vix"])
        skew_now  = float(df.iloc[i]["skew"])

        vix_rev  = (vix_now / vix_peak - 1) < VIX_REV_THR
        skew_hld = (skew_now / skew_peak - 1) > SKEW_HOLD_THR

        if not (vix_rev and skew_hld):
            continue

        bear = bool(df.iloc[i]["bear_trend"])
        row: dict = {
            "date":        dt.strftime("%Y-%m-%d"),
            "vix":         round(vix_now, 1),
            "skew":        round(skew_now, 1),
            "spy":         round(spy_at, 2),
            "vix_peak":    round(vix_peak, 1),
            "skew_peak":   round(skew_peak, 1),
            "vix_drop":    round((vix_now / vix_peak - 1) * 100, 1),
            "skew_hold":   round((skew_now / skew_peak - 1) * 100, 1),
            "bear_trend":  bear,
        }
        if breadth is not None and dt in breadth.index and not np.isnan(float(breadth[dt])):
            row["above200"] = round(float(breadth[dt]), 1)
        for td in [10, 21, 42, 63]:
            row[f"ret_{td}d"] = fwd_ret(dt, td)

        signals.append(row)
        last_signal = dt

    # ── Current reading ───────────────────────────────────────────────────────
    last_i   = len(df) - 1
    dt_last  = df.index[last_i]
    lb_last  = df.iloc[max(0, last_i - SYNC_WINDOW): last_i]
    vix_peak_now  = float(lb_last["vix"].max())  if not lb_last.empty else float(df.iloc[last_i]["vix"])
    skew_peak_now = float(lb_last["skew"].max()) if not lb_last.empty else float(df.iloc[last_i]["skew"])
    vix_now   = float(df.iloc[last_i]["vix"])
    skew_now  = float(df.iloc[last_i]["skew"])
    spy_now   = float(df.iloc[last_i]["spy"])

    seq_alert = (
        lb_last["sync_on"].any()
        and (vix_now / vix_peak_now - 1) < VIX_REV_THR
        and (skew_now / skew_peak_now - 1) > SKEW_HOLD_THR
    )
    bear_now    = bool(df.iloc[last_i]["bear_trend"])
    breadth_now = round(float(breadth.iloc[-1]), 1) if breadth is not None else None

    current = {
        "date":           dt_last.strftime("%Y-%m-%d"),
        "vix":            round(vix_now, 1),
        "skew":           round(skew_now, 1),
        "spy":            round(spy_now, 2),
        "vix_pct_2y":     round(float(df.iloc[last_i]["vix_pct"]), 1),
        "skew_pct_2y":    round(float(df.iloc[last_i]["skew_pct"]), 1),
        "skew_pct_all":   round(float(df.iloc[last_i]["skew_pct_all"]), 1),
        "div_score":      round(float(df.iloc[last_i]["div_score"]), 1),
        "vix_peak_25d":   round(vix_peak_now, 1),
        "skew_peak_25d":  round(skew_peak_now, 1),
        "vix_from_peak":  round((vix_now / vix_peak_now - 1) * 100, 1),
        "skew_from_peak": round((skew_now / skew_peak_now - 1) * 100, 1),
        "seq_alert":      seq_alert,
        "bear_trend":     bear_now,
        "breadth_above200": breadth_now,
        "breadth_weak":   breadth_now is not None and breadth_now < 50,
        "full_alert":     seq_alert and bear_now,
    }

    # ── History rows (all trading days → frontend samples as needed) ──────────
    history_rows = []
    for idx, row in df.iterrows():
        d_str = idx.strftime("%Y-%m-%d")
        r: dict = {
            "d":   d_str,
            "v":   round(float(row["vix"]), 2),
            "sk":  round(float(row["skew"]), 1),
            "sp":  round(float(row["spy"]), 2),
        }
        if not np.isnan(float(row["div_score"])):
            r["ds"] = round(float(row["div_score"]), 1)
        history_rows.append(r)

    payload = {
        "updated":  date.today().isoformat(),
        "current":  current,
        "signals":  signals,
        "history":  history_rows,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    print(f"Wrote {len(history_rows)} history rows, {len(signals)} signals → {OUT.name}")
    print(f"Current: VIX={current['vix']}  SKEW={current['skew']}  "
          f"seq_alert={'⚠️' if current['seq_alert'] else 'OK'}  "
          f"full_alert={'🚨' if current['full_alert'] else 'OK'}")


if __name__ == "__main__":
    main()
