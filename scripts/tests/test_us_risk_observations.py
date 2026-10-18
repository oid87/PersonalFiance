"""Offline provenance/versioning tests. Never rewrites shared market data."""
import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

SPEC = importlib.util.spec_from_file_location('us_risk_capture', Path(__file__).resolve().parents[1] / 'compute_us_risk_observations.py')
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class ObservationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.path = Path(self.tmp.name)
        self.now = datetime(2026, 10, 18, 7, tzinfo=timezone.utc)
        self.row = dict(date='2020-03-20', open=100, high=102, low=95, close=98)
        for ticker in ('SPY', 'QQQ'):
            self.write(ticker, [self.row])

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, ticker, rows):
        (self.path / (ticker + '.json')).write_text(json.dumps({'updated': '2026-10-17', 'data': rows}))

    def test_first_import_is_today_even_for_old_data(self):
        result = module.build_bundle(self.path, now=self.now)
        row = result['series']['SPY']['records'][0]
        self.assertEqual(row['date'], '2020-03-20')
        self.assertEqual(row['observed_at'], '2026-10-18T07:00:00Z')
        self.assertIsNone(row['published_at'])
        self.assertEqual(len(row['source_hash']), 64)

    def test_idempotence_and_revisions_append_without_mutation(self):
        before = module.build_bundle(self.path, now=self.now)
        again = module.build_bundle(self.path, before, self.now.replace(hour=8))
        self.assertEqual(before['series']['SPY']['records'], again['series']['SPY']['records'])
        self.write('SPY', [{**self.row, 'close': 99}])
        after = module.build_bundle(self.path, again, self.now.replace(hour=9))
        self.assertEqual([r['values']['close'] for r in after['series']['SPY']['records']], [98, 99])
        self.assertEqual(before['series']['SPY']['records'][0]['values']['close'], 98)

    def test_upstream_failure_keeps_old_timestamp_and_sets_stale(self):
        before = module.build_bundle(self.path, now=self.now)
        self.write('SPY', [])
        after = module.build_bundle(self.path, before, self.now.replace(hour=9))
        self.assertEqual(after['series']['SPY']['records'], before['series']['SPY']['records'])
        self.assertEqual(after['series']['SPY']['meta']['status'], 'stale')
        self.assertNotEqual(after['series']['SPY']['meta']['input_updated'], '2026-10-18')

    def test_corrupt_archive_cannot_be_overwritten(self):
        with self.assertRaises(ValueError):
            module.build_bundle(self.path, {'schema_version': 0}, self.now)
        with self.assertRaises(ValueError):
            module.build_bundle(self.path, now=self.now.replace(tzinfo=None))

    def test_missing_required_prices_fails(self):
        (self.path / 'QQQ.json').unlink()
        with self.assertRaisesRegex(ValueError, 'Required QQQ'):
            module.build_bundle(self.path, now=self.now)

    def test_future_rows_never_imported_and_bad_ohlc_not_repaired(self):
        self.write('SPY', [{**self.row, 'open': 110}, {**self.row, 'date': '2027-01-01'}])
        result = module.build_bundle(self.path, now=self.now)
        rows = result['series']['SPY']['records']
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['values']['open'], 110)  # engine makes outcome unavailable

    def test_unlicensed_and_missing_sources_are_explicitly_unavailable(self):
        result = module.build_bundle(self.path, now=self.now)
        for key in ('HY_OAS', 'CNN_FG', 'SMH', 'RSP'):
            self.assertFalse(result['series'][key]['meta']['available'])
            self.assertEqual(result['series'][key]['records'], [])
            self.assertTrue(result['series'][key]['meta']['reason'])


if __name__ == '__main__':
    unittest.main()
