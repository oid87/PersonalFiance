"""Fetch TAIFEX 台指期 (TX) 三大法人未平倉，推導散戶多空 (台股情緒指標之一).

Source: FinMind TaiwanFuturesInstitutionalInvestors, data_id=TX (2018-present).
期貨市場零和：散戶淨部位 ≈ -(三大法人淨未平倉)。外資淨未平倉本身是「聰明錢」方向。

token: env FINMIND_TOKEN (CI secret) → 否則讀 repo 根目錄 .finmind_token → 否則匿名(低額度).

Output: data/taiwan_fut_inst.json
  -> {source, updated, data:[{date, foreign_net, trust_net, dealer_net, inst_net, retail_net}]}
  net = long_open_interest - short_open_interest (口數)
"""
from __future__ import annotations

import json
import os
from datetime import date, timedelta
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "taiwan_fut_inst.json"
API = "https://api.finmindtrade.com/api/v4/data"
START = "2018-01-01"


def get_token() -> str:
    tok = os.environ.get("FINMIND_TOKEN", "").strip()
    if tok:
        return tok
    for p in (ROOT / ".finmind_token", ROOT.parent / "Financial_work" / ".finmind_token"):
        if p.exists():
            return p.read_text().strip()
    return ""  # anonymous (low rate limit, may still work for a single daily call)


def load_existing() -> list[dict]:
    if not OUT.exists():
        return []
    try:
        return json.loads(OUT.read_text()).get("data", [])
    except Exception:
        return []


def fetch(start: str, token: str) -> list[dict]:
    params = {"dataset": "TaiwanFuturesInstitutionalInvestors", "data_id": "TX", "start_date": start}
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
        net = (row.get("long_open_interest_balance_volume", 0) or 0) - \
              (row.get("short_open_interest_balance_volume", 0) or 0)
        who = row.get("institutional_investors", "")
        rec = by_date.setdefault(d, {"date": d, "foreign_net": 0, "trust_net": 0, "dealer_net": 0})
        if "外資" in who:
            rec["foreign_net"] += net
        elif "投信" in who:
            rec["trust_net"] += net
        elif "自營" in who:
            rec["dealer_net"] += net
    for rec in by_date.values():
        rec["inst_net"] = rec["foreign_net"] + rec["trust_net"] + rec["dealer_net"]
        rec["retail_net"] = -rec["inst_net"]  # zero-sum proxy
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
    fresh = aggregate(raw)
    by_date.update(fresh)
    print(f"  fetched {len(raw)} institutional rows -> {len(fresh)} days from {start}")

    if not by_date:
        raise SystemExit("No futures-institutional data and no existing file")

    data = sorted(by_date.values(), key=lambda r: r["date"])
    OUT.write_text(json.dumps({
        "source": "FinMind TaiwanFuturesInstitutionalInvestors (TX 台指期三大法人未平倉)",
        "note": "net=多單未平倉-空單未平倉(口). inst_net=三大法人合計; retail_net=-(inst_net) 散戶淨多(零和近似). 外資淨=聰明錢方向.",
        "updated": date.today().isoformat(),
        "data": data,
    }, ensure_ascii=False) + "\n")
    print(f"Wrote {len(data)} rows -> {OUT.name} ({data[0]['date']}..{data[-1]['date']})")


if __name__ == "__main__":
    main()
