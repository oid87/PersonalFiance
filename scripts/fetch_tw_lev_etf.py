#!/usr/bin/env python3
"""台股槓桿／反向 ETF 最新交易日行情 → data/tw_lev_etf.json（前端 #tab=twlevetf 熱力圖）

來源（免費、免 token）：TWSE OpenAPI exchangeReport/STOCK_DAY_ALL（上市全部證券最新一日收盤）。
台灣的槓桿／反向 ETF 目前都在上市（代號 00xxxL／00xxxR），上櫃沒有。
只取代號以 L（槓桿）或 R（反向）結尾的 ETF；倍數從名稱「正2／反1／反2」判斷。
漲跌% ＝ 漲跌價差 ÷（收盤 − 漲跌價差）。成交值為元。
另保留最近 HISTORY_DAYS 個交易日的 [代號, 漲跌%, 成交值] 供比較（idempotent：同日期新蓋舊）。
"""
from __future__ import annotations

import json
import re
from datetime import date
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "tw_lev_etf.json"
URL = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)"}
HISTORY_DAYS = 20
CODE_RE = re.compile(r"^00\d{3,4}[LR]$")
# 台股大盤類（台灣50／加權／台指）另成一組，其餘為海外指數／原物料等
TW_RE = re.compile(r"台灣|臺灣|台指|加權|摩台")


def num(s):
    try:
        v = float(str(s).replace(",", "").replace("+", ""))
    except (TypeError, ValueError):
        return None
    return v


def roc_to_iso(s: str) -> str:
    s = s.strip()
    return f"{int(s[:-4]) + 1911:04d}-{s[-4:-2]}-{s[-2:]}"


def leverage(code: str, name: str) -> int:
    m = re.search(r"(正|反)\s*([0-9１２])", name)
    if m:
        n = int(m.group(2).translate(str.maketrans("１２", "12")))
        return n if m.group(1) == "正" else -n
    return 2 if code.endswith("L") else -1


def main() -> None:
    r = requests.get(URL, headers=UA, timeout=60)
    r.raise_for_status()
    rows = r.json()
    items, day = [], None
    for x in rows:
        code = str(x.get("Code", "")).strip()
        if not CODE_RE.match(code):
            continue
        name = str(x.get("Name", "")).strip()
        close, chg, value = num(x.get("ClosingPrice")), num(x.get("Change")), num(x.get("TradeValue"))
        day = day or roc_to_iso(str(x.get("Date", "")))
        ret = None
        if close is not None and chg is not None and close - chg > 0:
            ret = round(chg / (close - chg) * 100, 2)
        items.append({
            "code": code, "name": name, "lev": leverage(code, name),
            "group": "tw" if TW_RE.search(name) else "intl",
            "close": close, "ret": ret, "value": int(value) if value is not None else None,
        })
    if len(items) < 10 or not day:
        raise SystemExit(f"槓桿／反向 ETF 只抓到 {len(items)} 檔，保留舊檔")

    old = {}
    if OUT.exists():
        try:
            old = json.loads(OUT.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            old = {}
    hist = {h["date"]: h for h in old.get("history", []) if isinstance(h, dict) and h.get("date")}
    hist[day] = {"date": day, "rows": [[i["code"], i["ret"], i["value"]] for i in items]}
    history = [hist[d] for d in sorted(hist)][-HISTORY_DAYS:]

    out = {
        "source": "TWSE OpenAPI exchangeReport/STOCK_DAY_ALL（上市最新一日收盤）",
        "note": "代號 L＝槓桿、R＝反向；lev 為倍數（反向為負）；ret＝漲跌價差÷前日參考價(%)；value＝成交值(元)",
        "updated": date.today().isoformat(),
        "date": day,
        "data": items,
        "history": history,
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"tw_lev_etf: {day} {len(items)} 檔")


if __name__ == "__main__":
    main()
