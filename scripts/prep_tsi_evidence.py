"""TSI 作者證據匯入（手動）：把研究專案的 Ground Truth 與前瞻追蹤表轉成網站靜態檔 data/tsi_evidence.json。

用法：python scripts/prep_tsi_evidence.py <研究專案 v8 資料夾> [<intrabar_v1 資料夾>]
來源：evidence/author_signals_updated.csv（週線 Ground Truth）、v132/forward_tracking_F1_F2.csv（V1.3.2 Evidence Patch 最終版）。
只搬運研究結果，不推算、不補寫作者訊號。作者發新訊號時先更新研究專案的追蹤表，再重跑本檔。
"""
from __future__ import annotations

import csv
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "data" / "tsi_evidence.json"
GT_FIELDS = ["signal_id", "signal_date_week_start", "date_low", "date_high", "timeframe", "signal",
             "publication", "realtime_or_retro", "confidence", "evidence_grade"]


def read_csv(p: Path) -> list[dict]:
    with p.open(encoding="utf-8") as f:
        return list(csv.DictReader(f))


def main(src: Path, intrabar: Path | None = None) -> None:
    gt = [{k: r.get(k, "") for k in GT_FIELDS} for r in read_csv(src / "evidence/author_signals_updated.csv")]
    fw = read_csv(src / "v132/forward_tracking_F1_F2.csv")
    out = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "TSI 研究 V1.3.1 凍結公式＋V1.3.2 Evidence Patch",
        "ground_truth": gt,
        "forward_tracking": fw,
    }
    if intrabar:  # 週內暫時訊號的歷史確認率（Intrabar Timing Audit V1，1999–2026 日線）
        out["intrabar_confirm_rates"] = read_csv(intrabar / "results/stats_B_confirm_rate_given_lit.csv")
        out["intrabar_source"] = "TSI Weekly Intrabar Signal Timing Audit V1（日線逐日重建進行中週線，1999-03～2026-11）"
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {OUT} ground_truth={len(gt)} forward={len(fw)}")


if __name__ == "__main__":
    if len(sys.argv) not in (2, 3):
        sys.exit(__doc__)
    main(Path(sys.argv[1]), Path(sys.argv[2]) if len(sys.argv) == 3 else None)
