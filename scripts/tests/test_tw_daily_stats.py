"""Offline checks for fetch_tw_daily_stats.py: parsing, TPEx limit detection, observation-stock rule."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1]
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import fetch_tw_daily_stats as F


class ParseTests(unittest.TestCase):
    def test_num_strips_commas_and_inner_spaces(self):
        self.assertEqual(F.num("+ 0.50"), 0.5)
        self.assertEqual(F.num("1,234"), 1234.0)
        self.assertIsNone(F.num("--"))

    def test_split_count(self):
        self.assertEqual(F.split_count("2,880(1,333)"), (2880, 1333))
        self.assertEqual(F.split_count("4(0)"), (4, 0))
        self.assertEqual(F.split_count("28"), (None, None))

    def test_twse_summary_uses_stock_column(self):
        rows = [[f"{1000 + i}", "x", "1,000", "1", "1", "10", "10", "9", "9.5", "-", "0.5"] for i in range(F.MIN_TWSE)]
        payload = {"stat": "OK", "tables": [
            {"title": "漲跌證券數合計", "fields": ["類型", "整體市場", "股票"],
             "data": [["上漲(漲停)", "1,249(262)", "4(0)"], ["下跌(跌停)", "2,880(1,333)", "1,032(937)"]]},
            {"title": "每日收盤行情", "fields": ["證券代號", "證券名稱", "成交股數", "成交筆數", "成交金額", "開盤價", "最高價", "最低價", "收盤價", "漲跌(+/-)", "漲跌價差"],
             "data": rows + [["0050", "ETF", "1", "1", "1", "1", "1", "1", "1", "-", "0"]]},
        ]}
        with patch.object(F, "get_json", return_value=payload):
            r = F.fetch_twse("2025-04-07")
        self.assertEqual(r["summary"], {"up": 4, "limit_up": 0, "down": 1032, "limit_down": 937})
        self.assertNotIn("0050", r["px"], "ETF codes are excluded")
        self.assertEqual(r["px"]["1000"], [9.5, 1])

    def test_tpex_limit_uses_previous_day_limit_price_else_approx(self):
        fields = ["代號", "名稱", "收盤", "漲跌", "成交股數", "次日漲停價", "次日跌停價"]
        filler = [[f"{5000 + i}", "x", "10", "0.00", "1,000", "11", "9"] for i in range(F.MIN_TPEX)]
        data = [["1101", "a", "90.0", "-10.00", "5,000", "99", "81"],   # 前一日跌停價 90 → 跌停
                ["1102", "b", "45.5", "-4.50", "5,000", "50", "41"],   # 無前一日資料、跌 9.0% → 不算
                ["1103", "c", "45.0", "-5.00", "5,000", "49.5", "40.5"]] + filler   # 無前一日、跌 10% → 近似跌停
        with patch.object(F, "get_json", return_value={"tables": [{"fields": fields, "data": data}]}):
            r = F.fetch_tpex("2025-04-07", {"1101": [110.0, 90.0]})
        self.assertEqual(r["summary"]["down"], 3)
        self.assertEqual(r["summary"]["limit_down"], 2)
        self.assertEqual(r["limits"]["1101"], [99.0, 81.0])


class ObserveTests(unittest.TestCase):
    def window(self, last):
        need = max(F.HIGH_N, F.VOL_N) + 1
        return [[10.0, 2000]] * (need - 1) + [last]

    def test_breakout_with_volume_counts_and_groups_need_three(self):
        dates = [f"d{i}" for i in range(max(F.HIGH_N, F.VOL_N) + 1)]
        hit = [11.0, 9000]   # 新高、4.5 倍均量
        series = {"1101": self.window(hit), "1102": self.window(hit), "1105": self.window(hit), "2330": self.window(hit), "2303": self.window(hit),
                  "1103": self.window([11.0, 7000]),    # 3.5 倍，量不夠
                  "1104": self.window([10.0, 9000])}    # 沒有創新高
        sectors = {"1101": "steel", "1102": "steel", "1105": "steel", "2330": "semiconductor", "2303": "semiconductor", "1103": "steel", "1104": "steel"}
        r = F.observe(dates, series, sectors)
        self.assertEqual(r["obs"], 5)
        self.assertEqual(r["obs_groups"], 1, "semiconductor has only two breakouts")
        self.assertEqual(r["no_obs"], 0)

    def test_no_breakouts_is_a_no_observation_day(self):
        dates = [f"d{i}" for i in range(max(F.HIGH_N, F.VOL_N) + 1)]
        r = F.observe(dates, {"1101": self.window([9.0, 5000])}, {"1101": "steel"})
        self.assertEqual((r["obs"], r["obs_groups"], r["no_obs"]), (0, 0, 1))

    def test_too_little_history_returns_none(self):
        self.assertIsNone(F.observe(["d0", "d1"], {}, {}))


if __name__ == "__main__":
    unittest.main()
