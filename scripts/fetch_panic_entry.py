"""恐慌進場回測（#tab=panicentry）的日線資料：把台股價格、還原後的 0050／00631L／台積電、美國波動率指數對齊到台股交易日。
輸出 data/panic_entry.json（欄位式）：
  date[]、tw_o/h/l/c（加權，data/TWII.json）、e50_*（0050 還原息與分割）、lev_*（00631L 還原分割）、
  tsm_ret／tsm_low_ret（台積電收盤／盤中最低相對參考價，除權息日不產生假跌幅）、
  us_vix／us_vxn／us_vxsmh（台股 t 日開盤前已知的最近一個美股收盤；美股日期嚴格早於 t）、
  us_smhrv（SMH 21 日實現波動率，年化 %；VXSMH 2025-09 才有，這是長期代理）、
  vix_c（期交所 TWVIX 收盤，data/twvix.json，2026-08 起）、meta.sim_cost_annual（模擬正二的年化成本，以 00631L 實績校準）。
來源：FinMind TaiwanStockPrice／TaiwanStockDividendResult／TaiwanStockSplitPrice、Yahoo（^VIX、^VXN、SMH）、Cboe（VXSMH、VXN 官方檔）。
還原方式：事件日之前的價格 ×（after_price ÷ before_price）。任何一個必要來源失敗就中止並保留舊檔。
"""
from __future__ import annotations
import io
import json
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
import requests

import _common

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "panic_entry.json"
START = "2003-07-01"
FM = "https://api.finmindtrade.com/api/v4/data"
HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"}
CBOE = "https://cdn.cboe.com/api/global/us_indices/daily_prices/{}_History.csv"


def finmind(dataset: str, sid: str) -> pd.DataFrame:
    params = {"dataset": dataset, "data_id": sid, "start_date": "2003-01-01"}
    tok = _common.get_finmind_token()
    hdr = {"Authorization": f"Bearer {tok}"} if tok else {}
    j = requests.get(FM, params=params, headers=hdr, timeout=60).json()
    if j.get("msg") != "success":
        raise SystemExit(f"panic_entry: FinMind {dataset} {sid}: {j.get('msg')}")
    return pd.DataFrame(j.get("data", []))


def adjusted(sid: str) -> pd.DataFrame:
    d = finmind("TaiwanStockPrice", sid)
    if d.empty:
        raise SystemExit(f"panic_entry: no price rows for {sid}")
    d["date"] = pd.to_datetime(d["date"])
    d = d.set_index("date").rename(columns={"max": "high", "min": "low"})[["open", "high", "low", "close"]]
    d = d[d.close > 0]
    f = pd.Series(1.0, index=d.index)
    for ds in ("TaiwanStockDividendResult", "TaiwanStockSplitPrice"):
        e = finmind(ds, sid)
        for dt, a, b in zip(pd.to_datetime(e.get("date", [])), e.get("after_price", []), e.get("before_price", [])):
            if b and a and b > 0:
                f[f.index < dt] *= a / b
    return d.mul(f, axis=0)


def yahoo_close(ticker: str) -> pd.Series:
    import yfinance as yf
    d = yf.download(ticker, start="2000-01-01", progress=False, auto_adjust=False)
    if isinstance(d.columns, pd.MultiIndex):
        d.columns = d.columns.get_level_values(0)
    s = d["Close"].dropna()
    if len(s) < 1000:
        raise SystemExit(f"panic_entry: Yahoo {ticker} returned {len(s)} rows")
    return s


def cboe_close(name: str) -> pd.Series:
    r = requests.get(CBOE.format(name), headers=HEADERS, timeout=30)
    r.raise_for_status()
    d = pd.read_csv(io.StringIO(r.text))
    d["DATE"] = pd.to_datetime(d["DATE"])
    return d.set_index("DATE")["CLOSE"].dropna()


def align_prior_us_close(tw_index: pd.DatetimeIndex, s: pd.Series, max_stale_days: int = 12) -> pd.Series:
    """台股 t 日 → 日期嚴格早於 t 的最近一筆美股收盤（美股收盤＝台北隔天清晨，所以 t 日開盤前已知）。"""
    ns = "datetime64[ns]"
    a = pd.merge_asof(pd.DataFrame({"d": pd.DatetimeIndex(tw_index).astype(ns)}),
                      pd.DataFrame({"u": pd.DatetimeIndex(s.index).tz_localize(None).astype(ns), "v": s.values}).sort_values("u"),
                      left_on="d", right_on="u", allow_exact_matches=False)
    v = a.v.values.astype(float)
    v[(a.d - a.u).dt.days.values > max_stale_days] = np.nan
    return pd.Series(v, index=tw_index)


def build(tw: pd.DataFrame, e50: pd.DataFrame, lev: pd.DataFrame, tsm: pd.DataFrame, usv: dict[str, pd.Series], twvix: pd.Series) -> dict:
    idx = tw.index[tw.index >= START]
    df = pd.DataFrame(index=idx)
    for n, d in (("tw", tw), ("e50", e50), ("lev", lev), ("tsm", tsm)):
        for c in ("open", "high", "low", "close"):
            df[f"{n}_{c[0]}"] = d[c].reindex(idx)
    # 停牌日（例：0050 2025-06-11～17 分割）沿用前收，漲跌在復牌日一次反映
    for n in ("e50", "lev", "tsm"):
        first = df[f"{n}_c"].first_valid_index()
        gap = df[f"{n}_c"].isna() & (df.index > first)
        df.loc[df.index >= first, f"{n}_c"] = df.loc[df.index >= first, f"{n}_c"].ffill()
        for c in "ohl":
            df.loc[gap, f"{n}_{c}"] = df.loc[gap, f"{n}_c"]
    pc = df.tsm_c.shift(1)
    df["tsm_ret"] = df.tsm_c / pc - 1
    df["tsm_low_ret"] = df.tsm_l / pc - 1
    # 模擬正二成本：2015 起讓「每日 2×0050 報酬 − c/252」的累積報酬等於 00631L 實績
    r50 = df.e50_c.pct_change()
    both = df.lev_c.notna() & (df.index >= "2015-01-01")
    tgt = np.log(df.lev_c[both].iloc[-1] / df.lev_c[both].iloc[0])
    lo, hi = -0.10, 0.20
    for _ in range(60):
        c = (lo + hi) / 2
        g = np.log1p((2 * r50 - c / 252)[both].iloc[1:]).sum()
        lo, hi = (c, hi) if g > tgt else (lo, c)
    for k, s in usv.items():
        df[k] = align_prior_us_close(idx, s)
    df["vix_c"] = twvix.reindex(idx)
    out: dict = {"date": [d.strftime("%Y-%m-%d") for d in df.index]}
    for k in ["tw_o", "tw_h", "tw_l", "tw_c", "e50_o", "e50_h", "e50_l", "e50_c", "lev_o", "lev_h", "lev_l", "lev_c",
              "tsm_ret", "tsm_low_ret", "us_vix", "us_vxn", "us_vxsmh", "us_smhrv", "vix_c"]:
        nd = 5 if "ret" in k else 3 if k.startswith(("e50", "lev")) else 2
        out[k] = [None if pd.isna(x) else round(float(x), nd) for x in df[k]]
    out["meta"] = {"sim_cost_annual": round(float(c), 4)}
    return out


def main() -> None:
    tw = pd.DataFrame(json.loads((ROOT / "data" / "TWII.json").read_text())["data"])
    tw["date"] = pd.to_datetime(tw["date"])
    tw = tw.set_index("date")[["open", "high", "low", "close"]].dropna()
    e50, lev, tsm = adjusted("0050"), adjusted("00631L"), adjusted("2330")
    smh = yahoo_close("SMH")
    yvxn = yahoo_close("^VXN")
    try:
        cvxn = cboe_close("VXN")
        vxn = pd.concat([yvxn[yvxn.index < cvxn.index[0]], cvxn])
    except Exception as e:  # Cboe 擋 IP 時退回 Yahoo
        print(f"panic_entry: Cboe VXN failed ({type(e).__name__}); using Yahoo")
        vxn = yvxn
    try:
        vxsmh = cboe_close("VXSMH")
    except Exception as e:
        print(f"panic_entry: Cboe VXSMH failed ({type(e).__name__}); reusing existing column")
        vxsmh = None
    usv = {"us_vix": yahoo_close("^VIX"), "us_vxn": vxn,
           "us_smhrv": (np.log(smh).diff().rolling(21).std() * np.sqrt(252) * 100).dropna()}
    usv["us_vxsmh"] = vxsmh if vxsmh is not None else pd.Series(dtype=float)
    tv = pd.DataFrame(json.loads((ROOT / "data" / "twvix.json").read_text())["data"])
    twvix = pd.Series(tv["close"].values, index=pd.to_datetime(tv["date"]))
    out = build(tw, e50, lev, tsm, usv, twvix)
    if vxsmh is None and OUT.exists():  # 保留舊的 VXSMH 欄
        old = json.loads(OUT.read_text())
        prev = dict(zip(old.get("date", []), old.get("us_vxsmh", [])))
        out["us_vxsmh"] = [prev.get(d) for d in out["date"]]
    n = len(out["date"])
    if n < 5000 or sum(v is not None for v in out["lev_c"]) < 2500 or out["us_vix"][-1] is None:
        raise SystemExit("panic_entry: output failed sanity checks; keep existing file")
    out["source"] = "TWSE/Yahoo ^TWII、FinMind（0050、00631L、2330 還原價）、Yahoo ^VIX ^VXN SMH、Cboe VXSMH／VXN、TAIFEX TWVIX"
    out["note"] = "美國指數為台股當日開盤前已知的最近一個美股收盤；TWVIX 只有期交所 2026-08 起的官方收盤"
    out["updated"] = date.today().isoformat()
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"panic_entry: {n} rows {out['date'][0]}..{out['date'][-1]} cost={out['meta']['sim_cost_annual']}")


if __name__ == "__main__":
    main()
