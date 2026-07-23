"""Fetch TAIFEX 三大法人-區分各期貨契約-依日期: 外資(及陸資) 台指期貨(TXF) 未平倉淨額.

Source: https://www.taifex.com.tw/cht/3/futContractsDateExcel  (POST, per-date HTML table)
This is the "Excel export" variant of the 三大法人 daily query page — same data as
the interactive page (https://www.taifex.com.tw/cht/3/futContractsDate) but a much
smaller HTML payload, easier to parse with BeautifulSoup (lxml/html5lib are not
installed in this environment, so pandas.read_html is unusable here).

Query is per single date + commodityId=TXF (臺股期貨 / big TAIEX futures).
Table layout per commodity block (3 rows: 自營商/投信/外資):
  first row : [序號, 商品名稱, 身份別, <12 numeric cols>]           (15 cells)
  next rows : [身份別, <12 numeric cols>]                          (13 cells)
The 12 numeric columns are:
  交易口數:  多方口數,多方金額, 空方口數,空方金額, 多空淨額口數,多空淨額金額
  未平倉餘額: 多方口數,多方金額, 空方口數,空方金額, 多空淨額口數,多空淨額金額
We want the LAST column (未平倉餘額 多空淨額 口數) for the 外資 row of the FIRST
commodity group returned (TXF, since we filter commodityId=TXF server-side).

Holidays / no-trading days return a "查無資料" HTML fragment — treated as skip,
not an error.

Output: data/taifex_foreign_oi.json
  {"source": "...", "note": "...", "updated": "...", "data": [{"date","tx_foreign_net_oi"}, ...]}
Idempotent: re-fetching overwrites rows for the same date (keyed by date).
"""
from __future__ import annotations

import json
import time
from datetime import date, datetime, timedelta
from pathlib import Path

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = DATA / "taifex_foreign_oi.json"

URL = "https://www.taifex.com.tw/cht/3/futContractsDateExcel"
REFERER = "https://www.taifex.com.tw/cht/3/futContractsDate"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Referer": REFERER,
}

BACKFILL_DAYS = 365          # ~1 year first pass (spec allows 1-2y; keep light to avoid getting blocked)
RECENT_DAYS = 10             # re-check window on incremental runs
REQUEST_DELAY = 0.8
RETRY_MAX = 3
RETRY_BACKOFF = 8
CONSEC_SKIP_PAUSE = 10       # after this many consecutive non-holiday failures, back off

SESSION = requests.Session()
SESSION.headers.update(HEADERS)


def fetch_day(dt: date) -> tuple[str, int | None]:
    """Returns (status, net_oi). status in {"ok","holiday","no_data","error"}."""
    payload = {
        "queryType": "2",
        "goDay": "",
        "doQuery": "1",
        "dateaddcnt": "",
        "queryDate": dt.strftime("%Y/%m/%d"),
        "commodityId": "TXF",
    }
    for attempt in range(RETRY_MAX):
        try:
            resp = SESSION.post(URL, data=payload, timeout=30)
            if resp.status_code == 429 or resp.status_code >= 500:
                time.sleep(RETRY_BACKOFF * (attempt + 1))
                continue
            if resp.status_code != 200:
                return "error", None

            html = resp.text
            if "查無資料" in html:
                return "holiday", None

            soup = BeautifulSoup(html, "html.parser")
            tbodies = soup.find_all("tbody")
            if len(tbodies) < 2:
                return "no_data", None
            trs = tbodies[1].find_all("tr")

            groups: list[dict] = []
            current: dict | None = None
            for tr in trs:
                texts = [td.get_text(strip=True) for td in tr.find_all("td")]
                if len(texts) == 15:
                    if current:
                        groups.append(current)
                    current = {"name": texts[1], "rows": {texts[2]: texts[3:15]}}
                elif len(texts) == 14:
                    if current:
                        groups.append(current)
                    current = {"name": texts[0], "rows": {texts[1]: texts[2:14]}}
                elif len(texts) == 13:
                    if current is None:
                        continue
                    current["rows"][texts[0]] = texts[1:13]
            if current:
                groups.append(current)

            if not groups:
                return "no_data", None

            # First group == TXF (server-side filtered by commodityId=TXF), before any
            # 期貨小計/期貨合計 aggregate rows.
            tx_group = groups[0]
            foreign_row = None
            for identity, nums in tx_group["rows"].items():
                if identity.startswith("外資") and "小計" not in identity and "合計" not in identity:
                    foreign_row = nums
                    break
            if foreign_row is None:
                return "no_data", None

            # nums layout (12 cols): [多方口數,多方金額,空方口數,空方金額,多空淨額口數,多空淨額金額,
            #                          未平倉多方口數,未平倉多方金額,未平倉空方口數,未平倉空方金額,
            #                          未平倉多空淨額口數,未平倉多空淨額金額]
            # index -2 = 未平倉餘額 多空淨額 口數 (what we want); index -1 is 金額 (NT$ thousand), not 口數.
            net_str = foreign_row[-2].replace(",", "")
            return "ok", int(net_str)
        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError):
            time.sleep(RETRY_BACKOFF * (attempt + 1))
        except Exception as e:
            print(f"  parse error {dt}: {e}")
            return "error", None
    return "error", None


def trading_dates(start: date, end: date) -> list[date]:
    out, d = [], start
    while d <= end:
        if d.weekday() < 5:
            out.append(d)
        d += timedelta(days=1)
    return out


def load_existing() -> dict[str, int]:
    if not OUT.exists():
        return {}
    try:
        payload = json.loads(OUT.read_text())
        return {row["date"]: row["tx_foreign_net_oi"] for row in payload.get("data", [])}
    except Exception:
        return {}


def save(by_date: dict[str, int], note: str) -> None:
    today = date.today()
    rows = sorted(
        ({"date": d, "tx_foreign_net_oi": v} for d, v in by_date.items() if d <= today.isoformat()),
        key=lambda r: r["date"],
    )
    OUT.write_text(json.dumps(
        {
            "source": "TAIFEX 三大法人-區分各期貨契約-依日期 (futContractsDateExcel), commodityId=TXF, 外資(及陸資)",
            "note": note,
            "updated": today.isoformat(),
            "data": rows,
        },
        ensure_ascii=False, indent=2,
    ))


def main() -> None:
    today = date.today()
    by_date = load_existing()

    if by_date:
        last = max(by_date.keys())
        start = datetime.strptime(last, "%Y-%m-%d").date() - timedelta(days=RECENT_DAYS)
        coverage_note = f"incremental refresh from {start.isoformat()}, existing history preserved"
    else:
        start = today - timedelta(days=BACKFILL_DAYS)
        coverage_note = f"first backfill window ~{BACKFILL_DAYS}d ({start.isoformat()} to {today.isoformat()})"

    dates = trading_dates(start, today)
    dates.reverse()  # newest-first:最近資料優先落檔,萬一中途中斷也先有近期可用資料
    print(f"Fetching TAIFEX TX foreign net OI for {len(dates)} weekdays ({start} -> {today}), newest-first")

    ok = holiday = errs = 0
    consec_err = 0
    example_url_tested = f"POST {URL} (Referer={REFERER})"
    print(f"Trying: {example_url_tested}")

    for i, dt in enumerate(dates):
        status, val = fetch_day(dt)
        if status == "ok":
            by_date[dt.strftime("%Y-%m-%d")] = val
            ok += 1
            consec_err = 0
        elif status == "holiday":
            holiday += 1
            consec_err = 0
        else:
            errs += 1
            consec_err += 1

        if (i + 1) % 30 == 0:
            print(f"  {i+1}/{len(dates)} (ok={ok} holiday={holiday} err={errs})")
            save(by_date, coverage_note)

        if consec_err >= CONSEC_SKIP_PAUSE:
            print(f"  {consec_err} consecutive errors at {dt}, pausing 30s...")
            save(by_date, coverage_note)
            time.sleep(30)
            consec_err = 0
        elif i < len(dates) - 1:
            time.sleep(REQUEST_DELAY)

    save(by_date, coverage_note)
    print(f"Done: ok={ok} holiday={holiday} err={errs} -> {OUT}")
    if by_date:
        last_date = max(by_date.keys())
        print(f"Last row: {last_date} tx_foreign_net_oi={by_date[last_date]}")
    else:
        print("No data collected — source likely unreachable/blocked. Writing empty dataset, not fabricating.")


if __name__ == "__main__":
    main()
