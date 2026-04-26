"""Fetch S&P 500 monthly trailing P/E from multpl.com and save to data/SP500_PE.json.

Data goes back to ~1927. We use the monthly table.
"""
from __future__ import annotations

import json
import re
from datetime import date
from pathlib import Path

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "SP500_PE.json"

URL = "https://www.multpl.com/s-p-500-pe-ratio/table/by-month"
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; personal-finance-bot/1.0)"}


def fetch_pe_table() -> list[dict]:
    resp = requests.get(URL, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    table = soup.find("table", {"id": "datatable"})
    if not table:
        raise RuntimeError("datatable not found on multpl.com")

    rows = []
    for tr in table.find_all("tr"):
        cells = [td.get_text(strip=True) for td in tr.find_all("td")]
        if len(cells) < 2:
            continue
        date_str, val_str = cells[0], cells[1]

        # Parse date: "Apr 1, 2024" → "2024-04-01"
        try:
            d = date_str.strip()
            # Remove ordinal suffixes: 1st→1, 2nd→2, etc.
            d = re.sub(r"(\d+)(st|nd|rd|th)", r"\1", d)
            from datetime import datetime
            parsed = datetime.strptime(d, "%b %d, %Y")
            date_iso = parsed.strftime("%Y-%m-%d")
        except Exception:
            continue

        # Parse value: "29.50" or "29.50*"
        try:
            pe = float(re.sub(r"[^\d.]", "", val_str))
        except Exception:
            continue

        rows.append({"date": date_iso, "pe": pe})

    # Sort ascending by date
    rows.sort(key=lambda r: r["date"])
    return rows


def main() -> None:
    print("Fetching S&P 500 trailing P/E from multpl.com ...")
    rows = fetch_pe_table()
    if not rows:
        print("  No data returned.")
        return

    print(f"  Got {len(rows)} rows: {rows[0]['date']} → {rows[-1]['date']}")

    payload = {
        "updated": date.today().isoformat(),
        "note": "S&P 500 monthly trailing P/E (TTM). Source: multpl.com",
        "data": rows,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    print(f"  Wrote {len(rows)} rows -> {OUT.name}")


if __name__ == "__main__":
    main()
