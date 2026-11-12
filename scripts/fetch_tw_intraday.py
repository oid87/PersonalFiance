"""盤中歷史回放資料（#tab=breadthwarn）。
每天收盤後抓證交所公布的「每 5 秒委託成交統計」(MI_5MINS)，縮成每分鐘序列，寫進 data/tw_intraday.json：
days{日期: {bq, sq, tq, tv, vb, bb, cb, sum, tf}}，欄位定義見 scripts/_tw_intraday.py。
授權（2026-11-12 查證）：只走政府資料開放平臺登錄的官方下載點（資料集 11671，政府資料開放授權條款第 1 版，
可改作與公開傳輸，須顯名標示）。這個下載點只給最新一個交易日，漏掉的日子不回補，也不改用網站的指定日期查詢。
「每 5 秒指數」沒有開放資料授權（證交所網站條款未經同意禁止自動下載與轉載），2026-11-12 起不抓、公開檔也不含指數序列。
時間戳：行情時間＝每分鐘序列的位置（09:00–13:30）；取得時間＝days[日].tf（UTC）；可用時間＝交易所收盤後公布。
doc.kind 固定是 "post_close"，頁面只能稱為盤中歷史回放。
只保留最近 KEEP 個交易日與 pinned（歷史危機日）。已存在的日子不重抓、不覆蓋。抓不到或資料不完整就保留舊檔。
TWII.json 只用來知道交易日順序（算前 5–20 日基準用），不拿來算盤中指數。
"""
from __future__ import annotations

import csv
import io
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

import _common
import _tw_intraday as ti

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "tw_intraday.json"
TWII = ROOT / "data" / "TWII.json"
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)"}
URL = {"m5": "https://www.twse.com.tw/exchangeReport/MI_5MINS?response=open_data"}
ATTRIBUTION = "金融監督管理委員會證券期貨局／臺灣證券交易所 2026「盤後資訊 > 每5秒委託成交統計」，此開放資料依政府資料開放授權條款 (Open Government Data License) 進行公眾釋出，https://data.gov.tw/license"
KEEP = 40          # 滾動保留的交易日數
BACKFILL = 1       # 開放資料下載點只給最新一天，所以只補最新的交易日
GAP = 3.0          # 證交所限速：單線、間隔 3 秒
KIND = "post_close"   # 資料分類：盤後公布（不是即時、也不是延遲行情）
CLOSE_UTC = "05:30:00"  # 13:30 臺北時間


def after_close(day: str, now: datetime) -> bool:
    """now（UTC）是不是已經過了 day 當天 13:30（臺北）。還沒收盤的日子不能寫成回放資料。"""
    return now.strftime("%Y-%m-%dT%H:%M:%S") >= f"{day}T{CLOSE_UTC}"


SOURCE = "臺灣證券交易所盤後資訊：每 5 秒委託成交統計（收盤後公布；政府資料開放平臺資料集 11671）"


def parse_open_data(text: str, disposition: str, day: str) -> list:
    """開放資料 CSV → [[時間, 7 欄…]…]。檔名裡的日期（MI_5MINS_YYYYMMDD.csv）不是要的那一天就回空：
    這個下載點只給最新一天，日期對不上代表交易所還沒換檔或那一天已經過了，不能把別天的資料寫進去。"""
    m = re.search(r"MI_5MINS_(\d{8})", disposition or "")
    if not m or m.group(1) != day.replace("-", ""):
        return []
    rows = [r for r in csv.reader(io.StringIO(text.lstrip("\ufeff"))) if r and r[0].strip().isdigit()]
    return rows


def get(kind: str, day: str) -> list:
    if kind != "m5":
        raise ValueError(f"不支援的資料種類：{kind}（每 5 秒指數沒有開放授權，不抓）")

    def call():
        r = requests.get(URL["m5"], headers=UA, timeout=60)
        r.raise_for_status()
        return parse_open_data(r.content.decode("utf-8", "replace"), r.headers.get("content-disposition", ""), day)
    rows = _common.retry_call(call, attempts=3, backoff=10)
    time.sleep(GAP)
    return rows


def add_baselines(days: dict, order: list[str], d: str) -> None:
    i = order.index(d)
    prior = [ti.with_cimb(days[x]) for x in order[max(0, i - 20):i] if x in days and "bq" in days[x]]
    for key, name in (("tv", "vb"), ("bq", "bb"), ("cimb", "cb")):
        v = ti.baseline(prior, key)
        if v:
            days[d][name] = v


def merge(doc: dict, tw_rows: list[dict], fetch=get, limit: int = BACKFILL, now: datetime | None = None) -> list[str]:
    """把 TWII.json 有、檔案裡沒有的最近幾個交易日補進 doc（原地修改）。回傳新增的日期。"""
    days = doc.setdefault("days", {})
    order = [r["date"] for r in tw_rows]
    added = []
    now = now or datetime.now(timezone.utc)
    for d in [x for x in order[-limit:] if x not in days]:
        if not after_close(d, now):
            print(f"  {d}: 還沒收盤，不抓")
            continue
        day = ti.build_day(fetch("m5", d))
        if not day:
            print(f"  {d}: 資料不完整，略過")
            continue
        days[d] = day
        add_baselines(days, order, d)
        day["sum"] = ti.summary(day)
        day["tf"] = now.strftime("%Y-%m-%dT%H:%M:%SZ")
        added.append(d)
    pinned = set(doc.get("pinned", []))
    recent = set(sorted(x for x in days if x not in pinned)[-KEEP:])
    for d in [x for x in days if x not in pinned and x not in recent]:
        del days[d]
    doc["days"] = dict(sorted(days.items()))
    return added


def main() -> None:
    if not OUT.exists():
        raise SystemExit("tw_intraday: 既有檔不存在（先跑一次性回補）")
    doc = json.loads(OUT.read_text(encoding="utf-8"))
    tw_rows = [r for r in _common.load_rows(TWII) if r.get("close")]
    added = merge(doc, tw_rows)
    if not added:
        print("tw_intraday: 沒有新的交易日")
        return
    doc.update(updated=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), ver=ti.VERSION, source=SOURCE, kind=KIND, attribution=ATTRIBUTION)
    OUT.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    print(f"tw_intraday: +{added} → {len(doc['days'])} 天")


if __name__ == "__main__":
    main()
