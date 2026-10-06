"""The local updater must preserve the macro archive, including untracked segments."""
from pathlib import Path
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'update_all.sh'


class ArchivePreservationTest(unittest.TestCase):
    def test_no_destructive_git_archive_operations(self):
        source = SCRIPT.read_text()
        for banned in ('git clean', 'git checkout', 'git restore', 'git reset', 'rm -rf'):
            self.assertNotIn(banned, source)

    def test_macro_refresh_is_explicit(self):
        source = SCRIPT.read_text()
        self.assertIn('run_script optional fetch_us_macro_diagnostic.py', source)
        self.assertIn('validate_us_macro.py', source)


if __name__ == '__main__':
    unittest.main()
