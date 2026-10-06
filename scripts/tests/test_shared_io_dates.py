"""Frozen before-refactor edge cases for cache and weekday wrappers."""
import ast
from datetime import date, timedelta
import json
from pathlib import Path
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
import _common


def wrapper(script, name, **values):
    """Load one public wrapper without importing a fetcher's top-level side effects."""
    tree = ast.parse((SCRIPTS / f"fetch_{script}.py").read_text())
    node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == name)
    scope = {'_common': _common, 'date': date, 'timedelta': timedelta, **values}
    exec(compile(ast.Module(body=[node], type_ignores=[]), str(SCRIPTS / f"fetch_{script}.py"), 'exec'), scope)
    return scope[name]


class SharedIoDatesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.out = Path(self.temp.name) / 'cache.json'

    def test_whole_object_cache_wrappers_keep_all_or_nothing_policy(self):
        scripts = ('bullbear', 'cpi', 'liquidity', 'liquidity_leverage', 'umich')
        for script in scripts:
            with self.subTest(script=script):
                load = wrapper(script, 'load_existing', OUT=self.out)
                self.assertEqual(load(), {})
                self.out.write_text('{broken')
                self.assertEqual(load(), {})
                self.out.write_text('{"data":[{"date":"2026-01-02"}],"note":"keep"}')
                self.assertEqual(load(), {'data': [{'date': '2026-01-02'}], 'note': 'keep'})
                self.out.unlink()

    def test_strict_date_map_preserves_duplicate_order_and_rejects_any_bad_row(self):
        scripts = (('margin_jp', 'load_existing_rows'), ('margin_kr', 'load_existing_rows'),
                   ('net_liquidity', 'load_existing'))
        for script, name in scripts:
            with self.subTest(script=script):
                load = wrapper(script, name, OUT=self.out)
                self.assertEqual(load(), {})
                self.out.write_text(json.dumps({'data': [
                    {'date': '2026-01-03', 'value': 1}, {'date': '2026-01-01', 'value': 2},
                    {'value': 9}, {'date': '2026-01-03', 'value': 3}]}))
                self.assertEqual(list(load()), ['2026-01-03', '2026-01-01'])
                self.assertEqual(load()['2026-01-03']['value'], 3)
                self.out.write_text('{"data":[{"date":"2026-01-01"},7]}')
                self.assertEqual(load(), {})
                self.out.unlink()

    def test_weekday_wrappers_preserve_generator_and_list_contracts(self):
        start, end = date(2026, 1, 2), date(2026, 1, 6)  # Friday through Tuesday.
        expected = [date(2026, 1, 2), date(2026, 1, 5), date(2026, 1, 6)]
        for script in ('finra_short', 'putcall'):
            days = wrapper(script, 'business_days')(start, end)
            self.assertEqual(type(days).__name__, 'generator')
            self.assertEqual(list(days), expected)
        for script in ('taifex_foreign_oi', 'tw_sector_flow'):
            days = wrapper(script, 'trading_dates')(start, end)
            self.assertIsInstance(days, list)
            self.assertEqual(days, expected)
        self.assertEqual(list(_common.weekday_dates(date(2026, 1, 7), date(2026, 1, 6))), [])

    def test_stride_wrappers_keep_newest_first_layers_and_empty_ceiling_anchor(self):
        class FixedDate:
            @staticmethod
            def today(): return date(2026, 2, 6)
        # Captured from the three before-snapshot functions, not recomputed here.
        expected = ['2026-02-06', '2026-01-15', '2026-01-27', '2026-01-05',
                    '2026-02-02', '2026-01-21', '2026-01-09', '2026-02-04',
                    '2026-01-29', '2026-01-23', '2026-01-19', '2026-01-13',
                    '2026-01-07', '2026-01-01', '2026-02-05', '2026-02-03',
                    '2026-01-30', '2026-01-28', '2026-01-26', '2026-01-22',
                    '2026-01-20', '2026-01-16', '2026-01-14', '2026-01-12',
                    '2026-01-08', '2026-01-06', '2026-01-02']
        for script in ('margin_ratio_mm', 'tpex_margin', 'twse_mktcap'):
            with self.subTest(script=script):
                days = wrapper(script, 'missing_trading_days', FLOOR='2026-01-01', CEIL='', date=FixedDate)({'2026-01-31'})
                self.assertEqual(days, expected)
                self.assertEqual(wrapper(script, 'missing_trading_days', FLOOR='2026-02-07', CEIL='2026-02-06')({}), [])


if __name__ == '__main__':
    unittest.main()
