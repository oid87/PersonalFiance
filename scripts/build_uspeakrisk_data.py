"""美股高檔風險研究頁（#tab=uspeakrisk）的公開資料：從已結案的研究資料夾彙總成 data/uspeakrisk.json。

公開白名單：只讀 SOURCES 列出的研究彙總 CSV，只輸出下方明確挑選的欄位。
不讀、不輸出任何原始行情（研究的 data/index、data/prices 都不碰），不含本機路徑。
研究已結案（P1 最終版 2026-11-15）；本腳本不重算模型，只搬運與檢查數字。

用法：python3 scripts/build_uspeakrisk_data.py [研究資料夾]   預設 ../研究_美股高檔預警_2026-11-15
"""
import csv, hashlib, json, math, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data/uspeakrisk.json"
VERSION = "P1-final-2026-11-15"
DATA_END = "2026-11-13"

# 公開白名單（研究資料夾內的相對路徑）。改動需同步 docs/research/uspeakrisk_public_data.md。
SOURCES = {
    "lead_events": "out/p1v2/sox_lead_events_v2.csv",
    "lag_dist": "out/p1v2/sox_lag_distribution.csv",
    "fair": "out/p1v2/fair_compare.csv",
    "short": "out/p1v2/short.csv",
    "long": "out/p1v2/long.csv",
    "loco": "out/p1v2/loco_strict.csv",
    "event_level": "out/p1v3/event_level_EA.csv",
    "coverage": "out/coverage_yearly.csv",
}
TNAME = {"NDX": "ndx", "GSPC": "spx"}
CATS = {"SOX先": "sox_first", "同步": "sync", "目標先": "target_first", "沒跟": "no_follow"}


def rows(research, key):
    with open(research / SOURCES[key], newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def num(x, nd=4):
    if x in (None, "", "None", "nan"):
        return None
    v = float(x)
    return None if math.isnan(v) else round(v, nd)


def arr(x):
    if x in (None, "", "None"):
        return None
    return [round(float(v), 3) for v in json.loads(x)]


def frac(x):
    a, b = x.split("/")
    return [int(a), int(b)]


def build(research: Path) -> dict:
    out = {"version": VERSION, "data_end": DATA_END, "provenance": {}}
    for k, rel in SOURCES.items():
        out["provenance"][k] = {"file": rel, "sha256": hashlib.sha256((research / rel).read_bytes()).hexdigest()}

    # B. SOX 領先事件（分類與衍生布林值，不含價格）
    ev = []
    for r in rows(research, "lead_events"):
        if r["cat"] == "pending":
            continue
        ev.append({"t": TNAME[r["target"]], "d": r["sox_date"], "c": CATS[r["cat"]],
                   "lag": None if r["lag_first_target_break"] == "" else int(float(r["lag_first_target_break"])),
                   "pw": r["target_pre_weak"] == "True",
                   "hz": None if r["target_highzone"] == "" else r["target_highzone"] == "True",
                   "dd10": None if r["target_dd10_60d"] == "" else r["target_dd10_60d"] == "True",
                   "rec": None if r["sox_recover_10d"] == "" else r["sox_recover_10d"] == "True"})
    out["lead_events"] = ev
    out["lag_dist"] = {TNAME[r["target"]]: {"n": int(r["n_nonpending"]), "n_break": int(r["n_with_target_break_in_±40"]),
                                            "q": [num(r[c], 1) for c in ("q10", "q25", "q50", "q75", "q90")],
                                            "gt2": num(r["share_lag_gt2"], 3), "lt_m2": num(r["share_lag_lt_m2"], 3), "abs_le2": num(r["share_abs_le2"], 3)}
                       for r in rows(research, "lag_dist")}
    fair = []
    for r in rows(research, "fair"):
        ci = [float(v) for v in re.findall(r"\d\.\d+", r["CI90_wilson"])]
        fair.append({"t": TNAME[r["target"]], "signal": "sox" if r["signal"].startswith("SOX") else "self",
                     "pop": "highzone" if "高檔" in r["population"] else "all", "from": r["period_from"],
                     "n": int(r["n"]), "hits": int(r["hits"]), "non_crisis": int(r["non_crisis"]), "pending": int(r["pending"]),
                     "rate": num(r["hit_rate"], 3), "ci90": ci})
    out["fair"] = fair

    # D. 模型比較：AUC/Brier 來自 p1v2（與最終版相同），事件層級與危機區塊 CI 以 p1v3 EA 為準
    ea = {(r["target"], r["extra"], r["h"], r["k"]): r for r in rows(research, "event_level")}
    models = []
    for grp in ("short", "long"):
        for r in rows(research, grp):
            key = (r["target"], r["extra"], r["h"], r["k"])
            m = {"t": TNAME[r["target"]], "x": r["extra"].lower(), "h": int(r["h"]), "k": float(r["k"]), "grp": grp,
                 "oos_from": int(r["oos_from"])}
            if r.get("AUC_M0") in ("", None):
                m["note"] = "正例不足，未計算"
                models.append(m); continue
            e = ea[key]
            m.update({"auc0": num(r["AUC_M0"]), "auc1": num(r["AUC_M1"]), "dauc": num(r["dAUC"]),
                      "brier0": num(r["Brier_M0"], 5), "brier1": num(r["Brier_M1"], 5), "bss": num(r["BSS_M1_vs_M0"]),
                      "n_days": int(float(r["n_days"])), "n_pos_days": int(float(r["n_pos_days"])),
                      "ci_year": arr(r["CI90_year_block"]), "ci_crisis": arr(e["CI90_crisis_block_EA"]),
                      "n_crisis": int(float(e["oos_EA_crisis"])), "n_events": int(float(e["oos_EA_events"])),
                      "rec0": frac(e["M0_event_recall"]), "rec1": frac(e["M1_event_recall"]),
                      "crec0": frac(e["M0_crisis_recall"]), "crec1": frac(e["M1_crisis_recall"]),
                      "lead0": arr(e["M0_lead_q25_50_75"]), "lead1": arr(e["M1_lead_q25_50_75"]),
                      "ci_note": e["note"] or ""})
            assert abs(float(e["dAUC"]) - float(r["dAUC"])) < 1e-9, key  # p1v2 與 p1v3 模型輸出必須一致
            models.append(m)
    out["models"] = models
    out["loco"] = [{"t": TNAME[r["target"]], "x": r["extra"].lower(), "h": int(r["h"]), "k": float(r["k"]), "drop": r["drop"],
                    "status": r["crisis_status"], "remain": int(r["remaining_crisis_clusters"]),
                    "dauc": num(r["dAUC"]), "bss": num(r["BSS"]), "note": r["note"] or ""} for r in rows(research, "loco")]

    # F. 資料完整性
    out["coverage"] = [{"y": int(r["date"]), "A": num(r["A"], 3), "B": num(r["B"], 3), "C": num(r["C"], 3), "Bx": num(r["B_exited"], 3)}
                       for r in rows(research, "coverage")]
    return out


def check_public(obj) -> None:
    """發布前檢查：不得含本機路徑、使用者名、憑證字樣。"""
    s = json.dumps(obj, ensure_ascii=False)
    for bad in ("/Users/", "/Volumes/", "C:\\", "token", "api_key", "apikey", "password", "secret"):
        assert bad.lower() not in s.lower(), f"public data contains {bad!r}"


def main() -> int:
    research = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT.parent / "研究_美股高檔預警_2026-11-15"
    obj = build(research.resolve())
    check_public(obj)
    OUT.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size} bytes, {len(obj['lead_events'])} events, {len(obj['models'])} model rows)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
