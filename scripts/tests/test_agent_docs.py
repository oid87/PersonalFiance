import importlib.util
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("sync_agent_docs", SCRIPTS / "sync_agent_docs.py")
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


class AgentDocsTest(unittest.TestCase):
    def test_render_rewrites_title_note_and_skill_paths(self):
        out = sync.render_agents_md("# CLAUDE.md — X\n\nsee `.claude/skills/add-tab/`\n")
        lines = out.split("\n")
        self.assertEqual(lines[0], "# AGENTS.md — X")
        self.assertIn("自動產生", lines[2])
        self.assertIn("`.agents/skills/add-tab/`", out)
        self.assertNotIn(".claude/skills/add-tab/", out)

    def test_render_keeps_bare_claude_layout_prose(self):
        out = sync.render_agents_md("# CLAUDE.md — X\nClaude 讀 `.claude/skills/`;Codex 讀 `.agents/skills/`\n")
        self.assertIn("Claude 讀 `.claude/skills/`", out)

    def test_render_rejects_unexpected_heading(self):
        with self.assertRaises(RuntimeError):
            sync.render_agents_md("# Something else\n")

    def test_committed_agent_docs_are_in_sync(self):
        # Fails when CLAUDE.md (or local .claude/skills) changed without re-running the sync.
        self.assertEqual(sync.main(check=True), 0)


if __name__ == "__main__":
    unittest.main()
