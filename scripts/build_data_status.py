"""產生 data/data_status.json：#tab=breadthwarn 各資料來源的最新日期與更新狀態（邏輯見 scripts/_data_status.py）。
只讀 repo 裡已經存在的資料檔，不連網。排程每個 job 在資料驗證前執行；--check 只印結果不寫檔（監測用）。
環境變數 STEP_LOG：scripts/run_step.py 寫的每支腳本執行結果（JSON lines），沒有就當作不知道。
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import _data_status as ds

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = DATA / "data_status.json"


def last_date(dates: list, values: list) -> str | None:
    """欄位式資料：最後一個有值的位置對應的日期。"""
    for d, v in zip(reversed(dates), reversed(values)):
        if v is not None:
            return d
    return None


def collect(data: Path = DATA) -> tuple[dict, list[str], list[str]]:
    """回傳（各來源最新日期, 已知交易日, 盤中統計滾動區間的日子）。讀不到的檔案該來源回 None。"""
    latest, cal, intraday = {}, set(), []

    def load(name):
        try:
            return json.loads((data / name).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
    p = load("panic_entry.json")
    if p:
        latest["twii"] = last_date(p["date"], p["tw_c"])
        latest["etf"] = min(filter(None, [last_date(p["date"], p["e50_c"]), last_date(p["date"], p["lev_c"])]), default=None)
    b = load("tw_breadth_warn.json")
    if b:
        for key, grp, col in (("tw50", "tw50", "a200"), ("twse", "twse", "a200"), ("tpex", "tpex", "a200"), ("ld", "twse", "ld")):
            latest[key] = last_date(b["date"], b[grp][col])
        latest["margin"] = last_date(b["date"], b.get("mg", {}).get("bal", []))
        cal |= {d for d in b["date"][-90:] if d <= (latest["twse"] or "")}
    i = load("tw_intraday.json")
    if i:
        pinned = set(i.get("pinned", []))
        days = sorted(i.get("days", {}))
        latest["intraday"] = days[-1] if days else None
        intraday = [d for d in days if d not in pinned][-40:]
        if intraday:      # pinned 裡屬於最近區間的日子也算已取得
            intraday = [d for d in days if d >= intraday[0]]
    return latest, sorted(cal), intraday


def read_steps(path: str | None) -> dict:
    steps = {}
    if path and Path(path).exists():
        for line in Path(path).read_text(encoding="utf-8").splitlines():
            try:
                r = json.loads(line)
                steps[r["script"]] = r
            except (ValueError, KeyError):
                continue
    return steps


def build(now: datetime | None = None, data: Path = DATA, steps: dict | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    try:
        prev = json.loads((data / "data_status.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        prev = {}
    latest, cal, intraday = collect(data)
    doc = ds.evaluate(latest, now, steps=steps, prev=prev, intraday_days=intraday, calendar=cal)
    run = os.environ.get("GITHUB_RUN_ID")
    doc["run"] = {"id": run, "url": f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/{os.environ.get('GITHUB_REPOSITORY', '')}/actions/runs/{run}",
                  "job": os.environ.get("GITHUB_JOB")} if run else None
    doc["note"] = "各來源狀態是排程執行當下判斷的；頁面會另外用現在時間檢查這份檔案本身是不是太久沒更新。"
    return doc


def main() -> None:
    doc = build(steps=read_steps(os.environ.get("STEP_LOG")))
    for r in doc["rows"]:
        print(f"  {r['state']:8s} {r['name']}  最新 {r['latest']}  落後 {r['lag']}  {r['cause'] or ''} {('缺 ' + ','.join(r['gaps'])) if r['gaps'] else ''}")
    if "--check" in sys.argv:
        return
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=1, allow_nan=False) + "\n", encoding="utf-8")
    print(f"data_status: {len(doc['alerts'])} 項需要處理 → {OUT.name}")


if __name__ == "__main__":
    main()
