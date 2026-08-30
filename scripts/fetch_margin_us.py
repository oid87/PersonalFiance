"""Fetch US margin debt balance (monthly) → data/margin_global_us.json

Source: FINRA margin statistics (margin debt balance), via third-party mirror
  https://www.thetrading.tools/data/indicators/margin-debt.csv

FINRA's own site (finra.org) is fully behind a Cloudflare managed challenge —
verified with plain requests/curl (403 on every path, including guessed direct
xlsx links) and with a headless real-browser check (page never leaves
"Just a moment...", no links exposed after a 6s wait). Direct scraping of
finra.org is therefore explicitly out of scope for this script; do not
attempt to bypass Cloudflare here (no anti-detection or browser-fingerprint
spoofing techniques).

thetrading.tools has no anti-bot protection and returns a clean CSV, columns:
  date,debit_balances,debit_yoy,spy_yoy,excess_leverage,free_credit_cash,
  free_credit_margin,net_free_credit,debit_mom,added_date

Only `date` and `debit_balances` (→ output field `margin_balance`, USD millions)
are kept. `added_date` is the mirror site's own scrape timestamp, not part of
the underlying data, and is ignored. Monthly granularity, back to 1997-01-01.

Because this is a small third-party site (not an official/institutional
source), its URL or CSV schema could change or break at any time. If the
fetch does not return HTTP 200, or the expected columns ("date",
"debit_balances") are missing, this script raises immediately with a clear
message rather than silently producing null/empty data — that failure needs a
human to look for a replacement source.

Output data/margin_global_us.json:
  {source, note, updated, data: [{date, margin_balance}]}

Idempotent merge: existing rows are re-unioned with freshly-fetched rows by
date (new overwrites old for that date), then written back sorted by date.
"""
from __future__ import annotations

import csv
import io
import json
from collections import OrderedDict
from datetime import date
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)
OUT = DATA_DIR / "margin_global_us.json"

CSV_URL = "https://www.thetrading.tools/data/indicators/margin-debt.csv"
UA = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    )
}


def fetch_margin_debt() -> "OrderedDict[str, int]":
    """Return {YYYY-MM-DD: margin_balance} from the thetrading.tools CSV mirror.

    Raises RuntimeError (not a silent empty/null result) if the request fails
    or the CSV no longer has the expected columns — this source is a small
    third-party site that could change format or go away without notice.
    """
    resp = requests.get(CSV_URL, timeout=30, headers=UA)
    if resp.status_code != 200:
        raise RuntimeError(
            f"thetrading.tools CSV 格式或連結已變動,需要人工檢查 "
            f"(HTTP {resp.status_code} from {CSV_URL})"
        )

    reader = csv.DictReader(io.StringIO(resp.text))
    fieldnames = reader.fieldnames or []
    if "date" not in fieldnames or "debit_balances" not in fieldnames:
        raise RuntimeError(
            "thetrading.tools CSV 格式或連結已變動,需要人工檢查 "
            f"(expected columns 'date' and 'debit_balances', got {fieldnames})"
        )

    out: "OrderedDict[str, int]" = OrderedDict()
    for row in reader:
        d = (row.get("date") or "").strip()
        v = (row.get("debit_balances") or "").strip()
        if not d or not v:
            continue
        try:
            out[d] = int(round(float(v)))
        except ValueError:
            continue

    if not out:
        raise RuntimeError(
            "thetrading.tools CSV 格式或連結已變動,需要人工檢查 "
            "(no usable rows parsed from response)"
        )
    return out


def load_existing_rows() -> "OrderedDict[str, dict]":
    if not OUT.exists():
        return OrderedDict()
    try:
        payload = json.loads(OUT.read_text())
        return OrderedDict((r["date"], r) for r in payload.get("data", []) if r.get("date"))
    except Exception:
        return OrderedDict()


def main() -> None:
    existing = load_existing_rows()
    fetched = fetch_margin_debt()
    last_d = next(reversed(fetched)) if fetched else None
    print(f"  [thetrading.tools] {len(fetched)} obs"
          + (f" · latest {last_d} = {fetched[last_d]}" if last_d else ""))

    today_str = date.today().isoformat()
    merged: "OrderedDict[str, dict]" = OrderedDict()
    for d, old in existing.items():
        merged[d] = old
    for d, v in fetched.items():
        if d > today_str:
            continue
        merged[d] = {"date": d, "margin_balance": v}

    data = [merged[d] for d in sorted(merged)]
    payload = {
        "source": (
            "FINRA margin debt balance, 經第三方轉載 "
            "https://www.thetrading.tools/data/indicators/margin-debt.csv "
            "(原始資料來源 FINRA margin statistics, finra.org 因 Cloudflare 反爬蟲無法直接抓取,"
            "改用此轉載源)"
        ),
        "note": (
            "margin_balance 單位 USD millions(百萬美元),月頻,資料回溯至1997-01-01。"
            "指數對照用既有 data/SP500.json 或 data/SPY.json,本檔不含指數資料。"
            "⚠️ 資料來源是第三方轉載站,非 FINRA 官方直連,若該站失效需另尋來源。"
        ),
        "updated": today_str,
        "data": data,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    print(f"Wrote {OUT.name}: {len(data)} rows")


if __name__ == "__main__":
    main()
