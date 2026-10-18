import importlib.util
import sys
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))


def load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


foreign = load("fetch_tw_foreign_net")
breadth = load("fetch_tw_breadth_ls")


class ForeignNetTest(unittest.TestCase):
    def test_aggregate_sums_foreign_investor_and_foreign_dealer(self):
        raw = [
            {"date": "2026-10-12", "name": "Foreign_Investor", "buy": 300e8, "sell": 200e8},
            {"date": "2026-10-12", "name": "Foreign_Dealer_Self", "buy": 10e8, "sell": 5e8},
            {"date": "2026-10-12", "name": "Investment_Trust", "buy": 20e8, "sell": 10e8},
            {"date": "2026-10-12", "name": "Dealer_self", "buy": 5e8, "sell": 8e8},
            {"date": "2026-10-12", "name": "Dealer_Hedging", "buy": 30e8, "sell": 40e8},
            {"date": "2026-10-12", "name": "total", "buy": 365e8, "sell": 263e8},
            {"date": "2026-10-11", "name": "Foreign_Investor", "buy": 0, "sell": 0},  # 非交易日
        ]
        out = foreign.aggregate(raw)
        self.assertEqual(list(out), ["2026-10-12"])
        r = out["2026-10-12"]
        self.assertAlmostEqual(r["foreign_net_yi"], 105.0)
        self.assertAlmostEqual(r["trust_net_yi"], 10.0)
        self.assertAlmostEqual(r["dealer_net_yi"], -13.0)
        self.assertAlmostEqual(r["total_net_yi"], 102.0)


class BreadthTest(unittest.TestCase):
    def setUp(self):
        self.old_min = breadth.MIN_STOCKS
        breadth.MIN_STOCKS = 1

    def tearDown(self):
        breadth.MIN_STOCKS = self.old_min

    def test_count_day_classifies_bull_bear_neutral(self):
        up = [float(i) for i in range(1, 61)]            # close>MA20>MA60
        down = [float(i) for i in range(60, 0, -1)]       # close<MA20<MA60
        flat = [10.0] * 60                                # close==MA → 中性
        short = [None] * 10 + [5.0] * 50                  # 資料不足 → 不納入
        dates = [f"d{i:02d}" for i in range(60)]
        res = breadth.count_day(dates, {"1101": up, "1102": down, "1103": flat, "1104": short})
        self.assertEqual((res["bull"], res["bear"], res["neutral"], res["n"]), (1, 1, 1, 3))

    def test_count_day_needs_full_ma_window(self):
        self.assertIsNone(breadth.count_day(["d0"] * 59, {"1101": [1.0] * 59}))


if __name__ == "__main__":
    unittest.main()
