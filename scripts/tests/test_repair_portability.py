"""Offline regression checks for the repository runner and costmap seed route."""
from pathlib import Path
from unittest import TestCase, mock
import json
import os
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import fetch_margin_costmap as costmap
import run_checks


FLOW = {
    "date": "2020-01-02", "buy_yi": 1, "sell_yi": 2, "repay_yi": 3,
    "prev_balance_yi": 4, "today_balance_yi": 5,
}


class CostmapSeedTest(TestCase):
    def test_missing_configuration_stops_before_fetch(self):
        with mock.patch.dict(os.environ, {costmap.SEED_ENV: ""}):
            with mock.patch.object(costmap, "load_twii", return_value=[("2001-01-02", 100)]), \
                 mock.patch.object(costmap, "load_actual_ratio", return_value={}), \
                 mock.patch.object(costmap, "load_existing_raw_flows", return_value={}), \
                 mock.patch.object(costmap, "fetch_missing") as fetch:
                with self.assertRaisesRegex(RuntimeError, costmap.SEED_ENV):
                    costmap.main()
                fetch.assert_not_called()

    def test_explicit_seed_uses_fixture_and_requires_nonempty_flows(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "seed.json"
            path.write_text(json.dumps({"raw_flows": [FLOW]}))
            with mock.patch.dict(os.environ, {costmap.SEED_ENV: str(path)}):
                self.assertEqual(costmap.load_seed_raw_flows(), {FLOW["date"]: FLOW})
            self.assertEqual(costmap.load_seed_raw_flows(path), {FLOW["date"]: FLOW})
            path.write_text(json.dumps({"raw_flows": []}))
            with mock.patch.object(costmap, "load_twii", return_value=[("2001-01-02", 100)]), \
                 mock.patch.object(costmap, "load_actual_ratio", return_value={}), \
                 mock.patch.object(costmap, "load_existing_raw_flows", return_value={}), \
                 mock.patch.object(costmap, "fetch_missing") as fetch:
                with mock.patch.dict(os.environ, {costmap.SEED_ENV: str(path)}):
                    with self.assertRaisesRegex(ValueError, "no raw_flows"):
                        costmap.main()
                fetch.assert_not_called()

    def test_existing_cache_skips_seed(self):
        with tempfile.TemporaryDirectory() as temp:
            raw_path = Path(temp) / "margin_costmap_raw.json"
            raw_path.write_text(json.dumps({"raw_flows": [FLOW]}))
            with mock.patch.object(costmap, "RAW_JSON", raw_path), \
                 mock.patch.object(costmap, "OUT_JSON", Path(temp) / "absent.json"), \
                 mock.patch.object(costmap, "load_twii", return_value=[("2001-01-02", 100)]), \
                 mock.patch.object(costmap, "load_actual_ratio", return_value={}), \
                 mock.patch.object(costmap, "load_seed_raw_flows") as seed, \
                 mock.patch.object(costmap, "fetch_missing", side_effect=RuntimeError("fetch boundary")) as fetch:
                with mock.patch.dict(os.environ, {costmap.SEED_ENV: "/missing/seed.json"}):
                    with self.assertRaisesRegex(RuntimeError, "fetch boundary"):
                        costmap.main()
                seed.assert_not_called()
                fetch.assert_called_once()
                self.assertEqual(fetch.call_args.args[1], {FLOW["date"]: FLOW})


class SyntaxGateTest(TestCase):
    def test_scaffold_bad_js_fails_offline_runner(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            scaffold = root / "js" / "scaffold"
            scaffold.mkdir(parents=True)
            (scaffold / "_template.js").write_text("const = ;\n")
            with mock.patch.object(run_checks, "ROOT", root), \
                 mock.patch.object(sys, "argv", ["run_checks.py", "--js-only"]):
                self.assertEqual(run_checks.main(), 1)
