"""Independent re-computation of docs/research/qqq-panic-divergence-events.csv / groups.csv.

Reads data/*.json directly (no shared code with js/tabs/qqqpanic_calc.mjs) and checks every
raw event of every threshold field by field. Exit 0 = all match, 1 = mismatch.

Usage: python3 scripts/research/verify_qqq_panic.py [--csv-dir docs/research]
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
START, END = "2015-01-01", "2026-10-30"
THRESHOLDS = (-2, -3, -4, -5)
PRE, POST, GROUP = 60, 60, 20
HORIZONS = (5, 20, 60)


def rows(name):
    return json.loads((ROOT / "data" / name).read_text())["data"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv-dir", default=str(ROOT / "docs" / "research"))
    args = ap.parse_args()

    q = sorted(rows("QQQ.json"), key=lambda r: r["date"])
    vix = {r["date"]: r for r in rows("VIX.json")}
    vxn = {r["date"]: r for r in rows("VXN.json")}
    fg = {r["date"]: r["value"] for r in rows("fear_greed.json") if r.get("value") is not None}
    D = [r["date"] for r in q]
    O, H, L, C, V = ([r[k] for r in q] for k in ("open", "high", "low", "close", "volume"))
    end = max(i for i, d in enumerate(D) if d <= END)
    start = next(i for i, d in enumerate(D) if d >= START)
    vixH = [vix.get(d, {}).get("high") for d in D]
    fgv = [fg.get(d) for d in D]

    def sma(p, i):
        if i < p - 1:
            return None
        return sum(C[i - p + 1:i + 1]) / p

    def panic_day(j):
        return (vixH[j] is not None and vixH[j] >= 30) or (fgv[j] is not None and fgv[j] < 15)

    expected = {}
    groups_expected = {}
    for thr in THRESHOLDS:
        idxs = [i for i in range(max(1, start), end + 1) if L[i] / C[i - 1] - 1 <= thr / 100]
        anchor, gno, rank = None, 0, 0
        for i in idxs:
            if anchor is None or i - anchor >= GROUP:
                anchor, gno, rank = i, gno + 1, 0
                groups_expected[f"{thr}#{gno:03d}"] = D[i]
            rank += 1
            avail = min(POST, end - i)
            pre_high = max(H[i - PRE:i])
            vh, f = vixH[i], fgv[i]
            cls = "B" if (vh is not None and vh >= 30) or (f is not None and f < 15) else ("A" if vh is not None and f is not None else "U")
            avg = sum(V[i - 20:i]) / 20
            e = {
                "group_id": f"{thr}#{gno:03d}", "group_rank": rank, "is_group_rep": 1 if rank == 1 else 0,
                "drop_low_vs_prev_close_pct": (L[i] / C[i - 1] - 1) * 100,
                "close_chg_pct": (C[i] / C[i - 1] - 1) * 100,
                "hl_range_high_to_low_pct": (L[i] / H[i] - 1) * 100,
                "vol_ratio": V[i] / avg,
                "pre_high_60": pre_high, "event_drawdown_pct": (L[i] / pre_high - 1) * 100,
                "panic_class": cls, "post_days_available": avail,
            }
            if avail >= 1:
                entry = O[i + 1]
                for h in HORIZONS:
                    if avail < h:
                        continue
                    lo = min(L[i + 1:i + h + 1])
                    e[f"ret{h}_open_pct"] = (C[i + h] / entry - 1) * 100
                    e[f"ret{h}_close_pct"] = (C[i + h] / C[i] - 1) * 100
                    e[f"mae{h}_open_pct"] = min(0.0, (lo / entry - 1) * 100)
                    e[f"rebreak{h}"] = 1 if lo < L[i] else 0
                    e[f"extra_drop{h}_pct"] = min(0.0, (lo / L[i] - 1) * 100)
                    e[f"total_dd{h}_pct"] = (lo / pre_high - 1) * 100
                post = range(i + 1, i + avail + 1)
                p = next((j for j in post if panic_day(j)), None)
                e["post_extreme_panic_date"] = D[p] if p is not None else ""
                b = next((j for j in post if fgv[j] is not None and fgv[j] < 15), None)
                e["post_fg_below15_date"] = D[b] if b is not None else ""
                for per in (125, 150):
                    m = sma(per, i)
                    if C[i] >= m:
                        e[f"ma{per}_status"] = "above"
                    else:
                        k = next((j for j in post if C[j] > sma(per, j)), None)
                        e[f"ma{per}_status"] = "reclaimed" if k is not None else ("not_within" if avail >= POST else "censored")
                        e[f"ma{per}_reclaim_days"] = (k - i) if k is not None else ""
                        kc = next((j for j in post if C[j] > sma(per, j) * 1.025), None)
                        e[f"ma{per}_confirm2p5_days"] = (kc - i) if kc is not None else ""
                t = next((j for j in post if L[j] <= sma(300, j)), None)
                e["ma300_touch_days"] = (t - i) if t is not None else ""
            expected[(thr, D[i])] = e

    def same(a, b):
        if isinstance(b, (int, float)) and not isinstance(b, bool):
            if a == "":
                return False
            return math.isclose(float(a), float(b), abs_tol=2e-4, rel_tol=1e-9)
        return str(a) == str(b)

    csv_dir = Path(args.csv_dir)
    got = list(csv.DictReader((csv_dir / "qqq-panic-divergence-events.csv").open()))
    errors, checked = [], 0
    keys_got = {(int(r["threshold_pct"]), r["date"]) for r in got}
    for k in sorted(set(expected) - keys_got):
        errors.append(f"missing event in CSV: {k}")
    for k in sorted(keys_got - set(expected)):
        errors.append(f"unexpected event in CSV: {k}")
    for r in got:
        e = expected.get((int(r["threshold_pct"]), r["date"]))
        if not e:
            continue
        for field, val in e.items():
            checked += 1
            if not same(r[field], val):
                errors.append(f"{r['threshold_pct']} {r['date']} {field}: csv={r[field]!r} expected={val!r}")
    g = list(csv.DictReader((csv_dir / "qqq-panic-divergence-groups.csv").open()))
    for row in g:
        checked += 1
        if groups_expected.get(row["group_id"]) != row["anchor_date"]:
            errors.append(f"group {row['group_id']} anchor {row['anchor_date']} expected {groups_expected.get(row['group_id'])}")
    if len(g) != len(groups_expected):
        errors.append(f"group count {len(g)} expected {len(groups_expected)}")

    counts = {t: sum(1 for k in expected if k[0] == t) for t in THRESHOLDS}
    gcounts = {t: sum(1 for k in groups_expected if k.startswith(f"{t}#")) for t in THRESHOLDS}
    print(f"events {counts} groups {gcounts}; checked {checked} values; mismatches {len(errors)}")
    for line in errors[:40]:
        print("  " + line)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
