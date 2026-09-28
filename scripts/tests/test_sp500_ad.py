"""Offline adjacent-session counting and failure-preservation checks."""
import json
import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import fetch_sp500_ad as ad


class CountsTest(unittest.TestCase):
    def prices(self, values):
        return pd.DataFrame(values, index=pd.date_range('2020-01-01', periods=len(next(iter(values.values())))))

    def test_counts_and_first_row(self):
        rows = ad.compute_ad(self.prices({'a': [10, 11], 'd': [10, 9], 'u': [10, 10]}))
        self.assertEqual(rows, [{'date': '2020-01-02', 'advances': 1, 'declines': 1, 'unchanged': 1, 'total': 3}])

    def test_invalid_pairs_no_search_back(self):
        rows = ad.compute_ad(self.prices({'gap': [10, None, 12], 'zero': [10, 0, 10], 'negative': [10, -1, 10], 'infinite': [10, float('inf'), 10]}))
        for row in rows:
            self.assertTrue(all(row[k] is None for k in ['advances', 'declines', 'unchanged', 'total']))

    def test_tolerance_both_signs(self):
        rows = ad.compute_ad(self.prices({'flat_up': [100, 100 + 0.9e-7], 'flat_down': [100, 100 - 0.9e-7], 'up': [100, 100 + 1.1e-7], 'down': [100, 100 - 1.1e-7]}))
        self.assertEqual([rows[0][k] for k in ['advances','declines','unchanged','total']], [1,1,2,4])

    def test_recent_coverage_boundary(self):
        today = date(2026, 9, 28)
        rows = [{'date': (today - timedelta(days=days)).isoformat(), 'total': total} for days, total in [(15,1),(14,479),(1,None),(0,480)]]
        self.assertEqual(ad.filter_recent_coverage(rows, today), [rows[0], rows[3]])

    def test_failure_preserves_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)/'ad.json'; original = b'{"data":[{"date":"2020-01-01","total":500}]}\n';out.write_bytes(original)
            for result in [RuntimeError('download failed'), pd.DataFrame(), self.prices({'A': [1]}), self.prices({'A': [None, None]})]:
                with patch.object(ad,'OUT_PATH',out), patch.object(ad,'get_sp500_tickers',return_value=['A']), patch.object(ad._breadth,'fetch_prices',side_effect=result if isinstance(result, Exception) else None, return_value=result):
                    with self.assertRaises(RuntimeError): ad.main()
                self.assertEqual(out.read_bytes(), original)

    def test_merge_keeps_old_and_always_incremental(self):
        with tempfile.TemporaryDirectory() as tmp:
            out=Path(tmp)/'ad.json';old={'date':'2019-01-01','advances':1,'declines':0,'unchanged':0,'total':1}
            out.write_text(json.dumps({'data':[old,{'date':'2020-01-02','total':500}]}))
            prices=self.prices({'A':[1,2,1]})
            with patch.object(ad,'OUT_PATH',out),patch.object(ad,'get_sp500_tickers',return_value=['A']),patch.object(ad._breadth,'fetch_prices',return_value=prices) as download:
                ad.main();ad.main()
            self.assertEqual(download.call_count,2)
            self.assertEqual(download.call_args.args[1],'2019-11-19')
            rows=json.loads(out.read_text())['data'];self.assertEqual(rows[0],old);self.assertEqual(len(rows),3);self.assertEqual(rows[1]['advances'],1)

    def test_missing_chunk_preserves_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            out=Path(tmp)/'ad.json';out.write_text('{"data":[]}');before=out.read_bytes()
            with patch.object(ad,'OUT_PATH',out),patch.object(ad,'get_sp500_tickers',return_value=['A','B']),patch.object(ad._breadth,'fetch_prices',return_value=self.prices({'A':[1,2]})):
                with self.assertRaises(RuntimeError): ad.main()
            self.assertEqual(out.read_bytes(),before)
