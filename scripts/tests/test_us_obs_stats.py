"""Offline checks for fetch_us_obs_stats.py: observation rule and point-in-time groups."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

import pandas as pd

SCRIPTS = Path(__file__).resolve().parents[1]
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import _us_index_history as U
import fetch_us_obs_stats as F


class ObserveTests(unittest.TestCase):
    def frames(self, last_close, last_vol):
        idx = pd.bdate_range("2024-01-01", periods=F.HIGH_N + 1)
        close = pd.DataFrame({"AAA": [10.0] * F.HIGH_N + [last_close]}, index=idx)
        vol = pd.DataFrame({"AAA": [1000.0] * F.HIGH_N + [last_vol]}, index=idx)
        return close, vol

    def test_new_twenty_day_high_with_double_volume(self):
        valid, obs = F.observe(*self.frames(11.0, 2500))
        self.assertTrue(valid["AAA"].iloc[-1])
        self.assertTrue(obs["AAA"].iloc[-1])
        self.assertFalse(valid["AAA"].iloc[F.HIGH_N - 1], "needs 20 prior closes")

    def test_volume_or_high_missing(self):
        self.assertFalse(F.observe(*self.frames(11.0, 1500))[1]["AAA"].iloc[-1])
        self.assertFalse(F.observe(*self.frames(10.0, 2500))[1]["AAA"].iloc[-1])


class GroupTests(unittest.TestCase):
    def test_point_in_time_groups(self):
        g = U.groups_on("2026-10-22")
        self.assertEqual(g["qqq"], U.NDX_CURRENT)
        self.assertIn("NVDA", g["soxx"])
        self.assertTrue(g["voo5"] <= U.SP500_CURRENT)
        self.assertTrue(all(U.SECTOR[t] in U.TOP5 for t in g["voo5"]))
        self.assertTrue(all(100 <= len(U.groups_on(d)["qqq"]) <= 107 for d in ("2013-06-03", "2018-01-02", "2022-06-01")))

    def test_renamed_ticker_uses_current_symbol(self):
        self.assertIn("META", U.groups_on("2014-06-02")["qqq"])


if __name__ == "__main__":
    unittest.main()
