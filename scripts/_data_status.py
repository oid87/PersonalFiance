"""各資料來源的更新狀態（#tab=breadthwarn 用）：純邏輯，不碰檔案與網路。
目的：某個來源停了幾天時，頁面與維護者都看得出來，不會被「排程有跑」蓋過去。

狀態 state：
  ok       已是目前可取得的最新資料
  waiting  今天（平日）的資料還沒到公布時間，或剛過公布時間、等下一次排程
  closed   平日已過公布時間，但沒有任何來源有那一天的資料：休市，或全部來源都還沒更新（無法只靠資料分辨）
  behind   其他來源已經有更新的交易日，這個來源沒有
  failed   這次抓取的腳本以錯誤結束，而且資料不是最新
原因 cause（behind／failed 才有）：
  request 請求失敗、format 資料格式改變、incomplete 資料不完整、script 腳本錯誤、
  source 腳本正常結束但沒有拿到新資料（來源尚未更新，或腳本內部略過）
交易日基準：任何一個來源已經有資料的日子就算交易日（沒有另外抓交易所行事曆）。
"""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta, timezone

TPE = timezone(timedelta(hours=8))

# ready：臺北時間幾點之後，當天資料「應該」拿得到。backfill：錯過之後能不能指定日期重抓。
SOURCES = [
    dict(key="twii", name="台股加權指數（日線）", script="fetch_stocks.py", src="Yahoo Finance ^TWII",
         cadence="每個交易日收盤後", ready="15:00", backfill=True, grace=1,
         note="Yahoo 常在隔天清晨才補上當天那一列，所以夜間排程後落後 1 個交易日算正常。"),
    dict(key="etf", name="0050、00631L（還原價）", script="fetch_panic_entry.py", src="FinMind 日線與除權息、分割",
         cadence="每個交易日收盤後", ready="16:00", backfill=True, grace=1,
         note="和加權指數對齊同一個日期軸，指數那一列還沒到時這裡也不會前進。"),
    dict(key="tw50", name="臺灣50 市場廣度", script="fetch_tw_breadth_warn.py", src="Yahoo Finance 成分股日線（本頁自算）",
         cadence="每個交易日收盤後", ready="16:00", backfill=True, grace=0),
    dict(key="twse", name="上市市場廣度", script="fetch_tw_breadth_warn.py", src="Yahoo Finance 上市個股日線（本頁自算）",
         cadence="每個交易日收盤後", ready="16:00", backfill=True, grace=0),
    dict(key="tpex", name="上櫃市場廣度", script="fetch_tw_breadth_warn.py", src="Yahoo Finance 上櫃個股日線（本頁自算）",
         cadence="每個交易日收盤後", ready="16:00", backfill=True, grace=0),
    dict(key="margin", name="融資餘額與買賣", script="fetch_tw_breadth_warn.py", src="證交所、櫃買中心信用交易統計",
         cadence="每個交易日晚間", ready="21:30", backfill=True, grace=0),
    dict(key="ld", name="跌停與買盤（跌停家數、收盤無委買）", script="fetch_tw_breadth_warn.py", src="Yahoo 日線自算＋證交所、櫃買收盤行情",
         cadence="每個交易日收盤後", ready="17:00", backfill=True, grace=0),
    dict(key="intraday", name="盤中歷史統計（每 5 秒委託成交）", script="fetch_tw_intraday.py", src="證交所盤後資訊（政府開放資料 11671）",
         cadence="每個交易日收盤後公布", ready="17:00", backfill=False, grace=0,
         note="下載點只提供最新一個交易日，錯過就無法回補，缺的日子會一直標示為缺漏。"),
]

TRACK_FROM = "2026-10-01"   # 盤中統計從這天起連續累積；更早的只是挑選的對照日，不算缺漏

CAUSE_PATTERNS = [
    ("request", r"HTTPError|ConnectionError|ConnectTimeout|ReadTimeout|Timeout|timed out|Max retries|SSLError|RemoteDisconnected|Connection reset|for url|FinMind .*:"),
    ("incomplete", r"不完整|incomplete|檔數明顯不足|too few|缺少"),
    ("format", r"KeyError|IndexError|JSONDecodeError|格式|ValueError|TypeError|AttributeError|schema"),
]


def classify(text: str) -> str:
    """腳本錯誤輸出 → 原因種類。認不出來就是 script。"""
    for kind, pat in CAUSE_PATTERNS:
        if re.search(pat, text or ""):
            return kind
    return "script"


def is_weekday(d: date) -> bool:
    return d.weekday() < 5


def pending_days(after: str, now: datetime, ready: str) -> list[str]:
    """after 之後、到 now 為止，已經過了公布時間的平日。"""
    now = now.astimezone(TPE)
    hh, mm = map(int, ready.split(":"))
    d = date.fromisoformat(after) + timedelta(days=1)
    out = []
    while d <= now.date():
        if is_weekday(d) and now >= datetime(d.year, d.month, d.day, hh, mm, tzinfo=TPE):
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out


def evaluate(latest: dict, now: datetime, steps: dict | None = None, prev: dict | None = None,
             intraday_days: list[str] | None = None, calendar: list[str] | None = None) -> dict:
    """latest：{來源 key: 最新資料日期}。steps：{腳本檔名: {exit, cause, msg}}（這次排程的執行結果，可省略）。
    prev：上一份狀態檔（保留各來源「第一次看到這個日期」的時間與已知缺漏）；沒有上一份時不知道是什麼時候取得的，seen 留空。
    calendar：已知交易日（任何來源有資料的日子）；intraday_days：盤中統計滾動保留的日子。"""
    steps, prev = steps or {}, prev or {}
    prev_rows = {r["key"]: r for r in prev.get("rows", [])}
    have = [v for v in latest.values() if v]
    ref = max(have) if have else None
    cal = sorted(set(calendar or []) | set(have))
    stamp = now.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    rows = []
    for s in SOURCES:
        last = latest.get(s["key"])
        step = steps.get(s["script"]) or {}
        hh, mm = map(int, s["ready"].split(":"))

        def hours_since_ready(d: str) -> float:
            x = date.fromisoformat(d)
            return (now.astimezone(TPE) - datetime(x.year, x.month, x.day, hh, mm, tzinfo=TPE)).total_seconds() / 3600
        # 別的來源已經有、而且已經過了這個來源公布時間的交易日，才算這個來源落後
        missing = [d for d in cal if last and d > last and hours_since_ready(d) >= 0]
        lag = len(missing) if last else None
        pend = pending_days(ref, now, s["ready"]) if ref else []
        failed = bool(step) and step.get("exit", 0) != 0
        cause = None
        if not last:
            state, cause = "failed", "format"
        elif lag:
            # 只差最新一天、而且離公布時間不到 20 小時：排程可能還沒跑到，先算等待
            fresh = lag == 1 and hours_since_ready(missing[-1]) < 20 and not step
            state = "failed" if failed else "waiting" if fresh else "behind"
            cause = step.get("cause", "script") if failed else None if fresh else "source"
        elif not pend:
            state = "ok"
        elif failed:
            state, cause = "failed", step.get("cause", "script")
        else:
            state = "waiting" if len(pend) == 1 and hours_since_ready(pend[-1]) < 20 else "closed"
        p0 = prev_rows.get(s["key"], {})
        row = dict(key=s["key"], name=s["name"], src=s["src"], cadence=s["cadence"], backfill=s["backfill"],
                   latest=last, expected=ref, lag=lag or 0, pending=pend, state=state, cause=cause,
                   seen=(p0.get("seen") if p0.get("latest") == last else stamp) if prev_rows else None,
                   note=s.get("note"), msg=(step.get("msg") or None) if failed else None, gaps=[])
        # 嚴重度：不可回補的來源落後就要馬上處理；可回補的來源超過各自的正常落後才算。
        row["alert"] = state == "failed" or (state == "behind" and (not s["backfill"] or row["lag"] > s["grace"])) \
            or (state == "closed" and len(pend) >= 3)
        rows.append(row)
    # 盤中統計的缺漏：滾動保留區間內、其他來源有交易、這裡沒有的日子。已記錄過的缺漏永久保留。
    ir = next(r for r in rows if r["key"] == "intraday")
    old = set(prev_rows.get("intraday", {}).get("gaps", []))
    if intraday_days:
        got = set(intraday_days)
        lo, hi = min(intraday_days), max(intraday_days)
        old |= {d for d in cal if max(lo, TRACK_FROM) < d < hi and d not in got}
        old -= got
    old = {d for d in old if d >= TRACK_FROM}
    ir["gaps"] = sorted(old)
    alerts = [dict(key=r["key"], name=r["name"], state=r["state"], cause=r["cause"], latest=r["latest"],
                   expected=r["expected"], lag=r["lag"], backfill=r["backfill"], msg=r["msg"]) for r in rows if r["alert"]]
    return dict(generated=stamp, expected=ref, rows=rows, alerts=alerts)


def signature(alerts: list[dict]) -> str:
    """同一組問題的指紋：一樣就不重複通知。"""
    return "|".join(sorted(f"{a['key']}:{a['state']}:{a.get('cause') or ''}:{a.get('latest') or ''}" for a in alerts))
