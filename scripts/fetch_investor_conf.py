"""Fetch 法說日 (investor conference) dates from MOPS for target TW stocks.

Merges type=conference entries into data/earnings.json alongside earnings entries.
Fetches previous month, current month, and next 2 months.
Runs with continue-on-error in CI — MOPS can be flaky.
"""
from __future__ import annotations

import json
import re
import time
from datetime import date
from pathlib import Path

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)

# 4-digit stock code → display name
TARGET_CODES: dict[str, str] = {
    "2308": "台達電",
    "2454": "聯發科",
    "2317": "鴻海",
}

MOPS_URL = "https://mops.twse.com.tw/mops/web/ajax_t100sb14"
HEADERS = {
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "User-Agent": "Mozilla/5.0 (compatible; financial-dashboard/1.0)",
    "Referer": "https://mops.twse.com.tw/mops/web/t100sb14",
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "zh-TW,zh;q=0.9",
}


def roc_year(y: int) -> int:
    return y - 1911


def parse_roc_date(text: str) -> str | None:
    """Parse ROC date string (115/05/08) → ISO 8601 (2026-05-08)."""
    m = re.search(r"(\d{3})/(\d{1,2})/(\d{1,2})", text)
    if not m:
        return None
    return f"{int(m.group(1)) + 1911}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"


def fetch_conf_month(year: int, month: int) -> list[dict]:
    """Fetch investor conferences for one month from MOPS."""
    roc = roc_year(year)
    payload = (
        f"encodeURIComponent=1&step=1&firstin=1"
        f"&TYPEK=sii&year={roc}&month={month}"
    )
    try:
        resp = requests.post(MOPS_URL, data=payload, headers=HEADERS, timeout=25)
        resp.raise_for_status()
        resp.encoding = "utf-8"
    except Exception as exc:
        print(f"  MOPS request failed {year}-{month:02d}: {exc}")
        return []

    soup = BeautifulSoup(resp.text, "lxml")
    results: list[dict] = []
    seen: set[str] = set()

    for tr in soup.find_all("tr"):
        cells = [td.get_text(strip=True) for td in tr.find_all("td")]
        if not cells:
            continue

        # Find target stock code as an exact cell value
        found_code = next((c for c in cells if c in TARGET_CODES), None)
        if not found_code:
            continue

        # Find all ROC dates in this row; prefer 2nd one (conference date vs announcement date)
        row_text = " ".join(cells)
        dates_found = re.findall(r"\d{3}/\d{1,2}/\d{1,2}", row_text)
        raw_date = dates_found[1] if len(dates_found) >= 2 else (dates_found[0] if dates_found else None)
        if not raw_date:
            continue

        date_str = parse_roc_date(raw_date)
        if not date_str:
            continue

        key = f"{found_code}|{date_str}"
        if key not in seen:
            seen.add(key)
            results.append({
                "date": date_str,
                "ticker": found_code,
                "name": TARGET_CODES[found_code],
                "type": "conference",
            })

    print(f"  MOPS {year}-{month:02d}: {len(results)} conference entries")
    return results


def months_to_fetch() -> list[tuple[int, int]]:
    """Return (year, month) tuples for prev month, current, +1, +2."""
    today = date.today()
    result = []
    for delta in (-1, 0, 1, 2):
        m = today.month + delta
        y = today.year
        while m < 1:
            m += 12; y -= 1
        while m > 12:
            m -= 12; y += 1
        result.append((y, m))
    return result


def main() -> None:
    out = DATA_DIR / "earnings.json"
    existing_by_key: dict[str, dict] = {}

    if out.exists():
        try:
            old = json.loads(out.read_text()).get("data", [])
            for r in old:
                existing_by_key[f"{r['ticker']}|{r['date']}"] = r
        except Exception:
            pass

    all_conf: list[dict] = []
    for year, month in months_to_fetch():
        rows = fetch_conf_month(year, month)
        all_conf.extend(rows)
        time.sleep(1.0)

    # Merge: conference entries override existing conference entries for same key
    merged: dict[str, dict] = {**existing_by_key}
    for r in all_conf:
        merged[f"{r['ticker']}|{r['date']}"] = r

    result = sorted(merged.values(), key=lambda x: x["date"])

    payload = {
        "updated": date.today().isoformat(),
        "data": result,
    }
    out.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    print(f"Wrote {len(result)} total entries ({len(all_conf)} conference) -> {out.name}")


if __name__ == "__main__":
    main()
