"""Fetch 大盤融資餘額 / 融券 (market-wide margin balance) — 台股情緒「槓桿」元件.

Source: FinMind TaiwanStockTotalMarginPurchaseShortSale (2008-present).
  name=MarginPurchaseMoney -> 融資餘額金額 (元)   ← 大盤融資餘額
  name=MarginPurchase      -> 融資餘額張數 (張)
  name=ShortSale           -> 融券餘額張數 (張)

註：大盤「融資維持率」無乾淨免費歷史源（MacroMicro/FinLab 付費；逐檔精算 FinMind 無
   bulk 歷史），故此處只提供餘額；槓桿情緒用「融資餘額動能」近似。

token: env FINMIND_TOKEN → repo .finmind_token → 匿名.
Output: data/taiwan_margin_total.json -> {source, updated, data:[{date, margin_money, margin_lots, short_lots}]}
  margin_money 單位=億元
"""
from __future__ import annotations

import json
import os
from datetime import date, timedelta
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "taiwan_margin_total.json"
API = "https://api.finmindtrade.com/api/v4/data"
START = "2008-01-01"


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
    params = {"dataset": "TaiwanStockTotalMarginPurchaseShortSale", "start_date": start}
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


def main() -> None:
    token = get_token()
    print(f"FinMind token: {'env/file' if token else 'ANONYMOUS'}")
    existing = load_existing()
    by_date = {r["date"]: r for r in existing}
    print(f"Loaded {len(existing)} existing rows")

    start = START if not existing else (date.fromisoformat(existing[-1]["date"]) - timedelta(days=40)).isoformat()
    try:
        raw = fetch(start, token)
    except Exception as exc:
        if existing:
            print(f"Fetch failed ({exc}); keeping existing file")
            return
        raise
    by_date.update(aggregate(raw))
    print(f"  fetched {len(raw)} rows from {start}")

    data = sorted((r for r in by_date.values() if r.get("margin_money") is not None),
                  key=lambda r: r["date"])
    if not data:
        raise SystemExit("No margin data")
    OUT.write_text(json.dumps({
        "source": "FinMind TaiwanStockTotalMarginPurchaseShortSale (大盤融資餘額/融券)",
        "note": "margin_money=大盤融資餘額(億元); margin_lots/short_lots=融資/融券餘額(張). 維持率無免費歷史源, 從缺.",
        "updated": date.today().isoformat(),
        "data": data,
    }, ensure_ascii=False) + "\n")
    print(f"Wrote {len(data)} rows -> {OUT.name} ({data[0]['date']}..{data[-1]['date']})")


if __name__ == "__main__":
    main()
