"""Fetch verified CFTC TFF futures-only positioning for three US index futures."""
from __future__ import annotations

import csv
import io
import json
import math
import zipfile
from datetime import date, datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "cftc_positions.json"
URL = "https://www.cftc.gov/files/dea/history/fut_fin_txt_{year}.zip"
UA = {"User-Agent": "Mozilla/5.0 (compatible; PersonalFiance market data fetcher)"}

INSTRUMENTS = {
    "13874+": {"id": "sp500", "name": "S&P 500 Consolidated", "label": "S&P 500", "contract_code": "13874+"},
    "20974+": {"id": "nasdaq100", "name": "NASDAQ-100 Consolidated", "label": "Nasdaq-100", "contract_code": "20974+"},
    "239742": {"id": "russell2000", "name": "Russell E-mini", "label": "Russell 2000", "contract_code": "239742"},
}


def _integer(raw: object, field: str) -> int:
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError) as exc:
        raise ValueError(f"invalid {field}: {raw!r}") from exc
    if value < 0 or not math.isfinite(value):
        raise ValueError(f"invalid {field}: {raw!r}")
    return value


def validate_row(row: dict) -> None:
    date.fromisoformat(row["date"])
    for field in ("lev_long", "lev_short", "am_long", "am_short", "open_interest"):
        _integer(row[field], field)
    if row["lev_net"] != row["lev_long"] - row["lev_short"]:
        raise ValueError("lev_net arithmetic mismatch")
    if row["am_net"] != row["am_long"] - row["am_short"]:
        raise ValueError("am_net arithmetic mismatch")


def parse_cftc_csv(text: str) -> dict[str, list[dict]]:
    parsed = {meta["id"]: [] for meta in INSTRUMENTS.values()}
    for raw in csv.DictReader(io.StringIO(text)):
        code = str(raw.get("CFTC_Contract_Market_Code", "")).strip()
        meta = INSTRUMENTS.get(code)
        if not meta or str(raw.get("FutOnly_or_Combined", "")).strip() != "FutOnly":
            continue
        row = {
            "date": str(raw.get("Report_Date_as_YYYY-MM-DD", "")).strip(),
            "lev_long": _integer(raw.get("Lev_Money_Positions_Long_All"), "lev_long"),
            "lev_short": _integer(raw.get("Lev_Money_Positions_Short_All"), "lev_short"),
            "am_long": _integer(raw.get("Asset_Mgr_Positions_Long_All"), "am_long"),
            "am_short": _integer(raw.get("Asset_Mgr_Positions_Short_All"), "am_short"),
            "open_interest": _integer(raw.get("Open_Interest_All"), "open_interest"),
        }
        row["lev_net"] = row["lev_long"] - row["lev_short"]
        row["am_net"] = row["am_long"] - row["am_short"]
        validate_row(row)
        parsed[meta["id"]].append(row)
    return parsed


def add_cot_index(rows: list[dict], window: int = 156) -> list[dict]:
    ordered = sorted(rows, key=lambda r: r["date"])
    for idx, row in enumerate(ordered):
        values = [r["lev_net"] for r in ordered[max(0, idx - window + 1):idx + 1]]
        if len(values) < window or max(values) == min(values):
            row["cot_index_3y"] = None
        else:
            row["cot_index_3y"] = round((row["lev_net"] - min(values)) / (max(values) - min(values)) * 100, 2)
    return ordered


def _existing() -> dict:
    try:
        payload = json.loads(OUT.read_text())
        for instrument in payload.get("instruments", []):
            for row in instrument.get("rows", []):
                validate_row(row)
        return payload
    except Exception:
        return {}


def merge_instruments(existing: dict, fresh: dict[str, list[dict]]) -> list[dict]:
    cached = {item.get("id"): item.get("rows", []) for item in existing.get("instruments", [])}
    output = []
    for meta in INSTRUMENTS.values():
        by_date = {r["date"]: dict(r) for r in cached.get(meta["id"], [])}
        for row in fresh.get(meta["id"], []):
            by_date[row["date"]] = row
        rows = add_cot_index(list(by_date.values()))
        output.append({**meta, "report_type": "tff_futures_only", "units": "contracts", "rows": rows})
    return output


def _fetch_year(year: int) -> str:
    response = requests.get(URL.format(year=year), headers=UA, timeout=60)
    response.raise_for_status()
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        names = [name for name in archive.namelist() if name.lower().endswith(".txt")]
        if len(names) != 1:
            raise ValueError(f"expected one CFTC text file, found {len(names)}")
        return archive.read(names[0]).decode("utf-8-sig", errors="strict")


def years_to_fetch(existing: dict, today: date) -> list[int]:
    """Retry incomplete historical years instead of permanently keeping holes."""
    complete = set(existing.get("completed_years", []))
    required = set(range(today.year - 4, today.year + 1))
    pending = required - complete
    pending.add(today.year)
    if today.month <= 2:
        pending.add(today.year - 1)
    return sorted(pending)


def main() -> None:
    existing = _existing()
    today = date.today()
    years = years_to_fetch(existing, today)
    completed_years = set(existing.get("completed_years", []))
    fresh = {meta["id"]: [] for meta in INSTRUMENTS.values()}
    errors = []
    for year in years:
        try:
            parsed = parse_cftc_csv(_fetch_year(year))
            missing = [key for key, rows in parsed.items() if not rows]
            if missing:
                raise ValueError(f"missing index records: {', '.join(missing)}")
            completed_years.add(year)
            for instrument_id, rows in parsed.items():
                fresh[instrument_id].extend(rows)
        except Exception as exc:
            errors.append(f"{year}: {exc}")
    instruments = merge_instruments(existing, fresh)
    has_rows = any(item["rows"] for item in instruments)
    if not has_rows:
        status = "unavailable"
    elif errors:
        status = "stale"
    else:
        status = "ok"
    updated = max((r["date"] for item in instruments for r in item["rows"]), default=None)
    payload = {
        "source": "CFTC Traders in Financial Futures (TFF), futures only",
        "source_url": URL.format(year=today.year),
        "updated": updated,
        "fetched_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "status": status,
        "error": "; ".join(errors) or None,
        "instruments": instruments,
        "completed_years": sorted(completed_years),
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"Wrote {OUT.name}: {status}, updated={updated}")


if __name__ == "__main__":
    main()
