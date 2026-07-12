"""Fetch Cleveland Fed Inflation Nowcasting → data/infl_nowcast.json

Source: https://www.clevelandfed.org/indicators-and-data/inflation-nowcasting
Free, no key. The page server-renders three plain HTML <table> blocks (no JSON
API / CSV / xlsx download was found — checked for links containing
xlsx/csv/xls/json/api/download in the page and found none; the only downloads
are PDF methodology notes). Tables are parsed directly with BeautifulSoup,
matched by their <caption> text (not position) for robustness:

  1. "Inflation, month-over-month percent change"  → monthly MoM %
  2. "Inflation, year-over-year percent change"     → monthly YoY %
  3. "Quarterly annualized percent change"           → quarterly annualized %

Each table only ever shows the ~2 most recent target periods (no historical
archive on this page) — history here is built up by re-running this script
over time and merging into the existing JSON by date/quarter (same idempotent
merge pattern as fetch_fsi.py / fetch_inflation_exp.py).

⚠️ IMPORTANT — these are forward-looking nowcasts, not realized data:
"Nowcasting" by definition estimates inflation for the *current or very near*
month/quarter before BLS/BEA have released (or fully released) the official
CPI/PCE numbers. The page itself explains some target months stay populated
even after the calendar month has passed because the official release is
delayed (e.g. the page notes it substitutes its own nowcast "for October 2025
CPI in place of the BLS October 2025 CPI release" during a data-release gap).
So target dates in this dataset — including dates equal to or after the
fetch date — are NOT a future-leak bug; they are the whole point of the
indicator. This differs from most other tabs in this dashboard which enforce
a strict "no dates after today" rule for realized data; here the date field
means "the period this nowcast is FOR", not "the period this is already
known for". Anything consuming this file must treat it as an estimate, not
an actual, for any period at or after the fetch date.

Output (data/infl_nowcast.json):
  {source, note, updated,
   data: [{date, cpi_yoy, core_cpi_yoy, pce_yoy, core_pce_yoy,
           cpi_mom, core_cpi_mom, pce_mom, core_pce_mom, updated}],
   data_quarterly: [{quarter, cpi, core_cpi, pce, core_pce, updated}]}

  data[].date = target month, YYYY-MM-01 (the month the nowcast is estimating)
  data_quarterly[].quarter = target quarter, "YYYY-Qn"
  per-row "updated" = site's own "as of" date (MM/DD, year-disambiguated
    against today) for that specific figure; top-level "updated" = date this
    script ran.
"""
from __future__ import annotations

import json
import re
from datetime import date
from pathlib import Path

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)
OUT = DATA_DIR / "infl_nowcast.json"

URL = "https://www.clevelandfed.org/indicators-and-data/inflation-nowcasting"
UA = {"User-Agent": "PersonalFiance/1.0"}

MONTH_MAP = {
    "January": "01", "February": "02", "March": "03", "April": "04",
    "May": "05", "June": "06", "July": "07", "August": "08",
    "September": "09", "October": "10", "November": "11", "December": "12",
}


def parse_month_label(label: str) -> str | None:
    """'July 2026' -> '2026-07-01'"""
    m = re.match(r"^(\w+)\s+(\d{4})$", label.strip())
    if not m:
        return None
    mon, yr = m.groups()
    mm = MONTH_MAP.get(mon)
    if not mm:
        return None
    return f"{yr}-{mm}-01"


def parse_updated(mmdd: str, today: date) -> str | None:
    """'07/10' -> ISO date, assuming current year unless that would be in the
    future relative to `today`, in which case assume prior year (year-boundary
    edge case)."""
    m = re.match(r"^(\d{2})/(\d{2})$", mmdd.strip())
    if not m:
        return None
    mm, dd = m.groups()
    try:
        d = date(today.year, int(mm), int(dd))
    except ValueError:
        return None
    if d > today:
        try:
            d = date(today.year - 1, int(mm), int(dd))
        except ValueError:
            return None
    return d.isoformat()


def find_table(soup: BeautifulSoup, caption_substr: str):
    for t in soup.find_all("table"):
        cap = t.find("caption")
        if cap and caption_substr in cap.get_text(strip=True):
            return t
    return None


def parse_monthly_table(table, cols: list[str], today: date) -> dict[str, dict]:
    """cols = output keys for CPI, Core CPI, PCE, Core PCE (in that column order)."""
    out: dict[str, dict] = {}
    if table is None:
        return out
    tbody = table.find("tbody")
    if tbody is None:
        return out
    for tr in tbody.find_all("tr"):
        tds = [td.get_text(strip=True) for td in tr.find_all("td")]
        if len(tds) != 6:
            continue
        month_label, cpi, core_cpi, pce, core_pce, updated_raw = tds
        d = parse_month_label(month_label)
        if d is None:
            continue
        rec: dict = {"date": d}
        for key, raw in zip(cols, (cpi, core_cpi, pce, core_pce)):
            raw = raw.strip()
            if raw in ("", "-", "N/A"):
                continue
            try:
                rec[key] = float(raw)
            except ValueError:
                continue
        upd = parse_updated(updated_raw, today)
        if upd:
            rec["updated"] = upd
        if len(rec) > 1:
            out[d] = rec
    return out


def parse_quarterly_table(table, today: date) -> dict[str, dict]:
    out: dict[str, dict] = {}
    if table is None:
        return out
    tbody = table.find("tbody")
    if tbody is None:
        return out
    for tr in tbody.find_all("tr"):
        tds = [td.get_text(strip=True) for td in tr.find_all("td")]
        if len(tds) != 6:
            continue
        q_label, cpi, core_cpi, pce, core_pce, updated_raw = tds
        m = re.match(r"^(\d{4}):Q(\d)$", q_label.strip())
        if not m:
            continue
        q = f"{m.group(1)}-Q{m.group(2)}"
        rec: dict = {"quarter": q}
        for key, raw in zip(("cpi", "core_cpi", "pce", "core_pce"),
                             (cpi, core_cpi, pce, core_pce)):
            raw = raw.strip()
            if raw in ("", "-", "N/A"):
                continue
            try:
                rec[key] = float(raw)
            except ValueError:
                continue
        upd = parse_updated(updated_raw, today)
        if upd:
            rec["updated"] = upd
        if len(rec) > 1:
            out[q] = rec
    return out


def load_existing() -> tuple[dict[str, dict], dict[str, dict]]:
    if not OUT.exists():
        return {}, {}
    try:
        payload = json.loads(OUT.read_text())
        monthly = {r["date"]: r for r in payload.get("data", []) if r.get("date")}
        quarterly = {r["quarter"]: r for r in payload.get("data_quarterly", []) if r.get("quarter")}
        return monthly, quarterly
    except Exception:
        return {}, {}


def main() -> None:
    today = date.today()
    existing_monthly, existing_quarterly = load_existing()

    try:
        resp = requests.get(URL, timeout=30, headers=UA)
        print(f"  GET {URL} -> {resp.status_code}")
        resp.raise_for_status()
    except Exception as exc:
        print(f"  FAILED: {exc}")
        payload = {
            "source": "Federal Reserve Bank of Cleveland — Inflation Nowcasting",
            "note": ("資料源不可得(fetch failed: %s)。此頁面應含月/季 CPI+PCE nowcast，"
                      "本次抓取失敗，未編造資料。data 為空。" % exc),
            "updated": today.isoformat(),
            "data": [],
            "data_quarterly": [],
        }
        OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
        print(f"Wrote {OUT.name}: 0 rows (source unreachable)")
        return

    soup = BeautifulSoup(resp.text, "html.parser")

    mom_table = find_table(soup, "month-over-month percent change")
    yoy_table = find_table(soup, "year-over-year percent change")
    q_table = find_table(soup, "Quarterly annualized percent change")
    print(f"  tables found: mom={mom_table is not None} yoy={yoy_table is not None} "
          f"quarterly={q_table is not None}")

    mom = parse_monthly_table(mom_table, ["cpi_mom", "core_cpi_mom", "pce_mom", "core_pce_mom"], today)
    yoy = parse_monthly_table(yoy_table, ["cpi_yoy", "core_cpi_yoy", "pce_yoy", "core_pce_yoy"], today)
    qtr = parse_quarterly_table(q_table, today)

    if not mom and not yoy and not qtr:
        if existing_monthly or existing_quarterly:
            print("  All tables empty/unparsed; keeping existing data")
            return
        payload = {
            "source": "Federal Reserve Bank of Cleveland — Inflation Nowcasting",
            "note": "資料源不可得:頁面抓到但三張表格皆解析失敗（頁面結構可能已改版）。data 為空，未編造資料。",
            "updated": today.isoformat(),
            "data": [],
            "data_quarterly": [],
        }
        OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
        print(f"Wrote {OUT.name}: 0 rows (parse failed)")
        return

    # merge monthly: combine mom+yoy per date, overlay onto existing
    monthly = dict(existing_monthly)
    all_month_dates = set(mom) | set(yoy)
    for d in all_month_dates:
        rec = dict(monthly.get(d, {"date": d}))
        rec.update(mom.get(d, {}))
        rec.update(yoy.get(d, {}))  # yoy's own "updated" wins if both present (same site date anyway)
        monthly[d] = rec

    quarterly = dict(existing_quarterly)
    for q, rec in qtr.items():
        quarterly[q] = rec

    data = [monthly[d] for d in sorted(monthly)]
    data_quarterly = [quarterly[q] for q in sorted(quarterly)]

    if data:
        last = data[-1]
        print(f"  Latest monthly ({last['date']}): "
              f"CPI YoY={last.get('cpi_yoy')} Core CPI YoY={last.get('core_cpi_yoy')} "
              f"PCE YoY={last.get('pce_yoy')} Core PCE YoY={last.get('core_pce_yoy')}")
    if data_quarterly:
        lastq = data_quarterly[-1]
        print(f"  Latest quarterly ({lastq['quarter']}): "
              f"CPI={lastq.get('cpi')} Core CPI={lastq.get('core_cpi')} "
              f"PCE={lastq.get('pce')} Core PCE={lastq.get('core_pce')}")
    print(f"  Total: {len(data)} monthly rows, {len(data_quarterly)} quarterly rows")

    payload = {
        "source": "Federal Reserve Bank of Cleveland — Inflation Nowcasting "
                   "(clevelandfed.org/indicators-and-data/inflation-nowcasting)",
        "note": (
            "月/季 CPI、PCE nowcast（含核心）。⚠️這是對『當月/當季』甚至部分尚未結束期間的"
            "模型預估值，不是已公布的實際數據——這是 nowcasting 指標本身的定義，date/quarter"
            "欄位代表『預估的目標期間』而非『已實現的期間』，即使該期間等於或晚於抓取當下的日期"
            "也是預期行為（頁面本身也會用 nowcast 暫代因公布延遲而缺漏的官方數據，例如曾用"
            "nowcast 取代延遲公布的 2025-10 CPI）。與本 dashboard 其他 tab『不存未來日期』的"
            "慣例不同，下游若要用這份資料，需明確標示為『預估』而非『實績』。"
            "頁面本身只顯示最近 1-2 期，無歷史封存；本檔靠每次執行合併累積歷史。"
        ),
        "updated": today.isoformat(),
        "data": data,
        "data_quarterly": data_quarterly,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    print(f"Wrote {OUT.name}: {len(data)} monthly rows, {len(data_quarterly)} quarterly rows")


if __name__ == "__main__":
    main()
