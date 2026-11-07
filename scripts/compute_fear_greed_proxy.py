"""Backfill CNN Fear & Greed sub-indicators before CNN's own history (2020-08).

CNN's graphdata endpoint only serves the seven raw readings from ~2020-08. For
2009-01 .. day before CNN's first row this script rebuilds each reading from free
data, fits it linearly onto CNN's scale over the overlap, and writes
data/fear_greed_proxy.json (same field names as data/fear_greed_components.json).

Manual one-off (status manual_research, not in fetch.yml): the constituent
download is ~500 tickers and the output never changes once CNN covers the
overlap. Re-run only to refresh the calibration:
    .venv/bin/python scripts/compute_fear_greed_proxy.py

Proxies (overlap correlation of the 126-day z score with CNN's raw, 2020-08..):
  sp500/sp125     ^GSPC close and its 125-day MA           (exact definition)
  vix/vix50       VIX close and its 50-day MA              (exact definition)
  put_call        Cboe equity P/C, 5-day mean (putcall.json) ~0.99
  safe_haven      SPY minus IEF 20-day total return, %       ~0.96
  junk            HYG minus LQD trailing-12m distribution yield, %  ~0.80
  strength        current S&P 500 members: (52w highs - lows) / n, 20-day mean ~0.85
  breadth         current S&P 500 members: McClellan volume summation ~0.70
strength/breadth use today's constituents (survivorship bias grows going back).
"""
from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
import yfinance as yf

from fetch_breadth import get_sp500_tickers

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = DATA / "fear_greed_proxy.json"
START = "2007-06-01"      # warm-up for 252-day highs and 126-day scoring windows
KEEP_FROM = "2008-06-01"  # rows kept so scores (126-day window) exist from 2009-01


def rows_series(path: Path, field: str = "close") -> pd.Series:
    rows = json.loads(path.read_text())["data"]
    s = pd.Series({r["date"]: r.get(field) for r in rows}, dtype=float)
    s.index = pd.to_datetime(s.index)
    return s.sort_index()


def trailing_yield(ticker: str) -> pd.Series:
    h = yf.Ticker(ticker).history(start=START, auto_adjust=False)
    h.index = h.index.tz_localize(None).normalize()
    return h["Dividends"].rolling("365D").sum() / h["Close"] * 100


def constituents_breadth() -> tuple[pd.Series, pd.Series]:
    tickers = get_sp500_tickers()
    print(f"  downloading {len(tickers)} S&P 500 members ...")
    df = yf.download(tickers, start=START, auto_adjust=False, group_by="column", threads=True, progress=False)
    close, vol = df["Close"], df["Volume"]
    hi, lo = close.rolling(252, min_periods=200).max(), close.rolling(252, min_periods=200).min()
    n = (close.notna() & hi.notna()).sum(axis=1).replace(0, np.nan)
    strength = (((close >= hi).sum(axis=1) - (close <= lo).sum(axis=1)) / n * 100).rolling(20).mean()
    ret = close.pct_change(fill_method=None)
    up, dn = vol.where(ret > 0).sum(axis=1), vol.where(ret < 0).sum(axis=1)
    net = (up - dn) / (up + dn) * 1000
    osc = net.ewm(span=19, adjust=False).mean() - net.ewm(span=39, adjust=False).mean()
    return strength, osc.cumsum()


def main() -> None:
    cnn = pd.DataFrame(json.loads((DATA / "fear_greed_components.json").read_text())["data"]).set_index("date")
    cnn.index = pd.to_datetime(cnn.index)
    first_cnn = cnn.index.min()

    sp = rows_series(DATA / "SP500.json")
    vix = rows_series(DATA / "VIX.json")
    pc = json.loads((DATA / "putcall.json").read_text())["equity"]
    pc = pd.Series({r["date"]: r["pc"] for r in pc}, dtype=float)
    pc.index = pd.to_datetime(pc.index)
    px = yf.download(["SPY", "IEF"], start=START, auto_adjust=True, progress=False)["Close"]
    strength, breadth = constituents_breadth()

    raw = pd.DataFrame({
        "sp500": sp, "sp125": sp.rolling(125).mean(),
        "vix": vix, "vix50": vix.rolling(50).mean(),
        "put_call": pc.sort_index().rolling(5).mean(),
        "safe_haven": (px["SPY"].pct_change(20) - px["IEF"].pct_change(20)) * 100,
        "junk": trailing_yield("HYG") - trailing_yield("LQD"),
        "strength": strength, "breadth": breadth,
    }).reindex(sp.index[sp.index >= pd.Timestamp(START)])

    out = pd.DataFrame(index=raw.index)
    calibration = {}
    for col in raw.columns:
        j = pd.concat([raw[col], cnn[col]], axis=1, join="inner").dropna()
        a, b = np.polyfit(j.iloc[:, 0], j.iloc[:, 1], 1)
        out[col] = raw[col] * a + b
        calibration[col] = {"slope": round(float(a), 6), "intercept": round(float(b), 6),
                            "overlap_corr": round(float(j.corr().iloc[0, 1]), 4), "n": len(j)}
        print(f"  {col:10s} corr {calibration[col]['overlap_corr']:.3f}")

    out = out[(out.index >= pd.Timestamp(KEEP_FROM)) & (out.index < first_cnn)]
    rows = []
    for d, r in out.iterrows():
        row = {"date": d.date().isoformat()}
        row.update({k: round(float(v), 6) for k, v in r.items() if np.isfinite(v)})
        rows.append(row)
    payload = {
        "source": "Proxy rebuilt from free data (Yahoo Finance, Cboe archive, current S&P 500 members), "
                  "linearly calibrated to CNN raw readings over the overlap",
        "updated": date.today().isoformat(),
        "proxy_until": (first_cnn - pd.Timedelta(days=1)).date().isoformat(),
        "calibration": calibration,
        "data": rows,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    print(f"Wrote {len(rows)} proxy rows -> {OUT.name}")


if __name__ == "__main__":
    main()
