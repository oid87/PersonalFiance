"""Reconstruct 台股大盤融資維持率 (market margin-maintenance ratio) from free TWSE data.

維持率% = Σ(個股融資今日餘額張 × 收盤 × 1000) ÷ 融資餘額金額 × 100
  分子 擔保品市值 : TWSE MI_MARGN 逐檔「融資今日餘額(張)」 × MI_INDEX 逐檔「收盤」
  分母 融資餘額   : TWSE MI_MARGN 市場彙總「融資金額(仟元)」今日餘額 × 1000

全部免費、純 TWSE（上市），無需 token。FinMind 逐檔為付費級，本腳本繞開它；
分子分母同源於 MI_MARGN（逐檔張 + 彙總金額）＋ MI_INDEX（收盤），無跨源日期對齊問題。

NOTE: 重建值 = 融資擔保品市值/融資餘額金額，與券商「整戶維持率」(含融券/現金/T+2) 定義略異，
      水位可能偏高，但趨勢一致 —— 急漲擴張、崩盤壓縮，作為槓桿風險溫度計。已知限制見
      [[reference_data_traps]]。逐檔張數加總已對 FinMind 總量驗證相等。

回補很重（每交易日 2 個 TWSE request）。每次抓「尚缺的交易日」，newest-first，每回上限
MARGIN_RATIO_MAX_DAYS（env，預設 30 → CI 輕量增量；回補時設超大值），禮貌間隔 + 重試，
idempotent 合併 → 可重跑/續傳。
Output: data/taiwan_margin_ratio.json
        {source, note, updated, data:[{date, ratio, collateral_yi, margin_yi, n}]}
"""
from __future__ import annotations

import json
import os
import time
from datetime import date, timedelta
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "taiwan_margin_ratio.json"
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)"}
MARGN = "https://www.twse.com.tw/exchangeReport/MI_MARGN"
MINDEX = "https://www.twse.com.tw/exchangeReport/MI_INDEX"
FLOOR = os.environ.get("MARGIN_RATIO_FLOOR", "2010-01-01")  # TWSE JSON reliably available from here
MAX_DAYS = int(os.environ.get("MARGIN_RATIO_MAX_DAYS", "30"))
SLEEP = float(os.environ.get("MARGIN_RATIO_SLEEP", "0.8"))


def num(s):
    try:
        return float(str(s).replace(",", "").replace(" ", ""))
    except Exception:
        return None


def get_json(url, params, tries=3):
    for i in range(tries):
        try:
            r = requests.get(url, params=params, headers=UA, timeout=45)
            if r.status_code == 200:
                return r.json()
            if r.status_code in (429, 503):  # throttled — back off
                time.sleep(2 + 3 * i)
                continue
        except Exception:
            time.sleep(1 + 2 * i)
    return None


def fetch_day(d_iso):
    """(ratio, collateral_yi, margin_yi, n) for a trading day, or None if no usable data."""
    ymd = d_iso.replace("-", "")
    mg = get_json(MARGN, {"response": "json", "date": ymd, "selectType": "ALL"})
    if not mg or mg.get("stat") != "OK" or not mg.get("tables"):
        return None
    # 逐檔「融資今日餘額(張)」: the largest table, code=idx0, 融資今日餘額=idx6
    rows = max(mg["tables"], key=lambda t: len(t.get("data", [])))["data"]
    lots = {}
    for r in rows:
        v = num(r[6]) if len(r) > 6 else None
        if v is not None and r[0]:
            lots[r[0]] = v
    if not lots:
        return None
    # 分母: 市場彙總「融資金額(仟元)」今日餘額(最後一欄)
    margin_money = None
    for t in mg["tables"]:
        for r in t.get("data", []):
            if r and "融資金額" in str(r[0]):
                margin_money = num(r[-1])
                break
        if margin_money:
            break
    if not margin_money:
        return None
    den = margin_money * 1000.0  # 仟元 → 元

    px = get_json(MINDEX, {"response": "json", "date": ymd, "type": "ALLBUT0999"})
    if not px or px.get("stat") != "OK":
        return None
    closes = {}
    for t in px.get("tables", []):
        f = t.get("fields", [])
        ci = [i for i, x in enumerate(f) if "代號" in str(x)]
        pi = [i for i, x in enumerate(f) if "收盤" in str(x)]
        if ci and pi:
            for r in t["data"]:
                v = num(r[pi[0]])
                if v is not None:
                    closes[r[ci[0]]] = v
    if not closes:
        return None

    matched = [c for c in lots if c in closes and closes[c]]
    if len(matched) < 0.5 * len(lots):  # coverage guard — partial price table → skip
        return None
    collateral = sum(lots[c] * closes[c] * 1000.0 for c in matched)
    return (round(collateral / den * 100, 2), round(collateral / 1e8, 1),
            round(den / 1e8, 1), len(matched))


def missing_trading_days(have):
    """Weekdays in [FLOOR, today] not already fetched, newest-first."""
    out, d, floor = [], date.today(), date.fromisoformat(FLOOR)
    while d >= floor:
        if d.weekday() < 5 and d.isoformat() not in have:
            out.append(d.isoformat())
        d -= timedelta(days=1)
    return out


def save(by_date):
    data = sorted(by_date.values(), key=lambda r: r["date"])
    OUT.write_text(json.dumps({
        "source": "TWSE MI_MARGN(逐檔融資張+融資金額) × MI_INDEX(收盤) — 重建大盤融資維持率",
        "note": ("ratio=融資維持率%=Σ(融資張×收盤×1000)/融資餘額金額; collateral_yi/margin_yi=億元; "
                 "n=配對檔數. 上市only; 與券商整戶維持率定義略異(偏高)但趨勢一致."),
        "updated": date.today().isoformat(),
        "data": data,
    }, ensure_ascii=False) + "\n")


def main():
    by_date = {}
    if OUT.exists():
        try:
            by_date = {r["date"]: r for r in json.loads(OUT.read_text()).get("data", [])}
        except Exception:
            by_date = {}
    todo = missing_trading_days(set(by_date))[:MAX_DAYS]
    print(f"{len(by_date)} existing · {len(todo)} days to fetch (newest-first, cap {MAX_DAYS}, floor {FLOOR})")

    done = skipped = 0
    for d in todo:
        res = fetch_day(d)
        if res:
            ratio, coll, marg, n = res
            by_date[d] = {"date": d, "ratio": ratio, "collateral_yi": coll, "margin_yi": marg, "n": n}
            done += 1
            if done % 20 == 0:
                save(by_date)
                print(f"  ...{done} fetched · latest {d} ratio={ratio}% (saved)")
        else:
            skipped += 1
        time.sleep(SLEEP)

    save(by_date)
    data = sorted(by_date.values(), key=lambda r: r["date"])
    if data:
        print(f"Wrote {len(data)} rows ({data[0]['date']}..{data[-1]['date']}); "
              f"+{done} new, {skipped} skipped(no-data/holiday) this run")


if __name__ == "__main__":
    main()
