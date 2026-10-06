from pathlib import Path
import json
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from check_pipeline import check, route_sequences
from source_contracts import expand_contracts, stock_stems

ROOT = Path(__file__).resolve().parents[2]


class PipelineTest(unittest.TestCase):
    def fixture_root(self, root):
        scripts = root / 'scripts'
        scripts.mkdir()
        for path in (ROOT / 'scripts').glob('*.py'):
            if path.name.startswith(('fetch_', 'prep_', 'compute_')):
                (scripts / path.name).symlink_to(path)
        for name in ('source_manifest.json', 'update_all.sh', 'run_us_macro_pipeline.sh'):
            (scripts / name).write_bytes((ROOT / 'scripts' / name).read_bytes())
        workflow = root / '.github/workflows'
        workflow.mkdir(parents=True)
        for name in ('fetch.yml', 'forward_pe.yml'):
            (workflow / name).write_bytes((ROOT / '.github/workflows' / name).read_bytes())

    def test_manifest_matches_all_routes(self):
        self.assertEqual(check(ROOT), [])
        routes = route_sequences(ROOT)
        self.assertEqual(routes['forward_pe'], ['fetch_forward_pe.py'] * 2)
        self.assertNotIn('fetch_margin_ratio_mm.py', sum(routes.values(), []))
        contracts, required = expand_contracts(ROOT, json.loads((ROOT / 'scripts/source_manifest.json').read_text()))
        self.assertEqual(len(stock_stems(ROOT)), 41)
        self.assertEqual(len(required), 41)
        self.assertEqual(contracts['QQQ.json']['profile'], 'ohlcv')

    def test_new_unwired_source_is_detected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.fixture_root(root)
            (root / 'scripts/fetch_unwired.py').write_text('# synthetic fixture\n')
            self.assertIn('source inventory mismatch', '\n'.join(check(root)))

    def test_dependency_order_regression_is_detected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.fixture_root(root)
            path = root / 'scripts/source_manifest.json'
            manifest = json.loads(path.read_text())
            entry = next(e for e in manifest['sources'] if e['script'] == 'scripts/fetch_aaii.py')
            entry['depends_on'] = ['scripts/fetch_yields.py']
            path.write_text(json.dumps(manifest))
            self.assertIn('runs after', '\n'.join(check(root)))

    def test_dry_run_never_invokes_git_or_fetch(self):
        with tempfile.TemporaryDirectory() as temp:
            bin_dir = Path(temp)
            for executable in ('git', 'python3'):
                stub = bin_dir / executable
                stub.write_text('#!/bin/sh\necho unexpected >&2\nexit 99\n')
                stub.chmod(0o755)
            env = dict(os.environ, PATH=f'{bin_dir}:{os.environ["PATH"]}')
            result = subprocess.run(['bash', str(ROOT / 'scripts/update_all.sh'), '--dry-run'],
                                    env=env, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('DRY-RUN required: fetch_stocks.py', result.stdout)
            self.assertNotIn('unexpected', result.stdout + result.stderr)

    def test_required_failure_exits(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            scripts = root / 'scripts'
            scripts.mkdir()
            (scripts / 'update_all.sh').write_bytes((ROOT / 'scripts/update_all.sh').read_bytes())
            fake = root / 'python'
            fake.write_text('#!/bin/sh\nexit 9\n')
            fake.chmod(0o755)
            result = subprocess.run(['bash', str(scripts / 'update_all.sh')],
                                    env=dict(os.environ, PYTHON=str(fake)), capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn('FAILED required: fetch_stocks.py', result.stderr)

    def test_optional_failure_is_reported_without_hiding_success(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            scripts = root / 'scripts'
            scripts.mkdir()
            (scripts / 'update_all.sh').write_bytes((ROOT / 'scripts/update_all.sh').read_bytes())
            fake_python = root / 'python'
            fake_python.write_text('#!/bin/sh\n'
                                   'if [ "$1" = fetch_aaii.py ]; then exit 9; fi\n'
                                   'if [ "$1" = -c ]; then echo 2026-10-02T00:00:00Z; fi\n'
                                   'exit 0\n')
            fake_python.chmod(0o755)
            fake_node = root / 'node'
            fake_node.write_text('#!/bin/sh\nexit 0\n')
            fake_node.chmod(0o755)
            result = subprocess.run(['bash', str(scripts / 'update_all.sh')],
                                    env=dict(os.environ, PYTHON=str(fake_python),
                                             PATH=f'{root}:{os.environ["PATH"]}'),
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('optional:fetch_aaii.py', result.stderr)

    def test_sync_refuses_dirty_data(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            scripts = root / 'scripts'
            scripts.mkdir()
            (scripts / 'update_all.sh').write_bytes((ROOT / 'scripts/update_all.sh').read_bytes())
            fake_git = root / 'git'
            fake_git.write_text('#!/bin/sh\n'
                                'case "$*" in *"branch --show-current"*) echo main;;'
                                ' *"status --porcelain"*) echo " M data/SPY.json";; esac\n')
            fake_git.chmod(0o755)
            result = subprocess.run(['bash', str(scripts / 'update_all.sh'), '--dry-run', '--sync-data'],
                                    env=dict(os.environ, PYTHON='python3',
                                             PATH=f'{root}:{os.environ["PATH"]}'),
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn('Refusing sync', result.stderr)


if __name__ == '__main__':
    unittest.main()
