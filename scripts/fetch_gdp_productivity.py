"""Fetch US real GDP / labor productivity / labor force data from FRED (no API key
required) and compute per-period CAGR (annualized growth rate) for each series.

→ data/us_gdp_productivity_decomp.json

Why: a popular Goldman Sachs slide breaks "potential GDP growth" into GDP /
productivity / labor-force contributions across a few historical eras. The three
underlying series are all free FRED data — this script recomputes the same shape
of breakdown directly from FRED with a simple CAGR method, without attempting to
reproduce Goldman's proprietary adjustments (e.g. an "AI investment not yet fully
measured" add-on term that free data cannot replicate).

Sources (FRED public CSV endpoint, no key required):
  GDPC1    — Real Gross Domestic Product (chained 2012 dollars, quarterly, 1947Q1+)
  OPHNFB   — Nonfarm Business Sector: Labor Productivity (Index 2017=100, quarterly, 1947Q1+)
  CLF16OV  — Civilian Labor Force, 16 years and over (thousands, monthly, 1948-01+)
             Resampled to quarterly by taking the value of the LAST month of each
             quarter (Mar/Jun/Sep/Dec), so it lines up with the quarterly GDPC1/
             OPHNFB observation dates.

CAGR formula (applied identically to all three series, over each period):
  cagr = (end_value / start_value) ** (1 / years) - 1
  where `years` is the exact number of years between the period's start and end
  quarter-start dates (quarters_between / 4), and `cagr` is reported as a percentage
  (cagr * 100).

Periods (calendar-year quarter boundaries, all using each series' Q1 observation
except the last period's end, which uses the latest quarter common to all three
series):
  1950-1980   : 1950-01-01 → 1980-01-01
  1980-2007   : 1980-01-01 → 2007-01-01
  2007-2019   : 2007-01-01 → 2019-01-01
  2020-latest : 2020-01-01 → latest common quarter across GDPC1/OPHNFB/CLF16OV

Output data/us_gdp_productivity_decomp.json:
  {updated, note,
   periods: [{period, gdp_cagr, productivity_cagr, labor_force_cagr}, ...]}  # 4 entries

This is low-frequency (quarterly/monthly) data — cheap to re-run. Idempotent: same-day
reruns simply overwrite the same output file. Historical CAGRs are expected to be
stable across reruns unless FRED revises historical GDPC1/OPHNFB/CLF16OV values, in
which case the recomputed numbers naturally change — no special handling needed.
"""
from __future__ import annotations

import csv
import io
import json
from datetime import date
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)
OUT = DATA_DIR / "us_gdp_productivity_decomp.json"

FRED_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}"
UA = {"User-Agent": "PersonalFiance/1.0"}

DISCLAIMER = (
    "用FRED公開數據以簡單CAGR法計算,非高盛原始調整方法論"
    "(高盛原圖另含「未被完整衡量的AI投資貢獻」等調整項),量級可能有落差。"
)

# (period_label, start_date, end_date_or_None)  end_date=None → 用最新可得共同季度
PERIOD_BOUNDS = [
    ("1950-1980", "1950-01-01", "1980-01-01"),
    ("1980-2007", "1980-01-01", "2007-01-01"),
    ("2007-2019", "2007-01-01", "2019-01-01"),
]


def fetch_series(series_id: str) -> dict[str, float]:
    """Return {YYYY-MM-DD: value} for one FRED series, skipping missing ('.') obs."""
    resp = requests.get(FRED_URL.format(sid=series_id), timeout=30, headers=UA)
    resp.raise_for_status()
    by_date: dict[str, float] = {}
    for row in csv.DictReader(io.StringIO(resp.text)):
        d = (row.get("observation_date") or "").strip()
        v = (row.get(series_id) or "").strip()
        if not d or v in ("", "."):
            continue
        try:
            by_date[d] = float(v)
        except ValueError:
            continue
    return by_date


def quarter_last_month(quarter_start: str) -> str:
    """'1950-01-01' (Q1 start) -> '1950-03-01' (Q1's last month)."""
    y, m, _ = quarter_start.split("-")
    m = int(m)
    last_month = m + 2  # Jan->Mar, Apr->Jun, Jul->Sep, Oct->Dec
    return f"{y}-{last_month:02d}-01"


def cagr(start_val: float, end_val: float, start_date: str, end_date: str) -> float:
    """(end/start)**(1/years) - 1, expressed as a percentage."""
    sy, sm, _ = (int(x) for x in start_date.split("-"))
    ey, em, _ = (int(x) for x in end_date.split("-"))
    quarters = (ey - sy) * 4 + (em - sm) / 3
    years = quarters / 4
    return ((end_val / start_val) ** (1 / years) - 1) * 100


def main() -> None:
    print("Fetching GDP / productivity / labor force data from FRED ...")
    gdp = fetch_series("GDPC1")
    prod = fetch_series("OPHNFB")
    labor_monthly = fetch_series("CLF16OV")

    # 最新可得共同季度:GDPC1 與 OPHNFB 的季度日期本身就對齊(FRED 官方同頻序列);
    # 再確認該季度對應的 labor force 季末月份也有值。
    common_quarters = sorted(set(gdp) & set(prod))
    latest_quarter = None
    for q in reversed(common_quarters):
        if quarter_last_month(q) in labor_monthly:
            latest_quarter = q
            break
    if latest_quarter is None:
        raise RuntimeError("no common quarter with GDP + productivity + labor force data")

    bounds = PERIOD_BOUNDS + [("2020-latest", "2020-01-01", latest_quarter)]

    periods = []
    for label, start_d, end_d in bounds:
        if start_d not in gdp or end_d not in gdp:
            raise RuntimeError(f"[{label}] GDPC1 missing boundary date(s): {start_d} / {end_d}")
        if start_d not in prod or end_d not in prod:
            raise RuntimeError(f"[{label}] OPHNFB missing boundary date(s): {start_d} / {end_d}")
        lf_start_m, lf_end_m = quarter_last_month(start_d), quarter_last_month(end_d)
        if lf_start_m not in labor_monthly or lf_end_m not in labor_monthly:
            raise RuntimeError(f"[{label}] CLF16OV missing boundary month(s): {lf_start_m} / {lf_end_m}")

        gdp_cagr = cagr(gdp[start_d], gdp[end_d], start_d, end_d)
        prod_cagr = cagr(prod[start_d], prod[end_d], start_d, end_d)
        lf_cagr = cagr(labor_monthly[lf_start_m], labor_monthly[lf_end_m], start_d, end_d)

        periods.append({
            "period": label,
            "gdp_cagr": round(gdp_cagr, 3),
            "productivity_cagr": round(prod_cagr, 3),
            "labor_force_cagr": round(lf_cagr, 3),
        })
        print(f"  [{label}] GDP {gdp_cagr:+.2f}% · Productivity {prod_cagr:+.2f}% · "
              f"Labor force {lf_cagr:+.2f}%")

    # 動態把最後一期標籤換成實際年份(例如最新季度落在 2026Q2 → "2020-2026")
    periods[-1]["period"] = f"2020-{latest_quarter[:4]}"

    payload = {
        "updated": date.today().isoformat(),
        "note": (
            "美國GDP/生產力/勞動力貢獻度拆解,分四個時期(1950-1980/1980-2007/2007-2019/"
            f"2020-{latest_quarter[:4]})計算年化成長率(CAGR)。資料源:FRED GDPC1(實質GDP,"
            "chained 2012$)、OPHNFB(非農企業部門勞動生產力指數)、CLF16OV(16歲以上民間勞動力,"
            "取各季最後一月的值代表該季)。CAGR公式:(期末值/期初值)^(1/年數)-1。" + DISCLAIMER
        ),
        "periods": periods,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    print(f"Wrote {OUT.name}: {len(periods)} periods")


if __name__ == "__main__":
    main()
