"""Fetch total-return series for the leverage-decay simulator → data/leverage.json.

Unlike fetch_stocks.py (auto_adjust=False, price-only — correct for the trend
charts), the leverage simulator needs DIVIDEND-REINVESTED total return so the
"無槓桿對照組" is honest over multi-decade windows. So this script fetches with
auto_adjust=True and writes a self-contained bundle the front-end engine drives:

  {
    "updated": "YYYY-MM-DD",
    "underlyings": { KEY: {"name","priceOnly?","data":[[date,close],...]} },
    "etfs": [ {"id","zh","leverage","underlying","expense","financing",
               "inception","region","real":[[date,close],...]} ]
  }

The front-end builds the leveraged equity curve by chaining DAILY returns:
  • date <  inception → synthetic:  K * underlyingRet − dailyDrag
                        (dailyDrag = (expense + (K-1)*financing) / 252)
  • date >= inception → real ETF's own daily return (captures true expense /
                        tracking / borrowing cost embedded in the fund price)
Chaining returns makes the synthetic→real splice continuous automatically.
"""
from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)
OUT = DATA_DIR / "leverage.json"

# ── Underlyings (1x total-return reference + synthetic basis) ──────────────
# key -> (yfinance ticker, display name, start, price_only)
UNDERLYINGS: dict[str, tuple[str, str, str, bool]] = {
    "QQQ":  ("QQQ",     "Nasdaq 100（QQQ 含息）",   "1999-03-10", False),
    "SOXX": ("SOXX",    "費城半導體（SOXX 含息）",   "2001-07-10", False),
    "SPY":  ("SPY",     "S&P 500（SPY 含息）",       "1993-01-29", False),
    "0050": ("0050.TW", "台灣 50 報酬（0050 含息）", "2003-06-30", False),
    # 加權「價格」指數（無股息）；深至 1997，給 00675L 的 2000 網路泡沫回測用。
    "TWII": ("^TWII",   "台灣加權指數（價格）",      "1997-07-02", True),
}

# ── Leveraged ETFs (real series, post-inception drives the curve) ──────────
# expense = 年化總費用率；financing = 假設融資成本（合成段才用，(K-1)×financing）。
ETFS: list[dict] = [
    {"id": "TQQQ",  "yf": "TQQQ",     "zh": "ProShares 納指3倍做多",
     "leverage": 3, "underlying": "QQQ",  "expense": 0.0084, "financing": 0.030,
     "inception": "2010-02-11", "region": "US"},
    {"id": "SOXL",  "yf": "SOXL",     "zh": "Direxion 半導體3倍做多",
     "leverage": 3, "underlying": "SOXX", "expense": 0.0075, "financing": 0.030,
     "inception": "2010-03-11", "region": "US"},
    {"id": "UPRO",  "yf": "UPRO",     "zh": "ProShares 標普500 3倍做多",
     "leverage": 3, "underlying": "SPY",  "expense": 0.0091, "financing": 0.030,
     "inception": "2009-06-25", "region": "US"},
    {"id": "00631L", "yf": "00631L.TW", "zh": "元大台灣50 正2",
     "leverage": 2, "underlying": "0050", "expense": 0.0112, "financing": 0.015,
     "inception": "2014-10-31", "region": "TW"},
    {"id": "00675L", "yf": "00675L.TW", "zh": "富邦台灣加權 正2",
     "leverage": 2, "underlying": "TWII", "expense": 0.0108, "financing": 0.015,
     "inception": "2014-12-04", "region": "TW"},
]


# yfinance's 0050.TW total-return feed still carries the 2014-01-02 split
# artifact (pre ~37.4 → post ~9.33, a phantom −75% that auto_adjust does NOT
# fix because the vendor never tagged it as a split). A 2x fund × −75% day
# blows past zero, so we ratio-splice the earlier segment DOWN onto the later
# basis — same approach as fetch_stocks.py. ticker -> [boundary dates].
SPLICE_FIXES: dict[str, list[str]] = {"0050.TW": ["2014-01-02"]}
SPLICE_TRIGGER = 0.40  # adjacent close-to-close gap beyond this = artificial stitch


def apply_splice(ticker: str, rows: list[list]) -> list[list]:
    for boundary in SPLICE_FIXES.get(ticker, []):
        pre = [r for r in rows if r[0] < boundary]
        post = [r for r in rows if r[0] >= boundary]
        if not pre or not post:
            continue
        last_pre, first_post = pre[-1][1], post[0][1]
        if last_pre <= 0 or first_post <= 0:
            continue
        if abs(first_post / last_pre - 1.0) < SPLICE_TRIGGER:
            continue  # already continuous
        factor = first_post / last_pre
        for r in pre:
            r[1] = round(r[1] * factor, 4)
        print(f"    [{ticker}] spliced {len(pre)} rows before {boundary} (x{factor:.5f})")
    return rows


def fetch_close(ticker: str, start: str) -> list[list]:
    """Return [[date, adj_close], ...] total-return series (auto_adjust=True)."""
    df = yf.download(
        ticker,
        start=start,
        end=(date.today() + timedelta(days=1)).isoformat(),
        auto_adjust=True,
        progress=False,
        threads=False,
    )
    if df is None or df.empty:
        return []
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    df = df.rename(columns=str.lower).reset_index()
    out: list[list] = []
    for _, r in df.iterrows():
        c = r["close"]
        if pd.isna(c):
            continue
        out.append([r["Date"].strftime("%Y-%m-%d"), round(float(c), 4)])
    return apply_splice(ticker, out)


def main() -> None:
    bundle: dict = {"updated": date.today().isoformat(), "underlyings": {}, "etfs": []}

    for key, (ticker, name, start, price_only) in UNDERLYINGS.items():
        rows = fetch_close(ticker, start)
        print(f"  underlying {key:6} [{ticker}] {len(rows)} rows "
              f"{rows[0][0] if rows else '—'} → {rows[-1][0] if rows else '—'}")
        entry: dict = {"name": name, "data": rows}
        if price_only:
            entry["priceOnly"] = True
        bundle["underlyings"][key] = entry

    for e in ETFS:
        rows = fetch_close(e["yf"], e["inception"])
        print(f"  etf        {e['id']:6} [{e['yf']}] {len(rows)} rows "
              f"{rows[0][0] if rows else '—'} → {rows[-1][0] if rows else '—'}")
        bundle["etfs"].append({
            "id": e["id"], "zh": e["zh"], "leverage": e["leverage"],
            "underlying": e["underlying"], "expense": e["expense"],
            "financing": e["financing"], "inception": e["inception"],
            "region": e["region"], "real": rows,
        })

    OUT.write_text(json.dumps(bundle, ensure_ascii=False) + "\n")
    size_kb = OUT.stat().st_size / 1024
    print(f"wrote {OUT.name} ({size_kb:.0f} KB) — "
          f"{len(bundle['underlyings'])} underlyings, {len(bundle['etfs'])} etfs")


if __name__ == "__main__":
    main()
