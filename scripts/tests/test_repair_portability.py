from pathlib import Path
from unittest import TestCase, mock
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import run_checks



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
