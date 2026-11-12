"""市場廣度與流動性預警（#tab=breadthwarn）的每日增量：臺灣50／上市／上櫃的站上均線比例、新高新低、漲跌、跌停與量能代理。
輸出 data/tw_breadth_warn.json（欄位式）：date[]、tw50{…}、twse{…}、tpex{…}，欄位定義見 scripts/_tw_breadth_warn.py。
來源：TWSE／TPEx OpenAPI t187ap03（現存上市／上櫃公司清單，免 token）、Yahoo Finance 逐檔日線（最近約兩年，還原收盤＋原始收盤＋成交量）、
      scripts/_tw50_history.py（臺灣50 當時成分股）。
每日只重算最近 TAIL 個交易日並依日期覆蓋；更早的歷史（2004 起，含已下市櫃股票）由一次性回補產生，不在這裡重抓。
既有檔不存在、清單或價格抓不到、最新一天檔數明顯不足時中止並保留舊檔。
"""
from __future__ import annotations

import json
import re
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import requests

import _common
import _tw50_history
import _tw_breadth_warn as bw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "tw_breadth_warn.json"
TWSE_LIST = "https://openapi.twse.com.tw/v1/opendata/t187ap03_L"
TPEX_LIST = "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O"
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)"}
TAIL = 15          # 每次覆蓋最近幾個交易日
LOOKBACK = 520     # 下載的日曆天數（200 日均線＋緩衝）
CHUNK = 150
SKIP_INDUSTRY = {"ETF", "ETN", "Index", "存託憑證", "受益證券", "大盤", "所有證券"}


def universe() -> dict[str, list[str]]:
    """現存上市／上櫃公司代號（交易所 OpenAPI，免 token）。只留 4 碼普通股，排除 91xx 存託憑證。"""
    out = {}
    for typ, url, key in (("twse", TWSE_LIST, "公司代號"), ("tpex", TPEX_LIST, "SecuritiesCompanyCode")):
        rows = _common.retry_call(lambda u=url: requests.get(u, headers=UA, timeout=40).json(), attempts=3, backoff=5)
        out[typ] = sorted({str(r.get(key, "")).strip() for r in rows if re.fullmatch(r"[1-8]\d{3}|9[02-9]\d{2}", str(r.get(key, "")).strip())})
    if len(out["twse"]) < 800 or len(out["tpex"]) < 600:
        raise SystemExit(f"tw_breadth_warn: universe too small {len(out['twse'])}/{len(out['tpex'])}")
    return out


def download(ids: list[str], suffix: str, start: str) -> dict[str, pd.DataFrame]:
    import yfinance as yf
    frames = []
    for i in range(0, len(ids), CHUNK):
        ch = [x + suffix for x in ids[i:i + CHUNK]]
        df = pd.DataFrame()
        for attempt in range(3):
            try:
                df = yf.download(ch, start=start, auto_adjust=False, progress=False, threads=True, group_by="column")
            except Exception as e:  # noqa: BLE001
                print(f"  chunk {i} attempt {attempt + 1}: {type(e).__name__}")
            if not df.empty:
                break
            time.sleep(4)
        if not df.empty:
            frames.append(df)
        time.sleep(1)
    if not frames:
        raise SystemExit(f"tw_breadth_warn: Yahoo returned nothing for {suffix}")
    d = pd.concat(frames, axis=1, sort=True)
    d = d.loc[~d.index.duplicated()].sort_index()
    d.index = pd.DatetimeIndex(d.index).tz_localize(None)
    res = {}
    for k in ("Adj Close", "Close", "Volume"):
        x = d[k].astype("float64")
        x.columns = [c.split(".")[0] for c in x.columns]
        res[k] = x.dropna(axis=1, how="all")
    return res


def main() -> None:
    if not OUT.exists():
        raise SystemExit("tw_breadth_warn: data/tw_breadth_warn.json 不存在；先跑一次性回補")
    old = json.loads(OUT.read_text())
    uni = universe()
    start = (date.today() - timedelta(days=LOOKBACK)).isoformat()
    px = {"twse": download(uni["twse"], ".TW", start), "tpex": download(uni["tpex"], ".TWO", start)}
    res = {t: bw.compute(px[t]["Adj Close"], px[t]["Close"], px[t]["Volume"]) for t in ("twse", "tpex")}
    ever = sorted(set().union(*[s for _, s in _tw50_history.TIMELINE]))
    a = pd.concat([px["twse"]["Adj Close"], px["tpex"]["Adj Close"]], axis=1, sort=True)
    cols = [s for s in ever if s in a.columns]
    a50 = a[cols].loc[:, ~a[cols].columns.duplicated()]
    c50 = pd.concat([px["twse"]["Close"], px["tpex"]["Close"]], axis=1, sort=True)[a50.columns].loc[:, lambda x: ~x.columns.duplicated()]
    v50 = pd.concat([px["twse"]["Volume"], px["tpex"]["Volume"]], axis=1, sort=True)[a50.columns].loc[:, lambda x: ~x.columns.duplicated()]
    mask = pd.DataFrame([[s in _tw50_history.members_on(d.strftime("%Y-%m-%d")) for s in a50.columns] for d in a50.index], index=a50.index, columns=a50.columns)
    res["tw50"] = bw.compute(a50, c50, v50, mask)
    idx = res["twse"].index
    # 最新一天若 Yahoo 還沒補齊（檔數比前 20 日中位少一成以上）就不寫那一天
    ok = (res["twse"]["n"] >= 0.9 * res["twse"]["n"].rolling(20, min_periods=5).median().shift(1)) & (res["tw50"]["n"].reindex(idx) >= 45)
    days = [d for d in idx[ok.fillna(False)] if res["twse"]["a200"].notna().get(d, False)][-TAIL:]
    # 盤中執行時 Yahoo 會給未收盤的當天，一律不寫
    now = datetime.now(timezone(timedelta(hours=8)))
    if now.hour < 15:
        days = [d for d in days if d.strftime("%Y-%m-%d") < now.strftime("%Y-%m-%d")]
    if not days:
        raise SystemExit("tw_breadth_warn: no complete recent day; keep existing file")
    pos = {d: i for i, d in enumerate(old["date"])}
    for d in days:
        ds = d.strftime("%Y-%m-%d")
        if ds < old["date"][-1] and ds not in pos:
            continue
        if ds not in pos:
            pos[ds] = len(old["date"]); old["date"].append(ds)
            for u in ("tw50", "twse", "tpex"):
                for f in bw.FIELDS:
                    old[u][f].append(None)
        i = pos[ds]
        for u in ("tw50", "twse", "tpex"):
            if d not in res[u].index:
                continue
            row = bw.to_columns(res[u].loc[[d]])
            for f in bw.FIELDS:
                old[u][f][i] = row[f][0]
    n = len(old["date"])
    if old["date"] != sorted(old["date"]) or any(len(old[u][f]) != n for u in ("tw50", "twse", "tpex") for f in bw.FIELDS):
        raise SystemExit("tw_breadth_warn: output failed sanity checks; keep existing file")
    old["updated"] = date.today().isoformat()
    OUT.write_text(json.dumps(old, ensure_ascii=False, separators=(",", ":")))
    print(f"tw_breadth_warn: {n} rows ..{old['date'][-1]}; refreshed {days[0].date()}..{days[-1].date()}")


if __name__ == "__main__":
    main()
