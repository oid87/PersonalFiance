"""美股 Put/Call ratio → data/putcall.json

Sources (兩段拼接，實測 2026-07-09 定案)：
  OCC daily-volume-totals API（2019-10-05+，全部 19 家交易所加總）
    https://marketdata.theocc.com/mdapi/daily-volume-totals?report_date=YYYY-MM-DD
    entity.total_volume / entity.equity_volume 各含一列 exchange=="Total" 的加總。
    實測回溯深度：OCC 只能回溯到約 2017-05-05（更早日期回應 200 但 total_volume=[]），
    未達 spec 要求的 2010 門檻 → 改採 CBOE 凍結 archive 補歷史 + OCC 接續後段（不用
    OCC 單一序列）。
  CBOE 凍結 archive totalpc.csv / equitypc.csv（2006-11-01～2019-10-04，實測最後一列
    為 2019-10-04；需 Mozilla UA 否則被擋）
    https://cdn.cboe.com/resources/options/volume_and_call_put_ratios/totalpc.csv
    https://cdn.cboe.com/resources/options/volume_and_call_put_ratios/equitypc.csv

拼接方式：CBOE 覆蓋 2006-11-01～2019-10-04，OCC 覆蓋 2019-10-05 起；兩段口徑不同
（CBOE 僅 Cboe 交易所、OCC 為 19 家交易所加總），接續處不做平滑，誠實記錄於 note。

回補策略：newest-first resumable —— 讀現有 data/putcall.json，只補缺的 OCC 工作日，
單次執行最多 400 筆請求（sleep 0.4s），CI 每日跑自然逐步往回補齊；只迭代週一～週五
（不特別識別聯邦假日，遇假日 OCC 回應空值即跳過，隔日不會重複計入 total 但仍可能在下次
執行時再被嘗試一次，屬可接受的小浪費）。

Output data/putcall.json:
  {source, note, updated,
   total:  [{date, pc}],   # 全市場 Put/Call ratio，升冪
   equity: [{date, pc}]}   # equity-only put/call（排除指數/期貨/債券），更貼近散戶情緒
"""
from __future__ import annotations

import csv
import io
import json
import time
from collections import OrderedDict
from datetime import date, datetime, timedelta
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)
OUT = DATA_DIR / "putcall.json"

UA = {"User-Agent": "PersonalFiance/1.0"}
CBOE_UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}

OCC_URL = "https://marketdata.theocc.com/mdapi/daily-volume-totals?report_date={d}"
CBOE_TOTAL_URL = "https://cdn.cboe.com/resources/options/volume_and_call_put_ratios/totalpc.csv"
CBOE_EQUITY_URL = "https://cdn.cboe.com/resources/options/volume_and_call_put_ratios/equitypc.csv"

OCC_START = date(2019, 10, 5)   # 接續 CBOE 凍結 archive（最後一天 2019-10-04）之後
MAX_OCC_REQUESTS = 400
SLEEP_SEC = 0.4
PC_MIN, PC_MAX = 0.3, 3.0


def load_existing() -> tuple[OrderedDict, OrderedDict]:
    if not OUT.exists():
        return OrderedDict(), OrderedDict()
    try:
        payload = json.loads(OUT.read_text())
        total = OrderedDict((r["date"], r["pc"]) for r in payload.get("total", []) if r.get("date"))
        equity = OrderedDict((r["date"], r["pc"]) for r in payload.get("equity", []) if r.get("date"))
        return total, equity
    except Exception:
        return OrderedDict(), OrderedDict()


def fetch_cboe_csv(url: str) -> "OrderedDict[str, float]":
    r = requests.get(url, headers=CBOE_UA, timeout=30)
    r.raise_for_status()
    rows: "OrderedDict[str, float]" = OrderedDict()
    started = False
    for row in csv.reader(io.StringIO(r.text)):
        if not row:
            continue
        if row[0].strip() == "DATE":
            started = True
            continue
        if not started or len(row) < 5:
            continue
        try:
            d = datetime.strptime(row[0].strip(), "%m/%d/%Y").date()
            pc = float(row[4].strip())
        except (ValueError, IndexError):
            continue
        rows[d.isoformat()] = pc
    return rows


def _total_row_pc(volume_list: list) -> float | None:
    for row in volume_list:
        if str(row.get("exchange", "")).strip() == "Total":
            calls = row.get("calls") or 0
            puts = row.get("puts") or 0
            if calls:
                return round(puts / calls, 3)
    return None


def fetch_occ_day(d: date) -> tuple[float | None, float | None]:
    """Return (total_pc, equity_pc) for one date; (None, None) if OCC has no data that day."""
    r = requests.get(OCC_URL.format(d=d.isoformat()), headers=UA, timeout=15)
    r.raise_for_status()
    entity = r.json().get("entity", {})
    return _total_row_pc(entity.get("total_volume", [])), _total_row_pc(entity.get("equity_volume", []))


def business_days(start: date, end: date):
    d = start
    while d <= end:
        if d.weekday() < 5:
            yield d
        d += timedelta(days=1)


def main() -> None:
    total, equity = load_existing()

    try:
        cboe_total = fetch_cboe_csv(CBOE_TOTAL_URL)
        total.update(cboe_total)
        print(f"  [putcall] CBOE total archive: {len(cboe_total)} rows")
    except Exception as exc:
        print(f"  [putcall] CBOE total FAILED ({exc}); keeping existing")

    try:
        cboe_equity = fetch_cboe_csv(CBOE_EQUITY_URL)
        equity.update(cboe_equity)
        print(f"  [putcall] CBOE equity archive: {len(cboe_equity)} rows")
    except Exception as exc:
        print(f"  [putcall] CBOE equity FAILED ({exc}); keeping existing")

    today = date.today()
    all_bdays = list(business_days(OCC_START, today))
    missing = sorted((d for d in all_bdays if d.isoformat() not in total), reverse=True)
    todo = missing[:MAX_OCC_REQUESTS]
    print(f"  [putcall] OCC missing business days: {len(missing)}, fetching {len(todo)} this run")

    fetched = 0
    for d in todo:
        try:
            total_pc, equity_pc = fetch_occ_day(d)
        except Exception as exc:
            print(f"  [putcall] OCC {d} FAILED ({exc}); skip")
            time.sleep(SLEEP_SEC)
            continue
        if total_pc is not None:
            total[d.isoformat()] = total_pc
        if equity_pc is not None:
            equity[d.isoformat()] = equity_pc
        fetched += 1
        time.sleep(SLEEP_SEC)
    print(f"  [putcall] OCC fetched {fetched} days (holidays/weekends without data are skipped)")

    total_rows = [{"date": d, "pc": total[d]} for d in sorted(total) if PC_MIN <= total[d] <= PC_MAX]
    equity_rows = [{"date": d, "pc": equity[d]} for d in sorted(equity) if PC_MIN <= equity[d] <= PC_MAX]

    payload = {
        "source": "CBOE frozen archive totalpc.csv/equitypc.csv (2006-11-01~2019-10-04) + "
                   "OCC daily-volume-totals API (2019-10-05+)",
        "note": "全市場 Put/Call ratio。OCC 官方回溯實測只到約 2017-05-05（未達 2010 門檻），"
                "故 2006-11-01~2019-10-04 改用 CBOE 凍結 archive（僅 Cboe 交易所口徑），"
                "2019-10-05 起改用 OCC daily-volume-totals 的 19 家交易所加總 Total 列；"
                "兩段涵蓋範圍口徑不同，接續處未做平滑處理。equity 為 equity-only P/C"
                "（排除指數/期貨/債券選擇權），更貼近散戶情緒，缺值時可能為空陣列。",
        "updated": today.isoformat(),
        "total": total_rows,
        "equity": equity_rows,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    print(f"Wrote {OUT.name}: total={len(total_rows)} rows, equity={len(equity_rows)} rows")


if __name__ == "__main__":
    main()
