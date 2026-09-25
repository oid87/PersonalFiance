"""Shared helpers for the valuation fetch scripts (spec_V.md).

Factored out of near-identical code duplicated across fetch_qqq_valuation.py /
fetch_soxx_valuation.py / fetch_tw_semi_valuation.py / fetch_spy_valuation.py /
fetch_mags_valuation.py / fetch_tw_valuation.py:

  - ntm_pe(): NTM (Next Twelve Months) PE from yfinance earnings_estimate.
    Verbatim body of the three files' _ntm_pe(), parameterized by throttle
    (qqq used 0.5s, soxx/tw_semi used 0.8s — the only difference).
  - weighted_means(): the "arithmetic + harmonic weighted mean" core shared
    by fetch_spy_valuation.py / fetch_soxx_valuation.py / fetch_tw_semi_valuation.py's
    calc_fpe(). Each caller keeps its own MIN_STOCKS / coverage / cap-floor
    logic and rounds the result itself.
  - write_daily_snapshot(): the main() "load -> merge today's entry -> sort ->
    write {updated, note, data}" tail, verbatim from the valuation scripts.

`import _common` the same way _breadth.py does — both `python scripts/x.py`
(cwd=repo root) and `cd scripts && python x.py` put this file's directory on
sys.path[0], so no sys.path hack is needed.
"""
from __future__ import annotations

import datetime as _dt
import json
import time
from datetime import date
from pathlib import Path

import yfinance as yf

import _common


def ntm_pe(sym: str, *, throttle: float, retries: int = 3) -> float | None:
    """Compute NTM (Next Twelve Months) PE from analyst earnings estimates.

    NTM EPS = (m/12) × current_FY_EPS + ((12-m)/12) × next_FY_EPS
    where m = months remaining in current fiscal year (0 = FY ending now → use +1y).

    Verbatim from fetch_qqq_valuation.py / fetch_soxx_valuation.py /
    fetch_tw_semi_valuation.py's _ntm_pe(), which were identical except for
    the per-attempt throttle (0.5s vs 0.8s), now the `throttle` parameter.
    """
    for attempt in range(retries):
        try:
            time.sleep(throttle)
            t = yf.Ticker(sym)
            info = t.info
            price = info.get("currentPrice") or info.get("regularMarketPrice")
            lfy_raw = info.get("lastFiscalYearEnd")  # UNIX ts (int) or ISO str
            if not price or not lfy_raw:
                return None

            ee = t.earnings_estimate
            if ee is None or ee.empty or "0y" not in ee.index or "+1y" not in ee.index:
                return None

            eps_0y = float(ee.loc["0y", "avg"])
            eps_1y = float(ee.loc["+1y", "avg"])
            if eps_0y <= 0 or eps_1y <= 0:
                return None

            lfy_date = (_dt.date.fromtimestamp(lfy_raw) if isinstance(lfy_raw, int)
                        else _dt.date.fromisoformat(str(lfy_raw)[:10]))
            try:
                current_fy_end = lfy_date.replace(year=lfy_date.year + 1)
            except ValueError:
                current_fy_end = lfy_date.replace(year=lfy_date.year + 1, day=28)
            today_d = date.today()
            m = max(0, min(12, (current_fy_end.year - today_d.year) * 12
                               + (current_fy_end.month - today_d.month)))

            ntm_eps = (m / 12) * eps_0y + ((12 - m) / 12) * eps_1y
            return float(price) / ntm_eps

        except Exception as e:
            if attempt < retries - 1:
                wait = 30 * (attempt + 1)
                print(f"  [{sym}] error ({e}), retry in {wait}s...")
                time.sleep(wait)
            else:
                print(f"  [{sym}] failed after {retries} attempts: {e}")
                return None
    return None


def weighted_means(pairs: list[tuple[float, float]]) -> tuple[float, float]:
    """(value, weight) pairs -> (weighted arithmetic mean, weighted harmonic mean).

    harmonic = total_weight / Σ(weight/value), equivalent to a market-cap-
    weighted "aggregate P/E". Not rounded — callers round as their own output
    format requires. Callers must filter to only the valid/non-empty pairs
    first (this raises ZeroDivisionError on an empty list, same as the
    original inline code would via `sum(...) / total_w` with total_w == 0).
    """
    total_w = sum(w for _, w in pairs)
    arith = sum(v * w for v, w in pairs) / total_w
    harmonic = total_w / sum(w / v for v, w in pairs)
    return arith, harmonic


def write_daily_snapshot(out_path: Path, today: str, entry: dict, note: str) -> list:
    """Load existing data/*.json, merge today's entry, write {updated, note, data}.

    Verbatim tail of the valuation scripts' main(): merge direction is
    `{**by_date.get(today, {}), **entry}` — the caller's `entry` dict controls
    which keys are (re)written and their order; a key omitted from `entry`
    (e.g. because that day's fpe/tpe was None) leaves any existing value for
    that key untouched. Returns the merged+sorted list (callers print their
    own "Wrote N entries" message with it since wording differs per script).
    """
    existing = _common.load_rows(out_path)
    by_date = {r["date"]: r for r in existing}
    by_date[today] = {**by_date.get(today, {}), **entry}
    merged = sorted(by_date.values(), key=lambda r: r["date"])
    payload = {"updated": today, "note": note, "data": merged}
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    return merged
