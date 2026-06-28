"""Fetch weekly signed dollar volume for SOXX+SMH, QQQ, 0050.TW
→ data/flows.json

Proxy for ETF fund flows: weekly (volume × close × sign_of_weekly_return).
Not actual fund flows (requires Bloomberg), but captures sentiment pulse direction.

Sources (all free via yfinance, no API key):
  SOXX + SMH  — semiconductor ETFs
  QQQ         — Nasdaq-100 ETF
  0050.TW     — Taiwan 50 ETF

Output data/flows.json:
  {source, note, updated,
   semi:  [{date, flow}],   # SOXX + SMH combined, weekly $ billions
   qqq:   [{date, flow}],   # QQQ weekly $ billions
   tw50:  [{date, flow}]}   # 0050.TW weekly NT$ billions
"""
from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "flows.json"


def weekly_signed_dollar_volume(tickers: list[str], start: str = "2012-01-01") -> list[dict]:
    combined_dv = None
    combined_close = None

    for tk in tickers:
        hist = yf.Ticker(tk).history(start=start, auto_adjust=False)
        if hist.empty:
            print(f"  [warn] {tk}: no data")
            continue
        hist = hist[~hist.index.duplicated(keep="first")]
        dv = hist["Close"] * hist["Volume"]
        cl = hist["Close"]
        if combined_dv is None:
            combined_dv = dv
            combined_close = cl
        else:
            combined_dv = combined_dv.add(dv, fill_value=0)
            combined_close = combined_close.add(cl, fill_value=0)

    if combined_dv is None:
        return []

    weekly_dv = combined_dv.resample("W").sum()
    weekly_close = combined_close.resample("W").last()
    weekly_ret = weekly_close.pct_change()

    signed = weekly_dv * weekly_ret.apply(lambda x: 1 if x >= 0 else -1)
    signed = signed.dropna()

    return [
        {"date": d.strftime("%Y-%m-%d"), "flow": round(v / 1e9, 3)}
        for d, v in signed.items()
        if pd.notna(v)
    ]


def main():
    print("Fetching SOXX + SMH (semiconductor)...")
    semi = weekly_signed_dollar_volume(["SOXX", "SMH"])
    print(f"  → {len(semi)} weeks")

    print("Fetching QQQ...")
    qqq = weekly_signed_dollar_volume(["QQQ"])
    print(f"  → {len(qqq)} weeks")

    print("Fetching 0050.TW (Taiwan 50)...")
    tw50 = weekly_signed_dollar_volume(["0050.TW"])
    print(f"  → {len(tw50)} weeks")

    payload = {
        "source": "yfinance (volume × close × weekly return sign)",
        "note": "Signed dollar volume proxy — not actual fund flows. "
                "Semi = SOXX + SMH combined; QQQ; TW50 = 0050.TW (NT$ billions)",
        "updated": date.today().isoformat(),
        "semi": semi,
        "qqq": qqq,
        "tw50": tw50,
    }

    OUT.write_text(json.dumps(payload) + "\n")
    print(f"Wrote {OUT} ({OUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
