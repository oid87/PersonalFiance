"""Fetch South Korea 신용거래융자 (margin-trading balance, daily) → data/margin_global_kr.json

Source: KOFIA FreeSIS 신용공여현황 (Credit Extension Status) statistics API —
a plain JSON POST endpoint, no browser/session required, confirmed reachable
with a direct `requests.post` (no headless browser, no cookie dance):

  POST https://freesis.kofia.or.kr/meta/getMetaDataList.do
  Referer: https://freesis.kofia.or.kr/stat/FreeSIS.do?parentDivId=MSIS10000000000000&serviceId=STATSCU0100000070
  Body (JSON): {"dmSearch": {
      "tmpV40": "1000000", "tmpV41": "1", "tmpV1": "D",
      "tmpV45": "<start YYYYMMDD>", "tmpV46": "<end YYYYMMDD>",
      "OBJ_NM": "STATSCU0100000070BO"
  }}

Before the POST, this script does a best-effort GET of the FreeSIS landing
page to pick up a session cookie. This is defensive only — testing showed the
POST succeeds even with zero prior requests — so a failure of the GET step is
swallowed and does not block the POST.

Response JSON layout (confirmed live 2026-08-29): top-level key `ds1` holds
the row array; each row uses opaque `TMPV*` field names, mapped here as:
  TMPV1 = date (string YYYYMMDD)
  TMPV2 = 신용거래융자 全體 (KOSPI+KOSDAQ combined margin balance) → margin_balance
  TMPV3 = same, KOSPI (유가증권)                                   → kospi_balance
  TMPV4 = same, KOSDAQ                                             → kosdaq_balance
  TMPV5-9 = 신용거래대주 (margin-sell) and other fields, not used here
Unit: KRW million (백만원) for all balance fields.

`tmpV1: "D"` selects daily granularity. `tmpV45`/`tmpV46` are an inclusive
YYYYMMDD start/end range — unlike some other Asian-market fetchers in this
repo (e.g. fetch_margin_cn.py), this endpoint supports one large range query
directly; no day-by-day looping is needed.

Merge strategy (chosen: incremental, not full re-query every run): if
data/margin_global_kr.json does not exist yet, this script does one full
historical pull from 2000-01-01. On every subsequent run it only re-queries
the trailing 30 days (cheap, and covers any late-arriving/revised recent
rows) and unions those rows into the existing history by date, new
overwriting old. This avoids re-downloading ~6700 rows on every daily CI run
while still healing the last month of data if a prior run's tail was
incomplete.

Idempotent merge: existing rows are loaded first, freshly-fetched rows are
unioned in by date (new overwrites old), the result is re-sorted and
rewritten. If the fetch fails and there is an existing file on disk, the
exception propagates (caller — update_all.sh / CI — handles continue-on-error
style skipping); if there is no existing file, the exception also propagates
since there is nothing to fall back to.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)
OUT = DATA_DIR / "margin_global_kr.json"

LANDING_URL = (
    "https://freesis.kofia.or.kr/stat/FreeSIS.do"
    "?parentDivId=MSIS10000000000000&serviceId=STATSCU0100000070"
)
API_URL = "https://freesis.kofia.or.kr/meta/getMetaDataList.do"
OBJ_NM = "STATSCU0100000070BO"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Content-Type": "application/json; charset=UTF-8",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": LANDING_URL,
}

FULL_HISTORY_START = "20000101"
INCREMENTAL_LOOKBACK_DAYS = 30


def fetch_range(session: requests.Session, start_yyyymmdd: str, end_yyyymmdd: str) -> list[dict]:
    """POST a date-range query and return the raw ds1 row list."""
    body = {
        "dmSearch": {
            "tmpV40": "1000000",
            "tmpV41": "1",
            "tmpV1": "D",
            "tmpV45": start_yyyymmdd,
            "tmpV46": end_yyyymmdd,
            "OBJ_NM": OBJ_NM,
        }
    }
    resp = session.post(API_URL, headers=HEADERS, json=body, timeout=60)
    resp.raise_for_status()
    payload = resp.json()

    rows = payload.get("ds1")
    if rows is None:
        # Fall back: find whichever top-level key holds an array of dicts
        # containing a "TMPV1" field, in case the endpoint's key name shifts.
        for key, val in payload.items():
            if isinstance(val, list) and val and isinstance(val[0], dict) and "TMPV1" in val[0]:
                rows = val
                break
    if not isinstance(rows, list) or not rows or "TMPV1" not in rows[0]:
        raise RuntimeError(
            f"KOFIA FreeSIS response did not contain the expected TMPV1 row array; "
            f"top-level keys were {list(payload.keys())}"
        )
    return rows


def parse_rows(raw_rows: list[dict]) -> list[dict]:
    out: list[dict] = []
    for r in raw_rows:
        raw_date = r.get("TMPV1")
        if not raw_date:
            continue
        try:
            d = datetime.strptime(str(raw_date), "%Y%m%d").strftime("%Y-%m-%d")
        except ValueError:
            continue
        margin_balance = r.get("TMPV2")
        if margin_balance is None:
            continue
        out.append({
            "date": d,
            "margin_balance": margin_balance,
            "kospi_balance": r.get("TMPV3"),
            "kosdaq_balance": r.get("TMPV4"),
        })
    return out


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

    session = requests.Session()
    try:
        session.get(LANDING_URL, headers=HEADERS, timeout=30)
    except Exception as exc:
        print(f"  [landing GET] failed (non-fatal, POST is independent): {exc}")

    today = date.today()
    if existing:
        start = (today - timedelta(days=INCREMENTAL_LOOKBACK_DAYS)).strftime("%Y%m%d")
        mode = "incremental"
    else:
        start = FULL_HISTORY_START
        mode = "full history"
    end = today.strftime("%Y%m%d")

    raw_rows = fetch_range(session, start, end)
    fresh_rows = parse_rows(raw_rows)
    print(f"  [{mode}] fetched {len(fresh_rows)} rows ({start} .. {end})")

    if not fresh_rows and not existing:
        raise RuntimeError("KOFIA FreeSIS fetch returned no usable rows and no existing file to fall back on")

    merged: dict[str, dict] = dict(existing)
    for r in fresh_rows:
        merged[r["date"]] = r

    today_str = today.isoformat()
    data = [merged[d] for d in sorted(merged) if d <= today_str]

    payload = {
        "source": (
            "KOFIA FreeSIS 신용공여현황, "
            "https://freesis.kofia.or.kr/meta/getMetaDataList.do (OBJ_NM=STATSCU0100000070BO)"
        ),
        "note": (
            "margin_balance 取自 TMPV2(신용거래융자 全體,KOSPI+KOSDAQ合計),單位百萬韓元"
            "(KRW million),日頻。資料回溯至2000-01-04。指數對照建議用 ^KS11(KOSPI,yfinance),"
            "本檔不含指數資料。無需瀏覽器自動化,純HTTP POST。"
        ),
        "updated": today_str,
        "data": data,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    print(f"Wrote {OUT.name}: {len(data)} rows"
          + (f" · {data[0]['date']} .. {data[-1]['date']}" if data else ""))


if __name__ == "__main__":
    main()
