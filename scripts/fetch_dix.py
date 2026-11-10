#!/usr/bin/env python3
"""SqueezeMetrics DIX（暗池指數）→ data/dix.json，供首頁 KPI 列。

來源：https://squeezemetrics.com/monitor/static/DIX.csv（公開免費；欄位 date, price, dix, gex）。
只保留最近 KEEP_DAYS 個交易日；dix 以小數存（0.434 = 43.4%）。idempotent：同日期新蓋舊。
"""
from __future__ import annotations

import csv
import io
import json
from datetime import date
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "dix.json"
URL = "https://squeezemetrics.com/monitor/static/DIX.csv"
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)"}
KEEP_DAYS = 1500


def main() -> None:
    r = requests.get(URL, headers=UA, timeout=60)
    r.raise_for_status()
    rows = {}
    for x in csv.DictReader(io.StringIO(r.text)):
        try:
            rows[x["date"]] = {"date": x["date"], "dix": round(float(x["dix"]), 5), "gex": round(float(x["gex"]))}
        except (KeyError, ValueError):
            continue
    if len(rows) < 100:
        raise SystemExit(f"DIX 只抓到 {len(rows)} 列，保留舊檔")
    old = {}
    if OUT.exists():
        try:
            old = {x["date"]: x for x in json.loads(OUT.read_text(encoding="utf-8")).get("data", [])}
        except (json.JSONDecodeError, KeyError, TypeError):
            old = {}
    old.update(rows)
    data = [old[d] for d in sorted(old)][-KEEP_DAYS:]
    out = {"source": URL, "note": "dix＝暗池指數（小數）；gex＝Gamma exposure", "updated": date.today().isoformat(), "data": data}
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"dix: {data[-1]['date']} {data[-1]['dix']}")


if __name__ == "__main__":
    main()
