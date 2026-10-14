"""Fetch 櫃買指數 (TPEx index) daily OHLCV and merge into data/TWOII.json.

Source: FinMind `TaiwanStockPrice` with `data_id=TPEx` (櫃買指數). From
2026-07-18 onward this script continues the series; the rows before that are
Yahoo `^TWOII` (yfinance has returned no data for it since 2026-07, so
fetch_stocks.py no longer fetches it). FinMind has no complete history back to
2013, so this script only ever *extends* an existing data/TWOII.json: if the
file is missing or has no rows it raises instead of building a new file from
recent data (which would overwrite the history).

Field mapping (FinMind -> data row):
  date -> date, open -> open, max -> high, min -> low, close -> close,
  Trading_Volume -> volume

Volume unit is 張 (lots): volume = Trading_Volume // 1000 (FinMind's raw unit
is shares). It differs from the older Yahoo volume by about 2%. The only
consumer (js/tabs/marginglobal.js) reads just date and close, never volume.

Each run fetches from (last existing date - 14 days) and merges by date, new
rows overriding old (same semantics as fetch_stocks.merge), so it is
idempotent. Yahoo-era rows are frozen: FinMind rows dated before FINMIND_START
(2026-07-18) are dropped before merging, so the 14-day overlap window can never
overwrite them. If FinMind returns nothing usable (after that filter) the
script raises and leaves the existing file untouched.

token: _common.get_finmind_token() (env FINMIND_TOKEN -> repo .finmind_token ->
anonymous).
Output data/TWOII.json:
  {symbol, updated, source, volume_note,
   data: [{date, open, high, low, close, volume}]}   # ascending by date
"""
from __future__ import annotations

import json
import math
from datetime import date, datetime, timedelta
from pathlib import Path

import requests

import _common

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "TWOII.json"
API = "https://api.finmindtrade.com/api/v4/data"
DATASET = "TaiwanStockPrice"
DATA_ID = "TPEx"
LOOKBACK_DAYS = 14
FINMIND_START = "2026-07-18"  # rows before this date are Yahoo-era and frozen
ATTEMPTS = 4

SOURCE = "FinMind TaiwanStockPrice TPEx (2026-07-18 起)；之前為 Yahoo ^TWOII"
VOLUME_NOTE = (
    "2026-07-18 起 volume 為 FinMind Trading_Volume//1000（張）；"
    "之前為 Yahoo volume，口徑約差 2%，頁面不使用 volume"
)


class RetryableFetchError(RuntimeError):
    """Transient failure (HTTP 429/5xx, or FinMind payload status 429/5xx)."""


def _backoff(attempt: int) -> float:
    return 2.0 * (attempt + 1)  # 2s, 4s, 6s between the 4 attempts


def _transient(status) -> bool:
    return status == 429 or 500 <= status < 600


def _fetch_once(start: str, token: str) -> list[dict]:
    params = {"dataset": DATASET, "data_id": DATA_ID, "start_date": start}
    if token:
        params["token"] = token
    resp = requests.get(API, params=params, timeout=60)
    if _transient(resp.status_code):
        raise RetryableFetchError(f"FinMind HTTP {resp.status_code}")
    resp.raise_for_status()  # other 4xx -> HTTPError, not retried
    payload = resp.json()
    status = payload.get("status")
    if status != 200:
        msg = f"FinMind status={status} msg={payload.get('msg')}"
        if isinstance(status, int) and _transient(status):
            raise RetryableFetchError(msg)
        raise RuntimeError(msg)
    return payload.get("data") or []


def fetch_rows(start: str, token: str) -> list[dict]:
    """Raw FinMind TPEx rows from `start`. Retries only connection errors,
    timeouts and 429/5xx (HTTP or payload status); any other failure (other
    4xx, non-200 payload status, bad JSON) is raised immediately. After the
    last failed attempt the final exception is re-raised."""
    def _raise_last(exc, _result):
        raise exc

    return _common.retry_call(
        lambda: _fetch_once(start, token),
        attempts=ATTEMPTS,
        backoff=_backoff,
        retry_on=(requests.exceptions.ConnectionError, requests.exceptions.Timeout,
                  RetryableFetchError),
        on_retry=lambda attempt, exc, _r: print(
            f"  [TWOII] fetch attempt {attempt + 1}/{ATTEMPTS} failed ({exc}); retrying"),
        on_final=_raise_last,
    )


def _finite(value) -> bool:
    try:
        return math.isfinite(float(value))
    except (TypeError, ValueError):
        return False


def _strict_date(d) -> bool:
    if not (isinstance(d, str) and len(d) == 10):
        return False
    try:
        return date.fromisoformat(d).isoformat() == d
    except ValueError:
        return False


def _volume_lots(d: str, value) -> int:
    """Trading_Volume (shares) -> lots. None -> 0 silently; unparseable or
    non-finite -> 0 with a warning."""
    if value is None:
        return 0
    try:
        v = float(value)
    except (TypeError, ValueError):
        v = float("nan")
    if not math.isfinite(v):
        print(f"  [TWOII] {d}: unusable Trading_Volume={value!r}, volume set to 0")
        return 0
    return int(v) // 1000


def map_rows(raw: list[dict]) -> list[dict]:
    """FinMind rows -> data rows. Skips (and counts) rows without a strict
    YYYY-MM-DD date or whose close is missing / non-finite / <= 0. A row whose
    close is fine but open/max/min is non-finite is skipped with a per-row
    warning (never fabricated, never written as NaN)."""
    rows: list[dict] = []
    skipped = 0
    for r in raw:
        d = r.get("date")
        if not _strict_date(d):
            skipped += 1
            continue
        if not _finite(r.get("close")) or float(r["close"]) <= 0:
            skipped += 1
            continue
        bad = next((k for k in ("open", "max", "min") if not _finite(r.get(k))), None)
        if bad is not None:
            print(f"  [TWOII] skipped {d}: non-finite {bad}={r.get(bad)!r}")
            continue
        rows.append({
            "date":   d,
            "open":   round(float(r["open"]), 4),
            "high":   round(float(r["max"]),  4),
            "low":    round(float(r["min"]),  4),
            "close":  round(float(r["close"]), 4),
            "volume": _volume_lots(d, r.get("Trading_Volume")),
        })
    if skipped:
        print(f"  [TWOII] skipped {skipped} unusable raw rows (bad date / close missing or <= 0)")
    return rows


def merge(existing: list[dict], new: list[dict]) -> list[dict]:
    by_date = {row["date"]: row for row in existing}
    for row in new:
        by_date[row["date"]] = row  # new overrides old
    return sorted(by_date.values(), key=lambda r: r["date"])


def main() -> None:
    token = _common.get_finmind_token()
    print(f"FinMind token: {'env/file' if token else 'ANONYMOUS'}")
    existing = _common.load_rows(OUT)
    if not existing:
        raise RuntimeError(
            f"{OUT.name} missing, empty or unreadable: refusing to build it from FinMind "
            "alone (FinMind has no full history back to 2013)")
    last = existing[-1]["date"]
    start = (datetime.fromisoformat(last) - timedelta(days=LOOKBACK_DAYS)).date().isoformat()
    print(f"  [TWOII] incremental from {start} ({len(existing)} existing rows)")

    raw = fetch_rows(start, token)
    mapped = map_rows(raw)
    new_rows = [r for r in mapped if r["date"] >= FINMIND_START]
    print(f"  [TWOII] kept {sum(1 for r in existing if r['date'] < FINMIND_START)} "
          f"pre-{FINMIND_START} Yahoo rows untouched "
          f"(dropped {len(mapped) - len(new_rows)} overlapping FinMind rows)")
    if not new_rows:
        raise RuntimeError(f"FinMind returned no usable TPEx rows from {start} "
                           f"({len(raw)} raw); keeping existing {OUT.name}")
    merged = merge(existing, new_rows)

    payload = {
        "symbol":      "TWOII",
        "updated":     date.today().isoformat(),
        "source":      SOURCE,
        "volume_note": VOLUME_NOTE,
        "data":        merged,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, allow_nan=False) + "\n")
    print(f"  [TWOII] wrote {len(merged)} rows -> {OUT.name} "
          f"({len(new_rows)} fetched, last {merged[-1]['date']})")


if __name__ == "__main__":
    main()
