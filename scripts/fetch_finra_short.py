"""FINRA Reg SHO 每日 short volume + 每月兩次空單餘額 → data/finra_shortvol.json /
data/finra_short_interest.json

Sources:
  FINRA Reg SHO daily consolidated (CNMS) short sale volume
    https://cdn.finra.org/equity/regsho/daily/CNMSshvol{YYYYMMDD}.txt
    pipe-delimited: Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market
    只取 SPY/QQQ。非交易日／不存在的檔回 403（不是 404）。
    [實測 2026-09-27] 最早可用 20180801；20180102/20120105/20160105/20190105 皆 403。
  FINRA consolidatedShortInterest API（免 auth）
    POST https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest
    body 不可帶 sortFields（回 400），回傳需自行排序。

Output data/finra_shortvol.json:
  {source, source_url, note, updated,
   data: [{date, SPY_sv, SPY_tv, QQQ_sv, QQQ_tv}]}   # 升冪、整數

Output data/finra_short_interest.json:
  {source, source_url, note, updated,
   data: [{date, SPY_si, SPY_dtc, QQQ_si, QQQ_dtc}]}  # date = settlementDate，升冪

A2 若任一 symbol 回空陣列或 HTTP 失敗：raise，保留舊檔（整列覆蓋會把舊值蓋成
null，同 CLAUDE.md 對多序列 FRED 腳本的規定）。A1 與 A2 互相獨立：A2 失敗不影響
A1 寫檔；最後 exit code 取兩者中較差的那個。
"""
from __future__ import annotations

import json
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path

import requests

import _common

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)

SHORTVOL_OUT = DATA_DIR / "finra_shortvol.json"
SHORT_INTEREST_OUT = DATA_DIR / "finra_short_interest.json"

UA = {"User-Agent": "PersonalFiance/1.0"}

SHORTVOL_URL = "https://cdn.finra.org/equity/regsho/daily/CNMSshvol{d}.txt"
SHORT_INTEREST_URL = "https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest"

SYMBOLS = ("SPY", "QQQ")
SHORTVOL_START = date(2018, 8, 1)
BACKFILL_DAYS = 5  # 存在時，從最後日期往回幾個日曆天重抓（讓 FINRA 修正值覆蓋舊值）
SLEEP_SEC = 0.15

SHORTVOL_NOTE = (
    "FINRA Reg SHO 每日合併(CNMS)short sale volume。short volume 多半是做市商"
    "對買單的避險(marking short 規則)，比率高通常代表買方主動、不是空頭在建倉；"
    "不是空單餘額(short interest)，兩者不可混用。"
)
SHORT_INTEREST_NOTE = (
    "FINRA 合併 OTC 空單餘額(consolidated short interest)，每月兩次(月中/月底"
    "結算)。currentShortPositionQuantity 為股數，daysToCoverQuantity(dtc) = "
    "空單股數 / 平均日成交量，數值越高代表回補所需天數越長、空單壓力越大。"
    "某個 symbol 在某日沒有資料時該欄位為 null。"
)


def _shortvol_day_url(d: date) -> str:
    return SHORTVOL_URL.format(d=d.strftime("%Y%m%d"))


def parse_shortvol_text(text: str) -> dict:
    """CNMSshvol{d}.txt (pipe-delimited) -> {"SPY": {"sv": int, "tv": int}, "QQQ": {...}}
    for whatever of SYMBOLS are present. Values are rounded to int (FINRA short
    volume carries a fractional-share decimal)."""
    out: dict = {}
    lines = text.splitlines()
    if not lines:
        return out
    header = lines[0].split("|")
    try:
        sym_idx = header.index("Symbol")
        sv_idx = header.index("ShortVolume")
        tv_idx = header.index("TotalVolume")
    except ValueError:
        return out
    for line in lines[1:]:
        if not line.strip():
            continue
        parts = line.split("|")
        if len(parts) <= max(sym_idx, sv_idx, tv_idx):
            continue
        sym = parts[sym_idx].strip()
        if sym not in SYMBOLS:
            continue
        try:
            sv = round(float(parts[sv_idx]))
            tv = round(float(parts[tv_idx]))
        except ValueError:
            continue
        out[sym] = {"sv": sv, "tv": tv}
    return out


def fetch_shortvol_day(d: date) -> "dict | None":
    """Return {"SPY": {...}, "QQQ": {...}} for one day, or None on a 403
    (non-trading day / not-yet-published file — not an error)."""

    def attempt():
        r = requests.get(_shortvol_day_url(d), headers=UA, timeout=30)
        time.sleep(SLEEP_SEC)
        if r.status_code == 403:
            return None
        r.raise_for_status()
        return r.text

    text = _common.retry_call(
        attempt,
        attempts=3,
        backoff=lambda a: 2 * (a + 1),
        retry_on=(requests.RequestException,),
    )
    if text is None:
        return None
    return parse_shortvol_text(text)


def business_days(start: date, end: date):
    yield from _common.weekday_dates(start, end)


def run_shortvol() -> int:
    """Returns 0 on success, 1 if >=1 non-403 day failed (data is still written)."""
    existing = _common.load_rows_by_date(SHORTVOL_OUT)
    today = date.today()

    if existing:
        last_date = max(existing.keys())
        start = datetime.strptime(last_date, "%Y-%m-%d").date() - timedelta(days=BACKFILL_DAYS)
        start = max(start, SHORTVOL_START)
    else:
        start = SHORTVOL_START

    days = list(business_days(start, today))
    print(f"  [finra_shortvol] fetching {len(days)} business day(s) from {start} to {today}")

    new_rows: dict[str, dict] = {}
    forbidden = 0
    failed = 0
    for d in days:
        try:
            day_data = fetch_shortvol_day(d)
        except Exception as exc:
            print(f"  [finra_shortvol] {d} FAILED ({exc}); skip")
            failed += 1
            continue
        if day_data is None:
            forbidden += 1
            continue
        if not day_data:
            continue
        row = {"date": d.isoformat()}
        for sym in SYMBOLS:
            if sym in day_data:
                row[f"{sym}_sv"] = day_data[sym]["sv"]
                row[f"{sym}_tv"] = day_data[sym]["tv"]
        new_rows[d.isoformat()] = row

    print(f"  [finra_shortvol] fetched {len(new_rows)} rows, {forbidden} non-trading (403), {failed} failed")

    merged = _common.idempotent_merge(SHORTVOL_OUT, list(new_rows.values()), key_field="date")
    payload = {
        "source": "FINRA Reg SHO daily short sale volume (CNMS consolidated)",
        "source_url": "https://cdn.finra.org/equity/regsho/daily/",
        "note": SHORTVOL_NOTE,
        "updated": today.isoformat(),
        "data": merged,
    }
    SHORTVOL_OUT.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    print(f"Wrote {SHORTVOL_OUT.name}: {len(merged)} rows")
    return 1 if failed > 0 else 0


def parse_short_interest(rows_spy: list, rows_qqq: list) -> list:
    """rows_spy / rows_qqq: raw (possibly unsorted) API record dicts, each with
    settlementDate / currentShortPositionQuantity / daysToCoverQuantity.
    Returns [{date, SPY_si, SPY_dtc, QQQ_si, QQQ_dtc}, ...] sorted ascending by
    date; a symbol missing a given date gets null for both its fields."""
    by_date: dict = {}
    for sym, rows in (("SPY", rows_spy), ("QQQ", rows_qqq)):
        for r in rows:
            d = r.get("settlementDate")
            if not d:
                continue
            entry = by_date.setdefault(d, {"date": d})
            si = r.get("currentShortPositionQuantity")
            dtc = r.get("daysToCoverQuantity")
            entry[f"{sym}_si"] = int(si) if si is not None else None
            entry[f"{sym}_dtc"] = float(dtc) if dtc is not None else None

    for d, entry in by_date.items():
        for sym in ("SPY", "QQQ"):
            entry.setdefault(f"{sym}_si", None)
            entry.setdefault(f"{sym}_dtc", None)

    return [by_date[d] for d in sorted(by_date)]


def fetch_short_interest_symbol(symbol: str) -> list:
    body = {
        "limit": 5000,
        "compareFilters": [{"compareType": "equal", "fieldName": "symbolCode", "fieldValue": symbol}],
    }
    r = requests.post(
        SHORT_INTEREST_URL,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        json=body,
        timeout=30,
    )
    r.raise_for_status()
    rows = r.json()
    if not isinstance(rows, list) or not rows:
        raise RuntimeError(f"FINRA short interest: {symbol} returned no rows")
    return rows


def run_short_interest() -> int:
    """Returns 0 on success. Raises on failure (caller keeps the old file)."""
    today = date.today()
    rows_spy = fetch_short_interest_symbol("SPY")
    rows_qqq = fetch_short_interest_symbol("QQQ")
    data = parse_short_interest(rows_spy, rows_qqq)

    payload = {
        "source": "FINRA consolidated OTC short interest (consolidatedShortInterest API)",
        "source_url": "https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest",
        "note": SHORT_INTEREST_NOTE,
        "updated": today.isoformat(),
        "data": data,
    }
    SHORT_INTEREST_OUT.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    print(f"Wrote {SHORT_INTEREST_OUT.name}: {len(data)} rows")
    return 0


def main() -> None:
    exit_code = 0
    try:
        exit_code = max(exit_code, run_shortvol())
    except Exception as exc:
        print(f"  [finra_shortvol] FATAL ({exc})")
        exit_code = 1

    try:
        run_short_interest()
    except Exception as exc:
        print(f"  [finra_short_interest] FAILED ({exc}); keeping existing file")
        exit_code = 1

    sys.exit(exit_code)


if __name__ == "__main__":
    main()
