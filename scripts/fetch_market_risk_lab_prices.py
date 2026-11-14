"""市場預警與策略回測頁的額外行情：QLD／SSO／USD（交易標的）、RSP（等權代理）、
^NDX（Nasdaq 100 指數）、NQ=F（Nasdaq 期貨連續合約）。

輸出 data/market_risk_lab_prices.json（欄位式，避免逐列物件把檔案撐大）：
  {"updated", "source", "tickers": {SYM: {"date":[], "open":[], "high":[], "low":[],
   "close":[], "adj_close":[], "first": "YYYY-MM-DD"}}}

- 原始價格 auto_adjust=False；adj_close 是 yfinance 的除權息調整收盤，只給 NAV 回測換算含息報酬。
- NQ=F 是 Yahoo 的「近月連續」合約，未做換月調整；每日 high/low 是 Globex 全時段
  （含夜盤）的區間。換月跳空會讓長均線有偏差，頁面要標示。
- 任一檔下載失敗或列數縮水超過 5% → 保留舊檔該檔的資料，不以空值覆蓋。
"""
from __future__ import annotations

import json
import math
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "market_risk_lab_prices.json"

TICKERS = {
    "QLD": "1999-01-01",
    "SSO": "1999-01-01",
    "USD": "1999-01-01",
    "RSP": "2003-01-01",
    "^NDX": "1999-01-01",
    "NQ=F": "1999-01-01",
}


def _r(x, nd=4):
    if x is None:
        return None
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f):
        return None
    return round(f, nd)


def download(sym: str, start: str) -> dict | None:
    import yfinance as yf

    df = yf.Ticker(sym).history(start=start, auto_adjust=False, actions=False)
    if df is None or df.empty:
        return None
    df = df.dropna(subset=["Close"])
    out = {k: [] for k in ("date", "open", "high", "low", "close", "adj_close")}
    for ts, row in df.iterrows():
        c = _r(row["Close"])
        if c is None or c <= 0:
            continue
        out["date"].append(ts.strftime("%Y-%m-%d"))
        out["open"].append(_r(row["Open"]))
        out["high"].append(_r(row["High"]))
        out["low"].append(_r(row["Low"]))
        out["close"].append(c)
        out["adj_close"].append(_r(row.get("Adj Close", c)))
    if not out["date"]:
        return None
    # 同日重複（期貨偶發）只留最後一筆
    seen = {}
    for i, d in enumerate(out["date"]):
        seen[d] = i
    keep = sorted(seen.values())
    out = {k: [v[i] for i in keep] for k, v in out.items()}
    out["first"] = out["date"][0]
    return out


def main() -> int:
    old = {}
    if OUT.exists():
        try:
            old = json.loads(OUT.read_text()).get("tickers", {})
        except Exception:
            old = {}
    tickers, failed = {}, []
    for sym, start in TICKERS.items():
        block = None
        try:
            block = download(sym, start)
        except Exception as e:  # noqa: BLE001
            print(f"[{sym}] download error: {type(e).__name__}: {e}")
        prev = old.get(sym)
        if block is None or (prev and len(block["date"]) < 0.95 * len(prev["date"])):
            failed.append(sym)
            if prev:
                tickers[sym] = prev
                print(f"[{sym}] 保留舊資料 {prev['date'][-1]}")
            continue
        tickers[sym] = block
        print(f"[{sym}] {block['first']} → {block['date'][-1]} ({len(block['date'])} rows)")
    if not tickers:
        print("全部下載失敗，不寫檔")
        return 1
    payload = {
        "updated": date.today().isoformat(),
        "source": "Yahoo Finance（yfinance, auto_adjust=False；adj_close 為除權息調整收盤）",
        "note": "NQ=F 為未換月調整的近月連續合約，high/low 含夜盤。",
        "failed": failed,
        "tickers": tickers,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    return 0 if not failed else 0


if __name__ == "__main__":
    sys.exit(main())
