"""Fetch WSJ official index-level P/E snapshot and append to data/WSJ_PE.json.

不可重生史料（irreplaceable snapshot）：WSJ 官方指數級 Forward/Trailing P/E 快照。
現值免費、歷史序列要錢/不可得，每日執行 append 才能自建歷史。漏跑的日子補不回來，
不做插值/前向填充。WSJ 為週更（以週五收盤 as-of），因此天天跑也只有新 tradeDate
出現時才會新增列——多數執行日 0 新增是預期行為，不是 bug。

ticker 對照：INX=S&P500, RIXF=NASDAQ100, RUT=Russell2000, DJI/DJT/DJU=道瓊三指數。

用法: python3 fetch_wsj_pe.py
"""
from __future__ import annotations

import json
import re
import sys
from datetime import date
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "WSJ_PE.json"

URL = "https://www.wsj.com/market-data/stocks/peyields"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

# 跳脫字串清乾淨後,逐塊抓 tradeDate + instruments 陣列(每個 indexType 一塊)
BLOCK_RE = re.compile(r'"tradeDate":"([^"]+)","instruments":(\[.*?\])(?=,"formattedTradeDate")')

NOTE = (
    "WSJ 官方指數級 PE 快照(週更,週五 as-of)。fpe=forward、tpe=trailing、yld=殖利率。"
    "ticker: INX=S&P500, RIXF=NASDAQ100, RUT=Russell2000, DJI/DJT/DJU=道瓊三指數。不可重生史料。"
)


def fetch_html() -> str:
    resp = requests.get(URL, headers={"User-Agent": UA}, timeout=30)
    if resp.status_code != 200:
        sys.exit(f"[fetch_wsj_pe] HTTP {resp.status_code} 非 200,中止")
    return resp.text


def _to_float(v):
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def parse(html: str) -> list[dict]:
    clean = html.replace("\\\\", "").replace('\\"', '"')
    blocks = BLOCK_RE.findall(clean)
    if not blocks:
        sys.exit("[fetch_wsj_pe] 找不到任何 tradeDate/instruments 區塊,頁面結構可能已變,中止")

    rows: list[dict] = []
    seen = set()
    for trade_date_raw, instr_json in blocks:
        trade_date = trade_date_raw.split("T")[0]
        try:
            instruments = json.loads(instr_json)
        except json.JSONDecodeError as e:
            sys.exit(f"[fetch_wsj_pe] instruments JSON 解析失敗:{e},中止")
        for inst in instruments:
            ticker = inst.get("ticker")
            if not ticker:
                continue
            key = (trade_date, ticker)
            if key in seen:
                continue
            seen.add(key)
            rows.append({
                "date": trade_date,
                "ticker": ticker,
                "fpe": _to_float(inst.get("priceEarningsRatioEstimate")),
                "tpe": _to_float(inst.get("priceEarningsRatio")),
                "yld": _to_float(inst.get("yield")),
            })
    if not rows:
        sys.exit("[fetch_wsj_pe] 解析出 0 筆 instrument,中止")
    return rows


def load_existing() -> list[dict]:
    if not OUT.exists():
        return []
    try:
        return json.loads(OUT.read_text()).get("data", [])
    except Exception:
        return []


def main() -> None:
    html = fetch_html()
    new_rows = parse(html)

    existing = load_existing()
    before = len(existing)
    by_key = {(r["date"], r["ticker"]): r for r in existing}
    for r in new_rows:
        by_key[(r["date"], r["ticker"])] = r
    merged = sorted(by_key.values(), key=lambda r: (r["date"], r["ticker"]))

    payload = {"updated": date.today().isoformat(), "note": NOTE, "data": merged}
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")

    added = len(merged) - before
    print(f"[fetch_wsj_pe] 新增 {added} 筆,JSON 總筆數 {len(merged)}")
    print(f"[fetch_wsj_pe] 最新一筆: {merged[-1] if merged else None}")


if __name__ == "__main__":
    main()
