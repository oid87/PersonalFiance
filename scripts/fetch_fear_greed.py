"""Fetch CNN Fear & Greed Index.

Strategy:
  - Backfill (if data/fear_greed.json is empty/missing): pull historical CSV
    from the whit3rabbit/fear-greed-data GitHub mirror (2011-present).
  - Every run: call CNN's live endpoint and merge the most recent ~30 days
    so the file stays current with today's close.
"""
from __future__ import annotations

import csv
import io
import json
from datetime import date, datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)
OUT = DATA_DIR / "fear_greed.json"

HISTORICAL_CSV = (
    "https://raw.githubusercontent.com/whit3rabbit/fear-greed-data/main/fear-greed.csv"
)
CNN_URL = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata"

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)


def _rating_from(value: float) -> str:
    # CNN thresholds
    if value <  25: return "extreme fear"
    if value <  45: return "fear"
    if value <  55: return "neutral"
    if value <  75: return "greed"
    return "extreme greed"


def load_existing() -> list[dict]:
    if not OUT.exists():
        return []
    try:
        return json.loads(OUT.read_text()).get("data", [])
    except Exception:
        return []


def fetch_backfill() -> list[dict]:
    print("  backfilling historical CSV from whit3rabbit/fear-greed-data ...")
    resp = requests.get(HISTORICAL_CSV, timeout=30)
    resp.raise_for_status()
    reader = csv.DictReader(io.StringIO(resp.text))
    rows: list[dict] = []
    for r in reader:
        try:
            rows.append({
                "date":   r["Date"],
                "value":  round(float(r["Fear Greed"]), 2),
                "rating": r["Rating"].strip().lower(),
            })
        except (KeyError, ValueError):
            continue
    print(f"  got {len(rows)} historical rows")
    return rows


def fetch_live() -> list[dict]:
    # CNN's endpoint wants a start-date segment in the path, but accepts any
    # ISO date. Ask for the last ~40 days.
    from datetime import timedelta
    start = (date.today() - timedelta(days=40)).isoformat()
    url = f"{CNN_URL}/{start}"
    resp = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=30)
    resp.raise_for_status()
    payload = resp.json()
    hist = payload.get("fear_and_greed_historical", {}).get("data", [])
    rows: list[dict] = []
    for r in hist:
        try:
            ts = int(r["x"]) / 1000
            d = datetime.fromtimestamp(ts, tz=timezone.utc).date().isoformat()
            v = round(float(r["y"]), 2)
            rows.append({
                "date":   d,
                "value":  v,
                "rating": (r.get("rating") or _rating_from(v)).lower(),
            })
        except (KeyError, ValueError, TypeError):
            continue
    print(f"  got {len(rows)} live rows from CNN")
    return rows


def merge(existing: list[dict], *sources: list[dict]) -> list[dict]:
    by_date = {r["date"]: r for r in existing}
    for src in sources:
        for r in src:
            by_date[r["date"]] = r
    return sorted(by_date.values(), key=lambda r: r["date"])


def main() -> None:
    existing = load_existing()
    print(f"Loaded {len(existing)} existing F&G rows")

    sources: list[list[dict]] = []
    if not existing:
        sources.append(fetch_backfill())

    try:
        sources.append(fetch_live())
    except Exception as exc:
        print(f"  WARN: live CNN fetch failed: {exc}")
        if not existing and not sources:
            raise

    merged = merge(existing, *sources)

    payload = {
        "source":  "CNN (via whit3rabbit/fear-greed-data + live CNN endpoint)",
        "updated": date.today().isoformat(),
        "data":    merged,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    print(f"Wrote {len(merged)} rows -> {OUT.name}")


if __name__ == "__main__":
    main()
