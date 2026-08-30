"""Fetch China (SSE + SZSE) margin financing balance (daily) → data/margin_global_cn.json

Requires: pip install akshare (no API key needed).

Sources (via akshare, https://akshare.akfamily.xyz/):
  SSE  — ak.stock_margin_sse(start_date, end_date)
         supports a date-range query in one call. Field used: 融资余额
         (margin financing balance), int64, unit CNY (raw yuan, not 萬元/億元).
         信用交易日期 comes back as "YYYYMMDD" string, converted here to
         "YYYY-MM-DD".
  SZSE — ak.stock_margin_szse(date=...)
         single-day query only (no range param) — the returned DataFrame has
         exactly 1 row and does NOT include the date, so the date is tracked
         from the `date` argument passed in, not read back from the response.
         Field used: 融资余额, already numeric (akshare has stripped thousands
         separators). [實測 bug] On a non-trading day (weekend/holiday) the
         underlying API returns an empty payload, and akshare's own
         `temp_df.columns = [...]` assignment against a 0-row frame raises
         `ValueError: Length mismatch: Expected axis has 0 elements, new
         values have 6 elements`. This is NOT a network failure — it is the
         (only) available signal for "no trading this day" — so it is caught
         specifically and treated as a skip, not an error.

Output data/margin_global_cn.json:
  {source, note, updated,
   data: [{date, exchange, margin_balance, margin_buy, short_balance}]}

  margin_balance unit: CNY (raw yuan), daily. exchange is "SSE" or "SZSE" —
  the frontend must sum both exchanges per date to get the full SSE+SZSE
  China margin balance. SZSE rows are simply absent on non-trading days
  (not null-filled) — this is expected, not a data gap.

Range strategy:
  - First run (no existing data/margin_global_cn.json, or its `data` is
    empty): backfill 3 years. SSE is fetched in one range-query call. SZSE
    has no range query, so it is fetched by looping every weekday over the
    past 3 years, one API call per day (~750 calls), sleeping 0.3s between
    calls and printing progress so a long run doesn't look hung.
  - Subsequent runs (file already has data): incremental — only the last 14
    days. SSE still uses a single range-query call; SZSE loops over the
    weekdays in that 14-day window only (no throttling needed, small volume).

Idempotent merge: existing rows are re-unioned with freshly-fetched rows by
the (date, exchange) composite key; new values overwrite old ones for the
same key. A failure fetching one exchange does not prevent the other from
being fetched and written.
"""
from __future__ import annotations

import json
import time
from datetime import date, timedelta
from pathlib import Path

import akshare as ak

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)
OUT = DATA_DIR / "margin_global_cn.json"

BACKFILL_YEARS = 3
INCREMENTAL_DAYS = 14
SZSE_SLEEP_SEC = 0.3


def load_existing() -> dict:
    """Return {(date, exchange): row} from the existing output file, if any."""
    if not OUT.exists():
        return {}
    try:
        payload = json.loads(OUT.read_text())
        rows = payload.get("data", [])
        return {(r["date"], r["exchange"]): r for r in rows if r.get("date") and r.get("exchange")}
    except Exception:
        return {}


def weekdays_between(start: date, end: date) -> list[date]:
    days = []
    d = start
    while d <= end:
        if d.weekday() < 5:  # Mon-Fri
            days.append(d)
        d += timedelta(days=1)
    return days


def fetch_sse(start: date, end: date) -> list[dict]:
    """One range-query call → list of {date, exchange, margin_balance, ...}."""
    rows: list[dict] = []
    try:
        df = ak.stock_margin_sse(
            start_date=start.strftime("%Y%m%d"), end_date=end.strftime("%Y%m%d")
        )
    except Exception as exc:
        print(f"  [SSE] FAILED to fetch {start}..{end}: {exc}")
        return rows

    for _, r in df.iterrows():
        raw_date = str(r["信用交易日期"]).strip()
        if len(raw_date) != 8:
            continue
        d = f"{raw_date[0:4]}-{raw_date[4:6]}-{raw_date[6:8]}"
        rows.append(
            {
                "date": d,
                "exchange": "SSE",
                "margin_balance": int(r["融资余额"]),
                "margin_buy": int(r["融资买入额"]) if "融资买入额" in r else None,
                "short_balance": int(r["融券余量金额"]) if "融券余量金额" in r else None,
            }
        )
    print(f"  [SSE] {len(rows)} rows fetched for {start}..{end}")
    return rows


def fetch_szse_one_day(d: date) -> dict | None:
    """Single-day SZSE query. Returns a row dict, or None if non-trading day/failed."""
    date_str = d.strftime("%Y%m%d")
    try:
        df = ak.stock_margin_szse(date=date_str)
    except ValueError as exc:
        # [實測] known akshare bug on non-trading days: temp_df.columns = [...]
        # assigned against a 0-row DataFrame → "Length mismatch" ValueError.
        # This is the (only) signal for "no trading this day", not a real error.
        if "Length mismatch" in str(exc):
            print(f"  [SZSE] {d}: no trading (empty response) — skipped")
            return None
        print(f"  [SZSE] {d}: FAILED ({exc}) — skipped")
        return None
    except Exception as exc:
        print(f"  [SZSE] {d}: FAILED ({exc}) — skipped")
        return None

    if df is None or df.empty:
        print(f"  [SZSE] {d}: empty response — skipped")
        return None

    r = df.iloc[0]
    # [實測 2026-08-29] ak.stock_margin_szse's numeric columns are NOT raw yuan
    # (unlike stock_margin_sse's int64 columns) — they are in 億元 (100-million
    # yuan) units, e.g. 融资余额=12790.04 for 2026-08-27, which only makes sense
    # as ~1.28 trillion CNY once scaled — matching SSE's same-day magnitude
    # (~1.34 trillion). The original spec for this script wrongly assumed both
    # exchanges returned raw yuan; that assumption was never checked against
    # actual values (only column names), so scale here to raw yuan for
    # consistency with SSE's unit before the frontend sums the two exchanges.
    yuan_per_yi = 100_000_000
    return {
        "date": d.isoformat(),
        "exchange": "SZSE",
        "margin_balance": round(r["融资余额"] * yuan_per_yi),
        "margin_buy": round(r["融资买入额"] * yuan_per_yi) if "融资买入额" in r else None,
        "short_balance": round(r["融券余额"] * yuan_per_yi) if "融券余额" in r else None,
    }


def fetch_szse(start: date, end: date, throttle: bool) -> list[dict]:
    days = weekdays_between(start, end)
    rows: list[dict] = []
    total = len(days)
    for i, d in enumerate(days, 1):
        print(f"SZSE {d}: {i}/{total}")
        row = fetch_szse_one_day(d)
        if row is not None:
            rows.append(row)
        if throttle:
            time.sleep(SZSE_SLEEP_SEC)
    print(f"  [SZSE] {len(rows)} rows fetched for {start}..{end}")
    return rows


def main() -> None:
    existing = load_existing()
    first_run = len(existing) == 0

    today = date.today()
    if first_run:
        start = today.replace(year=today.year - BACKFILL_YEARS)
        print(f"First run: backfilling {BACKFILL_YEARS} years ({start} .. {today})")
    else:
        start = today - timedelta(days=INCREMENTAL_DAYS)
        print(f"Incremental run: fetching last {INCREMENTAL_DAYS} days ({start} .. {today})")

    sse_rows = fetch_sse(start, today)
    szse_rows = fetch_szse(start, today, throttle=first_run)

    merged = dict(existing)
    for row in sse_rows + szse_rows:
        merged[(row["date"], row["exchange"])] = row

    if not merged:
        raise RuntimeError("No SSE or SZSE data fetched and no existing margin_global_cn.json to fall back on")

    data = [merged[k] for k in sorted(merged, key=lambda k: (k[0], k[1]))]

    payload = {
        "source": "上交所 stock_margin_sse + 深交所 stock_margin_szse (via akshare 套件)",
        "note": (
            "margin_balance 單位人民幣元(CNY,原始單位,非萬元/億元),日頻。"
            "exchange 欄位區分 SSE(上交所)/SZSE(深交所),前端需自行依日期加總兩個交易所"
            "才是完整滬深融資餘額。深交所遇非交易日會被跳過(該日無此 exchange 的資料列,"
            "非資料缺漏)。首次執行回溯3年,之後每次增量抓最近14天。制度起點2010-03-31,"
            "本檔案未回溯到那麼早(見上述3年範圍限制)。"
        ),
        "updated": today.isoformat(),
        "data": data,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    n_sse = sum(1 for r in data if r["exchange"] == "SSE")
    n_szse = sum(1 for r in data if r["exchange"] == "SZSE")
    print(f"Wrote {OUT.name}: {len(data)} rows total (SSE={n_sse}, SZSE={n_szse})")


if __name__ == "__main__":
    main()
