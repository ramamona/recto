# CODEX.md

Codex reads `AGENTS.md` natively — that file is the canonical guide. This file only adds Codex notes.

- For CV/job assistant work, load `agent/recto.md`, `agent/writing.md`, `agent/grammar.md` and the relevant `agent/modes/*.md`, then follow `agent/modes/cli.md`.
- Run in a sandbox that allows `node`; the Recto tools need no network except `evaluate --job <url>` and PDF export (local Chromium).
- Propose edits as `edits.json` and apply them with `node cli/recto.js apply` only after the user approves.
