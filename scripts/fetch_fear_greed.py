"""Fetch CNN Fear & Greed Index.

Strategy:
  - Backfill (if data/fear_greed.json is empty/missing): pull historical CSV
    from the whit3rabbit/fear-greed-data GitHub mirror (2011-present).
  - Every run: call CNN's live endpoint and merge the most recent ~30 days
    so the file stays current with today's close.
  - Same CNN payload also carries the seven sub-indicators' raw daily
    readings (~2020-09 onward) and today's 0-100 score per indicator; those go
    to data/fear_greed_components.json (raw rows merged by date, today's
    scores appended to `scores` so per-indicator scores accumulate daily).
"""
from __future__ import annotations

import csv
import io
import json
from datetime import date, datetime, timezone
from pathlib import Path

import requests

from _common import load_rows

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)
OUT = DATA_DIR / "fear_greed.json"
COMP_OUT = DATA_DIR / "fear_greed_components.json"

HISTORICAL_CSV = (
    "https://raw.githubusercontent.com/whit3rabbit/fear-greed-data/main/fear-greed.csv"
)
CNN_URL = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata"

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)


def _rating_from(value: float) -> str:
    # CNN thresholds
    if value <  25: return "extreme fear"
    if value <  45: return "fear"
    if value <  55: return "neutral"
    if value <  75: return "greed"
    return "extreme greed"


def load_existing() -> list[dict]:
    return load_rows(OUT)


def fetch_backfill() -> list[dict]:
    print("  backfilling historical CSV from whit3rabbit/fear-greed-data ...")
    resp = requests.get(HISTORICAL_CSV, timeout=30)
    resp.raise_for_status()
    reader = csv.DictReader(io.StringIO(resp.text))
    rows: list[dict] = []
    for r in reader:
        try:
            rows.append({
                "date":   r["Date"],
                "value":  round(float(r["Fear Greed"]), 2),
                "rating": r["Rating"].strip().lower(),
            })
        except (KeyError, ValueError):
            continue
    print(f"  got {len(rows)} historical rows")
    return rows


def fetch_live() -> list[dict]:
    # CNN's endpoint wants a start-date segment in the path, but accepts any
    # ISO date. Ask for the last ~40 days.
    from datetime import timedelta
    start = (date.today() - timedelta(days=40)).isoformat()
    url = f"{CNN_URL}/{start}"
    resp = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=30)
    resp.raise_for_status()
    payload = resp.json()
    hist = payload.get("fear_and_greed_historical", {}).get("data", [])
    rows: list[dict] = []
    for r in hist:
        try:
            ts = int(r["x"]) / 1000
            d = datetime.fromtimestamp(ts, tz=timezone.utc).date().isoformat()
            v = round(float(r["y"]), 2)
            rows.append({
                "date":   d,
                "value":  v,
                "rating": (r.get("rating") or _rating_from(v)).lower(),
            })
        except (KeyError, ValueError, TypeError):
            continue
    print(f"  got {len(rows)} live rows from CNN")
    return rows


# CNN key -> our field. momentum: S&P 500 and its 125-day MA; vix: VIX and
# its 50-day MA. The other five carry one raw reading each.
COMPONENT_KEYS = {
    "market_momentum_sp500":  "sp500",
    "market_momentum_sp125":  "sp125",
    "stock_price_strength":   "strength",
    "stock_price_breadth":    "breadth",
    "put_call_options":       "put_call",
    "market_volatility_vix":  "vix",
    "market_volatility_vix_50": "vix50",
    "junk_bond_demand":       "junk",
    "safe_haven_demand":      "safe_haven",
}
SCORE_KEYS = ["market_momentum_sp500", "stock_price_strength", "stock_price_breadth",
              "put_call_options", "market_volatility_vix", "junk_bond_demand", "safe_haven_demand"]
# CNN's endpoint 500s before ~2020-09; walk forward until one start works.
COMPONENT_STARTS = ["2020-07-01", "2020-08-01", "2020-09-01", "2020-10-01", "2021-01-01"]


def _ts_date(x) -> str:
    return datetime.fromtimestamp(int(x) / 1000, tz=timezone.utc).date().isoformat()


def fetch_components() -> dict:
    payload = None
    for start in COMPONENT_STARTS:
        resp = requests.get(f"{CNN_URL}/{start}", headers={"User-Agent": USER_AGENT}, timeout=30)
        if resp.ok:
            payload = resp.json()
            break
    if payload is None:
        raise RuntimeError("CNN components endpoint refused every start date")
    by_date: dict[str, dict] = {}
    for key, field in COMPONENT_KEYS.items():
        for r in payload.get(key, {}).get("data", []):
            try:
                d = _ts_date(r["x"]); v = float(r["y"])
            except (KeyError, ValueError, TypeError):
                continue
            row = by_date.setdefault(d, {"date": d})
            # Per-point "rating" in these arrays does not track the indicator's
            # own score (S&P shows "extreme greed" while momentum scores 8), so
            # only the raw reading is kept.
            row[field] = round(v, 6)
    fg = payload.get("fear_and_greed", {})
    snap = {"date": _ts_date(datetime.fromisoformat(fg["timestamp"]).timestamp() * 1000),
            "composite": round(float(fg["score"]), 4)}
    for key in SCORE_KEYS:
        snap[COMPONENT_KEYS[key]] = round(float(payload[key]["score"]), 4)
    print(f"  got {len(by_date)} component rows from CNN (start {start})")
    return {"rows": sorted(by_date.values(), key=lambda r: r["date"]), "score": snap}


def write_components(fresh: dict) -> None:
    old = json.loads(COMP_OUT.read_text()) if COMP_OUT.exists() else {}
    rows = {r["date"]: r for r in old.get("data", [])}
    for r in fresh["rows"]:
        rows[r["date"]] = {**rows.get(r["date"], {}), **r}
    scores = {r["date"]: r for r in old.get("scores", [])}
    scores[fresh["score"]["date"]] = fresh["score"]
    payload = {
        "source":  "CNN Fear & Greed graphdata endpoint (raw sub-indicators; daily score snapshots)",
        "updated": date.today().isoformat(),
        "data":    sorted(rows.values(), key=lambda r: r["date"]),
        "scores":  sorted(scores.values(), key=lambda r: r["date"]),
    }
    COMP_OUT.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    print(f"Wrote {len(payload['data'])} rows, {len(payload['scores'])} score snapshots -> {COMP_OUT.name}")


def merge(existing: list[dict], *sources: list[dict]) -> list[dict]:
    by_date = {r["date"]: r for r in existing}
    for src in sources:
        for r in src:
            by_date[r["date"]] = r
    return sorted(by_date.values(), key=lambda r: r["date"])


def main() -> None:
    existing = load_existing()
    print(f"Loaded {len(existing)} existing F&G rows")

    sources: list[list[dict]] = []
    if not existing:
        sources.append(fetch_backfill())

    try:
        sources.append(fetch_live())
    except Exception as exc:
        print(f"  WARN: live CNN fetch failed: {exc}")
        if not existing and not sources:
            raise

    merged = merge(existing, *sources)

    payload = {
        "source":  "CNN (via whit3rabbit/fear-greed-data + live CNN endpoint)",
        "updated": date.today().isoformat(),
        "data":    merged,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    print(f"Wrote {len(merged)} rows -> {OUT.name}")

    try:
        write_components(fetch_components())
    except Exception as exc:
        print(f"  WARN: CNN components fetch failed, kept old file: {exc}")


if __name__ == "__main__":
    main()
