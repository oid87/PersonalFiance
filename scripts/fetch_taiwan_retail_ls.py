"""Fetch TAIFEX 小型/微型臺指期貨(MTX/TMF) 散戶多空比 (零和反推), 附近月收盤/成交量.

期交所不直接公布散戶未平倉，用零和關係反推：
  散戶多單 = 全市場未平倉 - 三大法人多方未平倉合計
  散戶空單 = 全市場未平倉 - 三大法人空方未平倉合計
  散戶淨   = 散戶多單 - 散戶空單 = -(三大法人多空未平倉淨額合計)
  散戶多空比(%) = 散戶淨 / 全市場未平倉 * 100

Two TAIFEX sources (POST, cp950/Big5 CSV on success; UTF-8 HTML alert page on
error/no-data — see below):

A. 三大法人未平倉 (分子): https://www.taifex.com.tw/cht/3/futContractsDateDown
   Same endpoint family as fetch_taiwan_opt_inst.py's callsAndPutsDateDown —
   accepts a date RANGE and returns ALL commodities mixed together, one row per
   (date, 商品名稱, 身份別). We filter 商品名稱 in {小型臺指期貨(MTX), 微型臺指期貨(TMF)}
   and sum 多方未平倉口數/空方未平倉口數 across the 3 身份別 rows (自營商/投信/外資及陸資)
   per (date, commodity) to get inst_long/inst_short.
   Tested 2026-08-02: a full 3-year range (2023-08-02..2026-07-31) returns in a
   SINGLE request (~48k CSV lines, no monthly segmentation needed) — unlike
   futDataDown below. 小型臺指期貨 data starts 2023/08/01 (rolling ~3y window,
   same as fetch_taiwan_opt_inst.py); 微型臺指期貨 (TMF) first appears 2024/07/29
   (product launch date, not a window limit).
   Like callsAndPutsDateDown, querying an end date TAIFEX hasn't published yet
   (weekend/holiday/today-before-close) rejects the WHOLE range with a
   "日期時間錯誤" alert (even though earlier dates in range have data) — distinct
   from a genuine "查無資料" (no data that day, e.g. a past weekend). We reuse the
   exact same bounded end-date-backoff pattern as fetch_taiwan_opt_inst.py's
   fetch_range() to handle this.

B. 全市場未平倉 + 價/量 (分母+價量): https://www.taifex.com.tw/cht/3/futDataDown
   form {"down_type":"1","commodity_id":<MTX|TMF>,"queryStartDate","queryEndDate"}.
   NOTE: 小型臺指期貨's commodity_id is "MTX" (NOT "MXF" — that returns empty).
   Tested 2026-08-02: a 32-day range (2026/07/01~2026/08/01) returns 691 rows OK;
   a 61-day range (2024/06/01~2024/07/31) returns a "日期時間錯誤" HTML page. So
   this endpoint is chunked by CALENDAR MONTH here (each chunk <=31 days, safely
   under the tested limit), with >=1s sleep between chunks to avoid being
   rate-limited. Unlike futContractsDateDown, an out-of-range/not-yet-published
   window here returns a harmless CSV with only the header row (0 data rows) —
   no HTML error page — so no backoff logic is needed for this endpoint.
   Per-date fields, computed from the "一般" (regular session) and "盤後"
   (after-hours) rows, EXCLUDING price-spread combo rows (到期月份(週別) containing
   "/", e.g. "202608/202609" — those have "-" placeholders, not real OI/price):
     total_oi = sum of 未沖銷契約數 across 一般-session single-leg rows only
                (盤後 rows always show "-" for 未沖銷契約數 — no OI there to add)
     volume   = sum of 成交量 across ALL single-leg rows (一般 + 盤後) = day's total volume
     close    = 一般-session 收盤價 of the NEAREST MONTH contract, where "nearest
                month" = min 到期月份(週別) among contracts whose code does NOT
                contain "W" (MTX has weekly contracts like "202608W1"; those are
                excluded from "nearest month" even if numerically smaller/sooner).

Verified against hand-computed 2026-07-31 benchmarks:
  MTX: inst_long=5639 inst_short=13026 total_oi=33583 retail_net=+7387 ratio=+22.00%
       close=43679 volume=342182
  TMF: inst_long=13745 inst_short=32536 total_oi=74020 retail_net=+18791 ratio=+25.39%
       close=43685 volume=586432

Output: data/taiwan_retail_ls.json
  {"source","note","updated",
   "data": [{"date",
             "mtx_ratio","mtx_retail_net","mtx_total_oi","mtx_close","mtx_volume",
             "tmf_ratio","tmf_retail_net","tmf_total_oi","tmf_close","tmf_volume"}]}
  tmf_* fields are null for dates before TMF's 2024-07-29 launch (row still
  emitted — keyed off MTX availability — so MTX history isn't truncated).
Idempotent: re-fetching overwrites rows for the same date (keyed by date).
"""
from __future__ import annotations

import argparse
import io
import time
from collections import OrderedDict
from datetime import date, timedelta
from pathlib import Path
import json

import pandas as pd
import requests

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)
OUT = DATA_DIR / "taiwan_retail_ls.json"

INST_URL = "https://www.taifex.com.tw/cht/3/futContractsDateDown"
DATA_URL = "https://www.taifex.com.tw/cht/3/futDataDown"
HEADERS = {"User-Agent": "PersonalFiance/1.0"}

# 商品名稱 (futContractsDateDown) -> field prefix
INST_COMMODITIES = {"小型臺指期貨": "mtx", "微型臺指期貨": "tmf"}
# field prefix -> commodity_id (futDataDown). NOTE: MTX not MXF.
DATA_COMMODITY_ID = {"mtx": "MTX", "tmf": "TMF"}

RECENT_DAYS = 10          # incremental mode: re-check window (covers long weekends)
BACKFILL_DAYS = 365 * 3   # TAIFEX 三大法人 rolling ~3y query-window limit
END_DATE_BACKOFF_MAX = 7  # max days to step queryEndDate back on "DateTime error"
MONTH_CHUNK_SLEEP = 1.2   # seconds between futDataDown month-chunk requests


# ── A. 三大法人未平倉 (futContractsDateDown) ─────────────────────────────────

def _post_inst(start: date, end: date) -> bytes:
    payload = {
        "queryStartDate": start.strftime("%Y/%m/%d"),
        "queryEndDate": end.strftime("%Y/%m/%d"),
        "queryDate": "",
    }
    resp = requests.post(INST_URL, data=payload, headers=HEADERS, timeout=90)
    resp.raise_for_status()
    return resp.content


def _parse_inst_csv(text: str) -> "OrderedDict[str, dict]":
    df = pd.read_csv(io.StringIO(text), dtype=str, index_col=False)
    df.columns = [c.strip() for c in df.columns]

    by_date: "OrderedDict[str, dict]" = OrderedDict()
    for _, row in df.iterrows():
        commodity = row["商品名稱"].strip()
        prefix = INST_COMMODITIES.get(commodity)
        if prefix is None:
            continue

        raw_date = row["日期"].strip()
        y, m, d = raw_date.replace("/", "-").split("-")
        iso = f"{y}-{int(m):02d}-{int(d):02d}"

        long_oi = int(row["多方未平倉口數"].strip().replace(",", ""))
        short_oi = int(row["空方未平倉口數"].strip().replace(",", ""))

        rec = by_date.setdefault(iso, {"date": iso})
        rec[f"{prefix}_inst_long"] = rec.get(f"{prefix}_inst_long", 0) + long_oi
        rec[f"{prefix}_inst_short"] = rec.get(f"{prefix}_inst_short", 0) + short_oi

    return by_date


def fetch_inst_range(start: date, end: date) -> "OrderedDict[str, dict]":
    """Fetch [start, end] inclusive in a single request (with end-date backoff
    on TAIFEX's "DateTime error" for not-yet-published end dates). Returns {date: record}.
    Same pattern as fetch_taiwan_opt_inst.py's fetch_range()."""
    cur_end = end
    for step in range(END_DATE_BACKOFF_MAX + 1):
        if cur_end < start:
            break
        raw = _post_inst(start, cur_end)

        if raw.lstrip()[:1] != b"<":
            return _parse_inst_csv(raw.decode("cp950"))

        html = raw.decode("utf-8", errors="replace")
        if "日期時間錯誤" in html or "DateTime error" in html:
            if step < END_DATE_BACKOFF_MAX:
                cur_end -= timedelta(days=1)
                continue
            print(f"  [inst] gave up backing off queryEndDate from {end} (still DateTime error at {cur_end})")
            return OrderedDict()

        print(f"  [inst] no data for {start} ~ {cur_end} (查無資料)")
        return OrderedDict()

    return OrderedDict()


# ── B. 全市場未平倉 + 價/量 (futDataDown) ────────────────────────────────────

def _post_data(commodity_id: str, start: date, end: date) -> bytes:
    payload = {
        "down_type": "1",
        "commodity_id": commodity_id,
        "queryStartDate": start.strftime("%Y/%m/%d"),
        "queryEndDate": end.strftime("%Y/%m/%d"),
    }
    resp = requests.post(DATA_URL, data=payload, headers=HEADERS, timeout=90)
    resp.raise_for_status()
    return resp.content


def _num_or_none(s: str) -> str | None:
    s = (s or "").strip().replace(",", "")
    return None if s in ("", "-") else s


def _parse_data_csv(text: str) -> "OrderedDict[str, dict]":
    df = pd.read_csv(io.StringIO(text), dtype=str, index_col=False)
    df.columns = [c.strip() for c in df.columns]
    for c in df.columns:
        df[c] = df[c].str.strip()

    # exclude price-spread combo rows (到期月份(週別) contains "/")
    df = df[~df["到期月份(週別)"].str.contains("/", na=False)]

    by_date: "OrderedDict[str, dict]" = OrderedDict()
    for raw_date, grp in df.groupby("交易日期", sort=False):
        y, m, d = raw_date.replace("/", "-").split("-")
        iso = f"{y}-{int(m):02d}-{int(d):02d}"

        general = grp[grp["交易時段"] == "一般"]
        total_oi = sum(int(_num_or_none(v) or 0) for v in general["未沖銷契約數"])
        volume = sum(int(_num_or_none(v) or 0) for v in grp["成交量"])

        # nearest month = min contract-month code among non-weekly (no "W") rows
        months = sorted(general.loc[~general["到期月份(週別)"].str.contains("W"), "到期月份(週別)"].unique())
        close = None
        if months:
            nearest = months[0]
            candidates = grp[grp["到期月份(週別)"] == nearest]
            # prefer 一般-session close; fall back to 盤後 if 一般 is "-" (rare, illiquid day)
            for _, cand_row in pd.concat([
                candidates[candidates["交易時段"] == "一般"],
                candidates[candidates["交易時段"] != "一般"],
            ]).iterrows():
                val = _num_or_none(cand_row["收盤價"])
                if val is not None:
                    close = int(val)
                    break

        by_date[iso] = {"total_oi": total_oi, "volume": volume, "close": close}

    return by_date


def month_chunks(start: date, end: date) -> list[tuple[date, date]]:
    """Split [start, end] into calendar-month chunks (each <=31 days —
    futDataDown rejects ranges longer than ~32 days with a HTML error page)."""
    chunks = []
    cur = start
    while cur <= end:
        next_month_start = date(cur.year + 1, 1, 1) if cur.month == 12 else date(cur.year, cur.month + 1, 1)
        chunk_end = min(end, next_month_start - timedelta(days=1))
        chunks.append((cur, chunk_end))
        cur = next_month_start
    return chunks


def fetch_data_range(prefix: str, start: date, end: date) -> "OrderedDict[str, dict]":
    commodity_id = DATA_COMMODITY_ID[prefix]
    by_date: "OrderedDict[str, dict]" = OrderedDict()
    chunks = month_chunks(start, end)
    for i, (cs, ce) in enumerate(chunks):
        try:
            raw = _post_data(commodity_id, cs, ce)
        except Exception as exc:
            print(f"  [{prefix}] request failed for {cs}~{ce}: {exc}")
            continue

        if raw.lstrip()[:1] == b"<":
            html = raw.decode("utf-8", errors="replace")
            reason = "日期時間錯誤" if "日期時間錯誤" in html else "unexpected HTML"
            print(f"  [{prefix}] {reason} for {cs}~{ce}, skipping chunk")
            continue

        try:
            chunk_data = _parse_data_csv(raw.decode("cp950"))
        except Exception as exc:
            print(f"  [{prefix}] parse failed for {cs}~{ce}: {exc}")
            continue

        by_date.update(chunk_data)

        if i < len(chunks) - 1:
            time.sleep(MONTH_CHUNK_SLEEP)

    return by_date


# ── merge / save ─────────────────────────────────────────────────────────

def load_existing() -> "OrderedDict[str, dict]":
    if not OUT.exists():
        return OrderedDict()
    try:
        payload = json.loads(OUT.read_text())
        return OrderedDict((r["date"], r) for r in payload.get("data", []) if r.get("date"))
    except Exception:
        return OrderedDict()


def build_rows(inst_by_date: dict, mtx_data: dict, tmf_data: dict) -> "OrderedDict[str, dict]":
    """Build merged rows keyed by date. A row is emitted for every date that has
    BOTH mtx inst data and mtx price/OI data (MTX anchors row presence). tmf_*
    fields are filled when tmf inst+price data exist for that date, else null."""
    rows: "OrderedDict[str, dict]" = OrderedDict()
    for d in sorted(set(inst_by_date) & set(mtx_data)):
        inst = inst_by_date[d]
        if "mtx_inst_long" not in inst or "mtx_inst_short" not in inst:
            continue
        md = mtx_data[d]
        if md.get("close") is None:
            continue
        retail_net = inst["mtx_inst_short"] - inst["mtx_inst_long"]
        ratio = round(retail_net / md["total_oi"] * 100, 2) if md["total_oi"] else None

        row = {
            "date": d,
            "mtx_ratio": ratio,
            "mtx_retail_net": retail_net,
            "mtx_total_oi": md["total_oi"],
            "mtx_close": md["close"],
            "mtx_volume": md["volume"],
            "tmf_ratio": None,
            "tmf_retail_net": None,
            "tmf_total_oi": None,
            "tmf_close": None,
            "tmf_volume": None,
        }

        if (d in inst_by_date and "tmf_inst_long" in inst_by_date[d]
                and d in tmf_data and tmf_data[d].get("close") is not None):
            tinst = inst_by_date[d]
            tmd = tmf_data[d]
            t_retail_net = tinst["tmf_inst_short"] - tinst["tmf_inst_long"]
            t_ratio = round(t_retail_net / tmd["total_oi"] * 100, 2) if tmd["total_oi"] else None
            row.update({
                "tmf_ratio": t_ratio,
                "tmf_retail_net": t_retail_net,
                "tmf_total_oi": tmd["total_oi"],
                "tmf_close": tmd["close"],
                "tmf_volume": tmd["volume"],
            })

        rows[d] = row

    return rows


def save(merged: "OrderedDict[str, dict]") -> None:
    data = [merged[d] for d in sorted(merged)]
    payload = {
        "source": "TAIFEX futContractsDateDown(三大法人未平倉) + futDataDown(全市場未平倉/價/量), MTX 小型臺指期貨 & TMF 微型臺指期貨",
        "note": (
            "散戶多空比 = -(三大法人多空未平倉淨額) / 全市場未平倉 × 100. 正=散戶淨多. "
            "期交所三大法人僅滾動3年查詢視窗; TMF 約2024年中上市, 更早無資料. "
            "close=近月月份契約一般時段收盤; volume=當日全時段總成交量(排除價差契約)."
        ),
        "updated": date.today().isoformat(),
        "data": data,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--backfill", action="store_true", help="fetch full ~3y rolling window")
    args = parser.parse_args()

    today = date.today()
    existing = load_existing()

    start = today - timedelta(days=BACKFILL_DAYS if args.backfill else RECENT_DAYS)
    mode = "backfill" if args.backfill else "incremental"
    print(f"Fetching TAIFEX MTX/TMF retail long-short: {start} ~ {today} ({mode})")

    try:
        inst_by_date = fetch_inst_range(start, today)
        print(f"  [inst] {len(inst_by_date)} dates")

        mtx_data = fetch_data_range("mtx", start, today)
        print(f"  [mtx] {len(mtx_data)} dates")

        tmf_data = fetch_data_range("tmf", start, today)
        print(f"  [tmf] {len(tmf_data)} dates")
    except Exception as exc:
        if existing:
            print(f"  [taiwan_retail_ls] FAILED ({exc}); keeping {len(existing)} existing rows")
            return
        print(f"  [taiwan_retail_ls] FAILED and no existing data ({exc}); nothing written")
        return

    fresh = build_rows(inst_by_date, mtx_data, tmf_data)
    if not fresh:
        print("  no fresh rows built (source likely unreachable/empty for this window)")
        if not existing:
            return

    merged = OrderedDict(existing)
    for d, rec in fresh.items():
        merged[d] = rec

    save(merged)
    print(f"Wrote {OUT.name}: {len(merged)} rows")
    if merged:
        last = max(merged.keys())
        first = min(merged.keys())
        print(f"  range: {first} -> {last}")
        print(f"  first row: {merged[first]}")
        print(f"  last row: {merged[last]}")


if __name__ == "__main__":
    main()
