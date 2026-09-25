"""Shared helpers for scripts/fetch_*.py — pure refactor, no behavior change.

Three helpers, factored out of near-identical code that was duplicated across
~30 fetch scripts (see spec_B.md / B1):
  - get_finmind_token(): FinMind token lookup (env -> repo .finmind_token ->
    sibling Financial_work/.finmind_token -> anonymous "").
  - fetch_fred_csv(): download + parse one FRED fredgraph.csv series.
  - load_rows_by_date(): load an existing data/*.json {"data": [...]} file into
    an OrderedDict keyed by date, for idempotent by-date merging.

Callers `import _common` (or `from _common import ...`) directly — both
`python scripts/x.py` (cwd=repo root) and `cd scripts && python x.py` put this
file's directory on sys.path[0] automatically, so no sys.path hack is needed.
"""
from __future__ import annotations

import csv
import io
import json
import os
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
