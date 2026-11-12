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

    def at(self, d):
        return lambda: (self.calls.append(d), (d, fake_rows()[0]))[1]

    NOW = None

    def test_day_comes_from_the_file_name_not_from_the_index_series(self):
        from datetime import datetime, timezone
        now = datetime(2026, 1, 20, tzinfo=timezone.utc)
        doc = {"days": {"2026-01-09": {"r": ["KEEP"], "sum": {}}, "2020-03-19": {"r": ["PIN"]}}, "pinned": ["2020-03-19"]}
        # 指數日線只到 01-10（Yahoo 落後），官方檔已經是 01-12：仍然要寫進 01-12
        self.assertEqual(F.merge(doc, self.tw, fetch=self.at("2026-01-12"), now=now), ["2026-01-12"])
        self.assertEqual(doc["days"]["2026-01-09"]["r"], ["KEEP"]); self.assertEqual(doc["days"]["2020-03-19"]["r"], ["PIN"])
        self.assertNotIn("r", doc["days"]["2026-01-12"])
        self.assertEqual(set(doc["days"]["2026-01-12"]["sum"]), {"bp_min", "bp_t", "cdev_max", "cdev_t", "vp", "missing"})
        before = json.dumps(doc, sort_keys=True)
        self.assertEqual(F.merge(doc, self.tw, fetch=self.at("2026-01-12"), now=now), [])      # 再跑一次不覆蓋
        self.assertEqual(F.merge(doc, self.tw, fetch=self.at("2026-01-08"), now=now), [])      # 比現有最新一天舊的不寫
        self.assertEqual(json.dumps(doc, sort_keys=True), before)
        json.dumps(doc, allow_nan=False)

    def test_incomplete_or_undated_download_raises_and_keeps_file(self):
        from datetime import datetime, timezone
        now = datetime(2026, 1, 20, tzinfo=timezone.utc)
        doc = {"days": {"2026-01-09": {"sum": {}}}, "pinned": []}
        before = json.dumps(doc, sort_keys=True)
        with self.assertRaises(ValueError):
            F.merge(doc, self.tw, fetch=lambda: ("2026-01-12", []), now=now)
        with self.assertRaises(ValueError):
            F.merge(doc, self.tw, fetch=lambda: (None, []), now=now)
        self.assertEqual(json.dumps(doc, sort_keys=True), before)

    def test_old_days_are_trimmed_but_pinned_stay(self):
        from datetime import datetime, timezone
        doc = {"days": {"2020-03-19": {"sum": {}}}, "pinned": ["2020-03-19"]}
        old = F.KEEP
        try:
            F.KEEP = 2
            for d in ("2026-01-07", "2026-01-08", "2026-01-09"):
                F.merge(doc, self.tw, fetch=self.at(d), now=datetime(2026, 1, 20, tzinfo=timezone.utc))
            self.assertEqual(list(doc["days"]), ["2020-03-19", "2026-01-08", "2026-01-09"])
        finally:
            F.KEEP = old

    def test_forward_log_is_append_only_and_starts_after_freeze(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as t:
            p = Path(t) / "f.json"
            self.assertFalse(F.log_forward(p, F.FROZEN, {"vp": 1.0}, "2026-11-12T09:00:00Z")); self.assertFalse(p.exists())
            self.assertTrue(F.log_forward(p, "2026-11-13", {"vp": 1.2}, "2026-11-13T10:00:00Z"))
            self.assertFalse(F.log_forward(p, "2026-11-13", {"vp": 9.9}, "2026-11-14T10:00:00Z"))      # 已寫入的不覆蓋
            self.assertTrue(F.log_forward(p, "2026-11-16", {"vp": 0.9}, "2026-11-16T10:00:00Z"))
            doc = json.loads(p.read_text(encoding="utf-8"))
            self.assertEqual([(r["date"], r["vp"], r["recorded"]) for r in doc["days"]],
                             [("2026-11-13", 1.2, "2026-11-13T10:00:00Z"), ("2026-11-16", 0.9, "2026-11-16T10:00:00Z")])
            self.assertEqual((doc["frozen"], doc["kind"]), (F.FROZEN, "post_close"))

    def test_public_flow_has_no_index_and_index_endpoint_is_gone(self):
        o, ix = fake_rows()
        day = ti.build_day(o)
        self.assertNotIn("r", day); self.assertEqual(len(day["bq"]), 271)
        self.assertEqual(set(ti.summary(day)), {"bp_min", "bp_t", "cdev_max", "cdev_t", "vp", "missing"})
        self.assertIn("r", ti.build_day(o, ix, 20000))            # 本機研究仍可帶指數
        self.assertEqual(set(F.URL), {"m5"}); self.assertFalse(hasattr(F, "get"))

    def test_day_not_yet_closed_is_not_written_and_fetch_time_is_recorded(self):
        from datetime import datetime, timezone
        tw = [{"date": "2026-01-01", "close": 20000.0}, {"date": "2026-01-02", "close": 20000.0}]
        f = lambda: ("2026-01-02", fake_rows()[0])
        doc = {"days": {}, "pinned": []}
        self.assertEqual(F.merge(doc, tw, fetch=f, now=datetime(2026, 1, 2, 3, 0, tzinfo=timezone.utc)), [])   # 臺北 11:00
        self.assertEqual(F.merge(doc, tw, fetch=f, now=datetime(2026, 1, 2, 10, 0, tzinfo=timezone.utc)), ["2026-01-02"])
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
        self.assertIn("open_data", F.URL["m5"]); self.assertEqual(F.file_day(disp), "2026-11-12")
        self.assertEqual(len(F.parse_open_data(csv_text, disp)), 2)

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
            for k in ("bq", "sq", "tq", "tv"):
                self.assertEqual(doc["days"][d][k], R[d][k], (d, k))


if __name__ == "__main__":
    unittest.main()
