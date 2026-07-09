"""Fetch 台指期(TX)近月正逆價差(基差) — 台股情緒獨有訊號.

Source: FinMind TaiwanFuturesDaily, data_id=TX (2018-present, 免費).
現貨: 既有 data/TWII.json(不自己抓 yfinance；TWII.json 由 fetch_stocks.py 維護,
      CI 中該 step 在本腳本之前跑,足夠新)。

基差 = 近月期貨日盤收盤 - 加權指數現貨收盤。
  正值(正價差)= 期貨貴於現貨,通常反映多頭情緒/資金追價；
  負值(逆價差)= 期貨賤於現貨,通常反映空頭情緒/避險賣壓。

近月挑法: 當日 trading_session=="position"(日盤,非夜盤 after_market)、
close>0、contract_date 符合 "YYYYMM" 六位數字(排除跨月價差列如
"202607/202608")的列中,取 contract_date 最小者(字串比大小即等於時序)
的收盤價。

已知簡化: 用「最小 contract_date」當近月,結算日(每月第三個週三)當天
兩者會收斂到 ~0；本版不做「結算前幾日提前轉倉」處理,當環境情緒訊號
已足夠,不追求逐日精確轉倉點。

token: env FINMIND_TOKEN (CI secret) → repo/.finmind_token →
       repo.parent/Financial_work/.finmind_token → 匿名(低額度).

Output: data/taiwan_basis.json
  -> {source, updated, data:[{date, futures, spot, basis, basis_pct, contract}]}
"""
from __future__ import annotations

import json
import os
import re
from datetime import date, timedelta
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "taiwan_basis.json"
TWII = ROOT / "data" / "TWII.json"
API = "https://api.finmindtrade.com/api/v4/data"
START = "2018-01-01"
CONTRACT_RE = re.compile(r"^\d{6}$")

INCREMENTAL_WINDOW_DAYS = 90   # 涵蓋轉倉的重抓窗口
FULL_REFETCH_GAP_DAYS = 350    # 既有資料太舊(接近/超過免費單次 row 上限風險)才退回全量逐年 chunk


def get_token() -> str:
    tok = os.environ.get("FINMIND_TOKEN", "").strip()
    if tok:
        return tok
    for p in (ROOT / ".finmind_token", ROOT.parent / "Financial_work" / ".finmind_token"):
        if p.exists():
            return p.read_text().strip()
    return ""  # anonymous (low rate limit, may still work for a single daily call)


def load_existing() -> list[dict]:
    if not OUT.exists():
        return []
    try:
        return json.loads(OUT.read_text()).get("data", [])
    except Exception:
        return []


def load_spot() -> dict[str, float]:
    """讀既有 TWII.json 現貨收盤 -> {date: close}。不自己抓 yfinance。"""
    if not TWII.exists():
        return {}
    try:
        rows = json.loads(TWII.read_text()).get("data", [])
    except Exception:
        return {}
    return {r["date"]: r["close"] for r in rows if r.get("close") is not None}


def fetch_chunk(start: str, end: str, token: str) -> list[dict]:
    params = {"dataset": "TaiwanFuturesDaily", "data_id": "TX", "start_date": start, "end_date": end}
    if token:
        params["token"] = token
    r = requests.get(API, params=params, timeout=60)
    r.raise_for_status()
    payload = r.json()
    if payload.get("status") != 200:
        raise RuntimeError(f"FinMind status={payload.get('status')} msg={payload.get('msg')}")
    return payload.get("data", [])


def fetch_full(token: str, end_date: str) -> list[dict]:
    """逐年 chunk 抓 START..end_date,避免免費單次 row 上限。"""
    rows: list[dict] = []
    start_year = int(START[:4])
    end_year = int(end_date[:4])
    for year in range(start_year, end_year + 1):
        y_start = f"{year}-01-01" if year > start_year else START
        y_end = f"{year}-12-31" if year < end_year else end_date
        chunk = fetch_chunk(y_start, y_end, token)
        print(f"  chunk {y_start}..{y_end}: {len(chunk)} rows")
        rows += chunk
    return rows


def extract_near_month(rows: list[dict]) -> dict[str, tuple[str, float]]:
    """{date: (contract_date, close)} — 當日近月(最小 contract_date)日盤收盤."""
    by_date: dict[str, list[tuple[str, float]]] = {}
    for row in rows:
        if row.get("trading_session") != "position":
            continue
        close = row.get("close")
        if not close or close <= 0:
            continue
        cd = row.get("contract_date", "")
        if not CONTRACT_RE.match(cd):
            continue
        by_date.setdefault(row["date"], []).append((cd, close))
    return {d: min(pairs, key=lambda p: p[0]) for d, pairs in by_date.items()}


def main() -> None:
    token = get_token()
    print(f"FinMind token: {'env/file' if token else 'ANONYMOUS'}")
    existing = load_existing()
    by_date = {r["date"]: r for r in existing}
    print(f"Loaded {len(existing)} existing rows")

    today = date.today()

    do_full = not existing
    if existing:
        last_date = existing[-1]["date"]
        gap_days = (today - date.fromisoformat(last_date)).days
        if gap_days > FULL_REFETCH_GAP_DAYS:
            do_full = True
            print(f"Existing data stale by {gap_days}d (> {FULL_REFETCH_GAP_DAYS}d) — full re-chunk")

    try:
        if do_full:
            raw = fetch_full(token, today.isoformat())
        else:
            window_days = max(INCREMENTAL_WINDOW_DAYS, gap_days + 10)
            start = (today - timedelta(days=window_days)).isoformat()
            raw = fetch_chunk(start, today.isoformat(), token)
            print(f"  incremental {start}..{today.isoformat()}: {len(raw)} rows")
    except Exception as exc:
        if existing:
            print(f"Fetch failed ({exc}); keeping existing file")
            return
        raise

    near_month = extract_near_month(raw)
    spot = load_spot()
    print(f"  near-month days: {len(near_month)}; spot days available: {len(spot)}")

    updated_n = 0
    for d, (contract, fut_close) in near_month.items():
        sp = spot.get(d)
        if sp is None:
            continue
        basis = round(fut_close - sp, 1)
        basis_pct = round(basis / sp * 100, 3)
        by_date[d] = {
            "date": d,
            "futures": fut_close,
            "spot": sp,
            "basis": basis,
            "basis_pct": basis_pct,
            "contract": contract,
        }
        updated_n += 1

    if not by_date:
        raise SystemExit("No basis data and no existing file")

    data = sorted(by_date.values(), key=lambda r: r["date"])
    OUT.write_text(json.dumps({
        "source": "FinMind TaiwanFuturesDaily(TX 日盤近月) − TWII 現貨",
        "note": "basis=近月期貨日盤收盤-加權指數現貨收盤;正=正價差(多頭情緒),負=逆價差(空頭情緒)."
                "近月=當日最小 contract_date；結算日當天會收斂至~0(未做提前轉倉處理).",
        "updated": today.isoformat(),
        "data": data,
    }, ensure_ascii=False) + "\n")
    print(f"Updated {updated_n} rows -> wrote {len(data)} rows -> {OUT.name} ({data[0]['date']}..{data[-1]['date']})")


if __name__ == "__main__":
    main()
