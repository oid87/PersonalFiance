"""Fetch recent Cboe daily put/call ratios without substituting fallback dates."""
from __future__ import annotations

import html as html_module
import json
import math
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "cboe_putcall.json"
BASE_URL = "https://www.cboe.com/markets/us/options/market-statistics/daily"
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; PersonalFiance market data fetcher)"}
RATIO_FIELDS = {
    "EQUITY PUT/CALL RATIO": "equity_pc",
    "SPX + SPXW PUT/CALL RATIO": "spx_pc",
    "TOTAL PUT/CALL RATIO": "total_pc",
    "INDEX PUT/CALL RATIO": "index_pc",
}


class NoDataError(ValueError):
    """The response is valid but contains no data for the requested trading day."""


def parse_cboe_html(page: str, requested_date: str) -> dict:
    decoded = html_module.unescape(page).replace('\\"', '"')
    dates = re.findall(r'"selectedDate"\s*:\s*"(\d{4}-\d{2}-\d{2})"', decoded)
    if not dates:
        raise ValueError("Cboe response has no selectedDate")
    actual_date = dates[-1]
    if actual_date != requested_date:
        raise NoDataError(f"Cboe returned {actual_date} for requested {requested_date}")
    if re.search(r'"ratios"\s*:\s*\[\s*\]', decoded):
        raise NoDataError("Cboe explicitly reports an empty ratios list")
    values = {}
    for name, field in RATIO_FIELDS.items():
        match = re.search(r'"name"\s*:\s*"' + re.escape(name) + r'"\s*,\s*"value"\s*:\s*"([0-9.]+)"', decoded)
        if not match:
            raise ValueError(f"missing ratio: {name}")
        value = float(match.group(1))
        if not math.isfinite(value) or value < 0:
            raise ValueError(f"invalid ratio: {name}")
        values[field] = value
    return {"date": actual_date, **values}


def _existing() -> dict:
    try:
        payload = json.loads(OUT.read_text())
        for row in payload.get("rows", []):
            date.fromisoformat(row["date"])
            for field in RATIO_FIELDS.values():
                if not math.isfinite(float(row[field])) or float(row[field]) < 0:
                    raise ValueError("invalid cached ratio")
        return payload
    except Exception:
        return {}


def merge_rows(existing_rows: list[dict], fresh_rows: list[dict]) -> list[dict]:
    by_date = {r["date"]: r for r in existing_rows}
    by_date.update({r["date"]: r for r in fresh_rows})
    return [by_date[key] for key in sorted(by_date)]


def _weekdays_back(end: date, count: int) -> list[date]:
    days = []
    cursor = end
    while len(days) < count:
        if cursor.weekday() < 5:
            days.append(cursor)
        cursor -= timedelta(days=1)
    return days


def _fetch(day: date) -> dict:
    requested = day.isoformat()
    response = requests.get(BASE_URL, params={"dt": requested}, headers=HEADERS, timeout=30)
    response.raise_for_status()
    return parse_cboe_html(response.text, requested)


def main() -> None:
    existing = _existing()
    target_count = 5 if existing.get("rows") else 20
    fresh = []
    errors = []
    # Ten extra weekdays keep the backfill bounded while allowing for holidays.
    for day in _weekdays_back(date.today(), target_count + 10):
        if len(fresh) >= target_count:
            break
        try:
            fresh.append(_fetch(day))
        except NoDataError:
            continue
        except Exception as exc:
            errors.append(f"{day.isoformat()}: {exc}")
    rows = merge_rows(existing.get("rows", []), fresh)
    status = "ok" if fresh and not errors else ("stale" if rows else "unavailable")
    payload = {
        "source": "Cboe",
        "source_url": BASE_URL,
        "updated": rows[-1]["date"] if rows else None,
        "fetched_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "status": status,
        "error": "; ".join(errors) or None,
        "rows": rows,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"Wrote {OUT.name}: {status}, {len(rows)} rows")


if __name__ == "__main__":
    main()
