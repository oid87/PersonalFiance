"""Shared helpers for scripts/fetch_*.py — pure refactor, no behavior change.

Helpers factored out of near-identical code that was duplicated across
~30 fetch scripts (see spec_B.md / B1, spec_V.md / V):
  - get_finmind_token(): FinMind token lookup (env -> repo .finmind_token ->
    sibling Financial_work/.finmind_token -> anonymous "").
  - fetch_fred_csv(): download + parse one FRED fredgraph.csv series.
  - load_rows_by_date(): load an existing data/*.json {"data": [...]} file into
    an OrderedDict keyed by date, for idempotent by-date merging.
  - load_rows(): load an existing data/*.json {"data": [...]} file into a
    plain list (verbatim body of the valuation scripts' load_existing()).
  - retry_call(): generic retry-with-backoff wrapper, extracted from the
    hand-rolled "for attempt in range(retries): try/except" loops that were
    byte-for-byte identical (Class A in the spec_V.md inventory) across
    several fetch scripts.

Callers `import _common` (or `from _common import ...`) directly — both
`python scripts/x.py` (cwd=repo root) and `cd scripts && python x.py` put this
file's directory on sys.path[0] automatically, so no sys.path hack is needed.
"""
from __future__ import annotations

import csv
import io
import json
import os
import time
from collections import OrderedDict
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent


def get_finmind_token() -> str:
    tok = os.environ.get("FINMIND_TOKEN", "").strip()
    if tok:
        return tok
    for p in (ROOT / ".finmind_token", ROOT.parent / "Financial_work" / ".finmind_token"):
        if p.exists():
            return p.read_text().strip()
    return ""  # anonymous (low rate limit, may still work for a single daily call)


def fetch_fred_csv(series_id: str, *, headers: dict, timeout: int = 30) -> list[tuple[str, float]]:
    """Download one FRED series as CSV -> [(date, value), ...], sorted ascending.

    Skips rows with no date, or value "." / "" / non-numeric. Not rounded and
    not otherwise transformed — callers round / reshape as their own output
    format requires.
    """
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}"
    resp = requests.get(url, timeout=timeout, headers=headers)
    resp.raise_for_status()
    rows: list[tuple[str, float]] = []
    for row in csv.DictReader(io.StringIO(resp.text)):
        d = (row.get("observation_date") or row.get("DATE") or "").strip()
        v = (row.get(series_id) or "").strip()
        if not d or v in ("", "."):
            continue
        try:
            rows.append((d, float(v)))
        except ValueError:
            continue
    return sorted(rows, key=lambda r: r[0])


def load_rows_by_date(path: Path) -> "OrderedDict[str, dict]":
    """Load a data/*.json {"data": [...]} file into {date: row} (OrderedDict,
    insertion order = file order). Missing file or any parse error -> empty."""
    if not path.exists():
        return OrderedDict()
    try:
        payload = json.loads(path.read_text())
        return OrderedDict((r["date"], r) for r in payload.get("data", []) if r.get("date"))
    except Exception:
        return OrderedDict()


def load_rows(path: Path) -> list:
    """Load a data/*.json {"data": [...]} file into a plain list.

    Verbatim body of the valuation scripts' load_existing() (6 files, byte-
    identical per spec_V.md Part 1 inventory). Missing file or any parse
    error -> empty list.
    """
    if not path.exists():
        return []
    try:
        return json.loads(path.read_text()).get("data", [])
    except Exception:
        return []


def idempotent_merge(existing_path: Path, new_rows: list[dict], key_field: str = "date") -> list[dict]:
    """Merge new_rows into the {"data": [...]} file at existing_path, keyed by
    key_field (new overwrites old on the same key). Verbatim body shared by 6
    fetch scripts (fetch_credit.py, fetch_real_rates.py, fetch_vix_term.py,
    fetch_yield_curve.py, fetch_central_banks.py, fetch_money_market.py).

    Missing file or any parse error -> start from empty. A row missing
    key_field raises KeyError, aborting the merge (rows processed so far stay
    in `existing`, but the exception propagates and nothing is returned)."""
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


def retry_call(fn, *, attempts, backoff, retry_on=(Exception,), retry_if=None,
                on_retry=None, on_final=None):
    """Call fn() up to `attempts` times.

    - fn() raises an exception in retry_on  -> failed attempt (exc recorded)
    - fn() returns r and retry_if(r) is truthy -> failed attempt (result recorded)
    - otherwise return r immediately
    Between failed attempts (never after the last one) call on_retry(attempt, exc, result)
    if given, then time.sleep(backoff(attempt)); attempt is 0-based.
    After the last failed attempt: return on_final(last_exc, last_result) if given,
    else last_result (None when the last attempt raised).
    Exceptions not in retry_on propagate immediately.
    """
    last_exc = None
    last_result = None
    for attempt in range(attempts):
        try:
            result = fn()
        except retry_on as e:
            last_exc = e
            last_result = None
        else:
            if retry_if is None or not retry_if(result):
                return result
            last_exc = None
            last_result = result
        if attempt < attempts - 1:
            if on_retry is not None:
                on_retry(attempt, last_exc, last_result)
            time.sleep(backoff(attempt))
    if on_final is not None:
        return on_final(last_exc, last_result)
    return last_result
