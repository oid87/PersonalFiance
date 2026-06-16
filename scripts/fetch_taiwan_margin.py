"""Fetch Taiwan market-wide margin trading totals (信用交易統計) — daily.

Source: TWSE MI_MARGN endpoint with selectType=ALL. tables[0] returns the
three market-level summary rows; we keep the cash-balance row 融資金額(仟元)
and the share-count row 融券(交易單位) → short interest tracking.

Incremental: backfill ~60 days on first run, then ~14 day catch-up afterwards.
TWSE accepts dates only for trading days; non-trading days return empty data,
which we silently skip.
"""
from __future__ import annotations

import json
import time
from datetime import date, datetime, timedelta
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)

URL_TEMPLATE = (
    "https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN"
    "?date={ymd}&selectType=ALL&response=json"
)
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/126.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.twse.com.tw/zh/trading/margin/mi-margn.html",
    "Accept":  "application/json, text/javascript, */*; q=0.01",
}

GLOBAL_START = date(2010, 1, 1)
BACKFILL_DAYS = 90        # first-run window
INCREMENTAL_LOOKBACK = 14  # subsequent-run safety window
SLEEP_BETWEEN_REQUESTS = 3.0  # TWSE rate-limits aggressively
COOLDOWN_ON_BLOCK = 60.0  # if we hit an HTML/maintenance page


def _to_int(s: str) -> int | None:
    s = (s or "").strip().replace(",", "")
    if not s or s == "-":
        return None
    try:
        return int(s)
    except ValueError:
        return None


def fetch_day(d: date) -> dict | None | str:
    """Return parsed row, None if no data, or 'BLOCKED' if rate-limited."""
    ymd = d.strftime("%Y%m%d")
    try:
        resp = requests.get(URL_TEMPLATE.format(ymd=ymd), headers=HEADERS, timeout=30)
        resp.raise_for_status()
        ct = resp.headers.get("Content-Type", "")
        # TWSE rate-limit returns HTML maintenance page
        if "html" in ct.lower() or resp.text.lstrip().startswith("<"):
            return "BLOCKED"
        payload = resp.json()
    except Exception as exc:
        print(f"  [{d}] request failed: {exc}")
        return None
    if payload.get("stat") != "OK":
        return None
    tables = payload.get("tables") or []
    if not tables or not tables[0].get("data"):
        return None

    # tables[0].data rows: [融資(交易單位), 融券(交易單位), 融資金額(仟元)]
    rows = {r[0]: r for r in tables[0]["data"] if r and r[0]}
    margin_amt_row = rows.get("融資金額(仟元)")
    short_units_row = rows.get("融券(交易單位)")
    if not margin_amt_row:
        return None

    # fields: 項目, 買進, 賣出, 現金(券)償還, 前日餘額, 今日餘額
    return {
        "date":             d.isoformat(),
        # 融資餘額 — convert 仟元 → 億元 for chart-friendly unit
        "margin_yi":        round((_to_int(margin_amt_row[5]) or 0) / 100_000, 2),
        "margin_prev_yi":   round((_to_int(margin_amt_row[4]) or 0) / 100_000, 2),
        # 融券餘額 — units (張)
        "short_units":      _to_int(short_units_row[5]) if short_units_row else None,
    }


def load_existing(path: Path) -> list[dict]:
    if not path.exists():
        return []
    try:
        return json.loads(path.read_text()).get("data", [])
    except Exception:
        return []


def main() -> None:
    out = DATA_DIR / "taiwan_margin.json"
    existing = load_existing(out)
    by_date = {r["date"]: r for r in existing}

    today = date.today()
    if existing:
        last = datetime.fromisoformat(existing[-1]["date"]).date()
        start = max(GLOBAL_START, last - timedelta(days=INCREMENTAL_LOOKBACK))
        print(f"Incremental from {start} (have {len(existing)} rows, last={last})")
    else:
        start = max(GLOBAL_START, today - timedelta(days=BACKFILL_DAYS))
        print(f"Backfill from {start}")

    cursor = start
    fetched = 0
    consecutive_blocks = 0
    while cursor <= today:
        if cursor.weekday() < 5:  # Mon-Fri only
            row = fetch_day(cursor)
            if row == "BLOCKED":
                consecutive_blocks += 1
                print(f"  [{cursor}] rate-limited, sleeping {COOLDOWN_ON_BLOCK}s")
                time.sleep(COOLDOWN_ON_BLOCK)
                if consecutive_blocks >= 3:
                    print("  Persistent block — bailing out, will retry next run")
                    break
                continue  # retry same date
            consecutive_blocks = 0
            if row:
                by_date[row["date"]] = row
                fetched += 1
            time.sleep(SLEEP_BETWEEN_REQUESTS)
        cursor += timedelta(days=1)

    merged = sorted(by_date.values(), key=lambda r: r["date"])
    payload = {
        "source":  "TWSE MI_MARGN (信用交易統計, selectType=ALL)",
        "updated": today.isoformat(),
        "latest":  merged[-1] if merged else None,
        "data":    merged,
    }
    out.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    print(f"Wrote {len(merged)} rows ({fetched} new/updated) -> {out.name}")
    if merged:
        print(f"  latest: {merged[-1]}")


if __name__ == "__main__":
    main()
