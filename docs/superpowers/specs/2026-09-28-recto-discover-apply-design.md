# Recto Discover & Apply — design spec

Date: 2026-09-28 · Branch `feat/discover-apply` · Builds on v1, Assist and Review & Jobs specs (binding where silent).

## 1. Intent
Owner: "a new section that scans and applies to jobs on my behalf, using my profile."
Decisions (owner asked twice; defaults chosen by the controller):
- **Scan**: company boards (Greenhouse, Lever, Ashby public APIs) from an editable company list + public remote feeds (Remotive, Arbeitnow). All five allow browser CORS (verified), so scanning works hosted and local.
- **Apply**: per job an *application pack* (tailored CV, cover letter, drafted screening answers, standard fields). The web app cannot fill third-party forms (browser same-origin policy), so auto-fill lives in the CLI: `recto autoapply` drives a visible Chrome via `cli/chrome.js`, fills and attaches, and **stops before Submit by default**. `--submit` submits only when: job score ≥ threshold, under the daily cap, no required field unanswered, no CAPTCHA/login/account wall (those always hand back to the user). Never bypasses CAPTCHAs, never logs in, never creates accounts.
- Every scan result, pack and submission is recorded in the jobs tracker/board with status history.

**Success criteria**
1. Discover view: configure sources and filters, press **Scan**, get a ranked, de-duplicated feed (★ score, match, legitimacy, age) in < 20 s for 30 companies; Save/Skip/Prepare per card.
2. Application pack view per job: tailored CV (AI if connected, else current CV), cover letter (AI), screening questions (Greenhouse exposes them; others: common set) with drafted answers from profile/CV (AI or rule-based), standard fields with copy buttons, **Open application page**, **Download PDF**, **Mark applied**.
3. `recto autoapply` fills Greenhouse, Lever and Ashby forms in a visible Chrome, attaches the pack PDF, stops before Submit (default) or submits under the §4 guards; logs to the tracker file; dry-run mode prints the plan without opening a browser.
4. No regressions; new pure modules unit-tested; e2e covers Discover → Save → Pack.

## 2. Sources and discovery (`src/jobs/sources.js`, `src/jobs/discover.js`, pure except injected fetch)
- `SOURCES`: `greenhouse` (`https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true`; detail `/jobs/{id}?questions=true`), `lever` (`https://api.lever.co/v0/postings/{site}?mode=json`), `ashby` (`https://api.ashbyhq.com/posting-api/job-board/{board}?includeCompensation=true`), `remotive` (`https://remotive.com/api/remote-jobs?search={q}&limit=100`; must show "via Remotive" + link back per their terms), `arbeitnow` (`https://www.arbeitnow.com/api/job-board-api?page={n}`).
- Each adapter → normalized `Posting { id: '<source>:<board>:<jobId>', source, board, company, title, location, remote: boolean|null, url, applyUrl, postedAt, text, salary?, questions?: Question[] }`. HTML → text via `extractHtml`.
- `companies` list: `{ source, board, name }[]` in `localStorage['recto:companies']` (+ import/export), with a starter set in `data/companies.json` (~40 well-known companies across the three ATS; verify each board token returns 200 at build time and drop failures).
- `discover({ companies, feeds, profile, cv, tracker, now, fetch, signal, onProgress }) → { results: Ranked[], errors: [{ source, board, message }] }`: fetch with concurrency 6 and per-request timeout 10 s; filter by profile (target-role keywords in title, location/remote preference, deal-breakers, posted within N days (default 30)); skip ids already in the tracker (unless status saved) and previously skipped; evaluate each with `evaluateJob` (local) + `matchCv`; rank by score, then match, then recency. `Ranked = { posting, evaluation, match, legitimacy }`.
- Scan settings persisted in `localStorage['recto:discover']`: `{ roles, locations, remote, maxAgeDays, minScore, feeds: { remotive: { enabled, query }, arbeitnow: { enabled } } }` (roles/locations default from the profile).

## 3. Profile and application pack (`src/profile.js` + `src/jobs/pack.js`)
- Profile gains applicant fields: `firstName, lastName, email, phone, linkedin, github, website, city, country, salaryExpectation, noticePeriod, willingToRelocate, pronouns?, eeo: { gender, race, veteran, disability } defaulting to 'decline'`. Name/email/phone/links prefill from the CV header when empty.
- `buildPack({ job, cv, profile, assist? }) → Promise<Pack>`: `Pack = { jobId, cvDocId, coverLetterDocId?, fields: {label, value}[], answers: [{ question, type, required, answer, source: 'profile'|'cv'|'ai'|'rule'|'unanswered', options? }], pdfName, createdAt }`. Standard question mapping (work authorization, sponsorship, relocation, salary, notice, how did you hear → "Company careers page", LinkedIn/GitHub/website, EEO → decline) is rule-based from the profile; free-text questions use AI (`assist` mode `answer`, new playbook file `agent/modes/answer.md`, no-fabrication rule) or are left `unanswered`. Packs stored on the job (`tracker` field `pack`).
- Tailored CV: duplicate current doc linked to the job; if AI connected, queue tailor cards (existing flow) — the pack notes "review tailored changes before applying".

## 4. CLI autoapply (`cli/autoapply.js`, invoked as `recto autoapply`)
`recto autoapply --jobs jobs.json --cv my.cv.json [--profile profile.json] [--min-score 4] [--max 5] [--submit] [--dry-run] [--log applications.jsonl]`
- `jobs.json` = tracker export (from the app's board export) — processes jobs with status `saved` that have a pack or can get a rule-based one.
- For each: export tailored CV to PDF (`export` path), launch **visible** Chrome (non-headless) with a persistent profile dir under `~/.recto/chrome` (so the user can be signed in themselves), open `applyUrl`, detect the ATS (greenhouse/lever/ashby form structure by URL and DOM), fill fields by label matching (name, email, phone, links, location, work auth, sponsorship, salary, notice, EEO = decline, custom answers from the pack), attach the PDF (`DOM.setFileInputFiles`), then:
  - default: highlight unfilled required fields, **stop before Submit**, print "Review and submit in the browser, then press Enter", wait, then ask "Did you submit? [y/N]" → mark applied if yes.
  - `--submit`: only if score ≥ `--min-score`, daily cap (`--max`, default 5, counted from the log) not reached, zero unfilled required fields, and no CAPTCHA (iframe/challenge detection: recaptcha, hcaptcha, turnstile), login or account-creation wall detected; then click Submit, wait for a confirmation signal (URL change or "thank you/application received" text), screenshot to `out/applications/<id>.png`, mark applied. Any guard failing → fall back to stop-before-submit for that job.
- Every attempt appended to the JSONL log `{ at, jobId, company, title, url, mode, result: 'submitted'|'filled'|'skipped'|'blocked', reason }` and the tracker file updated (status + history) so importing it back into the app moves cards.
- `--dry-run`: no browser; prints per job the fields/answers it would fill and the guard decisions.

## 5. UI
- **Discover** view (full-screen like the board; top bar button **Discover** + Cmd-K): left settings column (roles, locations, remote, max age, min score, sources: company list editor with add/remove/import/export + starter set, feeds toggles), **Scan** button with progress (n/total, errors collapsible), results feed (cards: company, title, location/remote, age, ★ score, match, legitimacy badge, source attribution/link) with Save · Skip · Prepare application; filter chips (score ≥, remote only, hide saved).
- **Application pack** drawer/view (from a Discover card, the board card drawer or the Job tab): sections Tailored CV (open doc, download PDF), Cover letter (open/create), Questions (each with answer editable, source badge, copy), Fields (copy buttons), actions **Open application page** (new tab), **Mark applied**, and a CLI hint box showing the exact `recto autoapply` command for this job.
- Profile dialog gains the applicant-fields section.

## 6. Files
src/jobs/sources.js, src/jobs/discover.js, src/jobs/pack.js, src/profile.js (extend), data/companies.json, agent/modes/answer.md, src/ai/prompts.js + assist.js (answer mode), src/ui/discover-view.js, src/ui/pack-view.js, styles/discover.css, cli/autoapply.js (+ recto.js subcommand), docs/discover-apply.md, tests: sources, discover, pack, profile, autoapply (dry-run + a local fake Greenhouse/Lever/Ashby form page served by serve.js extra routes, driven headless in tests), scripts/assist-check.js (Discover flow with stubbed sources).

## 7. Non-goals
LinkedIn/Indeed scraping or Easy Apply, CAPTCHA solving, account creation, logging in on the user's behalf, emailing recruiters, applying without a pack.
