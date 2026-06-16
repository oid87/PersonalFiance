"""One-off backfill: build a REAL deep trailing-PE history for 0050 from FinMind.

0050 (ETF) has no PER in FinMind, but its constituents do — daily back to ~2010.
We weight the top-N holdings' real per-stock PER (TaiwanStockPER) by 0050 weight,
renormalising to whatever has data each month, to approximate the index trailing PE.

Output: month-end real series → data/TW_valuation.json (src="finmind"), keeping any
recent daily calc/calc-live entries from the daily fetch_tw_valuation.py.

Note: this is trailing PE only. Taiwan index forward PE has no free source.
"""
from __future__ import annotations

import json
import time
from collections import defaultdict
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "TW_valuation.json"
TOKEN_FILE = ROOT.parent / "Financial_work" / ".finmind_token"
TOKEN_FILE_LOCAL = ROOT / ".finmind_token"

API = "https://api.finmindtrade.com/api/v4/data"
PE_CAP = 60.0
START = "2005-01-01"   # FinMind 個股 PER 最早約 2005-09（涵蓋 2008 金融海嘯）

# Top-15 0050 holdings (approx weights, 元大投信). TSMC dominates (~60%).
HOLDINGS: dict[str, float] = {
    "2330": 60.0, "2454": 5.2, "2308": 4.2, "2317": 3.4, "3711": 1.8,
    "2382": 1.5, "2881": 1.4, "2891": 1.3, "2882": 1.2, "1301": 1.1,
    "2886": 1.0, "2412": 1.0, "1303": 0.9, "3008": 0.9, "2379": 0.8,
}


def read_token() -> str:
    for f in (TOKEN_FILE, TOKEN_FILE_LOCAL):
        if f.exists():
            return f.read_text().strip()
    return ""


def fetch_per(sid: str, token: str) -> dict[str, float]:
    """Return {date: PER} for one stock from FinMind."""
    try:
        r = requests.get(API, params={
            "dataset": "TaiwanStockPER", "data_id": sid,
            "start_date": START, "token": token,
        }, timeout=60)
        rows = r.json().get("data", [])
        out = {}
        for row in rows:
            pe = row.get("PER")
            if isinstance(pe, (int, float)) and 0 < pe <= PE_CAP:
                out[row["date"]] = float(pe)
        print(f"  [{sid}] {len(out)} daily PER rows")
        return out
    except Exception as e:
        print(f"  [{sid}] ERR {e}")
        return {}


def month_end_map(daily: dict[str, float]) -> dict[str, float]:
    """Collapse daily {date:pe} → {YYYY-MM: last-trading-day pe}."""
    by_month: dict[str, tuple[str, float]] = {}
    for d, v in daily.items():
        ym = d[:7]
        if ym not in by_month or d > by_month[ym][0]:
            by_month[ym] = (d, v)
    return {ym: v for ym, (_, v) in by_month.items()}


def main() -> None:
    token = read_token()
    if not token:
        print("No FinMind token found — aborting.")
        return
    print(f"Backfilling 0050 trailing PE from FinMind (token len {len(token)}) ...")

    # fetch per-stock monthly PER
    monthly: dict[str, dict[str, float]] = {}   # sid -> {ym: pe}
    for sid in HOLDINGS:
        monthly[sid] = month_end_map(fetch_per(sid, token))
        time.sleep(0.3)

    # weighted mean per month, renormalising to available constituents
    all_months = sorted({ym for m in monthly.values() for ym in m})
    series = []
    for ym in all_months:
        num = den = 0.0
        for sid, w in HOLDINGS.items():
            pe = monthly[sid].get(ym)
            if pe is not None:
                num += pe * w
                den += w
        if den >= 30:   # require decent coverage (TSMC alone is 60)
            series.append({"date": ym + "-01", "tpe": round(num / den, 2), "src": "finmind"})

    if not series:
        print("  No weighted series produced — aborting.")
        return
    print(f"  Built {len(series)} monthly points: {series[0]['date']} → {series[-1]['date']}")

    # merge: FinMind history + keep any recent non-seed daily calc entries
    existing = json.loads(OUT.read_text()).get("data", []) if OUT.exists() else []
    keep = [r for r in existing if r.get("src") in ("calc", "calc-live", "yf-trailing")]
    by_date = {r["date"]: r for r in series}
    for r in keep:
        by_date[r["date"]] = r   # daily real entries win over month seed
    merged = sorted(by_date.values(), key=lambda r: r["date"])

    note = (
        "台灣 50（0050）本益比 — trailing。歷史由成分股真實 PER 加權回溯（FinMind TaiwanStockPER，"
        "前15大持股、依 0050 權重，台積電約佔 60%），月頻深至 2010；近期為 TWSE 每日加權實值。"
        "註：為 trailing 本益比；台股指數無免費 forward PE 來源。"
    )
    OUT.write_text(json.dumps({"updated": series[-1]["date"], "note": note, "data": merged},
                              ensure_ascii=False, indent=2) + "\n")
    print(f"  Wrote {len(merged)} entries -> {OUT.name}")


if __name__ == "__main__":
    main()
