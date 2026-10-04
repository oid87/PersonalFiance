#!/usr/bin/env python3
"""Portable, offline repository checks; never calls fetch/update commands."""
from __future__ import annotations

import argparse
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-js", action="store_true")
    parser.add_argument("--js-only", action="store_true")
    args = parser.parse_args()
    checks = [] if args.js_only else [([sys.executable, "scripts/check_pipeline.py"], "manifest"),
              ([sys.executable, "-m", "unittest", "discover", "-s", "scripts/tests"], "python tests")]
    if not args.skip_js:
        sources = sorted(str(p.relative_to(ROOT)) for p in (ROOT / "js").rglob("*")
                         if p.is_file() and p.suffix in {".js", ".mjs"})
        checks.extend((["node", "--check", source], f"javascript syntax: {source}")
                      for source in sources)
        tests = sorted(str(p.relative_to(ROOT)) for p in (ROOT / "js").rglob("*.test.mjs"))
        if tests:
            checks.append((["node", "--test", *tests], "javascript tests"))
    for command, label in checks:
        print(f"Running {label}...", flush=True)
        if subprocess.run(command, cwd=ROOT, check=False).returncode:
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
