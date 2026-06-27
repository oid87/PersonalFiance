"""Fetch USD/TWD spot → data/usdtwd.json

yfinance `TWD=X` (= USD per 1 TWD quote convention is actually USD/TWD, i.e. how
many TWD per 1 USD), daily back to 2004. Used by compute_taiwan_stress.py for the
FX-volatility leg of the Taiwan financial-stress index.

⚠ yfinance FX series carry occasional garbage ticks (e.g. a stray 1.8 when the real
rate is ~31). USD/TWD has lived in a narrow ~28–35 band for two decades, so we hard-
filter to a sane SANE_LO..SANE_HI window — anything outside is a bad tick, dropped.

Output (idempotent merge by date):
  {symbol, source, updated, data: [{date, close}]}   # close = TWD per USD
"""
from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)
OUT = DATA_DIR / "usdtwd.json"

SYMBOL = "TWD=X"
SANE_LO, SANE_HI = 20.0, 45.0   # USD/TWD realistic band; drop ticks outside it
START = "2004-01-01"


def load_existing() -> dict:
    if not OUT.exists():
        return {}
    try:
        payload = json.loads(OUT.read_text())
        return {r["date"]: r["close"] for r in payload.get("data", []) if r.get("date")}
    except Exception:
        return {}


def main() -> None:
    existing = load_existing()

    df = yf.download(SYMBOL, start=START, progress=False, auto_adjust=False)
    if df is None or df.empty:
        if existing:
            print(f"  [USD/TWD] download empty; keeping {len(existing)} existing rows")
            return
        raise RuntimeError("USD/TWD download returned no data")

    close = df["Close"]
    if hasattr(close, "columns"):   # yfinance multiindex when single ticker
        close = close.iloc[:, 0]

    merged = dict(existing)
    dropped = 0
    for ts, v in close.dropna().items():
        px = float(v)
        if not (SANE_LO <= px <= SANE_HI):   # bad tick guard
            dropped += 1
            continue
        merged[ts.date().isoformat()] = round(px, 4)

    data = [{"date": d, "close": merged[d]} for d in sorted(merged)]
    last = data[-1]
    print(f"  [USD/TWD] {len(data)} days · latest {last['date']} = {last['close']} "
          f"(dropped {dropped} out-of-band ticks)")

    payload = {
        "symbol": "USDTWD",
        "source": "Yahoo Finance TWD=X (USD/TWD spot, TWD per USD). Bad ticks outside 20–45 dropped.",
        "updated": date.today().isoformat(),
        "data": data,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    print(f"Wrote {OUT.name}: {len(data)} daily rows")


if __name__ == "__main__":
    main()
