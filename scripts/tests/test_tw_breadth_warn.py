"""市場廣度與流動性預警（data/tw_breadth_warn.json）的資料品質測試：
增量＝全量、成分股不被最新名單覆寫、分割／減資不造成假跌停、盤中不算完整交易日、日期不重複、缺漏不會變成 0%。"""
import json
import sys
import unittest
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import _tw50_history as th  # noqa: E402
import _tw_breadth_warn as bw  # noqa: E402


def synth(days=900, stocks=60, seed=5):
    rng = np.random.default_rng(seed)
    idx = pd.bdate_range("2021-01-04", periods=days)
    ret = rng.normal(0, 0.025, (days, stocks)).clip(-0.0999, 0.0999)
    ret[700:705, :25] = -0.0995                       # 一段跌停潮
    adj = pd.DataFrame(50 * np.cumprod(1 + ret, axis=0), index=idx, columns=[f"{1101 + i}" for i in range(stocks)])
    vol = pd.DataFrame(rng.integers(1_000, 900_000, (days, stocks)).astype(float), index=idx, columns=adj.columns)
    return adj, adj.copy(), vol


class BreadthWarnData(unittest.TestCase):
    def test_incremental_equals_full(self):
        adj, close, vol = synth()
        full = bw.compute(adj, close, vol).tail(15)
        inc = bw.compute(adj.tail(370), close.tail(370), vol.tail(370)).tail(15)   # 每日增量只抓約 520 個日曆天 ≈ 370 個交易日
        for f in bw.FIELDS:
            np.testing.assert_allclose(inc[f].to_numpy(float), full[f].to_numpy(float), rtol=1e-9, atol=1e-9, equal_nan=True, err_msg=f)

    def test_tw50_members_are_point_in_time(self):
        self.assertTrue(all(len(s) == 50 for e, s in th.TIMELINE if e >= "2012-12-24"))
        m2015 = th.members_on("2015-01-05")
        self.assertIn("2498", m2015)            # 宏達電 2015-09 才剔除
        self.assertNotIn("6669", m2015)         # 緯穎 2020 才納入
        self.assertNotIn("2498", th.members_on("2015-09-21"))
        self.assertIn("2311", th.members_on("2018-04-27"))      # 日月光：2018-04-30 才換成 3711
        self.assertNotIn("3711", th.members_on("2018-04-27"))
        self.assertIn("3711", th.members_on("2018-04-30"))
        self.assertEqual(th.members_on("2026-11-11"), th.CURRENT)
        m2008 = th.members_on("2008-10-27")                     # 2008 用當時的名單，不是 2012 年底的
        self.assertEqual(len(m2008), 50)
        for sid in ("2408", "3009", "5854", "2888", "9904"):     # 南科、奇美電、合庫（舊代號）、新光金、寶成：後來都離開
            self.assertIn(sid, m2008)
        for sid in ("3008", "2474", "5880", "3673"):             # 大立光、可成當時不在；合庫金、TPK 還沒掛牌
            self.assertNotIn(sid, m2008)
        self.assertEqual(len(th.members_on("2010-06-25")), 51)   # 和碩納入、力成尚未刪除的 5 天，官方就是 51 檔
        effs = [e for e, _ in th.TIMELINE]
        self.assertEqual(effs, sorted(effs))

    def test_mask_uses_membership_of_that_day(self):
        adj, close, vol = synth(400, 10)
        mask = pd.DataFrame(True, index=adj.index, columns=adj.columns)
        mask.iloc[:300, 5:] = False             # 後 5 檔第 300 天才納入
        out = bw.compute(adj, close, vol, mask)
        self.assertEqual(out["n"].iloc[250], 5)
        self.assertEqual(out["n"].iloc[350], 10)

    def test_split_and_capital_reduction_do_not_fake_limit_down(self):
        adj, close, vol = synth(400, 40, seed=9)
        adj.iloc[:] = 50.0 * np.cumprod(1 + np.random.default_rng(1).normal(0, 0.01, adj.shape), axis=0)
        close = adj.copy()
        close.iloc[300:, 0] = close.iloc[300:, 0] / 4     # 1 拆 4：原始收盤掉 75%，還原收盤連續
        close.iloc[300:, 1] = close.iloc[300:, 1] * 2     # 減資：原始收盤翻倍
        out = bw.compute(adj, close, vol)
        self.assertEqual(out["ld"].iloc[300], 0)
        base = bw.compute(adj, adj.copy(), vol)
        for f in ("a20", "a60", "adv", "dec", "nl20", "ew"):
            self.assertAlmostEqual(out[f].iloc[300], base[f].iloc[300], places=9, msg=f)

    def test_unclosed_day_is_not_written(self):
        import fetch_tw_breadth_warn as fw
        days = [pd.Timestamp("2026-11-11"), pd.Timestamp("2026-11-12")]
        self.assertEqual(fw.drop_unclosed(days, datetime(2026, 11, 12, 11, 30)), days[:1])
        self.assertEqual(fw.drop_unclosed(days, datetime(2026, 11, 12, 18, 0)), days)

    def test_missing_is_null_not_zero(self):
        adj, close, vol = synth(300, 30)
        out = bw.compute(adj, close, vol)
        self.assertTrue(np.isnan(out["a200"].iloc[100]))          # 還沒有 200 日均線
        self.assertTrue(np.isnan(out["a60"].iloc[30]))
        cols = bw.to_columns(out)
        self.assertIsNone(cols["a200"][100])
        adj2 = adj.copy(); adj2.iloc[250, :20] = np.nan           # 當天多數股票缺價：分母只算有成交的
        out2 = bw.compute(adj2, close, vol)
        self.assertEqual(out2["n"].iloc[250], 10)
        self.assertGreater(out2["a20"].iloc[250] + 1, 0)
        self.assertTrue(np.isnan(out["ldvr"].iloc[10]) or out["ld"].iloc[10] > 0)   # 沒有跌停股 → 量比是缺值不是 0

    def test_phantom_holiday_row_is_dropped(self):
        adj, close, vol = synth(300, 30)
        for df in (adj, close, vol):
            df.iloc[200] = df.iloc[199]                            # Yahoo 把前一天整列照抄到休市日
        out = bw.compute(adj, close, vol)
        self.assertNotIn(adj.index[200], out.index)

    def test_official_parsers(self):
        f = ["證券代號", "證券名稱", "成交股數", "成交筆數", "成交金額", "開盤價", "最高價", "最低價", "收盤價", "漲跌(+/-)", "漲跌價差", "最後揭示買價", "最後揭示買量", "最後揭示賣價", "最後揭示賣量", "本益比"]
        rows = [[str(1101 + k), "甲", "1,000", "1", "9,000", "9", "9", "9", "9.00", "<p style= color:green>-</p>", "1.00", "--", "", "9.00", "5", "0"] for k in range(150)]
        rows += [[str(2101 + k), "乙", "1,000", "1", "10,000", "10", "10", "10", "10.00", "<p style= color:red>+</p>", "0.10", "9.99", "3", "10.00", "5", "0"] for k in range(150)]
        rows += [["0050", "ETF", "1", "1", "1", "1", "1", "1", "1", "", "0", "1", "1", "1", "1", "0"], ["9105", "泰金寶-DR", "1", "1", "1", "1", "1", "1", "1", "", "0", "1", "1", "1", "1", "0"]]
        q = bw.parse_quotes("twse", f, rows)
        self.assertEqual(len(q), 300)
        self.assertAlmostEqual(q.ret.iloc[0], -0.10)
        self.assertEqual(bw.lock_pct(q, "2026-11-05"), 50.0)
        self.assertEqual(bw.lock_pct(q, "2008-10-20"), 50.0)
        mg = bw.parse_margin("twse", {"tables": [{"data": [["融資(交易單位)", "1", "2", "3", "100", "96"], ["融券(交易單位)", "0", "0", "0", "0", "0"], ["融資金額(仟元)", "100,000", "300,000", "50,000", "10,000,000", "9,750,000"]]}]})
        self.assertEqual(mg, {"bal": 97.5, "buy": 1.0, "sell": 3.0, "repay": 0.5, "lots": 96})
        self.assertIsNone(bw.parse_margin("twse", {"stat": "很抱歉，沒有符合條件的資料!"}))

    def test_data_file_integrity(self):
        d = json.loads((ROOT / "data" / "tw_breadth_warn.json").read_text())
        n = len(d["date"])
        self.assertEqual(d["date"], sorted(set(d["date"])))        # 遞增且不重複
        for u in ("tw50", "twse", "tpex"):
            for f in bw.FIELDS:
                self.assertEqual(len(d[u][f]), n, f"{u}.{f}")
            for i, x in enumerate(d[u]["n"]):                      # 沒有有效股票的日子，比例必須是缺值而不是 0
                if not x:
                    self.assertIsNone(d[u]["a20"][i], f"{u} {d['date'][i]}")
        self.assertTrue(all(len(d["mg"][f]) == n for f in bw.MG_FIELDS))
        self.assertTrue(all(len(d[u]["lock"]) == n for u in ("twse", "tpex")))


if __name__ == "__main__":
    unittest.main()
