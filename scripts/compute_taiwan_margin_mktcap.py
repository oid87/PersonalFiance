"""融資餘額 ÷ 上市市值 (千分比 ‰) — 台股槓桿密度指標, 多年回測版.

來源:
  data/taiwan_margin_total.json   (FinMind 大盤融資餘額, 億元, 2008+, 每日)
  data/TWII.json                  (yfinance 加權指數 TAIEX OHLC, 1997+, 每日)
  data/taiwan_mktcap_anchors.json (TWSE 月訊 + SFB 證期局, 月度/年度上市市值錨點)

方法:
  TWSE 不開放免費每日大盤總市值. 改採『月度錨點 + K(t) 線性插值』:
    1. 每個錨點 (date, mktcap_billion) 配對其 TWII 收盤 → K_anchor = mktcap / TAIEX
       (K 物理意義 = 每點指數對應的市值 億元/index point, 隨新股上市/減資/股本變動而漂移)
    2. 對任一交易日 t: 以前後兩個錨點線性插值 K(t)
       — 越接近錨點越準, 兩錨點間用線性過渡
       — 早於最早錨點: 用最早 K 常數外推 (回測 < 2010 較不準)
       — 晚於最新錨點: 用最新 K 常數外推 (新月度錨進來會自動修正)
    3. 上市市值估_t = TAIEX_close_t × K(t)
    4. ratio = 融資餘額_t (億) / 上市市值估_t (億) × 1000 (千分比 ‰)

設計取捨:
  - 比舊版單一 K 大幅準確, 但仍是估算. 真正準的『每日上市市值』需逐檔股本 × 收盤, 重且付費.
  - 5.0 警戒線 (2021 高點概念) 在校準後較有意義, 但仍非可精準比對的閾值.

輸出: data/taiwan_margin_mktcap.json
  { source, note, anchors_used, updated,
    data: [{date, twii_close, margin_billion, k_interp, mktcap_billion_est, ratio}, ...] }
"""
from __future__ import annotations

import json
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MARGIN_IN = ROOT / "data" / "taiwan_margin_total.json"
TWII_IN = ROOT / "data" / "TWII.json"
ANCHORS_IN = ROOT / "data" / "taiwan_mktcap_anchors.json"
OUT = ROOT / "data" / "taiwan_margin_mktcap.json"


def load_json(p: Path) -> dict:
    return json.loads(p.read_text())


def nearest_twii(twii_close: dict[str, float], target: str) -> tuple[str, float] | None:
    """Return (date, close) of the latest available TWII trading day on or before target."""
    if target in twii_close:
        return target, twii_close[target]
    keys = sorted(twii_close.keys())
    # binary-ish: walk backward up to 12 days for month-end falling on weekend/holiday
    from datetime import date as _date, timedelta
    try:
        d = _date.fromisoformat(target)
    except ValueError:
        return None
    for _ in range(12):
        d -= timedelta(days=1)
        s = d.isoformat()
        if s in twii_close:
            return s, twii_close[s]
    # fallback: scan keys
    le = [k for k in keys if k <= target]
    return (le[-1], twii_close[le[-1]]) if le else None


def interp_k(target: str, anchor_k: list[tuple[str, float]]) -> float:
    """Linear interpolation of K(t). anchor_k is sorted list of (date, k)."""
    if not anchor_k:
        raise ValueError("no anchors")
    if target <= anchor_k[0][0]:
        return anchor_k[0][1]
    if target >= anchor_k[-1][0]:
        return anchor_k[-1][1]
    # find bracket
    lo, hi = 0, len(anchor_k) - 1
    while lo + 1 < hi:
        mid = (lo + hi) // 2
        if anchor_k[mid][0] <= target:
            lo = mid
        else:
            hi = mid
    d0, k0 = anchor_k[lo]
    d1, k1 = anchor_k[hi]
    from datetime import date as _d
    t0 = _d.fromisoformat(d0).toordinal()
    t1 = _d.fromisoformat(d1).toordinal()
    t = _d.fromisoformat(target).toordinal()
    w = (t - t0) / (t1 - t0)
    return k0 + (k1 - k0) * w


def main() -> None:
    for p in (MARGIN_IN, TWII_IN, ANCHORS_IN):
        if not p.exists():
            raise SystemExit(f"missing input: {p.name}")

    try:
        margin = load_json(MARGIN_IN).get("data", [])
        twii = load_json(TWII_IN).get("data", [])
        anchors_doc = load_json(ANCHORS_IN)
    except Exception as exc:
        if OUT.exists():
            print(f"input parse failed ({exc}); keeping existing {OUT.name}")
            return
        raise

    twii_close = {r["date"]: r.get("close") for r in twii if r.get("close") is not None}
    anchors = sorted(anchors_doc.get("anchors", []), key=lambda a: a["date"])

    # Compute K for each anchor (mktcap_billion / TAIEX_close_at_anchor_date)
    anchor_k: list[tuple[str, float]] = []
    anchor_dbg: list[dict] = []
    for a in anchors:
        nt = nearest_twii(twii_close, a["date"])
        if nt is None:
            continue
        twii_date, twii_val = nt
        if twii_val <= 0:
            continue
        k = a["mktcap_billion"] / twii_val
        anchor_k.append((a["date"], k))
        anchor_dbg.append({
            "anchor_date": a["date"], "mktcap_billion": a["mktcap_billion"],
            "twii_date": twii_date, "twii_close": round(twii_val, 2),
            "k": round(k, 3), "src": a.get("src"),
        })
    if not anchor_k:
        raise SystemExit("no usable anchors")

    rows: list[dict] = []
    for m in margin:
        d = m.get("date")
        mb = m.get("margin_money")
        tc = twii_close.get(d)
        if d is None or mb is None or tc is None or tc <= 0:
            continue
        k = interp_k(d, anchor_k)
        mktcap_b = tc * k
        ratio = mb / mktcap_b * 1000.0
        rows.append({
            "date": d,
            "twii_close": round(tc, 2),
            "margin_billion": round(mb, 1),
            "k_interp": round(k, 3),
            "mktcap_billion_est": round(mktcap_b, 0),
            "ratio": round(ratio, 3),
        })

    if not rows:
        if OUT.exists():
            print("no joined rows; keeping existing")
            return
        raise SystemExit("no overlapping dates between margin and TWII")

    rows.sort(key=lambda r: r["date"])

    OUT.write_text(json.dumps({
        "source": "compute: taiwan_margin_total.json × TWII.json × taiwan_mktcap_anchors.json",
        "note": "ratio = 融資餘額(億) / 上市市值估算(億) × 1000 (千分比 ‰). 上市市值 = TAIEX × K(t), K(t) 由月度錨點線性插值 (錨點源: TWSE 集中市場月訊 + SFB 證期局). 錨點外的早期/最新區段 K 常數外推, 較不準. 5.0 警戒線取 2021 高點概念, 為視覺參考.",
        "anchors_used": anchor_dbg,
        "updated": date.today().isoformat(),
        "data": rows,
    }, ensure_ascii=False) + "\n")
    print(f"Wrote {len(rows)} rows -> {OUT.name} ({rows[0]['date']}..{rows[-1]['date']}; "
          f"latest ratio={rows[-1]['ratio']}, K={rows[-1]['k_interp']})")
    print(f"  anchors used: {len(anchor_dbg)}, K range: "
          f"{min(d['k'] for d in anchor_dbg):.2f}..{max(d['k'] for d in anchor_dbg):.2f}")


if __name__ == "__main__":
    main()
