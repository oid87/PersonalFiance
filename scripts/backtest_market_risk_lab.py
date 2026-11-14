"""市場預警與策略回測：歷史回測 → data/market_risk_lab_backtest.json。

模式：
  --mode daily  只更新「訊號回測」（事件研究；新完成的前瞻視窗會自動從 pending 變 complete）。
                保留上次 full 的策略 NAV 與 walk-forward 區塊。
  --mode full   訊號回測＋策略 NAV 回測＋walk-forward＋模型版本比對（每週排程）。
  --force       即使輸入資料與模型版本都沒變也重跑。

輸入雜湊與模型版本都相同 → 直接跳過（不寫檔），避免重跑昂貴研究。
任何例外 → 不寫檔、保留上次成功結果。
"""
from __future__ import annotations

import argparse
import json
import sys
from bisect import bisect_left
from datetime import date
from pathlib import Path
from statistics import median

import _market_risk_lab as M
import compute_market_risk_lab as C

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "market_risk_lab_backtest.json"

HORIZONS = (20, 60, 120, 252)

# 策略：交易標的 ≠ 訊號基準
STRATEGIES = [
    {"id": "QLD_reset_r150", "market": "US_NDX", "trade": "QLD", "signal": "reclaim150_after_reset",
     "label": "QLD：Nasdaq 300MA Reset 後收盤站回 150MA", "costs": "us"},
    {"id": "SSO_b200_r125", "market": "US_SPX", "trade": "SSO", "signal": "break200_reclaim125",
     "label": "SSO：S&P 500 跌破 200MA 後站回 125MA", "costs": "us"},
    {"id": "SSO_b200_r150", "market": "US_SPX", "trade": "SSO", "signal": "break200_reclaim150",
     "label": "SSO：S&P 500 跌破 200MA 後站回 150MA", "costs": "us"},
    {"id": "USD_reset_r150", "market": "US_SOX", "trade": "USD", "signal": "reclaim150_after_reset",
     "label": "USD：費半 300MA Reset 後收盤站回 150MA", "costs": "us"},
    {"id": "631L_reset_r150", "market": "TW", "trade": "00631L", "signal": "reclaim150_after_reset",
     "label": "00631L：加權指數 300MA Reset 後收盤站回 150MA", "costs": "tw"},
]

SIGNAL_FAMILIES = [
    ("US_NDX", "reset300", "Nasdaq 100 盤中觸及 300MA（Reset）"),
    ("US_NDX", "reclaim150_after_reset", "Reset 後站回 150MA（QLD 訊號）"),
    ("US_SPX", "break200_reclaim125", "S&P 跌破 200MA 後站回 125MA（SSO）"),
    ("US_SPX", "break200_reclaim150", "S&P 跌破 200MA 後站回 150MA（SSO）"),
    ("US_SOX", "reset300", "費半盤中觸及 300MA（Reset）"),
    ("US_SOX", "reclaim150_after_reset", "費半 Reset 後站回 150MA（USD 訊號）"),
    ("TW", "reset300", "加權盤中觸及 300MA（Reset）"),
    ("TW", "reclaim150_after_reset", "加權 Reset 後站回 150MA（00631L 訊號）"),
]

COSTS = {
    # 單邊：手續費、滑價。美股零佣金券商以 0.05% 估算規費＋價差；台股 0.1425% 手續費（未折讓）、ETF 證交稅 0.1%。
    "us": {"fee_buy": 0.0005, "fee_sell": 0.0005, "slippage": 0.0005},
    "tw": {"fee_buy": 0.001425, "fee_sell": 0.001425 + 0.001, "slippage": 0.001},
}

STRATEGY_VARIANTS = [
    {"id": "hold252_1", "exit_rule": "hold", "hold_days": 252, "tranches": (1.0,),
     "label": "一次投入，持有 252 日"},
    {"id": "hold252_3", "exit_rule": "hold", "hold_days": 252, "tranches": (1 / 3, 1 / 3, 1 / 3),
     "label": "三批（間隔 21 日）各 1/3，持有 252 日"},
    {"id": "ma200exit_1", "exit_rule": "basis_below_ma", "hold_days": 756, "tranches": (1.0,),
     "label": "一次投入，基準收盤跌破 200MA 出場（最長 756 日）"},
]


def events_with_index(mk, kind, rearm):
    ev = C.market_events(mk, kind, rearm)
    return ev


def signal_backtests(markets, kind, rearm):
    out = {}
    for mkey, fam, label in SIGNAL_FAMILIES:
        mk = markets[mkey]
        ev = events_with_index(mk, kind, rearm).get(fam, [])
        study = M.event_study(mk["dates"], mk["close"], mk["low"], mk["high"], ev, HORIZONS)
        out[f"{mkey}:{fam}"] = {"label": label, "market": mkey, "family": fam, "basis": mk["basis"], **study}
    return out


def strategy_backtests(markets, kind, rearm):
    out = {}
    for st in STRATEGIES:
        mk = markets[st["market"]]
        tr = mk["trade"].get(st["trade"])
        if not tr:
            out[st["id"]] = {"label": st["label"], "available": False, "reason": f"{st['trade']} 價格不可得"}
            continue
        ev = events_with_index(mk, kind, rearm).get(st["signal"], [])
        ma200 = M.moving_average(mk["close"], 200, kind)
        start = tr["first"]
        sigs = [e for e in ev if e["date"] >= start]
        excluded = [e["date"] for e in ev if e["date"] < start]
        res = {"label": st["label"], "available": True, "trade": st["trade"], "basis": mk["basis"],
               "start": start, "signals_used": [e["date"] for e in sigs],
               "signals_before_inception": excluded, "costs": COSTS[st["costs"]], "variants": {}}
        bh = M.buy_hold_nav(tr["date"], tr["close"], tr["adj_ratio"], start)
        res["buy_hold"] = {"stats": M.perf_stats(bh), "nav": thin(bh)}
        for v in STRATEGY_VARIANTS:
            r = M.nav_backtest(tr["date"], tr["open"], tr["close"], tr["adj_ratio"], sigs,
                               basis_close=mk["close"], basis_exit_ma=ma200, basis_dates=mk["dates"],
                               tranches=v["tranches"], hold_days=v["hold_days"], exit_rule=v["exit_rule"],
                               start=start, **COSTS[st["costs"]])
            res["variants"][v["id"]] = {"label": v["label"], "stats": M.perf_stats(r["nav"]),
                                        "trades": r["trades"], "open_position": r["open_position"],
                                        "nav": thin(r["nav"])}
        out[st["id"]] = res
    return out


def thin(nav, step=5):
    """NAV 每 5 個交易日取一點給前端畫圖（統計用完整序列計算）；保留最後一點。"""
    if not nav:
        return []
    t = nav[::step]
    if t[-1] != nav[-1]:
        t.append(nav[-1])
    return t


def walk_forward(markets, rearm):
    """逐年往前：每年年初只用「前瞻 120 日視窗已在年初前結束」的事件，
    在候選（SSO 125/150 × SMA/EMA）中選 120 日報酬中位數最高者，套用到當年事件。"""
    mk = markets["US_SPX"]
    cands = {}
    for kind in ("SMA", "EMA"):
        ev = C.market_events(mk, kind, rearm)
        for fam in ("break200_reclaim125", "break200_reclaim150"):
            evs = ev.get(fam, [])
            rows = []
            for e in evs:
                fm = M.forward_metrics(mk["close"], mk["low"], mk["high"], e["i"], 120)
                end_i = e["i"] + 120
                rows.append({"date": e["date"], "ret": fm["ret"] if fm else None,
                             "known_on": mk["dates"][end_i] if end_i < len(mk["dates"]) else None})
            cands[f"{kind}:{fam}"] = rows
    years = range(1995, int(mk["dates"][-1][:4]) + 1)
    picks, oos = [], {"selected": [], **{k: [] for k in cands}}
    for y in years:
        cut = f"{y}-01-01"
        best, best_val = None, None
        for k, rows in cands.items():
            known = [r["ret"] for r in rows if r["known_on"] and r["known_on"] < cut and r["ret"] is not None]
            if len(known) < 5:
                continue
            m = median(known)
            if best_val is None or m > best_val:
                best, best_val = k, m
        if best is None:
            continue
        picks.append({"year": y, "pick": best, "train_median_120": round(best_val, 4)})
        for k, rows in cands.items():
            yr = [r["ret"] for r in rows if r["date"].startswith(str(y)) and r["ret"] is not None]
            oos[k].extend(yr)
            if k == best:
                oos["selected"].extend(yr)
    return {
        "method": "expanding window，每年 1/1 重選；訓練只用 120 日視窗已結束的事件；至少 5 筆才選。",
        "picks": picks,
        "oos_120": {k: M.summarize(v) for k, v in oos.items()},
    }


def run(mode="full", force=False, today=None):
    today = today or date.today().isoformat()
    in_hash = C.file_hash(C.INPUT_FILES)
    old = json.loads(OUT.read_text()) if OUT.exists() else None
    if old and not force and old.get("input_hash") == in_hash and old.get("model_version") == M.MODEL_VERSION \
            and (mode == "daily" or old.get("full_input_hash") == in_hash):
        print("輸入與模型版本未變，跳過")
        return None
    markets = C.build_markets()
    payload = {
        "updated": today, "model_version": M.MODEL_VERSION, "input_hash": in_hash,
        "horizons": list(HORIZONS),
        "assumptions": {
            "signal_anchor": "訊號日收盤；前瞻 N 個交易日；視窗未滿＝pending（右設限，不計入統計）",
            "execution": "訊號日收盤後成立 → 交易標的下一個交易日開盤成交",
            "rearm": "Reset 去群聚：觸及後收盤連續 N 日高於 300MA 才記下一次（工程假設，非使用者規則）",
            "exit": "使用者未定義出場規則；回測提供『持有 252 日』與『基準跌破 200MA』兩種研究假設",
            "cash_rate": 0.0,
            "prices": "交易標的用真實 ETF 成交價（adj_close/close 換算含息）；不以指數 ×2 推算",
            "basis_returns": "訊號回測的基準報酬為價格指數（不含息）",
            "bootstrap": "事件層級重抽 2000 次，90% 區間，seed 固定",
            "survivorship": "指數／ETF 層級無成分股倖存者偏誤；廣度資料有（見 market_risk_lab.json proxies）",
        },
        "variants": {},
    }
    for kind in ("SMA", "EMA"):
        for rearm in (60, 20):
            key = f"{kind}|rearm{rearm}"
            payload["variants"][key] = {"signals": signal_backtests(markets, kind, rearm)}
    if mode == "full":
        payload["strategies"] = {kind: strategy_backtests(markets, kind, 60) for kind in ("SMA", "EMA")}
        payload["walk_forward"] = walk_forward(markets, 60)
        payload["full_input_hash"] = in_hash
        payload["full_updated"] = today
        prev_v = old.get("model_version") if old else None
        payload["version_check"] = {"previous": prev_v, "current": M.MODEL_VERSION,
                                    "changed": prev_v != M.MODEL_VERSION}
    elif old:
        for k in ("strategies", "walk_forward", "full_input_hash", "full_updated", "version_check"):
            if k in old:
                payload[k] = old[k]
    return payload


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["daily", "full"], default="daily")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args(argv)
    try:
        payload = run(a.mode, a.force)
    except Exception as e:  # noqa: BLE001
        print(f"backtest_market_risk_lab 失敗，保留舊檔：{type(e).__name__}: {e}")
        return 1
    if payload is None:
        return 0
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False))
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB) mode={a.mode}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
