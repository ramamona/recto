# Recto Career Suite — design spec

Date: 2026-09-28 · Branch `feat/career-suite` (on top of `feat/discover-apply`) · Builds on v1, Assist, Review & Jobs and Discover & Apply specs (binding where silent).

## 1. Intent
Owner: "Bring in all features from career-ops and merge them together. Prepare application asks a set of questions — save similar questions in the candidate profile and reuse them to autofill and submit. Prepare a detailed candidate profile. Reduce manual overload; apply to all jobs with one click. Focus on Australian candidates for now and start hunting Australian jobs, but keep the documentation neutral."

Decisions:
- **Neutral product, country presets.** Region logic lives in `src/jobs/region.js` (already written by the controller: `REGIONS`, `DEFAULT_COUNTRY = 'AU'`, `countryOf`, `regionOf`, `mentionsCountry`, `inArea`, `countriesIn`, `authorizedFor(authorizedIn, text)`, `detectCountry({ timeZone, language })`). The active country = profile `country` → else detected from the browser → else `DEFAULT_COUNTRY`. Presets give states, currency, retirement wording (super, KiwiSaver, 401(k)…), clearance levels, checks (police check, working-with-children, background check), extra diversity questions (e.g. Indigenous identity for AU) and feed country codes. Docs describe "country presets", never "for Australian candidates". The starter company list and defaults are simply rich in Australian employers.
- **Answer bank.** Every answer the candidate gives (in a pack, the apply queue or the profile) is saved to the profile and reused for similar questions everywhere (app packs, `recto autoapply`). Similar = same rule (pack.js `ruleOf`) or ≥ 0.6 token similarity after normalization; choice questions map the saved answer onto the offered options.
- **One click.** "Apply to selected" (Discover) / "Apply to all saved" (Jobs board) opens an apply queue: builds packs for every job, asks each still-unanswered required question **once** (answers go to the bank and refill every pack), then runs `recto autoapply` for the whole queue through a local bridge in `serve.js` (loopback only). Hosted (no bridge): downloads one bundle file and shows the one command to run. Guards from the Discover & Apply spec §4 stay: never solves CAPTCHAs, never logs in or creates accounts; submit only in "Submit when every guard passes" mode, which the user turns on explicitly per run.
- **career-ops parity, UI-first.** Every career-ops mode that makes sense in a UI becomes a Recto feature (table §6). AI output is always a draft, never sent anywhere; the no-fabrication rule binds every mode.

Success criteria
1. Discover scans Australian roles out of the box: SmartRecruiters (country filter), Workable, Jobicy (geo filter) + an AU-rich starter company list; location filters understand states/cities/APAC.
2. Candidate profile is a full view with sections, country-aware fields, saved answers and a story bank; one fill covers typical application forms.
3. A second pack for a job with a similar question reuses the saved answer with source `bank`.
4. Apply queue: select 10 jobs → one "answer missing questions" form → run; locally Chrome fills each form, stops before Submit (or submits under guards); tracker updates per job.
5. Every career-ops mode in §6 is reachable from the job workspace, Insights view or Cmd-K, with deterministic parts unit-tested and AI parts behind the guard.
6. No regressions: all unit tests, render-check, smoke and assist-check pass.

## 2. Region and sources (`src/jobs/region.js` done; `src/jobs/sources.js`, `src/jobs/discover.js`, `src/jobs/evaluate.js`, `data/companies.json`)
- New sources (all CORS `*`, verified 2026-09-28):
  - `smartrecruiters` company boards: list `https://api.smartrecruiters.com/v1/companies/{id}/postings?limit=100&offset={n}` (+ `&country={code}` when a country is active, code from `regionOf(country).feeds.smartrecruiters`); detail `https://api.smartrecruiters.com/v1/companies/{id}/postings/{postingId}` (`jobAd.sections.*.text` HTML → text). `applyUrl` = `https://jobs.smartrecruiters.com/{id}/{postingId}`; location from `location.city/region/country`, `location.remote`. Page until `totalFound` or 300.
  - `workable` company boards: `https://apply.workable.com/api/v1/widget/accounts/{sub}` (`jobs[]`: `title, shortcode, url, application_url, city, state, country, telecommuting, published_on, description`?) — tolerate missing fields.
  - `jobicy` feed: `https://jobicy.com/api/v2/remote-jobs?count=50&geo={geo}` (geo from the preset; omitted when none); attribution "via Jobicy" + link, like Remotive.
- `Posting.source` gains these; `tracker.js` SOURCES accept them.
- `findBoards(name, { fetch })` ("career-ops discover"): slug variants of a company name (`Culture Amp` → `cultureamp`, `culture-amp`, `culture_amp`, `CultureAmp` for SmartRecruiters) probed across greenhouse/lever/ashby/smartrecruiters/workable; returns `[{ source, board, name, jobs }]` with jobs > 0. Company editor gets "Find boards" to add results.
- Discover settings gain `country` (code; default as §1) and `feeds.jobicy { enabled }`; SmartRecruiters `country` filter uses it. Location filter: a posting passes when its location `mentionsCountry(loc, country)` or matches a `locations` entry (word match) or is remote and (`inArea(loc, country)` or names no country). Remote/hybrid/onsite detection unchanged.
- `evaluate.js` drops its own `COUNTRY_ALIASES` and uses `region.js authorizedFor`; `pack.js` likewise (it may keep re-exporting `authorizedFor(p, text)` with the profile signature).
- `data/companies.json`: Australian-heavy boards first (verified with AU postings: ashby xero, airwallex, zip, dovetail, lorikeet, relevanceai, airtasker, harrison.ai, elevenlabs, cursor, sierra; greenhouse block, cultureamp, eucalyptus, databricks, datadog, mongodb, stripe, anthropic, okta, intercom, octopusdeploy, thoughtworks, buildkite, canonical, grafanalabs, elastic, vercel, gitlab, figma, airbnb, twilio; lever kogan, megaport, mable, deputy, immutable, pexa, q-ctrl, brighte, palantir; smartrecruiters Canva, SEEK, Carsales, SiteMinder, Versent, Appen), then the rest of today's list. Re-verify each returns 200 at build time; drop failures.
- CLI `recto discover [--profile p.json] [--cv cv.cv.json] [--country AU] [--companies list.json] [--out jobs.json] [--min-score 3.5]` runs `discover()` in Node and writes a tracker-format export (career-ops scan / scheduled scans).

## 3. Candidate profile v2 (`src/profile.js`, `src/jobs/answers.js`, `src/ui/profile-dialog.js`)
Profile (all optional; unknown keys dropped; old profiles load unchanged):
- identity: `firstName, lastName, preferredName, pronouns`
- contact: `email, phone, linkedin, github, website, portfolio`
- address: `street, city, state, postcode, country` (country stored as the preset name when known)
- work rights: `authorizedIn[]`, `workRights` ∈ preset `workRights` ∪ '' (citizen, permanent-resident, nz-citizen, settled-status, visa, needs-visa), `visaType` (text, e.g. "Subclass 482"), `visaExpiry` (YYYY-MM-DD), `needsSponsorship`
- availability: `noticePeriod, earliestStart` (date), `employmentTypes[]` ⊂ full-time, part-time, contract, casual, internship, `remote, locations[], willingToRelocate, willingToTravel` ∈ '', none, occasional, frequent
- compensation: `salaryMin, currency` (default preset currency), `salaryExpectation` (text), `salaryBasis` ∈ '', base, base-plus-retirement, total-package, `dayRate`
- checks: `clearance` (text; preset levels suggested), `policeCheck`, `workingWithChildren`, `backgroundCheck` ∈ '', current, willing, no; `driversLicence, ownVehicle` (boolean|null)
- background: `highestEducation, yearsExperience` (number), `languages[]`, `referees` (text; default "Available on request")
- preferences: `targetRoles[], dealBreakers[]`
- diversity: `eeo { gender, race, veteran, disability, indigenous, lgbtq }` each default `'decline'`
- `answers: [{ id, question, answer, options?, updatedAt, uses }]` (max 500; question ≤ 500 chars, answer ≤ 5000)
- `stories: [{ id, title, situation, task, action, result, reflection, tags[], sourceLines[] }]` (STAR+R story bank, max 50)
`src/jobs/answers.js` (pure): `normalizeQuestion(q)` (lowercase, strip punctuation/stop words), `similarity(a, b)` (token Jaccard 0–1), `findAnswer(bank, q, { options })` → `{ answer, entry } | null` (exact normalized → same `ruleOf` → similarity ≥ 0.6; choice answers mapped onto `options` or skipped), `remember(bank, { question, answer, options }, now)` → new bank (update in place when similar ≥ 0.85, else add; bumps `uses`), `COMMON_QUESTIONS` library (the "answer once" list: right to work in {country}, citizenship/residency, visa type and expiry, sponsorship, notice period, earliest start, salary expectation (incl. {retirement}), employment type, relocation, travel, police check, working-with-children check (when preset has it), security clearance, driver's licence, own vehicle, highest education, years of experience, languages, referees, how did you hear, diversity items (decline default)).
`pack.js`: answer order = rules (profile fields, now covering every §3 field) → bank → AI (free text) → unanswered. Source badge `bank` added. `buildPack` returns `profileUpdates` nothing — remembering is the UI's job.
Profile UI: a full-screen **Candidate profile** view (replaces the dialog body, same `openProfileDialog` entry and `data-action="profile-save"`): left section nav (Identity & contact, Work rights, Availability & pay, Checks & clearances, Background, Preferences, Diversity (optional), Saved answers, Story bank), country select at the top drives preset fields (states datalist, currency, clearance suggestions, which checks show, retirement wording, Indigenous question only when the preset lists it). A completeness meter ("12 of 18 common questions answered") links to the unanswered ones. Saved answers: search, edit, delete, import/export JSON. Story bank: add/edit/delete; "Draft from my CV (AI)" button appears when a provider is connected (calls `ctx.assist.stories()` from §6; wave B wires it).
Pack view: editing an answer saves it to the bank (debounced) — a "Remember for similar questions" checkbox per answer, on by default; unanswered required questions show "Answer & remember".

## 4. One-click apply (`src/ui/apply-queue.js`, `serve.js`, `cli/autoapply.js`)
- `openApplyQueue(store, ctx, { jobIds })`: dialog with steps
  1. Prepare: `buildPack` for each job (concurrency 2, progress, reuses stored packs, fetches Greenhouse questions as pack-view does). Tailored CV = the job's linked doc if any, else the current CV.
  2. Missing answers: every required unanswered question across all packs, grouped by similarity (answers.js) → one form, one input per group ("Asked by 4 jobs"). Saving writes the bank and refills each pack. Can skip: those jobs will stop for manual input.
  3. Run: mode radio **Fill forms and stop before Submit** (default) / **Submit when every guard passes** (needs a confirmation checkbox "I have reviewed the packs and I am responsible for these applications"), min score (default 4.0), daily cap (default 10). **Start**.
     - Bridge available (`GET /api/apply` → 200 JSON `{ bridge: true, token }`): `POST /api/apply` with `{ jobs, cv: { name, content, layout }, profile, mode, minScore, max }`; poll `GET /api/apply/status` every 1 s → per-job rows (queued, filling, waiting-for-you, submitted, filled, blocked + reason); "I submitted it" / "Skip" buttons answer a waiting job (`POST /api/apply/continue { submitted }`); **Stop** (`POST /api/apply/stop`). Each finished job updates the tracker (applied with history, or stays saved with a note of the reason).
     - No bridge: download `recto-apply.json` (bundle) and show `node cli/recto.js autoapply --bundle recto-apply.json [--submit]`.
- Bridge (`serve.js`): only when the server is bound to a loopback address (as `/api/fetch`) and the Host header is loopback. `GET /api/apply` requires `Sec-Fetch-Site: same-origin` or an Origin equal to the server origin, and returns a per-process random token. All POSTs require `Content-Type: application/json`, the same Origin check and header `X-Recto-Token`. One run at a time (409 otherwise). Writes the bundle to a temp dir, spawns `process.execPath cli/recto.js autoapply --bundle <file> --progress-json [--submit]`, parses its JSON-lines stdout into the status, forwards continue answers to its stdin. Bodies capped at 5 MB.
- `autoapply`: `--bundle file` (jobs + cv + profile in one JSON; the existing `--jobs/--cv/--profile` stay), `--progress-json` (one JSON event per line: `{ type: 'job', id, state, reason? }`, `{ type: 'wait', id }`, `{ type: 'done', summary }`; the interactive prompts then read `y`/`n` lines from stdin), bank lookup (`findAnswer(profile.answers, …)`) for form questions the pack did not cover, profile v2 fields in the rule answers, a generic label-based filler for SmartRecruiters/Workable/unknown forms that **never submits** (always stops for the user).

## 5. Tracker additions (`src/jobs/tracker.js`)
Per job, all optional and size-capped: `outcome { stage: 'screen'|'interview'|'final'|'offer'|'', reason: string, at }`, `followUps [{ due, kind: 'follow-up'|'thank-you'|'check-in', done }]`, `contacts [{ name, role, kind: 'recruiter'|'hiring-manager'|'peer'|'other', url, note }]`, `interviews [{ at, round, notes, debrief }]`, `offer { base, currency, super, bonus, equity, notes, deadline }`, `artifacts { [mode]: Brief }` (latest AI brief per §6 mode), `applyLog [{ at, result, reason }]`. SOURCES += smartrecruiters, workable, jobicy, pipeline. Export/import round-trip everything.

## 6. career-ops parity
| career-ops | Recto | Kind |
|---|---|---|
| auto-pipeline, pipeline, batch | **Pipeline inbox** in Discover: paste many URLs/JDs → fetch, evaluate, save, build pack; "Process all" | deterministic (+AI evaluate when connected) |
| oferta (A–H) | existing Evaluate (Job tab) | done |
| ofertas | **Compare** 2–5 jobs (board multi-select): side-by-side score, match, gates, comp, location, gaps + AI recommendation | deterministic + AI |
| scan, discover | Discover (§2), `findBoards`, `recto discover` | deterministic |
| pdf, text, latex | PDF/TXT exist; **LaTeX export** (`src/io/latex.js`, Export menu, `recto export --format tex`) | deterministic |
| cover, email | cover letter exists; **Application email** draft (subject, body, attachments checklist) | AI |
| contacto | **Outreach**: contacts list per job + ≤300-char LinkedIn note per contact type | AI draft, never sent |
| deep | **Company research** brief (culture, recent moves, angle) from the posting text + user-pasted notes; marked unverified | AI |
| interview-prep, interview/plan, practice, debrief | **Interview** tab: prep doc (likely questions mapped to stories, questions to ask), time-blocked plan, practice (one question → answer → feedback), debrief notes → next steps | AI + story bank |
| interview-redflag | **Red flags** from posting + notes | AI + deterministic signals from legitimacy |
| offer-prep, negotiation, salary-gap | **Offer** tab: offer fields, salary gap (desired/advertised/offered, deterministic), negotiation script, contract clause walk + lawyer questions (not legal advice) | deterministic + AI |
| followup, reply-watch, outcome | **Follow-ups**: cadence (applied +7 d, +14 d; interview thank-you +1 d; check-in +7 d), overdue badge on board cards, draft follow-up; **Paste a reply** → classify (rejection, interview, offer, info request, auto-ack; regex first, AI fallback) → suggested status; outcome stage + reason on rejection | deterministic + AI |
| patterns, stats, detect-reposts, calibrate, upskill, titles | **Insights** view: funnel, response rates by source/ATS/score band/remote, rejection stages & reasons, reposts/ghost suspects, score-vs-outcome calibration, top missing skills across evaluations, adjacent titles | deterministic (+AI titles/upskill narrative) |
| training, project | **Career advice**: evaluate a course/cert or portfolio project against target roles | AI |
| add, expand | "Add to CV" (paste a project/role → diff card, human-approved) | AI |
| interview (onboarding) | Candidate profile + completeness (§3) | deterministic |
Not ported: plugin system, TUI dashboard (board exists), update/agent-inbox (CLI housekeeping), funded-company feeds (no free structured source), sending anything.

`src/jobs/insights.js` (pure): `funnel(jobs)`, `rates(jobs, by)` (by ∈ source, ats, band, remote, archetype), `rejections(jobs)`, `reposts(jobs)` (same company + normalized title seen with different ids/dates, or postedAt refreshed), `calibration(jobs)` (score band → reached interview %), `skillGaps(jobs)` (missing-requirement keywords frequency), `adjacentTitles(archetypes)`, `followUpsDue(job, now)` / `cadence(job)`, `classifyReply(text)` → `{ kind, status, confidence, quote }`, `salaryGap({ desired, advertised, offered })`, `compare(jobs)` → rows.
AI modes (`src/ai/assist.js` + `prompts.js` + `agent/modes/<mode>.md`, loaded by playbook.js): `brief(mode, { job, notes, extra })` for mode ∈ research, outreach, email, interview-prep, interview-plan, debrief, redflags, negotiate, offer-review, followup, compare, training, project, titles, upskill → `Brief { title, sections: [{ heading, body, items[] }], needsInput[] }`; `practice({ job, question, answer })` → `{ feedback, score 1–5, next }`; `stories()` → `Story[]` drafted only from CV lines (each story cites `sourceLines`; the guard drops stories citing none); `addToCv(text)` → suggestions (existing suggestion shape, diff cards); `classifyReply(text)` AI fallback → same shape as insights. Every prompt carries NO_FABRICATION; outreach/email/letter facts only from CV + profile.

## 7. UI (wave B)
- **Job workspace**: the board drawer grows tabs — Overview (today's content + outcome), Pack, Research, Outreach, Interview, Offer, Follow-ups. Each AI tab: "Generate"/"Regenerate", brief rendered as headings/paragraphs/lists (textContent only), copy-all, stored in `artifacts`. Board cards: overdue follow-up badge; multi-select checkboxes → **Compare** and **Apply to selected**; header button **Apply to all saved** and **Insights**.
- **Insights** view (full-screen like the board): cards for each §6 insight, empty states, export CSV of the funnel.
- **Discover**: result checkboxes + "Select ★≥4" + **Apply to selected (n)**; **Pipeline inbox** tab; Jobicy/SmartRecruiters/Workable in feeds and company editor; "Find boards" in the company editor.
- Cmd-K: Candidate profile, Insights, Pipeline inbox, Apply queue, Compare.

## 8. Files per task
- T50 sources/region/discover: src/jobs/sources.js, src/jobs/discover.js, src/jobs/evaluate.js, data/companies.json, cli/recto.js (discover command), src/ui/discover-view.js (country select, new feeds, company editor sources + Find boards), tests.
- T51 profile/answers/pack: src/profile.js, src/jobs/answers.js, src/jobs/pack.js, src/ui/profile-dialog.js, src/ui/pack-view.js, styles/profile.css, tests.
- T52 one-click apply: src/ui/apply-queue.js, styles/apply.css, serve.js, cli/autoapply.js, tests.
- T53 AI modes: src/ai/prompts.js, src/ai/assist.js, src/ai/playbook.js, agent/modes/{research,outreach,email,interview-prep,interview-plan,practice,debrief,redflags,negotiate,offer-review,followup,compare,training,project,titles,upskill,stories,add,reply}.md, tests.
- T54 insights/tracker: src/jobs/insights.js, src/jobs/tracker.js, tests.
- T57 LaTeX: src/io/latex.js, src/ui/topbar.js (Export menu item), cli/recto.js export `--format tex` (request to T50 owner: controller merges), tests.
- T55 job workspace + compare (wave B): src/ui/jobs-board.js, src/ui/job-workspace.js, styles/board.css.
- T56 insights view + pipeline inbox + apply buttons (wave B): src/ui/insights-view.js, src/ui/pipeline-view.js, src/ui/discover-view.js, styles/insights.css, src/ui/command-bar.js.
- T58 wave C: scripts/assist-check.js flows, docs (neutral), agent/recto.md + AGENTS.md + skill mode list, README feature table.
Strings: each task writes its keys to `locales/_parts/t<N>.json` (controller merges into en.json). `src/main.js` and `index.html` wiring: controller (tasks list what they need under "requests").

## 9. Non-goals
LinkedIn/SEEK/Indeed scraping, CAPTCHA solving, logging in or account creation for the user, sending email or messages, legal or financial advice, storing anything server-side.
