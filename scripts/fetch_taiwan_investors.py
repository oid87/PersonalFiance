"""Fetch 外資（不含自營）大盤買賣超 — 流動性 tab「外資累計」線.

Source: FinMind TaiwanStockTotalInstitutionalInvestors (market-wide, no data_id, 2004-04起).
  同一 API 回傳多個 name 分類 (Foreign_Investor / Investment_Trust / Dealer_self /
  Dealer_Hedging / Foreign_Dealer_Self / total)；本腳本只取 name=='Foreign_Investor'
  這列 (即市場一般認知的「外資買賣超」，不含外資自營商 Foreign_Dealer_Self)。
  同一 dataset 的 name=='total' 列已由 ../../Financial_work/fetch_tw_institutional_total.py
  取用 (三大法人合計)；兩者是同一支 API 的不同列，不重複抓價。

token: env FINMIND_TOKEN → repo .finmind_token → ../Financial_work/.finmind_token → 匿名.
Output: data/taiwan_investors.json -> {source, note, updated, data:[{date, foreign, foreign_cum}]}
  foreign=當日外資買賣超(億元); foreign_cum=自 2004-04 起累計(億元，僅供參考，
  liquidity.js 圖表本身用視窗內重新歸零的 rebaseCumulative，不吃這欄)。
"""
from __future__ import annotations

import json
import os
from datetime import date, timedelta
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "taiwan_investors.json"
API = "https://api.finmindtrade.com/api/v4/data"
START = "2004-01-01"


def get_token() -> str:
    tok = os.environ.get("FINMIND_TOKEN", "").strip()
    if tok:
        return tok
    for p in (ROOT / ".finmind_token", ROOT.parent / "Financial_work" / ".finmind_token"):
        if p.exists():
            return p.read_text().strip()
    return ""


def load_existing() -> list[dict]:
    if not OUT.exists():
        return []
    try:
        return json.loads(OUT.read_text()).get("data", [])
    except Exception:
        return []


def fetch(start: str, token: str) -> list[dict]:
    params = {
        "dataset": "TaiwanStockTotalInstitutionalInvestors",
        "start_date": start,
        "end_date": date.today().isoformat(),
    }
    if token:
        params["token"] = token
    r = requests.get(API, params=params, timeout=60)
    r.raise_for_status()
    payload = r.json()
    if payload.get("status") != 200:
        raise RuntimeError(f"FinMind status={payload.get('status')} msg={payload.get('msg')}")
    return payload.get("data", [])


def aggregate(rows: list[dict]) -> dict[str, dict]:
    by_date: dict[str, dict] = {}
    for row in rows:
        if row.get("name") != "Foreign_Investor":
            continue
        d = row["date"]
        buy, sell = row.get("buy"), row.get("sell")
        if buy is None or sell is None:
            continue
        by_date[d] = {"date": d, "foreign": round((buy - sell) / 1e8, 2)}
    return by_date


def main() -> None:
    token = get_token()
    print(f"FinMind token: {'env/file' if token else 'ANONYMOUS'}")
    existing = load_existing()
    by_date = {r["date"]: {"date": r["date"], "foreign": r["foreign"]} for r in existing}
    print(f"Loaded {len(existing)} existing rows")

    start = START if not existing else (date.fromisoformat(existing[-1]["date"]) - timedelta(days=40)).isoformat()
    try:
        raw = fetch(start, token)
    except Exception as exc:
        if existing:
            print(f"Fetch failed ({exc}); keeping existing file")
            return
        raise
    new_by_date = aggregate(raw)
    by_date.update(new_by_date)
    print(f"  fetched {len(raw)} rows from {start} ({len(new_by_date)} Foreign_Investor rows)")

    data = sorted(by_date.values(), key=lambda r: r["date"])
    if not data:
        raise SystemExit("No foreign investor data")

    acc = 0.0
    for r in data:
        acc += r["foreign"]
        r["foreign_cum"] = round(acc, 2)

    OUT.write_text(json.dumps({
        "source": "FinMind TaiwanStockTotalInstitutionalInvestors (name=='Foreign_Investor')",
        "note": "foreign=外資買賣超(億元,不含外資自營商); foreign_cum=自 2004 起累計(億元,參考用).",
        "updated": date.today().isoformat(),
        "data": data,
    }, ensure_ascii=False) + "\n")
    print(f"Wrote {len(data)} rows -> {OUT.name} ({data[0]['date']}..{data[-1]['date']})")


if __name__ == "__main__":
    main()
