# Career suite

The career suite is everything in Recto that goes beyond a single CV: a detailed candidate profile with country presets and an answer bank you fill in once, a one-click apply queue that fills forms in bulk, a full job workspace per posting, and the analysis and prep tools it takes to run a real job search — evaluate, compare, track, research, prepare for interviews and negotiate an offer. It builds on the [job tracker and AI job evaluation](assist.md#job-evaluation); read that first if you're new to Recto's jobs features.

Everything here follows the same rules as the rest of Recto: it's local-first and works with no AI connected, a human decides every application and every accepted AI suggestion, and Recto never solves a CAPTCHA, signs you in or creates an account anywhere. The mode-by-mode parity with [career-ops](https://github.com/career-ops-hq/career-ops) — the CLI tool this suite draws its feature set from — is listed at the bottom of this page.

## Candidate profile

Open **Candidate profile** from the top bar, the command bar (`⌘K` / `Ctrl K`), or the Job tab. It replaced the old single-page applicant form with a full view: a section list on the left, and a country select at the top that drives everything country-specific.

| Section | What it holds |
|---|---|
| Identity & contact | Name, preferred name, pronouns, email, phone, LinkedIn, GitHub, website, portfolio |
| Work rights | Address, authorized-to-work countries, work-rights status (citizen, permanent resident, visa, …), visa type and expiry, sponsorship |
| Availability & pay | Notice period, earliest start, employment types, remote preference, locations, relocation and travel, salary expectation, currency, day rate |
| Checks & clearances | Security clearance, police check, working-with-children check, background check, driver's licence, own vehicle |
| Background | Highest education, years of experience, languages, referees |
| Preferences | Target roles, deal-breakers |
| Diversity (optional) | Gender, race, veteran, disability, and — only where the country preset asks for it — Indigenous identity or LGBTQIA+ identity. Every diversity question defaults to "decline" |
| Saved answers | The answer bank: search, edit, delete, import and export as JSON |
| Story bank | STAR+R stories (situation, task, action, result, reflection) for interview answers and screening questions |

Every field is optional. Leaving one blank simply skips whatever it would have gated (a work-authorization check, a deal-breaker match); Recto never guesses. A completeness meter ("12 of 18 common questions answered") lists what's still unanswered and links straight to it.

### Country presets

The country select at the top of the profile — and Discover's own country filter — chooses a **preset**: states or provinces for the address field, the local currency, the wording for retirement contributions (superannuation, KiwiSaver, a pension, 401(k), RRSP, …), the checks that country's applications usually ask for, suggested clearance levels, and country-specific feed codes for the sources in [Discover](#discover). Recto ships presets for Australia, New Zealand, the United Kingdom, the United States, Canada, Ireland, Germany, France, Singapore and India; a country without a preset still works with the generic fields. The active country is your profile's `country`, or failing that the one detected from your browser's time zone and language, or the built-in default. None of this narrows what jobs you can see by default — it only shapes which fields and questions the app shows you.

### Saved answers (the answer bank)

Every answer you give — filling in an application pack, the apply queue's "missing answers" step, or the profile itself — is saved to the answer bank and reused the next time a similar question comes up, in any pack and in `recto autoapply`. "Similar" means the same underlying rule (for example, two different postings both asking about sponsorship) or a close enough wording match; a multiple-choice question maps the saved answer onto whatever options that form offers, and only if it can. In a pack, each editable answer has a **Remember for similar questions** checkbox, on by default, and its source badge (`profile`, `cv`, `rule`, `bank` or `ai`) shows where it came from. Manage the bank directly from **Saved answers**: search, edit, delete, or import/export it as JSON to move it between browsers.

### Story bank

Keep a small set of STAR+R stories — real examples from your CV, ready to reuse for "tell me about a time…" questions. Add them by hand, or press **Draft from my CV (AI)**, which only appears once a provider is connected: it proposes stories citing the CV lines they're built from, and any draft that can't cite a real line is dropped before you see it.

## Discover

Discover (top bar, or the command bar) scans public job boards and ranks what it finds against your CV, entirely from your browser — no Recto server in between.

| Source | What it scans |
|---|---|
| Greenhouse, Lever, Ashby | The public job-board API of each company in your list |
| SmartRecruiters | Company posting boards, filtered by country when one is active |
| Workable | Company posting boards |
| Jobicy | A remote-jobs feed, filtered by the active country's geo code; off by default, toggle it in Discover's settings |

The starter company list (`data/companies.json`) is a starting point; every source and filter is country-neutral — set your country preset and Discover filters, ranks and labels for that country. Add your own companies with the editor, or use **Find boards**: type a company name and Recto probes it across every source (Greenhouse, Lever, Ashby, SmartRecruiters, Workable) for a public board with open roles, so you don't have to guess the board name.

Filters, scoring, legitimacy checks and the Save / Skip / Prepare application actions are unchanged from before — see [Discover & apply](discover-apply.md). What's new: a checkbox on every result, **Select ★≥ {n}** to pick every result at or above a score, and **Apply to selected**, which saves the picked postings and opens the [apply queue](#one-click-apply) for them. A **Pipeline inbox** button next to Scan opens the tool below.

## Pipeline inbox

For postings you already have links or text for — from a newsletter, a recruiter email, a spreadsheet — **Pipeline inbox** (Discover's header, or the command bar) is a paste-and-process queue instead of a scan. Paste one link per line, or whole job descriptions separated by a blank line, then **Process all**. Each item is fetched (or asked for the text, when it can't be), parsed, evaluated locally, scored against your CV, optionally deep-evaluated with AI when you tick that on, saved to the tracker and built into an application pack — automatically, two at a time. Duplicates against your tracker or the current queue are flagged, not reprocessed. A failed item keeps its text in an editable box with **Retry**. When it's done, **Apply to processed** sends everything still in Saved to the apply queue.

## One-click apply

Once you've picked jobs — from the board's **Apply to all saved**, a multi-select's **Apply to selected**, Discover's selection, or Pipeline's **Apply to processed** — the apply queue does the rest in three steps.

1. **Prepare.** It builds (or reuses) an application pack for every job: a tailored CV, a cover letter if you draft one, and each posting's own application questions answered from your profile, the answer bank, and AI for free-text questions only.
2. **Missing answers.** Every required question across all the packs that's still unanswered is shown once, grouped with the other jobs asking essentially the same thing ("Asked by 4 jobs"). Answer it once and it's saved to your profile's answer bank and fills every pack at once. You can skip a question; those jobs simply stop for you to finish by hand later.
3. **Run.** Pick a mode — **Fill forms and stop before Submit** (the default) or **Submit when every guard passes**, which needs a confirmation checkbox ("I have reviewed the packs and I am responsible for these applications") — plus a minimum score (default 4.0) and a daily cap (default 10), then **Start**.

### The local bridge

Running Recto locally with `node serve.js`, the queue drives `recto autoapply` for you through a small bridge: it starts the run, shows each job's live state (queued, filling, waiting for you, submitted, filled, blocked, with a reason), lets you answer **"I submitted it" / Skip** for a job it's waiting on, and **Stop** the whole run. **The bridge only exists when the server is bound to a loopback address** (`127.0.0.1`/`localhost`, the default) — the same restriction as the `/api/fetch` job-link proxy — and it checks the request's origin and a per-run token on every call, so a page on another origin can never reach it. See [self-hosting.md](self-hosting.md#the-apiapply-bridge) for the exact guarantees, and [cli.md](cli.md#autoapply) for what `recto autoapply` itself does and its guards.

**On a hosted instance (no bridge)**, the queue instead downloads one `recto-apply.json` bundle — every prepared job, your CV and your profile in one file — and shows you the exact command to run it yourself:

```sh
node cli/recto.js autoapply --bundle recto-apply.json           # fill, review and submit yourself
node cli/recto.js autoapply --bundle recto-apply.json --submit  # submit once every guard passes
```

Either way, autoapply never solves a CAPTCHA, never signs in and never creates an account, and it submits only in **Submit when every guard passes** mode, only once every guard (score, daily cap, no empty required field, no CAPTCHA/login/account wall) passes for that job. Every application it does submit is still logged, and the tracker is updated per job either way.

## Job workspace

Click a card on the [jobs board](assist.md#jobs-board) and its drawer now opens as a full workspace with a tab strip:

| Tab | What it does |
|---|---|
| Overview | The evaluation, notes, status history — plus, once a job is Rejected, an outcome stage and reason |
| Pack | The application pack summary and a shortcut into the apply queue for this one job |
| Research | Your notes, an AI research brief (marked unverified) about the company, and the posting's legitimacy signals |
| Outreach | Contacts for this job (name, role, kind, link, note) and an AI-drafted note per contact, plus an application-email draft |
| Interview | Interview records, an AI prep doc mapped to your story bank, a time-blocked plan, and a practice loop (pick or type a question, answer it, get AI feedback and a next question) |
| Offer | Offer fields, a deterministic salary-gap table (desired vs. advertised vs. offered), a negotiation script, and a pasted-contract walk-through (clearly labelled: not legal advice) |
| Follow-ups | A cadence of suggested follow-ups (applied +7/+14 days, interview thank-you +1 day, check-in +7 days) with a done checkbox each, and **Paste a reply** to classify an email (rejection, interview, offer, info request, auto-ack) and move the card |

Every AI panel needs a connected provider — without one it shows **Connect AI providers** and the deterministic parts (Overview, the salary-gap table, follow-up cadence, reply classification's first pass) still work on their own. Every AI result is a draft you can regenerate or copy; nothing is sent anywhere on its own.

Multi-select cards on the board (the checkbox on each card) to unlock **Compare** and **Apply to selected**, and the drawer no longer competes with them — clicking one card still opens its own workspace.

## Compare

Select 2 to 5 jobs on the board and press **Compare** for a side-by-side table: score, match, gates, compensation, location and the first few gaps for each job, plus an optional AI recommendation across all of them. It's read-only — decide there, then act from the board or a job's own workspace.

## Insights

**Insights** (the board header, or the command bar) is a full-screen view over everything the tracker has recorded:

- **Funnel** — saved → applied → responded → interview → offer, with the conversion rate at each step, and a CSV export.
- **Response rates**, grouped by source, ATS, score band or remote policy.
- **Score calibration** — the interview rate for each ★ band, so you can see whether your own scoring is predictive.
- **Rejections** — by stage and by reason.
- **Reposts and ghost suspects** — the same role appearing again under a new id, or re-dated after you first saw it.
- **Top skill gaps** across every evaluation you've run, with an AI-drafted upskilling plan.
- **Adjacent titles** seeded from your target roles and the archetypes you've actually evaluated, each with **Add to target roles**; also an AI title-suggestion button.
- **Career advice** — paste a course, certification or portfolio-project idea and get an AI read on it against your target roles.

Every card has its own empty state, and the deterministic cards (funnel, rates, calibration, rejections, reposts) never need AI.

## LaTeX export

Alongside PDF, plain text and JSON Resume, **Export → LaTeX (.tex)** in the top bar writes a self-contained LaTeX `article` — only the `geometry`, `hyperref` and `enumitem` packages, which every TeX distribution ships — following your document's own section order and layout (hidden sections and column reading order included). The same conversion is available on the CLI as `recto export cv.cv.json -o cv.tex`. It's a deterministic, local conversion; no AI and no network involved. See [cli.md](cli.md#export).

## `recto discover`

Everything Discover does in the browser is also a CLI command, for a scheduled or scripted scan:

```sh
node cli/recto.js discover --country GB --out jobs.json --min-score 3.5
```

See [cli.md](cli.md#discover) for every flag.

## career-ops parity

Recto's career suite reimplements every mode of [career-ops](https://github.com/career-ops-hq/career-ops), a CLI job-search assistant, as UI-first features that share Recto's own deterministic scoring and the same no-fabrication rule everywhere AI is involved:

| career-ops | Recto |
|---|---|
| `auto-pipeline`, `pipeline`, `batch` | [Pipeline inbox](#pipeline-inbox) |
| `oferta` | The Job tab's local evaluation (see [assist.md](assist.md#job-evaluation)) |
| `ofertas` | [Compare](#compare) |
| `scan`, `discover` | [Discover](#discover), Find boards, [`recto discover`](#recto-discover) |
| `pdf`, `text`, `latex` | PDF and plain-text export, plus [LaTeX export](#latex-export) |
| `cover`, `email` | The cover-letter draft, plus the job workspace's application-email draft |
| `contacto` | The Outreach tab's contacts and per-contact notes |
| `deep` | The Research tab's company-research brief (marked unverified) |
| `interview-prep`, `interview`/`plan`, `practice`, `debrief` | The Interview tab: prep doc, time-blocked plan, practice loop, debrief notes |
| `interview-redflag` | Red-flag signals on the Research tab |
| `offer-prep`, `negotiation`, `salary-gap` | The Offer tab: fields, salary gap, negotiation script, contract walk-through |
| `followup`, `reply-watch`, `outcome` | The Follow-ups tab: cadence, overdue badges, reply classification, outcome stage |
| `patterns`, `stats`, `detect-reposts`, `calibrate`, `upskill`, `titles` | [Insights](#insights) |
| `training`, `project` | Insights' career-advice card |
| `add`, `expand` | "Add to CV" (paste a project or role → a diff card, same human-approval flow as any other suggestion) |
| `interview` (onboarding) | [Candidate profile](#candidate-profile) and its completeness meter |

Not ported: a plugin system, a TUI dashboard (the jobs board covers that), CLI housekeeping commands, funded-company feeds (there's no free structured source for them), and anything that sends a message or submits on its own — Recto never does either.
