"""Compute 台股金融壓力指數 (Taiwan Financial Stress composite, 0-100, 越高越有壓力).

A poor-man's Taiwan answer to the US OFR FSI. UNLIKE the 台股情緒 (fear-greed) tab,
this reads in the STRESS direction: high = genuine systemic strain (NOT a contrarian
buy). Each leg → trailing rolling percentile (0-100, higher = more stress), then a
weighted average over whatever legs exist that day (weights renormalised when a leg
is missing, so the series extends back as far as the mix allows).

  fx       匯率波動  : USD/TWD 20日已實現波動 的百分位                       25%  [2004+]
  eqvol    股市波動  : 加權 20日已實現波動 的百分位 (台指VIX 替身)            30%  [1997+]
  margin   融資斷頭  : 大盤融資維持率 的反向百分位 (維持率低=接近斷頭)        20%  [2022-12+]
  foreign  外資避險  : 外資台指期淨未平倉 的反向百分位 (轉空/減多=risk-off)   25%  [2018+]

What's deliberately MISSING (no free Taiwan daily source): a real credit spread
(公司債 vs 公債) and clean inter-bank funding stress. So this captures the
volatility / leverage / positioning corner of stress, not credit/funding.

Inputs : data/{usdtwd,TWII,taiwan_margin_ratio,taiwan_fut_inst}.json
Output : data/taiwan_stress.json
"""
from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = DATA / "taiwan_stress.json"

WIN = 504          # rolling percentile window (~2 trading years)
MIN_P = 60         # min periods before a percentile is emitted
VOL_WIN = 20       # realized-vol lookback (trading days)
WEIGHTS = {"fx": 0.25, "eqvol": 0.30, "margin": 0.20, "foreign": 0.25}

COMPONENT_LABELS = {
    "fx": "USD/TWD 20日已實現波動",
    "eqvol": "加權 20日已實現波動（台指VIX替身）",
    "margin": "大盤融資維持率（反向）",
    "foreign": "外資台指期淨未平倉（反向, risk-off）",
}


def load(name: str) -> list[dict]:
    return json.loads((DATA / f"{name}.json").read_text())["data"]


def roll_pct(s: pd.Series) -> pd.Series:
    """Trailing rolling percentile rank (0-100) of the last value within the window."""
    return s.rolling(WIN, min_periods=MIN_P).apply(
        lambda x: (x <= x[-1]).sum() / len(x) * 100.0, raw=True)


def realized_vol(close: pd.Series) -> pd.Series:
    """Annualised rolling realized vol (%) from daily log returns."""
    ret = np.log(close / close.shift(1))
    return ret.rolling(VOL_WIN, min_periods=VOL_WIN // 2).std() * np.sqrt(252) * 100.0


def main() -> None:
    twii = pd.DataFrame(load("TWII"))[["date", "close"]].rename(columns={"close": "twii"})
    fx = pd.DataFrame(load("usdtwd"))[["date", "close"]].rename(columns={"close": "fx"})
    mar = pd.DataFrame(load("taiwan_margin_ratio"))[["date", "ratio"]].rename(columns={"ratio": "mratio"})
    fut = pd.DataFrame(load("taiwan_fut_inst"))[["date", "foreign_net"]]

    df = twii.merge(fx, on="date", how="left").merge(mar, on="date", how="left") \
             .merge(fut, on="date", how="left").sort_values("date").reset_index(drop=True)
    for c in ("fx", "mratio", "foreign_net"):
        df[c] = pd.to_numeric(df[c], errors="coerce").ffill(limit=3)
    df["twii"] = pd.to_numeric(df["twii"], errors="coerce")

    # raw → stress percentile (higher = MORE stress)
    df["fx"] = roll_pct(realized_vol(df["fx"]))                  # high FX vol = stress
    df["eqvol"] = roll_pct(realized_vol(df["twii"]))             # high equity vol = stress
    df["margin"] = 100.0 - roll_pct(df["mratio"])               # low maintenance ratio = stress
    df["foreign"] = 100.0 - roll_pct(df["foreign_net"])         # low/short foreign futures = risk-off

    comps = list(WEIGHTS)
    W = np.array([WEIGHTS[c] for c in comps])
    M = df[comps].to_numpy(dtype=float)
    mask = ~np.isnan(M)
    wsum = (mask * W).sum(axis=1)
    csum = np.nansum(M * W, axis=1)
    composite = np.divide(csum, wsum, out=np.full_like(csum, np.nan), where=wsum > 0)
    df["composite"] = np.round(composite, 1)

    out = df.dropna(subset=["composite"])
    rows = [{
        "date": r["date"],
        "twii": None if pd.isna(r["twii"]) else round(float(r["twii"]), 2),
        "composite": r["composite"],
        **{c: (None if pd.isna(r[c]) else round(float(r[c]), 1)) for c in comps},
    } for _, r in out.iterrows()]

    latest = rows[-1]
    payload = {
        "source": "PersonalFiance compute_taiwan_stress (匯率波動 + 股市波動 + 融資維持率 + 外資期貨)",
        "note": ("台股金融壓力綜合 0-100，越高壓力越大（非反向情緒）。各leg取2年滾動百分位後加權平均。"
                 "缺 credit spread / funding 兩維（台灣免費端無乾淨日序）。融資維持率僅 2022-12 起，"
                 "該leg百分位歷史較短。"),
        "weights": WEIGHTS,
        "components": COMPONENT_LABELS,
        "updated": date.today().isoformat(),
        "latest": latest,
        "data": rows,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    print(f"Wrote {len(rows)} rows -> {OUT.name} ({rows[0]['date']}..{rows[-1]['date']})")
    print(f"latest: {latest}")


if __name__ == "__main__":
    main()
