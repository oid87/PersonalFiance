"""VXN−VIX 波動率價差 tab 資料準備。

讀取本地已快取的 data/VIX.json、data/VXN.json（不重抓、不呼叫任何網路 API），
以 date inner join 對齊兩序列，計算 spread = VXN.close - VIX.close，
並用「全樣本」（非 rolling window）分位數當描述性參考門檻（90th/95th）。

輸出 data/vxnvix.json。
"""
import json
import os

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VIX_PATH = os.path.join(BASE, "data", "VIX.json")
VXN_PATH = os.path.join(BASE, "data", "VXN.json")
OUT_PATH = os.path.join(BASE, "data", "vxnvix.json")


def percentile(sorted_vals, p):
    """比照前端 js/tabs/vixskew.js 的 percentile()：index-based（非內插）。"""
    if not sorted_vals:
        return None
    n = len(sorted_vals)
    idx = min(n - 1, max(0, int(p * (n - 1))))
    return sorted_vals[idx]


def percentile_rank(sorted_vals, value):
    """value 在 sorted_vals 中的百分位排名（0-100），= <= value 的比例。"""
    n = len(sorted_vals)
    if n == 0:
        return None
    count_le = sum(1 for v in sorted_vals if v <= value)
    return count_le / n * 100.0


def main():
    with open(VIX_PATH) as f:
        vix_j = json.load(f)
    with open(VXN_PATH) as f:
        vxn_j = json.load(f)

    vix_by_date = {r["date"]: r["close"] for r in vix_j["data"]}
    vxn_by_date = {r["date"]: r["close"] for r in vxn_j["data"]}

    common_dates = sorted(set(vix_by_date) & set(vxn_by_date))
    if not common_dates:
        raise RuntimeError("no overlapping dates between VIX and VXN")

    rows = []
    for d in common_dates:
        vix_c = vix_by_date[d]
        vxn_c = vxn_by_date[d]
        if vix_c is None or vxn_c is None:
            continue
        rows.append({
            "date": d,
            "vix": vix_c,
            "vxn": vxn_c,
            "spread": round(vxn_c - vix_c, 4),
        })

    spreads_sorted = sorted(r["spread"] for r in rows)
    p90 = percentile(spreads_sorted, 0.90)
    p95 = percentile(spreads_sorted, 0.95)

    last = rows[-1]
    rank = percentile_rank(spreads_sorted, last["spread"])

    updated = max(vix_j.get("updated", ""), vxn_j.get("updated", ""))

    out = {
        "updated": updated,
        "data": rows,
        "percentile_90": round(p90, 4),
        "percentile_95": round(p95, 4),
        "current": {
            "date": last["date"],
            "spread": last["spread"],
            "percentile_rank": round(rank, 2),
        },
    }

    # sanity check per spec: 2026-07-17 spread should be ~10.26
    check = next((r for r in rows if r["date"] == "2026-07-17"), None)
    if check is not None:
        if abs(check["spread"] - 10.26) > 0.05:
            raise RuntimeError(
                f"sanity check failed: 2026-07-17 spread={check['spread']}, expected ~10.26"
            )
        print(f"sanity check OK: 2026-07-17 spread={check['spread']}")
    else:
        print("WARNING: 2026-07-17 not found in aligned data (sanity check skipped)")

    with open(OUT_PATH, "w") as f:
        json.dump(out, f, indent=2)

    print(f"wrote {OUT_PATH}")
    print(f"rows: {len(rows)}  first={rows[0]['date']}  last={rows[-1]['date']}")
    print(f"percentile_90={p90}  percentile_95={p95}")
    print(f"current={out['current']}")


if __name__ == "__main__":
    main()
