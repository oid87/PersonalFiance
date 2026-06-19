"""Compute 台股恐懼貪婪指數 (Taiwan Fear & Greed composite, 0-100, 越高越貪婪).

Mirrors the US compute_sentiment.py idea: each component is normalised to 0-100 by
its trailing rolling percentile, then weighted-averaged. Components all read
"crowd greed" in the same direction:

  pc      選擇權避險  : P/C 成交量比(8日均) 的反向百分位 (P/C 高=恐慌=低分)   30%  [2005+]
  retail  散戶部位    : 台指期散戶淨多 的百分位 (散戶越偏多=越貪婪)            25%  [2018+]
  trend   價格動能    : 加權 距 200MA 偏離 的百分位                           25%  [1997+]
  lev     槓桿        : 大盤融資餘額 20日變動% 的百分位                       20%  [2008+]

Missing components (before their start date) are dropped and weights renormalised,
so the composite extends back as far as the available mix allows.

Inputs : data/{TWII,taiwan_pcratio,taiwan_fut_inst,taiwan_margin_total}.json
Output : data/taiwan_sentiment.json
"""
from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = DATA / "taiwan_sentiment.json"

WIN = 504          # rolling percentile window (~2 trading years)
MIN_P = 60         # min periods before a percentile is emitted
WEIGHTS = {"pc": 0.30, "retail": 0.25, "trend": 0.25, "lev": 0.20}


def load(name: str) -> list[dict]:
    return json.loads((DATA / f"{name}.json").read_text())["data"]


def roll_pct(s: pd.Series) -> pd.Series:
    """Trailing rolling percentile rank (0-100) of the last value within the window."""
    return s.rolling(WIN, min_periods=MIN_P).apply(
        lambda x: (x <= x[-1]).sum() / len(x) * 100.0, raw=True)


def main() -> None:
    twii = pd.DataFrame(load("TWII"))[["date", "close"]].rename(columns={"close": "twii"})
    pc = pd.DataFrame(load("taiwan_pcratio"))[["date", "vol_pc"]]
    fut = pd.DataFrame(load("taiwan_fut_inst"))[["date", "retail_net"]]
    mar = pd.DataFrame(load("taiwan_margin_total"))[["date", "margin_money"]]

    df = twii.merge(pc, on="date", how="left").merge(fut, on="date", how="left") \
             .merge(mar, on="date", how="left").sort_values("date").reset_index(drop=True)
    # small-gap fill for the slower/holiday-misaligned series
    for c in ("vol_pc", "retail_net", "margin_money"):
        df[c] = df[c].ffill(limit=3)

    df["twii"] = pd.to_numeric(df["twii"], errors="coerce")

    # raw component signals (higher = more greed BEFORE percentile, except pc which we invert)
    pc_ma = df["vol_pc"].rolling(8, min_periods=3).mean()
    df["pc"] = 100.0 - roll_pct(pc_ma)                              # invert: high P/C = fear
    df["retail"] = roll_pct(df["retail_net"])
    ma200 = df["twii"].rolling(200, min_periods=100).mean()
    df["trend"] = roll_pct(df["twii"] / ma200 - 1.0)
    df["lev"] = roll_pct(df["margin_money"].pct_change(20) * 100.0)

    # weighted average over whatever components are present that day
    comps = list(WEIGHTS)
    W = np.array([WEIGHTS[c] for c in comps])
    M = df[comps].to_numpy(dtype=float)              # (n, k)
    mask = ~np.isnan(M)
    wsum = (mask * W).sum(axis=1)
    csum = np.nansum(M * W, axis=1)
    composite = np.where(wsum > 0, csum / wsum, np.nan)
    df["composite"] = np.round(composite, 1)

    out = df.dropna(subset=["composite"])
    rows = [{
        "date": r["date"],
        "composite": r["composite"],
        "pc": None if pd.isna(r["pc"]) else round(r["pc"], 1),
        "retail": None if pd.isna(r["retail"]) else round(r["retail"], 1),
        "trend": None if pd.isna(r["trend"]) else round(r["trend"], 1),
        "lev": None if pd.isna(r["lev"]) else round(r["lev"], 1),
    } for _, r in out.iterrows()]

    latest = rows[-1]
    payload = {
        "source": "PersonalFiance compute_taiwan_sentiment (P/C + 散戶多空 + 趨勢 + 融資)",
        "weights": WEIGHTS,
        "components": {
            "pc": "選擇權 P/C 成交量比 8日均（反向）",
            "retail": "台指期散戶淨多",
            "trend": "加權距 200MA 偏離",
            "lev": "大盤融資餘額 20日變動%",
        },
        "updated": date.today().isoformat(),
        "latest": latest,
        "data": rows,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    print(f"Wrote {len(rows)} rows -> {OUT.name} ({rows[0]['date']}..{rows[-1]['date']})")
    print(f"latest: {latest}")


if __name__ == "__main__":
    main()
