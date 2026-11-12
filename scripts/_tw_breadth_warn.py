"""市場廣度與流動性代理指標的共用計算（fetch_tw_breadth_warn.py 每日增量與研究回補共用同一套公式）。

輸入：同一市場範圍的逐檔日線（日期 × 代號）
  adj   還原收盤（均線、新高新低、報酬用）
  close 原始收盤、vol 成交股數（成交值＝close × vol）
  mask  （可省）當天是否屬於這個範圍；省略＝當天有價格就算

輸出欄位（每日一列，比例都是「占當天有效檔數的 %」）：
  a5 a10 a20 a60 a120 a200  收盤高於 N 日均線（分母＝當天有 N 日均線的檔數）
  nh20 nl20 nh60 nl60       收盤等於近 N 日最高／最低收盤
  adv dec                   上漲／下跌
  n                         有效檔數
  ld                        跌停（收盤報酬 ≤ −(跌幅限制 − 0.3 個百分點)；限制 2015-06-01 前 7%、之後 10%，2008-10-13～24 為 3.5%）
  ldq                       跌停且成交量 < 前 20 日均量的一半（「跌停鎖死、量出不來」的代理）
  volr                      個股成交量 ÷ 前 20 日均量的中位數
  ew                        等權平均日報酬 %（每日再平衡；單日報酬以漲跌幅限制截斷，避免資料錯誤）
  dnv                       下跌股票成交值 ÷（上漲＋下跌股票成交值）%
  top10                     成交值前 10 大占全部成交值 %
  ld2                       連續兩天跌停
  ld3u ld5u                 近 3／5 日內曾經跌停（同一檔只算一次）
  ldvr                      當天跌停股票的「成交量 ÷ 前 20 日均量」中位數（沒有跌停股＝缺值）
  ldcont                    昨天跌停的股票裡，今天又跌停的 %（其餘＝打開跌停；昨天跌停不到 5 檔＝缺值）
  tv                        成交值合計（億元）
這些都是價格與成交量算出的代理指標，不是委託簿資料。
"""
from __future__ import annotations

import numpy as np
import pandas as pd

MAS = (5, 10, 20, 60, 120, 200)
FIELDS = ["a5", "a10", "a20", "a60", "a120", "a200", "nh20", "nl20", "nh60", "nl60",
          "adv", "dec", "n", "ld", "ldq", "volr", "ew", "dnv", "top10",
          "ld2", "ld3u", "ld5u", "ldvr", "ldcont", "tv"]
DECIMALS = {"n": 0, "ld": 2, "ldq": 2, "volr": 2, "ew": 3, "ld2": 2, "ld3u": 2, "ld5u": 2, "ldvr": 2}


def limit_series(index: pd.DatetimeIndex) -> pd.Series:
    lim = pd.Series(0.10, index=index)
    lim[index < "2015-06-01"] = 0.07
    lim[(index >= "2008-10-13") & (index <= "2008-10-24")] = 0.035
    return lim


def compute(adj: pd.DataFrame, close: pd.DataFrame, vol: pd.DataFrame, mask: pd.DataFrame | None = None) -> pd.DataFrame:
    adj = adj.sort_index()
    close = close.reindex_like(adj)
    vol = vol.reindex_like(adj)
    # 沒成交的日子（量 0 或缺）不算有效，但均線仍用最後成交價延續
    # Yahoo 偶爾在休市日（颱風假、補假）放一列沿用前收的資料。成交檔數不到近 60 日中位三成的日子整列丟掉
    cnt = (adj.notna() & (vol.fillna(0) > 0)).sum(axis=1)
    live = cnt >= 0.3 * cnt.rolling(60, min_periods=1).median()
    # 另一種：整列照抄前一日（連成交量都一樣）→ 九成以上的股票收盤完全沒變
    same = (close == close.shift(1)).sum(axis=1) / close.notna().sum(axis=1).replace(0, np.nan)
    live &= ~(same >= 0.9)
    adj, close, vol = adj[live], close[live], vol[live]
    if mask is not None:
        mask = mask.reindex(adj.index)
    traded = adj.notna() & (vol.fillna(0) > 0)
    px = adj.ffill(limit=10)
    member = traded if mask is None else (traded & mask.reindex_like(adj).fillna(False).astype(bool))
    n = member.sum(axis=1)
    out = pd.DataFrame(index=adj.index)
    pct = lambda cond, den=None: (cond & member).sum(axis=1) / (n if den is None else den).replace(0, np.nan) * 100
    for m in MAS:
        ma = px.rolling(m, min_periods=m).mean()
        has = member & ma.notna()
        out[f"a{m}"] = ((px > ma) & has).sum(axis=1) / has.sum(axis=1).replace(0, np.nan) * 100
    for w in (20, 60):
        hi, lo = px.rolling(w, min_periods=w).max(), px.rolling(w, min_periods=w).min()
        has = member & hi.notna()
        den = has.sum(axis=1)
        out[f"nh{w}"] = pct((px >= hi) & has, den)
        out[f"nl{w}"] = pct((px <= lo) & has, den)
    ret = px / px.shift(1) - 1
    lim = limit_series(adj.index)
    rc = ret.clip(lower=-(lim + 0.005), upper=lim + 0.005, axis=0)
    out["adv"] = pct(ret > 0)
    out["dec"] = pct(ret < 0)
    out["n"] = n
    is_ld = ret.le(-(lim - 0.003), axis=0) & ret.ge(-(lim + 0.01), axis=0)
    v20 = vol.where(vol > 0).rolling(20, min_periods=10).mean().shift(1)
    vr = vol / v20
    out["ld"] = pct(is_ld)
    out["ldq"] = pct(is_ld & (vr < 0.5))
    out["volr"] = vr.where(member).median(axis=1)
    out["ew"] = rc.where(member).mean(axis=1) * 100
    val = (close * vol).where(member)
    upv, dnv = val.where(ret > 0).sum(axis=1), val.where(ret < 0).sum(axis=1)
    out["dnv"] = dnv / (upv + dnv).replace(0, np.nan) * 100
    tot = val.sum(axis=1).replace(0, np.nan)
    v = np.nan_to_num(val.to_numpy(dtype="float64"), nan=0.0)
    k = min(10, v.shape[1])
    out["top10"] = np.sort(v, axis=1)[:, -k:].sum(axis=1) / tot.to_numpy() * 100
    ldm = (is_ld & member).astype("float32")
    prev = ldm.shift(1).fillna(0) > 0
    out["ld2"] = pct((ldm > 0) & prev)
    for w in (3, 5):
        out[f"ld{w}u"] = (ldm.rolling(w, min_periods=1).max() > 0).sum(axis=1) / n.replace(0, np.nan) * 100
    out["ldvr"] = vr.where(ldm > 0).median(axis=1)
    den = (prev & traded).sum(axis=1)
    out["ldcont"] = ((prev & traded & is_ld).sum(axis=1) / den.where(den >= 5) * 100)
    out["tv"] = val.sum(axis=1) / 1e8
    return out


def to_columns(df: pd.DataFrame) -> dict:
    """DataFrame → {欄位: [值…]}，依 DECIMALS 四捨五入，缺值為 None。"""
    res = {}
    for f in FIELDS:
        nd = DECIMALS.get(f, 1)
        res[f] = [None if pd.isna(x) else (int(x) if nd == 0 else round(float(x), nd)) for x in df[f]]
    return res


# ── 官方每日行情（收盤委買）與信用交易統計：每日增量與研究回補共用 ──
import re as _re

MG_FIELDS = ["bal", "lots", "buy", "sell", "repay", "o_bal", "o_lots", "o_buy", "o_sell", "o_repay"]
_COMMON = _re.compile(r"[1-8]\d{3}|9[02-9]\d{2}")   # 4 碼普通股，排除 91xx 存託憑證


def _num(x) -> float:
    try:
        return float(_re.sub(r"[,\s]", "", str(x)))
    except ValueError:
        return float("nan")


def official_url(kind: str, d: str) -> tuple[str, dict]:
    """kind：twse_px／tpex_px／twse_mg／tpex_mg；d：YYYY-MM-DD。"""
    ymd, sl = d.replace("-", ""), d.replace("-", "/")
    return {
        "twse_px": ("https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX", {"date": ymd, "type": "ALLBUT0999", "response": "json"}),
        "tpex_px": ("https://www.tpex.org.tw/www/zh-tw/afterTrading/otc", {"date": sl, "type": "EW", "response": "json"}),
        "twse_mg": ("https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN", {"date": ymd, "selectType": "MS", "response": "json"}),
        "tpex_mg": ("https://www.tpex.org.tw/www/zh-tw/margin/balance", {"date": sl, "response": "json"}),
    }[kind]


def parse_quotes(kind: str, fields: list, data: list) -> pd.DataFrame:
    """官方行情表 → 每檔一列：id、close、ret（漲跌價差 ÷ 參考價；除權息日＝0）、vol、val、nobid（收盤沒有委買）。只留普通股。"""
    F = [str(f).strip() for f in fields]
    if kind == "twse":
        ic, inm, icl, isg, idf, iv, ia, ib = (F.index(k) for k in ("證券代號", "證券名稱", "收盤價", "漲跌(+/-)", "漲跌價差", "成交股數", "成交金額", "最後揭示買價"))
    else:
        ic, inm, icl, idf, iv, ia, ib = (F.index(k) for k in ("代號", "名稱", "收盤", "漲跌", "成交股數", "成交金額(元)", "最後買價"))
    rec = []
    for r in data:
        c = str(r[ic]).strip()
        if not _COMMON.fullmatch(c) or "DR" in str(r[inm]):
            continue
        cl = _num(r[icl])
        if kind == "twse":
            sg, df = str(r[isg]), _num(r[idf])
            chg = 0.0 if ("X" in sg or df != df) else (-df if ("-" in sg or "green" in sg) else df)
        else:
            t = _re.sub(r"\s", "", str(r[idf]))
            chg = _num(t) if _re.fullmatch(r"[+-]?\d+(\.\d+)?", t) else 0.0
        ret = chg / (cl - chg) if cl == cl and cl - chg > 0 else float("nan")
        rec.append((c, cl, ret, _num(r[iv]), _num(r[ia]), not (_num(r[ib]) > 0)))
    return pd.DataFrame(rec, columns=["id", "close", "ret", "vol", "val", "nobid"])


def lock_pct(q: pd.DataFrame, d: str) -> float | None:
    """鎖死跌停占比 %：跌停（與 ld 同一套報酬門檻）且收盤沒有委買 ÷ 當天有成交的檔數。"""
    tr = q[q.vol > 0]
    if len(tr) < 200:
        return None
    lim = float(limit_series(pd.DatetimeIndex([d])).iloc[0])
    return round(float(((tr.ret <= -(lim - 0.003)) & tr.nobid).sum() / len(tr) * 100), 2)


def parse_margin(kind: str, payload: dict) -> dict | None:
    """信用交易統計 → {bal, buy, sell, repay（億元）, lots（張）}；抓不到回 None。"""
    try:
        if kind == "twse":
            rows = {str(r[0]).strip(): r for r in payload["tables"][0]["data"]}
            m, l = rows["融資金額(仟元)"], rows["融資(交易單位)"]
            buy, sell, rep, bal, lots = _num(m[1]), _num(m[2]), _num(m[3]), _num(m[5]), _num(l[5])
        else:
            rows = {str(r[1]).strip(): r for r in payload["tables"][0]["summary"]}
            m, l = rows["融資金(仟元)"], rows["合計(張)"]
            buy, sell, rep, bal, lots = _num(m[3]), _num(m[4]), _num(m[5]), _num(m[6]), _num(l[6])
        if not bal > 0:
            return None
        return {"bal": round(bal / 1e5, 1), "buy": round(buy / 1e5, 2), "sell": round(sell / 1e5, 2), "repay": round(rep / 1e5, 2), "lots": int(lots)}
    except (KeyError, IndexError, TypeError, ValueError):
        return None
