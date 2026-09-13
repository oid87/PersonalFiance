"""Fetch NBER US recession indicator (FRED USREC) → data/USREC.json

USREC — NBER-based Recession Indicators for the United States (FRED series
USREC). Monthly, binary (1 = NBER-dated recession month, 0 = expansion).
Free, no API key. History back to 1854-12.

Used by js/tabs/semi_vs_spx_pe.js to shade recession periods (markArea) on
the SOXX vs SPY forward-PE chart.

Output (data/USREC.json), idempotent merge by date (new overwrites old):
  {source, note, updated,
   data: [{date, usrec}]}   # monthly, YYYY-MM-01, usrec ∈ {0, 1}
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
OUT = DATA_DIR / "USREC.json"

FRED_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=USREC"
UA = {"User-Agent": "PersonalFiance/1.0"}


def fetch_rows() -> "OrderedDict[str, dict]":
    """Return {date: {date, usrec}} from FRED USREC CSV, skipping missing ('.') obs."""
    resp = requests.get(FRED_URL, timeout=30, headers=UA)
    resp.raise_for_status()
    rows: "OrderedDict[str, dict]" = OrderedDict()
    for row in csv.DictReader(io.StringIO(resp.text)):
        d = (row.get("observation_date") or "").strip()
        v = (row.get("USREC") or "").strip()
        if not d or v in ("", "."):
            continue
        try:
            rows[d] = {"date": d, "usrec": int(float(v))}
        except ValueError:
            continue
    return rows


def load_existing() -> "OrderedDict[str, dict]":
    if not OUT.exists():
        return OrderedDict()
    try:
        payload = json.loads(OUT.read_text())
        return OrderedDict((r["date"], r) for r in payload.get("data", []) if r.get("date"))
    except Exception:
        return OrderedDict()


def main() -> None:
    existing = load_existing()
    try:
        fresh = fetch_rows()
    except Exception as exc:
        if existing:
            print(f"  [USREC] FAILED ({exc}); keeping {len(existing)} existing rows")
            return
        raise

    merged = OrderedDict(existing)
    merged.update(fresh)  # 新覆舊（idempotent）
    data = [merged[d] for d in sorted(merged)]

    if not data:
        raise RuntimeError("no USREC data available (fresh fetch failed and no existing data)")

    last = data[-1]
    print(f"  [USREC] {len(data)} months · latest {last['date']} = {last['usrec']}")

    payload = {
        "source": "FRED USREC (NBER-based Recession Indicators for the United States)",
        "note": (
            "月頻,NBER 官方衰退期認定,二元值:1=該月屬 NBER 認定的衰退期,0=擴張期。"
            "1854-12 起有資料。NBER 衰退期認定本質上是事後回溯公告(通常落後數月至一年以上),"
            "非即時訊號,僅供圖表灰底標示歷史衰退區間使用。"
        ),
        "updated": date.today().isoformat(),
        "data": data,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    print(f"Wrote {OUT.name}: {len(data)} rows")


if __name__ == "__main__":
    main()
