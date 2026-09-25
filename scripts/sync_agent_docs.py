"""Generate the Codex/ChatGPT-facing agent docs from the Claude-facing ones.

Source of truth (edit these):  CLAUDE.md, .claude/skills/**
Generated (never edit by hand): AGENTS.md, .agents/skills/**

    python3 scripts/sync_agent_docs.py          # regenerate
    python3 scripts/sync_agent_docs.py --check  # exit 1 if generated files are stale

.claude/ is git-ignored (local only). On a checkout without .claude/skills/ the skills
step is skipped and the tracked .agents/skills/ copy is left as is.
"""
from __future__ import annotations

import filecmp
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLAUDE_MD = ROOT / "CLAUDE.md"
AGENTS_MD = ROOT / "AGENTS.md"
CLAUDE_SKILLS = ROOT / ".claude" / "skills"
AGENTS_SKILLS = ROOT / ".agents" / "skills"
SKILL_PATH_RE = re.compile(r"\.claude/skills/([A-Za-z0-9_-]+/)")

GENERATED_NOTE = (
    "> 本檔由 `CLAUDE.md` 自動產生（`python3 scripts/sync_agent_docs.py`），**勿直接編輯**；"
    "要改請改 `CLAUDE.md` 後重跑。Codex / ChatGPT 讀本檔與 `.agents/skills/`，"
    "Claude Code 讀 `CLAUDE.md` 與 `.claude/skills/`，內容相同。"
)


def render_agents_md(claude_text: str) -> str:
    # Only concrete skill paths (`.claude/skills/<name>/`) are rewritten; prose that describes
    # the Claude-side layout itself (bare `.claude/skills/`) must stay as is.
    text = SKILL_PATH_RE.sub(r".agents/skills/\1", claude_text)
    lines = text.split("\n")
    if not lines[0].startswith("# CLAUDE.md"):
        raise RuntimeError("CLAUDE.md must start with '# CLAUDE.md' heading")
    lines[0] = lines[0].replace("# CLAUDE.md", "# AGENTS.md", 1)
    lines[1:1] = ["", GENERATED_NOTE]
    return "\n".join(lines)


def skill_files(base: Path) -> set[Path]:
    return {p.relative_to(base) for p in base.rglob("*") if p.is_file()} if base.exists() else set()


def main(check: bool) -> int:
    stale: list[str] = []

    want = render_agents_md(CLAUDE_MD.read_text())
    if not AGENTS_MD.exists() or AGENTS_MD.read_text() != want:
        stale.append("AGENTS.md")
        if not check:
            AGENTS_MD.write_text(want)

    if CLAUDE_SKILLS.exists():
        src, dst = skill_files(CLAUDE_SKILLS), skill_files(AGENTS_SKILLS)
        for rel in sorted(src):
            s, d = CLAUDE_SKILLS / rel, AGENTS_SKILLS / rel
            if not d.exists() or not filecmp.cmp(s, d, shallow=False):
                stale.append(f".agents/skills/{rel}")
                if not check:
                    d.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(s, d)
        for rel in sorted(dst - src):
            stale.append(f".agents/skills/{rel} (removed upstream)")
            if not check:
                (AGENTS_SKILLS / rel).unlink()
    else:
        print("note: .claude/skills/ not present — skills sync skipped")

    if check:
        if stale:
            print("stale (run python3 scripts/sync_agent_docs.py):\n  " + "\n  ".join(stale))
            return 1
        print("agent docs in sync")
        return 0
    print("updated:\n  " + "\n  ".join(stale) if stale else "already in sync")
    return 0


if __name__ == "__main__":
    sys.exit(main(check="--check" in sys.argv[1:]))
