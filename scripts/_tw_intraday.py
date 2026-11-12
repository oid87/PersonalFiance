"""台股盤中去槓桿壓力監測的純計算（不連網）。兩部分：

一、盤後回放：證交所收盤後公布的「每 5 秒委託成交統計」(MI_5MINS) 與「每 5 秒指數」(MI_5MINS_INDEX)
    → 每分鐘序列（09:00=第 0 分，13:30=第 270 分；只取該分鐘之前最後一筆已公布的值，不內插）。
    r   指數對前一日收盤的漲跌（%）
    bq／sq  累積委託買進／賣出張數（千張）   tq 累積成交張數（千張）   tv 累積成交金額（億元）
    vb／bb／cb  前 5–20 個交易日同一分鐘的 tv／bq／委託失衡 中位數（基準；不足 5 天則沒有）
二、盤中快照彙總：把一批個股即時報價（已正規化的 dict）彙總成家數與占比。來源無關，
    公開 repo 不含任何抓即時報價的程式；見研究資料夾的本機收集器。

所有門檻都寫在 LIVE_RULES，版本號 VERSION；改門檻必須換版本號，舊紀錄不重算。
"""
from __future__ import annotations

import math

VERSION = "live-v1"          # 2026-11-12 固定；之後任何定義或門檻變動都要換號
MINUTES = 271
WIN = 15                      # 「15 分鐘最大跌幅」的視窗

# 事前固定的觀察門檻（不是驗證過的預警條件）。key → (說明, 欄位, 比較, 門檻)
LIVE_RULES = {
    "ld3": ("跌停家數占比 ≥ 3%", "ld_pct", ">=", 3.0),
    "lock2": ("跌停且沒有買單的占比 ≥ 2%", "lock_pct", ">=", 2.0),
    "mw5": ("融資餘額加權跌幅 ≤ −5%", "mw_ret", "<=", -5.0),
    "bp70": ("買單只有平常同時段的七成以下", "bp", "<=", 0.7),
}


def num(x):
    try:
        v = float(str(x).replace(",", ""))
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def minute_of(t: str):
    """'09:00:05'、'09:00'、'090005' → 距 09:00 的分鐘數；解析不了回 None。"""
    s = str(t).strip()
    if ":" not in s and len(s) >= 4:
        s = f"{s[:2]}:{s[2:4]}"
    p = s.split(":")
    try:
        return (int(p[0]) - 9) * 60 + int(p[1])
    except (ValueError, IndexError):
        return None


def to_minutes(rows, ncol):
    """[[時間, v1, v2…]…] → ncol 條長度 271 的序列；該分鐘沒有任何一筆就是 None（不補值）。"""
    out = [[None] * MINUTES for _ in range(ncol)]
    for r in rows or []:
        m = minute_of(r[0])
        if m is None or not 0 <= m < MINUTES:
            continue
        for k in range(ncol):
            v = num(r[1 + k]) if len(r) > 1 + k else None
            if v is not None:
                out[k][m] = v
    return out


def build_day(order_rows, index_rows, prev_close):
    """單日每分鐘序列。資料不足（有效分鐘 < 200 或沒有前收）回 None。"""
    bn, bq, sn, sq, tn, tq, tv = to_minutes(order_rows, 7)
    (idx,) = to_minutes(index_rows, 1)
    if not prev_close or sum(v is not None for v in idx) < 200 or sum(v is not None for v in sq) < 200:
        return None
    rd = lambda a, k: [None if v is None else int(round(v / k)) for v in a]
    return {
        "r": [None if v is None else round((v / prev_close - 1) * 100, 2) for v in idx],
        "bq": rd(bq, 1000), "sq": rd(sq, 1000), "tq": rd(tq, 1000), "tv": rd(tv, 100),
    }


def indicators(day):
    """cimb：開盤至今（累積委賣 − 累積委買）÷ 兩者合計（%）；平常是負的（掛買比掛賣多），越往正的方向＝賣單相對變多。
    fill：累積成交張數 ÷ 累積委賣張數（%）。
    bp：累積委買張數 ÷ 前幾日同一分鐘的中位數；小於 1＝買單比平常少。 vp：累積成交金額的同樣比值。
    cdev：cimb 減去前幾日同一分鐘 cimb 的中位數（百分點）。沒有基準的日子 bp／vp／cdev 是 None。"""
    n = len(day["r"])
    cimb, fill, bp, vp, cdev = ([None] * n for _ in range(5))
    for i in range(n):
        b, s, t = day["bq"][i], day["sq"][i], day["tq"][i]
        if b is not None and s is not None and b + s > 0:
            cimb[i] = round((s - b) / (s + b) * 100, 1)
            if day.get("cb") and day["cb"][i] is not None:
                cdev[i] = round(cimb[i] - day["cb"][i], 1)
        if t is not None and s:
            fill[i] = round(t / s * 100, 1)
        if day.get("bb") and b is not None and day["bb"][i]:
            bp[i] = round(b / day["bb"][i], 2)
        if day.get("vb") and day["tv"][i] is not None and day["vb"][i]:
            vp[i] = round(day["tv"][i] / day["vb"][i], 2)
    return {"cimb": cimb, "fill": fill, "bp": bp, "vp": vp, "cdev": cdev}


def with_cimb(day):
    """補上 cimb 欄（算基準用）。"""
    return {**day, "cimb": indicators(day)["cimb"]}


def baseline(prior_days, key, min_days=5, max_days=20):
    """前幾個交易日同一分鐘的中位數；prior_days 由舊到新。不足 min_days 回 None。"""
    use = [d[key] for d in prior_days[-max_days:] if d and d.get(key)]
    if len(use) < min_days:
        return None
    out = []
    for m in range(MINUTES):
        v = sorted(x[m] for x in use if x[m] is not None)
        md = None if len(v) < min_days else v[len(v) // 2] if len(v) % 2 else (v[len(v) // 2 - 1] + v[len(v) // 2]) / 2
        out.append(md if md is None else round(md, 1) if key == "cimb" else int(round(md)))
    return out


def hhmm(m):
    return None if m is None else f"{9 + m // 60:02d}:{m % 60:02d}"


def summary(day):
    """單日摘要：最低點、各跌幅第一次出現的時間、買單最少與委託失衡偏離最大的時間、低點後收回多少。
    09:05 以前與 13:25 以後（集合競價）不列入極值。"""
    r, ind = day["r"], indicators(day)
    ok = [i for i, v in enumerate(r) if v is not None]
    if not ok:
        return {}
    lo = min(ok, key=lambda i: r[i])
    first = lambda thr: next((i for i in ok if r[i] <= thr), None)
    best = lambda a, f: (lambda c: f(c, key=lambda i: a[i]) if c else None)([i for i in range(5, 265) if a[i] is not None])
    bm, cm = best(ind["bp"], min), best(ind["cdev"], max)
    d15 = [None if i < WIN or r[i] is None or r[i - WIN] is None else round(r[i] - r[i - WIN], 2) for i in range(len(r))]
    dm = best(d15, min)
    last = lambda a: next((a[i] for i in range(len(a) - 1, -1, -1) if a[i] is not None), None)
    return {
        "open": r[1] if len(r) > 1 else None, "low": r[lo], "low_t": hhmm(lo), "close": r[ok[-1]],
        "rebound": round(r[ok[-1]] - r[lo], 2),
        "t1": hhmm(first(-1)), "t2": hhmm(first(-2)), "t3": hhmm(first(-3)), "t5": hhmm(first(-5)),
        "bp_min": None if bm is None else ind["bp"][bm], "bp_t": hhmm(bm),
        "cdev_max": None if cm is None else ind["cdev"][cm], "cdev_t": hhmm(cm),
        "vp": last(ind["vp"]), "drop15": None if dm is None else d15[dm], "drop15_t": hhmm(dm),
        "missing": MINUTES - len(ok),
    }


# ───────────────────────── 盤中快照彙總（來源無關） ─────────────────────────

def classify(q):
    """q：{y 參考價, w 跌停價, u 漲停價, px 最近成交價或 None, bid 最佳買價或 None, ask 最佳賣價或 None,
           askv 最佳賣量, low 當日最低或 None}
    回傳 dict：ret（%，沒有成交價是 None）、ld 現在成交在跌停價、lock 賣單掛在跌停價而且沒有買單、
    near 離跌停不到 2 個百分點、touched 今天碰過跌停、reopen 碰過跌停但現在已離開。"""
    y, w, px, bid, ask = q.get("y"), q.get("w"), q.get("px"), q.get("bid"), q.get("ask")
    if not y or not w:
        return None
    eps = 1e-9
    ld = px is not None and px <= w + eps
    lock = ask is not None and ask <= w + eps and bid is None
    touched = ld or lock or (q.get("low") is not None and q["low"] <= w + eps)
    ret = None if px is None else (px / y - 1) * 100
    near = (not ld and not lock) and px is not None and (px - w) / y <= 0.02
    return {"ret": ret, "ld": ld, "lock": lock, "near": near, "touched": touched,
            "reopen": touched and not ld and not lock, "queue": (q.get("askv") or 0) if lock else 0}


def aggregate(quotes, margin=None, tw50=None):
    """quotes：{代號: q}；margin：{代號: 前一日融資餘額（張）}；tw50：成分股代號集合。
    回傳各種家數與占比（%）。分母是有參考價的股票數；沒有成交價的股票不算漲也不算跌，另外列 no_px。"""
    c = {k: v for k, v in ((k, classify(q)) for k, q in quotes.items()) if v}
    n = len(c)
    if not n:
        return {"n": 0}
    pct = lambda x, d=n: round(x / d * 100, 2) if d else None
    cnt = lambda f, ks=None: sum(1 for k, v in c.items() if (ks is None or k in ks) and f(v))
    out = {
        "n": n, "no_px": cnt(lambda v: v["ret"] is None),
        "adv_pct": pct(cnt(lambda v: v["ret"] is not None and v["ret"] > 0)),
        "dec_pct": pct(cnt(lambda v: v["ret"] is not None and v["ret"] < 0)),
        "ld": cnt(lambda v: v["ld"] or v["lock"]), "lock": cnt(lambda v: v["lock"]), "near": cnt(lambda v: v["near"]),
        "touched": cnt(lambda v: v["touched"]), "reopen": cnt(lambda v: v["reopen"]),
        "queue": sum(v["queue"] for v in c.values()),
    }
    out.update(ld_pct=pct(out["ld"]), lock_pct=pct(out["lock"]), near_pct=pct(out["near"]))
    rs = [v["ret"] for v in c.values() if v["ret"] is not None]
    out["ew_ret"] = round(sum(rs) / len(rs), 2) if rs else None
    if tw50:
        m = [k for k in c if k in tw50]
        out["tw50_n"] = len(m)
        out["tw50_adv_pct"] = pct(cnt(lambda v: v["ret"] is not None and v["ret"] > 0, set(m)), len(m))
        out["tw50_dec_pct"] = pct(cnt(lambda v: v["ret"] is not None and v["ret"] < 0, set(m)), len(m))
    if margin:
        # 權重＝前一日融資餘額張數 × 參考價（融資買進的股票市值近似；不是融資金額，更不是維持率）
        wt = {k: margin[k] * quotes[k]["y"] for k in c if margin.get(k) and c[k]["ret"] is not None}
        tot = sum(wt.values())
        if tot > 0:
            out["mw_ret"] = round(sum(wt[k] * c[k]["ret"] for k in wt) / tot, 2)
            out["mw_ld_pct"] = round(sum(wt[k] for k in wt if c[k]["ld"] or c[k]["lock"]) / tot * 100, 2)
            out["mw_lock_pct"] = round(sum(wt[k] for k in wt if c[k]["lock"]) / tot * 100, 2)
            out["mw_dn7_pct"] = round(sum(wt[k] for k in wt if c[k]["ret"] <= -7) / tot * 100, 2)
            out["mw_cover"] = round(len(wt) / n * 100, 1)
    return out


def flags(rec):
    """依 LIVE_RULES 回傳目前成立的規則 key（值缺就不成立）。"""
    out = []
    for k, (_, field, op, thr) in LIVE_RULES.items():
        v = rec.get(field)
        if v is not None and ((op == ">=" and v >= thr) or (op == "<=" and v <= thr)):
            out.append(k)
    return out
