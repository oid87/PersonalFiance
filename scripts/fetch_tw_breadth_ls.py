"""台股上市「多空家數」近似版（非旺財紫線原版）→ data/tw_breadth_ls.json

逐檔判斷（TWSE MI_INDEX 每日收盤，僅普通股 4 碼代號，免 token）：
  偏多 = 收盤 > MA20 且 MA20 > MA60
  偏空 = 收盤 < MA20 且 MA20 < MA60
  其餘為中性。MA 以原始（未還原）收盤價計算，除權息缺口會造成少量雜訊。
  需連續 60 個交易日皆有收盤才納入該日該檔判斷。

MA60 需前 60 日收盤，故保留滾動收盤快取 data/tw_breadth_closes.json（最近 CACHE_DAYS 個交易日），
每日增量：抓缺的平日 → 更新快取 → 當日家數寫入輸出。首次 backfill 設 TW_BREADTH_MAX_DAYS 很大。

Output data/tw_breadth_ls.json:
  {source, note, updated, data:[{date, bull, bear, neutral, n}]}
"""
from __future__ import annotations

import json
import os
import re
import time
from datetime import date, timedelta
from pathlib import Path

import requests

import _common

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "tw_breadth_ls.json"
CACHE = ROOT / "data" / "tw_breadth_closes.json"
MINDEX = "https://www.twse.com.tw/exchangeReport/MI_INDEX"
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)"}
FLOOR = os.environ.get("TW_BREADTH_FLOOR", "2024-01-01")
MAX_DAYS = int(os.environ.get("TW_BREADTH_MAX_DAYS", "30"))
SLEEP = float(os.environ.get("TW_BREADTH_SLEEP", "0.8"))
CACHE_DAYS = 65
MA_SHORT, MA_LONG = 20, 60
MIN_STOCKS = 800  # 當日有效收盤檔數下限；低於視為殘缺表
CODE_RE = re.compile(r"^[1-9]\d{3}$")


def num(s):
    try:
        return float(str(s).replace(",", "").strip())
    except Exception:
        return None


def get_json(params, tries=3):
    for i in range(tries):
        try:
            r = requests.get(MINDEX, params=params, headers=UA, timeout=45)
            if r.status_code == 200:
                return r.json()
            if r.status_code in (429, 503):
                time.sleep(2 + 3 * i)
                continue
        except Exception:
            time.sleep(1 + 2 * i)
    return None


def fetch_closes(d_iso: str):
    px = get_json({"response": "json", "date": d_iso.replace("-", ""), "type": "ALLBUT0999"})
    if not px or px.get("stat") != "OK":
        return None
    closes = {}
    for t in px.get("tables", []):
        f = t.get("fields", [])
        ci = [i for i, x in enumerate(f) if "代號" in str(x)]
        pi = [i for i, x in enumerate(f) if "收盤" in str(x)]
        if ci and pi:
            for r in t["data"]:
                code = str(r[ci[0]]).strip()
                v = num(r[pi[0]])
                if CODE_RE.match(code) and v and v > 0:
                    closes[code] = v
    return closes if len(closes) >= MIN_STOCKS else None


def count_day(dates, closes_by_code):
    """用快取最後 MA_LONG 個日期計算家數；dates 為升序且已含當日。"""
    if len(dates) < MA_LONG:
        return None
    bull = bear = neu = 0
    for series in closes_by_code.values():
        w = series[-MA_LONG:]
        if len(w) < MA_LONG or any(v is None for v in w):
            continue
        c = w[-1]
        ma20 = sum(w[-MA_SHORT:]) / MA_SHORT
        ma60 = sum(w) / MA_LONG
        if c > ma20 > ma60:
            bull += 1
        elif c < ma20 < ma60:
            bear += 1
        else:
            neu += 1
    n = bull + bear + neu
    if n < MIN_STOCKS * 0.8:
        return None
    return {"bull": bull, "bear": bear, "neutral": neu, "n": n}


def load_cache():
    if not CACHE.exists():
        return [], {}
    try:
        c = json.loads(CACHE.read_text())
        return c.get("dates", []), c.get("closes", {})
    except Exception:
        return [], {}


def save_cache(dates, closes):
    keep = dates[-CACHE_DAYS:]
    off = len(dates) - len(keep)
    out = {}
    for code, s in closes.items():
        t = s[off:]
        if any(v is not None for v in t):
            out[code] = t
    CACHE.write_text(json.dumps({"note": "滾動收盤快取（TWSE MI_INDEX 原始收盤），供 fetch_tw_breadth_ls.py 計算 MA60",
                                 "dates": keep, "closes": out},
                                ensure_ascii=False, separators=(",", ":")) + "\n")


def save_out(rows_by_date):
    data = [rows_by_date[d] for d in sorted(rows_by_date)]
    OUT.write_text(json.dumps({
        "source": "TWSE MI_INDEX 每日收盤（上市普通股）自算",
        "note": ("近似版多空家數，非旺財紫線原版：偏多=收盤>MA20>MA60；偏空=收盤<MA20<MA60；其餘中性。"
                 "原始收盤（未還原）；n=納入判斷檔數。"),
        "updated": date.today().isoformat(),
        "data": data,
    }, ensure_ascii=False, separators=(",", ":")) + "\n")
    return data


def main():
    rows = _common.load_rows_by_date(OUT)
    dates, closes = load_cache()
    if dates:
        start = date.fromisoformat(dates[-1]) + timedelta(days=1)
    else:
        start = date.fromisoformat(FLOOR)
    todo, d = [], start
    while d <= date.today():
        if d.weekday() < 5:
            todo.append(d.isoformat())
        d += timedelta(days=1)
    todo = todo[:MAX_DAYS]
    print(f"{len(rows)} existing rows · cache {len(dates)} days · {len(todo)} days to fetch (cap {MAX_DAYS})", flush=True)

    fetched = 0
    for d_iso in todo:
        cl = fetch_closes(d_iso)
        time.sleep(SLEEP)
        if cl is None:
            continue  # 假日／殘缺表；不寫入，維持快取連續交易日
        for code in set(closes) | set(cl):
            s = closes.setdefault(code, [None] * len(dates))
            s.append(cl.get(code))
        dates.append(d_iso)
        res = count_day(dates, closes)
        if res:
            rows[d_iso] = {"date": d_iso, **res}
        fetched += 1
        if fetched % 25 == 0:
            save_cache(dates, closes)
            save_out(rows)
            print(f"  ...{fetched} days · latest {d_iso} {res}", flush=True)
    if fetched == 0 and not rows:
        raise RuntimeError("no breadth rows produced")
    save_cache(dates, closes)
    data = save_out(rows)
    if data:
        print(f"Wrote {OUT.name}: {len(data)} rows ({data[0]['date']} → {data[-1]['date']}); +{fetched} days fetched")


if __name__ == "__main__":
    main()
