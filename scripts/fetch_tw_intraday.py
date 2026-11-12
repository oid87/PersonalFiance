"""盤中去槓桿壓力監測的「盤後回放」資料（#tab=breadthwarn）。
每天收盤後抓證交所公布的「每 5 秒委託成交統計」(MI_5MINS) 與「每 5 秒指數」(MI_5MINS_INDEX)，
縮成每分鐘序列，寫進 data/tw_intraday.json：days{日期: {r, bq, sq, tq, tv, vb, bb, cb, sum}}，欄位定義見 scripts/_tw_intraday.py。
這是收盤後才公布的官方統計，不是即時行情；MI_5MINS 同時列在政府資料開放平臺（openapi.twse.com.tw）。
只保留最近 KEEP 個交易日與 pinned（歷史危機日，由一次性回補寫入）。已存在的日子不重抓、不覆蓋。
對帳：每分鐘指數的最後一筆換算成收盤，和 TWII.json 的官方收盤比，差距寫在 sum.recon（%）。
抓不到或資料不完整就保留舊檔。
"""
from __future__ import annotations

import json
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
URL = {"m5": "https://www.twse.com.tw/rwd/zh/afterTrading/MI_5MINS", "m5i": "https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_INDEX"}
KEEP = 40          # 滾動保留的交易日數
BACKFILL = 5       # 每次最多回頭補幾天
GAP = 3.0          # 證交所限速：單線、間隔 3 秒
SOURCE = "臺灣證券交易所盤後資訊：每 5 秒委託成交統計、每 5 秒指數（收盤後公布）"


def get(kind: str, day: str) -> list:
    def call():
        j = requests.get(URL[kind], params={"date": day.replace("-", ""), "response": "json"}, headers=UA, timeout=60).json()
        if j.get("stat") != "OK" or j.get("date") not in (None, day.replace("-", "")):
            return []
        return j.get("data") or []
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


def merge(doc: dict, tw_rows: list[dict], fetch=get, limit: int = BACKFILL) -> list[str]:
    """把 TWII.json 有、檔案裡沒有的最近幾個交易日補進 doc（原地修改）。回傳新增的日期。"""
    days = doc.setdefault("days", {})
    order = [r["date"] for r in tw_rows]
    close = {r["date"]: r.get("close") for r in tw_rows}
    added = []
    for d in [x for x in order[-limit:] if x not in days]:
        i = order.index(d)
        if i == 0 or not close.get(order[i - 1]):
            continue
        day = ti.build_day(fetch("m5", d), fetch("m5i", d), close[order[i - 1]])
        if not day:
            print(f"  {d}: 資料不完整，略過")
            continue
        days[d] = day
        add_baselines(days, order, d)
        s = ti.summary(day)
        if close.get(d) and s.get("close") is not None:
            s["recon"] = round(s["close"] - (close[d] / close[order[i - 1]] - 1) * 100, 2)
        day["sum"] = s
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
    doc.update(updated=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), ver=ti.VERSION, source=SOURCE)
    OUT.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    print(f"tw_intraday: +{added} → {len(doc['days'])} 天")


if __name__ == "__main__":
    main()
