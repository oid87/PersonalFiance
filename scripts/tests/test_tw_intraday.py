"""盤中監測純計算與盤後回放合併的離線測試（不連網；報價全是假資料）。"""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import _tw_intraday as ti  # noqa: E402
import fetch_tw_intraday as F  # noqa: E402


def fake_rows(scale=1.0, drop=0.0, step=5, skip=()):
    """每 step 秒一筆的假委託統計與指數；skip 內的分鐘整分鐘不給。"""
    o, ix = [], []
    for sec in range(0, 270 * 60 + 1, step):
        m = sec // 60
        if m in skip:
            continue
        t = f"{9 + m // 60:02d}:{m % 60:02d}:{sec % 60:02d}"
        k = (sec + 60) * scale
        o.append([t, f"{int(k):,}", f"{int(k * 10):,}", f"{int(k):,}", f"{int(k * 6):,}", f"{int(k / 2):,}", f"{int(k * 3):,}", f"{int(k * 2):,}"])
        ix.append([t, f"{20000 * (1 + drop * sec / 16200):,.2f}"])
    return o, ix


class Minutes(unittest.TestCase):
    def test_takes_last_value_within_each_minute_and_never_fills_gaps(self):
        o, ix = fake_rows(skip={100, 101})
        day = ti.build_day(o, ix, 20000)
        self.assertEqual(len(day["r"]), 271)
        self.assertIsNone(day["r"][100]); self.assertIsNone(day["bq"][101])
        self.assertIsNotNone(day["r"][99]); self.assertIsNotNone(day["r"][102])
        self.assertEqual(day["bq"][0], round((55 + 60) * 10 / 1000))      # 09:00:55 那一筆
        self.assertEqual(day["r"][270], 0.0)

    def test_old_one_minute_format_and_bad_input(self):
        o, ix = fake_rows(step=60)
        o = [[r[0][:5]] + r[1:] for r in o]; ix = [[r[0][:5], r[1]] for r in ix]
        self.assertEqual(sum(v is not None for v in ti.build_day(o, ix, 20000)["r"]), 271)
        self.assertIsNone(ti.build_day(o[:50], ix[:50], 20000))
        self.assertIsNone(ti.build_day(o, ix, None))
        self.assertEqual(ti.minute_of("133000"), 270); self.assertIsNone(ti.minute_of("x"))

    def test_indicators_and_summary(self):
        o, ix = fake_rows(drop=-0.04)
        day = ti.build_day(o, ix, 20000)
        prior = [ti.with_cimb(ti.build_day(*fake_rows(scale=2.0), 20000)) for _ in range(5)]
        for k, b in (("tv", "vb"), ("bq", "bb"), ("cimb", "cb")):
            day[b] = ti.baseline(prior, k)
        ind = ti.indicators(day)
        self.assertAlmostEqual(ind["cimb"][200], -25.0, places=0)        # (6−10)/(6+10)
        self.assertAlmostEqual(ind["bp"][200], 0.5, places=1)            # 今天是基準的一半
        self.assertAlmostEqual(ind["cdev"][200], 0.0, places=0)
        s = ti.summary(day)
        self.assertIn(s["low_t"], ("13:29", "13:30")); self.assertAlmostEqual(s["low"], -4.0, places=1)
        self.assertIsNotNone(s["t2"]); self.assertIsNone(s["t5"]); self.assertEqual(s["missing"], 0)
        self.assertIn("bp70", ti.flags({"bp": ind["bp"][200]}))

    def test_baseline_needs_five_days(self):
        d = ti.build_day(*fake_rows(), 20000)
        self.assertIsNone(ti.baseline([d] * 4, "tv"))
        self.assertEqual(len(ti.baseline([d] * 5, "tv")), 271)


class Snapshot(unittest.TestCase):
    Q = {
        "A": {"y": 100, "w": 90, "px": 90, "bid": None, "ask": 90, "askv": 500, "low": 90},    # 鎖跌停、沒有買單
        "B": {"y": 100, "w": 90, "px": 90, "bid": 90, "ask": 90.5, "askv": 5, "low": 90},      # 成交在跌停價但有買單
        "C": {"y": 100, "w": 90, "px": 91.5, "bid": 91, "ask": 91.5, "askv": 5, "low": 91},    # 接近跌停
        "D": {"y": 100, "w": 90, "px": 95, "bid": 95, "ask": 95.5, "askv": 5, "low": 90},      # 碰過跌停又打開
        "E": {"y": 50, "w": 45, "px": 51, "bid": 51, "ask": 51.5, "askv": 5, "low": 50},       # 上漲
        "F": {"y": 50, "w": 45, "px": None, "bid": 49, "ask": 50, "askv": 5, "low": None},     # 今天還沒成交
        "G": {"y": None, "w": None, "px": 10},                                                 # 沒有參考價，不算
    }

    def test_classification(self):
        a = ti.aggregate(self.Q, margin={"A": 1000, "E": 1000, "F": 500}, tw50={"A", "E"})
        self.assertEqual((a["n"], a["ld"], a["lock"], a["near"], a["touched"], a["reopen"], a["no_px"]), (6, 2, 1, 1, 3, 1, 1))
        self.assertEqual(a["queue"], 500)
        self.assertAlmostEqual(a["lock_pct"], 16.67, places=2)
        self.assertEqual((a["tw50_n"], a["tw50_adv_pct"], a["tw50_dec_pct"]), (2, 50.0, 50.0))
        # 融資加權：A 權重 1000×100、E 權重 1000×50；F 沒有成交價不算
        self.assertAlmostEqual(a["mw_ret"], round((100000 * -10 + 50000 * 2) / 150000, 2))
        self.assertAlmostEqual(a["mw_lock_pct"], 66.67, places=2)
        self.assertEqual(ti.aggregate({}), {"n": 0})

    def test_flags_use_fixed_thresholds_and_ignore_missing(self):
        self.assertEqual(ti.flags({"ld_pct": 3.0, "lock_pct": 1.99, "mw_ret": None}), ["ld3"])
        self.assertEqual(ti.flags({}), [])
        self.assertEqual(set(ti.LIVE_RULES), {"ld3", "lock2", "mw5", "bp70"})   # 改門檻要換 VERSION，這裡會提醒
        self.assertEqual(ti.VERSION, "live-v1")


class Merge(unittest.TestCase):
    def setUp(self):
        self.tw = [{"date": f"2026-01-{d:02d}", "close": 20000.0} for d in range(1, 11)]
        self.calls = []

    def fetch(self, kind, d):
        self.calls.append((kind, d))
        o, ix = fake_rows()
        return o if kind == "m5" else ix

    def test_adds_only_missing_days_and_never_overwrites(self):
        doc = {"days": {"2026-01-09": {"r": ["KEEP"], "sum": {}}}, "pinned": ["2020-03-19"]}
        doc["days"]["2020-03-19"] = {"r": ["PIN"]}
        added = F.merge(doc, self.tw, fetch=self.fetch, limit=3)
        self.assertEqual(added, ["2026-01-08", "2026-01-10"])
        self.assertEqual(self.calls, [("m5", "2026-01-08"), ("m5i", "2026-01-08"), ("m5", "2026-01-10"), ("m5i", "2026-01-10")])
        self.assertEqual(doc["days"]["2026-01-09"]["r"], ["KEEP"])
        self.assertEqual(doc["days"]["2020-03-19"]["r"], ["PIN"])
        self.assertEqual(doc["days"]["2026-01-10"]["sum"]["recon"], 0.0)
        self.assertEqual(F.merge(doc, self.tw, fetch=self.fetch, limit=3), [])      # 再跑一次不重抓
        json.dumps(doc, allow_nan=False)

    def test_incomplete_day_is_skipped_and_old_days_trimmed(self):
        doc = {"days": {}, "pinned": []}
        added = F.merge(doc, self.tw, fetch=lambda k, d: [] if d.endswith("10") else self.fetch(k, d), limit=9)
        self.assertNotIn("2026-01-10", added); self.assertEqual(len(added), 8)
        old = F.KEEP
        try:
            F.KEEP = 3
            F.merge(doc, self.tw, fetch=lambda k, d: [], limit=1)
            self.assertEqual(list(doc["days"]), ["2026-01-07", "2026-01-08", "2026-01-09"])
        finally:
            F.KEEP = old


class PublishedFile(unittest.TestCase):
    def test_public_file_has_no_per_stock_quotes_and_is_consistent(self):
        p = Path(__file__).resolve().parent.parent.parent / "data" / "tw_intraday.json"
        doc = json.loads(p.read_text(encoding="utf-8"))
        self.assertTrue(doc["days"])
        self.assertEqual(doc.get("kind"), "post_close")
        self.assertEqual(list(doc["days"]), sorted(set(doc["days"])))
        for d, x in doc["days"].items():
            self.assertLessEqual(set(x), {"r", "bq", "sq", "tq", "tv", "vb", "bb", "cb", "sum", "tf"}, d)
            # 取得時間一定在那一天收盤之後：盤後公布的資料不可能在盤中就有
            self.assertGreater(x["tf"], f"{d}T05:30:00", d)
            self.assertEqual(len(x["r"]), 271, d)
            self.assertLess(abs(x["sum"].get("recon") or 0), 0.2, d)
            self.assertTrue(all(v is None or abs(v) <= 11 for v in x["r"]), d)


class V31(unittest.TestCase):
    """V3.1 補的資料品質與方法測試。"""

    def test_rows_out_of_order_or_duplicated_still_take_the_latest_in_each_minute(self):
        o, ix = fake_rows()
        a = ti.build_day(o, ix, 20000)
        b = ti.build_day(list(reversed(o)) + o[:50], list(reversed(ix)) + ix[:50] + [["??", "1"], []], 20000)
        self.assertEqual(a, b)

    def test_missing_minutes_are_none_not_zero_everywhere(self):
        o, ix = fake_rows(skip=set(range(120, 130)))
        day = ti.build_day(o, ix, 20000)
        for k in ("r", "bq", "sq", "tq", "tv"):
            self.assertTrue(all(day[k][m] is None for m in range(120, 130)), k)
        ind = ti.indicators(day)
        self.assertTrue(all(ind["cimb"][m] is None and ind["fill"][m] is None for m in range(120, 130)))
        self.assertEqual(ti.summary(day)["missing"], 10)

    def test_fixed_horizon_needs_the_full_window(self):
        r = [0.0] * 271
        r[200] = -3.0
        self.assertEqual(ti.future_min(r, 150, 60), -3.0)
        self.assertEqual(ti.future_min(r, 150, 120), -3.0)       # 150+120=270，剛好完整
        self.assertIsNone(ti.future_min(r, 151, 120))            # 超過收盤一分鐘就不算
        self.assertIsNone(ti.future_min(r, 225, 60))
        self.assertEqual(ti.future_min(r, 210, 60), 0.0)
        self.assertEqual(ti.future_min(r, 190, None), -3.0)      # 「到收盤」是另一個目標
        # V3 的檢查時點（09:15–13:00 每 15 分鐘）：60 分鐘有 2 個、120 分鐘有 6 個不完整
        pts = range(15, 241, 15)
        self.assertEqual([sum(ti.future_min(r, m, h) is None for m in pts) for h in (15, 30, 60, 120)], [0, 0, 2, 6])

    def test_fixed_horizon_rejects_gappy_windows_and_missing_start(self):
        r = [0.0] * 271
        for m in range(101, 108):
            r[m] = None                                           # 60 分鐘裡缺 7 分鐘 > 一成
        self.assertIsNone(ti.future_min(r, 100, 60))
        self.assertIsNotNone(ti.future_min(r, 100, 120))          # 120 分鐘裡缺 7 分鐘 < 一成
        r[50] = None
        self.assertIsNone(ti.future_min(r, 50, 15))

    def test_baseline_never_uses_the_day_itself_or_later_days(self):
        tw = [f"2026-01-{d:02d}" for d in range(1, 11)]
        mk = lambda sc: ti.build_day(*fake_rows(scale=sc), 20000)
        days = {d: mk(1.0) for d in tw}
        F.add_baselines(days, tw, "2026-01-07")
        before = list(days["2026-01-07"]["bb"])
        for d in ("2026-01-07", "2026-01-08", "2026-01-09", "2026-01-10"):
            days[d].update({k: v for k, v in mk(9.0).items()})
        F.add_baselines(days, tw, "2026-01-07")
        self.assertEqual(days["2026-01-07"]["bb"], before)        # 當天與之後的日子怎麼變，基準都不變
        days["2026-01-03"].update(mk(9.0)); days["2026-01-04"].update(mk(9.0)); days["2026-01-05"].update(mk(9.0)); days["2026-01-06"].update(mk(9.0))
        F.add_baselines(days, tw, "2026-01-07")
        self.assertNotEqual(days["2026-01-07"]["bb"], before)

    def test_recon_is_in_percentage_points_of_daily_change(self):
        tw = [{"date": "2026-01-01", "close": 20000.0}, {"date": "2026-01-02", "close": 19600.0}]
        doc = {"days": {}, "pinned": []}
        o, ix = fake_rows(drop=-0.03)                              # 盤中最後一筆 −3%，官方收盤 −2%
        F.merge(doc, tw, fetch=lambda k, d: o if k == "m5" else ix, limit=1)
        self.assertAlmostEqual(doc["days"]["2026-01-02"]["sum"]["recon"], -1.0, places=2)

    def test_day_not_yet_closed_is_not_written_and_fetch_time_is_recorded(self):
        from datetime import datetime, timezone
        tw = [{"date": "2026-01-01", "close": 20000.0}, {"date": "2026-01-02", "close": 20000.0}]
        f = lambda k, d: fake_rows()[0 if k == "m5" else 1]
        doc = {"days": {}, "pinned": []}
        self.assertEqual(F.merge(doc, tw, fetch=f, limit=1, now=datetime(2026, 1, 2, 3, 0, tzinfo=timezone.utc)), [])   # 臺北 11:00
        self.assertEqual(F.merge(doc, tw, fetch=f, limit=1, now=datetime(2026, 1, 2, 10, 0, tzinfo=timezone.utc)), ["2026-01-02"])
        self.assertEqual(doc["days"]["2026-01-02"]["tf"], "2026-01-02T10:00:00Z")

    def test_open_data_csv_is_parsed_and_wrong_date_is_rejected(self):
        csv_text = '\ufeff時間,累積委託買進筆數,累積委託買進數量,累積委託賣出筆數,累積委託賣出數量,累積成交筆數,累積成交數量,累積成交金額\r\n"090000","480117","6521428","437563","1771948","","",""\r\n"133000","35900401","28673673","37133946","17295071","3292405","13491883","1013293"\r\n'
        disp = 'attachment; filename="MI_5MINS_20261112.csv"'
        rows = F.parse_open_data(csv_text, disp, "2026-11-12")
        self.assertEqual(len(rows), 2); self.assertEqual(rows[1][2], "28673673")
        cols = ti.to_minutes(rows, 7)
        self.assertEqual(cols[1][270], 28673673.0); self.assertIsNone(cols[5][0])      # 09:00 還沒有成交＝空值，不是 0
        self.assertEqual(F.parse_open_data(csv_text, disp, "2026-11-11"), [])          # 不是要的那一天就不寫
        self.assertEqual(F.parse_open_data(csv_text, "", "2026-11-12"), [])
        self.assertIn("open_data", F.URL["m5"]); self.assertEqual(F.BACKFILL, 1)

    def test_index_is_not_requested_when_order_stats_are_unavailable(self):
        tw = [{"date": "2026-01-01", "close": 20000.0}, {"date": "2026-01-02", "close": 20000.0}]
        calls = []
        F.merge({"days": {}, "pinned": []}, tw, fetch=lambda k, d: calls.append(k) or [], limit=1)
        self.assertEqual(calls, ["m5"])

    def test_public_replay_matches_research_panel_when_available(self):
        """網頁回放資料與研究面板（本機、不進 repo）同一天的序列必須一致；CI 上沒有研究面板就跳過。"""
        root = Path(__file__).resolve().parent.parent.parent
        pkl = root.parent / "研究_市場廣度預警_2026-11-12" / "data" / "intraday_1m.pkl"
        if not pkl.exists():
            self.skipTest("沒有本機研究面板")
        import pickle
        R = pickle.loads(pkl.read_bytes())
        doc = json.loads((root / "data" / "tw_intraday.json").read_text(encoding="utf-8"))
        both = [d for d in doc["days"] if d in R]
        self.assertGreaterEqual(len(both), 50)
        for d in both:
            for k in ("r", "bq", "sq", "tq", "tv"):
                self.assertEqual(doc["days"][d][k], R[d][k], (d, k))


if __name__ == "__main__":
    unittest.main()
