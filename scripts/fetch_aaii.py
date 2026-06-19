"""Fetch AAII Investor Sentiment Survey (weekly bullish / neutral / bearish).

Output: data/aaii.json  ->  {source, updated, data:[{date,bull,neutral,bear,spread}]}
  bull/neutral/bear are percentages (0-100); spread = bull - bear (net bullish).

Strategy (each source merged into the existing file; later sources win on a tie):
  1. results table  https://www.aaii.com/sentimentsurvey/sent_results  (~22 recent weeks)
  2. dataChart5 var on the main survey page                            (~52 recent weeks)
  3. official Excel https://www.aaii.com/files/surveys/sentiment.xls   (full history 1987-)

aaii.com bot-blocks many non-US IPs (returns a JS shell / 403). On GitHub Actions
US runners the live sources usually work; if source 3 succeeds it backfills the
whole series including any historical gap. If every live source fails we keep the
existing committed file untouched rather than wiping it.
"""
from __future__ import annotations

import io
import json
import re
from datetime import date, datetime
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "aaii.json"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.aaii.com/",
}

SURVEY_URL = "https://www.aaii.com/sentimentsurvey"
RESULTS_URL = "https://www.aaii.com/sentimentsurvey/sent_results"
XLS_URL = "https://www.aaii.com/files/surveys/sentiment.xls"


def _row(d: str, bull: float, neut: float, bear: float) -> dict:
    return {
        "date": d,
        "bull": round(bull, 1),
        "neutral": round(neut, 1),
        "bear": round(bear, 1),
        "spread": round(bull - bear, 1),
    }


def _pct(x: float) -> float:
    """Coerce a value that may be a fraction (0.36) or a percent (36.0) to percent."""
    x = float(x)
    return x * 100 if x <= 1.0 else x


def load_existing() -> list[dict]:
    if not OUT.exists():
        return []
    try:
        return json.loads(OUT.read_text()).get("data", [])
    except Exception:
        return []


def _parse_mon_day(s: str) -> str | None:
    """'May 6' / 'Jun 17' -> ISO, assuming current year (last year if it'd be future)."""
    s = s.strip()
    for fmt in ("%b %d", "%B %d"):
        try:
            cur = date.today()
            dt = datetime.strptime(f"{s} {cur.year}", f"{fmt} %Y").date()
            if dt > cur:
                dt = dt.replace(year=cur.year - 1)
            return dt.isoformat()
        except ValueError:
            continue
    return None


def fetch_results_table() -> list[dict]:
    html = requests.get(RESULTS_URL, headers=HEADERS, timeout=30).text
    rows = re.findall(
        r"<tr[^>]*>\s*"
        r"<td[^>]*>\s*([A-Za-z]{3,9}\s+\d{1,2})\s*</td>\s*"
        r"<td[^>]*>\s*([\d.]+)\s*%?\s*</td>\s*"
        r"<td[^>]*>\s*([\d.]+)\s*%?\s*</td>\s*"
        r"<td[^>]*>\s*([\d.]+)\s*%?\s*</td>",
        html, re.DOTALL,
    )
    out = []
    for d_str, b, n, br in rows:
        iso = _parse_mon_day(d_str)
        if iso:
            out.append(_row(iso, _pct(b), _pct(n), _pct(br)))
    print(f"  results table: {len(out)} weeks")
    return out


def fetch_datachart5() -> list[dict]:
    html = requests.get(SURVEY_URL, headers=HEADERS, timeout=30).text
    m = re.search(r"var\s+dataChart5\s*=\s*(\[[\s\S]*?\]);", html)
    if not m:
        print("  dataChart5: not present")
        return []
    raw = re.sub(r"(?<![\"'\w])(\w+):", r'"\1":', m.group(1))  # quote bare keys
    items = json.loads(raw)
    out = []
    for it in items:
        d = it.get("date_") or it.get("date")
        try:
            datetime.strptime(d, "%Y-%m-%d")
        except (ValueError, TypeError):
            continue
        try:
            out.append(_row(d, _pct(it["bullish"]), _pct(it["neutral"]), _pct(it["bearish"])))
        except (KeyError, ValueError, TypeError):
            continue
    print(f"  dataChart5: {len(out)} weeks")
    return out


def fetch_official_xls() -> list[dict]:
    import pandas as pd

    resp = requests.get(XLS_URL, headers=HEADERS, timeout=40)
    resp.raise_for_status()
    if resp.content[:4] not in (b"\xd0\xcf\x11\xe0", b"PK\x03\x04"):  # OLE2 / zip magic
        raise ValueError("not an Excel file (likely bot-block HTML)")
    sheet = 0
    try:
        xls = pd.ExcelFile(io.BytesIO(resp.content))
        sheet = "SENTIMENT" if "SENTIMENT" in xls.sheet_names else xls.sheet_names[0]
    except Exception:
        pass
    df = pd.read_excel(io.BytesIO(resp.content), sheet_name=sheet, header=3)
    df = df.rename(columns={df.columns[0]: "Date"})
    df["Date"] = pd.to_datetime(df["Date"], errors="coerce")
    df = df.dropna(subset=["Date"])
    bc, nc, brc = df.columns[1], df.columns[2], df.columns[3]
    out = []
    for _, r in df.iterrows():
        try:
            bull, neut, bear = _pct(r[bc]), _pct(r[nc]), _pct(r[brc])
        except (TypeError, ValueError):
            continue
        if 0 <= bull <= 100 and 0 <= bear <= 100:
            out.append(_row(r["Date"].date().isoformat(), bull, neut, bear))
    print(f"  official xls: {len(out)} weeks")
    return out


def _days_between(a: str, b: str) -> int:
    return abs((date.fromisoformat(a) - date.fromisoformat(b)).days)


def _add_unless_near(by_date: dict, r: dict, win: int = 3) -> None:
    """Add a row unless an entry already exists within `win` days (same survey week,
    different day-of-week convention between sources)."""
    if r["date"] in by_date:
        by_date[r["date"]] = r
        return
    if any(_days_between(r["date"], d) <= win for d in by_date):
        return
    by_date[r["date"]] = r


def main() -> None:
    existing = load_existing()
    print(f"Loaded {len(existing)} existing AAII rows")

    def try_fetch(label, fn):
        try:
            return fn() or []
        except Exception as exc:
            print(f"  WARN: {label} failed: {exc}")
            return []

    xls = try_fetch("official xls", fetch_official_xls)
    live = try_fetch("results", fetch_results_table) + try_fetch("dataChart5", fetch_datachart5)

    if xls:
        # The official Excel is the authoritative, gap-free full history. Use it as
        # the sole base and only let live sources add weeks newer than the xls max.
        by_date = {r["date"]: r for r in xls}
        xls_max = max(by_date)
        for r in live:
            if r["date"] > xls_max:
                _add_unless_near(by_date, r)
    elif live:
        # xls unavailable this run: keep committed history, refresh the tail.
        by_date = {r["date"]: r for r in existing}
        for r in sorted(live, key=lambda r: r["date"]):
            _add_unless_near(by_date, r)
    elif existing:
        print("All live sources failed; keeping existing file unchanged")
        return
    else:
        raise SystemExit("No AAII data from any source and no existing file")

    data = sorted(by_date.values(), key=lambda r: r["date"])
    payload = {
        "source": "AAII Investor Sentiment Survey (aaii.com live + official sentiment.xls)",
        "note": "Weekly. bull/neutral/bear are percentages; spread = bull - bear (net bullish).",
        "updated": date.today().isoformat(),
        "data": data,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    print(f"Wrote {len(data)} rows -> {OUT.name} (range {data[0]['date']}..{data[-1]['date']})")


if __name__ == "__main__":
    main()
