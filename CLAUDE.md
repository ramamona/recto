# CLAUDE.md

Read `AGENTS.md` — it is the canonical guide for both contributors and CV-assistant use.

Claude Code notes:
- For CV writing, review, tailoring, job evaluation, cover letters or ATS checks, use the `recto` skill (`.claude/skills/recto/SKILL.md`).
- Show every CV change as a diff and wait for approval before writing files; use `node cli/recto.js apply` rather than editing CV files directly.
- No git write commands unless the user asks.
