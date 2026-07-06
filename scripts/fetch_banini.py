"""Fetch banini-tracker public SQLite snapshot → data/banini_reverse_indicator.json

Source:
  https://github.com/cablate/banini-tracker (AGPL-3.0)
  data/banini-public.db — 去識別化預測快照（345 predictions / 1563 price_snapshots）
  追蹤 FB 網紅「股海冥燈 巴逆逆(8zz)」貼文做反指標分析。

⚠️ 偏離本 repo 其他 fetch script 的「按 date 累積合併」慣例：
  這份資料是第三方 repo 裡的一份**靜態完整快照**，不是我方逐日累積的時序資料。
  對方資料集本身就是全量，沒有「本地才有、對方沒有」的歷史需要保留合併。
  因此每次執行都用最新下載內容**全量覆蓋重建**輸出檔，不做 OrderedDict 按日期 merge。

self_result 是本頁自行計算的方向判定，非原作者公開的成功率算法（原作者未公開其計算方式）：
  取每筆 prediction 在 price_snapshots 裡 day_number 最大的一列。
  - 無對應列          → no_data
  - 最大 day_number<5 → insufficient（資料集已凍結，不會再補）
  - day_number==5     → 用該列 change_pct_close：
      reverse_view=='多' 且 change_pct_close>1  → success
      reverse_view=='空' 且 change_pct_close<-1 → success
      其餘                                       → fail

Output data/banini_reverse_indicator.json:
  {source, note, license_note, disclaimer, updated, upstream_range,
   data: [{id, post_url, symbol_name, symbol_code, symbol_type, her_action,
           reverse_view, reasoning, base_price, created_at, status,
           tracked_days, final_change_pct, self_result}],
   stats: {total_predictions, by_reverse_view, by_symbol_type,
           self_success_rate, monthly_counts, top_symbols}}
"""
from __future__ import annotations

import json
import sqlite3
from collections import Counter
from datetime import date
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)
OUT = DATA_DIR / "banini_reverse_indicator.json"

UA = {"User-Agent": "PersonalFiance/1.0"}
DB_URL = "https://github.com/cablate/banini-tracker/raw/master/data/banini-public.db"

SOURCE = (
    "banini-tracker by cablate (https://github.com/cablate/banini-tracker)，"
    "data/banini-public.db，AGPL-3.0"
)
NOTE = (
    "資料集為去識別化預測快照，不含原始貼文全文。self_result/final_change_pct/tracked_days "
    "為本頁自行依「第5個交易日收盤價 vs 基準價，正確方向且幅度>1%」計算，非原作者公式；"
    "原作者未公開其成功率計算方法，兩者數字不可直接對照。"
)
LICENSE_NOTE = "依 AGPL-3.0，使用/展示本資料須標明原作者並附上原 repo 連結。"
DISCLAIMER = "本專案僅供娛樂參考，不構成任何投資建議。（原作者聲明）"


def fetch_db_bytes() -> bytes:
    resp = requests.get(DB_URL, headers=UA, timeout=30)
    resp.raise_for_status()
    return resp.content


def compute_self_result(reverse_view: str, snaps: list[sqlite3.Row]) -> tuple[int | None, float | None, str]:
    if not snaps:
        return None, None, "no_data"
    last = max(snaps, key=lambda r: r["day_number"])
    day_number = last["day_number"]
    change_pct_close = last["change_pct_close"]
    if day_number < 5:
        return day_number, change_pct_close, "insufficient"
    # day_number == 5
    if reverse_view == "多" and change_pct_close is not None and change_pct_close > 1:
        result = "success"
    elif reverse_view == "空" and change_pct_close is not None and change_pct_close < -1:
        result = "success"
    else:
        result = "fail"
    return day_number, change_pct_close, result


def build_payload(db_bytes: bytes) -> dict:
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".db") as tmp:
        tmp.write(db_bytes)
        tmp.flush()
        con = sqlite3.connect(tmp.name)
        con.row_factory = sqlite3.Row
        cur = con.cursor()

        cur.execute(
            "SELECT id, post_id, post_url, symbol_name, symbol_code, symbol_type, "
            "her_action, reverse_view, reasoning, base_price, created_at, status "
            "FROM predictions ORDER BY id"
        )
        predictions = cur.fetchall()

        cur.execute(
            "SELECT prediction_id, day_number, date, close_price, change_pct_close "
            "FROM price_snapshots"
        )
        snaps_by_pred: dict[int, list[sqlite3.Row]] = {}
        for row in cur.fetchall():
            snaps_by_pred.setdefault(row["prediction_id"], []).append(row)

        con.close()

    data = []
    for p in predictions:
        snaps = snaps_by_pred.get(p["id"], [])
        tracked_days, final_change_pct, self_result = compute_self_result(p["reverse_view"], snaps)
        data.append({
            "id": p["id"],
            "post_url": p["post_url"],
            "symbol_name": p["symbol_name"],
            "symbol_code": p["symbol_code"],
            "symbol_type": p["symbol_type"],
            "her_action": p["her_action"],
            "reverse_view": p["reverse_view"],
            "reasoning": p["reasoning"],
            "base_price": p["base_price"],
            "created_at": p["created_at"],
            "status": p["status"],
            "tracked_days": tracked_days,
            "final_change_pct": final_change_pct,
            "self_result": self_result,
        })

    created_ats = [d["created_at"] for d in data if d["created_at"]]
    upstream_range = {
        "from": min(created_ats) if created_ats else None,
        "to": max(created_ats) if created_ats else None,
    }

    by_reverse_view = dict(Counter(d["reverse_view"] for d in data))
    by_symbol_type = dict(Counter(d["symbol_type"] for d in data))

    def rate_block(rows: list[dict]) -> dict:
        c = Counter(r["self_result"] for r in rows)
        success, fail = c.get("success", 0), c.get("fail", 0)
        denom = success + fail
        rate_pct = round(success / denom * 100, 1) if denom else 0.0
        return success, fail, c, rate_pct

    success_all, fail_all, c_all, rate_all = rate_block(data)
    overall = {
        "success": success_all,
        "fail": fail_all,
        "insufficient": c_all.get("insufficient", 0),
        "no_data": c_all.get("no_data", 0),
        "rate_pct": rate_all,
    }

    long_rows = [d for d in data if d["reverse_view"] == "多"]
    short_rows = [d for d in data if d["reverse_view"] == "空"]
    s_long, f_long, _, r_long = rate_block(long_rows)
    s_short, f_short, _, r_short = rate_block(short_rows)

    monthly = Counter(d["created_at"][:7] for d in data if d["created_at"])
    monthly_counts = [{"month": m, "count": monthly[m]} for m in sorted(monthly)]

    symbol_counter = Counter((d["symbol_name"], d["symbol_code"]) for d in data)
    top_symbols = [
        {"symbol_name": name, "symbol_code": code, "count": count}
        for (name, code), count in symbol_counter.most_common(15)
    ]

    stats = {
        "total_predictions": len(data),
        "by_reverse_view": by_reverse_view,
        "by_symbol_type": by_symbol_type,
        "self_success_rate": {
            "method": (
                "第5個交易日收盤價 vs 基準價，正確方向且幅度>1%記為成功；"
                "no_data/insufficient 不計入分母"
            ),
            "overall": overall,
            "多": {"success": s_long, "fail": f_long, "rate_pct": r_long},
            "空": {"success": s_short, "fail": f_short, "rate_pct": r_short},
        },
        "monthly_counts": monthly_counts,
        "top_symbols": top_symbols,
    }

    return {
        "source": SOURCE,
        "note": NOTE,
        "license_note": LICENSE_NOTE,
        "disclaimer": DISCLAIMER,
        "updated": date.today().isoformat(),
        "upstream_range": upstream_range,
        "data": data,
        "stats": stats,
    }


def main() -> None:
    try:
        db_bytes = fetch_db_bytes()
        payload = build_payload(db_bytes)
    except Exception as exc:
        if OUT.exists():
            print(f"  [banini] FAILED ({exc}); keeping existing data/banini_reverse_indicator.json")
            return
        raise

    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=None) + "\n")
    print(f"Wrote {OUT.name}: {len(payload['data'])} predictions, "
          f"self_success_rate.overall.rate_pct={payload['stats']['self_success_rate']['overall']['rate_pct']}")


if __name__ == "__main__":
    main()
