from pathlib import Path
import json
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

ROOT = Path(__file__).resolve().parents[2]


class PipelineTest(unittest.TestCase):
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
