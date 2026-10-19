"""Backfill 大盤融資餘額 2001-01-03 ~ 2007-12-31 (static, manual research source).

Source: FinMind TaiwanStockTotalMarginPurchaseShortSale（同 fetch_taiwan_margin_total.py，
該腳本的 START=2008-01-01；FinMind 本身自 2001 年起有資料）。
  name=MarginPurchaseMoney -> 融資餘額金額 (元) → margin_money 億元
  name=MarginPurchase      -> 融資餘額張數 (張)
  name=ShortSale           -> 融券餘額張數 (張)

這是歷史補遺：2007 年以前的資料不會再變，所以獨立成檔、不進 CI 排程（routes 為空），
不動 data/taiwan_margin_total.json，也就不影響其他讀取該檔的頁面與計算。
讀取端（融資去槓桿警報頁、壓力推估 CLI）把兩個檔以日期合併，主檔優先。

交叉核對：與 data/taiwan_margin_ratio_mm.json 的 margin_yi（TWSE MI_MARGN 彙總，2004-02-11 起）
逐日比對，差異 > 1 億者逐筆列出（預期 0 筆）。

用法: python scripts/fetch_taiwan_margin_early.py
token: env FINMIND_TOKEN → repo .finmind_token → 匿名.
Output: data/taiwan_margin_total_early.json -> {source, note, updated, data:[{date, margin_money, margin_lots, short_lots}]}
"""
from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import requests

from _common import get_finmind_token as get_token

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "taiwan_margin_total_early.json"
MM = ROOT / "data" / "taiwan_margin_ratio_mm.json"
API = "https://api.finmindtrade.com/api/v4/data"
START = "2001-01-01"
END = "2007-12-31"


def fetch(token: str) -> list[dict]:
    params = {
        "dataset": "TaiwanStockTotalMarginPurchaseShortSale",
        "start_date": START,
        "end_date": END,
    }
    if token:
        params["token"] = token
    r = requests.get(API, params=params, timeout=90)
    r.raise_for_status()
    payload = r.json()
    if payload.get("status") != 200:
        raise RuntimeError(f"FinMind status={payload.get('status')} msg={payload.get('msg')}")
    return payload.get("data", [])


def aggregate(rows: list[dict]) -> dict[str, dict]:
    by_date: dict[str, dict] = {}
    for row in rows:
        d = row["date"]
        rec = by_date.setdefault(d, {"date": d, "margin_money": None, "margin_lots": None, "short_lots": None})
        bal = row.get("TodayBalance")
        name = row.get("name", "")
        if name == "MarginPurchaseMoney" and bal is not None:
            rec["margin_money"] = round(bal / 1e8, 1)   # 元 -> 億元
        elif name == "MarginPurchase" and bal is not None:
            rec["margin_lots"] = int(bal)
        elif name == "ShortSale" and bal is not None:
            rec["short_lots"] = int(bal)
    return by_date


def cross_check(data: list[dict]) -> tuple[int, list[tuple[str, float, float]]]:
    if not MM.exists():
        return 0, []
    mm = {r["date"]: r["margin_yi"] for r in json.loads(MM.read_text()).get("data", []) if r.get("margin_yi") is not None}
    compared, bad = 0, []
    for r in data:
        if r["date"] in mm:
            compared += 1
            if abs(r["margin_money"] - mm[r["date"]]) > 1:
                bad.append((r["date"], r["margin_money"], mm[r["date"]]))
    return compared, bad


def main() -> None:
    token = get_token()
    print(f"FinMind token: {'env/file' if token else 'ANONYMOUS'}")
    by_date = aggregate(fetch(token))
    data = sorted((r for r in by_date.values() if r.get("margin_money") is not None and START <= r["date"] <= END),
                  key=lambda r: r["date"])
    if not data:
        raise SystemExit("No early margin data")
    compared, bad = cross_check(data)
    print(f"cross-check vs TWSE margin_yi: {compared} days compared, {len(bad)} differ by >1 億")
    for d, a, b in bad[:20]:
        print(f"  {d}: FinMind {a} vs TWSE {b}")
    OUT.write_text(json.dumps({
        "source": "FinMind TaiwanStockTotalMarginPurchaseShortSale (大盤融資餘額/融券，2001-2007 歷史補遺)",
        "note": f"margin_money=大盤融資餘額(億元); {data[0]['date']}~{data[-1]['date']} 靜態補遺，與 taiwan_margin_total.json（2008-01-02 起）以日期合併。",
        "updated": date.today().isoformat(),
        "data": data,
    }, ensure_ascii=False) + "\n")
    print(f"Wrote {len(data)} rows -> {OUT.name} ({data[0]['date']}..{data[-1]['date']})")


if __name__ == "__main__":
    main()
