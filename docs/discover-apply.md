# Discover & Apply

Discover finds job postings that fit your profile. For each job you pick, the application pack gathers what you need to apply. The optional `recto autoapply` command then fills the application form in a Chrome window you can see. By default it stops before Submit, so you always submit yourself.

This page covers Discover, one job at a time. For the candidate profile, country presets, the answer bank, the one-click apply queue (many jobs at once) and the rest of the career suite, see [career-suite.md](career-suite.md).

## Safety and terms of use

Many job sites and applicant tracking systems forbid automated or bulk submissions in their terms of use. **You are responsible for how you use autoapply and for every application sent in your name.** Read each site's terms first. The default mode only fills the form and stops before Submit. `--submit` is opt-in, per run, and guarded (see [The guards](#the-guards)). Recto never solves or bypasses a CAPTCHA, never signs in for you and never creates an account. Those steps are always left to you.

## Discover

Open **Discover** from the top bar or the command bar (`Cmd/Ctrl+K`). Press **Scan** to fetch postings straight from your browser. There is no Recto server in between.

### Sources and attribution

| Source | What it scans |
|---|---|
| Greenhouse, Lever, Ashby | The public job-board API of each company in your company list. |
| SmartRecruiters | Each company's posting board, filtered by the active country preset when one is set. |
| Workable | Each company's posting board. |
| Remotive | Remote jobs matching the feed query (or your first target role). |
| Arbeitnow | The first page of the Arbeitnow job board. |
| Jobicy | A remote-jobs feed, filtered by the active country preset's geo code. Off by default — turn it on in Discover's feed settings. |

The company list is `{ source, board, name }` entries. `board` is the company's token in its ATS URL, for example `stripe` in `boards.greenhouse.io/stripe`, or `Canva` in `jobs.smartrecruiters.com/Canva`. You can add, remove, import and export entries by hand, or press **Find boards** and type a company name: Recto probes every source for a public board with open roles under that name and lists what it finds, ready to add with one click. The starter list (`data/companies.json`) is a starting point, and every source and filter works for any country — see [Country presets](career-suite.md#country-presets). You can turn the Jobicy feed on or off. Results from Remotive and Jobicy show "via {source}" and link back to the original posting, as their terms require. Every card links to its source posting.

### Filters

Scan settings are saved in the browser (`localStorage['recto:discover']`). Roles, locations, remote preference and the active country start from your candidate profile; the country select at the top of Discover overrides it for this scan, and drives which state/currency/clearance wording the [country preset](career-suite.md#country-presets) uses.

- **Roles:** every word of at least one target role must appear in the title.
- **Locations and remote:** `remote` keeps remote jobs only. `onsite` keeps non-remote jobs in your locations. `hybrid` keeps jobs in your locations. `any` keeps remote jobs plus jobs in your locations. A posting also passes when its location names the active country, or is remote and falls within that country's area (or names no country at all).
- **Max age:** postings older than this many days are dropped (default 30).
- **Min score:** postings whose local ★ score is below this are dropped (default 0).
- **Deal-breakers** from your profile, and jobs already on your board (except those still `saved`) or skipped before, are left out. Duplicates across sources are shown once.

Each result is scored locally, with no AI: the ★ 1–5 job evaluation, the match estimate, a legitimacy badge and the posting's age. Results are ranked by score, then match, then recency. You can narrow them with filter chips (★ 4 or more, remote only, hide saved). Each card has a selection checkbox and offers **Save** (adds it to the jobs board), **Skip** (hides it, with undo) and **Prepare application**. Selecting results (or **Select ★≥ n**) enables **Apply to selected**, which saves them and opens the [apply queue](career-suite.md#one-click-apply) for all of them at once. **Pipeline** (main strip) is the paste-and-check list described in [career-suite.md](career-suite.md#pipeline).

## Application pack

**Prepare application** opens from a Discover card, a board card's drawer, the Job tab or the command bar. It builds a pack for that job and stores it on the job in the tracker, so the pack survives reloads and travels in the board's export. Reopening the pack shows the stored one and reuses its tailored CV instead of making another copy.

- **Tailored CV:** a copy of your open CV, linked to the job. If AI is connected, its tailoring suggestions wait in the Suggest tab for you to review. Open it, or download it as a PDF.
- **Cover letter:** open the linked letter, or draft one with AI.
- **Questions:** the form's own questions for Greenhouse jobs, or a common set for other jobs. Each answer shows its source: `profile`, `cv`, `rule`, `ai` or unanswered. Standard questions are answered by rules from your profile and CV: name, contact details, links, location, work authorization, sponsorship, relocation, salary, notice period, "How did you hear" (Company careers page), and equal-opportunity questions (decline). AI drafts only free-text questions, and a draft that adds facts your CV doesn't have is dropped. You can edit every answer and copy it.
- **Fields:** your standard applicant fields, each with a copy button.
- **Actions:** **Open application page** (new tab) and **Mark applied**.
- **CLI hint:** the exact `recto autoapply` command for this job, plus a download of a jobs file that holds only this job and its pack.

## One-click apply

For more than one job at a time, use the **apply queue** in the app instead of running `recto autoapply` by hand: **Apply to selected** (Discover, board multi-select), **Apply to all saved** (board header) or **Apply to N saved jobs** (Pipeline) build every pack, ask each still-unanswered required question once (the answer is saved to your [answer bank](career-suite.md#saved-answers-the-answer-bank) and reused across all of them), then run `recto autoapply` for the whole batch for you through a local bridge — or, when there's no bridge, hand you a bundle file and the one command to run. See [career-suite.md](career-suite.md#one-click-apply) for the full flow.

### The local bridge

Running locally (`node serve.js`), the apply queue talks to `recto autoapply` through `/api/apply`. **This route only exists when the server is bound to a loopback address** (`127.0.0.1`/`localhost`, the default) — exactly like the `/api/fetch` job-link proxy — and every request is checked for same-origin and a per-run token, so a page on another origin can never reach it. Only one run happens at a time. See [self-hosting.md](self-hosting.md#the-apiapply-bridge) for the exact guarantees.

On a hosted (static) instance there is no bridge and no server-side code at all: the apply queue instead downloads a `recto-apply.json` bundle (every prepared job, your CV and your profile in one file) and shows you the command below.

## `recto autoapply`

```sh
node cli/recto.js autoapply --jobs recto-job-<id>.json --cv cv.cv.json --dry-run   # the plan, no browser
node cli/recto.js autoapply --jobs recto-job-<id>.json --cv cv.cv.json             # fill, you review and submit
node cli/recto.js autoapply --jobs jobs.json --cv cv.cv.json --submit --min-score 4 --max 5
node cli/recto.js autoapply --bundle recto-apply.json                              # from the apply queue's download
```

| Flag | Meaning |
|---|---|
| `--jobs <file>` | A jobs board export, or a pack's jobs file. Only jobs with status `saved` are processed. Required unless `--bundle` is given. |
| `--cv <file>` | The CV to export and attach (`.cv.json` or Recto Markdown). Required unless `--bundle` is given. |
| `--bundle <file>` | A `recto-apply.json` bundle (jobs, CV and profile in one file), as downloaded from the apply queue. Replaces `--jobs`/`--cv`/`--profile`; `--min-score`/`--max` still override the bundle's own values. |
| `--profile <file>` | Applicant fields. Defaults to `./profile.json` when it exists. Empty name, email, phone and links come from the CV header. |
| `--min-score <n>` | `--submit` guard: the lowest job score allowed (default 4). |
| `--max <n>` | `--submit` guard: the most submissions per day, counted from the log (default 5). |
| `--submit` | Click Submit when every guard passes. Without it, autoapply always stops before Submit. |
| `--dry-run` | Open no browser and write nothing. Print each job's URL, the fields and answers it would fill, and the `--submit` decision. |
| `--progress-json` | Print one JSON event per line to stdout instead of readable text, for the apply queue's local bridge to parse. Each waiting job then reads a single `y`/`n` line from stdin instead of the two interactive prompts. |
| `--log <file>` | JSONL log of every attempt (default `applications.jsonl`). |
| `-h`, `--help` | Usage. |

For each saved job, autoapply exports the CV to a PDF. It opens the application page in a visible Chrome that keeps its own profile in `~/.recto/chrome`, so you can sign in there yourself once. It then fills fields by their labels: first from the job's pack, then from your profile (including every [candidate profile](career-suite.md#candidate-profile) field) with the same rules as the app's pack, then from your saved [answer bank](career-suite.md#saved-answers-the-answer-bank) for anything the pack and the rules didn't cover. It attaches the PDF and outlines every required field that is still empty in red. By default it then waits while you review and submit in the browser, and asks whether you submitted. A yes marks the job applied in the jobs file, and importing that file back into the app moves the card. Full details are in [cli.md](cli.md#autoapply).

### The guards

With `--submit`, autoapply clicks Submit only when all of these hold:

1. The job's score (the latest evaluation stored on the job, or a local evaluation of its text) is at least `--min-score`.
2. Fewer than `--max` applications were submitted today.
3. No required field is empty.
4. The page shows no CAPTCHA (reCAPTCHA, hCaptcha, Turnstile), no login wall and no account-creation wall.
5. The page has a Submit button.

After clicking Submit, it waits for a confirmation: the page moves on, or shows a "thank you" or "application received" message. It saves a screenshot to `out/applications/<job id>.png`. If any guard fails, or no confirmation appears, it stops before Submit for that job and hands over to you.
