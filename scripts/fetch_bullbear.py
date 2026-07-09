"""Fetch Bull & Bear indicator components → data/bullbear.json

Six data series fetched fresh each run:
  1. NAAIM Exposure Index (manager positioning)   — naaim.org weekly (best-effort scrape)
  2. CFTC COT Leveraged Funds net (hedge funds)   — cftc.gov TFF report weekly
  3. ICE BofA HY OAS (credit stress)              — FRED BAMLH0A0HYM2 daily
  4. Fed SLOOS (credit tightening)                 — FRED DRTSCILM quarterly
  5. U.Mich Consumer Sentiment                     — FRED UMCSENT monthly
  6. Money Market Fund assets (cash positioning)   — FRED MMMFFAQ027S quarterly
     Proxy for NAAIM: high MMF = institutions parking cash = bearish positioning.

The front-end tab reads this plus existing breadth.json / SP500_PE.json / SP500.json
to compute an 8-component composite (percentile-rank 0–10 each, equal-weight average).
Each section degrades independently: if one source is down the existing data is kept.
"""
from __future__ import annotations

import csv
import io
import json
import re
import zipfile
from collections import OrderedDict
from datetime import date, datetime
from pathlib import Path

import pandas as pd
import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)
OUT = DATA_DIR / "bullbear.json"

UA = {"User-Agent": (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)}


# ── helpers ──────────────────────────────────────────────────────────────────

def load_existing() -> dict:
    if not OUT.exists():
        return {}
    try:
        return json.loads(OUT.read_text())
    except Exception:
        return {}


def fetch_fred_csv(series_id: str) -> list[dict]:
    """Download a FRED series as CSV → [{date, value}] sorted ascending."""
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}"
    resp = requests.get(url, timeout=30, headers=UA)
    resp.raise_for_status()
    rows = []
    for row in csv.DictReader(io.StringIO(resp.text)):
        d = row.get("DATE", "").strip()
        v = row.get(series_id, "").strip()
        if not d or v in (".", ""):
            continue
        try:
            rows.append({"date": d, "value": round(float(v), 4)})
        except ValueError:
            continue
    return sorted(rows, key=lambda x: x["date"])


# ── 1. NAAIM Exposure Index ─────────────────────────────────────────────────

NAAIM_URL = "https://www.naaim.org/programs/naaim-exposure-index/"

def _parse_naaim_table(html: str) -> list[dict]:
    """Extract NAAIM weekly readings from the HTML table on their page."""
    soup = BeautifulSoup(html, "lxml")
    rows = []
    for table in soup.find_all("table"):
        headers = [th.get_text(strip=True).lower() for th in table.find_all("th")]
        if not any("date" in h for h in headers):
            continue
        date_idx = next((i for i, h in enumerate(headers) if "date" in h), 0)
        mean_idx = next((i for i, h in enumerate(headers) if "mean" in h or "average" in h), None)
        if mean_idx is None:
            for i, h in enumerate(headers):
                if i != date_idx and any(k in h for k in ("number", "mean", "exposure")):
                    mean_idx = i
                    break
        if mean_idx is None and len(headers) >= 3:
            mean_idx = 2
        if mean_idx is None:
            continue
        for tr in table.find_all("tr")[1:]:
            cells = [td.get_text(strip=True) for td in tr.find_all(["td", "th"])]
            if len(cells) <= max(date_idx, mean_idx):
                continue
            raw_date = cells[date_idx]
            raw_mean = cells[mean_idx]
            try:
                dt = _parse_naaim_date(raw_date)
                mean = float(raw_mean.replace(",", "").replace("%", ""))
                rows.append({"date": dt, "mean": round(mean, 2)})
            except (ValueError, TypeError):
                continue
    return sorted(rows, key=lambda x: x["date"])


def _parse_naaim_date(s: str) -> str:
    """Try common NAAIM date formats → YYYY-MM-DD."""
    for fmt in ("%B %d, %Y", "%b %d, %Y", "%m/%d/%Y", "%m/%d/%y", "%Y-%m-%d"):
        try:
            return datetime.strptime(s.strip(), fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    raise ValueError(f"Cannot parse date: {s}")


def _parse_naaim_js(html: str) -> list[dict]:
    """Try to extract NAAIM data from embedded JavaScript chart data.

    NOTE: unused by fetch_naaim() as of 2026-07 — the naaim.org page embeds
    TWO date/value chart series back to back (NAAIM mean exposure AND an S&P
    500 overlay), both matched by this same regex. When merged by date in
    main(), the second (S&P 500) series clobbers the first, which is exactly
    how the previously-committed data/bullbear.json ended up with `mean`
    values like 5881/7483 (S&P 500 index points, not 0–200 exposure). Kept
    here only as a reference; do not wire back in without de-interleaving
    the two series first.
    """
    rows = []
    for match in re.finditer(r'\[(?:new\s+Date\(|Date\.UTC\()(\d{4}),\s*(\d+),\s*(\d+)\),\s*([\d.+-]+)\]', html):
        y, m, d, v = match.groups()
        dt = f"{y}-{int(m)+1:02d}-{int(d):02d}"
        rows.append({"date": dt, "mean": round(float(v), 2)})
    if rows:
        return sorted(rows, key=lambda x: x["date"])
    for match in re.finditer(r'\[(\d{13,}),\s*([\d.+-]+)\]', html):
        ts, v = match.groups()
        dt = datetime.utcfromtimestamp(int(ts) / 1000).strftime("%Y-%m-%d")
        rows.append({"date": dt, "mean": round(float(v), 2)})
    return sorted(rows, key=lambda x: x["date"])


NAAIM_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://naaim.org/",
}


def _find_naaim_history_link(html: str) -> str | None:
    """Look for a linked historical data export (xls/xlsx/csv) on the NAAIM page."""
    soup = BeautifulSoup(html, "lxml")
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if not re.search(r"\.(xlsx|xls|csv)(\?|$)", href, re.IGNORECASE):
            continue
        text = a.get_text(strip=True).lower()
        haystack = f"{href} {text}".lower()
        if any(kw in haystack for kw in ("export", "data", "history", "since", "inception", "here")):
            return href
    return None


def _parse_naaim_history_file(content: bytes, url: str) -> list[dict]:
    """Parse the NAAIM historical xls/xlsx/csv export → [{date, mean}] (Mean/Average Exposure)."""
    import pandas as pd

    if url.lower().split("?")[0].endswith(".csv"):
        df = pd.read_csv(io.BytesIO(content))
    else:
        df = pd.read_excel(io.BytesIO(content))
    df.columns = [str(c).strip() for c in df.columns]
    date_col = next((c for c in df.columns if "date" in c.lower()), None)
    mean_col = next((c for c in df.columns if "mean" in c.lower() or "average" in c.lower()), None)
    if date_col is None or mean_col is None:
        raise ValueError(f"expected Date/Mean columns not found: {list(df.columns)}")
    by_date: dict[str, dict] = {}
    for _, r in df.iterrows():
        try:
            dt = pd.to_datetime(r[date_col]).strftime("%Y-%m-%d")
            mean = round(float(r[mean_col]), 2)
        except (ValueError, TypeError):
            continue
        by_date[dt] = {"date": dt, "mean": mean}
    return sorted(by_date.values(), key=lambda x: x["date"])


def fetch_naaim() -> list[dict]:
    """Fetch NAAIM Exposure Index weekly readings (Mean/Average Exposure).

    Tries the linked historical export (xls/xlsx/csv, typically full history
    since 2006) first; falls back to the recent-weeks HTML table if no link
    is found or the download/parse fails.
    """
    resp = requests.get(NAAIM_URL, timeout=30, headers=NAAIM_HEADERS)
    resp.raise_for_status()
    html = resp.text

    link = _find_naaim_history_link(html)
    if link:
        try:
            file_url = link if link.startswith("http") else requests.compat.urljoin(NAAIM_URL, link)
            file_resp = requests.get(file_url, timeout=40, headers=NAAIM_HEADERS)
            file_resp.raise_for_status()
            rows = _parse_naaim_history_file(file_resp.content, file_url)
            if rows:
                print(f"  [NAAIM]  history file {file_url} -> {len(rows)} weeks")
                return rows
        except Exception as exc:
            print(f"  [NAAIM]  history file failed ({exc}); falling back to page table")

    return _parse_naaim_table(html)


# ── 2. CFTC COT — Leveraged Funds positioning in S&P 500 E-Mini ─────────────

CFTC_TFF_URL = "https://www.cftc.gov/files/dea/history/fut_fin_txt_{year}.zip"

def fetch_cot_es(years: int = 5) -> list[dict]:
    """Download CFTC TFF reports for recent years, extract Leveraged Funds net for ES."""
    all_rows = []
    current_year = date.today().year
    for y in range(current_year - years + 1, current_year + 1):
        url = CFTC_TFF_URL.format(year=y)
        try:
            resp = requests.get(url, timeout=60, headers=UA)
            if resp.status_code != 200:
                print(f"  [COT] {y}: HTTP {resp.status_code}, skipping")
                continue
            zf = zipfile.ZipFile(io.BytesIO(resp.content))
            txt_name = [n for n in zf.namelist() if n.endswith(".txt")][0]
            raw = zf.read(txt_name).decode("utf-8", errors="replace")
            df = pd.read_csv(io.StringIO(raw))
            df.columns = [c.strip().strip('"') for c in df.columns]
            # filter for S&P 500 E-Mini futures
            mask = df["Market_and_Exchange_Names"].str.contains("E-MINI S&P 500", case=False, na=False)
            es = df[mask].copy()
            if es.empty:
                mask = df["Market_and_Exchange_Names"].str.contains("S&P 500", case=False, na=False)
                es = df[mask].copy()
            for _, r in es.iterrows():
                d = str(r.get("Report_Date_as_YYYY-MM-DD", "")).strip()
                if not re.match(r"^\d{4}-\d{2}-\d{2}$", d):
                    continue
                try:
                    lev_l = int(r.get("Lev_Money_Positions_Long_All", 0))
                    lev_s = int(r.get("Lev_Money_Positions_Short_All", 0))
                    am_l = int(r.get("Asset_Mgr_Positions_Long_All", 0))
                    am_s = int(r.get("Asset_Mgr_Positions_Short_All", 0))
                    all_rows.append({
                        "date": d,
                        "lev_long": lev_l, "lev_short": lev_s, "lev_net": lev_l - lev_s,
                        "am_long": am_l, "am_short": am_s, "am_net": am_l - am_s,
                    })
                except (ValueError, TypeError):
                    continue
            print(f"  [COT] {y}: {len(es)} ES weeks")
        except Exception as exc:
            print(f"  [COT] {y}: FAILED ({exc})")
    seen = {}
    for r in all_rows:
        seen[r["date"]] = r
    return sorted(seen.values(), key=lambda x: x["date"])


# ── 3–5. FRED series ────────────────────────────────────────────────────────

FRED_SERIES = OrderedDict([
    ("BAMLH0A0HYM2", "hy_spread"),    # ICE BofA HY OAS (daily)
    ("DRTSCILM", "sloos"),             # SLOOS C&I loan tightening (quarterly)
    ("UMCSENT", "consumer"),           # U.Mich Consumer Sentiment (monthly)
    ("MMMFFAQ027S", "mmf"),            # Money Market Funds total assets (quarterly, $B)
                                       # proxy for institutional cash positioning (NAAIM替代)
                                       # high = defensive/bearish, low = risk-on/bullish
])


# ── main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    existing = load_existing()

    # 1. NAAIM
    naaim: list[dict] = existing.get("naaim", [])
    try:
        fresh = fetch_naaim()
        if fresh:
            by_date = {r["date"]: r for r in naaim}
            for r in fresh:
                by_date[r["date"]] = r
            naaim = sorted(by_date.values(), key=lambda x: x["date"])
            print(f"  [NAAIM]  {len(naaim)} weeks · latest {naaim[-1]['date']} mean={naaim[-1]['mean']}")
        else:
            print(f"  [NAAIM]  no data parsed from page; keeping {len(naaim)} existing")
    except Exception as exc:
        print(f"  [NAAIM]  FAILED ({exc}); keeping {len(naaim)} existing")

    # 2. CFTC COT
    cot: list[dict] = existing.get("cot", [])
    try:
        fresh = fetch_cot_es(years=5)
        if fresh:
            by_date = {r["date"]: r for r in cot}
            for r in fresh:
                by_date[r["date"]] = r
            cot = sorted(by_date.values(), key=lambda x: x["date"])
            print(f"  [COT]    {len(cot)} weeks · latest {cot[-1]['date']} lev_net={cot[-1]['lev_net']:,}")
        else:
            print(f"  [COT]    no ES data found; keeping {len(cot)} existing")
    except Exception as exc:
        if not cot:
            raise
        print(f"  [COT]    FAILED ({exc}); keeping {len(cot)} existing")

    # 3–5. FRED series
    fred_data: dict[str, list[dict]] = {}
    for series_id, key in FRED_SERIES.items():
        existing_series: list[dict] = existing.get(key, [])
        try:
            data = fetch_fred_csv(series_id)
            if data:
                by_date = {r["date"]: r for r in existing_series}
                for r in data:
                    by_date[r["date"]] = r
                data = sorted(by_date.values(), key=lambda x: x["date"])
                fred_data[key] = data
                latest = data[-1]
                print(f"  [{series_id:16}] {len(data)} obs · latest {latest['date']} = {latest['value']}")
            else:
                fred_data[key] = existing_series
                print(f"  [{series_id:16}] empty response; keeping {len(existing_series)} existing")
        except Exception as exc:
            fred_data[key] = existing_series
            print(f"  [{series_id:16}] FAILED ({exc}); keeping {len(existing_series)} existing")

    payload = {
        "source": ("NAAIM Exposure Index (naaim.org) · "
                    "CFTC COT TFF Leveraged Funds / Asset Managers (cftc.gov) · "
                    "FRED: BAMLH0A0HYM2 (ICE BofA HY OAS), DRTSCILM (SLOOS), "
                    "UMCSENT (UMich), MMMFFAQ027S (MMF assets)"),
        "note": ("Weekly NAAIM mean=% equity exposure (0–200). "
                 "Weekly COT lev_net/am_net = contracts (long−short). "
                 "HY spread in percentage points (OAS). "
                 "SLOOS = net % banks tightening (positive=tightening). "
                 "Consumer = UMich index (higher=more optimistic). "
                 "MMF = Money Market Fund total assets in $B (high=cash-heavy=bearish)."),
        "updated": date.today().isoformat(),
        "naaim": naaim,
        "cot": cot,
        **fred_data,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    ct = {k: len(v) for k, v in payload.items() if isinstance(v, list)}
    print(f"Wrote {OUT.name}: {ct}")


if __name__ == "__main__":
    main()
