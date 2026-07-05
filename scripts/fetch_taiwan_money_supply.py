"""Fetch Taiwan M1B / M2 monthly money aggregates from the Central Bank.

Source: CBC EBOOKXLS table 1 (重要金融指標) — Big5-encoded CSV that ships with
央行 monthly bulletin. Stable URL — same path each month, content refreshes.

The file mixes annual rows (民國 105-114 ≈ 2016-2025) and monthly rows for the
trailing ~24 months. Monthly rows continue with a blank 民國 year column — we
carry the last seen year forward.

We extract the period-end (期底) YoY growth rates for M1B and M2, which is the
standard 同比 series quoted by MacroMicro and most TW market commentary.
"""
from __future__ import annotations

import csv
import io
import json
import re
from datetime import date
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)

URL = "https://www.cbc.gov.tw/public/data/EBOOKXLS/001_EF01_A4L.csv"
HEADERS = {"User-Agent": "Mozilla/5.0 PersonalFiance/1.0"}

# Column indices (0-based) from the EBOOKXLS table 1 layout — verified against
# 105 annual row: M1B 期底 amount = col[15] / YoY = col[16] / M2 期底 amount =
# col[19] / YoY = col[20].
COL_M1B_AMT = 15
COL_M1B_YOY = 16
COL_M2_AMT  = 19
COL_M2_YOY  = 20


def _clean_num(s: str) -> float | None:
    s = (s or "").strip().replace(",", "")
    if not s or s == "-":
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _parse_period_label(cell: str) -> tuple[int | None, int | None]:
    """Parse the leading 民國年[月] cell.

    - "105      "         -> (105, None) annual
    - "113   10 "         -> (113, 10)   monthly
    - "      11 "         -> (None, 11)  monthly, carry year
    - "115 r  1 " / "p"   -> (115, 1)    revised/preliminary marker — strip
    - blank                -> (None, None)
    """
    s = cell.replace("　", " ").strip()
    if not s:
        return None, None
    # Strip r/p revision markers
    s = re.sub(r"[rp]", " ", s)
    parts = s.split()
    if not parts:
        return None, None
    if len(parts) == 1:
        # Either year only (3 digits) or month only (1-2 digits)
        try:
            n = int(parts[0])
        except ValueError:
            return None, None
        if n >= 100:
            return n, None  # annual row
        if 1 <= n <= 12:
            return None, n  # month row continuing prior year
        return None, None
    # Two tokens: year + month
    try:
        y = int(parts[0])
        m = int(parts[-1])
        if y >= 100 and 1 <= m <= 12:
            return y, m
    except ValueError:
        pass
    return None, None


def parse(csv_text: str) -> list[dict]:
    monthly: list[dict] = []
    annual:  list[dict] = []
    current_year: int | None = None

    reader = csv.reader(io.StringIO(csv_text))
    for row in reader:
        if not row or len(row) <= COL_M2_YOY:
            continue
        year, month = _parse_period_label(row[0])
        if year is not None:
            current_year = year
        if current_year is None:
            continue

        m1b_amt = _clean_num(row[COL_M1B_AMT])
        m1b_yoy = _clean_num(row[COL_M1B_YOY])
        m2_amt  = _clean_num(row[COL_M2_AMT])
        m2_yoy  = _clean_num(row[COL_M2_YOY])
        if m1b_yoy is None or m2_yoy is None:
            continue

        west_year = current_year + 1911
        spread = round(m1b_yoy - m2_yoy, 3)

        rec = {
            "m1b_amt": m1b_amt,
            "m1b_yoy": m1b_yoy,
            "m2_amt":  m2_amt,
            "m2_yoy":  m2_yoy,
            "spread":  spread,  # M1B同比 - M2同比 (黃柱 in MacroMicro chart)
        }

        if month is None:
            rec = {"date": f"{west_year}-12-31", "freq": "annual",  **rec}
            annual.append(rec)
        else:
            # End-of-month date — last day approximation, use first-of-next for chart x-axis cleanliness
            rec = {"date": f"{west_year}-{month:02d}-01", "freq": "monthly", **rec}
            monthly.append(rec)
    return monthly + annual


def main() -> None:
    print(f"Fetching {URL}")
    resp = requests.get(URL, timeout=60, headers=HEADERS)
    resp.raise_for_status()
    text = resp.content.decode("big5")
    rows = parse(text)
    if not rows:
        raise RuntimeError("no parsed rows")

    monthly = sorted([r for r in rows if r["freq"] == "monthly"], key=lambda r: r["date"])
    annual  = sorted([r for r in rows if r["freq"] == "annual"],  key=lambda r: r["date"])

    out = DATA_DIR / "taiwan_money_supply.json"
    payload = {
        "source":  "CBC EBOOKXLS 001_EF01_A4L (重要金融指標, 期底年增率)",
        "updated": date.today().isoformat(),
        "latest":  monthly[-1] if monthly else (annual[-1] if annual else None),
        "monthly": monthly,
        "annual":  annual,
    }
    out.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    print(f"Wrote {len(monthly)} monthly + {len(annual)} annual rows -> {out.name}")
    if monthly:
        print(f"  latest monthly: {monthly[-1]}")


if __name__ == "__main__":
    main()
