"""Offline tests for API provenance and the CSV fallback boundary."""
from __future__ import annotations

import sys
import tempfile
import unittest
import io
import os
import shutil
import subprocess
import json
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1]
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import _macro_data as macro  # noqa: E402
import fetch_us_macro_diagnostic as fetch  # noqa: E402
import validate_us_macro as validator  # noqa: E402


class PipelineSourceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_api_missing_provenance_validation_and_csv_dedupe(self):
        series = 'UNRATE'
        api = macro.api_source_url(series)
        csv = macro.source_url(series)
        body_api = 'observation_date,UNRATE\n2025-09-01,4.0\n2025-10-01,.\n2025-11-01,4.2\n'
        body_csv = body_api.replace('2025-10-01,.', '2025-10-01,')
        with patch.object(fetch._common, 'get_fred_api_key', return_value='test-secret'), patch.object(
                fetch._common, 'fred_csv_text', return_value=body_api) as getter:
            rows, stamp = fetch.fetch_one(series)
        getter.assert_called_once()
        self.assertTrue(stamp.endswith('Z'))
        self.assertEqual(rows[1]['raw_lexeme'], '.')
        self.assertIsNone(rows[1]['raw_value'])
        self.assertEqual(rows[1]['source_url'], api)
        macro.commit_batch(self.data, {series: (rows, '2026-09-27T00:00:00Z')}, {}, attempt_at='2026-09-27T00:00:00Z')
        self.assertEqual(validator.validate(self.data)['events'], 3)
        summary = macro.query(self.data, 'latest_revised')
        self.assertEqual(summary['indicators'][series]['source_url'], api)
        first, latest, _ = macro.load_archive(self.data)
        self.assertEqual(latest[series]['2025-10']['source_url'], api)
        csv_rows = macro.parse_csv(series, body_csv, source=csv)
        macro.commit_batch(self.data, {series: (csv_rows, '2026-09-27T00:00:01Z')}, {}, attempt_at='2026-09-27T00:00:01Z')
        second, _, _ = macro.load_archive(self.data)
        self.assertEqual(sum(s['rows'] for s in first['segments']), sum(s['rows'] for s in second['segments']))
        self.assertEqual(validator.validate(self.data)['events'], 3)

    def test_api_dot_rejected_for_csv_and_wrong_source_rejected(self):
        with self.assertRaises(macro.SourceError):
            macro.parse_csv('UNRATE', 'observation_date,UNRATE\n2025-10-01,.\n')
        with self.assertRaises(macro.SourceError):
            macro.parse_csv('UNRATE', 'observation_date,UNRATE\n2025-10-01,.\n', source='https://example.invalid')

    def test_api_failure_never_exposes_key_or_changes_archive(self):
        secret = 'test-secret-never-log'
        rows = macro.parse_csv('PCEC96', 'observation_date,PCEC96\n2026-08-01,100\n')
        macro.commit_batch(self.data, {'PCEC96': (rows, '2026-09-26T00:00:00Z')}, {}, attempt_at='2026-09-26T00:00:00Z')
        _, previous, _ = macro.load_archive(self.data)
        event_hash = previous['PCEC96']['2026-08']['event_sha256']
        with patch.object(fetch._common, 'get_fred_api_key', return_value=secret), patch.object(
                fetch._common, 'fred_csv_text', side_effect=RuntimeError(f'https://api.example/?api_key={secret}')):
            with patch.object(fetch._common, 'retry_call', side_effect=lambda fn, **kwargs: fn()):
                with self.assertRaises(macro.SourceError) as caught:
                    fetch.fetch_one('PCEC96')
                stdout = io.StringIO()
                with redirect_stdout(stdout):
                    fetch.run(self.data, fetcher=fetch.fetch_one, attempt_at='2026-09-27T00:00:00Z')
        self.assertNotIn(secret, str(caught.exception))
        self.assertNotIn(secret, stdout.getvalue())
        manifest, latest, _ = macro.load_archive(self.data)
        self.assertEqual(latest['PCEC96']['2026-08']['event_sha256'], event_hash)
        self.assertEqual(manifest['source_status']['PCEC96']['last_attempt_status'], 'failed')
        self.assertNotIn(secret, manifest['source_status']['PCEC96']['error'])

    def test_no_key_uses_csv_downloader(self):
        body = b'observation_date,ISRATIO\n2026-08-01,1.2\n'
        with patch.object(fetch._common, 'get_fred_api_key', return_value=None), patch.object(
                fetch.subprocess, 'run') as command:
            command.return_value.stdout = body
            with patch.object(fetch._common, 'retry_call', side_effect=lambda fn, **kwargs: fn()):
                rows, _ = fetch.fetch_one('ISRATIO')
        self.assertEqual(rows[0]['source_url'], macro.source_url('ISRATIO'))
        self.assertIn(macro.source_url('ISRATIO'), command.call_args.args[0])


class PipelineGitSimulationTests(unittest.TestCase):
    """Offline Git integration: only B fetch is replaced by a local clock shim."""

    ROOT = SCRIPTS.parent

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.work = Path(self.tmp.name) / 'repo'
        self.work.mkdir()
        for relative in [
            'scripts/run_us_macro_pipeline.sh', 'scripts/validate_us_macro.py',
            'scripts/_macro_data.py', 'scripts/capture_us_macro_diagnostic.mjs',
            'scripts/_us_macro_snapshot_index.mjs',
            'scripts/validate_us_macro_diagnostic_snapshots.mjs',
            'js/utils/us_macro_diagnostic.js', 'js/utils/math.js',
            'data/us_macro_diagnostic.json', 'data/SPY.json', 'data/QQQ.json',
            'data/cpi.json', 'data/credit_spread.json',
        ]:
            target = self.work / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(self.ROOT / relative, target)
        frozen = self.ROOT / 'js/utils/us_macro_diagnostic_v01.js'
        if frozen.exists():
            shutil.copy2(frozen, self.work / 'js/utils/us_macro_diagnostic_v01.js')
        shutil.copytree(self.ROOT / 'data/us_macro_archive', self.work / 'data/us_macro_archive')
        # No HTTP/API call. This exercises the real manifest builder and B validator.
        (self.work / 'scripts/fetch_us_macro_diagnostic.py').write_text(
            'from datetime import datetime, timezone\n'
            'from pathlib import Path\n'
            'import _macro_data as macro\n'
            'stamp = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")\n'
            'macro.commit_batch(Path("data"), {}, {}, attempt_at=stamp)\n'
            'print("OFFLINE B SHIM: manifest clock advanced; zero downloads")\n',
            encoding='utf-8',
        )
        (self.work / 'data/other.json').write_text('{"old":true}\n', encoding='utf-8')
        self.git('init', '-q')
        self.git('config', 'user.name', 'Offline test')
        self.git('config', 'user.email', 'offline@example.invalid')

    def run_command(self, *args, env=None):
        return subprocess.run(args, cwd=self.work, text=True, capture_output=True,
                              env={**os.environ, **(env or {}), 'PYTHONDONTWRITEBYTECODE': '1'})

    def git(self, *args):
        result = self.run_command('git', *args)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def commit_fixture(self, *, macro_in_head):
        if not macro_in_head:
            shutil.rmtree(self.work / 'data/us_macro_archive')
            (self.work / 'data/us_macro_diagnostic.json').unlink()
        self.git('add', '.')
        self.git('commit', '-qm', 'isolated fixture')
        if not macro_in_head:
            shutil.copy2(self.ROOT / 'data/us_macro_diagnostic.json', self.work / 'data/us_macro_diagnostic.json')
            shutil.copytree(self.ROOT / 'data/us_macro_archive', self.work / 'data/us_macro_archive')

    def macro_bytes(self):
        result = {}
        for root in ('data/us_macro_diagnostic.json', 'data/us_macro_archive', 'data/us_macro_diagnostic_snapshots'):
            path = self.work / root
            if path.is_file():
                result[root] = path.read_bytes()
            elif path.is_dir():
                for item in path.rglob('*'):
                    if item.is_file():
                        result[item.relative_to(self.work).as_posix()] = item.read_bytes()
        return result

    def validators(self):
        b = self.run_command(sys.executable, 'scripts/validate_us_macro.py')
        c = self.run_command('node', 'scripts/validate_us_macro_diagnostic_snapshots.mjs')
        return b, c

    def test_normal_capture_and_same_day_second_run(self):
        self.commit_fixture(macro_in_head=True)
        first = self.run_command('bash', 'scripts/run_us_macro_pipeline.sh')
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        b, c = self.validators()
        self.assertEqual((b.returncode, c.returncode), (0, 0), b.stderr + c.stderr)
        # Verify the filename from the snapshot itself, independent of host TZ.
        snapshots = list((self.work / 'data/us_macro_diagnostic_snapshots').glob('*/*.json'))
        self.assertEqual(len(snapshots), 1)
        snapshot = json.loads(snapshots[0].read_text(encoding='utf-8'))
        self.assertEqual(snapshots[0].stem, snapshot['local_date_Taipei'])
        self.git('add', 'data/us_macro_diagnostic.json', 'data/us_macro_archive', 'data/us_macro_diagnostic_snapshots')
        self.git('commit', '-qm', 'isolated daily macro snapshot')
        before = self.macro_bytes()
        second = self.run_command('bash', 'scripts/run_us_macro_pipeline.sh')
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        self.assertIn('::notice::', second.stdout)
        self.assertEqual(before, self.macro_bytes())
        self.assertEqual(self.git('status', '--short'), '')
        print('NORMAL:', first.stdout.strip(), '| B:', b.stdout.splitlines()[0], '| C:', c.stdout.strip())
        print('SECOND:', second.stdout.strip(), '| git status --short: clean; macro bytes identical')

    def test_capture_failure_restores_head_and_other_data(self):
        self.commit_fixture(macro_in_head=True)
        before = self.macro_bytes()
        (self.work / 'data/other.json').write_text('{"new":true}\n', encoding='utf-8')
        preloader = Path(self.tmp.name) / 'fail_capture.cjs'
        preloader.write_text(
            'if (process.argv.some(x => x.endsWith("capture_us_macro_diagnostic.mjs"))) {\n'
            '  const fs = require("node:fs");\n'
            '  fs.mkdirSync("data/us_macro_diagnostic_snapshots/2099", {recursive:true});\n'
            '  fs.writeFileSync("data/us_macro_diagnostic_snapshots/2099/partial.json", "partial");\n'
            '  require("node:child_process").execFileSync("git", ["add", "data/us_macro_diagnostic_snapshots/2099/partial.json"]);\n'
            '  console.error("INTENTIONAL CAPTURE FAILURE"); process.exit(73);\n}\n', encoding='utf-8')
        env = {**os.environ, 'NODE_OPTIONS': f'--require={preloader}'}
        run = self.run_command('bash', 'scripts/run_us_macro_pipeline.sh', env=env)
        self.assertEqual(run.returncode, 1, run.stdout + run.stderr)
        self.assertIn('::warning::', run.stderr)
        self.assertEqual(before, self.macro_bytes())
        status = self.git('status', '--short')
        self.assertEqual(status, ' M data/other.json\n')
        b, c = self.validators()
        self.assertEqual((b.returncode, c.returncode), (0, 0), b.stderr + c.stderr)
        print('CAPTURE FAILURE:', run.stderr.strip(), '| git status --short:', status.strip())
        print('B:', b.stdout.splitlines()[0], '| C:', c.stdout.strip())

    def test_capture_failure_before_macro_first_commit(self):
        self.commit_fixture(macro_in_head=False)
        (self.work / 'data/other.json').write_text('{"new":true}\n', encoding='utf-8')
        # A broken C writer fails after B has created a valid untracked generation.
        preloader = Path(self.tmp.name) / 'fail_capture.cjs'
        preloader.write_text(
            'if (process.argv.some(x => x.endsWith("capture_us_macro_diagnostic.mjs"))) {\n'
            '  const fs = require("node:fs");\n'
            '  fs.mkdirSync("data/us_macro_diagnostic_snapshots/2099", {recursive:true});\n'
            '  fs.writeFileSync("data/us_macro_diagnostic_snapshots/2099/partial.json", "partial");\n'
            '  require("node:child_process").execFileSync("git", ["add", "data/us_macro_diagnostic_snapshots/2099/partial.json"]);\n'
            '  console.error("INTENTIONAL CAPTURE FAILURE"); process.exit(73);\n}\n', encoding='utf-8')
        run = self.run_command('bash', 'scripts/run_us_macro_pipeline.sh', env={**os.environ, 'NODE_OPTIONS': f'--require={preloader}'})
        self.assertEqual(run.returncode, 1, run.stdout + run.stderr)
        self.assertIn('::warning::', run.stderr)
        self.assertEqual(self.macro_bytes(), {})
        status = self.git('status', '--short')
        self.assertEqual(status, ' M data/other.json\n')
        b, c = self.validators()
        self.assertNotEqual(b.returncode, 0)
        self.assertEqual(c.returncode, 0, c.stderr)
        print('NO MACRO IN HEAD:', run.stderr.strip(), '| git status --short:', status.strip())
        print('B exit:', b.returncode, b.stderr.splitlines()[-1], '| C:', c.stdout.strip())


if __name__ == '__main__':
    unittest.main()
