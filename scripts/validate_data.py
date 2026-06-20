#!/usr/bin/env python3
"""Data integrity guard — run AFTER fetches, BEFORE commit.

Catches the failure modes that have silently corrupted data before:
  1. Git conflict markers written into a JSON file (the 2026-06 55→1 row incident,
     where an unresolved rebase wrote `<<<<<<<` into QQQ_valuation.json and the next
     fetch's parse-fallback emptied it).
  2. Invalid JSON (parse failure).
  3. Catastrophic row-count collapse vs the committed version (>50% shrink).

Exits non-zero on any failure so the CI / update_all.sh commit step is skipped and
the corruption never reaches the repo.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"

CONFLICT_MARKERS = ("<<<<<<<", ">>>>>>>")  # unambiguous; never start a JSON line
SHRINK_RATIO = 0.5    # fail if new rows < 50% of committed rows
MIN_PREV_ROWS = 10    # only enforce the shrink check on files that had real data


def row_count(obj) -> int:
    if isinstance(obj, list):
        return len(obj)
    if isinstance(obj, dict):
        if isinstance(obj.get("data"), list):
            return len(obj["data"])
        return len(obj)
    return 0


def git_show_head(rel: str) -> str | None:
    """Committed version of a file, or None if it's new / not tracked."""
    try:
        return subprocess.run(
            ["git", "show", f"HEAD:{rel}"],
            cwd=ROOT, capture_output=True, text=True, check=True,
        ).stdout
    except subprocess.CalledProcessError:
        return None


def main() -> int:
    failures: list[str] = []
    files = sorted(DATA_DIR.glob("*.json"))

    for path in files:
        rel = f"data/{path.name}"
        raw = path.read_text()

        # 1. conflict markers (line-anchored)
        if any(ln.startswith(CONFLICT_MARKERS) for ln in raw.splitlines()):
            failures.append(f"{rel}: git conflict marker found")

        # 2. valid JSON
        try:
            obj = json.loads(raw)
        except Exception as exc:
            failures.append(f"{rel}: invalid JSON ({exc})")
            continue

        # 3. catastrophic shrink vs committed
        head = git_show_head(rel)
        if head is not None:
            try:
                prev_rows = row_count(json.loads(head))
            except Exception:
                prev_rows = 0
            new_rows = row_count(obj)
            if prev_rows >= MIN_PREV_ROWS and new_rows < prev_rows * SHRINK_RATIO:
                failures.append(
                    f"{rel}: row count collapsed {prev_rows} → {new_rows} "
                    f"(<{int(SHRINK_RATIO * 100)}% of committed)"
                )

    if failures:
        print("DATA VALIDATION FAILED — commit aborted:")
        for f in failures:
            print(f"  ✗ {f}")
        return 1

    print(f"Data validation passed ({len(files)} files).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
