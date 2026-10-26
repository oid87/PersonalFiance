"""Compute 臺灣50 (0050) market breadth: % of stocks above 50-day and 200-day MA.

Output: data/breadth_tw50.json, data/tw50_members.json（現行成分股，參考用）
Strategy:
  - No existing file → full backfill (download ~7 years of history)
  - Stale existing   → incremental (download last 450 cal. days, recompute tail)
  - Fresh existing   → skip
Constituents: point-in-time from scripts/_tw50_history.py（現行名單＋每季異動倒推，逐日只計當時的成分股）。
  2026-10 以前曾抓中文維基百科的成分股權重表，但那張表停在 2025-09-30 的快照、卻被蓋上抓取日，
  造成名單過期一年；異動表才是最新的，所以改用 _tw50_history（每季審核後在那裡補一筆）。
"""
from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path

import _breadth
import _tw50_history

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
OUT_PATH = DATA_DIR / "breadth_tw50.json"

MIN_COVERAGE = 45    # ~90% of 50 TW50 constituents; drop RECENT days below this.
                      # yfinance hasn't filled all ~50 names yet → shrunk denominator spikes %).

TW50_MEMBERS_PATH = DATA_DIR / "tw50_members.json"   # 現行成分股（參考用，由 _tw50_history 產生）


def tw(codes) -> set[str]:
    return {f"{c}.TW" for c in codes}


def members_on(d_iso: str) -> set[str]:
    return tw(_tw50_history.members_on(d_iso))


def get_tw50_tickers() -> list[str]:
    """下載期間（最長 FULL_BACKFILL_CAL 天）內曾是臺灣50成分股的所有代號；順便寫出現行名單。"""
    today = date.today().isoformat()
    start = (date.today() - timedelta(days=_breadth.FULL_BACKFILL_CAL)).isoformat()
    codes = set(_tw50_history.members_on(start))
    for eff, members in _tw50_history.TIMELINE:
        if eff >= start:
            codes |= members
    current = sorted(tw(_tw50_history.members_on(today)))
    TW50_MEMBERS_PATH.write_text(json.dumps({"updated": today, "source": "scripts/_tw50_history.py", "tickers": current},
                                            ensure_ascii=False) + "\n")
    print(f"  臺灣50 current members {len(current)}; {len(codes)} names were members since {start}")
    return sorted(tw(codes))


if __name__ == "__main__":
    _breadth.run(
        get_tickers=get_tw50_tickers,
        out_path=OUT_PATH,
        min_coverage=MIN_COVERAGE,
        label="TW50",
        members_on=members_on,
    )
