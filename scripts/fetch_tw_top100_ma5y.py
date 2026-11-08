#!/usr/bin/env python3
"""權值 100 大落在 5 年線之下的比例 → data/tw_top100_ma5y.json

成分（現在的快照，有存活者偏差）：
  上市普通股（不含 ETF「00」、TDR「91」開頭）依「現在股本 × 最近收盤」取市值前 100 檔。
  股本：TWSE OpenAPI t187ap03_L；收盤：TWSE MI_INDEX（往回找最近有資料的交易日）。
  TWSE 沒有歷史成分查詢，所以過去每一天都用「今天」的前 100 檔回算：當年已下市或掉出前 100 的
  公司不在裡面，歷史比例會偏樂觀（偏低）。

5 年線：與儀表板的長期均線同一算法——月線 60 個月均線＝前 59 個已收完月份的月底收盤＋當天收盤，
  上市滿 60 個月才算（不滿的那天不列入分母）。
個股歷史收盤：Yahoo（代號.TW），auto_adjust=False（已還原分割、未還原股息，和 fetch_stocks.py 一致）。

輸出 {source, note, updated, universe:[{code, mktcap_yi}], data:[{date, n, below, ratio}]}，
date 從 2005-01 起（2000 起抓資料、扣掉 60 個月）。每次整檔重算。
"""
from __future__ import annotations

import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

import pandas as pd
import yfinance as yf

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_twse_mktcap import fetch_close, fetch_shares  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "tw_top100_ma5y.json"
TOP_N = 100
MONTHS = 60
START = "2000-01-01"
OUT_FROM = "2005-01-01"


def universe() -> list[dict]:
    shares = fetch_shares()
    if not shares:
        raise SystemExit("t187ap03_L 抓不到股本")
    closes, d = None, date.today()
    for _ in range(10):
        closes = fetch_close(d.isoformat())
        if closes:
            break
        d -= timedelta(days=1)
    if not closes:
        raise SystemExit("MI_INDEX 近 10 天都抓不到收盤")
    caps = [(c, shares[c] * closes[c] / 1e8) for c in shares
            if c in closes and len(c) == 4 and not c.startswith(("00", "91"))]
    caps.sort(key=lambda x: -x[1])
    return [{"code": c, "mktcap_yi": round(m, 1)} for c, m in caps[:TOP_N]]


def history(codes: list[str]) -> pd.DataFrame:
    df = yf.download([f"{c}.TW" for c in codes], start=START,
                     end=(date.today() + timedelta(days=1)).isoformat(),
                     auto_adjust=False, progress=False, threads=True)["Close"]
    df.columns = [str(c).removesuffix(".TW") for c in df.columns]
    return df.sort_index()


def below_flags(s: pd.Series) -> pd.Series:
    """每天：收盤 < 月線 60 個月均線 → True／False；不滿 60 個月或無收盤 → NaN。"""
    s = s.dropna()
    out = pd.Series(index=s.index, dtype="float64")
    if s.empty:
        return out
    month = s.index.to_period("M")
    month_close = s.groupby(month).last()
    prev_sum = month_close.rolling(MONTHS - 1).sum().shift(1)   # 前 59 個已收完月份
    have = pd.Series(range(len(month_close)), index=month_close.index) >= MONTHS
    ps, ok = prev_sum.reindex(month).to_numpy(), have.reindex(month).to_numpy()
    ma = (ps + s.to_numpy()) / MONTHS
    out[:] = [float(c < m) if k and m == m else float("nan") for c, m, k in zip(s.to_numpy(), ma, ok)]
    return out


def main() -> None:
    uni = universe()
    df = history([u["code"] for u in uni])
    flags = pd.DataFrame({c: below_flags(df[c]) for c in df.columns})
    n, below = flags.notna().sum(axis=1), flags.sum(axis=1)
    data = [{"date": d.strftime("%Y-%m-%d"), "n": int(k), "below": int(b), "ratio": round(b / k, 4)}
            for d, k, b in zip(flags.index, n, below) if k > 0 and d.strftime("%Y-%m-%d") >= OUT_FROM]
    missing = [u["code"] for u in uni if u["code"] not in df.columns or df[u["code"]].dropna().empty]
    OUT.write_text(json.dumps({
        "source": "TWSE OpenAPI t187ap03_L（股本）× MI_INDEX（收盤）選成分；個股歷史收盤 Yahoo（代號.TW）",
        "note": ("成分＝執行當天市值前 100 檔上市普通股（不含 ETF、TDR），過去每天都用同一批回算，有存活者偏差。"
                 "5 年線＝月線 60 個月均線（前 59 個月底收盤＋當天收盤），上市未滿 60 個月不列入分母。"
                 f"Yahoo 抓不到的代號：{', '.join(missing) or '無'}。"),
        "updated": datetime.now().strftime("%Y-%m-%d"),
        "universe": uni,
        "data": data,
    }, ensure_ascii=False) + "\n")
    print(f"wrote {len(data)} rows; last {data[-1]}; missing {missing}")


if __name__ == "__main__":
    main()
