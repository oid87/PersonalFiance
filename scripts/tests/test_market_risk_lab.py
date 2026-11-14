"""市場預警與策略回測：引擎單元測試（合成資料）＋可追溯的真實歷史案例（讀已提交 data/）。"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))

import _market_risk_lab as M  # noqa: E402

DATA = SCRIPTS.parent / "data"


def days(n, start=2000):
    # 合成交易日（只需遞增、唯一）
    return [f"{start + i // 300:04d}-{(i % 300) // 25 + 1:02d}-{i % 25 + 1:02d}" for i in range(n)]


class MovingAverageTests(unittest.TestCase):
    def test_sma_window_and_reset_on_none(self):
        self.assertEqual(M.sma([1, 2, 3, 4], 2), [None, 1.5, 2.5, 3.5])
        self.assertEqual(M.sma([1, None, 3, 4], 2), [None, None, None, 3.5])

    def test_ema_seeds_with_sma(self):
        out = M.ema([1, 2, 3, 4], 3)
        self.assertEqual(out[:3], [None, None, 2.0])
        self.assertAlmostEqual(out[3], 4 * 0.5 + 2.0 * 0.5)


class ResetTests(unittest.TestCase):
    def setUp(self):
        n = 400
        self.d = days(n)
        self.close = [100.0] * n
        self.low = [100.01] * n  # 合成：低點略高於 MA，只有指定日觸及

    def test_intraday_touch_uses_previous_day_ma_not_close(self):
        # MA300 = 100；第 350 天收盤 100（沒跌破），但盤中低點 99 → 觸及
        self.low[350] = 99.0
        ev, _, _ = M.detect_resets(self.d, self.low, self.close, ma_len=300)
        self.assertEqual([e["i"] for e in ev], [350])
        self.assertFalse(ev[0]["closed_below"])

    def test_unknown_low_is_not_a_touch(self):
        self.low[350] = None
        self.close[350] = 90.0  # 收盤跌破，但沒有盤中資料 → 不能用收盤冒充觸及
        ev, _, unknown = M.detect_resets(self.d, self.low, self.close, ma_len=300)
        self.assertEqual(ev, [])
        self.assertEqual(unknown, 1)

    def test_declustering_requires_rearm_days_above_ma(self):
        self.low[320] = 98.0
        self.low[330] = 98.0  # 同一段：中間沒有連續站上 → 不重複記
        self.close = [101.0 if 331 <= i < 395 else c for i, c in enumerate(self.close)]
        self.low = [100.99 if 331 <= i < 395 else x for i, x in enumerate(self.low)]
        self.low[396] = 90.0
        ev, _, _ = M.detect_resets(self.d, self.low, self.close, ma_len=300, rearm_days=60)
        self.assertEqual([e["i"] for e in ev], [320, 395])  # 394 重新武裝，395 回到 MA 下方即再觸及

    def test_reclaim_requires_break_first_and_one_per_reset(self):
        close = [100.0] * 50
        ma = [100.0] * 50
        close[10], close[11], close[12], close[13] = 99, 101, 98, 102
        ev = M.detect_reclaim_after(days(50), close, ma, [{"i": 5, "date": "x"}], need_break_ma=ma)
        self.assertEqual([e["i"] for e in ev], [11])


class BreakReclaimTests(unittest.TestCase):
    def test_break200_then_reclaim125(self):
        n = 30
        c = [100.0] * n
        b = [100.0] * n
        r = [95.0] * n
        c[5] = 99   # 跌破 200
        c[6] = 94   # 仍低於 125
        c[7] = 96   # 站回 125 → 訊號
        ev = M.detect_break_then_reclaim(days(n), c, b, r, "x", rearm_days=5)
        self.assertEqual([e["i"] for e in ev], [7])


class EventStudyTests(unittest.TestCase):
    def test_censored_events_marked_pending_and_excluded(self):
        n = 100
        d = days(n)
        c = [100.0 + i for i in range(n)]
        ev = [{"i": 10, "date": d[10]}, {"i": 95, "date": d[95]}]
        st = M.event_study(d, c, c, c, ev, horizons=(20,))
        self.assertEqual(st["events"][1]["h"]["20"], {"status": "pending"})
        self.assertEqual(st["all"]["20"]["n"], 1)
        self.assertEqual(st["all"]["20"]["pending"], 1)
        self.assertAlmostEqual(st["events"][0]["h"]["20"]["ret"], round(130 / 110 - 1, 4))

    def test_bootstrap_is_deterministic(self):
        vals = [0.1, -0.05, 0.02, 0.07, 0.03]
        self.assertEqual(M.bootstrap_ci(vals), M.bootstrap_ci(vals))
        self.assertIsNone(M.bootstrap_ci([0.1, 0.2]))


class NavTests(unittest.TestCase):
    def test_next_day_open_execution_fees_and_hold_exit(self):
        d = days(10)
        opn = [10, 10, 11, 12, 12, 12, 12, 12, 12, 12]
        close = [10, 10.5, 11.5, 12, 12, 12, 12, 12, 12, 12]
        res = M.nav_backtest(d, opn, close, [1.0] * 10, [{"date": d[1]}], initial=1000,
                             hold_days=3, fee_buy=0.01, fee_sell=0.0, slippage=0.0)
        buy = res["trades"][0]
        self.assertEqual(buy["date"], d[2])  # 訊號日 d1 收盤 → d2 開盤
        self.assertEqual(buy["price"], 11)
        sell = res["trades"][1]
        self.assertEqual(sell["date"], d[6])  # 持有滿 3 日（d5 收盤）→ d6 開盤
        units = 1000 * 0.99 / 11
        self.assertAlmostEqual(res["final_cash"], round(units * 12, 2), places=2)

    def test_uses_etf_prices_not_index_multiple(self):
        # 指數漲 10%，ETF 實際只漲 15%（非 2×10%=20%）→ NAV 必須跟 ETF 實價
        d = days(5)
        etf_open = [100, 100, 100, 115, 115]
        res = M.nav_backtest(d, etf_open, etf_open, [1.0] * 5, [{"date": d[0]}], initial=100,
                             hold_days=1, fee_buy=0, fee_sell=0, slippage=0)
        self.assertAlmostEqual(res["final_cash"], 115.0)

    def test_tranches_leave_cash(self):
        d = days(60)
        px = [10.0] * 60
        res = M.nav_backtest(d, px, px, [1.0] * 60, [{"date": d[0]}], initial=900, tranches=(1 / 3, 1 / 3, 1 / 3),
                             tranche_gap=21, hold_days=500, fee_buy=0, fee_sell=0, slippage=0)
        buys = [t for t in res["trades"] if t["side"] == "buy"]
        self.assertEqual([b["date"] for b in buys], [d[1], d[22], d[43]])
        self.assertAlmostEqual(sum(b["amount"] for b in buys), 900, places=2)

    def test_perf_stats_drawdown(self):
        st = M.perf_stats([["a", 100], ["b", 120], ["c", 60], ["d", 90]])
        self.assertAlmostEqual(st["max_drawdown"], -0.5)


class IndicatorTests(unittest.TestCase):
    def test_distribution_days(self):
        c = [100, 99, 99.5, 98]
        v = [10, 20, 5, 30]
        self.assertEqual(M.distribution_days(c, v, 3, window=25), 2)

    def test_lower_high(self):
        h = [10] * 63 + [20] * 10 + [15] * 21
        self.assertTrue(M.lower_high(h, len(h) - 1))


class BacktestSkipTests(unittest.TestCase):
    def test_skip_when_hash_and_version_unchanged(self):
        import backtest_market_risk_lab as B
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "bt.json"
            out.write_text(json.dumps({"input_hash": "h", "model_version": M.MODEL_VERSION, "full_input_hash": "h"}))
            with mock.patch.object(B, "OUT", out), mock.patch.object(B.C, "file_hash", return_value="h"):
                self.assertIsNone(B.run("full"))
                self.assertIsNone(B.run("daily"))
            with mock.patch.object(B, "OUT", out), mock.patch.object(B.C, "file_hash", return_value="new"), \
                    mock.patch.object(B.C, "build_markets", side_effect=RuntimeError("would rerun")):
                with self.assertRaises(RuntimeError):
                    B.run("daily")


@unittest.skipUnless((DATA / "QQQ.json").exists() and (DATA / "market_risk_lab_prices.json").exists()
                     and (DATA / "TWII.json").exists(), "需要已提交的行情資料")
class RealHistoryCases(unittest.TestCase):
    """可追溯案例：以 data/ 原始日 K 獨立重算（不經引擎）核對引擎輸出。"""

    @classmethod
    def setUpClass(cls):
        import compute_market_risk_lab as C
        cls.C = C
        cls.mk = C.build_markets()
        cls.ndx = C.market_events(cls.mk["US_NDX"], "SMA", 60)
        cls.tw = C.market_events(cls.mk["TW"], "SMA", 60)

    def _touch(self, name, d):
        rows = json.loads((DATA / name).read_text())["data"]
        ds = [r["date"] for r in rows]
        i = ds.index(d)
        ma = sum(r["close"] for r in rows[i - 300:i]) / 300
        return rows[i]["low"] <= ma

    def test_2018_q4_reset(self):
        dates = [e["date"] for e in self.ndx["reset300"]]
        self.assertIn("2018-10-26", dates)
        self.assertTrue(self._touch("QQQ.json", "2018-10-26"))
        # 2018-12-24 也觸及，但屬於同一段修正（去群聚）→ 不另記
        self.assertTrue(self._touch("QQQ.json", "2018-12-24"))
        self.assertNotIn("2018-12-24", dates)

    def test_2022_reset_and_bear_rally_reclaim(self):
        self.assertIn("2022-01-24", [e["date"] for e in self.ndx["reset300"]])
        self.assertTrue(self._touch("QQQ.json", "2022-01-24"))
        rec = [e for e in self.ndx["reclaim150_after_reset"] if e["from"] == "2022-01-24"]
        self.assertEqual(rec[0]["date"], "2022-08-12")  # 規則照定義會在熊市反彈中觸發（不改規則，回測照實呈現）
        self.assertIn("2022-03-08", [e["date"] for e in self.tw["reset300"]])

    def test_2026_resets_and_pending(self):
        dates = [e["date"] for e in self.ndx["reset300"]]
        self.assertIn("2026-03-27", dates)
        self.assertIn("2026-11-05", dates)
        st = M.event_study(self.mk["US_NDX"]["dates"], self.mk["US_NDX"]["close"], self.mk["US_NDX"]["low"],
                           self.mk["US_NDX"]["high"], self.ndx["reset300"], (252,))
        last = st["events"][-1]
        self.assertEqual(last["date"], "2026-11-05")
        self.assertEqual(last["h"]["252"]["status"], "pending")

    def test_00631l_signal_basis_is_taiwan_index_not_qqq(self):
        tw_dates = set(self.mk["TW"]["dates"])
        for e in self.tw["reclaim150_after_reset"]:
            self.assertIn(e["date"], tw_dates)
        self.assertNotEqual([e["date"] for e in self.tw["reset300"]], [e["date"] for e in self.ndx["reset300"]])


if __name__ == "__main__":
    unittest.main()
