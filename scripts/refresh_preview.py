#!/usr/bin/env python3
"""Safe local preview refresh entry point."""
from __future__ import annotations

from pathlib import Path
import subprocess
import sys

SCRIPT = Path(__file__).with_name("update_all.sh")
if __name__ == "__main__":
    raise SystemExit(subprocess.call(["bash", str(SCRIPT), *sys.argv[1:]]))
