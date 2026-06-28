"""Fetch TWSE industry sector index closing prices.

Source: https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_INDEX
Returns 5-second intraday snapshots for all sector indices; we take the last
row (13:30 closing) for each trading day.

First run backfills ~3 years; subsequent runs fetch the last 14 days and merge
idempotently.
"""
from __future__ import annotations

import json
import time
from datetime import date, datetime, timedelta
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = DATA / "taiwan_sector_index.json"

TWSE_URL = "https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_INDEX"

# Key sectors to extract (Chinese field names from TWSE API → internal keys)
SECTORS: dict[str, str] = {
    "發行量加權股價指數": "taiex",
    "半導體類指數":       "semiconductor",
    "電子類指數":         "electronics",
    "金融保險類指數":     "finance",
    "航運類指數":         "shipping",
    "鋼鐵類指數":         "steel",
    "生技醫療類指數":     "biotech",
    "通信網路類指數":     "telecom",
    "光電類指數":         "optoelectronics",
    "電腦及週邊設備類指數": "computer",
    "電子零組件類指數":   "e_components",
    "建材營造類指數":     "construction",
    "觀光餐旅類指數":     "tourism",
    "食品類指數":         "food",
    "塑膠類指數":         "plastics",
    "油電燃氣類指數":     "oil_gas",
    "數位雲端類指數":     "digital_cloud",
    "綠能環保類指數":     "green_energy",
    "電機機械類指數":     "machinery",
}

BACKFILL_YEARS = 3
FETCH_RECENT_DAYS = 21
REQUEST_DELAY = 0.5
RETRY_MAX = 3
RETRY_BACKOFF = 5

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Referer": "https://www.twse.com.tw/",
    "Accept": "application/json",
}


def load_existing() -> dict[str, list]:
    if not OUT.exists():
        return {}
    try:
        return json.loads(OUT.read_text()).get("data", {})
    except Exception:
        return {}


def parse_value(s: str) -> float | None:
    try:
        return float(s.replace(",", ""))
    except (ValueError, TypeError):
        return None


SESSION = requests.Session()
SESSION.headers.update(HEADERS)


def fetch_day(dt: date) -> dict[str, tuple[str, float]] | None:
    """Fetch closing sector indices for a single trading day (with retry)."""
    for attempt in range(RETRY_MAX):
        try:
            resp = SESSION.get(
                TWSE_URL,
                params={"response": "json", "date": dt.strftime("%Y%m%d")},
                timeout=20,
            )
            if resp.status_code == 429 or resp.status_code >= 500:
                time.sleep(RETRY_BACKOFF * (attempt + 1))
                continue
            if resp.status_code != 200:
                return None
            j = resp.json()
            if j.get("stat") != "OK" or not j.get("data"):
                return None

            fields = j["fields"]
            last_row = j["data"][-1]
            field_map = dict(zip(fields, last_row))

            result = {}
            date_str = dt.strftime("%Y-%m-%d")
            for zh_name, key in SECTORS.items():
                val = parse_value(field_map.get(zh_name, ""))
                if val is not None:
                    result[key] = (date_str, val)
            return result
        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError):
            time.sleep(RETRY_BACKOFF * (attempt + 1))
    return None


def trading_dates(start: date, end: date) -> list[date]:
    """Generate weekdays between start and end (inclusive)."""
    out = []
    d = start
    while d <= end:
        if d.weekday() < 5:
            out.append(d)
        d += timedelta(days=1)
    return out


def main():
    existing = load_existing()
    today = date.today()

    if existing:
        latest_dates = []
        for series in existing.values():
            if series:
                latest_dates.append(series[-1][0])
        if latest_dates:
            last = max(latest_dates)
            start = datetime.strptime(last, "%Y-%m-%d").date() - timedelta(days=FETCH_RECENT_DAYS)
        else:
            start = today - timedelta(days=BACKFILL_YEARS * 365)
    else:
        start = today - timedelta(days=BACKFILL_YEARS * 365)

    dates = trading_dates(start, today)
    print(f"Fetching {len(dates)} trading days from {start} to {today}")

    def save():
        for key in existing:
            by_date = {}
            for row in existing[key]:
                by_date[row[0]] = row[1]
            existing[key] = sorted([[d, v] for d, v in by_date.items()])
        out = {"data": existing, "updated": today.isoformat()}
        OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))

    fetched = 0
    skipped = 0
    consec_skip = 0
    for i, dt in enumerate(dates):
        result = fetch_day(dt)
        if result:
            for key, (date_str, val) in result.items():
                if key not in existing:
                    existing[key] = []
                existing[key].append([date_str, val])
            fetched += 1
            consec_skip = 0
        else:
            skipped += 1
            consec_skip += 1

        if (i + 1) % 50 == 0:
            print(f"  {i + 1}/{len(dates)} done ({fetched} fetched, {skipped} skipped)")
            save()

        # TWSE throttles after ~150 rapid requests; back off when seeing consecutive failures
        if consec_skip >= 10:
            print(f"  {consec_skip} consecutive skips at {dt}, pausing 30s…")
            save()
            time.sleep(30)
            consec_skip = 0
        elif i < len(dates) - 1:
            time.sleep(REQUEST_DELAY)

    save()
    print(f"Done: {fetched} days fetched, {skipped} holidays/errors → {OUT}")
    for key in sorted(existing):
        print(f"  {key}: {len(existing[key])} points")


if __name__ == "__main__":
    main()
