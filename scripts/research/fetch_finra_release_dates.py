#!/usr/bin/env python3
"""用 Wayback Machine 的 FINRA Margin Statistics 頁面快照，推估每個月度融資餘額「最早可被看到」的日期。

為什麼：repo 的 margin_global_us.json 只有月份（月初記號），沒有公布日；研究不得把月底數字當成月底已知。
方法：對每個快照解析頁面表格（Month/Year → Debit balances），某月 M 第一次出現的快照日 ＝ 公布日上界
（known_by），前一個『已成功解析且尚未出現 M』的快照日 ＝ 下界（not_yet）；真實公布日 ∈ (not_yet, known_by]。
結果存 data/research/us_delever/finra_release_dates.json；快照解析結果快取在同檔 captures 欄，可續跑。
  python3 scripts/research/fetch_finra_release_dates.py
"""
from __future__ import annotations

import gzip
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data" / "research" / "us_delever" / "finra_release_dates.json"
PAGES = [
    "finra.org/investors/learn-to-invest/advanced-investing/margin-statistics",
    "finra.org/rules-guidance/key-topics/margin-accounts/margin-statistics",
]
MONTHS = {m: i for i, m in enumerate("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(), 1)}
ROW = re.compile(r"\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2})\s+([\d,]{5,})\s+([\d,]{4,})\s+([\d,]{4,})")
KEEP_FROM = "2019-06"   # 只保留研究用得到的月份，縮小輸出檔
UA = {"User-Agent": "Mozilla/5.0 (research; PersonalFiance)"}


def get(url: str, tries: int = 4) -> bytes:
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    data = gzip.decompress(data)
                return data
        except Exception as exc:  # noqa: BLE001
            if k == tries - 1:
                raise
            time.sleep(3 * (k + 1))
    raise RuntimeError("unreachable")


def listing(page: str) -> list[str]:
    q = urllib.parse.urlencode({"url": page, "output": "json", "from": "2019", "filter": "statuscode:200",
                                "collapse": "timestamp:8", "fl": "timestamp"})
    rows = json.loads(get("https://web.archive.org/cdx/search/cdx?" + q))
    return [r[0] for r in rows[1:]]


def parse(html: str) -> dict[str, dict]:
    html = re.sub(r"<script.*?</script>|<style.*?</style>", " ", html, flags=re.S)
    text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html))
    out = {}
    for m in ROW.finditer(text):
        yy = int(m.group(2))
        month = f"{(1900 if yy >= 90 else 2000) + yy}-{MONTHS[m.group(1)]:02d}"
        out.setdefault(month, {"debit": int(m.group(3).replace(",", "")), "free_cash": int(m.group(4).replace(",", "")),
                               "free_margin": int(m.group(5).replace(",", ""))})
    return out


def main() -> None:
    cache = {}
    if OUT.exists():
        cache = {c["ts"]: c for c in json.loads(OUT.read_text()).get("captures", [])}
        for c in cache.values():   # 舊版把 Dec-99 解成 2099；改正快取並裁剪舊月份
            c["months"] = {(("1999" + k[4:]) if k.startswith("2099") else k): v for k, v in c["months"].items() if (("1999" + k[4:]) if k.startswith("2099") else k) >= KEEP_FROM}
    jobs = []
    for page in PAGES:
        for ts in listing(page):
            jobs.append((ts, page))
    jobs.sort()
    print(len(jobs), "captures;", len(cache), "cached", file=sys.stderr)
    for ts, page in jobs:
        if ts in cache:
            continue
        try:
            html = get(f"https://web.archive.org/web/{ts}id_/https://www.{page}").decode("utf-8", "ignore")
            cache[ts] = {"ts": ts, "page": page, "months": {m: v for m, v in parse(html).items() if m >= KEEP_FROM}}
        except Exception as exc:  # noqa: BLE001
            cache[ts] = {"ts": ts, "page": page, "months": {}, "error": str(exc)[:120]}
        print(ts, len(cache[ts]["months"]), cache[ts].get("error", ""), file=sys.stderr)
        time.sleep(0.8)
    caps = [cache[k] for k in sorted(cache)]
    good = [c for c in caps if c["months"]]
    months = sorted({m for c in good for m in c["months"]})
    release = {}
    for m in months:
        seen = [c for c in good if m in c["months"]]
        first = seen[0]
        absent = [c for c in good if c["ts"] < first["ts"] and m not in c["months"]]
        first_vals = first["months"][m]
        last_vals = seen[-1]["months"][m]
        release[m] = {
            "known_by": f"{first['ts'][:4]}-{first['ts'][4:6]}-{first['ts'][6:8]}",
            "not_yet": (f"{absent[-1]['ts'][:4]}-{absent[-1]['ts'][4:6]}-{absent[-1]['ts'][6:8]}" if absent else None),
            "debit_first_seen": first_vals["debit"], "debit_latest_capture": last_vals["debit"],
            "left_censored": first is good[0],   # 該月在最早的可用快照就已存在 → 只有上界、沒有下界
        }
    payload = {
        "method": "Wayback Machine snapshots of FINRA Margin Statistics page; release date ∈ (not_yet, known_by]",
        "fetched_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "capture_count": len(caps), "parsed_count": len(good),
        "release": release, "captures": caps,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    print("months", len(release))


if __name__ == "__main__":
    main()
