"""排程用：執行一支抓取腳本，把結果（結束碼、錯誤種類、最後一行訊息）附加到 $STEP_LOG，再以原本的結束碼結束。
用法：python scripts/run_step.py -- python scripts/fetch_tw_intraday.py（-- 後面是原本的指令）。輸出照常印出；不改變腳本行為。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import _data_status as ds


def main() -> int:
    cmd = sys.argv[sys.argv.index("--") + 1:]
    script = Path(cmd[-1]).name
    t0 = time.time()
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace")
    sys.stdout.write(p.stdout)
    tail = [x for x in p.stdout.strip().splitlines() if x.strip()][-15:]
    rec = {"script": script, "exit": p.returncode, "seconds": round(time.time() - t0, 1),
           "cause": ds.classify("\n".join(tail)) if p.returncode else None,
           "msg": (tail[-1][:200] if tail else "") if p.returncode else None}
    log = os.environ.get("STEP_LOG")
    if log:
        with open(log, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return p.returncode


if __name__ == "__main__":
    sys.exit(main())
