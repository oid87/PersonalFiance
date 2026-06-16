"""Backfill a deep *realized* forward-PE history for 0050 into data/TW_valuation.json.

Historical analyst forward estimates aren't freely archived, so we reconstruct a
"realized / hindsight forward PE" from REAL data:

    forward_PE(t) = price(t) / actual-EPS(t → t+12m)

Using the identity actual-EPS(t→t+12m) ≈ TTM-EPS(t+12m) = price(t+12m) / trailingPE(t+12m):

    realized_fwd(t) = trailingPE(t+12m) * price(t) / price(t+12m)

trailingPE is the real FinMind-weighted 0050 trailing series already in TW_valuation
(monthly, src=finmind, deep to 2010); price is 0050.TW month-end close.

⚠️ This uses earnings that were unknown at time t (look-ahead) — it is a backward-
looking valuation lens for charting, NOT a real-time signal. Stored as fpe with
src="realized-fwd". The most-recent ~12 months (no future data) keep the live
analyst-based forward from fetch_tw_valuation.py (src=calc/calc-live).
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TW = ROOT / "data" / "TW_valuation.json"
PX = ROOT / "data" / "0050.TW.json"


def month_end_price() -> dict[str, float]:
    rows = json.loads(PX.read_text())["data"]
    pm: dict[str, tuple[str, float]] = {}
    for r in rows:
        ym = r["date"][:7]
        if ym not in pm or r["date"] > pm[ym][0]:
            pm[ym] = (r["date"], r["close"])
    return {ym: v for ym, (_, v) in pm.items()}


def plus12(ym: str) -> str:
    y, m = map(int, ym.split("-"))
    return f"{y + 1}-{m:02d}"


def main() -> None:
    d = json.loads(TW.read_text())
    data = d["data"]
    tpe = {r["date"][:7]: r["tpe"] for r in data if r.get("tpe") is not None}
    price = month_end_price()

    added = 0
    for r in data:
        ym = r["date"][:7]
        # only fill historical realized forward where we DON'T already have a live forward
        if r.get("src") in ("calc", "calc-live", "yf-trailing"):
            continue
        f = plus12(ym)
        if f in tpe and ym in price and f in price and price[f]:
            r["fpe"] = round(tpe[f] * price[ym] / price[f], 2)
            added += 1

    d["data"] = sorted(data, key=lambda r: r["date"])
    d["note"] = (
        "台灣 50（0050）估值。tpe=trailing（FinMind 成分股 PER 加權，深至 2010 + TWSE 每日實值）；"
        "fpe=forward：歷史為『實際 forward（後見）』＝股價÷未來4季實際EPS（real-data 回推，含 look-ahead），"
        "近期為成分股 yfinance forwardPE 加權實值。台股無公開歷史分析師預估，故 forward 歷史以實際盈餘回推。"
    )
    TW.write_text(json.dumps(d, ensure_ascii=False, indent=2) + "\n")
    fcount = sum(1 for r in d["data"] if r.get("fpe") is not None)
    print(f"Added realized forward to {added} months. Total fpe points: {fcount} / {len(d['data'])}")
    fwd_rows = [r for r in d["data"] if r.get("fpe") is not None]
    print(f"forward range: {fwd_rows[0]['date']} → {fwd_rows[-1]['date']}")


if __name__ == "__main__":
    main()
