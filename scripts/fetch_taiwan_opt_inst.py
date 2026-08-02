"""Fetch TAIFEX 三大法人-選擇權買賣權分計-依日期: 臺指選擇權 CALL/PUT 未平倉口數買賣淨額.

Source: https://www.taifex.com.tw/cht/3/callsAndPutsDateDown  (POST, date-range CSV export)
This endpoint accepts a date RANGE (queryStartDate/queryEndDate) and returns all
trading days in one response — unlike the per-date futContractsDateExcel endpoint
used by fetch_taifex_foreign_oi.py. A single request can pull the full ~3-year
rolling window (~700+ trading days), so this script does NOT loop day-by-day.

Response encoding: Big5/cp950 CSV when data exists. When the query range has no
data (non-trading day, or outside the queryable window), TAIFEX returns a UTF-8
HTML page instead of CSV — detected by the response starting with b"<" and
treated as "no data" (not an error, not cp950-decoded).

Quirk discovered while testing (not in the original data-source brief): if
queryEndDate is a date whose data hasn't been published yet (e.g. a weekend/
holiday, or "today" before end-of-day processing), TAIFEX rejects the WHOLE
range with a "日期時間錯誤 DateTime error" alert page — even though earlier
dates in the range have valid data. This is different from the genuine
"查無資料" (no data) alert. fetch_range() distinguishes the two by inspecting
the HTML text, and on a DateTime-error walks queryEndDate back a day at a time
(bounded) until it finds the last date TAIFEX has actually published, so
`--backfill`/incremental runs on a weekend or before today's data drop still
succeed instead of silently returning zero rows.

CSV columns (原文, 5 commodities mixed: 臺指/電子/金融/股票/ETF選擇權):
  日期, 商品名稱, 買賣權別, 身份別,
  買方交易口數, 買方交易契約金額(千元), 賣方交易口數, 賣方交易契約金額(千元),
  交易口數買賣淨額, 交易契約金額買賣淨額(千元),
  買方未平倉口數, 買方未平倉契約金額(千元), 賣方未平倉口數, 賣方未平倉契約金額(千元),
  未平倉口數買賣淨額, 未平倉契約金額買賣淨額(千元)
We filter 商品名稱 == "臺指選擇權" and take 未平倉口數買賣淨額 (already net, no need
to compute from buy/sell columns) for each (買賣權別 in {CALL,PUT}) x
(身份別 in {外資及陸資,投信,自營商}) combination.

Important: TAIFEX only exposes a ROLLING ~3-YEAR query window (older dates return
the "no data" HTML page even mid-range). This script relies on the existing
data/taiwan_opt_inst.json to accumulate history beyond that window — it must
never be treated as re-derivable from scratch after 3 years have passed.

Output: data/taiwan_opt_inst.json
  {"source": "...", "note": "...", "updated": "...",
   "data": [{"date","call_foreign","put_foreign","call_trust","put_trust",
             "call_dealer","put_dealer"}, ...]}
Idempotent: re-fetching overwrites rows for the same date (keyed by date).
"""
from __future__ import annotations

import argparse
import io
import json
from collections import OrderedDict
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import requests

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)
OUT = DATA_DIR / "taiwan_opt_inst.json"

URL = "https://www.taifex.com.tw/cht/3/callsAndPutsDateDown"
HEADERS = {"User-Agent": "PersonalFiance/1.0"}

COMMODITY = "臺指選擇權"
IDENTITY_SUFFIX = {
    "外資及陸資": "foreign",
    "投信": "trust",
    "自營商": "dealer",
}
SIDE_PREFIX = {"CALL": "call", "PUT": "put"}

RECENT_DAYS = 10          # incremental mode: re-check window (covers long weekends)
BACKFILL_DAYS = 365 * 3   # matches TAIFEX's rolling ~3y query-window limit
END_DATE_BACKOFF_MAX = 7  # max days to step queryEndDate back on "DateTime error"


def _post(start: date, end: date) -> bytes:
    payload = {
        "queryStartDate": start.strftime("%Y/%m/%d"),
        "queryEndDate": end.strftime("%Y/%m/%d"),
    }
    resp = requests.post(URL, data=payload, headers=HEADERS, timeout=60)
    resp.raise_for_status()
    return resp.content


def _parse_csv(text: str) -> "OrderedDict[str, dict]":
    df = pd.read_csv(io.StringIO(text), dtype=str, index_col=False)
    df.columns = [c.strip() for c in df.columns]

    df = df[df["商品名稱"].str.strip() == COMMODITY]

    by_date: "OrderedDict[str, dict]" = OrderedDict()
    for _, row in df.iterrows():
        raw_date = row["日期"].strip()
        d = raw_date.replace("/", "-")
        y, m, day = d.split("-")
        iso = f"{y}-{int(m):02d}-{int(day):02d}"

        side = SIDE_PREFIX.get(row["買賣權別"].strip())
        identity = IDENTITY_SUFFIX.get(row["身份別"].strip())
        if side is None or identity is None:
            continue

        net = int(row["未平倉口數買賣淨額"].strip().replace(",", ""))
        rec = by_date.setdefault(iso, {"date": iso})
        rec[f"{side}_{identity}"] = net

    return by_date


def fetch_range(start: date, end: date) -> "OrderedDict[str, dict]":
    """Fetch [start, end] inclusive in a single request (with end-date backoff
    on TAIFEX's "DateTime error" for not-yet-published end dates). Returns {date: record}."""
    cur_end = end
    for step in range(END_DATE_BACKOFF_MAX + 1):
        if cur_end < start:
            break
        raw = _post(start, cur_end)

        if raw.lstrip()[:1] != b"<":
            return _parse_csv(raw.decode("cp950"))

        html = raw.decode("utf-8", errors="replace")
        if "日期時間錯誤" in html or "DateTime error" in html:
            if step < END_DATE_BACKOFF_MAX:
                cur_end -= timedelta(days=1)
                continue
            print(f"  gave up backing off queryEndDate from {end} (still DateTime error at {cur_end})")
            return OrderedDict()

        # genuine "查無資料" (no data) for this range — not an error
        print(f"  no data for {start} ~ {cur_end} (查無資料)")
        return OrderedDict()

    return OrderedDict()


def load_existing() -> "OrderedDict[str, dict]":
    if not OUT.exists():
        return OrderedDict()
    try:
        payload = json.loads(OUT.read_text())
        return OrderedDict((r["date"], r) for r in payload.get("data", []) if r.get("date"))
    except Exception:
        return OrderedDict()


def save(merged: "OrderedDict[str, dict]") -> None:
    data = [merged[d] for d in sorted(merged)]
    payload = {
        "source": "TAIFEX 三大法人-選擇權買賣權分計-依日期 (callsAndPutsDateDown), 臺指選擇權",
        "note": (
            "各身份別 CALL/PUT 未平倉口數買賣淨額(口). 正=淨買方(買進未平倉>賣出未平倉). "
            "外資 CALL 淨額為主要觀察值. 期交所僅提供滾動3年查詢視窗, 更早歷史靠本檔累積保存."
        ),
        "updated": date.today().isoformat(),
        "data": data,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--backfill", action="store_true", help="fetch full ~3y rolling window")
    args = parser.parse_args()

    today = date.today()
    existing = load_existing()

    if args.backfill:
        start = today - timedelta(days=BACKFILL_DAYS)
    else:
        start = today - timedelta(days=RECENT_DAYS)

    print(f"Fetching TAIFEX {COMMODITY} inst OI: {start} ~ {today} ({'backfill' if args.backfill else 'incremental'})")

    try:
        fresh = fetch_range(start, today)
    except Exception as exc:
        if existing:
            print(f"  [taiwan_opt_inst] FAILED ({exc}); keeping {len(existing)} existing rows")
            return
        raise

    merged = OrderedDict(existing)
    for d, rec in fresh.items():
        merged[d] = rec

    save(merged)
    print(f"Wrote {OUT.name}: {len(merged)} rows")
    if merged:
        last = max(merged.keys())
        first = min(merged.keys())
        print(f"  range: {first} -> {last}")
        print(f"  last row: {merged[last]}")


if __name__ == "__main__":
    main()
