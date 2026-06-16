"""Fetch Taiwan PMI / NMI from data.gov.tw dataset 6100 — monthly.

Source: 中華經濟研究院 PMI / NMI via NDC, published as CSV on data.gov.tw.
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

META_URL = "https://data.gov.tw/api/v2/rest/dataset/6100"
HEADERS = {"User-Agent": "Mozilla/5.0 PersonalFiance/1.0"}


def find_csv_url() -> str:
    resp = requests.get(META_URL, timeout=30, headers=HEADERS)
    resp.raise_for_status()
    for dist in resp.json().get("result", {}).get("distribution", []):
        fmt = (dist.get("resourceFormat") or "").upper()
        url = dist.get("resourceDownloadUrl") or dist.get("resourceURL")
        if fmt == "CSV" and url:
            return url
    raise RuntimeError("dataset 6100: no CSV distribution found")


def parse(csv_text: str) -> list[dict]:
    rows = []
    reader = csv.DictReader(io.StringIO(csv_text))
    for r in reader:
        ym = (r.get("Date") or "").strip()
        if len(ym) != 6 or not ym.isdigit():
            continue
        def parse_num(s):
            s = (s or "").strip()
            if not s or s == "-":
                return None
            try:
                return float(s)
            except ValueError:
                return None
        pmi = parse_num(r.get("PMI"))
        nmi = parse_num(r.get("NMI"))
        if pmi is None and nmi is None:
            continue
        rows.append({
            "date": f"{ym[:4]}-{ym[4:]}-01",
            "pmi":  pmi,
            "nmi":  nmi,
        })
    return rows


def main() -> None:
    url = find_csv_url()
    print(f"Fetching {url}")
    resp = requests.get(url, timeout=60, headers=HEADERS)
    resp.raise_for_status()
    text = resp.content.decode("utf-8-sig")
    rows = parse(text)
    if not rows:
        raise RuntimeError("no parsed rows")
    rows.sort(key=lambda r: r["date"])

    out = DATA_DIR / "taiwan_pmi.json"
    payload = {
        "source":  "data.gov.tw dataset 6100 (中華經濟研究院 / NDC)",
        "updated": date.today().isoformat(),
        "latest":  rows[-1],
        "data":    rows,
    }
    out.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    print(f"Wrote {len(rows)} rows -> {out.name} (latest {rows[-1]})")


if __name__ == "__main__":
    main()
