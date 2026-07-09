"""Compute 臺灣50 (0050) market breadth: % of stocks above 50-day and 200-day MA.

Output: data/breadth_tw50.json
Strategy:
  - No existing file → full backfill (download 3 years of history)
  - Stale existing   → incremental (download last 350 cal. days, recompute tail)
  - Fresh existing   → skip
"""
from __future__ import annotations

import json
import re
from datetime import date, timedelta
from pathlib import Path

import time

import requests
from io import StringIO

import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
OUT_PATH = DATA_DIR / "breadth_tw50.json"

FRESHNESS_DAYS    = 4     # same as isDataFresh() in frontend
FULL_BACKFILL_CAL = 2555  # ~7 calendar years → ~1820 trading days → ~1620 valid after 200-day warmup
INCREMENTAL_CAL   = 450   # must cover win52=252 trading days (~365 cal. days) + 30-day recompute
                          # buffer below, or prev_hi/prev_lo never satisfy min_periods=252 and
                          # new_hi/new_lo silently null out on every incremental run (2026-05-23 regression)
MIN_COVERAGE      = 45    # ~90% of 50 TW50 constituents; drop RECENT days below this.
RECENT_WINDOW_DAYS = 14   #   yfinance hasn't filled all ~50 names yet → shrunk denominator spikes %).
#   Gated to recent days only, so deep-history days (constituents that hadn't IPO'd yet → lower
#   valid count) are NOT dropped.


TW50_MEMBERS_PATH  = DATA_DIR / "tw50_members.json"   # cached constituent list (committed)
MEMBERS_STALE_DAYS = 90    # 臺灣50 半年審核一次;季度重抓,日常跑 reuse cache(1 request 而已但避免依賴外站每日可用)
TW50_SIZE = 50

# Static fallback = 臺灣50 constituents (2026-07-09 Wikipedia snapshot). Refresh after the
# semi-annual (3月/9月) index review. Used only if the Wikipedia scrape fails/returns too few.
TW50_FALLBACK = [
    "2345.TW", "3661.TW", "3017.TW", "6919.TW", "5871.TW", "2412.TW", "2308.TW", "2383.TW",
    "4904.TW", "6505.TW", "2881.TW", "2207.TW", "2883.TW", "3008.TW", "2454.TW", "1303.TW",
    "4938.TW", "2382.TW", "5876.TW", "5880.TW", "2330.TW", "1216.TW", "2615.TW", "6669.TW",
    "2609.TW", "2395.TW", "3711.TW", "2357.TW", "2882.TW", "2002.TW", "2891.TW", "2884.TW",
    "2603.TW", "2892.TW", "1301.TW", "2317.TW", "2880.TW", "2059.TW", "2301.TW", "2886.TW",
    "3034.TW", "2912.TW", "2379.TW", "2890.TW", "3045.TW", "2887.TW", "2303.TW", "3231.TW",
    "2327.TW", "2885.TW",
]


def _load_cached_members() -> list[str] | None:
    if not TW50_MEMBERS_PATH.exists():
        return None
    try:
        obj = json.loads(TW50_MEMBERS_PATH.read_text())
        if (date.today() - date.fromisoformat(obj["updated"])).days > MEMBERS_STALE_DAYS:
            return None
        members = obj.get("tickers", [])
        return members if len(members) >= TW50_SIZE - 5 else None
    except Exception:
        return None


def get_tw50_tickers() -> list[str]:
    """0050 = 臺灣50指數 constituents (50 largest TWSE names). Scrape the zh.wikipedia
    constituent table (股票代號 columns, 值形如「臺證所:2330」), append .TW; cache 90 days;
    static fallback on failure."""
    cached = _load_cached_members()
    if cached:
        print(f"  Using cached TW50 members ({len(cached)}) from {TW50_MEMBERS_PATH.name}")
        return cached
    try:
        url  = "https://zh.wikipedia.org/wiki/臺灣50指數"
        html = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=30).text
        tables = pd.read_html(StringIO(html))
        table  = next(t for t in tables if any("股票代號" in str(c) for c in t.columns))
        codes: list[str] = []
        for col in [c for c in table.columns if "股票代號" in str(c)]:
            for v in table[col].tolist():
                m = re.search(r"(\d{4})", str(v))
                if m:
                    code = m.group(1) + ".TW"
                    if code not in codes:
                        codes.append(code)
        if len(codes) < TW50_SIZE - 3:
            raise RuntimeError(f"only {len(codes)} codes parsed from Wikipedia")
        codes = codes[:TW50_SIZE]
        TW50_MEMBERS_PATH.write_text(
            json.dumps({"updated": date.today().isoformat(), "tickers": codes},
                       ensure_ascii=False) + "\n")
        print(f"  Parsed {len(codes)} 臺灣50 constituents from Wikipedia "
              f"(cached to {TW50_MEMBERS_PATH.name})")
        return codes
    except Exception as exc:
        print(f"  Wikipedia TW50 parse failed ({exc}); using static fallback list")
        return TW50_FALLBACK


def load_existing() -> list[dict]:
    if not OUT_PATH.exists():
        return []
    try:
        return json.loads(OUT_PATH.read_text()).get("data", [])
    except Exception:
        return []


CHUNK_SIZE = 50  # tickers per yfinance batch to avoid rate limiting


def fetch_prices(tickers: list[str], start: str) -> pd.DataFrame:
    """Download closing prices in chunks to avoid Yahoo Finance rate limits."""
    end    = (date.today() + timedelta(days=1)).isoformat()
    chunks = [tickers[i:i + CHUNK_SIZE] for i in range(0, len(tickers), CHUNK_SIZE)]
    print(f"  Downloading {len(tickers)} tickers in {len(chunks)} chunks of ≤{CHUNK_SIZE} ...")

    frames: list[pd.DataFrame] = []
    for idx, chunk in enumerate(chunks):
        df = pd.DataFrame()
        for attempt in range(3):
            try:
                df = yf.download(
                    chunk, start=start, end=end,
                    auto_adjust=True, progress=False, threads=True,
                )
                if not df.empty:
                    break
            except Exception as exc:
                print(f"  [chunk {idx+1}] attempt {attempt+1} error: {exc}")
            if attempt < 2:
                time.sleep(3)

        if df.empty:
            print(f"  [chunk {idx+1}/{len(chunks)}] no data, skipping")
            continue
        if isinstance(df.columns, pd.MultiIndex):
            df = df["Close"]
        frames.append(df)
        if idx < len(chunks) - 1:
            time.sleep(1)  # brief pause between batches

    if not frames:
        raise RuntimeError("All chunks returned empty data from yfinance")

    combined = pd.concat(frames, axis=1)
    combined = combined.loc[~combined.index.duplicated(keep="last")].sort_index()
    print(f"  Got {len(combined)} trading days × {combined.shape[1]} tickers")
    return combined


def compute_breadth(price_df: pd.DataFrame) -> list[dict]:
    """Vectorized rolling MA breadth + 52w new-highs/lows (Hindenburg-style) computation."""
    ma50  = price_df.rolling(50,  min_periods=50).mean()
    ma200 = price_df.rolling(200, min_periods=200).mean()

    valid50  = price_df.notna() & ma50.notna()
    valid200 = price_df.notna() & ma200.notna()

    above50  = (price_df > ma50).where(valid50,  False).sum(axis=1)
    above200 = (price_df > ma200).where(valid200, False).sum(axis=1)

    n50  = valid50.sum(axis=1)
    n200 = valid200.sum(axis=1)

    # 52-week new highs/lows: today strictly exceeds prior 252 days' max/min.
    # Used for Hindenburg-style breadth divergence (computed simplified on S&P500, not full NYSE).
    win52   = 252
    prev_hi = price_df.rolling(win52, min_periods=win52).max().shift(1)
    prev_lo = price_df.rolling(win52, min_periods=win52).min().shift(1)
    valid_hl = price_df.notna() & prev_hi.notna() & prev_lo.notna()
    new_hi  = (price_df > prev_hi).where(valid_hl, False).sum(axis=1)
    new_lo  = (price_df < prev_lo).where(valid_hl, False).sum(axis=1)
    n_hl    = valid_hl.sum(axis=1)

    rolling_high = price_df.rolling(win52, min_periods=win52).max()
    valid_bear   = price_df.notna() & rolling_high.notna()
    is_bear      = (price_df <= rolling_high * 0.80).where(valid_bear, False)
    bear_count   = is_bear.sum(axis=1)
    n_bear       = valid_bear.sum(axis=1)

    records: list[dict] = []
    dropped_lowcov = 0
    recent_cutoff  = (date.today() - timedelta(days=RECENT_WINDOW_DAYS)).isoformat()
    for dt in price_df.index:
        ds  = dt.strftime("%Y-%m-%d")
        v50 = int(n50[dt])
        if v50 == 0:
            continue
        if v50 < MIN_COVERAGE and ds >= recent_cutoff:
            dropped_lowcov += 1   # laggy tail day; skip so it doesn't spike % on a shrunk denominator
            continue
        a50  = int(above50[dt])
        v200 = int(n200[dt])
        a200 = int(above200[dt]) if v200 > 0 else None
        vhl  = int(n_hl[dt])
        nh   = int(new_hi[dt]) if vhl > 0 else None
        nl   = int(new_lo[dt]) if vhl > 0 else None
        vbear = int(n_bear[dt])
        bc    = int(bear_count[dt]) if vbear > 0 else None

        records.append({
            "date":           dt.strftime("%Y-%m-%d"),
            "above50_count":  a50,
            "above50_pct":    round(a50 / v50 * 100, 1),
            "above200_count": a200,
            "above200_pct":   round(a200 / v200 * 100, 1) if (v200 > 0 and a200 is not None) else None,
            "new_hi_count":   nh,
            "new_lo_count":   nl,
            "hl_total":       vhl if vhl > 0 else None,
            "bear_count": bc,
            "bear_pct": round(bc / vbear * 100, 1) if (vbear > 0 and bc is not None) else None,
            "bear_total": vbear if vbear > 0 else None,
            "total":          v50,
        })
    if dropped_lowcov:
        print(f"  Dropped {dropped_lowcov} recent low-coverage day(s) (<{MIN_COVERAGE} names)")
    return records


def merge(existing: list[dict], new_records: list[dict]) -> list[dict]:
    by_date = {r["date"]: r for r in existing}
    for r in new_records:
        by_date[r["date"]] = r
    return sorted(by_date.values(), key=lambda r: r["date"])


def main() -> None:
    existing = load_existing()
    today    = date.today()

    # ── Schema migration: missing new_hi_count → force full backfill ──
    if existing and ("new_hi_count" not in existing[0] or "bear_count" not in existing[0]):
        print("Existing data missing new_hi_count/bear_count field — full backfill to recompute schema")
        existing = []

    # ── Freshness check FIRST — skip Wikipedia + yfinance if not needed ──
    if existing:
        last_date  = existing[-1]["date"]
        days_stale = (today - date.fromisoformat(last_date)).days
        if days_stale <= FRESHNESS_DAYS:
            print(f"Data is fresh (last: {last_date}), skipping.")
            return

    tickers = get_tw50_tickers()
    print(f"TW50 constituent count: {len(tickers)}")

    if existing:
        last_date       = existing[-1]["date"]
        start           = (today - timedelta(days=INCREMENTAL_CAL)).isoformat()
        recompute_from  = (date.fromisoformat(last_date) - timedelta(days=30)).isoformat()
        print(f"Incremental update: download from {start}, recompute from {recompute_from}")
    else:
        start          = (today - timedelta(days=FULL_BACKFILL_CAL)).isoformat()
        recompute_from = None
        print(f"Full backfill: download from {start}")

    prices      = fetch_prices(tickers, start)
    all_records = compute_breadth(prices)

    new_records = (
        [r for r in all_records if r["date"] >= recompute_from]
        if recompute_from else all_records
    )

    merged = merge(existing, new_records)

    payload = {
        "updated": today.isoformat(),
        "data":    merged,
    }
    OUT_PATH.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    print(f"Wrote {len(merged)} rows → {OUT_PATH.name}")
    if merged:
        last = merged[-1]
        print(
            f"Latest ({last['date']}): "
            f"above50={last['above50_pct']}%  "
            f"above200={last.get('above200_pct')}%  "
            f"total={last['total']}"
        )


if __name__ == "__main__":
    main()
