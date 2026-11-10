#!/usr/bin/env python3
"""Yahoo股市 RSS 新聞標題 → data/news.json，供首頁跑馬燈。

來源：https://tw.stock.yahoo.com/rss?category=tw-market（台股）、category=intl-markets（國際）。
Yahoo 服務條款 RSS Feeds 條款：只能原樣顯示 feed 內容、須標示來源並連回原文、不得夾帶廣告。
所以這裡只存標題原文、原文連結、發布時間，不存內文；前端顯示「來源：Yahoo股市」並連到原文。
每類最多 MAX_ITEMS 則；整份覆寫（新聞不累積歷史）。任一類抓不到就保留該類舊資料。
"""
from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "news.json"
FEEDS = {"tw": "https://tw.stock.yahoo.com/rss?category=tw-market",
         "intl": "https://tw.stock.yahoo.com/rss?category=intl-markets"}
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)"}
MAX_ITEMS = 15


def fetch(url: str) -> list[dict]:
    r = requests.get(url, headers=UA, timeout=30)
    r.raise_for_status()
    items = []
    for it in ET.fromstring(r.content).iter("item"):
        title, link, pub = ((it.findtext(k) or "").strip() for k in ("title", "link", "pubDate"))
        if not title or not link.startswith("https://"):
            continue
        try:
            t = parsedate_to_datetime(pub).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        except (TypeError, ValueError):
            t = None
        items.append({"title": title, "link": link, "time": t})
        if len(items) >= MAX_ITEMS:
            break
    return items


def main() -> None:
    old = {}
    if OUT.exists():
        try:
            old = json.loads(OUT.read_text(encoding="utf-8")).get("feeds", {})
        except json.JSONDecodeError:
            old = {}
    feeds, errors = {}, []
    for key, url in FEEDS.items():
        try:
            feeds[key] = fetch(url)
            if not feeds[key]:
                raise ValueError("空的")
        except Exception as e:  # noqa: BLE001 — 單一 feed 失敗保留舊資料
            errors.append(f"{key}: {type(e).__name__}")
            feeds[key] = old.get(key, [])
    if not any(feeds.values()):
        raise SystemExit("新聞 RSS 全部抓不到，保留舊檔")
    out = {"source": "Yahoo股市 RSS", "source_url": "https://tw.stock.yahoo.com/",
           "note": "依 Yahoo RSS 條款：標題原樣顯示、標示來源並連回原文、不夾廣告",
           "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "errors": errors, "feeds": feeds}
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"news: tw {len(feeds['tw'])}・intl {len(feeds['intl'])}" + (f"・錯誤 {errors}" if errors else ""))


if __name__ == "__main__":
    main()
