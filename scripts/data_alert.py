"""資料更新警示：把需要處理的來源寫成一張 GitHub Issue（標籤 data-alert），維護者會收到 GitHub 的通知信。
同一組問題只開一張、只在內容改變時留言一次；全部恢復就自動關閉。沒有 gh 或沒有權限時只印出內容、以 0 結束（不假裝已通知）。
用法：
  python scripts/data_alert.py                      用 data/data_status.json 的內容（抓取排程結束時）
  python scripts/data_alert.py --monitor             用現在時間重算，並檢查狀態檔本身與正式站是不是停了（獨立監測排程）
  python scripts/data_alert.py --job-failed us       這個 job 失敗（資料驗證或提交沒過），加一項流程警示
  加 --dry-run 只印不送。
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import _data_status as ds
import build_data_status as bs

LABEL = "data-alert"
TITLE = "資料更新警示"
SITE = "https://personal-fiance-nine.vercel.app/data/data_status.json"
STATE_TEXT = {"behind": "落後", "failed": "抓取失敗", "closed": "連續多個平日沒有任何新資料（連假，或排程停擺）", "stalled": "狀態檔停止更新", "deploy": "正式站沒有跟上", "job": "更新流程失敗"}
CAUSE_TEXT = {"request": "請求失敗", "format": "資料格式改變", "incomplete": "資料不完整", "script": "腳本錯誤", "source": "腳本正常結束但沒有新資料（來源尚未更新或被略過）",
              "validation": "資料驗證或提交沒過，這一批資料沒有發布"}
RETRY = {"request": "會，下一次排程自動重試", "source": "會，下一次排程自動重試", "incomplete": "會，下一次排程自動重試",
         "format": "不會自己好，需要改程式", "script": "不會自己好，需要看紀錄", "validation": "不會自己好，需要看紀錄"}


def stalled(doc: dict, now: datetime) -> dict | None:
    """狀態檔產生之後，又過了至少一個平日的最晚公布時間再加 12 小時 → 排程沒跑或沒提交成功。"""
    gen = datetime.strptime(doc["generated"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    missed = [d for d in ds.pending_days(gen.astimezone(ds.TPE).date().isoformat(), now, "21:30")]
    hours = (now - gen).total_seconds() / 3600
    if hours >= 36 and len(missed) >= 2:
        return dict(key="_status", name="狀態檔 data_status.json", state="stalled", cause=None, latest=doc["generated"][:10],
                    expected=None, lag=len(missed), backfill=True, msg=f"已 {hours:.0f} 小時沒有更新")
    return None


def deploy_lag(repo_doc: dict, site_doc: dict | None, now: datetime) -> dict | None:
    """repo 的狀態檔已經超過 1 小時，正式站還是更舊的版本 → 部署沒跟上。讀不到正式站也算。"""
    gen = datetime.strptime(repo_doc["generated"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    if (now - gen).total_seconds() < 3600:
        return None
    if site_doc and site_doc.get("generated", "") >= repo_doc["generated"]:
        return None
    return dict(key="_deploy", name="正式站（Vercel）", state="deploy", cause=None, latest=(site_doc or {}).get("generated", "讀不到"),
                expected=repo_doc["generated"], lag=0, backfill=True, msg="repo 已有較新的資料，正式站還沒有")


def body(alerts: list[dict], now: datetime, run_url: str | None) -> str:
    lines = [f"<!-- sig:{ds.signature(alerts)} -->", f"最後檢查：{now.strftime('%Y-%m-%d %H:%M')} UTC", "",
             "| 資料來源 | 狀況 | 最新成功日期 | 應有日期 | 錯誤種類 | 會自動重試嗎 | 錯過能回補嗎 |", "|---|---|---|---|---|---|---|"]
    for a in alerts:
        st = STATE_TEXT.get(a["state"], a["state"]) + (f" {a['lag']} 個交易日" if a["state"] == "behind" else "")
        lines.append(f"| {a['name']} | {st} | {a.get('latest') or '—'} | {a.get('expected') or '—'} | {CAUSE_TEXT.get(a.get('cause'), '—')} | {RETRY.get(a.get('cause'), '—')} | {'可以' if a.get('backfill') else '**不行，當天沒抓到就永久缺漏**'} |")
    msgs = [f"- {a['name']}：{a['msg']}" for a in alerts if a.get("msg")]
    if msgs:
        lines += ["", "訊息：", *msgs]
    if run_url:
        lines += ["", f"執行紀錄：{run_url}"]
    lines += ["", "頁面上的狀態表：https://personal-fiance-nine.vercel.app/#tab=breadthwarn", "問題全部恢復後，這張 Issue 會自動關閉。"]
    return "\n".join(lines)


def gh(*args: str, check: bool = True) -> str:
    r = subprocess.run(["gh", *args], capture_output=True, text=True)
    if check and r.returncode:
        raise RuntimeError(r.stderr.strip()[:300])
    return r.stdout


def plan(alerts: list[dict], open_issue: dict | None) -> str:
    """要做什麼：create／update（內容變了，留言）／touch（沒變，只更新檢查時間，不留言）／close／none。"""
    if not alerts:
        return "close" if open_issue else "none"
    if not open_issue:
        return "create"
    m = re.search(r"<!-- sig:(.*?) -->", open_issue.get("body") or "")
    return "touch" if m and m.group(1) == ds.signature(alerts) else "update"


def main() -> int:
    now = datetime.now(timezone.utc)
    dry = "--dry-run" in sys.argv
    run = os.environ.get("GITHUB_RUN_ID")
    run_url = f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/{os.environ.get('GITHUB_REPOSITORY', '')}/actions/runs/{run}" if run else None
    if "--monitor" in sys.argv:
        stored = json.loads(bs.OUT.read_text(encoding="utf-8")) if bs.OUT.exists() else None
        alerts = bs.build(now=now)["alerts"]
        if stored:
            site = None
            try:
                import requests
                site = requests.get(SITE, timeout=30).json()
            except Exception as e:      # 正式站讀不到本身就是要回報的狀況
                print(f"正式站讀不到：{type(e).__name__}")
            alerts += [a for a in (stalled(stored, now), deploy_lag(stored, site, now)) if a]
    else:
        alerts = json.loads(bs.OUT.read_text(encoding="utf-8"))["alerts"] if bs.OUT.exists() else []
    if "--job-failed" in sys.argv:
        job = sys.argv[sys.argv.index("--job-failed") + 1]
        alerts.append(dict(key=f"_job_{job}", name=f"排程 {job}", state="job", cause="validation", latest=None, expected=now.strftime("%Y-%m-%d"), lag=0, backfill=True, msg=None))
    text = body(alerts, now, run_url)
    print(text if alerts else "沒有需要處理的項目")
    if dry:
        return 0
    try:
        gh("label", "create", LABEL, "--color", "D93F0B", "--description", "資料來源落後或更新失敗", "--force")
        found = json.loads(gh("issue", "list", "--label", LABEL, "--state", "open", "--json", "number,body", "--limit", "1"))
        issue = found[0] if found else None
        act = plan(alerts, issue)
        if act == "create":
            gh("issue", "create", "--title", TITLE, "--label", LABEL, "--body", text)
        elif act in ("update", "touch"):
            gh("issue", "edit", str(issue["number"]), "--body", text)
            if act == "update":
                gh("issue", "comment", str(issue["number"]), "--body", "狀況有變化，內容已更新（見上方表格）。")
        elif act == "close":
            gh("issue", "close", str(issue["number"]), "--comment", f"{now.strftime('%Y-%m-%d %H:%M')} UTC 檢查：全部恢復。")
        print(f"data_alert: {act}")
    except (RuntimeError, OSError, ValueError) as e:
        print(f"::warning::data_alert: 沒有送出通知（{e}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
