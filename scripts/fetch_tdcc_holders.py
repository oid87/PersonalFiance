"""集保股權分散表 → 槓桿 ETF 受益人數 (0050 / 00631L / 00675L) → data/tdcc_holders.json

Sources:
  opendata (每週更新, 全市場) — https://opendata.tdcc.com.tw/getOD.ashx?id=1-5
    欄位: 資料日期,證券代號,持股分級,人數,股數,占集保庫存數比例%
    檔案含全市場所有代號、逐年增大 → 用 requests streaming 逐行過濾三個代號，
    不整檔載入記憶體。持股分級 17 = 「合　計」，取該級「人數」為受益人數。
    2026-07-09 驗算：各分級(1-16)人數加總 vs 合計(17) —
      0050: 3,273,064 vs 3,273,063 (差1,捨入雜訊) / 00631L: 309,613 = 309,613 (相等)
      00675L: 19,835 = 19,835 (相等) → 合計級編號=17 確認無誤。
  qryStock (best-effort 歷史回補) — https://www.tdcc.com.tw/portal/zh/smWeb/qryStock
    查詢頁 scaDate 下拉為近 ~1 年週次 (2026-07-09 實測 51 筆, 20250711~20260703)。
    逐日期 × 逐標的 POST 查詢解析合計列。此段失敗不 fail 整支腳本 —— 印警告，
    改靠 opendata 從今起每週累積。

累積合併按 date（idempotent，新覆舊，絕不覆蓋整份舊資料）。

Output data/tdcc_holders.json:
  {source, note, updated,
   data: {"0050": [{date, holders}], "00631L": [...], "00675L": [...]}}
  date 升冪。
"""
from __future__ import annotations

import csv
import json
import re
import time
from datetime import date
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "tdcc_holders.json"
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) PersonalFiance/1.0"}
OPENDATA_URL = "https://opendata.tdcc.com.tw/getOD.ashx?id=1-5"
QRYSTOCK_URL = "https://www.tdcc.com.tw/portal/zh/smWeb/qryStock"
SYMBOLS = ["0050", "00631L", "00675L"]
TOTAL_LEVEL = "17"


def ymd_to_iso(ymd: str) -> str:
    ymd = ymd.strip()
    return f"{ymd[0:4]}-{ymd[4:6]}-{ymd[6:8]}"


def fetch_opendata_latest() -> dict[str, dict]:
    """Stream opendata CSV line-by-line, filter to SYMBOLS, return {symbol: {date, holders}}."""
    out: dict[str, dict] = {}
    r = requests.get(OPENDATA_URL, headers=UA, stream=True, timeout=120)
    r.raise_for_status()
    lines = r.iter_lines(decode_unicode=True)
    next(lines, None)  # header (BOM-prefixed) — skip
    for line in lines:
        if not line:
            continue
        row = next(csv.reader([line]))
        if len(row) < 4:
            continue
        code = row[1].strip()
        if code not in SYMBOLS:
            continue
        if row[2].strip() != TOTAL_LEVEL:
            continue
        try:
            holders = int(row[3].strip())
        except ValueError:
            continue
        iso = ymd_to_iso(row[0])
        out[code] = {"date": iso, "holders": holders}
    return out


def get_qrystock_form():
    """GET query page once, return (session, token) for POST backfill."""
    sess = requests.Session()
    r = sess.get(QRYSTOCK_URL, headers=UA, timeout=30)
    r.raise_for_status()
    m = re.search(r'name="SYNCHRONIZER_TOKEN"\s+value="([^"]*)"', r.text)
    token = m.group(1) if m else ""
    dates = re.findall(r'<option value="(\d{8})"\s*>\1</option>', r.text)
    if not dates:
        m2 = re.search(r'name="scaDate"[^>]*>(.*?)</select>', r.text, re.S)
        if m2:
            dates = re.findall(r'value="(\d{8})"', m2.group(1))
    return sess, token, sorted(set(dates), reverse=True)


# NOTE: qryStock omits the 差異數調整(16) row entirely when its count is 0 (opendata always
# keeps it, even as a zero row) — so 合計's level number shifts between 16/17 depending on the
# security. Match on the "合計" label itself, not a hardcoded level index.
ROW_TOTAL_RE = re.compile(
    r'<td[^>]*>\d+</td>\s*<td[^>]*>合\s*計</td>\s*<td[^>]*>([\d,]+)</td>',
    re.S,
)


TOKEN_RE = re.compile(r'name="SYNCHRONIZER_TOKEN"\s+value="([^"]*)"')


def qrystock_query(sess: requests.Session, token: str, sca_date: str, symbol: str) -> tuple[int | None, str]:
    """Returns (holders, next_token). SYNCHRONIZER_TOKEN is single-use — the response embeds
    a fresh token that MUST be used for the next POST, or every request after the first 400s."""
    payload = {
        "firDate": "",
        "scaDate": sca_date,
        "sqlMethod": "StockNo",
        "stockNo": symbol,
        "stockName": "",
        "SYNCHRONIZER_TOKEN": token,
        "SYNCHRONIZER_URI": "/portal/zh/smWeb/qryStock",
        "method": "submit",
    }
    r = sess.post(QRYSTOCK_URL, data=payload, headers=UA, timeout=30)
    r.raise_for_status()
    tm = TOKEN_RE.search(r.text)
    next_token = tm.group(1) if tm else token
    m = ROW_TOTAL_RE.search(r.text)
    if not m:
        return None, next_token
    try:
        return int(m.group(1).replace(",", "")), next_token
    except ValueError:
        return None, next_token


def backfill_history(existing: dict[str, dict]) -> tuple[dict[str, dict], int, str | None]:
    """Best-effort qryStock backfill. Never raises — returns (new_points, n_added, earliest_date)."""
    added: dict[str, dict] = {s: {} for s in SYMBOLS}
    n_added = 0
    earliest = None
    try:
        sess, token, dates = get_qrystock_form()
        if not token or not dates:
            print(f"  [tdcc_holders] qryStock: no token/dates parsed — skip backfill")
            return added, 0, None
        print(f"  [tdcc_holders] qryStock: {len(dates)} scaDate options, backfilling {len(SYMBOLS)} symbols")
        for sca_date in dates:
            iso = ymd_to_iso(sca_date)
            for sym in SYMBOLS:
                if iso in existing.get(sym, {}):
                    continue
                try:
                    holders, token = qrystock_query(sess, token, sca_date, sym)
                except Exception as exc:
                    print(f"  [tdcc_holders] qryStock {sym} {sca_date} FAILED: {exc}")
                    holders = None
                if holders:
                    added[sym][iso] = {"date": iso, "holders": holders}
                    n_added += 1
                    earliest = iso if earliest is None else min(earliest, iso)
                time.sleep(1)
    except Exception as exc:
        print(f"  [tdcc_holders] qryStock backfill FAILED entirely ({exc}); opendata-only from now on")
        return added, 0, None
    return added, n_added, earliest


def load_existing() -> dict[str, dict[str, dict]]:
    if not OUT.exists():
        return {s: {} for s in SYMBOLS}
    try:
        payload = json.loads(OUT.read_text())
        out = {}
        for s in SYMBOLS:
            rows = payload.get("data", {}).get(s, [])
            out[s] = {r["date"]: r for r in rows if r.get("date")}
        return out
    except Exception:
        return {s: {} for s in SYMBOLS}


def main() -> None:
    existing = load_existing()
    n_existing = sum(len(v) for v in existing.values())
    print(f"Loaded {n_existing} existing points across {len(SYMBOLS)} symbols")

    try:
        latest = fetch_opendata_latest()
        for sym, rec in latest.items():
            existing.setdefault(sym, {})[rec["date"]] = rec
        print(f"  [tdcc_holders] opendata: {len(latest)} symbols updated ({latest})")
    except Exception as exc:
        print(f"  [tdcc_holders] opendata FAILED ({exc}); keeping existing data")

    added, n_added, earliest = backfill_history(existing)
    for sym in SYMBOLS:
        existing.setdefault(sym, {}).update(added.get(sym, {}))
    if n_added:
        print(f"  [tdcc_holders] qryStock backfill: +{n_added} points, earliest {earliest}")
    else:
        print(f"  [tdcc_holders] qryStock backfill: 0 new points (already covered or failed)")

    data = {s: [existing[s][d] for d in sorted(existing[s])] for s in SYMBOLS}
    payload = {
        "source": "TDCC opendata id=1-5(股權分散表,週頻) + qryStock(近1年週次歷史回補,best-effort)",
        "note": "holders=持股分級「合計」列之人數(opendata固定第17級;qryStock無差異調整列時合計為第16級,已用標籤比對非序號);槓桿ETF受益人數(0050為對照,前端不強制畫)",
        "updated": date.today().isoformat(),
        "data": data,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    for s in SYMBOLS:
        n = len(data[s])
        rng = f"{data[s][0]['date']}..{data[s][-1]['date']}" if n else "empty"
        print(f"Wrote {OUT.name}: {s} {n} rows ({rng})")


if __name__ == "__main__":
    main()
