"""Fetch ProShares daily NAV + shares outstanding for TQQQ / QLD → data/proshares_flows.json.

Source: ProShares' own "Historical NAV" CSV (one file per fund, full history since inception):
  https://accounts.profunds.com/etfdata/ByFund/<TICKER>-historical_nav.csv
Columns: Date, NAV, Prior NAV, Shares Outstanding (000), Assets Under Management.
ProShares rescales past NAV and share counts after every split, so a fresh CSV is
always split-consistent. That is why each run REPLACES the fund's whole history
instead of merging dated rows: mixing pre- and post-split rows would fake a flow.

Daily net flow (front end computes it): (shares_t − shares_{t−1}) × NAV_t.
ProShares' count dated t already holds day t's creations/redemptions, so the flow
belongs to trade date t and is published after that day's close. This reproduces
ETFIQ's published TQQQ flows (dated by its navDate) to the dollar; the run records
that cross-check under `etfiq_check` (optional — ETFIQ failing does not fail the run).

Output:
  {"updated", "source", "etfiq_check": {...}|null,
   "funds": {"TQQQ": {"name", "data": [[date, nav, shares_000], ...]}, "QLD": {...}}}
"""
from __future__ import annotations

import csv
import io
import json
import sys
from datetime import date, datetime
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "proshares_flows.json"

CSV_URL = "https://accounts.profunds.com/etfdata/ByFund/{ticker}-historical_nav.csv"
ETFIQ_URL = "https://etfiq.com/data/flows/funds/tqqq.json"
HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                         "(KHTML, like Gecko) Chrome/130 Safari/537.36"}

# ticker -> (display name, first date kept). QLD is trimmed to TQQQ's era (the study axis).
FUNDS = {
    "TQQQ": ("ProShares UltraPro QQQ（3 倍）", "2010-02-09"),
    "QLD":  ("ProShares Ultra QQQ（2 倍）",    "2010-02-09"),
}
MIN_ROWS = 4000  # TQQQ has ~4,200 sessions since 2010; far fewer means a truncated file


def fetch_fund(ticker: str, start: str) -> list[list]:
    r = requests.get(CSV_URL.format(ticker=ticker), headers=HEADERS, timeout=60)
    r.raise_for_status()
    rows = []
    for rec in csv.DictReader(io.StringIO(r.text)):
        d = datetime.strptime(rec["Date"].strip(), "%m/%d/%Y").date().isoformat()
        if d < start:
            continue
        nav = float(rec["NAV"])
        shares = float(rec["Shares Outstanding (000)"])
        if nav <= 0 or shares < 0:
            raise ValueError(f"{ticker} {d}: bad NAV/shares {nav}/{shares}")
        rows.append([d, round(nav, 4), shares])
    rows.sort(key=lambda x: x[0])
    if len(rows) < MIN_ROWS:
        raise ValueError(f"{ticker}: only {len(rows)} rows — refusing to overwrite")
    for a, b in zip(rows, rows[1:]):
        if a[0] == b[0]:
            raise ValueError(f"{ticker}: duplicate date {a[0]}")
    return rows


def etfiq_check(tqqq: list[list]) -> dict | None:
    """Compare our flows with ETFIQ's published TQQQ daily flows (dated by navDate)."""
    try:
        r = requests.get(ETFIQ_URL, headers=HEADERS, timeout=30)
        r.raise_for_status()
        j = r.json()
    except Exception as e:  # optional cross-check only
        print(f"  ETFIQ check skipped: {e}")
        return None
    ours = {}
    for prev, cur in zip(tqqq, tqqq[1:]):
        ours[cur[0]] = (cur[2] - prev[2]) * 1000 * cur[1]
    diffs = [abs(ours[x["navDate"]] - x["flow"]) for x in j.get("daily", []) if x.get("navDate") in ours]
    if not diffs:
        return None
    return {"as_of": j.get("asOf"), "n": len(diffs), "within_10k_usd": sum(d < 10_000 for d in diffs),
            "max_abs_diff_usd": round(max(diffs)),
            "cite": "ETFIQ, Fund flows of TQQQ, https://etfiq.com/funds/tqqq"}


def main() -> None:
    funds = {}
    for ticker, (name, start) in FUNDS.items():
        rows = fetch_fund(ticker, start)
        print(f"  {ticker}: {len(rows)} rows {rows[0][0]} → {rows[-1][0]}")
        funds[ticker] = {"name": name, "data": rows}
    if funds["TQQQ"]["data"][-1][0] != funds["QLD"]["data"][-1][0]:
        print("  warning: TQQQ / QLD last dates differ")
    out = {
        "updated": date.today().isoformat(),
        "source": {
            "publisher": "ProShares",
            "url": "https://www.proshares.com/our-etfs/leveraged-and-inverse/tqqq",
            "csv": CSV_URL,
            "note": "flow_t = (shares_t − shares_{t−1}) × NAV_t；ProShares 的 t 日股數已含 t 日申贖，t 日收盤後公布",
        },
        "etfiq_check": etfiq_check(funds["TQQQ"]["data"]),
        "funds": funds,
    }
    print(f"  ETFIQ check: {out['etfiq_check']}")
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"fetch_proshares_flows failed: {e}", file=sys.stderr)
        sys.exit(1)
