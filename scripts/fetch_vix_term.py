"""Fetch VIX term structure (VIX9D / VIX / VIX3M / VIX6M) from CBOE official daily-prices CSVs.

Output:
  data/vix_term.json — daily term-structure points + ts_ratio (VIX / VIX3M).
  ts_ratio > 1 = backwardation (near-term fear higher than 3-month) — primary
  front-end signal for this dataset.

Source: CBOE cdn.cboe.com daily_prices CSVs (no auth). Each CSV has columns
DATE,OPEN,HIGH,LOW,CLOSE with DATE as MM/DD/YYYY. We take DATE + CLOSE only.
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

HEADERS = {"User-Agent": "PersonalFiance/1.0"}

CBOE_URLS = {
    "vix9d": "https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX9D_History.csv",
    "vix": "https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv",
    "vix3m": "https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX3M_History.csv",
    "vix6m": "https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX6M_History.csv",
}


def fetch_cboe_close(url: str) -> dict[str, float]:
    """Fetch a CBOE daily_prices CSV and return {YYYY-MM-DD: close}."""
    resp = requests.get(url, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    text = resp.text
    reader = csv.DictReader(io.StringIO(text))
    fieldnames = [f.strip().upper() for f in (reader.fieldnames or [])]
    if "DATE" not in fieldnames or "CLOSE" not in fieldnames:
        lines = text.splitlines()
        preview = "\n".join(lines[:3])
        raise ValueError(f"unexpected CBOE CSV header {fieldnames}; first lines:\n{preview}")

    out: dict[str, float] = {}
    for row in reader:
        raw_date = (row.get("DATE") or "").strip()
        raw_close = (row.get("CLOSE") or "").strip()
        if not raw_date or not raw_close:
            continue
        try:
            mm, dd, yyyy = raw_date.split("/")
            iso_date = f"{yyyy}-{int(mm):02d}-{int(dd):02d}"
            out[iso_date] = round(float(raw_close), 4)
        except (ValueError, AttributeError):
            continue
    return out


def idempotent_merge(existing_path: Path, new_rows: list[dict], key_field: str = "date") -> list[dict]:
    existing = {}
    if existing_path.exists():
        try:
            for r in json.loads(existing_path.read_text()).get("data", []):
                existing[r[key_field]] = r
        except Exception:
            pass
    for r in new_rows:
        existing[r[key_field]] = r
    return sorted(existing.values(), key=lambda r: r[key_field])


def main() -> None:
    print("Fetching VIX term structure from CBOE ...")

    series: dict[str, dict[str, float]] = {}
    for key, url in CBOE_URLS.items():
        try:
            series[key] = fetch_cboe_close(url)
            print(f"  {key}: OK ({len(series[key])} rows)")
        except Exception as exc:
            series[key] = {}
            print(f"  {key}: FAILED ({exc})")

    ok_keys = [k for k, v in series.items() if v]
    missing_keys = [k for k in CBOE_URLS if k not in ok_keys]

    if "vix" not in ok_keys or "vix3m" not in ok_keys:
        print("  ABORT: need at least vix + vix3m to build term structure; keeping old data/vix_term.json untouched.")
        return

    try:
        all_dates = sorted(set().union(*[set(v.keys()) for v in series.values() if v]))

        new_rows = []
        for d in all_dates:
            vix9d = series.get("vix9d", {}).get(d)
            vix = series.get("vix", {}).get(d)
            vix3m = series.get("vix3m", {}).get(d)
            vix6m = series.get("vix6m", {}).get(d)
            ts_ratio = round(vix / vix3m, 4) if (vix is not None and vix3m is not None and vix3m != 0) else None
            new_rows.append({
                "date": d,
                "vix9d": vix9d,
                "vix": vix,
                "vix3m": vix3m,
                "vix6m": vix6m,
                "ts_ratio": ts_ratio,
            })

        out = DATA_DIR / "vix_term.json"
        merged = idempotent_merge(out, new_rows)

        note = (
            "CBOE official daily close: vix9d=VIX9D (9-day), vix=VIX (30-day), "
            "vix3m=VIX3M (3-month), vix6m=VIX6M (6-month). "
            "ts_ratio = vix / vix3m; ts_ratio > 1 = backwardation "
            "(near-term fear priced above 3-month, front-end signal)."
        )
        if missing_keys:
            note += f" NOTE: source failed for {missing_keys} on this run; those fields are null for dates without prior data."

        out.write_text(json.dumps({
            "source": "CBOE",
            "note": note,
            "updated": date.today().isoformat(),
            "data": merged,
        }, ensure_ascii=False) + "\n")
        print(f"  vix_term.json: {len(merged)} rows")
    except Exception as exc:
        print(f"  vix_term FAILED: {exc}")


if __name__ == "__main__":
    main()
