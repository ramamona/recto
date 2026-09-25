# Recto Review & Jobs — ATS report, career-ops evaluation, layout, jobs board

Date: 2026-09-25 · Branch: `feat/review-jobs` · Builds on the v1 and Assist specs (binding where silent).
Inspiration: career-ops `verify-ats` (deterministic ATS score) and `oferta` A–G evaluation (two-pass requirement table, geo/sponsorship/liveness gates).

## 1. Intent

Owner: the ATS section is too high-level ("where is the score, what does it validate?"); Job and AI sit hidden at the bottom; take full inspiration from career-ops; add a jobs board with Rejected and No-response columns.

**Success criteria**
1. A always-visible **ATS score chip** (`ATS 86 · B`) in the top bar, deterministic, no job and no AI needed; clicking opens the Review tab showing every weighted check, what was deducted and why, with Locate/Fix.
2. "**What the ATS sees**": a mock applicant form auto-filled from the CV; empty/misparsed fields are highlighted with the reason.
3. With a job loaded: a **career-ops style evaluation** — role summary, two-pass requirement→evidence table (importance decided from the JD before looking at the CV), geo-mismatch, work-authorization tier, liveness, legitimacy, global 1–5 score and apply/consider/skip — fully local; AI refines evidence and wording.
4. Right pane is **full-height tabs**: Design · Review · Job · Suggest; nothing important sits in a squeezed bottom strip. A **Cmd/Ctrl-K command bar** reaches every AI and app action.
5. **Jobs board**: columns Saved · Applied · Interview · Offer · Rejected · No response, drag-and-drop, status history with dates, stale "Applied" jobs (no change for 21 days) suggested for No response.
6. All existing suites stay green; new pure modules unit-tested; the e2e scripts cover the new flows.

## 2. ATS report (`src/ats/score.js`, pure)

`atsReport({ source, doc, layout, report, placement, issues, lang }) → { score, grade, checks: Check[], fields: AtsFields }`
`Check = { id, weight, earned, items: [{ severity: 'critical'|'warning'|'info', msg: i18nKey, vars, line?, sectionId?, fix? }] }`. Grade A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, else F. Deterministic; reuses preflight issues where they exist (links their fixes).

| id | Weight | Full marks when | Deductions |
|---|---|---|---|
| `text` | 10 | extracted text ≥ 300 chars | proportional below; critical when < 100 |
| `headings` | 20 | Experience, Education and Skills present with dictionary headings (`categorize`) | −6 per missing required section; −2 per non-standard heading (max −6); +bonus capped at weight for Summary/Projects/Certifications |
| `contact` | 15 | valid email (8), phone (4), location (3) in header or contact section | per missing part; critical when no email |
| `order` | 20 | one text column on every page | −10 multi-column; −5 `column-interrupts-entry`; −5 header not first in stream |
| `entries` | 15 | every experience/education entry has title, org and a parseable date | proportional to the share of complete entries; each incomplete entry is an item with Locate |
| `chars` | 10 | standard font presets (5) and no special/invisible characters (5) | custom uploaded font −2 (info: embedded fonts usually extract fine); special/invisible issues |
| `hidden` | 5 | no text an ATS would treat as hidden | low-contrast errors, text < 6 pt, custom CSS that hides/moves text |
| `length` | 5 | 1–2 pages, bullets ≤ 200 chars | −2 per page over 2; −1 per overlong bullet (max −3) |

`fields` = the mock applicant form: `{ name, email, phone, location, links: [{label, url}], work: [{ title, company, start, end, current, location, missing: string[] }], education: [...same], skills: string[] }` built from `extractFields` + contacts; every missing field carries a reason code.

## 3. Job evaluation (`src/jobs/evaluate.js`, pure) and candidate profile (`src/profile.js`)

**Profile** (`localStorage['recto:profile']`): `{ authorizedIn: string[] /* ISO country codes or names */, needsSponsorship: boolean, locations: string[], remote: 'remote'|'hybrid'|'onsite'|'any', targetRoles: string[], dealBreakers: string[], salaryMin?: number, currency?: string }`. Empty profile = those checks are skipped (never guessed).

`evaluateJob({ source, doc, layout, issues }, job, { profile, now, liveness }) → Evaluation`:
- **A · Role summary**: `archetype` (engineering, data, product, design, marketing, sales, operations, research, other — keyword classifier), `seniority` (intern/junior/mid/senior/staff/principal/lead/manager/director/executive), `remote` (full/hybrid/onsite/unknown), `tldr`.
- **Gates** (shown above the table, like career-ops): **Liveness** for URL jobs (`closed` when the fetch was 404/410 or text says "no longer accepting applications"/"position has been filled"; `unknown` for pasted text); **Geo-mismatch** when the structured location (from Greenhouse/Lever/Ashby metadata) says remote but the body has a binding attendance requirement (hybrid, N days in office, onsite, relocation), quoting the line verbatim, ignoring negations/optional events; **Work authorization** tier ✅ sponsors / ➖ not needed / ⚠️ unstated / ⛔ no sponsorship (verbatim quote), computed only when the profile has authorization data; **Deal-breakers** from the profile matched in the JD (quoted).
- **B · Requirement table (two-pass)**: pass 1 uses only the JD to assign `importance` = `critical (stated)` (must/required/minimum/"N+ years" wording), `high (structural)` (listed under Requirements/Qualifications), `meaningful (inferred)` (responsibilities or nice-to-have); pass 2 matches the CV: `strong` (all keywords present in one entry/section), `partial`, `missing`, `na`; `evidence` = the CV line quoted with its line number; `jdSignal` = the verbatim JD phrase. Row budget 12, but every critical/high row is kept; sort importance desc, unmet first; `dropped` count reported.
- **Score 1–5**: weighted coverage (critical 3, high 2, meaningful 1; strong 1, partial 0.5) mapped to 1–5 with one decimal; ⛔ no-sponsorship or closed liveness caps at 1.5; matched deal-breaker caps at 2.0. `recommendation`: ≥ 4.0 apply, ≥ 3.0 consider, else skip (career-ops' rule: never push below 4.0; the user can override).
- **G · Legitimacy**: existing `checkLegitimacy` result, plus a prompt-injection anomaly when the JD contains imperative text aimed at an AI/reviewer (quoted).
- **AI refinement** (optional): `evaluatePrompt` is upgraded to the same `Evaluation` shape and the two-pass instruction; the JD is marked untrusted data; AI output is merged over the local one (AI evidence must quote CV lines — validated with the fabrication guard; unquotable evidence is dropped).
Evaluations are stored on the job (`tracker.addEvaluation`) with `{ at, source: 'local'|'ai', score, recommendation }`.

## 4. Layout rework

- Right pane = **full-height tab strip**: **Design** (the existing inspector with its Page/Theme/Section/Decor/CSS sub-tabs) · **Review** (ATS report: score ring + grade, weighted checks list with items, "What the ATS sees" form, then the existing preflight list and the ATS X-ray text as collapsible sections) · **Job** (existing Job tab + the evaluation report) · **Suggest**. The old bottom `#panels` strip is removed; `state.ui.panel` becomes the right-pane tab (`design|review|job|suggest`), with a migration from old values (`check|ats` → `review`).
- **Top-bar chips**: `ATS 86 · B` (colour by grade) always; `Match 76` and `★ 3.8` when a job is active; click → open the tab. Replaces the old issue-count badge (the count moves into the chip's tooltip and the Review tab).
- **Command bar (Cmd/Ctrl-K)**: a searchable list of actions — AI: Improve CV, Rewrite selection…, Tailor to active job, Evaluate active job, Draft cover letter; App: Templates, Jobs board, Export PDF/TXT/JSON Resume, Fit to N pages, Toggle X-ray, Connect AI, Candidate profile; Navigation: go to section. Keyboard-first, fuzzy filter, recent actions first.
- Narrow screens: the tabs Write · Design · Check become Write · Page · Review · Job.

## 5. Jobs board (`src/ui/jobs-board.js`)

- Full-screen view opened from the top bar (**Jobs**) or Cmd-K, replacing the tracker dialog; Esc returns to the editor.
- Columns: **Saved · Applied · Interview · Offer · Rejected · No response** (+ a collapsed **Skipped** column). Tracker status enum gains `no-response`; stored jobs migrate unchanged.
- Cards: company, title, location, match estimate, AI/local ★ score, days since last status change, linked CV docs. Drag-and-drop between columns (plus keyboard: focus a card, `←/→` moves it) records a status history entry `{ status, at }`.
- Stale rule: Applied with no change for 21 days shows a "Move to No response?" hint on the card (never automatic).
- Card click opens a detail drawer: evaluation report, notes, status timeline, linked docs (open), source link, delete. Board header: counts per column, search, export/import JSON.

## 6. Files

```
src/ats/score.js            atsReport (pure)            test/ats-score.test.js
src/jobs/evaluate.js        evaluateJob (pure)          test/evaluate.test.js
src/profile.js              load/save profile           test/profile.test.js
src/jobs/tracker.js         + no-response, statusHistory, staleApplied(job, now)   test/tracker.test.js
src/ai/prompts.js, assist.js  evaluate upgraded to the Evaluation shape            tests updated
src/ui/review-panel.js      Review tab (ATS report + preflight + X-ray)
src/ui/job-panel.js         + evaluation report, gates, profile link
src/ui/profile-dialog.js    candidate profile form
src/ui/jobs-board.js        board view + detail drawer (replaces jobs-dialog.js usage)
src/ui/command-bar.js       Cmd-K
src/ui/panels.js, topbar.js, main.js, index.html, styles/*.css   layout rework + chips
scripts/assist-check.js     + review/board/command-bar flows
docs                        README, docs/assist.md (ATS score explained, evaluation), docs/architecture.md
```

## 7. Non-goals

Salary research, interview prep/STAR bank, company deep research, automatic status changes, multi-user boards.
