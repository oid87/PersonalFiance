"""Fetch QQQ (Nasdaq-100) sub-industry-level signed dollar volume flow ranking.
→ data/qqq_sector_flows.json

Constituents source: Wikipedia "List of NASDAQ-100 companies"
  https://en.wikipedia.org/wiki/List_of_NASDAQ-100_companies
  (NOT "Nasdaq-100" — that page no longer carries the components table; it hatnotes
  out to this separate list page.)

IMPORTANT taxonomy note: this Wikipedia table's columns are "ICB Industry" / "ICB
Subsector" (Industry Classification Benchmark), NOT GICS Sector / GICS Sub-Industry
as originally assumed in the spec. Checked live on 2026-07-10 — the "Nasdaq-100"
page's components table (with GICS columns) does not exist on Wikipedia; only this
ICB-classified list does. ICB Subsector is used as the functional equivalent of GICS
Sub-Industry (same granularity intent); "Semiconductors" and "Software" subsectors
exist verbatim in both taxonomies. There is no ICB category matching GICS's
"Interactive Media & Services" or "Technology Hardware, Storage & Peripherals"
verbatim, so those two names from the spec's protected-group list have no exact ICB
counterpart — only Semiconductors/Software are protected from singleton merge-up
(see PROTECTED_GROUPS below). Flagged for spec owner review.

Flow proxy per stock (daily, trailing only — no future function):
  Close(t) × Volume(t) × sign(Close(t)/Close(t-1) - 1)
Summed per ICB-subsector-derived group, per trailing window (1d / 5d / 20d).
"days" field = count of days within the window where the GROUP's aggregate daily
flow (summed across member tickers) was net positive (i.e. "net-inflow day count"),
not the window length.

Not a real fund-flow measure (same caveat as scripts/fetch_flows.py) — signed dollar
volume is a directional proxy only.
"""
from __future__ import annotations

import json
import sys
from datetime import date, timedelta
from io import StringIO
from pathlib import Path

import pandas as pd
import requests
import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "qqq_sector_flows.json"

WIKI_URL = "https://en.wikipedia.org/wiki/List_of_NASDAQ-100_companies"
PROTECTED_GROUPS = {"Semiconductors", "Software"}
WINDOWS = {"1d": 1, "5d": 5, "20d": 20}

# Hardcoded fallback (used only if the Wikipedia scrape fails) — covers major names
# across the groups the spec explicitly calls out. NOT exhaustive; coverage will be
# low if this path triggers, which is reported honestly in the output note.
FALLBACK_CONSTITUENTS = [
    ("NVDA", "Technology", "Semiconductors"), ("AVGO", "Technology", "Semiconductors"),
    ("AMD", "Technology", "Semiconductors"), ("QCOM", "Technology", "Semiconductors"),
    ("TXN", "Technology", "Semiconductors"), ("INTC", "Technology", "Semiconductors"),
    ("ADI", "Technology", "Semiconductors"), ("MU", "Technology", "Semiconductors"),
    ("KLAC", "Technology", "Semiconductors"), ("LRCX", "Technology", "Semiconductors"),
    ("MRVL", "Technology", "Semiconductors"), ("NXPI", "Technology", "Semiconductors"),
    ("MCHP", "Technology", "Semiconductors"), ("ASML", "Technology", "Semiconductors"),
    ("AMAT", "Technology", "Semiconductors"), ("MPWR", "Technology", "Semiconductors"),
    ("MSFT", "Technology", "Software"), ("GOOGL", "Technology", "Software"),
    ("GOOG", "Technology", "Software"), ("ADBE", "Technology", "Software"),
    ("CRWD", "Technology", "Software"), ("PANW", "Technology", "Software"),
    ("INTU", "Technology", "Software"), ("SNPS", "Technology", "Software"),
    ("CDNS", "Technology", "Software"), ("WDAY", "Technology", "Software"),
    ("DDOG", "Technology", "Software"), ("FTNT", "Technology", "Software"),
    ("PLTR", "Technology", "Software"), ("PYPL", "Technology", "Software"),
    ("AAPL", "Technology", "Consumer Electronics"),
    ("META", "Technology", "Interactive Media & Services"),
    ("NFLX", "Consumer Discretionary", "Interactive Media & Services"),
    ("AMZN", "Consumer Discretionary", "Catalog/Specialty Distribution"),
    ("TSLA", "Consumer Discretionary", "Automobiles & Parts"),
    ("COST", "Consumer Staples", "Retail"),
    ("PEP", "Consumer Staples", "Soft Drinks"),
    ("CSCO", "Technology", "Communication Equipment"),
    ("CMCSA", "Communication Services", "Cable & Other Pay Television Services"),
    ("TMUS", "Communication Services", "Telecommunications Services"),
    ("GILD", "Health Care", "Biotechnology"),
    ("VRTX", "Health Care", "Biotechnology"),
    ("REGN", "Health Care", "Biotechnology"),
    ("AMGN", "Health Care", "Biotechnology"),
    ("ISRG", "Health Care", "Medical/Dental Instruments"),
    ("BKNG", "Consumer Discretionary", "Hotels/Resorts"),
    ("SBUX", "Consumer Discretionary", "Restaurants"),
    ("HON", "Industrials", "Diversified Industrials"),
]


def fetch_constituents() -> tuple[pd.DataFrame, str, bool]:
    """Returns (df[Ticker, Industry, Subsector], source_desc, used_fallback)."""
    try:
        r = requests.get(WIKI_URL, headers={"User-Agent": "Mozilla/5.0"}, timeout=30)
        r.raise_for_status()
        tables = pd.read_html(StringIO(r.text), header=0, flavor="lxml")
        t = tables[0]
        cols = [str(c) for c in t.columns]
        if len(cols) < 4 or "Ticker" not in cols[0]:
            raise ValueError(f"unexpected table columns: {cols}")
        t = t.iloc[:, :4].copy()
        t.columns = ["Ticker", "Company", "Industry", "Subsector"]
        for c in ("Ticker", "Industry", "Subsector"):
            t[c] = t[c].astype(str).str.strip()
        t = t[t["Ticker"] != ""]
        t = t.drop_duplicates(subset=["Ticker"])
        if len(t) < 90:
            raise ValueError(f"too few rows after parse: {len(t)}")
        return (
            t[["Ticker", "Industry", "Subsector"]].reset_index(drop=True),
            "Wikipedia: List of NASDAQ-100 companies (ICB Industry / ICB Subsector, "
            "used as functional equivalent of GICS Sector / Sub-Industry — see module docstring)",
            False,
        )
    except Exception as e:
        print(f"  [warn] Wikipedia scrape failed ({e}); using hardcoded fallback constituents", file=sys.stderr)
        df = pd.DataFrame(FALLBACK_CONSTITUENTS, columns=["Ticker", "Industry", "Subsector"])
        return df, "hardcoded fallback constituents (Wikipedia scrape failed — LOW coverage, see coverage field)", True


def assign_groups(df: pd.DataFrame) -> pd.DataFrame:
    """Sub-industry grouping; merge singleton subsectors into their Industry,
    except protected groups (Semiconductors, Software)."""
    counts = df["Subsector"].value_counts()
    singleton = set(counts[counts == 1].index)
    df = df.copy()
    df["Group"] = df.apply(
        lambda r: r["Industry"] if (r["Subsector"] in singleton and r["Subsector"] not in PROTECTED_GROUPS) else r["Subsector"],
        axis=1,
    )
    return df


def fetch_daily_signed_flow(tickers: list[str], start: str) -> dict[str, pd.Series]:
    """Per-ticker daily signed dollar volume series (trailing only, sign = same-day return)."""
    print(f"Downloading {len(tickers)} tickers from {start}...")
    raw = yf.download(tickers, start=start, auto_adjust=False, group_by="ticker", threads=True, progress=False)

    out: dict[str, pd.Series] = {}
    for tk in tickers:
        try:
            if len(tickers) == 1:
                sub = raw
            else:
                if tk not in raw.columns.get_level_values(0):
                    continue
                sub = raw[tk]
        except Exception:
            continue
        sub = sub.dropna(subset=["Close", "Volume"])
        if sub.empty or len(sub) < 2:
            continue
        ret = sub["Close"].pct_change()
        sign = ret.apply(lambda x: 1.0 if x >= 0 else (-1.0 if x < 0 else 0.0))
        signed = sub["Close"] * sub["Volume"] * sign
        signed = signed.dropna()
        if signed.empty:
            continue
        out[tk] = signed
    return out


def build_windows(df: pd.DataFrame, flows: dict[str, pd.Series]) -> dict[str, list[dict]]:
    """Aggregate per-group flow for each trailing window."""
    tk_to_group = dict(zip(df["Ticker"], df["Group"]))
    group_counts_total = df.groupby("Group")["Ticker"].nunique().to_dict()

    # union of all trading dates actually present, sorted ascending
    all_dates = sorted(set().union(*[set(s.index) for s in flows.values()])) if flows else []

    result: dict[str, list[dict]] = {}
    for win_key, win_len in WINDOWS.items():
        window_dates = all_dates[-win_len:] if len(all_dates) >= win_len else all_dates

        # per-group daily total flow (for "net-inflow day count")
        group_daily: dict[str, dict] = {}  # group -> {date: sum_flow}
        group_flow_total: dict[str, float] = {}
        group_member_count: dict[str, int] = {}

        for tk, s in flows.items():
            grp = tk_to_group.get(tk)
            if grp is None:
                continue
            s_win = s[s.index.isin(window_dates)]
            if s_win.empty:
                continue
            group_member_count[grp] = group_member_count.get(grp, 0) + 1
            group_flow_total[grp] = group_flow_total.get(grp, 0.0) + s_win.sum()
            gd = group_daily.setdefault(grp, {})
            for d, v in s_win.items():
                gd[d] = gd.get(d, 0.0) + v

        rows = []
        for grp, total in group_flow_total.items():
            gd = group_daily.get(grp, {})
            net_inflow_days = sum(1 for v in gd.values() if v > 0)
            rows.append({
                "group": grp,
                "flow": round(total / 1e9, 4),
                "days": net_inflow_days,
                "count": group_member_count.get(grp, 0),
            })
        rows.sort(key=lambda r: r["flow"], reverse=True)
        result[win_key] = rows

    return result


def main():
    print("Fetching Nasdaq-100 constituents (Wikipedia)...")
    const_df, source_desc, used_fallback = fetch_constituents()
    print(f"  → {len(const_df)} tickers, source_fallback={used_fallback}")

    const_df = assign_groups(const_df)
    print(f"  → {const_df['Group'].nunique()} groups")

    tickers = const_df["Ticker"].tolist()
    start = (date.today() - timedelta(days=90)).isoformat()

    flows = fetch_daily_signed_flow(tickers, start)
    mapped = len(flows)
    total = len(tickers)
    print(f"  → mapped {mapped}/{total} tickers with usable price data")
    missing = sorted(set(tickers) - set(flows.keys()))
    if missing:
        print(f"  [warn] no usable data for: {missing}")

    windows = build_windows(const_df, flows)

    for wk in WINDOWS:
        rows = windows[wk]
        print(f"\n=== window {wk} ({len(rows)} groups) ===")
        print("Top 3:")
        for r in rows[:3]:
            print(f"   {r}")
        print("Bottom 3:")
        for r in rows[-3:]:
            print(f"   {r}")
        semi = next((r for r in rows if r["group"] == "Semiconductors"), None)
        rank = rows.index(semi) + 1 if semi else None
        print(f"Semiconductors: {semi}  (rank {rank}/{len(rows)})")

    payload = {
        "source": source_desc,
        "note": (
            "Signed dollar volume proxy (Close × Volume × sign(daily return)), summed per "
            "sub-industry group — NOT actual fund flow data. Groups are ICB Subsector "
            "(Wikipedia's Nasdaq-100 list uses ICB, not GICS; see fetch script docstring). "
            "Caveat: the ICB 'Software' group is broader than GICS — it also sweeps in some "
            "interactive-media / industrial names (e.g. GOOGL, META, ROP). The Semiconductors "
            "group is clean (pure chip names, no overlap with the Technology catch-all). "
            f"Constituent coverage: {mapped}/{total} tickers mapped to usable price data."
        ),
        "updated": date.today().isoformat(),
        "coverage": {"mapped": mapped, "total": total},
        "windows": windows,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, allow_nan=False) + "\n")
    print(f"\nWrote {OUT} ({OUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
