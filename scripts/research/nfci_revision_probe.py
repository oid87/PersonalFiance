#!/usr/bin/env python3
"""用 git 歷史上不同時間點的 data/nfci.json 快照，量測 NFCI 被回頭重估的幅度（替代取不到的 ALFRED 歷史版本）。

只能涵蓋 repo 有該檔以來（約 2026-07 起）的版本；不是完整的 2020 以來逐期 vintage。
輸出 data/research/us_delever/nfci_revision_probe.json。
"""
import json
import statistics as st
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data" / "research" / "us_delever" / "nfci_revision_probe.json"


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True)


def snapshot(commit: str) -> dict:
    rows = json.loads(git("show", f"{commit}:data/nfci.json"))["data"]
    return {r["date"]: r for r in rows}


def main() -> None:
    commits = git("log", "--format=%h %ad", "--date=short", "--", "data/nfci.json").strip().splitlines()
    oldest, newest = commits[-1].split(), commits[0].split()
    old, new = snapshot(oldest[0]), snapshot(newest[0])
    common = sorted(d for d in old if d in new and d >= "2020-01-01")
    out = {"oldest_commit": oldest[0], "oldest_date": oldest[1], "newest_commit": newest[0], "newest_date": newest[1],
           "commits": len(commits), "common_weeks": len(common), "series": {}}
    for key, name in (("nfci", "NFCI"), ("risk", "NFCIRISK"), ("credit", "NFCICREDIT"), ("leverage", "NFCILEVERAGE")):
        level = [abs(old[d][key] - new[d][key]) for d in common]
        dchg_old = [old[common[i]][key] - old[common[i - 1]][key] for i in range(1, len(common))]
        dchg_new = [new[common[i]][key] - new[common[i - 1]][key] for i in range(1, len(common))]
        ddiff = [abs(a - b) for a, b in zip(dchg_old, dchg_new)]
        sd = st.pstdev(dchg_new)
        worst = max(range(len(level)), key=lambda i: level[i])
        out["series"][name] = {
            "level_mean_abs_revision": round(st.mean(level), 5), "level_max_abs_revision": round(max(level), 5), "level_max_week": common[worst],
            "level_revised_weeks": sum(1 for x in level if x > 1e-9),
            "weekly_change_mean_abs_revision": round(st.mean(ddiff), 5), "weekly_change_max_abs_revision": round(max(ddiff), 5),
            "weekly_change_std": round(sd, 5), "max_revision_in_std": round(max(ddiff) / sd, 2) if sd else None,
            "weeks_revision_over_half_std": sum(1 for x in ddiff if sd and x > 0.5 * sd),
        }
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n")
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
