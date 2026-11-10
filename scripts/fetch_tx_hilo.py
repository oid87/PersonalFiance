"""台指期(TX)近月 日盤＋夜盤 合併高低點 → data/tx_hilo.json

Source: FinMind TaiwanFuturesDaily, data_id=TX（2018～）。
FinMind 的 after_market 列日期 D ＝ 前一晚開盤、D 日清晨收盤的夜盤（歸屬 D 交易日，同期交所口徑）。
每個交易日 D：近月＝當日日盤(position) close>0 的最小 YYYYMM 合約；
high/low ＝ 該合約 D 日夜盤與日盤的最大/最小；close ＝ 日盤收盤。
已知簡化：換月當天直接換合約（價差通常數十～數百點）。
Output: {source, updated, data:[{date, high, low, close, contract, dhigh, dlow, nhigh?, nlow?}]}（d=日盤、n=夜盤）
"""
from __future__ import annotations

import json
import re
from datetime import date, timedelta
from pathlib import Path

import requests

from _common import get_finmind_token as get_token

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "tx_hilo.json"
START = "2018-01-01"
API = "https://api.finmindtrade.com/api/v4/data"


def fetch(start: str, end: str, token: str) -> list[dict]:
    p = {"dataset": "TaiwanFuturesDaily", "data_id": "TX", "start_date": start, "end_date": end}
    if token:
        p["token"] = token
    r = requests.get(API, params=p, timeout=60)
    r.raise_for_status()
    j = r.json()
    if j.get("status") not in (200, None):
        raise RuntimeError(j.get("msg"))
    return j.get("data", [])


def build(rows: list[dict]) -> list[dict]:
    by = {}
    for x in rows:
        c = str(x.get("contract_date", ""))
        if not re.fullmatch(r"\d{6}", c):
            continue
        by.setdefault(x["date"], []).append(x)
    out = []
    for d in sorted(by):
        day = [x for x in by[d] if x["trading_session"] == "position" and (x.get("close") or 0) > 0]
        if not day:
            continue
        c = min(x["contract_date"] for x in day)
        legs = [x for x in by[d] if x["contract_date"] == c and (x.get("max") or 0) > 0 and (x.get("min") or 0) > 0]
        pos = next(x for x in day if x["contract_date"] == c)
        ngt = [x for x in legs if x["trading_session"] == "after_market"]
        row = {"date": d, "high": max(x["max"] for x in legs), "low": min(x["min"] for x in legs),
               "close": pos["close"], "contract": c,
               "dhigh": pos["max"], "dlow": pos["min"]}
        if ngt:
            row.update(nhigh=ngt[0]["max"], nlow=ngt[0]["min"])
        out.append(row)
    return out


def main() -> None:
    token = get_token()
    today = date.today()
    old = []
    if OUT.exists():
        old = json.loads(OUT.read_text()).get("data", [])
    if old and "dhigh" in old[-1] and (today - date.fromisoformat(old[-1]["date"])).days < 300:
        raw = fetch((date.fromisoformat(old[-1]["date"]) - timedelta(days=10)).isoformat(), today.isoformat(), token)
    else:
        raw, old = [], []
        for y in range(int(START[:4]), today.year + 1):
            ch = fetch(f"{y}-01-01", f"{y}-12-31" if y < today.year else today.isoformat(), token)
            print(f"  {y}: {len(ch)} rows")
            raw += ch
    new = build(raw)
    if not new:
        raise SystemExit("no rows")
    m = {r["date"]: r for r in old}
    m.update({r["date"]: r for r in new})
    data = [m[k] for k in sorted(m)]
    OUT.write_text(json.dumps({"source": "FinMind TaiwanFuturesDaily TX 近月（日盤＋夜盤）",
                               "updated": data[-1]["date"], "data": data}, ensure_ascii=False, separators=(",", ":")))
    print(f"tx_hilo: {len(data)} rows, last {data[-1]}")


if __name__ == "__main__":
    main()
