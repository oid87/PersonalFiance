#!/usr/bin/env python3
"""回補研究用 CFTC TFF（futures only）歷史：2019～2021（正式管線只保留近 5 年，2022 起）。

重用 scripts/fetch_cftc_positions.py 的解析與驗證，輸出獨立研究檔，不改動 data/cftc_positions.json。
  python3 scripts/research/fetch_cftc_tff_history.py            # 預設 2019 2020 2021
  python3 scripts/research/fetch_cftc_tff_history.py 2019 2020
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import fetch_cftc_positions as cftc  # noqa: E402

OUT = ROOT / "data" / "research" / "us_delever" / "cftc_tff_2019_2021.json"


def main(years: list[int]) -> None:
    rows = {meta["id"]: [] for meta in cftc.INSTRUMENTS.values()}
    for year in years:
        parsed = cftc.parse_cftc_csv(cftc._fetch_year(year))
        for key, items in parsed.items():
            if not items:
                raise SystemExit(f"{year}: no rows for {key}")
            rows[key].extend(items)
    instruments = []
    for meta in cftc.INSTRUMENTS.values():
        by_date = {r["date"]: r for r in rows[meta["id"]]}
        instruments.append({**meta, "report_type": "tff_futures_only", "units": "contracts",
                            "rows": [by_date[d] for d in sorted(by_date)]})
    payload = {
        "source": "CFTC Traders in Financial Futures (TFF), futures only — research backfill",
        "source_url": cftc.URL.format(year="YYYY"),
        "years": years,
        "fetched_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "note": "report date = Tuesday as-of; public release normally the following Friday 15:30 ET. 與 data/cftc_positions.json（2022+）同欄位，不重疊。",
        "instruments": instruments,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    for item in instruments:
        print(item["id"], len(item["rows"]), item["rows"][0]["date"], item["rows"][-1]["date"])


if __name__ == "__main__":
    main([int(a) for a in sys.argv[1:]] or [2019, 2020, 2021])
