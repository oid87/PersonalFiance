"""台股當日沖銷(當沖)交易占比 → data/tw_daytrading.json

Source: TWSE exchangeReport/TWTB4U (當日沖銷交易統計資訊, exchangeReport 路徑;
  rwd 路徑 2026-07-09 實測回空，故不用)。
  https://www.twse.com.tw/exchangeReport/TWTB4U?response=json&date=YYYYMMDD&selectType=All

  實測 fields (「當日沖銷交易統計資訊」表):
    當日沖銷交易總成交股數
    當日沖銷交易總成交股數占市場比重%          -> shares_ratio (必存)
    當日沖銷交易總買進成交金額                  -> amount (元)
    當日沖銷交易總買進成交金額占市場比重%        -> amount_ratio
    當日沖銷交易總賣出成交金額
    當日沖銷交易總賣出成交金額占市場比重%
  買/賣金額與占比幾乎相等(當沖同日買賣同股數，僅盤中價差微幅不同)；本檔僅存「買進」
  side 作為 amount/amount_ratio 代表值(spec 未指定買賣擇一，此為本次實作決策)。
  假日/無資料日：TWSE 仍回 stat=OK，但只有「當日沖銷交易標的」table(3 欄, data=[])、
  無 6 欄的統計資訊 table —— 判定為 skip_date，記錄避免重複打。

回補起點 2021-01-01（5年內夠用，2014-2020 不補，已知取捨）。newest-first resumable：
  單次執行上限 120 個交易日，sleep 3 秒（TWSE 反爬蟲禮貌間隔，同 fetch_taiwan_margin_ratio.py
  先例）。CI 每日跑，幾週內自然補齊全部歷史。

Output data/tw_daytrading.json:
  {source, updated, skip_dates, data: [{date, shares_ratio, amount, amount_ratio}]}
  date 升冪。
"""
from __future__ import annotations

import json
import time
from datetime import date, timedelta
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "tw_daytrading.json"
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) PersonalFiance/1.0"}
URL = "https://www.twse.com.tw/exchangeReport/TWTB4U"
START = "2021-01-01"
MAX_DAYS = 120
SLEEP = 3.0
STAT_FIELD_COUNT = 6
STAT_FIELD_HINT = "當日沖銷交易總成交股數"


def num(s):
    try:
        return float(str(s).replace(",", "").replace(" ", ""))
    except Exception:
        return None


def fetch_day(d_iso: str):
    """Return dict {shares_ratio, amount, amount_ratio} or None (holiday/no-data)."""
    ymd = d_iso.replace("-", "")
    r = requests.get(URL, params={"response": "json", "date": ymd, "selectType": "All"},
                      headers=UA, timeout=45)
    r.raise_for_status()
    payload = r.json()
    if payload.get("stat") != "OK":
        return None
    stat_table = None
    for t in payload.get("tables", []):
        fields = t.get("fields") or []
        if len(fields) == STAT_FIELD_COUNT and fields[0] == STAT_FIELD_HINT:
            stat_table = t
            break
    if not stat_table or not stat_table.get("data"):
        return None
    row = stat_table["data"][0]
    shares_ratio = num(row[1])
    amount = num(row[2])
    amount_ratio = num(row[3])
    if shares_ratio is None:
        return None
    out = {"shares_ratio": shares_ratio}
    if amount is not None:
        out["amount"] = amount
    if amount_ratio is not None:
        out["amount_ratio"] = amount_ratio
    return out


def missing_trading_days(have: set, skip: set):
    """Weekdays in [START, today] not already fetched/skipped, newest-first."""
    out, d, floor = [], date.today(), date.fromisoformat(START)
    while d >= floor:
        iso = d.isoformat()
        if d.weekday() < 5 and iso not in have and iso not in skip:
            out.append(iso)
        d -= timedelta(days=1)
    return out


def load_existing():
    if not OUT.exists():
        return {}, []
    try:
        payload = json.loads(OUT.read_text())
        by_date = {r["date"]: r for r in payload.get("data", []) if r.get("date")}
        skip_dates = list(payload.get("skip_dates", []))
        return by_date, skip_dates
    except Exception:
        return {}, []


def save(by_date: dict, skip_dates: list):
    data = sorted(by_date.values(), key=lambda r: r["date"])
    OUT.write_text(json.dumps({
        "source": "TWSE exchangeReport/TWTB4U (當日沖銷交易統計資訊)",
        "updated": date.today().isoformat(),
        "skip_dates": sorted(set(skip_dates)),
        "data": data,
    }, ensure_ascii=False) + "\n")


def main():
    by_date, skip_dates = load_existing()
    skip_set = set(skip_dates)
    print(f"{len(by_date)} existing rows · {len(skip_set)} skip_dates")

    todo = missing_trading_days(set(by_date), skip_set)[:MAX_DAYS]
    print(f"{len(todo)} days to fetch this run (newest-first, cap {MAX_DAYS}, floor {START})")

    done = skipped = failed = 0
    for i, d in enumerate(todo):
        try:
            res = fetch_day(d)
        except Exception as exc:
            print(f"  [tw_daytrading] {d} request FAILED (transient, not skip_dates): {exc}")
            failed += 1
            time.sleep(SLEEP)
            continue
        if res:
            res["date"] = d
            by_date[d] = res
            done += 1
        else:
            skip_set.add(d)
            skipped += 1
        if (i + 1) % 20 == 0:
            save(by_date, list(skip_set))
            print(f"  ...{i + 1}/{len(todo)} processed · latest {d} (saved)")
        time.sleep(SLEEP)

    save(by_date, list(skip_set))
    data = sorted(by_date.values(), key=lambda r: r["date"])
    if data:
        print(f"Wrote {len(data)} rows ({data[0]['date']}..{data[-1]['date']}); "
              f"+{done} new, {skipped} skip(holiday/no-data), {failed} transient-fail this run; "
              f"{len(skip_set)} total skip_dates")
    else:
        print("No data written (no rows fetched)")


if __name__ == "__main__":
    main()
