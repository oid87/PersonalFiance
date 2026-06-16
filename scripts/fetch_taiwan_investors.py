"""Fetch Taiwan three-institutional-investor daily flow (三大法人買賣超) — daily.

Source: TWSE BFI82U endpoint. Returns 5 rows per day:
  - 自營商(自行買賣) / 自營商(避險)  → combined as 自營商
  - 投信
  - 外資及陸資(不含外資自營商)        → 外資
  - 外資自營商 (kept separate, usually 0)

We store daily net buy (買賣差額) in 億元 and pre-compute the cumulative
running total for 外資 — the key chart series. Cumulative resets nowhere; if
the user wants a sliding window it's done client-side.
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
    "https://www.twse.com.tw/rwd/zh/fund/BFI82U"
    "?dayDate={ymd}&type=day&response=json"
)
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/126.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.twse.com.tw/zh/trading/foreign/bfi82u.html",
    "Accept":  "application/json, text/javascript, */*; q=0.01",
}

GLOBAL_START = date(2010, 1, 1)
BACKFILL_DAYS = 90
INCREMENTAL_LOOKBACK = 14
SLEEP_BETWEEN_REQUESTS = 3.0
COOLDOWN_ON_BLOCK = 60.0


def _to_yi(s: str) -> float:
    """Convert TWSE NT$ string to 億元 (1e8)."""
    s = (s or "").strip().replace(",", "")
    if not s or s == "-":
        return 0.0
    try:
        return round(float(s) / 1e8, 2)
    except ValueError:
        return 0.0


def fetch_day(d: date) -> dict | None | str:
    """Return parsed row, None if no data, or 'BLOCKED' if rate-limited."""
    ymd = d.strftime("%Y%m%d")
    try:
        resp = requests.get(URL_TEMPLATE.format(ymd=ymd), headers=HEADERS, timeout=30)
        resp.raise_for_status()
        ct = resp.headers.get("Content-Type", "")
        if "html" in ct.lower() or resp.text.lstrip().startswith("<"):
            return "BLOCKED"
        payload = resp.json()
    except Exception as exc:
        print(f"  [{d}] request failed: {exc}")
        return None
    if payload.get("stat") != "OK":
        return None
    data = payload.get("data") or []
    if not data:
        return None

    by_name = {row[0]: row for row in data if row and row[0]}

    def net(name: str) -> float:
        r = by_name.get(name)
        return _to_yi(r[3]) if r else 0.0

    # 自營商 = 自行買賣 + 避險
    dealer = net("自營商(自行買賣)") + net("自營商(避險)")
    trust  = net("投信")
    foreign = net("外資及陸資(不含外資自營商)") + net("外資自營商")

    return {
        "date":    d.isoformat(),
        "foreign": round(foreign, 2),
        "trust":   round(trust,   2),
        "dealer":  round(dealer,  2),
    }


def load_existing(path: Path) -> list[dict]:
    if not path.exists():
        return []
    try:
        return json.loads(path.read_text()).get("data", [])
    except Exception:
        return []


def with_cumulative(rows: list[dict]) -> list[dict]:
    """Add foreign_cum / trust_cum / dealer_cum running totals."""
    cum_f = cum_t = cum_d = 0.0
    out = []
    for r in rows:
        cum_f += r["foreign"]
        cum_t += r["trust"]
        cum_d += r["dealer"]
        out.append({
            **r,
            "foreign_cum": round(cum_f, 2),
            "trust_cum":   round(cum_t, 2),
            "dealer_cum":  round(cum_d, 2),
        })
    return out


def main() -> None:
    out = DATA_DIR / "taiwan_investors.json"
    existing = load_existing(out)
    # Strip cumulative — will be recomputed from scratch over the full series.
    base = [{k: v for k, v in r.items() if not k.endswith("_cum")} for r in existing]
    by_date = {r["date"]: r for r in base}

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
        if cursor.weekday() < 5:
            row = fetch_day(cursor)
            if row == "BLOCKED":
                consecutive_blocks += 1
                print(f"  [{cursor}] rate-limited, sleeping {COOLDOWN_ON_BLOCK}s")
                time.sleep(COOLDOWN_ON_BLOCK)
                if consecutive_blocks >= 3:
                    print("  Persistent block — bailing out, will retry next run")
                    break
                continue
            consecutive_blocks = 0
            if row:
                by_date[row["date"]] = row
                fetched += 1
            time.sleep(SLEEP_BETWEEN_REQUESTS)
        cursor += timedelta(days=1)

    merged = sorted(by_date.values(), key=lambda r: r["date"])
    merged = with_cumulative(merged)

    payload = {
        "source":  "TWSE BFI82U (三大法人買賣超), net in 億元",
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
