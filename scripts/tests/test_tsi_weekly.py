"""TSI 逆向訊號：網站輸出與研究凍結結果逐筆一致、F2 續亮不增加 BUY_EVENT、未收盤週不產生訊號。"""
import csv
import json
import unittest
from datetime import date, datetime, timezone
from pathlib import Path

import sys

import pandas as pd

SCRIPTS = Path(__file__).resolve().parents[1]
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
import compute_tsi_weekly as T  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
FIX = Path(__file__).parent / "fixtures" / "tsi_research_signals_1999_2026.csv"
OUT = ROOT / "data" / "tsi_weekly.json"
B = lambda s: s == "True"


class ResearchParity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.site = {r["week"]: r for r in json.loads(OUT.read_text(encoding="utf-8"))["data"]}
        with FIX.open(encoding="utf-8") as f:
            cls.ref = list(csv.DictReader(f))

    def test_every_research_week_identical(self):
        self.assertEqual(len(self.ref), 1444)
        for r in self.ref:
            s = self.site[r["week"]]
            with self.subTest(week=r["week"]):
                self.assertEqual(s["purple"], B(r["PURPLE"]))
                self.assertEqual(s["buy"], B(r["BUY_EVENT"]))
                self.assertEqual(s["cont"], B(r["BUY_STATE_CONTINUATION_T25"]))
                self.assertEqual(s["sell"], B(r["SELL"]))
                self.assertEqual(s["cont_of"], r["continuation_of_event_week"])
                self.assertAlmostEqual(s["k"], float(r["stoch_k"]), delta=0.011)
                self.assertAlmostEqual(s["d"], float(r["stoch_d"]), delta=0.011)
                self.assertAlmostEqual(s["c"], float(r["close"]), delta=0.01)

    def test_counts_and_f2_does_not_add_buy_events(self):
        rows = list(self.site.values())
        buys = [r["week"] for r in rows if r["buy"]]
        self.assertEqual(len(buys), 49)
        self.assertFalse(any(r["buy"] and r["cont"] for r in rows))
        # F1 與 F2 的買進事件（首次買入）同一組；F2 只多 STATE
        f2_events = [r["week"] for r in rows if r["buy"]]
        self.assertEqual(buys, f2_events)
        self.assertEqual(sum(r["cont"] for r in rows), 26)

    def test_anchor_weeks(self):
        self.assertTrue(self.site["2026-11-09"]["purple"])
        self.assertEqual(self.site["2026-11-09"]["author"], "PROVISIONAL_MATCH")
        s = self.site["2026-10-12"]
        self.assertTrue(s["sell"])
        self.assertEqual(s["author_detail"]["sample"], "IN_SAMPLE")
        # 2026-10-06 短週期 Red Dot（10-05 週）不得變成週線訊號或可評分證據
        w = self.site["2026-10-05"]
        self.assertFalse(w["sell"] or w["purple"] or w["buy"])
        self.assertEqual(w["author"], "UNKNOWN")
        self.assertFalse(w["author_detail"]["eligible"])


class PendingWeek(unittest.TestCase):
    def _daily(self):
        days = pd.bdate_range("2024-01-01", "2024-12-13")
        c = 100 + (pd.Series(range(len(days))) % 40).values
        return pd.DataFrame({"date": days.strftime("%Y-%m-%d"), "open": c, "high": c + 1, "low": c - 1, "close": c})

    def test_unfinished_week_excluded(self):
        d = self._daily()
        thu = datetime(2024, 12, 12, 21, 0, tzinfo=timezone.utc)   # 週四收盤後，週五未收
        d = d[d.date <= "2024-12-12"]
        out = T.build(d, None, {}, thu)
        self.assertEqual(out["pending_week"], "2024-12-09")
        self.assertEqual(out["last_complete_week"], "2024-12-02")

    def test_friday_after_close_included(self):
        fri = datetime(2024, 12, 13, 21, 1, tzinfo=timezone.utc)   # 週五 16:01 ET
        out = T.build(self._daily(), None, {}, fri)
        self.assertEqual(out["last_complete_week"], "2024-12-09")
        self.assertIsNone(out["pending_week"])
        early = datetime(2024, 12, 13, 20, 0, tzinfo=timezone.utc)  # 週五 15:00 ET 盤中
        self.assertEqual(T.build(self._daily(), None, {}, early)["pending_week"], "2024-12-09")


class ProvisionalWeek(unittest.TestCase):
    """進行中週線（Intrabar Audit V1 對照）：2026-11-09 週，週四美東收盤後的暫時狀態。"""
    def test_current_week_matches_research_and_stays_out_of_history(self):
        fx = Path(__file__).parent / "fixtures" / "tsi_ndx_daily_2025_2026.csv"
        d = pd.read_csv(fx)
        thu = datetime(2026, 11, 12, 21, 30, tzinfo=timezone.utc)      # 週四 16:30 ET，週五未收
        hist = pd.read_csv(Path(__file__).parent / "fixtures" / "tsi_ndx_daily_1990_2024.csv")
        out = T.build(pd.concat([hist, d], ignore_index=True), None, {}, thu)
        cw = out["current_week"]
        self.assertEqual(cw["status"], "PROVISIONAL")
        self.assertEqual(cw["week"], "2026-11-09")
        self.assertEqual(cw["day_no"], 4)
        self.assertEqual(cw["first_seen"]["purple"], "2026-11-09")
        self.assertAlmostEqual(cw["steps"][2]["k"], 24.71, delta=0.01)   # 研究：D3 K 24.71
        self.assertTrue(all(s["purple"] for s in cw["steps"]))
        self.assertEqual(out["last_complete_week"], "2026-11-02")        # 未收盤週不進 data[]
        self.assertNotIn("2026-11-09", [r["week"] for r in out["data"]])


FX = Path(__file__).parent / "fixtures"
_DAILY = None


def daily(drop=(), until=None):
    global _DAILY
    if _DAILY is None:
        _DAILY = pd.concat([pd.read_csv(FX / "tsi_ndx_daily_1990_2024.csv"), pd.read_csv(FX / "tsi_ndx_daily_2025_2026.csv")],
                           ignore_index=True)
    d = _DAILY[~_DAILY.date.isin(drop)]
    return d[d.date <= until] if until else d


def utc(*a):
    return datetime(*a, tzinfo=timezone.utc)


def run(d, now, frm="2099"):          # frm：測試只算確認狀態時略過逐週重建，加速
    return T.build(d, None, {}, now, intrabar_from=frm)


class ConfirmationRules(unittest.TestCase):
    """P0：週線確認＝最後預期交易日正式收盤＋當週日線齊全；缺資料時 DATA_PENDING，不猜、不拿週四當週五。"""

    def test_01_friday_closed_but_yahoo_missing_friday(self):
        out = run(daily(until="2026-11-12"), utc(2026, 11, 13, 22, 0))          # 週五 17:00 ET
        cw = out["current_week"]
        self.assertEqual(cw["status"], "DATA_PENDING")
        self.assertEqual(cw["missing_days"], ["2026-11-13"])
        self.assertEqual(out["last_complete_week"], "2026-11-02")
        self.assertNotIn("2026-11-09", [r["week"] for r in out["data"]])

    def test_02_good_friday_confirms_thursday_close(self):
        d = daily(until="2026-04-02")
        out = run(d, utc(2026, 4, 2, 20, 30))                                  # 週四 16:30 EDT
        self.assertEqual(out["last_complete_week"], "2026-03-30")
        self.assertIsNone(out["current_week"])
        self.assertEqual(out["data"][-1]["confirm_utc"], "2026-04-02T20:00Z")
        self.assertEqual(out["data"][-1]["trading_days_in_week"], 4)
        early = run(d, utc(2026, 4, 2, 19, 30))                               # 15:30 EDT 盤中
        self.assertEqual(early["current_week"]["status"], "PROVISIONAL")
        self.assertEqual(early["current_week"]["day_no"], 3)                  # 盤中那筆不算

    def test_03_black_friday_early_close(self):
        d = daily(until="2025-11-28")
        out = run(d, utc(2025, 11, 28, 18, 5))                                 # 13:05 EST
        self.assertEqual(out["last_complete_week"], "2025-11-24")
        self.assertEqual(out["data"][-1]["confirm_utc"], "2025-11-28T18:00Z")
        before = run(d, utc(2025, 11, 28, 17, 55))                             # 12:55 EST
        self.assertEqual(before["current_week"]["status"], "PROVISIONAL")
        self.assertEqual(before["last_complete_week"], "2025-11-17")

    def test_04_wednesday_missing(self):
        out = run(daily(drop=["2026-11-11"]), utc(2026, 11, 14, 15, 0))
        self.assertEqual(out["current_week"]["status"], "DATA_PENDING")
        self.assertEqual(out["current_week"]["missing_days"], ["2026-11-11"])
        self.assertEqual(out["last_complete_week"], "2026-11-02")
        mid = run(daily(drop=["2026-11-11"], until="2026-11-12"), utc(2026, 11, 12, 22, 0))
        self.assertEqual(mid["current_week"]["status"], "PROVISIONAL")
        self.assertEqual(mid["current_week"]["missing_days"], ["2026-11-11"])

    def test_05_friday_late_then_filled_next_day(self):
        sat = utc(2026, 11, 14, 14, 0)
        late = run(daily(until="2026-11-12"), sat)
        self.assertEqual(late["current_week"]["status"], "DATA_PENDING")
        filled = run(daily(), sat)
        self.assertIsNone(filled["current_week"])
        self.assertEqual(filled["last_complete_week"], "2026-11-09")
        self.assertTrue(filled["data"][-1]["purple"])
        # 未齊的新資料不得覆蓋已確認的舊檔
        self.assertIsNotNone(T.refuse_overwrite(filled, late))
        self.assertIsNone(T.refuse_overwrite(late, filled))

    def test_mid_history_gap_stops(self):
        with self.assertRaises(RuntimeError):
            run(daily(drop=["2026-10-21"]), utc(2026, 11, 14, 15, 0))

    def test_calendar(self):
        self.assertEqual(T.expected_days(date(2026, 3, 30))[-1], "2026-04-02")
        self.assertEqual(T.close_hour(date(2025, 11, 28)), 13)
        self.assertEqual(T.close_hour(date(2026, 7, 3)), 16)          # 2026-07-03 是週五補假休市日，非提前收盤
        self.assertNotIn("2026-07-03", T.expected_days(date(2026, 6, 29)))


class IntrabarHistory(unittest.TestCase):
    """P1：正式歷史保留首次亮燈；與研究 intrabar_v1 final_signals_first_seen.csv 238 筆一致（另於驗收報告比對）。"""

    @classmethod
    def setUpClass(cls):
        cls.site = {r["week"]: r for r in json.loads(OUT.read_text(encoding="utf-8"))["data"]}

    def test_06_first_seen_kept_after_confirmation(self):
        ib = self.site["2026-11-09"]["intrabar"]["purple"]
        self.assertEqual((ib["first_provisional_date"], ib["first_provisional_day_no"]), ("2026-11-09", 1))
        self.assertEqual(ib["final_confirmation_date"], "2026-11-13")
        self.assertEqual(ib["first_provisional_status"], "PROVISIONAL_EARLY")
        g = self.site["2026-03-30"]["intrabar"]["buy"]
        self.assertEqual((g["first_provisional_date"], g["final_confirmation_date"]), ("2026-03-31", "2026-04-02"))
        self.assertEqual(self.site["2026-03-30"]["trading_days_in_week"], 4)

    def test_07_disappear_and_reappear(self):
        s = self.site["1999-07-26"]["intrabar"]["sell"]
        self.assertTrue(s["provisional_disappeared"] and s["provisional_reappeared"])
        self.assertEqual(s["number_of_signal_flips"], 2)
        self.assertTrue(s["final"])
        gone = self.site["2000-04-03"]["intrabar"]["sell"]                 # 亮過但最後沒成立
        self.assertFalse(gone["final"])
        self.assertIsNone(gone["final_confirmation_date"])

    def test_08_continuation_never_counts_as_buy_event(self):
        rows = list(self.site.values())
        self.assertEqual(sum(r["buy"] for r in rows), 49)
        for r in rows:
            ib = r["intrabar"] or {}
            if "cont" in ib and ib["cont"]["final"]:
                self.assertFalse(r["buy"], r["week"])
        self.assertEqual(sum(1 for r in rows if (r["intrabar"] or {}).get("buy", {}).get("final")), 49)



class DataIntegrityV12(unittest.TestCase):
    """V1.2：整週缺資料、日曆序號、資料日期停滯、原子寫入。"""

    def test_whole_week_missing_refused(self):
        wk = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]
        with self.assertRaisesRegex(RuntimeError, "整週"):
            run(daily(drop=wk), utc(2026, 11, 14, 15, 0))

    def test_week_count_drop_refused(self):
        full = run(daily(), utc(2026, 11, 14, 15, 0))
        short = dict(full, data=full["data"][:-200] + full["data"][-199:])   # 少一週、最後週不變
        self.assertIn("週數", T.refuse_overwrite(full, short))
        self.assertIsNone(T.refuse_overwrite(full, full))

    def test_first_day_missing_day_no_by_calendar(self):
        out = run(daily(drop=["2026-11-09"], until="2026-11-12"), utc(2026, 11, 12, 22, 0))
        cw = out["current_week"]
        self.assertEqual(cw["status"], "PROVISIONAL")
        self.assertEqual(cw["missing_days"], ["2026-11-09"])
        self.assertEqual(cw["day_no"], 4)
        self.assertTrue(cw["data_incomplete"])

    def test_middle_day_missing_day_no_by_calendar(self):
        cw = run(daily(drop=["2026-11-10"], until="2026-11-12"), utc(2026, 11, 12, 22, 0))["current_week"]
        self.assertEqual([s["day_no"] for s in cw["steps"]], [1, 3, 4])
        self.assertTrue(cw["data_incomplete"])
        ok = run(daily(until="2026-11-12"), utc(2026, 11, 12, 22, 0))["current_week"]
        self.assertFalse(ok["data_incomplete"])
        self.assertEqual(ok["day_no"], 4)

    def test_stale_data_date_detected(self):
        out = run(daily(until="2026-11-10"), utc(2026, 11, 14, 15, 0))     # 腳本週六還在跑，資料停在週二
        self.assertEqual(out["data_through"], "2026-11-10")
        self.assertEqual(out["expected_through"], "2026-11-13")
        self.assertEqual(out["data_lag_days"], 3)
        self.assertEqual(run(daily(), utc(2026, 11, 14, 15, 0))["data_lag_days"], 0)
        old = {"data": [], "data_through": "2026-11-13", "last_complete_week": "2026-11-09"}
        self.assertIn("倒退", T.refuse_overwrite(old, dict(old, data_through="2026-11-12")))

    def test_atomic_write_failure_keeps_old(self):
        import tempfile
        from unittest import mock
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "x.json"
            f.write_text("OLD", encoding="utf-8")
            with mock.patch("os.replace", side_effect=OSError("disk")):
                with self.assertRaises(OSError):
                    T.atomic_write(f, "NEW")
            self.assertEqual(f.read_text(encoding="utf-8"), "OLD")
            self.assertEqual(sorted(p.name for p in Path(d).iterdir()), ["x.json"])
            T.atomic_write(f, "NEW")
            self.assertEqual(f.read_text(encoding="utf-8"), "NEW")


if __name__ == "__main__":
    unittest.main()
