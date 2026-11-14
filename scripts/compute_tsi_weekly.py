"""TSI 逆向訊號（研究重建候選，非作者官方訊號）：NDX 週線 F1／F2 → data/tsi_weekly.json。

公式凍結於 TSI 研究 V1.3.1（研究專案 code/mtf.py＋code/freeze_f1_f2.py），本檔逐行照抄，不得調參：
  NDX 週線（週一為週 key，最後交易日收盤確認）；Stochastic(14,3,3)：K＝SMA3(原始 %K)、D＝SMA3(K)；MACD(12,26,9) EMA adjust=False。
  PURPLE＝K 由 ≥25 跌破 25；BUY_EVENT＝K 上穿 D 且前週 K<25；SELL＝MACD 下穿 Signal 且 K 較前週下降。
  F1＝三種事件；F2＝F1＋BUY_STATE_CONTINUATION（BUY_EVENT 後每週 K 仍 <25 且上升就續亮；狀態，不是新交易）。
資料：Yahoo ^NDX 日線（1990 起，原始價）、QQQ 日線（只供價格對照）。尚未收盤的週不輸出（不產生正式訊號）。
作者證據：data/tsi_evidence.json（由 prep_tsi_evidence.py 從研究專案匯入）。
"""
from __future__ import annotations

import json
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "tsi_weekly.json"
EVID = ROOT / "data" / "tsi_evidence.json"
ET = ZoneInfo("America/New_York")
NDX_START = "1990-01-01"      # 研究 prep_mtf.py：ndx 日線取 1990 起
OUT_START = "1999-03-15"      # 研究 FULL 區間起點
T_STOCH = 25


# ---------- 指標（照抄研究 mtf.py） ----------
def _s(x):
    return pd.Series(x)


def sma(x, n):
    return _s(x).rolling(n).mean().values


def ema(x, n):
    return _s(x).ewm(span=n, adjust=False).mean().values


def stoch(h, l, c, n=14, k=3, d=3):
    ll = _s(l).rolling(n).min().values
    hh = _s(h).rolling(n).max().values
    r = 100 * (c - ll) / np.where(hh - ll == 0, np.nan, hh - ll)
    K = sma(r, k) if k > 1 else r
    return K, sma(K, d)


def macd(c, f=12, s=26, g=9):
    m = ema(c, f) - ema(c, s)
    return m, ema(m, g)


def prev(x):
    p = np.roll(np.asarray(x, float), 1)
    p[0] = np.nan
    return p


def xup(a, b):
    pb = prev(b) if np.ndim(b) else b
    return (a > b) & (prev(a) <= pb)


def xdn(a, b):
    pb = prev(b) if np.ndim(b) else b
    return (a < b) & (prev(a) >= pb)


def weekly(d: pd.DataFrame) -> pd.DataFrame:
    """研究 prep_mtf.weekly：週一為 key；open=首日、high/low=極值、close=末日、last_day=最後交易日。"""
    d = d.copy()
    dt = pd.to_datetime(d["date"])
    d["week"] = (dt - pd.to_timedelta(dt.dt.weekday, unit="D")).dt.normalize()
    g = d.groupby("week")
    return pd.DataFrame({"open": g.open.first(), "high": g.high.max(), "low": g.low.min(),
                         "close": g.close.last(), "last_day": g["date"].max()}).reset_index()


# ---------- NYSE 交易日曆（照抄研究 intrabar_v1/code/engine.py；1999–2026 與日線逐週比對 0 差異） ----------
SPECIAL_CLOSED = {"2001-09-11", "2001-09-12", "2001-09-13", "2001-09-14", "2004-06-11", "2007-01-02",
                  "2012-10-29", "2012-10-30", "2018-12-05", "2025-01-09"}


def _easter(y):
    a, b, c = y % 19, y // 100, y % 100
    d, e = b // 4, b % 4
    g = (8 * b + 13) // 25
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    l_ = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 19 * l_) // 433
    mo = (h + l_ - 7 * m + 90) // 25
    return date(y, mo, (h + l_ - 7 * m + 33 * mo + 19) % 32)


def _nth(y, m, wd, n):
    d = date(y, m, 1)
    d += timedelta((wd - d.weekday()) % 7)
    return d + timedelta(7 * (n - 1))


def _last(y, m, wd):
    d = date(y, m + 1, 1) - timedelta(1)
    return d - timedelta((d.weekday() - wd) % 7)


def _obs(d, sat_to_fri=True):
    if d.weekday() == 5:
        return d - timedelta(1) if sat_to_fri else None
    if d.weekday() == 6:
        return d + timedelta(1)
    return d


def nyse_holidays(y):
    hs = [_obs(date(y, 1, 1), sat_to_fri=False), _nth(y, 1, 0, 3), _nth(y, 2, 0, 3), _easter(y) - timedelta(2),
          _last(y, 5, 0), _obs(date(y, 7, 4)), _nth(y, 9, 0, 1), _nth(y, 11, 3, 4), _obs(date(y, 12, 25))]
    if y >= 2022:
        hs.append(_obs(date(y, 6, 19)))
    return {h for h in hs if h}


def expected_days(monday: date) -> list[str]:
    hol = nyse_holidays(monday.year) | nyse_holidays((monday + timedelta(4)).year)
    return [d.isoformat() for d in (monday + timedelta(i) for i in range(5))
            if d not in hol and d.isoformat() not in SPECIAL_CLOSED]


def close_hour(day: date) -> int:
    """美股收盤：16:00 ET；提前收盤 13:00（感恩節隔天、平日的 12/24、平日的 7/3）。"""
    if day in nyse_holidays(day.year):
        return 16
    if (day.month == 11 and day.weekday() == 4 and 23 <= day.day <= 29) or \
            ((day.month, day.day) in ((12, 24), (7, 3)) and day.weekday() < 5):
        return 13
    return 16


def close_dt(day: date) -> datetime:
    return datetime(day.year, day.month, day.day, close_hour(day), 0, tzinfo=ET)


def week_status(monday: date, actual_days, now_utc: datetime) -> str:
    """CONFIRMED＝最後預期交易日已正式收盤，且當週每個預期交易日的日線都已取得；
    PROVISIONAL＝最後交易日還沒收盤；DATA_PENDING＝理論上已收盤但日線缺漏（不猜收盤值、不拿週四當週五）。"""
    exp = expected_days(monday)
    if not exp:
        return "NO_TRADING"
    last = date.fromisoformat(exp[-1])
    if now_utc < close_dt(last):
        return "PROVISIONAL"
    if monday.isoformat() < OUT_START:
        return "CONFIRMED"                       # 1999 前只是指標暖機，日曆不逐日核對
    return "CONFIRMED" if set(exp) <= set(actual_days) else "DATA_PENDING"


def week_closed(week_monday: date, now_utc: datetime, actual_days=None) -> bool:
    return week_status(week_monday, actual_days if actual_days is not None else expected_days(week_monday), now_utc) == "CONFIRMED"


def compute(wd: pd.DataFrame) -> pd.DataFrame:
    h, l, c = wd.high.values, wd.low.values, wd.close.values
    K, D = stoch(h, l, c, 14, 3, 3)
    m, sg = macd(c, 12, 26, 9)
    pK = prev(K)
    nb = lambda x: np.nan_to_num(x).astype(bool)
    PUR = nb(xdn(K, T_STOCH))
    BEV = nb(xup(K, D) & (pK < T_STOCH))
    SEL = nb(xdn(m, sg) & (K < pK))
    n = len(wd)
    CONT = np.zeros(n, bool)
    src = np.full(n, -1)
    on, last = False, -1
    for i in range(n):
        if BEV[i]:
            on, last = True, i
            continue
        on = on and K[i] > pK[i] and K[i] < T_STOCH
        if on:
            CONT[i], src[i] = True, last
    out = wd.copy()
    out["K"], out["D"], out["macd"], out["signal"] = K, D, m, sg
    out["purple"], out["buy_event"], out["sell"], out["continuation"] = PUR, BEV, SEL, CONT
    out["cont_of"] = [wd.week.iloc[j].strftime("%Y-%m-%d") if j >= 0 else "" for j in src]
    return out


# ---------- 資料 ----------
def fetch_daily(ticker: str, start: str) -> pd.DataFrame:
    import yfinance as yf
    df = yf.download(ticker, start=start, end=(date.today() + timedelta(days=1)).isoformat(),
                     auto_adjust=False, progress=False, threads=False)
    if df.empty:
        raise RuntimeError(f"{ticker} 無資料")
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    df = df.rename(columns=str.lower).reset_index()
    df["date"] = pd.to_datetime(df["Date"]).dt.strftime("%Y-%m-%d")
    return df[["date", "open", "high", "low", "close"]].dropna(subset=["close"])


def evidence_index(ev: dict) -> dict:
    """週 → 作者證據狀態。只用研究專案已登錄的資料；沒有就 UNKNOWN。"""
    idx: dict[str, dict] = {}
    for g in ev.get("ground_truth", []):
        if g.get("timeframe") != "W":
            continue
        idx.setdefault(g["signal_date_week_start"], {"week": g["signal_date_week_start"]})["ground_truth"] = (
            f'{g["signal_id"]} {g["signal"]} {g["confidence"]}（{g["evidence_grade"]}）')
    for f in ev.get("forward_tracking", []):
        e = idx.setdefault(f["week"], {"week": f["week"]})
        e.update(status=f.get("evaluation_status") or "UNKNOWN", sample=f.get("in_sample_or_out_of_sample", ""),
                 eligible=f.get("weekly_scoring_eligible", "false") == "true", author_signal=f.get("author_signal", ""),
                 note=f.get("note", ""))
    return idx


def r2(x):
    return None if x is None or not np.isfinite(x) else round(float(x), 2)


SIGS = ("purple", "buy", "cont", "sell")
COLS = {"purple": "purple", "buy": "buy_event", "cont": "continuation", "sell": "sell"}


def partial_steps(wd_before: pd.DataFrame, days: pd.DataFrame) -> list[dict]:
    """完整週固定，只把當週換成截至各交易日收盤的累積 OHLC，跑同一組公式取最後一列（無前視）。"""
    wk = pd.Timestamp(days.date.iloc[0]) - pd.Timedelta(days=pd.Timestamp(days.date.iloc[0]).weekday())
    steps = []
    for j in range(len(days)):
        part = pd.DataFrame([{"week": wk.normalize(), "open": days.open.iloc[0], "high": days.high.iloc[:j + 1].max(),
                              "low": days.low.iloc[:j + 1].min(), "close": days.close.iloc[j], "last_day": days.date.iloc[j]}])
        r = compute(pd.concat([wd_before, part], ignore_index=True)).iloc[-1]
        steps.append({"day_no": j + 1, "date": days.date.iloc[j], "c": r2(r.close), "k": r2(r.K), "d": r2(r.D),
                      "macd": r2(r.macd), "sig": r2(r.signal), **{k: bool(r[COLS[k]]) for k in SIGS}})
    return steps


def intrabar_summary(steps: list[dict], final: dict) -> dict:
    """每種訊號分開保存首次亮燈、消失／重現、翻轉次數；續亮是 STATE，與 BUY_EVENT 分開計，不會互相加總。"""
    out = {}
    last = steps[-1]["date"] if steps else None
    for k in SIGS:
        seq = [s[k] for s in steps]
        if not any(seq) and not final[k]:
            continue
        i0 = seq.index(True) if any(seq) else None
        flips = sum(a != b for a, b in zip(seq, seq[1:]))   # 同研究：週內相鄰交易日狀態改變次數
        gone = any(seq[i] and not seq[i + 1] for i in range(len(seq) - 1))
        back = any(not seq[i] and seq[i + 1] for i in range(i0 + 1, len(seq) - 1)) if i0 is not None else False
        out[k] = {
            "first_provisional_date": steps[i0]["date"] if i0 is not None else None,
            "first_provisional_day_no": i0 + 1 if i0 is not None else None,
            "first_provisional_status": None if i0 is None else ("CONFIRM_DAY_ONLY" if i0 == len(seq) - 1 else "PROVISIONAL_EARLY"),
            "final": bool(final[k]),
            "final_confirmation_date": last if final[k] else None,
            "provisional_disappeared": gone,
            "provisional_reappeared": back,
            "number_of_signal_flips": flips,
        }
    return out


def provisional_week(wd: pd.DataFrame, ndx: pd.DataFrame, pending: pd.DataFrame, now_utc: datetime) -> dict | None:
    """進行中週線（永遠不寫進 data[]）。status＝PROVISIONAL（週線形成中）或 DATA_PENDING（理論上已收盤、日線未齊）。"""
    if not len(pending):
        return None
    wk = pending.week.iloc[0]
    days = ndx[_wkey(ndx) == wk].reset_index(drop=True)
    exp = expected_days(wk.date())
    status = week_status(wk.date(), list(days.date), now_utc)
    base = {"week": wk.strftime("%Y-%m-%d"), "status": status, "expected_days": exp,
            "missing_days": [d for d in exp if d not in set(days.date) and now_utc >= close_dt(date.fromisoformat(d))],
            "trading_days_in_week": len(exp)}
    if not len(days):
        return {**base, "day_no": 0, "data_incomplete": bool(base["missing_days"]), "steps": [], "first_seen": {}}
    steps = partial_steps(wd, days)
    for st in steps:                                   # 第幾個交易日＝交易所日曆序號，不是資料筆數
        st["day_no"] = exp.index(st["date"]) + 1 if st["date"] in exp else None
    first = {k: next((s["date"] for s in steps if s[k]), None) for k in SIGS}
    gaps = [d for d in base["missing_days"] if d <= steps[-1]["date"]]
    return {**base, "day_no": steps[-1]["day_no"], "data_incomplete": bool(gaps), "steps": steps, "first_seen": first}


def _wkey(d: pd.DataFrame) -> pd.Series:
    dt = pd.to_datetime(d["date"])
    return (dt - pd.to_timedelta(dt.dt.weekday, unit="D")).dt.normalize()


def build(ndx: pd.DataFrame, qqq: pd.DataFrame | None, ev: dict, now_utc: datetime, intrabar_from: str = OUT_START) -> dict:
    ndx = ndx[ndx["date"] >= NDX_START]
    # 今天盤中那筆（尚未收盤）不算已取得的日線
    ndx = ndx[[now_utc >= close_dt(date.fromisoformat(x)) for x in ndx["date"]]].reset_index(drop=True)
    wd = weekly(ndx)
    key = _wkey(ndx)
    by_week = {w: list(g) for w, g in ndx.groupby(key)["date"]}
    have = set(wd.week)
    m = max(pd.Timestamp(OUT_START), wd.week.iloc[0]) if len(wd) else pd.Timestamp(OUT_START)
    while len(wd) and m <= wd.week.iloc[-1]:            # 依交易所日曆列出應有的週，整週缺資料也要抓到
        if expected_days(m.date()) and m not in have:
            raise RuntimeError(f"{m.date()} 週整週沒有日線，不得往後計算")
        m += pd.Timedelta(days=7)
    status = [week_status(w.date(), by_week.get(w, []), now_utc) for w in wd.week]
    i0 = next((i for i, s in enumerate(status) if s != "CONFIRMED"), len(status))
    if len(status) - i0 > 2:
        raise RuntimeError(f"{wd.week.iloc[i0].date()} 週日線缺漏（{status[i0]}），不得往後計算")
    pending = wd.iloc[i0:]
    wd = wd.iloc[:i0].reset_index(drop=True)          # 未確認的週不進公式
    res = compute(wd)
    qw = {}
    if qqq is not None and len(qqq):
        q = weekly(qqq)
        qw = {w.strftime("%Y-%m-%d"): r for w, r in zip(q.week, q.itertuples())}
    evi = evidence_index(ev)
    rows = []
    for i in range(len(res)):
        r = res.iloc[i]
        if r.week < pd.Timestamp(OUT_START):
            continue
        wk = r.week.strftime("%Y-%m-%d")
        ld = date.fromisoformat(r.last_day)
        conf = close_dt(ld).astimezone(timezone.utc)
        days = ndx[key == r.week].reset_index(drop=True)
        final = {k: bool(r[COLS[k]]) for k in SIGS}
        steps = partial_steps(wd.iloc[:i], days) if wk >= intrabar_from else []
        if steps and {k: steps[-1][k] for k in SIGS} != final:
            raise RuntimeError(f"{wk} 週內重建最後一天與正式週線不一致")
        qr = qw.get(wk)
        e = evi.get(wk, {})
        rows.append({
            "week": wk, "week_end": (r.week + timedelta(days=4)).strftime("%Y-%m-%d"), "last_day": r.last_day,
            "confirm_utc": conf.strftime("%Y-%m-%dT%H:%MZ"),
            "o": r2(r.open), "h": r2(r.high), "l": r2(r.low), "c": r2(r.close),
            "qqq": [r2(qr.open), r2(qr.high), r2(qr.low), r2(qr.close)] if qr is not None else None,
            "k": r2(r.K), "d": r2(r.D), "macd": r2(r.macd), "sig": r2(r.signal),
            "purple": final["purple"], "buy": final["buy"], "cont": final["cont"], "sell": final["sell"],
            "cont_of": r.cont_of,
            "trading_days_in_week": len(days),
            "intrabar": (intrabar_summary(steps, final) or None) if steps else None,
            "author": e.get("status") or ("GROUND_TRUTH" if "ground_truth" in e else "UNKNOWN"),
            "author_detail": e or None,
        })
    nb = sum(x["buy"] for x in rows)
    current = provisional_week(wd, ndx, pending, now_utc)
    return {
        "updated": now_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "label": "研究重建候選，非作者官方訊號",
        "formula_version": "TSI F1/F2 frozen V1.3.1 (+V1.3.2 evidence patch)",
        "formula": {"market": "NDX", "timeframe": "W", "stoch": [14, 3, 3], "macd": [12, 26, 9], "threshold": T_STOCH},
        "data_through": ndx["date"].iloc[-1] if len(ndx) else None,
        "expected_through": expected_through(now_utc),
        "data_lag_days": lag_days(ndx["date"].iloc[-1] if len(ndx) else None, now_utc),
        "last_complete_week": rows[-1]["week"] if rows else None,
        "pending_week": pending.week.iloc[0].strftime("%Y-%m-%d") if len(pending) else None,
        "counts": {"purple": sum(x["purple"] for x in rows), "buy_event": nb, "continuation": sum(x["cont"] for x in rows),
                   "sell": sum(x["sell"] for x in rows), "F1_green": nb, "F2_green": nb + sum(x["cont"] for x in rows)},
        "current_week": current,
        "intrabar_confirm_rates": ev.get("intrabar_confirm_rates", []),
        "intrabar_source": ev.get("intrabar_source", ""),
        "evidence_source": ev.get("source", ""),
        "forward_tracking": ev.get("forward_tracking", []),
        "data": rows,
    }


def expected_through(now_utc: datetime) -> str:
    """交易所日曆上、到現在為止最後一個已正式收盤的交易日。"""
    d = now_utc.astimezone(ET).date()
    while True:
        mon = d - timedelta(days=d.weekday())
        if d.isoformat() in expected_days(mon) and now_utc >= close_dt(d):
            return d.isoformat()
        d -= timedelta(days=1)


def lag_days(data_through: str | None, now_utc: datetime) -> int | None:
    """data_through 之後、到 expected_through 為止還沒拿到的交易日數（資料新鮮度看這個，不看執行時間）。"""
    if not data_through:
        return None
    end, n, d = expected_through(now_utc), 0, date.fromisoformat(data_through) + timedelta(days=1)
    while d.isoformat() <= end:
        n += d.isoformat() in expected_days(d - timedelta(days=d.weekday()))
        d += timedelta(days=1)
    return n


def refuse_overwrite(old: dict, new: dict) -> str | None:
    """已確認的舊資料不得被不完整的新資料覆蓋。歷史週數只能增加；資料日期不得倒退。"""
    if len(new["data"]) < len(old.get("data", [])):
        return f"週數由 {len(old['data'])} 減為 {len(new['data'])}，疑似資料缺漏"
    if (old.get("last_complete_week") or "") > (new.get("last_complete_week") or ""):
        return f"新資料最後確認週 {new.get('last_complete_week')} 早於舊檔 {old['last_complete_week']}"
    if (old.get("data_through") or "") > (new.get("data_through") or ""):
        return f"資料日期由 {old['data_through']} 倒退為 {new.get('data_through')}"
    old_weeks = [r["week"] for r in old.get("data", [])]
    if old_weeks and [r["week"] for r in new["data"][:len(old_weeks)]] != old_weeks:
        return "既有歷史週清單被改變"
    return None


def atomic_write(path: Path, text: str) -> None:
    """先寫同目錄暫存檔再 os.replace；中途失敗舊檔不動。"""
    import os
    import tempfile
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def main() -> None:
    now = datetime.now(timezone.utc)
    ndx = fetch_daily("^NDX", "1985-01-01")
    try:
        qqq = fetch_daily("QQQ", "1999-03-01")
    except Exception as e:                       # QQQ 只是對照，不擋主流程
        print("QQQ 抓取失敗，略過：", e)
        qqq = None
    ev = json.loads(EVID.read_text(encoding="utf-8")) if EVID.exists() else {}
    out = build(ndx, qqq, ev, now)
    if OUT.exists():
        why = refuse_overwrite(json.loads(OUT.read_text(encoding="utf-8")), out)
        if why:
            sys.exit(why + "，保留舊檔")
    atomic_write(OUT, json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n")
    if out["data_lag_days"]:
        print(f"::warning::TSI 資料停在 {out['data_through']}，落後 {out['data_lag_days']} 個交易日")
    print(f"wrote {OUT} weeks={len(out['data'])} last={out['last_complete_week']} pending={out['pending_week']} counts={out['counts']}")


if __name__ == "__main__":
    main()
