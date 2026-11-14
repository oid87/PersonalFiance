"""市場預警與策略回測：純計算核心（無 I/O、無網路），供 compute／backtest 兩支腳本與測試共用。

時間規則（防 look-ahead）：
- 均線 MA_t 用 t 日（含）以前的收盤。盤中觸及判斷用「前一日」均線 MA_{t-1}：
  盤中當下 t 日收盤未知，只能拿昨天收盤算出的均線當作盤中參考線。
- 收盤型條件（跌破／站回）在 t 日收盤後才成立；可成交時間為 t+1 開盤。
- 前瞻報酬以訊號日 t 收盤為錨，視窗未滿的事件標記 censored（pending），不進統計。
"""
from __future__ import annotations

import math
import random
from bisect import bisect_left
from statistics import median

MODEL_VERSION = "mrl-1.0.0"

# ── 基本序列工具 ───────────────────────────────────────────────────────────


def sma(values, n):
    out = [None] * len(values)
    s, q = 0.0, []
    for i, v in enumerate(values):
        if v is None:
            s, q = 0.0, []
            continue
        q.append(v)
        s += v
        if len(q) > n:
            s -= q.pop(0)
        if len(q) == n:
            out[i] = s / n
    return out


def ema(values, n):
    """EMA 以前 n 筆 SMA 起算（與 SMA 同樣需要 n 筆暖身，避免早期值失真）。"""
    out = [None] * len(values)
    k = 2.0 / (n + 1)
    prev, buf = None, []
    for i, v in enumerate(values):
        if v is None:
            prev, buf = None, []
            continue
        if prev is None:
            buf.append(v)
            if len(buf) == n:
                prev = sum(buf) / n
                out[i] = prev
            continue
        prev = v * k + prev * (1 - k)
        out[i] = prev
    return out


def moving_average(values, n, kind="SMA"):
    return ema(values, n) if kind.upper() == "EMA" else sma(values, n)


def shift1(arr):
    return [None] + list(arr[:-1])


def pct(a, b):
    if a is None or b is None or b == 0:
        return None
    return a / b - 1.0


# ── 事件偵測 ─────────────────────────────────────────────────────────────


def detect_resets(dates, low, close, ma_len=300, kind="SMA", rearm_days=60):
    """盤中觸及長均線的 Reset 事件。

    觸及：low_t ≤ MA_{t-1}（前一日收盤算的均線）。low 為 None 的日子視為「無法判定」，
    不當成觸及也不當成未觸及（不會用收盤冒充）。

    去群聚（工程假設，不是使用者規則）：一次觸及之後，要先連續 rearm_days 個交易日
    收盤都在 MA 之上，才會記錄下一次 Reset，避免同一段修正每天都算一次。
    """
    ma = moving_average(close, ma_len, kind)
    ma_prev = shift1(ma)
    events, armed, above_run = [], True, rearm_days
    unknown_days = 0
    for i in range(len(dates)):
        m = ma_prev[i]
        if m is None:
            continue
        if low[i] is None:
            unknown_days += 1
            continue
        if low[i] <= m:
            if armed:
                events.append({"i": i, "date": dates[i], "low": low[i], "ma": round(m, 4),
                               "close": close[i], "closed_below": close[i] < m})
            armed, above_run = False, 0
        elif close[i] is not None and ma[i] is not None and close[i] > ma[i]:
            above_run += 1
            if above_run >= rearm_days:
                armed = True
        else:
            above_run = 0
    return events, ma, unknown_days


def detect_reclaim_after(dates, close, ma_vals, start_events, *, need_break_ma=None,
                         label="reclaim"):
    """每個起點事件之後，第一次「收盤 > 指定均線」的日子。

    need_break_ma：若給，起點之後必須先出現收盤 < 該均線，才開始等待站回。
    每個起點最多產生一次觸發；下一個起點出現前若尚未觸發則作廢（被新起點取代）。
    同一天收盤條件成立 → 訊號日 t，可成交 t+1。
    """
    out = []
    starts = [e["i"] for e in start_events]
    for k, s in enumerate(starts):
        end = starts[k + 1] if k + 1 < len(starts) else len(dates)
        broke = need_break_ma is None
        for i in range(s, end):
            if i == s and need_break_ma is None:
                # Reset 當天（盤中觸及）不算站回，避免同日觸發
                continue
            c, m = close[i], ma_vals[i]
            if c is None or m is None:
                continue
            if not broke:
                b = need_break_ma[i]
                if b is not None and c < b:
                    broke = True
                continue
            if c > m:
                out.append({"i": i, "date": dates[i], "close": c, "ma": round(m, 4),
                            "from": dates[s], "label": label})
                break
    return out


def detect_break_then_reclaim(dates, close, break_ma, reclaim_ma, label, rearm_days=20):
    """SSO 型：收盤跌破 break_ma 之後，第一次收盤站回 reclaim_ma。

    跌破事件去群聚：觸發後要先收盤在 break_ma 之上連續 rearm_days 日，才接受下一次跌破。
    """
    out, state, above_run, brk = [], "wait_break", 0, None
    for i in range(len(dates)):
        c, b, r = close[i], break_ma[i], reclaim_ma[i]
        if c is None or b is None or r is None:
            continue
        if state == "wait_break":
            if c < b:
                state, brk = "wait_reclaim", i
        elif state == "wait_reclaim":
            if c > r and i > brk:
                out.append({"i": i, "date": dates[i], "close": c, "ma": round(r, 4),
                            "from": dates[brk], "label": label})
                state, above_run = "cooldown", 0
        else:  # cooldown
            above_run = above_run + 1 if c > b else 0
            if above_run >= rearm_days:
                state = "wait_break"
    return out


# ── 訊號回測（事件研究） ──────────────────────────────────────────────────


def forward_metrics(close, low, high, i, h):
    """以 i 日收盤為錨的 h 日前瞻指標；資料不足回 None（右設限）。"""
    if i + h >= len(close) or close[i] is None:
        return None
    base = close[i]
    seg_c = [c for c in close[i + 1:i + h + 1] if c is not None]
    seg_l = [x if x is not None else c for x, c in zip(low[i + 1:i + h + 1], close[i + 1:i + h + 1]) if c is not None]
    seg_h = [x if x is not None else c for x, c in zip(high[i + 1:i + h + 1], close[i + 1:i + h + 1]) if c is not None]
    if not seg_c:
        return None
    peak, mdd = base, 0.0
    for c in seg_c:
        peak = max(peak, c)
        mdd = min(mdd, c / peak - 1)
    return {
        "ret": close[i + h] / base - 1 if close[i + h] is not None else None,
        "mae": min(seg_l) / base - 1,
        "mfe": max(seg_h) / base - 1,
        "mdd": mdd,
    }


def bootstrap_ci(vals, stat=None, n=2000, alpha=0.10, seed=20261114):
    vals = [v for v in vals if v is not None]
    if len(vals) < 3:
        return None
    stat = stat or (lambda xs: sum(xs) / len(xs))
    rng = random.Random(seed)
    res = sorted(stat([vals[rng.randrange(len(vals))] for _ in vals]) for _ in range(n))
    lo = res[int(n * alpha / 2)]
    hi = res[int(n * (1 - alpha / 2)) - 1]
    return [round(lo, 4), round(hi, 4)]


def summarize(vals):
    vals = [v for v in vals if v is not None]
    if not vals:
        return {"n": 0}
    return {
        "n": len(vals),
        "mean": round(sum(vals) / len(vals), 4),
        "median": round(median(vals), 4),
        "up": round(sum(1 for v in vals if v > 0) / len(vals), 4),
        "ci90_mean": bootstrap_ci(vals),
    }


def event_study(dates, close, low, high, events, horizons=(20, 60, 120, 252),
                cluster_days=60, rebreak_lookback=60, oos_from="2013-01-01"):
    """事件研究。回傳逐事件明細、各 horizon 統計、無訊號基準、樣本內外、去群聚版本。"""
    rows = []
    last_i = None
    for e in events:
        i = e["i"]
        clustered = last_i is not None and i - last_i < cluster_days
        last_i = i
        prior_low = min((x for x in low[max(0, i - rebreak_lookback):i + 1] if x is not None), default=None)
        r = {"date": e["date"], "i": i, "clustered": clustered, "h": {}}
        for h in horizons:
            fm = forward_metrics(close, low, high, i, h)
            if fm is None:
                r["h"][str(h)] = {"status": "pending"}
                continue
            seg = [x for x in low[i + 1:i + h + 1] if x is not None]
            fm["rebreak"] = bool(prior_low is not None and seg and min(seg) < prior_low)
            fm["status"] = "complete"
            r["h"][str(h)] = {k: (round(v, 4) if isinstance(v, float) else v) for k, v in fm.items()}
        rows.append(r)

    def stats_for(sel):
        out = {}
        for h in horizons:
            done = [r["h"][str(h)] for r in sel if r["h"][str(h)]["status"] == "complete"]
            pend = sum(1 for r in sel if r["h"][str(h)]["status"] == "pending")
            s = summarize([d["ret"] for d in done])
            s["pending"] = pend
            if done:
                s["mae_median"] = round(median(d["mae"] for d in done), 4)
                s["mfe_median"] = round(median(d["mfe"] for d in done), 4)
                s["mdd_worst"] = round(min(d["mdd"] for d in done), 4)
                s["rebreak"] = round(sum(1 for d in done if d["rebreak"]) / len(done), 4)
            out[str(h)] = s
        return out

    first_date = events[0]["date"] if events else None
    baseline = {}
    if first_date:
        i0 = bisect_left(dates, first_date)
        for h in horizons:
            vals = [close[j + h] / close[j] - 1 for j in range(i0, len(close) - h)
                    if close[j] is not None and close[j + h] is not None]
            b = {"n": len(vals)}
            if vals:
                b.update(mean=round(sum(vals) / len(vals), 4), median=round(median(vals), 4),
                         up=round(sum(1 for v in vals if v > 0) / len(vals), 4))
            baseline[str(h)] = b
    return {
        "events": rows,
        "all": stats_for(rows),
        "declustered": stats_for([r for r in rows if not r["clustered"]]),
        "in_sample": stats_for([r for r in rows if r["date"] < oos_from]),
        "out_of_sample": stats_for([r for r in rows if r["date"] >= oos_from]),
        "baseline_all_days": baseline,
        "oos_from": oos_from,
    }


# ── 策略回測（真實 ETF 價格的組合 NAV） ─────────────────────────────────────


def nav_backtest(dates, opn, close, adj_ratio, signals, *, basis_close=None, basis_exit_ma=None,
                 basis_dates=None, initial=1_000_000.0, tranches=(1.0,), tranche_gap=21,
                 hold_days=252, exit_rule="hold", fee_buy=0.0005, fee_sell=0.0005,
                 slippage=0.0005, start=None, end=None):
    """單一交易標的的組合 NAV 回測。

    - 標的價格用該 ETF 的真實成交價（已內含每日槓桿重設與費用），不以指數 ×2／×3 推算。
    - 訊號日 t（收盤後成立）→ 第 1 批在 t+1 開盤成交；第 k 批在 t+1+k×tranche_gap 開盤成交。
    - 含息：以 adj_ratio（adj_close/close）把開／收盤換算成含息價。
    - 出場：exit_rule="hold" 持有 hold_days 個交易日後次日開盤賣出；
      "basis_below_ma" 另加「訊號基準收盤跌破 basis_exit_ma」→ 次日開盤賣出（研究假設）。
    - 未投入資金留在現金（利率 0，保守）。持有中出現新訊號忽略（不加碼）。
    """
    n = len(dates)
    px_o = [o * r if o is not None and r is not None else None for o, r in zip(opn, adj_ratio)]
    px_c = [c * r if c is not None and r is not None else None for c, r in zip(close, adj_ratio)]
    idx = {d: k for k, d in enumerate(dates)}
    bidx = {d: k for k, d in enumerate(basis_dates)} if basis_dates else {}
    sig_by_i = {}
    for s in signals:
        j = bisect_left(dates, s["date"])
        # 訊號日之後第一個「該標的」交易日開盤成交（跨市場對齊：用日期，不用索引）
        if j < n and dates[j] == s["date"]:
            j += 1
        if j < n:
            sig_by_i.setdefault(j, s)

    cash, units, nav = initial, 0.0, []
    trades, pos = [], None
    i0 = bisect_left(dates, start) if start else 0
    i1 = bisect_left(dates, end) if end else n
    for i in range(i0, min(i1, n)):
        d = dates[i]
        if px_c[i] is None:
            nav.append([d, nav[-1][1] if nav else initial])
            continue
        # 1) 出場（以今日開盤成交，條件在昨日收盤成立）
        if pos and pos.get("exit_pending") and px_o[i] is not None:
            proceeds = units * px_o[i] * (1 - slippage) * (1 - fee_sell)
            trades.append({"side": "sell", "date": d, "price": round(px_o[i], 4), "units": round(units, 6),
                           "reason": pos["exit_reason"]})
            pos["exit_date"] = d
            pos["exit_value"] = proceeds
            cash += proceeds
            units, pos = 0.0, None
        # 2) 新訊號進場
        if pos is None and i in sig_by_i and px_o[i] is not None:
            pos = {"signal": sig_by_i[i]["date"], "entry_i": i, "batches_done": 0,
                   "batch_cash": cash, "exit_pending": False}
        # 3) 分批成交
        if pos and not pos["exit_pending"] and pos["batches_done"] < len(tranches):
            due = pos["entry_i"] + pos["batches_done"] * tranche_gap
            if i >= due and px_o[i] is not None:
                w = tranches[pos["batches_done"]]
                spend = min(cash, pos["batch_cash"] * w)
                if spend > 0:
                    buy_px = px_o[i] * (1 + slippage)
                    units += spend * (1 - fee_buy) / buy_px
                    cash -= spend
                    trades.append({"side": "buy", "date": d, "price": round(px_o[i], 4), "amount": round(spend, 2),
                                   "batch": pos["batches_done"] + 1, "signal": pos["signal"]})
                pos["batches_done"] += 1
        # 4) 收盤後判斷出場條件（明日開盤成交）
        if pos and not pos["exit_pending"]:
            held = i - pos["entry_i"]
            if held >= hold_days:
                pos["exit_pending"], pos["exit_reason"] = True, f"持有滿{hold_days}日"
            elif exit_rule == "basis_below_ma" and basis_close is not None:
                k = bidx.get(d)
                if k is not None and basis_close[k] is not None and basis_exit_ma[k] is not None \
                        and basis_close[k] < basis_exit_ma[k] and held >= 1:
                    pos["exit_pending"], pos["exit_reason"] = True, "基準收盤跌破出場均線"
        nav.append([d, round(cash + units * px_c[i], 2)])
    open_pos = pos is not None
    return {"nav": nav, "trades": trades, "open_position": open_pos, "final_cash": round(cash, 2)}


def perf_stats(nav, periods_per_year=252):
    vals = [v for _, v in nav if v is not None]
    if len(vals) < 2:
        return {}
    years = len(vals) / periods_per_year
    cagr = (vals[-1] / vals[0]) ** (1 / years) - 1 if vals[0] > 0 and years > 0 else None
    peak, mdd = vals[0], 0.0
    rets = []
    for a, b in zip(vals, vals[1:]):
        rets.append(b / a - 1 if a else 0.0)
    for v in vals:
        peak = max(peak, v)
        mdd = min(mdd, v / peak - 1)
    mu = sum(rets) / len(rets)
    sd = math.sqrt(sum((r - mu) ** 2 for r in rets) / max(1, len(rets) - 1))
    sharpe = mu / sd * math.sqrt(periods_per_year) if sd > 0 else None
    exposure = sum(1 for r in rets if r != 0) / len(rets)
    return {
        "start": nav[0][0], "end": nav[-1][0],
        "total_return": round(vals[-1] / vals[0] - 1, 4),
        "cagr": round(cagr, 4) if cagr is not None else None,
        "max_drawdown": round(mdd, 4),
        "sharpe_rf0": round(sharpe, 3) if sharpe is not None else None,
        "exposure": round(exposure, 3),
    }


def buy_hold_nav(dates, close, adj_ratio, start, end=None, initial=1_000_000.0):
    px = [c * r if c is not None and r is not None else None for c, r in zip(close, adj_ratio)]
    i0 = bisect_left(dates, start)
    i1 = bisect_left(dates, end) if end else len(dates)
    base = None
    out = []
    for i in range(i0, i1):
        if px[i] is None:
            continue
        if base is None:
            base = px[i]
        out.append([dates[i], round(initial * px[i] / base, 2)])
    return out


# ── 美股早期預警指標 ─────────────────────────────────────────────────────


def distribution_days(close, volume, i, window=25, thr=-0.002):
    """IBD 式：收盤跌 ≥0.2% 且量大於前一日；只計最近 window 日（含 i）。"""
    cnt = 0
    for j in range(max(1, i - window + 1), i + 1):
        c0, c1, v0, v1 = close[j - 1], close[j], volume[j - 1], volume[j]
        if None in (c0, c1, v0, v1) or c0 == 0 or not v0 or not v1:
            continue
        if c1 / c0 - 1 <= thr and v1 > v0:
            cnt += 1
    return cnt


def lower_high(high, i, recent=21, prior=63):
    """近 recent 日最高價 < 再往前 prior 日最高價（且近期未創新高）。"""
    if i < recent + prior:
        return None
    r = [x for x in high[i - recent + 1:i + 1] if x is not None]
    p = [x for x in high[i - recent - prior + 1:i - recent + 1] if x is not None]
    if not r or not p:
        return None
    return max(r) < max(p)


def momentum(close, i, n):
    if i - n < 0 or close[i] is None or close[i - n] in (None, 0):
        return None
    return close[i] / close[i - n] - 1
