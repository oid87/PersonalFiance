"""Fetch Shiller CAPE (P/E10) from Yale directly via Excel.

Uses xlrd to parse the legacy .xls file. No API key required.
Data updated monthly by Shiller's team.
"""
from __future__ import annotations

import json
import math
from datetime import date
from pathlib import Path

import requests
import xlrd

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)

YALE_URL = "http://www.econ.yale.edu/~shiller/data/ie_data.xls"
CAPE_COL = 12   # 0-indexed; column header "CAPE" in row 7 of the "Data" sheet
DATE_COL = 0
HEADER_ROW = 8  # first data row (0-indexed)


def fetch_cape() -> list[dict]:
    resp = requests.get(YALE_URL, timeout=60, headers={"User-Agent": "PersonalFiance/1.0"})
    resp.raise_for_status()
    wb = xlrd.open_workbook(file_contents=resp.content)
    ws = wb.sheet_by_name("Data")

    rows = []
    for r in range(HEADER_ROW, ws.nrows):
        date_val = ws.cell_value(r, DATE_COL)
        cape_val = ws.cell_value(r, CAPE_COL)

        if not date_val or not cape_val or isinstance(date_val, str):
            continue
        try:
            date_f = float(date_val)
            year   = int(date_f)
            month  = round((date_f - year) * 100)
            if not (1 <= month <= 12):
                continue
            date_str = f"{year:04d}-{month:02d}-01"
        except (ValueError, TypeError):
            continue

        try:
            v = float(cape_val)
            if math.isnan(v) or v <= 0:
                continue
            rows.append({"date": date_str, "value": round(v, 2)})
        except (ValueError, TypeError):
            continue

    return sorted(rows, key=lambda r: r["date"])


def main() -> None:
    print("Fetching Shiller CAPE from Yale ...")
    rows = fetch_cape()
    out  = DATA_DIR / "CAPE.json"
    out.write_text(json.dumps({
        "symbol":  "CAPE",
        "updated": date.today().isoformat(),
        "data":    rows,
    }, ensure_ascii=False) + "\n")
    print(f"  wrote {len(rows)} rows -> {out.name}")


if __name__ == "__main__":
    main()
