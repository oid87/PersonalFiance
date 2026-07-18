"""QQQ/SPY 長期相對強度比值 tab 資料準備。

讀取本地已快取的 data/QQQ.json、data/SPY.json（不重抓、不呼叫任何網路 API、
不用 yfinance/requests），以 date inner join 對齊兩序列，計算
ratio = QQQ.close / SPY.close（皆為未還原息原始收盤價，這是刻意的方法論選擇，
比照原始靈感來源 SpotGamma 的 NDX/SPX 比較圖，同樣排除股息）。

程式化（非手動硬編）尋找兩個關鍵點：
  - dotcom_peak：2000 上半年（2000-01-01 ~ 2000-06-30）區間內 ratio 的區域最大值
  - bust_trough：2002 下半年（2002-06-01 ~ 2002-12-31）區間內 ratio 的區域最小值
以及最新一筆 current。

輸出 data/relstrength.json。
"""
import json
import os

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
QQQ_PATH = os.path.join(BASE, "data", "QQQ.json")
SPY_PATH = os.path.join(BASE, "data", "SPY.json")
OUT_PATH = os.path.join(BASE, "data", "relstrength.json")

DOTCOM_PEAK_START = "2000-01-01"
DOTCOM_PEAK_END = "2000-06-30"
BUST_TROUGH_START = "2002-06-01"
BUST_TROUGH_END = "2002-12-31"


def main():
    with open(QQQ_PATH) as f:
        qqq_j = json.load(f)
    with open(SPY_PATH) as f:
        spy_j = json.load(f)

    qqq_by_date = {r["date"]: r["close"] for r in qqq_j["data"]}
    spy_by_date = {r["date"]: r["close"] for r in spy_j["data"]}

    common_dates = sorted(set(qqq_by_date) & set(spy_by_date))
    if not common_dates:
        raise RuntimeError("no overlapping dates between QQQ and SPY")

    rows = []
    for d in common_dates:
        qqq_c = qqq_by_date[d]
        spy_c = spy_by_date[d]
        if qqq_c is None or spy_c is None or spy_c == 0:
            continue
        rows.append({
            "date": d,
            "qqq": qqq_c,
            "spy": spy_c,
            "ratio": qqq_c / spy_c,
        })

    if not rows:
        raise RuntimeError("no valid rows after alignment")

    # 程式化尋找 dotcom_peak：2000 上半年區間內的區域最大值
    dotcom_window = [r for r in rows if DOTCOM_PEAK_START <= r["date"] <= DOTCOM_PEAK_END]
    if not dotcom_window:
        raise RuntimeError("no rows found in dotcom peak window 2000-01-01 ~ 2000-06-30")
    dotcom_peak_row = max(dotcom_window, key=lambda r: r["ratio"])

    # 程式化尋找 bust_trough：2002 下半年區間內的區域最小值
    bust_window = [r for r in rows if BUST_TROUGH_START <= r["date"] <= BUST_TROUGH_END]
    if not bust_window:
        raise RuntimeError("no rows found in bust trough window 2002-06-01 ~ 2002-12-31")
    bust_trough_row = min(bust_window, key=lambda r: r["ratio"])

    current_row = rows[-1]

    updated = max(qqq_j.get("updated", ""), spy_j.get("updated", ""))

    out = {
        "updated": updated,
        "data": rows,
        "dotcom_peak": {
            "date": dotcom_peak_row["date"],
            "ratio": round(dotcom_peak_row["ratio"], 6),
        },
        "bust_trough": {
            "date": bust_trough_row["date"],
            "ratio": round(bust_trough_row["ratio"], 6),
        },
        "current": {
            "date": current_row["date"],
            "ratio": round(current_row["ratio"], 6),
        },
    }

    # round ratio in data rows for output size sanity, keep enough precision
    for r in out["data"]:
        r["qqq"] = round(r["qqq"], 4)
        r["spy"] = round(r["spy"], 4)
        r["ratio"] = round(r["ratio"], 6)

    with open(OUT_PATH, "w") as f:
        json.dump(out, f, separators=(",", ":"))

    print(f"rows: {len(rows)}")
    print(f"first: {rows[0]['date']}  last: {rows[-1]['date']}")
    print(f"dotcom_peak: {out['dotcom_peak']}")
    print(f"bust_trough: {out['bust_trough']}")
    print(f"current: {out['current']}")


if __name__ == "__main__":
    main()
