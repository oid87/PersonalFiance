"""臺灣50 成分股均線廣度：每天站上 20／50／100／200 日均線的檔數占比（point-in-time 成分股，_tw50_history）。
輸出 data/tw50_ma_breadth.json：[{date, n, p20, p50, p100, p200}]，2014-01 起。
價格用 yfinance auto_adjust（還原除權息，避免除息缺口讓股價誤跌破均線）；每次整段重算（約 120 檔，1 次下載）。
"""
from __future__ import annotations
import json
from datetime import date
from pathlib import Path

import pandas as pd
import yfinance as yf

import _tw50_history as T

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "tw50_ma_breadth.json"
START, DL_START = "2014-01-01", "2012-12-01"
MAS = (20, 50, 100, 200)
MIN_N = 40  # 當天有效檔數不足就不寫


def main() -> None:
    codes = sorted({c for eff, s in T.TIMELINE if not eff or eff >= "2013" for c in s} | set(T.members_on(START)))
    raw = yf.download([c + ".TW" for c in codes], start=DL_START, auto_adjust=True, progress=False, threads=True)["Close"]
    raw.columns = [c.replace(".TW", "") for c in raw.columns]
    raw = raw.dropna(how="all")
    ma = {m: raw.rolling(m, min_periods=m).mean() for m in MAS}
    rows = []
    for ts in raw.index:
        d = ts.strftime("%Y-%m-%d")
        if d < START:
            continue
        mem = [c for c in T.members_on(d) if c in raw.columns]
        row, n_ok = {"date": d}, None
        for m in MAS:
            px, mv = raw.loc[ts, mem], ma[m].loc[ts, mem]
            ok = px.notna() & mv.notna()
            k = int(ok.sum())
            row[f"p{m}"] = round(float((px[ok] > mv[ok]).sum()) / k * 100, 1) if k >= MIN_N else None
            n_ok = k if m == 20 else n_ok
        row["n"] = n_ok
        if row["p20"] is not None:
            rows.append(row)
    missing = [c for c in codes if c not in raw.columns or raw[c].notna().sum() == 0]
    OUT.write_text(json.dumps({
        "source": "yfinance (auto_adjust) + scripts/_tw50_history.py",
        "note": "臺灣50 point-in-time 成分股站上 20/50/100/200 日均線占比 %；n＝當天有 20MA 的檔數",
        "missing": missing, "updated": date.today().isoformat(), "data": rows,
    }, ensure_ascii=False, separators=(",", ":")))
    print(f"tw50_ma_breadth: {len(rows)} rows {rows[0]['date']}..{rows[-1]['date']}, missing {missing}")


if __name__ == "__main__":
    main()
