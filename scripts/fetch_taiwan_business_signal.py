"""Fetch Taiwan NDC business cycle signal (景氣對策信號) — monthly.

Source: data.gov.tw dataset 6099 (景氣指標及燈號), provided by NDC.
The platform serves a ZIP of CSVs; we extract 景氣指標與燈號.csv which
contains the composite score (9-45) and signal light (藍/黃藍/綠/黃紅/紅).
"""
from __future__ import annotations

import io
import json
import zipfile
from datetime import date
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)

META_URL = "https://data.gov.tw/api/v2/rest/dataset/6099"
TARGET_CSV = "景氣指標與燈號.csv"
HEADERS = {"User-Agent": "Mozilla/5.0 PersonalFiance/1.0"}


def find_download_url() -> str:
    resp = requests.get(META_URL, timeout=30, headers=HEADERS)
    resp.raise_for_status()
    payload = resp.json()
    for dist in payload.get("result", {}).get("distribution", []):
        url = dist.get("resourceDownloadUrl") or dist.get("resourceURL")
        if url and url.lower().endswith((".zip", ".zip&icon=.zip")) or "zip" in (dist.get("resourceFormat") or "").lower():
            return url
    raise RuntimeError("dataset 6099: no ZIP distribution found")


def extract_signal_csv(zip_bytes: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
        for name in z.namelist():
            try:
                decoded = name.encode("cp437").decode("big5")
            except Exception:
                decoded = name
            if decoded == TARGET_CSV:
                return z.read(name).decode("utf-8-sig")
    raise RuntimeError(f"{TARGET_CSV} not found in ZIP")


def parse(csv_text: str) -> list[dict]:
    import csv
    rows = []
    reader = csv.DictReader(io.StringIO(csv_text))
    for r in reader:
        ym = (r.get("Date") or "").strip()
        if len(ym) != 6 or not ym.isdigit():
            continue
        score = (r.get("景氣對策信號綜合分數") or "").strip()
        light = (r.get("景氣對策信號") or "").strip()
        if not score or score == "-":
            continue
        try:
            score_int = int(score)
        except ValueError:
            continue
        rows.append({
            "date":  f"{ym[:4]}-{ym[4:]}-01",
            "score": score_int,
            "light": light,
        })
    return rows


def main() -> None:
    url = find_download_url()
    print(f"Fetching {url}")
    resp = requests.get(url, timeout=60, headers=HEADERS)
    resp.raise_for_status()
    csv_text = extract_signal_csv(resp.content)
    rows = parse(csv_text)
    if not rows:
        raise RuntimeError("no parsed rows")
    rows.sort(key=lambda r: r["date"])

    out = DATA_DIR / "taiwan_business_signal.json"
    payload = {
        "source":  "data.gov.tw dataset 6099 (NDC)",
        "updated": date.today().isoformat(),
        "latest":  rows[-1],
        "data":    rows,
    }
    out.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    print(f"Wrote {len(rows)} rows -> {out.name} (latest {rows[-1]})")


if __name__ == "__main__":
    main()
