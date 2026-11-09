"""臺指選擇權波動率指數（台指 VIX）每日收盤：期交所「前3個月每日收盤」頁列出的月檔（含當月），逐月下載後依日期合併。
期交所免費只提供近 4 個月，更早的歷史要向期交所購買 → 本檔從 2026-08 起逐日累積。
輸出 data/twvix.json：[{date, close, close_1m}]；close_1m＝收盤前 1 分鐘平均。
"""
from __future__ import annotations
import json
import re
from datetime import date
from pathlib import Path

import requests

import _common

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "twvix.json"
PAGE = "https://www.taifex.com.tw/cht/7/vixDaily3MNew"
HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"}


def parse(text: str) -> list[dict]:
    rows = []
    for line in text.splitlines():
        p = line.split()
        if len(p) >= 3 and re.fullmatch(r"\d{8}", p[0]):
            d = f"{p[0][:4]}-{p[0][4:6]}-{p[0][6:]}"
            try:
                rows.append({"date": d, "close": float(p[2]), "close_1m": float(p[3]) if len(p) > 3 else None})
            except ValueError:
                continue
    return rows


def main() -> None:
    html = requests.get(PAGE, headers=HEADERS, timeout=30).text
    urls = sorted(set(re.findall(r"https://www\.taifex\.com\.tw/file/taifex/Dailydownload/vix/log2data/\d{6}new\.txt", html)))
    if not urls:
        raise SystemExit("twvix: no monthly files listed; keep existing file")
    new = []
    for u in urls:
        r = requests.get(u, headers=HEADERS, timeout=30)
        r.raise_for_status()
        new += parse(r.content.decode("big5", errors="replace"))
    if not new:
        raise SystemExit("twvix: no rows parsed; keep existing file")
    merged = _common.idempotent_merge(OUT, new)
    OUT.write_text(json.dumps({
        "source": "TAIFEX 臺指選擇權波動率指數 前3個月每日收盤 (vixDaily3MNew)",
        "note": "期交所免費只提供近 4 個月，本檔自 2026-08 起逐日累積；更早歷史需向期交所購買",
        "updated": date.today().isoformat(), "data": merged,
    }, ensure_ascii=False, separators=(",", ":")))
    print(f"twvix: {len(merged)} rows {merged[0]['date']}..{merged[-1]['date']}")


if __name__ == "__main__":
    main()
