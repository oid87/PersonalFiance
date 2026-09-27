"""Run update_all.sh's archive cleanup guard in disposable Git repositories."""

import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "update_all.sh"


def cleanup_guard():
    source = SCRIPT.read_text(encoding="utf-8")
    match = re.search(
        r'(?ms)^if git -C "\$ROOT_DIR" ls-files --error-unmatch '
        r'data/us_macro_archive/manifest\.json >/dev/null 2>&1; then\n.*?^fi$',
        source,
    )
    if match is None:
        raise AssertionError("archive cleanup guard missing from update_all.sh")
    return match.group()


class ArchiveCleanupGuardTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        self.archive = self.root / "data" / "us_macro_archive"
        self.archive.mkdir(parents=True)

    def write(self, relative, content):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return path

    def run_guard(self):
        env = os.environ.copy()
        env["ROOT_DIR"] = str(self.root)
        subprocess.run(["bash", "-e", "-c", cleanup_guard()], env=env, check=True)

    def test_first_import_preserves_untracked_archive_bytes(self):
        manifest = self.write("data/us_macro_archive/manifest.json", b'{"events":1}\n')
        segment = self.write("data/us_macro_archive/segments/one.json", b"\x00original\xff")
        outside = self.write("data/elsewhere.json", b"other data\n")
        before = {path: path.read_bytes() for path in (manifest, segment, outside)}

        self.run_guard()

        self.assertEqual({path: path.read_bytes() for path in before}, before)

    def test_tracked_manifest_cleans_only_untracked_archive_orphans(self):
        manifest = self.write("data/us_macro_archive/manifest.json", b'{"events":1}\n')
        segment = self.write("data/us_macro_archive/segments/one.json", b"kept segment\n")
        orphan = self.write("data/us_macro_archive/segments/orphan.json", b"orphan\n")
        outside = self.write("data/elsewhere.json", b"other data\n")
        subprocess.run(
            ["git", "-C", str(self.root), "add", "data/us_macro_archive/manifest.json", "data/us_macro_archive/segments/one.json"],
            check=True,
        )

        self.run_guard()

        self.assertEqual(manifest.read_bytes(), b'{"events":1}\n')
        self.assertEqual(segment.read_bytes(), b"kept segment\n")
        self.assertFalse(orphan.exists())
        self.assertEqual(outside.read_bytes(), b"other data\n")


if __name__ == "__main__":
    unittest.main()
