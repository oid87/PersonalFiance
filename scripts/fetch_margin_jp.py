"""Fetch Japan margin-trading balances (信用取引残高, weekly) → data/margin_global_jp.json

Source: JPX (Japan Exchange Group) official weekly margin balance report,
fixed URL that is overwritten in place each week (no need to guess a
per-week filename):
  https://www.jpx.co.jp/english/markets/statistics-equities/margin/dreu2500000073zr-att/dreu25000000747j.xls

Referer page: https://www.jpx.co.jp/english/markets/statistics-equities/margin/06.html
A standard browser User-Agent is required; a Referer header was used during
manual testing and is kept here defensively (untested whether it's actually
required).

File format: legacy BIFF .xls, parsed with
    pandas.read_excel(path, header=None, engine="xlrd")
which needs the `xlrd` package (newer pandas dropped built-in .xls support).
Confirmed at test time: DataFrame shape ~(1233, 13), growing weekly.

Layout (0-indexed):
  - Rows 0-9 are multi-level headers/titles — skipped.
  - Data starts at row 10. Column 0 is the week-ending date (python
    datetime object). Reading stops at the first row where column 0 is not
    a valid datetime (NaN, or a trailing footnote row like "注:...").
  - Column map (of 13 total; only 0-7 are used here):
      0 = date
      1 = 売残高 (short/margin-sell balance) — shares, thousands
      2 = 売残高 — value, JPY million            → output: short_balance
      3 = 買残高 (margin-buy balance) — shares, thousands
      4 = 買残高 — value, JPY million            → output: margin_balance (target field)
      5 = 一般信用取引 (Negotiable margin) — shares
      6 = 一般信用取引 — value
      7 = 制度信用取引 (Standardized margin) — shares

First observation at test time: 2002-08-02. Latest observation grows each
week as JPX updates the file in place; this script does not hardcode an end
date — it just reads until the date column stops parsing.

Units: value fields are kept in their original unit, JPY million (百万円) —
NOT converted to yen or any other unit.

Idempotent merge: existing data/margin_global_jp.json rows are loaded first,
freshly-fetched rows are unioned in by date (new overwrites old), and the
result is re-sorted and rewritten. If the fetch fails and there is an
existing file on disk, the exception propagates WITHOUT touching/clearing
the existing file — the caller (update_all.sh, run with
continue-on-error-style handling) is expected to catch it and move on.
"""
from __future__ import annotations

import json
from datetime import date, datetime
from pathlib import Path

import pandas as pd
import requests

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)
OUT = DATA_DIR / "margin_global_jp.json"

URL = (
    "https://www.jpx.co.jp/english/markets/statistics-equities/margin/"
    "dreu2500000073zr-att/dreu25000000747j.xls"
)
REFERER = "https://www.jpx.co.jp/english/markets/statistics-equities/margin/06.html"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Referer": REFERER,
}

DATA_START_ROW = 10


def fetch_xls_bytes() -> bytes:
    resp = requests.get(URL, headers=HEADERS, timeout=60)
    resp.raise_for_status()
    return resp.content


def parse_rows(xls_bytes: bytes) -> list[dict]:
    df = pd.read_excel(pd.io.common.BytesIO(xls_bytes), header=None, engine="xlrd")

    rows: list[dict] = []
    for i in range(DATA_START_ROW, len(df)):
        raw_date = df.iat[i, 0]
        if not isinstance(raw_date, (datetime, pd.Timestamp)):
            break  # end of data (NaN, footnote text, etc.)
        d = raw_date.strftime("%Y-%m-%d")

        def num(col: int):
            v = df.iat[i, col] if col < df.shape[1] else None
            if v is None or (isinstance(v, float) and pd.isna(v)):
                return None
            try:
                return int(round(float(v)))
            except (TypeError, ValueError):
                return None

        rows.append({
            "date": d,
            "short_shares": num(1),
            "short_balance": num(2),
            "margin_shares": num(3),
            "margin_balance": num(4),
            "negotiable_shares": num(5),
            "negotiable_value": num(6),
            "standardized_shares": num(7),
        })
    return rows


def load_existing_rows() -> dict[str, dict]:
    if not OUT.exists():
        return {}
    try:
        payload = json.loads(OUT.read_text())
        return {r["date"]: r for r in payload.get("data", []) if r.get("date")}
    except Exception:
        return {}


def main() -> None:
    existing = load_existing_rows()

    try:
        fresh_rows = parse_rows(fetch_xls_bytes())
    except Exception:
        if existing:
            raise  # propagate; caller (update_all.sh) handles continue-on-error
        raise

    merged: dict[str, dict] = dict(existing)
    for r in fresh_rows:
        merged[r["date"]] = r

    today_str = date.today().isoformat()
    data = [merged[d] for d in sorted(merged) if d <= today_str]

    payload = {
        "source": (
            "JPX 信用取引残高 (Negotiable/Standardized), "
            "https://www.jpx.co.jp/english/markets/statistics-equities/margin/06.html"
        ),
        "note": (
            "融資餘額(margin_balance)取自「買残高 金額」欄,單位百萬日圓(JPY million),週頻。"
            "資料回溯至2002-08-02(JPX官方xls本身即為完整歷史,單一連續序列)。"
            "指數對照建議用 ^N225(yfinance),本檔不含指數資料。"
        ),
        "updated": today_str,
        "data": data,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    print(f"Wrote {OUT.name}: {len(data)} rows"
          + (f" · {data[0]['date']} .. {data[-1]['date']}" if data else ""))


if __name__ == "__main__":
    main()
