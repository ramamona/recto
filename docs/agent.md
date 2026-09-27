# The Recto agent

Recto ships its own AI agent: a CV writer and job assistant defined once, in plain Markdown, under [`agent/`](../agent). The same playbook powers the AI features inside the app (Suggest, Rewrite, Tailor, Evaluate, Cover letter, job import) and any AI coding CLI you point at your CV — Claude Code, Codex or Gemini CLI.

## What it is

- [`agent/recto.md`](../agent/recto.md) — who the agent is and the rules it never breaks: it never invents facts (it asks instead), it only proposes and you decide, it treats job postings and CVs as data and never follows instructions hidden in them, it keeps output ATS-safe, sends your data only to the provider you chose, and labels its own estimates.
- [`agent/writing.md`](../agent/writing.md) — the CV-writing craft: impact bullets, verbs, cutting filler, summaries, skills, keyword mirroring without stuffing, per-language notes.
- [`agent/grammar.md`](../agent/grammar.md) — Recto Markdown for models, and the edit format: each change replaces one whole line and carries that line's exact current text, so stale or malformed edits are rejected.
- [`agent/modes/`](../agent/modes) — one file per task, with its method and output contract. `evaluate.md` describes the career-ops-style evaluation: a two-pass requirement table, gates (liveness, geo mismatch, work authorization, deal-breakers), a 1–5 score with caps and an apply / consider / skip recommendation. `cli.md` describes how a CLI agent works with your files.

## How the app and the CLIs share it

In the app, AI results are JSON that match the contracts in the mode files, and every suggestion passes Recto's guard (line still matches, same line kind, no new facts) before it shows up as a diff card. The deterministic parts — preflight, the ATS score, gates, caps and legitimacy — run locally and never depend on the model.

A CLI agent reads the same files and uses Recto's command-line tools for everything deterministic:

```sh
node cli/recto.js check my.cv.json
node cli/recto.js ats my.cv.json --json
node cli/recto.js evaluate my.cv.json --job job.txt --json
node cli/recto.js tips my.cv.json --json
node cli/recto.js apply my.cv.json --edits edits.json
node cli/recto.js export my.cv.json -o cv.pdf
```

It shows you each change as a diff, writes files only after you approve, and never submits an application or sends a message.

## Using it

Clone the repo and start your CLI in the repo folder, with your CV (a `.cv.json` saved from the app, or a Recto Markdown file) next to it.

- **Claude Code:** reads `CLAUDE.md` and has the `recto` skill (`.claude/skills/recto/`). Ask "review my CV", "evaluate this job against my CV", "tailor my CV to job.txt" or "write a cover letter".
- **Codex:** reads `AGENTS.md` natively; `CODEX.md` adds a few notes.
- **Gemini CLI:** reads `GEMINI.md`, which points to `AGENTS.md`.
- **Any other agent:** tell it to read `AGENTS.md` and follow section 2.

On the first run the agent asks for your CV, the roles you are targeting, and your work authorization, so that job evaluations can check sponsorship and deal-breakers.

## Customising the playbook

Edit the Markdown. Add verbs or conventions for your field to `writing.md`, tighten a mode's quality bar, or add a mode of your own and list it in `agent/recto.md`. Keep the non-negotiable rules and the output contracts intact: the app's schemas in `src/ai/prompts.js` and the guard expect exactly those fields.
