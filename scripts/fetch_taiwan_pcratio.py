"""Fetch TAIFEX 臺指選擇權 Put/Call Ratio (台股情緒指標之一).

Source: https://www.taifex.com.tw/cht/3/pcRatioDown  (free CSV, Big5, 2005-present)
Daily single values:
  vol_pc = 賣權/買權 成交量比率 (%)   — 越高代表避險/看空買盤越多 (恐慌)
  oi_pc  = 賣權/買權 未平倉量比率 (%)  — 部位面的多空結構

The download caps at ~1 month per request, so backfill chunks month-by-month;
incremental runs only refetch the current + previous month.

Output: data/taiwan_pcratio.json -> {source, updated, data:[{date, vol_pc, oi_pc}]}
"""
from __future__ import annotations

import csv
import io
import json
import time
from datetime import date
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "taiwan_pcratio.json"
URL = "https://www.taifex.com.tw/cht/3/pcRatioDown"
HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}
START_YEAR = 2005  # TAIFEX P/C ratio history begins 2005


def load_existing() -> list[dict]:
    if not OUT.exists():
        return []
    try:
        return json.loads(OUT.read_text()).get("data", [])
    except Exception:
        return []


def fetch_month(y: int, m: int) -> list[dict]:
    last = date(y + (m == 12), (m % 12) + 1, 1)  # first of next month
    first = date(y, m, 1)
    resp = requests.post(URL, headers=HEADERS, timeout=30, data={
        "queryStartDate": first.strftime("%Y/%m/%d"),
        "queryEndDate": min(last, date.today()).strftime("%Y/%m/%d"),
    })
    resp.encoding = "big5"
    rows: list[dict] = []
    reader = csv.reader(io.StringIO(resp.text))
    for r in reader:
        if not r or not r[0].strip().startswith("20"):
            continue
        try:
            d = r[0].strip().replace("/", "-")
            vol_pc = float(r[3]) if r[3].strip() not in ("", "-") else None
            oi_pc = float(r[6]) if len(r) > 6 and r[6].strip() not in ("", "-") else None
            if vol_pc is None:
                continue
            rows.append({"date": d, "vol_pc": round(vol_pc, 2),
                         "oi_pc": round(oi_pc, 2) if oi_pc is not None else None})
        except (ValueError, IndexError):
            continue
    return rows


def months_from(y0: int, m0: int):
    y, m = y0, m0
    today = date.today()
    while (y, m) <= (today.year, today.month):
        yield y, m
        y, m = (y + (m == 12), (m % 12) + 1)


def main() -> None:
    existing = load_existing()
    by_date = {r["date"]: r for r in existing}
    print(f"Loaded {len(existing)} existing P/C rows")

    if existing:
        # incremental: refetch current + previous month only
        today = date.today()
        py, pm = (today.year - (today.month == 1), today.month - 1 or 12)
        targets = [(py, pm), (today.year, today.month)]
    else:
        targets = list(months_from(START_YEAR, 1))
        print(f"Backfilling {len(targets)} months from {START_YEAR}-01 ...")

    got = 0
    for i, (y, m) in enumerate(targets):
        try:
            rows = fetch_month(y, m)
            for r in rows:
                by_date[r["date"]] = r
            got += len(rows)
        except Exception as exc:
            print(f"  WARN {y}-{m:02d}: {exc}")
        if not existing:
            time.sleep(0.3)  # be polite during the one-time backfill
            if i % 24 == 0:
                print(f"  ... {y}-{m:02d} ({got} rows so far)")

    if not by_date:
        raise SystemExit("No P/C data fetched and no existing file")

    data = sorted(by_date.values(), key=lambda r: r["date"])
    OUT.write_text(json.dumps({
        "source": "TAIFEX 臺指選擇權 Put/Call Ratio (pcRatioDown)",
        "note": "vol_pc=賣權/買權成交量比率%; oi_pc=未平倉量比率%. 越高=避險/看空越濃(恐慌)。",
        "updated": date.today().isoformat(),
        "data": data,
    }, ensure_ascii=False) + "\n")
    print(f"Wrote {len(data)} rows -> {OUT.name} ({data[0]['date']}..{data[-1]['date']})")


if __name__ == "__main__":
    main()
