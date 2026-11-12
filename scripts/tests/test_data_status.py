"""資料更新狀態與警示（scripts/_data_status.py、build_data_status.py、data_alert.py、run_step.py）。離線。"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import _data_status as ds          # noqa: E402
import build_data_status as bs     # noqa: E402
import data_alert as da            # noqa: E402

KEYS = [s["key"] for s in ds.SOURCES]


def utc(s):
    return datetime.strptime(s, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)


def rows(doc):
    return {r["key"]: r for r in doc["rows"]}


class Evaluate(unittest.TestCase):
    def all(self, d, **over):
        return {**{k: d for k in KEYS}, **over}

    def test_all_current_is_ok_and_weekend_is_not_a_failure(self):
        doc = ds.evaluate(self.all("2026-11-13"), utc("2026-11-15 12:00"))        # 週日
        self.assertTrue(all(r["state"] == "ok" for r in doc["rows"])); self.assertEqual(doc["alerts"], [])

    def test_before_publish_time_is_ok_then_waiting_then_closed(self):
        lat = self.all("2026-11-12")
        self.assertEqual(rows(ds.evaluate(lat, utc("2026-11-13 05:00")))["margin"]["state"], "ok")       # 週五 13:00 臺北，還沒收盤
        self.assertEqual(rows(ds.evaluate(lat, utc("2026-11-13 14:00")))["margin"]["state"], "waiting")  # 22:00，剛過公布時間
        d = ds.evaluate(lat, utc("2026-11-16 23:00"))                                                     # 兩個平日都沒有任何來源有資料
        self.assertEqual(rows(d)["twse"]["state"], "closed"); self.assertEqual(d["alerts"], [])           # 可能是休市，不當成失敗
        d = ds.evaluate(lat, utc("2026-11-18 23:00"))                                                     # 連續 4 個平日 → 提醒（連假或排程停擺）
        self.assertTrue(d["alerts"]); self.assertEqual(d["alerts"][0]["state"], "closed")

    def test_behind_uses_other_sources_as_the_trading_calendar(self):
        now = utc("2026-11-13 23:00")
        d = ds.evaluate(self.all("2026-11-13", twii="2026-11-12", intraday="2026-11-12", tw50="2026-11-10"), now, calendar=["2026-11-10", "2026-11-11", "2026-11-12"])
        r = rows(d)
        self.assertEqual((r["tw50"]["state"], r["tw50"]["lag"], r["tw50"]["cause"]), ("behind", 3, "source"))
        self.assertEqual(r["twii"]["state"], "waiting")                 # 只差最新一天、公布不到 20 小時
        self.assertEqual(r["intraday"]["state"], "waiting")
        later = rows(ds.evaluate(self.all("2026-11-13", twii="2026-11-12", intraday="2026-11-12"), utc("2026-11-14 14:00")))
        self.assertEqual(later["twii"]["state"], "behind"); self.assertFalse(later["twii"]["alert"])       # Yahoo 常落後一天：列出但不警示
        self.assertTrue(later["intraday"]["alert"])                                                         # 不可回補：落後一天就警示

    def test_step_failure_sets_cause_and_workflow_success_is_not_enough(self):
        now = utc("2026-11-13 23:00")
        lat = self.all("2026-11-13", intraday="2026-11-12")
        steps = {"fetch_tw_intraday.py": {"exit": 1, "cause": "format", "msg": "下載點沒有回傳帶日期的檔名"}}
        r = rows(ds.evaluate(lat, now, steps=steps))["intraday"]
        self.assertEqual((r["state"], r["cause"], r["alert"]), ("failed", "format", True)); self.assertIn("檔名", r["msg"])
        ok = {"fetch_tw_intraday.py": {"exit": 0}}                      # 腳本正常結束但資料沒前進
        r = rows(ds.evaluate(lat, now, steps=ok))["intraday"]
        self.assertEqual((r["state"], r["cause"], r["alert"]), ("behind", "source", True))

    def test_classify(self):
        self.assertEqual(ds.classify("requests.exceptions.HTTPError: 503 Server Error for url: x"), "request")
        self.assertEqual(ds.classify("tw_intraday: 保留舊檔：2026-11-12: 資料不完整（3 列）"), "incomplete")
        self.assertEqual(ds.classify("KeyError: 'data'"), "format")
        self.assertEqual(ds.classify("tw_intraday: 保留舊檔：下載點沒有回傳帶日期的檔名（格式可能改了）"), "format")
        self.assertEqual(ds.classify("boom"), "script")

    def test_gaps_are_kept_forever_and_seen_time_only_moves_with_new_dates(self):
        now = utc("2026-11-12 10:00")
        days = ["2026-11-09", "2026-11-10", "2026-11-12"]
        cal = ["2026-09-15", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"]
        d1 = ds.evaluate(self.all("2026-11-12"), now, intraday_days=days, calendar=cal)
        self.assertEqual(rows(d1)["intraday"]["gaps"], ["2026-11-11"])            # 9 月是挑選的對照日，不算缺漏
        self.assertIsNone(rows(d1)["twse"]["seen"])                               # 第一份狀態檔：不知道何時取得，不亂填
        d2 = ds.evaluate(self.all("2026-11-12"), utc("2026-11-12 20:00"), prev=d1, intraday_days=["2026-11-12"], calendar=cal)
        self.assertEqual(rows(d2)["intraday"]["gaps"], ["2026-11-11"])            # 滾出視窗後缺漏紀錄仍在
        self.assertIsNone(rows(d2)["twse"]["seen"])                               # 日期沒變，取得時間不動
        d3 = ds.evaluate(self.all("2026-11-13"), utc("2026-11-13 12:00"), prev=d2)
        self.assertEqual(rows(d3)["twse"]["seen"], "2026-11-13T12:00:00Z")

    def test_signature_changes_only_when_the_problem_changes(self):
        a = [{"key": "twii", "state": "behind", "cause": "source", "latest": "2026-11-09"}]
        self.assertEqual(ds.signature(a), ds.signature([dict(a[0], lag=9)]))
        self.assertNotEqual(ds.signature(a), ds.signature([dict(a[0], latest="2026-11-10")]))


class Alert(unittest.TestCase):
    A = [{"key": "twii", "name": "指數", "state": "behind", "cause": "source", "latest": "2026-11-09", "expected": "2026-11-12", "lag": 3, "backfill": True, "msg": None}]

    def test_same_problem_does_not_comment_twice(self):
        now = utc("2026-11-12 10:00")
        self.assertEqual(da.plan(self.A, None), "create"); self.assertEqual(da.plan([], None), "none")
        issue = {"number": 1, "body": da.body(self.A, now, "https://x/run/1")}
        self.assertEqual(da.plan(self.A, issue), "touch")
        self.assertEqual(da.plan([dict(self.A[0], latest="2026-11-10")], issue), "update")
        self.assertEqual(da.plan([], issue), "close")
        b = da.body(self.A, now, "https://x/run/1")
        for want in ("指數", "2026-11-09", "2026-11-12", "落後 3 個交易日", "下一次排程自動重試", "https://x/run/1"):
            self.assertIn(want, b)

    def test_stalled_status_file_and_deploy_lag(self):
        doc = {"generated": "2026-11-09T14:00:00Z"}
        self.assertIsNone(da.stalled(doc, utc("2026-11-10 20:00")))               # 才少一次，可能只是延遲
        self.assertEqual(da.stalled(doc, utc("2026-11-12 02:00"))["state"], "stalled")
        self.assertIsNone(da.stalled({"generated": "2026-11-13T14:00:00Z"}, utc("2026-11-16 08:00")))   # 週末不算
        repo = {"generated": "2026-11-12T10:00:00Z"}
        self.assertIsNone(da.deploy_lag(repo, None, utc("2026-11-12 10:30")))     # 剛提交，部署還在跑
        self.assertIsNone(da.deploy_lag(repo, {"generated": "2026-11-12T10:00:00Z"}, utc("2026-11-12 12:00")))
        self.assertEqual(da.deploy_lag(repo, {"generated": "2026-11-11T10:00:00Z"}, utc("2026-11-12 12:00"))["state"], "deploy")
        self.assertEqual(da.deploy_lag(repo, None, utc("2026-11-12 12:00"))["state"], "deploy")


class Build(unittest.TestCase):
    def test_reads_real_files_without_network_and_is_json_safe(self):
        doc = bs.build(now=utc("2026-11-12 10:00"))
        self.assertEqual([r["key"] for r in doc["rows"]], KEYS)
        self.assertTrue(all(r["latest"] for r in doc["rows"]))
        json.dumps(doc, allow_nan=False)

    def test_missing_file_is_reported_not_crashed(self):
        with tempfile.TemporaryDirectory() as t:
            doc = bs.build(now=utc("2026-11-12 10:00"), data=Path(t))
            self.assertTrue(all(r["state"] == "failed" for r in doc["rows"])); self.assertEqual(len(doc["alerts"]), len(KEYS))

    def test_run_step_records_exit_code_and_cause(self):
        with tempfile.TemporaryDirectory() as t:
            bad = Path(t) / "fetch_x.py"; bad.write_text("raise SystemExit('x: 資料不完整（3 列）')\n", encoding="utf-8")
            log = Path(t) / "s.jsonl"
            r = subprocess.run([sys.executable, str(Path(__file__).resolve().parents[1] / "run_step.py"), "--", sys.executable, str(bad)],
                               env={**os.environ, "STEP_LOG": str(log)}, capture_output=True, text=True)
            self.assertEqual(r.returncode, 1)
            rec = bs.read_steps(str(log))["fetch_x.py"]
            self.assertEqual((rec["exit"], rec["cause"]), (1, "incomplete"))


class StocksGuard(unittest.TestCase):
    """波動率指數單日跳 40% 以上是真實行情，不能被「價格基準」檢查擋掉（2026-11-05 起 VIX 停更、連帶擋掉整批美股資料）。"""

    def test_volatility_index_jump_is_written_but_etf_jump_is_rejected(self):
        import pandas as pd
        import fetch_stocks as fs
        old = [{"date": "2026-11-04", "open": 16, "high": 17, "low": 16, "close": 16.61, "volume": 0}]
        new = pd.DataFrame([{"date": "2026-11-04", "open": 16, "high": 17, "low": 16, "close": 16.61, "volume": 0},
                            {"date": "2026-11-05", "open": 20, "high": 29, "low": 20, "close": 28.18, "volume": 0}])
        with tempfile.TemporaryDirectory() as t:
            keep = fs.DATA_DIR, fs.fetch_range
            try:
                fs.DATA_DIR, fs.fetch_range = Path(t), lambda ticker, start: new
                for stem in ("VIX", "SPY"):
                    (Path(t) / f"{stem}.json").write_text(json.dumps({"symbol": stem, "data": old}), encoding="utf-8")
                fs.update_ticker("^VIX", "VIX", "1990-01-02")
                self.assertEqual(json.loads((Path(t) / "VIX.json").read_text())["data"][-1]["close"], 28.18)
                with self.assertRaises(ValueError):
                    fs.update_ticker("SPY", "SPY", "1993-01-29")
            finally:
                fs.DATA_DIR, fs.fetch_range = keep


if __name__ == "__main__":
    unittest.main()
