"""Fetch 台股現貨外資（上市＋上櫃合計，TWSE 三大法人買賣金額統計）每日買賣超 → data/tw_foreign_net.json

Source: FinMind TaiwanStockTotalInstitutionalInvestors（2004 起；register 等級可用）。
  外資 = Foreign_Investor + Foreign_Dealer_Self（外資及陸資＋外資自營商）。
  FinMind 此資料集為市場彙總（逐日單次回傳整段區間），不是逐檔。

token: _common.get_finmind_token()（CI secret FINMIND_TOKEN／本地 .finmind_token）。

Output data/tw_foreign_net.json:
  {source, note, updated, data:[{date, foreign_net_yi, foreign_buy_yi, foreign_sell_yi,
                                   trust_net_yi, dealer_net_yi, total_net_yi}]}
  單位：億元新台幣（金額 ÷ 1e8，保留 2 位）。
"""
from __future__ import annotations

import json
from collections import OrderedDict
from datetime import date, timedelta
from pathlib import Path

import requests

import _common

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "tw_foreign_net.json"
API = "https://api.finmindtrade.com/api/v4/data"
START = "2004-01-01"
YI = 1e8
FOREIGN = {"Foreign_Investor", "Foreign_Dealer_Self"}
DEALER = {"Dealer_self", "Dealer_Hedging"}


def fetch(start: str, token: str) -> list[dict]:
    params = {"dataset": "TaiwanStockTotalInstitutionalInvestors", "start_date": start}
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    r = requests.get(API, params=params, headers=headers, timeout=90)
    r.raise_for_status()
    payload = r.json()
    if payload.get("status") != 200:
        raise RuntimeError(f"FinMind status={payload.get('status')} msg={payload.get('msg')}")
    return payload.get("data", [])


def aggregate(raw: list[dict]) -> "OrderedDict[str, dict]":
    acc: dict[str, dict] = {}
    for row in raw:
        d = row["date"]
        name = row.get("name")
        buy = float(row.get("buy") or 0)
        sell = float(row.get("sell") or 0)
        rec = acc.setdefault(d, {"fb": 0.0, "fs": 0.0, "trust": 0.0, "dealer": 0.0, "total": None})
        if name in FOREIGN:
            rec["fb"] += buy
            rec["fs"] += sell
        elif name == "Investment_Trust":
            rec["trust"] += buy - sell
        elif name in DEALER:
            rec["dealer"] += buy - sell
        elif name == "total":
            rec["total"] = buy - sell
    out: "OrderedDict[str, dict]" = OrderedDict()
    for d in sorted(acc):
        r = acc[d]
        if r["fb"] == 0 and r["fs"] == 0:  # 非交易日／無資料列
            continue
        out[d] = {
            "date": d,
            "foreign_net_yi": round((r["fb"] - r["fs"]) / YI, 2),
            "foreign_buy_yi": round(r["fb"] / YI, 2),
            "foreign_sell_yi": round(r["fs"] / YI, 2),
            "trust_net_yi": round(r["trust"] / YI, 2),
            "dealer_net_yi": round(r["dealer"] / YI, 2),
            "total_net_yi": round((r["total"] if r["total"] is not None else 0.0) / YI, 2),
        }
    return out


def main() -> None:
    token = _common.get_finmind_token()
    print(f"FinMind token: {'yes' if token else 'ANONYMOUS'}")
    existing = _common.load_rows_by_date(OUT)
    print(f"Loaded {len(existing)} existing rows")
    start = START
    if existing:
        start = (date.fromisoformat(max(existing)) - timedelta(days=30)).isoformat()
    try:
        fresh = aggregate(fetch(start, token))
    except Exception as exc:
        if existing:
            print(f"  [tw_foreign_net] FAILED ({exc}); keeping {len(existing)} existing rows")
            return
        raise
    if not fresh and not existing:
        raise RuntimeError("no rows returned")
    merged = OrderedDict(existing)
    merged.update(fresh)
    data = [merged[d] for d in sorted(merged)]
    payload = {
        "source": "FinMind TaiwanStockTotalInstitutionalInvestors（TWSE 三大法人買賣金額統計）",
        "note": "外資=Foreign_Investor+Foreign_Dealer_Self；單位億元新台幣；net=買進-賣出；市場彙總（非逐檔）。",
        "updated": date.today().isoformat(),
        "data": data,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"Wrote {OUT.name}: {len(data)} rows ({data[0]['date']} → {data[-1]['date']})")


if __name__ == "__main__":
    main()
