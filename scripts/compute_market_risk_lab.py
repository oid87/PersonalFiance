"""市場預警與策略回測：每日訊號與頁面資料 → data/market_risk_lab.json。

只讀 repo 內已提交的 data/*.json（由既有 fetch 腳本產生）＋ fetch_market_risk_lab_prices.py 的額外行情，
不連網。任一必要輸入缺失 → 該區塊標示 unavailable，整體仍寫檔；但若連主要美股基準都讀不到，
不寫檔、保留上次成功結果（exit 1）。

規則定義見 docs/research/market_risk_lab_methodology.md。這裡不建立任何綜合風險分數；
「市場狀態」只是使用者既有均線規則的狀態機結果。
"""
from __future__ import annotations

import hashlib
import json
import sys
from bisect import bisect_right
from datetime import date
from pathlib import Path

import _market_risk_lab as M

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = DATA / "market_risk_lab.json"

CASES = [
    {"id": "2018q4", "date": "2018-10-10", "label": "2018 Q4 升息修正（10/10 急跌日）"},
    {"id": "2020covid", "date": "2020-02-24", "label": "2020 疫情崩跌（2/24 首個急跌日）"},
    {"id": "2022bear", "date": "2022-01-05", "label": "2022 升息熊市（1/5 跌破前）"},
    {"id": "2025tariff", "date": "2025-04-03", "label": "2025 關稅崩跌（4/3）"},
    {"id": "2026oct", "date": "2026-10-15", "label": "2026/10/15（Minervini 空 SPY 傳聞日；當日可觀測訊號）"},
]


# ── 載入 ────────────────────────────────────────────────────────────────


def _rows(name):
    p = DATA / name
    if not p.exists():
        return None
    d = json.loads(p.read_text())
    return d["data"] if isinstance(d, dict) and "data" in d else d


def load_ohlcv(name):
    rows = _rows(name)
    if not rows:
        return None
    return {
        "date": [r["date"] for r in rows],
        "open": [r.get("open") for r in rows],
        "high": [r.get("high") for r in rows],
        "low": [r.get("low") for r in rows],
        "close": [r.get("close") for r in rows],
        "volume": [r.get("volume") for r in rows],
    }


def load_extra():
    p = DATA / "market_risk_lab_prices.json"
    if not p.exists():
        return {}, None
    d = json.loads(p.read_text())
    return d.get("tickers", {}), d


def load_00631l():
    p = DATA / "panic_entry.json"
    if not p.exists():
        return None
    d = json.loads(p.read_text())
    out = {"date": [], "open": [], "high": [], "low": [], "close": []}
    for i, dt in enumerate(d["date"]):
        c = d["lev_c"][i]
        if c is None:
            continue
        out["date"].append(dt)
        out["open"].append(d["lev_o"][i])
        out["high"].append(d["lev_h"][i])
        out["low"].append(d["lev_l"][i])
        out["close"].append(c)
    return out if out["date"] else None


def align(dates, src_dates, src_vals):
    """把 src 依日期對齊到 dates；該日沒有資料 → None（不前值填補）。"""
    m = dict(zip(src_dates, src_vals))
    return [m.get(d) for d in dates]


def asof(dates, vals, d):
    k = bisect_right(dates, d) - 1
    return (dates[k], vals[k]) if k >= 0 else (None, None)


def file_hash(names):
    h = hashlib.sha256()
    for n in names:
        p = DATA / n
        h.update(n.encode())
        if p.exists():
            h.update(p.read_bytes())
    return h.hexdigest()[:16]


INPUT_FILES = ["QQQ.json", "SPY.json", "SP500.json", "SOX.json", "SOXX.json", "TWII.json",
               "market_risk_lab_prices.json", "panic_entry.json", "breadth.json", "sp500_ad.json",
               "tw_breadth_warn.json"]


# ── 市場定義 ────────────────────────────────────────────────────────────


def build_markets():
    """回傳各「訊號基準」的序列與交易標的。所有回測與頁面都由這裡出發。"""
    qqq = load_ohlcv("QQQ.json")
    spx = load_ohlcv("SP500.json")
    sox = load_ohlcv("SOX.json")
    twii = load_ohlcv("TWII.json")
    extra, _ = load_extra()
    if not qqq or not spx:
        raise RuntimeError("缺少 QQQ.json 或 SP500.json")
    nq = extra.get("NQ=F")
    nq_low = align(qqq["date"], nq["date"], nq["low"]) if nq else [None] * len(qqq["date"])
    nq_close = align(qqq["date"], nq["date"], nq["close"]) if nq else [None] * len(qqq["date"])

    def etf(sym):
        t = extra.get(sym)
        if not t:
            return None
        ratio = [a / c if a and c else None for a, c in zip(t["adj_close"], t["close"])]
        return {"date": t["date"], "open": t["open"], "close": t["close"], "adj_ratio": ratio,
                "first": t["first"]}

    l631 = load_00631l()
    tw_etf = None
    if l631:
        tw_etf = {"date": l631["date"], "open": l631["open"], "close": l631["close"],
                  "adj_ratio": [1.0] * len(l631["date"]), "first": l631["date"][0]}
    return {
        "US_NDX": {
            "label": "Nasdaq 100（QQQ／NQ 期貨）", "basis": "QQQ", "dates": qqq["date"],
            "close": qqq["close"], "low": qqq["low"], "high": qqq["high"], "volume": qqq["volume"],
            "alt_touch": {"NQ=F": (nq_low, nq_close)},
            "trade": {"QLD": etf("QLD")}, "reset": True,
        },
        "US_SPX": {
            "label": "S&P 500（^GSPC）", "basis": "^GSPC", "dates": spx["date"],
            "close": spx["close"], "low": spx["low"], "high": spx["high"], "volume": spx["volume"],
            "trade": {"SSO": etf("SSO")}, "reset": False,
        },
        "US_SOX": {
            "label": "費城半導體（^SOX）", "basis": "^SOX", "dates": sox["date"] if sox else [],
            "close": sox["close"] if sox else [], "low": sox["low"] if sox else [],
            "high": sox["high"] if sox else [], "volume": sox["volume"] if sox else [],
            "trade": {"USD": etf("USD")}, "reset": True,
        },
        "TW": {
            "label": "台灣加權指數（^TWII）", "basis": "^TWII", "dates": twii["date"] if twii else [],
            "close": twii["close"] if twii else [], "low": twii["low"] if twii else [],
            "high": twii["high"] if twii else [], "volume": [None] * (len(twii["date"]) if twii else 0),
            "trade": {"00631L": tw_etf}, "reset": True,
            "note": "Yahoo ^TWII 日 K 的高低點為現貨盤中；不含台指期夜盤。",
        },
    }


def combined_touch_resets(mk, kind="SMA", rearm_days=60):
    """US_NDX：QQQ 盤中低點或 NQ 期貨（含夜盤）低點觸及各自前一日 300MA 即算觸及。"""
    dates, close, low = mk["dates"], mk["close"], mk["low"]
    ma_q = M.shift1(M.moving_average(close, 300, kind))
    nq_low, nq_close = mk["alt_touch"]["NQ=F"]
    ma_n = M.shift1(M.moving_average(nq_close, 300, kind)) if any(nq_close) else [None] * len(dates)
    ratio, src = [], []
    for i in range(len(dates)):
        cands = []
        if low[i] is not None and ma_q[i]:
            cands.append((low[i] / ma_q[i], "QQQ"))
        if nq_low[i] is not None and ma_n[i]:
            cands.append((nq_low[i] / ma_n[i], "NQ=F"))
        if cands:
            r, s = min(cands)
            ratio.append(r)
            src.append(s)
        else:
            ratio.append(None)
            src.append(None)
    # 以比例序列跑同一套偵測：low' = ratio、MA' 恆為 1、收盤 close/MA_q
    ma_q_today = M.moving_average(close, 300, kind)
    close_ratio = [c / m if c is not None and m else None for c, m in zip(close, ma_q_today)]
    events, armed, above_run, unknown = [], True, rearm_days, 0
    for i in range(len(dates)):
        if ratio[i] is None:
            if ma_q[i] is not None:
                unknown += 1
            continue
        if ratio[i] <= 1.0:
            if armed:
                events.append({"i": i, "date": dates[i], "source": src[i], "touch_ratio": round(ratio[i], 4),
                               "close": close[i], "ma": round(ma_q[i], 4) if ma_q[i] else None,
                               "closed_below": bool(close_ratio[i] is not None and close_ratio[i] < 1)})
            armed, above_run = False, 0
        elif close_ratio[i] is not None and close_ratio[i] > 1:
            above_run += 1
            if above_run >= rearm_days:
                armed = True
        else:
            above_run = 0
    return events, unknown


def market_events(mk, kind="SMA", rearm_days=60):
    dates, close, low = mk["dates"], mk["close"], mk["low"]
    if not dates:
        return {}
    ma = {n: M.moving_average(close, n, kind) for n in (125, 150, 200, 300)}
    out = {}
    if mk.get("reset"):
        if "alt_touch" in mk:
            resets, unknown = combined_touch_resets(mk, kind, rearm_days)
        else:
            resets, _, unknown = M.detect_resets(dates, low, close, 300, kind, rearm_days)
        out["reset300"] = resets
        out["reset_unknown_days"] = unknown
        out["reclaim150_after_reset"] = M.detect_reclaim_after(
            dates, close, ma[150], resets, need_break_ma=ma[150], label="reclaim150")
    out["break200_reclaim125"] = M.detect_break_then_reclaim(dates, close, ma[200], ma[125], "b200r125")
    out["break200_reclaim150"] = M.detect_break_then_reclaim(dates, close, ma[200], ma[150], "b200r150")
    return out


def state_machine(mk, ev, kind="SMA"):
    """依使用者規則描述「現在」所在狀態；不是分數。"""
    dates, close = mk["dates"], mk["close"]
    if not dates or close[-1] is None:
        return {"state": "無法判定", "reason": "缺最新收盤"}
    i = len(dates) - 1
    ma = {n: M.moving_average(close, n, kind)[i] for n in (50, 125, 150, 200, 300)}
    if any(v is None for v in ma.values()):
        return {"state": "無法判定", "reason": "均線樣本不足"}
    last_reset = ev.get("reset300", [])[-1] if ev.get("reset300") else None
    reclaims = ev.get("reclaim150_after_reset", [])
    reclaimed = bool(last_reset and reclaims and reclaims[-1]["from"] == last_reset["date"])
    res = {
        "date": dates[i], "close": close[i], "ma": {str(k): round(v, 2) for k, v in ma.items()},
        "above": {str(k): close[i] > v for k, v in ma.items()},
        "last_reset": last_reset["date"] if last_reset else None,
        "reset_days_ago": (i - last_reset["i"]) if last_reset else None,
        "reclaim150_done": reclaimed if last_reset else None,
        "reclaim150_date": reclaims[-1]["date"] if reclaimed else None,
    }
    in_reset = bool(last_reset and not reclaimed and (i - last_reset["i"]) < 504)
    if in_reset:
        st = "深度修正：300MA Reset 已成立，等待 150MA 站回"
    elif close[i] < ma[200]:
        st = "修正：收盤低於 200MA"
    elif close[i] < ma[50]:
        st = "多頭結構轉弱：低於 50MA、仍高於 200MA"
    else:
        st = "多頭結構：高於 50MA 與 200MA"
    res["state"] = st
    return res


# ── 美股早期預警面板 ──────────────────────────────────────────────────────


def us_panel(markets, kind="SMA"):
    qqq = load_ohlcv("QQQ.json")
    spy = load_ohlcv("SPY.json")
    spx = markets["US_SPX"]
    sox = load_ohlcv("SOX.json")
    soxx = load_ohlcv("SOXX.json")
    extra, _ = load_extra()
    rsp = extra.get("RSP")
    dates = qqq["date"]
    spy_c = align(dates, spy["date"], spy["close"]) if spy else [None] * len(dates)
    spx_c = align(dates, spx["dates"], spx["close"])
    series = {
        "QQQ/SPY": [a / b if a and b else None for a, b in zip(qqq["close"], spy_c)],
        "SOX/SPX": ([a / b if a and b else None for a, b in zip(align(dates, sox["date"], sox["close"]), spx_c)]
                    if sox else None),
        "SOXX/SPY": ([a / b if a and b else None for a, b in zip(align(dates, soxx["date"], soxx["close"]), spy_c)]
                     if soxx else None),
        "RSP/SPY": ([a / b if a and b else None for a, b in zip(align(dates, rsp["date"], rsp["close"]), spy_c)]
                    if rsp else None),
    }
    br = _rows("breadth.json") or []
    ad = _rows("sp500_ad.json") or []
    return dates, series, br, ad, qqq, spy


def indicators_asof(d, markets, panel, kind="SMA"):
    """d 當天（含）以前可得的資訊。用於最新快照與歷史案例。"""
    dates, ratios, br, ad, qqq, spy = panel
    k = bisect_right(dates, d) - 1
    if k < 0:
        return None
    out = {"asof": dates[k]}
    rel = {}
    for name, s in ratios.items():
        if not s or s[k] is None:
            rel[name] = None
            continue
        ma50 = M.sma(s[:k + 1][-50:], 50)[-1] if k >= 49 else None
        rel[name] = {
            "value": round(s[k], 5),
            "chg21": round(s[k] / s[k - 21] - 1, 4) if k >= 21 and s[k - 21] else None,
            "above_ma50": (s[k] > ma50) if ma50 else None,
        }
    out["relative"] = rel
    tech = {}
    for sym, src in (("QQQ", qqq), ("SPY", spy)):
        if not src:
            continue
        j = bisect_right(src["date"], d) - 1
        c = src["close"][:j + 1]
        mas = {n: M.moving_average(c[-(n * 3 + 10):], n, kind)[-1] for n in (50, 150, 200, 300)} \
            if kind == "SMA" else {n: M.moving_average(c, n, kind)[-1] for n in (50, 150, 200, 300)}
        tech[sym] = {
            "close": c[-1],
            "vs_ma": {str(n): (round(c[-1] / v - 1, 4) if v else None) for n, v in mas.items()},
            "mom": {str(n): (round(M.momentum(c, len(c) - 1, n), 4) if M.momentum(c, len(c) - 1, n) is not None else None)
                    for n in (5, 10, 21, 42)},
            "dist_days_25": M.distribution_days(src["close"][:j + 1], src["volume"][:j + 1], j),
            "lower_high": M.lower_high(src["high"][:j + 1], j),
        }
    out["technical"] = tech
    b = [r for r in br if r["date"] <= d]
    if b:
        r = b[-1]
        out["breadth"] = {"date": r["date"], "above20": r.get("above20_pct"), "above50": r.get("above50_pct"),
                          "above200": r.get("above200_pct"), "new_hi": r.get("new_hi_count"),
                          "new_lo": r.get("new_lo_count"),
                          "stale": r["date"] != out["asof"]}
    else:
        out["breadth"] = None
    a = [r for r in ad if r["date"] <= d]
    if a:
        last10 = a[-10:]
        out["adv_dec"] = {"date": a[-1]["date"], "adv": a[-1]["advances"], "dec": a[-1]["declines"],
                          "net10": sum(r["advances"] - r["declines"] for r in last10)}
    else:
        out["adv_dec"] = None
    return out


def forward_path(dates, close, d, n=60):
    k = bisect_right(dates, d) - 1
    if k < 0 or close[k] is None:
        return None
    base = close[k]
    path = [[dates[j], round(close[j] / base - 1, 4)] for j in range(k, min(len(dates), k + n + 1))
            if close[j] is not None]
    return {"anchor": dates[k], "path": path, "complete": k + n < len(dates)}


# ── 台股模組 ────────────────────────────────────────────────────────────


def tw_module(markets):
    tw = markets["TW"]
    out = {"available": bool(tw["dates"])}
    if not tw["dates"]:
        return out
    dates, high, low, close = tw["dates"], tw["high"], tw["low"], tw["close"]
    i = len(dates) - 1
    hi252 = max(h for h in high[max(0, i - 251):i + 1] if h is not None)
    out["drawdown_intraday"] = round(low[i] / hi252 - 1, 4) if low[i] else None
    out["drawdown_close"] = round(close[i] / hi252 - 1, 4)
    out["asof"] = dates[i]
    # 最近一次盤中回撤 ≤ −20% 的日子（每日用自己的 252 日最高價）
    last_dd20 = None
    for j in range(len(dates)):
        hs = [h for h in high[max(0, j - 251):j + 1] if h is not None]
        if hs and low[j] is not None and low[j] / max(hs) - 1 <= -0.20:
            last_dd20 = dates[j]
    out["last_dd20"] = last_dd20
    ev = market_events(tw, "SMA", 60)
    out["last_reset300"] = ev["reset300"][-1]["date"] if ev.get("reset300") else None
    out["last_reclaim150"] = ev["reclaim150_after_reset"][-1]["date"] if ev.get("reclaim150_after_reset") else None
    w = DATA / "tw_breadth_warn.json"
    if w.exists():
        d = json.loads(w.read_text())
        j = len(d["date"]) - 1
        tw50, twse = d.get("tw50", {}), d.get("twse", {})
        out["breadth"] = {
            "date": d["date"][j],
            "tw50_above20": tw50.get("a20", [None])[j], "tw50_above60": tw50.get("a60", [None])[j],
            "twse_above20": twse.get("a20", [None])[j], "twse_above200": twse.get("a200", [None])[j],
            "limit_down_pct": twse.get("ld", [None])[j], "limit_down_locked_pct": twse.get("lock", [None])[j],
            "margin_balance": d.get("mg", {}).get("bal", [None])[j],
        }
        bal = d.get("mg", {}).get("bal", [])
        if len(bal) > 6 and bal[j] and bal[j - 5]:
            out["breadth"]["margin_chg5"] = round(bal[j] / bal[j - 5] - 1, 4)
    out["signals"] = [
        {"id": "dd20", "tier": "core", "name": "加權指數盤中回撤 ≤ −20%（00631L 分批進場）",
         "basis": "^TWII 252 日最高價 → 當日最低價", "value": out["drawdown_intraday"],
         "triggered": out["drawdown_intraday"] is not None and out["drawdown_intraday"] <= -0.20,
         "last": last_dd20,
         "evidence": "恐慌進場回測 V2：回撤 −20% 有支持；V3 結案維持此規則（研究_微觀流動性V3 V3_final_decision.md）。"},
        {"id": "reset300_tw", "tier": "core_user_rule", "name": "加權指數盤中觸及 300MA（00631L Reset）",
         "basis": "^TWII 日 K 最低價 vs 前一日 SMA300", "value": None, "triggered": None,
         "last": out["last_reset300"], "last_note": f"之後站回 150MA：{out['last_reclaim150'] or '—'}",
         "evidence": "使用者既定規則；本頁回測見『策略回測』。未經本專案研究驗證為有增量價值。"},
        {"id": "twvix40", "tier": "aux", "name": "TWVIX ≥ 40",
         "basis": "期交所臺指選擇權波動率指數", "value": None, "triggered": None,
         "evidence": "小樣本（2016-11 起）有用，能分辨 2022 慢熊；與回撤合併後長期樣本無改善。僅供觀察。"},
        {"id": "breadth_ld_margin", "tier": "aux", "name": "市場廣度／跌停潮／融資減幅",
         "basis": "tw_breadth_warn（臺灣50／上市／上櫃）", "value": None, "triggered": None,
         "evidence": "廣度預警 V1/V2：都沒勝過只看回撤（M1–M4 ΔAUC 區間含 0）。未證實增量價值。"},
        {"id": "nsf", "tier": "aux", "name": "國安基金進場", "basis": "官方公告（手動維護）",
         "value": None, "triggered": None, "evidence": "恐慌進場回測：無額外價值。僅供觀察。"},
        {"id": "v3micro", "tier": "research", "name": "V3 微觀流動性（價差修復／可轉債／當沖）",
         "basis": "研究資料夾，未進正式資料管線", "value": None, "triggered": None,
         "evidence": "V3.0.2 結案：L1–L4 樣本外未穩定勝過 M0；−20%／−25% 門檻結論方向相反。"
                     "V3.0.1 列管項（分批 NAV 最大回撤、價差修復定義、可轉債零成交完整性）已於 V3.0.2/勘誤處理，"
                     "但結論為未證實增量價值 → 不納入交易觸發。"},
    ]
    return out


# ── 主程式 ─────────────────────────────────────────────────────────────


def compact(vals, nd=2):
    return [None if v is None else round(v, nd) for v in vals]


def build(today=None):
    today = today or date.today().isoformat()
    markets = build_markets()
    extra, extra_meta = load_extra()
    ev_by_kind, states = {}, {}
    for kind in ("SMA", "EMA"):
        ev_by_kind[kind] = {}
        for key, mk in markets.items():
            ev = market_events(mk, kind)
            ev_by_kind[kind][key] = {k: ([{kk: vv for kk, vv in e.items() if kk != "i"} for e in v]
                                         if isinstance(v, list) else v) for k, v in ev.items()}
            if kind == "SMA":
                states[key] = state_machine(mk, ev, kind)
    panel = us_panel(markets)
    latest = indicators_asof(panel[0][-1], markets, panel)
    cases = []
    for c in CASES:
        snap = indicators_asof(c["date"], markets, panel)
        fwd = {
            "SPY": forward_path(markets["US_SPX"]["dates"], markets["US_SPX"]["close"], c["date"], 60),
            "QQQ": forward_path(markets["US_NDX"]["dates"], markets["US_NDX"]["close"], c["date"], 60),
        }
        cases.append({**c, "snapshot": snap, "forward": fwd,
                      "status": "complete" if all(f and f["complete"] for f in fwd.values()) else "pending"})
    dates, ratios, br, ad, qqq, spy = panel
    chart = {
        "us": {
            "dates": dates, "qqq_c": compact(qqq["close"]), "qqq_l": compact(qqq["low"]),
            "spx_c": compact(align(dates, markets["US_SPX"]["dates"], markets["US_SPX"]["close"])),
            "sox_c": compact(align(dates, markets["US_SOX"]["dates"], markets["US_SOX"]["close"])),
            "ratios": {k: (compact(v, 5) if v else None) for k, v in ratios.items()},
            "breadth": {"dates": [r["date"] for r in br],
                        "above50": [r.get("above50_pct") for r in br],
                        "above200": [r.get("above200_pct") for r in br]},
        },
        "tw": {"dates": markets["TW"]["dates"], "c": compact(markets["TW"]["close"]),
               "l": compact(markets["TW"]["low"])},
    }
    w = DATA / "tw_breadth_warn.json"
    if w.exists():
        d = json.loads(w.read_text())
        chart["tw"]["margin"] = {"dates": d["date"], "bal": d.get("mg", {}).get("bal")}
        chart["tw"]["breadth"] = {"dates": d["date"], "tw50_a60": d.get("tw50", {}).get("a60")}
    # 資料完整率：最新快照應有欄位中有值的比例
    expect = [latest["relative"].get(k) for k in ("QQQ/SPY", "SOX/SPX", "SOXX/SPY", "RSP/SPY")]
    expect += [latest.get("breadth"), latest.get("adv_dec"), latest["technical"].get("QQQ"),
               latest["technical"].get("SPY")]
    completeness = round(sum(1 for x in expect if x) / len(expect), 3)
    inputs = {}
    for n in INPUT_FILES:
        p = DATA / n
        if p.exists():
            try:
                dd = json.loads(p.read_text())
                inputs[n] = dd.get("updated") if isinstance(dd, dict) else None
            except Exception:  # noqa: BLE001
                inputs[n] = "壞檔"
        else:
            inputs[n] = None
    return {
        "updated": today,
        "model_version": M.MODEL_VERSION,
        "input_hash": file_hash(INPUT_FILES),
        "inputs_updated": inputs,
        "extra_prices_failed": (extra_meta or {}).get("failed", []),
        "completeness": completeness,
        "states": states,
        "events": ev_by_kind,
        "us_latest": latest,
        "cases": cases,
        "tw": tw_module(markets),
        "chart": chart,
        "proxies": {
            "breadth": "breadth.json：S&P 500 現任成分股回填（非 point-in-time，含倖存者偏誤），2019-11 起；"
                       "200MA／新高新低只有部分期間。不是完整歷史成分股廣度。",
            "adv_dec": "sp500_ad.json：現任成分股自算漲跌家數，2015-12 起，含倖存者偏誤。",
            "rsp": "RSP/SPY 是等權 vs 市值加權 ETF 的代理，不是廣度本身。",
            "leaders": "領漲股破線／突破失敗：尚未自動化（需要可追溯的領漲股清單）。",
        },
    }


def main():
    try:
        payload = build()
    except Exception as e:  # noqa: BLE001
        print(f"compute_market_risk_lab 失敗，保留舊檔：{type(e).__name__}: {e}")
        return 1
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False))
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB) states:",
          {k: v.get("state") for k, v in payload["states"].items()})
    return 0


if __name__ == "__main__":
    sys.exit(main())
