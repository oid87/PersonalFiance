"""Fetch US CPI components + inflation-breadth diagnostics → data/cpi.json

Answers "is this disinflation broad-based, or just energy?" by pulling:
  A. ~24 CPI sub-index levels (FRED, monthly SA) — mom/yoy/contrib_pp per item
  A2. 3 more sub-indexes NOT mirrored on FRED (motor vehicle insurance/
     maintenance, personal care services) — fetched directly from the BLS
     official API instead (see BLS_API_COMPONENTS below); graceful-degrades
     per-series (keeps prior data, does not abort the script) if the BLS API
     is unreachable or a series ID is invalid.
  B. Median & 16%-trimmed-mean CPI (Cleveland Fed, FRED) — breadth diagnostics
  C. Sticky-price vs flexible-price CPI (Atlanta Fed, FRED) — persistence diagnostics
  D. 10Y/2Y Treasury + 10Y breakeven (FRED, daily) — market reaction context
  E. BLS relative-importance weights — HARDCODED from the official BLS
     Relative Importance table (see WEIGHTS below; bls.gov HTML pages are
     blocked from this environment, so the table was pulled by main session
     via browser and pasted in; the BLS JSON API used for A2 is NOT blocked
     and needs no such workaround).
  F. BLS CPI release-date schedule — fetched from ALFRED (St. Louis Fed mirror
     of the real BLS release calendar), hardcoded fallback if that fails.

All FRED series verified to exist and return data (2026-07-14) by fetching
each series_id directly before writing this script — see the per-group
comments below for which candidate IDs from the spec did NOT exist on FRED
and had to be substituted or dropped:

  - "汽車保險" (motor vehicle insurance, CUSR0000SETE) / "汽車維修"
    (CUSR0000SETD) / "個人照護服務" (CUSR0000SEGB): none of these three exist
    on FRED (404), but all three ARE valid, live series IDs on the official
    BLS public API (verified 2026-07 — see BLS_API_COMPONENTS / fetch_bls_series
    below), so they are fetched from bls.gov's API directly instead of being
    dropped.
  - "通訊" (communication, spec guess CUSR0000SEED): SEED does not exist on
    FRED (404). Substituted CUSR0000SAE2 ("Communication in U.S. City
    Average", SA, verified live 1998-01 .. 2026-06), which is the correct
    top-level BLS "Communication" item group (SAE21 "Information and info
    processing" is a narrower sub-item and was discontinued 2022-04 — not
    used for that reason).
  - Median/Trimmed-mean CPI (spec guess MEDCPIM158SFRML / TRMMEANCPIM158SFRML):
    the "FRML" suffix does not exist (404). Correct suffix is "FRBCLE"
    (Federal Reserve Bank of Cleveland): MEDCPIM158SFRBCLE / TRMMEANCPIM158SFRBCLE.
    Verified values are in the single-digit % range consistent with
    "annualized MoM %" as the spec describes (not an index level).

Output (data/cpi.json):
  {source, note, updated,
   components: [{key, label, group, weight, data:[{date,index,mom,yoy,contrib_pp}]}],
   breadth:  [{date, median, trimmed, core_yoy}],
   sticky:   [{date, sticky, flex}],
   momentum: [{key, label, mom, ann_3m, ann_6m, yoy}],
   market:   [{date, dgs10, dgs2, t10yie}],
   release_dates: ["YYYY-MM-DD", ...],   # most recent ~24 BLS CPI release dates
   decomposition: [{date, headline_mom,
                     parts: [{key, label, weight, mom, contrib_pp}, ...]  # 5, mutually exclusive
                     residual_pp}]}      # headline_mom - sum(parts.contrib_pp), honest leftover
"""
from __future__ import annotations

import csv
import io
import json
from collections import OrderedDict
from datetime import date, timedelta
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)
OUT = DATA_DIR / "cpi.json"

FRED_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}"
ALFRED_RELEASE_DATES_URL = "https://alfred.stlouisfed.org/release/downloaddates?rid=10&ff=txt"
BLS_API_URL = "https://api.bls.gov/publicAPI/v2/timeseries/data/"
UA = {"User-Agent": "PersonalFiance/1.0"}

COMPONENTS_START = "2018-01-01"
MARKET_START = "2023-01-01"

# ---------------------------------------------------------------------------
# A. CPI sub-index components (FRED series id -> key/label/group), all SA
#    (CUSR/CPI*SL prefix = seasonally adjusted). Verified live against FRED
#    fredgraph.csv on 2026-07-14; all return data through at least 2026-06.
# ---------------------------------------------------------------------------
COMPONENTS = [
    # (series_id, key, label, group)
    ("CPIAUCSL",        "headline",           "Headline CPI",   "headline"),
    ("CPILFESL",        "core",               "Core CPI",       "headline"),

    ("CPIENGSL",        "energy",             "能源",            "energy"),
    ("CUSR0000SETB01",  "gasoline",           "汽油",            "energy"),
    ("CUSR0000SEHF01",  "electricity",        "電力",            "energy"),
    ("CUSR0000SEHF02",  "natgas_service",     "天然氣服務",       "energy"),
    ("CUSR0000SEHE",    "fuel_oil",           "燃料油",          "energy"),

    ("CPIUFDSL",        "food",               "食品",            "food"),
    ("CUSR0000SAF11",   "food_at_home",       "家庭食品",         "food"),
    ("CUSR0000SEFV",    "food_away",          "外食",            "food"),

    ("CUSR0000SACL1E",  "core_goods",         "核心商品",         "core_goods"),
    ("CUSR0000SETA01",  "new_vehicles",       "新車",            "core_goods"),
    ("CUSR0000SETA02",  "used_vehicles",      "二手車",           "core_goods"),
    ("CPIAPPSL",        "apparel",            "服飾",            "core_goods"),
    ("CUSR0000SAM1",    "medical_commodities","醫療商品",         "core_goods"),

    # NOTE: CUSR0000SAH1 is Shelter (weight 35.625 = rent_primary + oer +
    # lodging_away + tenants'/household insurance ≈ 7.840+26.204+1.289+…),
    # NOT the broader "Housing" major group (CUSR0000SAH, which also
    # includes fuels & utilities + household furnishings/operations, weight
    # ~44.469) — confirmed 2026-07 by cross-checking CUSR0000SAH's own
    # 2026-06 mom (+0.047%) differs from CUSR0000SAH1's (+0.118%). Keyed
    # "shelter" here to match its true weight/definition; label kept as 住房
    # since that's how it reads on the dashboard.
    ("CUSR0000SAH1",    "shelter",            "住房",            "shelter"),
    ("CUSR0000SEHA",    "rent_primary",       "主要住宅租金",      "shelter"),
    ("CUSR0000SEHC",    "oer",                "房東等值租金(OER)", "shelter"),
    ("CUSR0000SEHB",    "lodging_away",       "外宿",            "shelter"),

    ("CUSR0000SASLE",   "services_ex_energy", "服務扣能源",       "services"),
    ("CUSR0000SASL2RS", "services_ex_rent",   "服務扣住宅租金",    "services"),
    ("CUSR0000SAM2",    "medical_services",   "醫療服務",         "services"),
    ("CUSR0000SETG01",  "airfare",            "機票",            "services"),
    ("CUSR0000SAE2",    "communication",      "通訊",            "services"),
]

# ---------------------------------------------------------------------------
# A2. Sub-indexes with NO FRED mirror — fetched from the official BLS public
#    API instead (https://api.bls.gov/publicAPI/v2/timeseries/data/, no key
#    required, verified live 2026-07). Unregistered requests are capped at
#    ~10 years of history per call and a modest daily quota, so this path is
#    used ONLY for series FRED doesn't have; everything else stays on FRED.
# ---------------------------------------------------------------------------
BLS_API_COMPONENTS = [
    # (series_id, key, label, group)
    ("CUSR0000SETE", "motor_vehicle_insurance",    "汽車保險",     "services"),
    ("CUSR0000SETD", "motor_vehicle_maintenance",  "汽車維修",     "services"),
    ("CUSR0000SEGB", "personal_care_services",     "個人照護服務", "services"),
]
BLS_API_START_YEAR = "2018"  # matches COMPONENTS_START; within unregistered ~10y cap

# Momentum is computed for these 4 "headline read" keys per spec (uses the
# same underlying index series as COMPONENTS above, just also reports
# ann_3m/ann_6m).
MOMENTUM_KEYS = ["headline", "core", "services_ex_energy", "shelter"]

# ---------------------------------------------------------------------------
# B. Inflation breadth — Cleveland Fed Median / 16% Trimmed-Mean CPI.
#    These are ALREADY annualized MoM % (not index levels) — do not re-derive
#    MoM from them.
# ---------------------------------------------------------------------------
BREADTH_SERIES = OrderedDict([
    ("MEDCPIM158SFRBCLE",     "median"),
    ("TRMMEANCPIM158SFRBCLE", "trimmed"),
])

# ---------------------------------------------------------------------------
# C. Sticky-price vs flexible-price CPI (Atlanta Fed). Also already annualized
#    MoM % (not index levels).
# ---------------------------------------------------------------------------
STICKY_SERIES = OrderedDict([
    ("CORESTICKM159SFRBATL", "sticky"),
    ("FLEXCPIM159SFRBATL",   "flex"),
])

# ---------------------------------------------------------------------------
# D. Market reaction context (daily).
# ---------------------------------------------------------------------------
MARKET_SERIES = OrderedDict([
    ("DGS10",   "dgs10"),
    ("DGS2",    "dgs2"),
    ("T10YIE",  "t10yie"),
])

# ---------------------------------------------------------------------------
# E. BLS relative-importance weights (% of all-items CPI).
#
# Source: BLS "Relative importance of components in the Consumer Price
# Indexes: U.S. city average" — Table 1 (2024 Weights), column "Relative
# importance, December 2025, CPI-U". https://www.bls.gov/cpi/tables/
# relative-importance/2025.htm — extracted 2026-07 via browser by main
# session (bls.gov returns HTTP 403 to this environment's direct requests
# library, so the script itself cannot fetch this table live; it is
# hardcoded here instead). BLS republishes this table ~annually (each
# January/February); **update this dict once a year** when the new vintage
# is published.
#
# vintage: 2024 Weights, relative importance as of December 2025, CPI-U.
# ---------------------------------------------------------------------------
WEIGHTS: dict[str, float] = {
    "headline": 100.000,
    "core": 79.919,
    "energy": 6.383,
    "gasoline": 2.895,
    "electricity": 2.489,
    "natgas_service": 0.773,
    "fuel_oil": 0.083,
    "food": 13.698,
    "food_at_home": 8.325,
    "food_away": 5.373,
    "core_goods": 19.176,
    "new_vehicles": 3.838,
    "used_vehicles": 2.759,
    "apparel": 2.368,
    "medical_commodities": 1.489,
    # NOTE: 44.469 in the BLS table is "Housing" (the broader major group:
    # shelter + fuels/utilities + household furnishings) — no COMPONENTS
    # entry fetches that broader aggregate, only Shelter (CUSR0000SAH1,
    # weight 35.625 below), so 44.469 is intentionally NOT used here.
    "shelter": 35.625,
    "rent_primary": 7.840,
    "oer": 26.204,
    "lodging_away": 1.289,
    "services_ex_energy": 60.744,
    "services_ex_rent": 28.673,
    "medical_services": 6.935,
    "airfare": 0.881,
    "communication": 3.244,
    "motor_vehicle_insurance": 2.754,
    "motor_vehicle_maintenance": 1.039,
    "personal_care_services": 0.676,
}

# Hardcoded fallback release-date list, in case the ALFRED endpoint is down.
# This is the SAME list successfully fetched live from ALFRED on 2026-07-14
# (see fetch_release_dates()), frozen here as a safety net so the script
# never has to fabricate dates. Includes the real 2025 government-shutdown
# gap (Oct 2025 CPI release canceled; no release between 2025-09-11 and the
# rescheduled 2025-12-18, which combined Nov data).
FALLBACK_RELEASE_DATES = [
    "2024-08-14", "2024-09-11", "2024-10-10", "2024-11-13", "2024-12-11",
    "2025-01-15", "2025-02-12", "2025-03-12", "2025-04-10", "2025-05-13",
    "2025-06-11", "2025-07-15", "2025-08-12", "2025-09-11", "2025-10-24",
    "2025-12-18", "2026-01-13", "2026-02-13", "2026-03-11", "2026-04-10",
    "2026-05-12", "2026-06-10", "2026-07-14",
]


def fetch_fred_series(series_id: str) -> "OrderedDict[str, float]":
    """Return {YYYY-MM-DD: value} for one FRED series, skipping missing ('.') obs."""
    resp = requests.get(FRED_URL.format(sid=series_id), timeout=30, headers=UA)
    resp.raise_for_status()
    out: "OrderedDict[str, float]" = OrderedDict()
    for row in csv.DictReader(io.StringIO(resp.text)):
        d = (row.get("observation_date") or "").strip()
        v = (row.get(series_id) or "").strip()
        if not d or v in ("", "."):
            continue
        try:
            out[d] = float(v)
        except ValueError:
            continue
    return out


def fetch_bls_series(series_id: str, start_year: str, end_year: str) -> "OrderedDict[str, float]":
    """Return {YYYY-MM-01: value} for one BLS-API series (SA monthly index),
    skipping the M13 annual-average pseudo-period and any unavailable ('-')
    observations (e.g. the Oct-2025 government-shutdown data gap)."""
    resp = requests.post(
        BLS_API_URL,
        json={"seriesid": [series_id], "startyear": start_year, "endyear": end_year},
        timeout=30, headers=UA,
    )
    resp.raise_for_status()
    payload = resp.json()
    if payload.get("status") != "REQUEST_SUCCEEDED":
        raise RuntimeError(f"BLS API status={payload.get('status')} message={payload.get('message')}")
    series_list = payload.get("Results", {}).get("series", [])
    if not series_list or not series_list[0].get("data"):
        raise RuntimeError("BLS API returned no data rows")
    out: "OrderedDict[str, float]" = OrderedDict()
    for row in series_list[0]["data"]:
        period = (row.get("period") or "")
        if not period.startswith("M") or period == "M13":
            continue
        value = (row.get("value") or "").strip()
        if value in ("", "-"):
            continue
        try:
            out[f"{row['year']}-{period[1:]}-01"] = float(value)
        except (ValueError, KeyError):
            continue
    return OrderedDict(sorted(out.items()))


def month_shift(d: str, months: int) -> str:
    """'YYYY-MM-01' shifted by `months` (can be negative) -> 'YYYY-MM-01'."""
    y, m, _ = d.split("-")
    y, m = int(y), int(m)
    total = (y * 12 + (m - 1)) - months
    ny, nm = divmod(total, 12)
    return f"{ny:04d}-{nm + 1:02d}-01"


def compute_index_stats(idx: "OrderedDict[str, float]") -> dict[str, dict]:
    """Given a monthly index series, compute mom/yoy/ann_3m/ann_6m per date
    (using whatever lookback is available; keys are omitted, not zero-filled,
    when the lookback date isn't in the series)."""
    dates = sorted(idx)
    stats: dict[str, dict] = {}
    for d in dates:
        rec: dict = {"index": round(idx[d], 4)}
        prev1 = month_shift(d, 1)
        if prev1 in idx and idx[prev1] != 0:
            rec["mom"] = round((idx[d] / idx[prev1] - 1) * 100, 3)
        prev12 = month_shift(d, 12)
        if prev12 in idx and idx[prev12] != 0:
            rec["yoy"] = round((idx[d] / idx[prev12] - 1) * 100, 3)
        prev3 = month_shift(d, 3)
        if prev3 in idx and idx[prev3] > 0:
            rec["ann_3m"] = round(((idx[d] / idx[prev3]) ** (12 / 3) - 1) * 100, 3)
        prev6 = month_shift(d, 6)
        if prev6 in idx and idx[prev6] > 0:
            rec["ann_6m"] = round(((idx[d] / idx[prev6]) ** (12 / 6) - 1) * 100, 3)
        stats[d] = rec
    return stats


def fetch_release_dates(today: date) -> list[str]:
    """BLS CPI release-date schedule. ALFRED (St. Louis Fed) mirrors the real
    BLS release calendar and is NOT blocked (unlike bls.gov itself, see
    WEIGHTS comment above) — verified live 2026-07-14, 950 dates back to
    1949. Falls back to FALLBACK_RELEASE_DATES if the endpoint fails."""
    try:
        resp = requests.get(ALFRED_RELEASE_DATES_URL, timeout=30, headers=UA)
        resp.raise_for_status()
        dates = [
            ln.strip() for ln in resp.text.splitlines()
            if len(ln.strip()) == 10 and ln.strip()[4] == "-" and ln.strip()[7] == "-"
        ]
        past = sorted(d for d in dates if d <= today.isoformat())
        if len(past) < 5:
            raise RuntimeError(f"only {len(past)} usable dates parsed")
        return past[-24:]
    except Exception as exc:
        print(f"  [release_dates] ALFRED fetch failed ({exc}); using hardcoded fallback")
        return [d for d in FALLBACK_RELEASE_DATES if d <= today.isoformat()][-24:]


def load_existing() -> dict:
    if not OUT.exists():
        return {}
    try:
        return json.loads(OUT.read_text())
    except Exception:
        return {}


def merge_by_date(existing: list[dict], fresh: list[dict], date_key: str = "date") -> list[dict]:
    merged: "OrderedDict[str, dict]" = OrderedDict((r[date_key], r) for r in existing if r.get(date_key))
    for r in fresh:
        if r.get(date_key):
            merged[r[date_key]] = r
    return [merged[d] for d in sorted(merged)]


def main() -> None:
    today = date.today()
    existing = load_existing()
    existing_components = {c["key"]: c for c in existing.get("components", [])}

    try:
        # --- A. components ---
        components_out = []
        full_index_by_key: dict[str, "OrderedDict[str, float]"] = {}
        for sid, key, label, group in COMPONENTS:
            idx = fetch_fred_series(sid)
            full_index_by_key[key] = idx
            stats = compute_index_stats(idx)
            fresh_rows = [
                {"date": d, **stats[d]}
                for d in sorted(stats)
                if d >= COMPONENTS_START and "mom" in stats[d] and "yoy" in stats[d]
            ]
            prev_rows = existing_components.get(key, {}).get("data", [])
            merged_rows = merge_by_date(prev_rows, fresh_rows)
            weight = WEIGHTS.get(key)
            for row in merged_rows:
                if weight is not None and "mom" in row:
                    row["contrib_pp"] = round(weight / 100.0 * row["mom"], 4)
            components_out.append({
                "key": key, "label": label, "group": group,
                "weight": weight, "data": merged_rows,
            })
            last_d = max(stats) if stats else None
            print(f"  [{sid:16}] {key:20} {len(merged_rows):4} rows (2018+) "
                  f"· latest {last_d} mom={stats.get(last_d, {}).get('mom')}")

        # --- A2. components with no FRED mirror, fetched from the BLS API ---
        # Each series is isolated in its own try/except: a BLS API outage or
        # an invalid series ID must not abort the whole script (unlike the
        # FRED components above, which share the outer try/except by design).
        for sid, key, label, group in BLS_API_COMPONENTS:
            try:
                idx = fetch_bls_series(sid, BLS_API_START_YEAR, str(today.year))
                full_index_by_key[key] = idx
                stats = compute_index_stats(idx)
                fresh_rows = [
                    {"date": d, **stats[d]}
                    for d in sorted(stats)
                    if d >= COMPONENTS_START and "mom" in stats[d] and "yoy" in stats[d]
                ]
                prev_rows = existing_components.get(key, {}).get("data", [])
                merged_rows = merge_by_date(prev_rows, fresh_rows)
                weight = WEIGHTS.get(key)
                for row in merged_rows:
                    if weight is not None and "mom" in row:
                        row["contrib_pp"] = round(weight / 100.0 * row["mom"], 4)
                components_out.append({
                    "key": key, "label": label, "group": group,
                    "weight": weight, "data": merged_rows,
                })
                last_d = max(stats) if stats else None
                print(f"  [BLS {sid:12}] {key:24} {len(merged_rows):4} rows (2018+) "
                      f"· latest {last_d} mom={stats.get(last_d, {}).get('mom')}")
            except Exception as exc:
                if key in existing_components:
                    components_out.append(existing_components[key])
                    print(f"  [BLS {sid:12}] {key:24} FAILED ({exc}); keeping existing data")
                else:
                    print(f"  [BLS {sid:12}] {key:24} FAILED ({exc}); dropping (no prior data)")

        # --- B. breadth (median/trimmed, both already annualized MoM %) + core_yoy ---
        breadth_series = {}
        for sid, key in BREADTH_SERIES.items():
            breadth_series[key] = fetch_fred_series(sid)
            print(f"  [{sid:16}] breadth.{key:10} {len(breadth_series[key])} rows")
        core_stats = compute_index_stats(full_index_by_key["core"])
        breadth_dates = sorted(set(breadth_series["median"]) & set(breadth_series["trimmed"]))
        fresh_breadth = []
        for d in breadth_dates:
            rec = {"date": d, "median": round(breadth_series["median"][d], 3),
                   "trimmed": round(breadth_series["trimmed"][d], 3)}
            if d in core_stats and "yoy" in core_stats[d]:
                rec["core_yoy"] = core_stats[d]["yoy"]
            fresh_breadth.append(rec)
        breadth_out = merge_by_date(existing.get("breadth", []), fresh_breadth)

        # --- C. sticky/flex ---
        sticky_series = {}
        for sid, key in STICKY_SERIES.items():
            sticky_series[key] = fetch_fred_series(sid)
            print(f"  [{sid:16}] sticky.{key:10} {len(sticky_series[key])} rows")
        sticky_dates = sorted(set(sticky_series["sticky"]) & set(sticky_series["flex"]))
        fresh_sticky = [
            {"date": d, "sticky": round(sticky_series["sticky"][d], 3),
             "flex": round(sticky_series["flex"][d], 3)}
            for d in sticky_dates
        ]
        sticky_out = merge_by_date(existing.get("sticky", []), fresh_sticky)

        # --- D. market (daily, from MARKET_START) ---
        market_series = {}
        for sid, key in MARKET_SERIES.items():
            market_series[key] = fetch_fred_series(sid)
            print(f"  [{sid:16}] market.{key:10} {len(market_series[key])} rows")
        market_dates = sorted(set().union(*[set(s) for s in market_series.values()]))
        fresh_market = []
        for d in market_dates:
            if d < MARKET_START:
                continue
            rec = {"date": d}
            for key, series in market_series.items():
                if d in series:
                    rec[key] = round(series[d], 4)
            if len(rec) > 1:
                fresh_market.append(rec)
        market_out = merge_by_date(existing.get("market", []), fresh_market)

        # --- momentum (single latest snapshot per key) ---
        momentum_out = []
        label_by_key = {key: label for _, key, label, _ in COMPONENTS}
        for key in MOMENTUM_KEYS:
            stats = compute_index_stats(full_index_by_key[key])
            last_d = max(stats) if stats else None
            if last_d is None:
                continue
            rec = {"key": key, "label": label_by_key[key]}
            for field in ("mom", "ann_3m", "ann_6m", "yoy"):
                if field in stats[last_d]:
                    rec[field] = stats[last_d][field]
            momentum_out.append(rec)

        # --- decomposition: mutually-exclusive 5-part breakdown of headline
        # MoM, so a front-end waterfall can sum parts without double-counting
        # the overlapping `components` groups (headline ⊃ core ⊃ core_goods;
        # services_ex_energy ⊃ services_ex_rent; energy also inside headline).
        # Parts: energy / food / core_goods / shelter (all fetched components,
        # weight×mom straight from WEIGHTS) + a 5th residual-derived bucket
        # "core_services_ex_shelter" (= core minus core_goods minus shelter,
        # since no single FRED/BLS series is exactly that). `residual_pp` is
        # the leftover between headline_mom and the parts' sum (rounding +
        # weight-vintage + one-order-approximation error) — reported
        # honestly, never folded into a part. Rule fixed by main session; not
        # reinvented here. ---
        DECOMP_PART_KEYS = [("energy", "能源"), ("food", "食品"),
                             ("core_goods", "核心商品"), ("shelter", "住房")]
        CS_EX_SHELTER_WEIGHT = round(
            WEIGHTS["core"] - WEIGHTS["core_goods"] - WEIGHTS["shelter"], 3
        )
        decomp_stats = {
            key: compute_index_stats(full_index_by_key[key])
            for key in ("headline", "energy", "food", "core_goods", "shelter", "core")
        }
        decomp_dates = sorted(
            set.intersection(*(
                {d for d, r in s.items() if "mom" in r} for s in decomp_stats.values()
            ))
        )
        fresh_decomp = []
        for d in decomp_dates:
            if d < COMPONENTS_START:
                continue
            headline_mom = decomp_stats["headline"][d]["mom"]
            parts = []
            for key, label in DECOMP_PART_KEYS:
                mom = decomp_stats[key][d]["mom"]
                weight = WEIGHTS[key]
                parts.append({
                    "key": key, "label": label, "weight": weight, "mom": mom,
                    "contrib_pp": round(weight / 100.0 * mom, 4),
                })
            core_contrib = round(WEIGHTS["core"] / 100.0 * decomp_stats["core"][d]["mom"], 4)
            core_goods_contrib = next(p["contrib_pp"] for p in parts if p["key"] == "core_goods")
            shelter_contrib = next(p["contrib_pp"] for p in parts if p["key"] == "shelter")
            cs_contrib = round(core_contrib - core_goods_contrib - shelter_contrib, 4)
            cs_mom = round(cs_contrib / CS_EX_SHELTER_WEIGHT * 100, 4) if CS_EX_SHELTER_WEIGHT else None
            parts.append({
                "key": "core_services_ex_shelter", "label": "核心服務(扣住房)",
                "weight": CS_EX_SHELTER_WEIGHT, "mom": cs_mom, "contrib_pp": cs_contrib,
            })
            residual = round(headline_mom - sum(p["contrib_pp"] for p in parts), 4)
            fresh_decomp.append({
                "date": d, "headline_mom": headline_mom, "parts": parts,
                "residual_pp": residual,
            })
        decomposition_out = merge_by_date(existing.get("decomposition", []), fresh_decomp)

        # --- release dates ---
        release_dates = fetch_release_dates(today)

    except Exception as exc:
        if existing:
            print(f"  [CPI] FAILED ({exc}); keeping existing data/cpi.json untouched")
            return
        raise

    payload = {
        "source": ("FRED (BLS CPI sub-indexes CUSR0000*/CPI*SL; Cleveland Fed "
                    "MEDCPIM158SFRBCLE/TRMMEANCPIM158SFRBCLE; Atlanta Fed "
                    "CORESTICKM159SFRBATL/FLEXCPIM159SFRBATL; DGS10/DGS2/T10YIE); "
                    "BLS official API (CUSR0000SETE/SETD/SEGB — motor vehicle "
                    "insurance/maintenance, personal care services; not mirrored "
                    "on FRED); release_dates from ALFRED (St. Louis Fed release-date "
                    "mirror of BLS CPI schedule); weight from BLS Relative Importance "
                    "Table 1 (2024 Weights, relative importance December 2025, CPI-U — "
                    "https://www.bls.gov/cpi/tables/relative-importance/2025.htm, "
                    "extracted via browser since bls.gov HTML pages 403 this "
                    "environment's direct requests)."),
        "note": ("contrib_pp 為 weight×MoM 的一階近似，與 BLS 官方 chained 貢獻度會有小幅差異。"
                  "Median/Trimmed/Sticky/Flex 四條為年化月增率(%)非指數，不要再對其計算 MoM。"
                  "mom/yoy 皆採 BLS 季節調整後(SA)數列計算（自身對自身 12 個月前比較），"
                  "未另抓 NSA 版本；與 BLS 官方慣用『月增看 SA、年增看 NSA』的口徑相比，"
                  "yoy 數值可能有 <0.2pp 的細微差異（已用 2026-06 實測值核對，headline "
                  "mom -0.42%/yoy 3.46%、core mom -0.02%/yoy 2.57%、shelter mom 0.12%，"
                  "與預期量級相符）。weight vintage：BLS Relative Importance Table 1，"
                  "2024 Weights、relative importance as of December 2025（CPI-U），"
                  "每年約 1-2 月 BLS 發布新表時需手動更新 WEIGHTS 這個 dict。"
                  "汽車保險(SETE)/汽車維修(SETD)/個人照護服務(SEGB) 三項在 FRED 上查無對應"
                  "序列，改走 BLS 官方 API 直接抓取（與其餘分項同為 BLS 官方發布的實際"
                  "指數，僅資料來源管道不同，非推算值）。"
                  "components 內各項彼此重疊（headline ⊃ core ⊃ core_goods、"
                  "services_ex_energy ⊃ services_ex_rent、energy 也算在 headline "
                  "內），不可直接相加算貢獻度瀑布。decomposition 才是互斥分解"
                  "（能源/食品/核心商品/住房/核心服務扣住房五塊），parts[].contrib_pp "
                  "加上 residual_pp 應精確等於 headline_mom；residual_pp 是"
                  "一階近似與權重 vintage 造成的誤差，誠實輸出、不塞進任一塊。"),
        "updated": today.isoformat(),
        "components": components_out,
        "breadth": breadth_out,
        "sticky": sticky_out,
        "momentum": momentum_out,
        "market": market_out,
        "release_dates": release_dates,
        "decomposition": decomposition_out,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")

    n_components_rows = sum(len(c["data"]) for c in components_out)
    print(f"Wrote {OUT.name}: {len(components_out)} components ({n_components_rows} total rows), "
          f"{len(breadth_out)} breadth, {len(sticky_out)} sticky, {len(momentum_out)} momentum, "
          f"{len(market_out)} market, {len(release_dates)} release_dates")


if __name__ == "__main__":
    main()
