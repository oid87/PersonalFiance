"""每月抓 TWSE『集中市場月訊』PDF, 解析上市公司總市值, append 進 taiwan_mktcap_anchors.json.

PDF URL pattern: https://www.twse.com.tw/rwd/staticFiles/product/publication/000500{ID}.pdf
  Jan-26 = 0005000107, Feb-26 = 108, Mar-26 = 109, Apr-26 = 110, ... (月增 1)
  也許某月 TWSE 跳號或不出版 → 連續 N 次 404 才停止 probe.

PDF 解析: 第 2 頁有 "X 月底上市公司總市值 XXX.XX 兆元". 第 1 頁有 "YYYY 年 X 月底...".
取年+月 → 月底錨點. 寫進 anchors JSON (按 date 排序; 已存在則 skip).

每月 GitHub Actions 跑一次 (cron `0 10 10 * *`). 失敗安全: 任一例外都保留現檔, 不損壞.
"""
from __future__ import annotations

import calendar
import io
import json
import re
import sys
from datetime import date
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
ANCHORS_FILE = ROOT / "data" / "taiwan_mktcap_anchors.json"

PDF_URL_TEMPLATE = "https://www.twse.com.tw/rwd/staticFiles/product/publication/000500{id:04d}.pdf"
MAX_CONSECUTIVE_MISSES = 3   # 連續 N 個 404 才停 probe (應付偶爾跳號)
MAX_PROBE_AHEAD = 12          # 上限: 最多往前推 12 個月

MKTCAP_RE = re.compile(r"(\d{1,3}(?:\.\d+)?)\s*兆元")
MONTH_PROSE_RE = re.compile(r"(\d{1,2})\s*月底上市公司總市值\s*(\d{1,3}\.\d+)\s*兆元")
YEAR_MONTH_PROSE_RE = re.compile(r"(\d{4})\s*年\s*(\d{1,2})\s*月底")


def load_anchors() -> dict:
    return json.loads(ANCHORS_FILE.read_text())


def save_anchors(doc: dict) -> None:
    ANCHORS_FILE.write_text(
        json.dumps(doc, ensure_ascii=False, indent=2) + "\n"
    )


def fetch_pdf(pdf_id: int) -> bytes | None:
    """Return PDF bytes or None if not found / error."""
    url = PDF_URL_TEMPLATE.format(id=pdf_id)
    try:
        r = requests.get(url, timeout=20, allow_redirects=True)
    except requests.RequestException as exc:
        print(f"  net error id={pdf_id}: {exc}")
        return None
    if r.status_code != 200 or not r.content.startswith(b"%PDF"):
        return None
    return r.content


def parse_pdf(content: bytes, pdf_id: int) -> tuple[str, float] | None:
    """Return (anchor_date_iso, mktcap_billion) or None on parse failure.

    anchor_date = 該月最後一個日曆日 (YYYY-MM-DD).
    mktcap_billion = 上市公司總市值轉成億元 (兆 × 10000).
    """
    try:
        import pdfplumber
    except ImportError:
        print("  pdfplumber not installed; skip PDF parsing")
        return None
    try:
        with pdfplumber.open(io.BytesIO(content)) as pdf:
            pages = [p.extract_text() or "" for p in pdf.pages[:3]]
    except Exception as exc:
        print(f"  pdf open failed id={pdf_id}: {exc}")
        return None

    text = "\n".join(pages)

    # 抓月份 + 兆元值 (page2 prose "X 月底上市公司總市值 NNN.NN 兆元")
    m = MONTH_PROSE_RE.search(text)
    if not m:
        print(f"  id={pdf_id}: no '月底上市公司總市值 X.XX 兆元' line found")
        return None
    month = int(m.group(1))
    mktcap_t = float(m.group(2))  # 兆元

    # 抓年份 (page1: "2026 年 4 月底...")
    ym = YEAR_MONTH_PROSE_RE.search(text)
    if not ym:
        print(f"  id={pdf_id}: 無法擷取年份")
        return None
    year = int(ym.group(1))
    # sanity check: 月份應該對得起來
    if int(ym.group(2)) != month:
        print(f"  id={pdf_id}: 月份不一致 ({ym.group(2)} vs {month}), skip")
        return None

    last_day = calendar.monthrange(year, month)[1]
    anchor_date = date(year, month, last_day).isoformat()
    mktcap_billion = round(mktcap_t * 10000, 0)  # 兆 → 億
    return anchor_date, mktcap_billion


def main() -> int:
    if not ANCHORS_FILE.exists():
        raise SystemExit(f"missing {ANCHORS_FILE}")

    doc = load_anchors()
    anchors = doc.setdefault("anchors", [])
    existing_dates = {a["date"] for a in anchors}
    last_id = int(doc.get("last_pdf_id", 107))
    print(f"current last_pdf_id={last_id}, {len(anchors)} anchors")

    misses = 0
    pid = last_id
    added: list[dict] = []
    while misses < MAX_CONSECUTIVE_MISSES and (pid - last_id) < MAX_PROBE_AHEAD:
        pid += 1
        print(f"probe id={pid}...")
        content = fetch_pdf(pid)
        if content is None:
            misses += 1
            continue
        misses = 0
        parsed = parse_pdf(content, pid)
        if parsed is None:
            # PDF exists but unparseable: still advance last_id so we don't re-try forever
            doc["last_pdf_id"] = pid
            continue
        anchor_date, mktcap_b = parsed
        if anchor_date in existing_dates:
            print(f"  id={pid}: {anchor_date} 已存在, skip")
        else:
            entry = {
                "date": anchor_date,
                "mktcap_billion": mktcap_b,
                "src": f"TWSE 月訊 0005{pid:06d}.pdf"
            }
            anchors.append(entry)
            existing_dates.add(anchor_date)
            added.append(entry)
            print(f"  + {anchor_date}: {mktcap_b/1e4:.2f} 兆")
        doc["last_pdf_id"] = pid

    if not added:
        print("沒新增錨點 (可能尚未發布新月份, 或已全部抓過)")
        # 只有當 last_pdf_id 變了才寫回
        if doc["last_pdf_id"] != last_id:
            save_anchors(doc)
        return 0

    anchors.sort(key=lambda a: a["date"])
    doc["anchors"] = anchors
    save_anchors(doc)
    print(f"新增 {len(added)} 筆錨點, 最新 last_pdf_id={doc['last_pdf_id']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
