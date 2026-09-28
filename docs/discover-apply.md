# Discover & Apply

Discover finds job postings that fit your profile. For each job you pick, the application pack gathers what you need to apply. The optional `recto autoapply` command then fills the application form in a Chrome window you can see. By default it stops before Submit, so you always submit yourself.

## Safety and terms of use

Many job sites and applicant tracking systems forbid automated or bulk submissions in their terms of use. **You are responsible for how you use autoapply and for every application sent in your name.** Read each site's terms first. The default mode only fills the form and stops before Submit. `--submit` is opt-in, per run, and guarded (see [The guards](#the-guards)). Recto never solves or bypasses a CAPTCHA, never signs in for you and never creates an account. Those steps are always left to you.

## Discover

Open **Discover** from the top bar or the command bar (`Cmd/Ctrl+K`). Press **Scan** to fetch postings straight from your browser. There is no Recto server in between.

### Sources and attribution

| Source | What it scans |
|---|---|
| Greenhouse, Lever, Ashby | The public job-board API of each company in your company list. |
| Remotive | Remote jobs matching the feed query (or your first target role). |
| Arbeitnow | The first page of the Arbeitnow job board. |

The company list is `{ source, board, name }` entries. `board` is the company's token in its ATS URL, for example `stripe` in `boards.greenhouse.io/stripe`. You can add, remove, import and export entries. The list starts from a set of about 40 well-known companies (`data/companies.json`). You can turn the two feeds on or off. Results from Remotive show "via Remotive" and link back to the original posting, as Remotive's terms require. Every card links to its source posting.

### Filters

Scan settings are saved in the browser (`localStorage['recto:discover']`). Roles, locations and remote preference start from your candidate profile.

- **Roles:** every word of at least one target role must appear in the title.
- **Locations and remote:** `remote` keeps remote jobs only. `onsite` keeps non-remote jobs in your locations. `hybrid` keeps jobs in your locations. `any` keeps remote jobs plus jobs in your locations.
- **Max age:** postings older than this many days are dropped (default 30).
- **Min score:** postings whose local ★ score is below this are dropped (default 0).
- **Deal-breakers** from your profile, and jobs already on your board (except those still `saved`) or skipped before, are left out. Duplicates across sources are shown once.

Each result is scored locally, with no AI: the ★ 1–5 job evaluation, the match estimate, a legitimacy badge and the posting's age. Results are ranked by score, then match, then recency. You can narrow them with filter chips (★ 4 or more, remote only, hide saved). Each card offers **Save** (adds it to the jobs board), **Skip** (hides it, with undo) and **Prepare application**.

## Application pack

**Prepare application** opens from a Discover card, a board card's drawer, the Job tab or the command bar. It builds a pack for that job and stores it on the job in the tracker, so the pack survives reloads and travels in the board's export. Reopening the pack shows the stored one and reuses its tailored CV instead of making another copy.

- **Tailored CV:** a copy of your open CV, linked to the job. If AI is connected, its tailoring suggestions wait in the Suggest tab for you to review. Open it, or download it as a PDF.
- **Cover letter:** open the linked letter, or draft one with AI.
- **Questions:** the form's own questions for Greenhouse jobs, or a common set for other jobs. Each answer shows its source: `profile`, `cv`, `rule`, `ai` or unanswered. Standard questions are answered by rules from your profile and CV: name, contact details, links, location, work authorization, sponsorship, relocation, salary, notice period, "How did you hear" (Company careers page), and equal-opportunity questions (decline). AI drafts only free-text questions, and a draft that adds facts your CV doesn't have is dropped. You can edit every answer and copy it.
- **Fields:** your standard applicant fields, each with a copy button.
- **Actions:** **Open application page** (new tab) and **Mark applied**.
- **CLI hint:** the exact `recto autoapply` command for this job, plus a download of a jobs file that holds only this job and its pack.

## `recto autoapply`

```sh
node cli/recto.js autoapply --jobs recto-job-<id>.json --cv cv.cv.json --dry-run   # the plan, no browser
node cli/recto.js autoapply --jobs recto-job-<id>.json --cv cv.cv.json             # fill, you review and submit
node cli/recto.js autoapply --jobs jobs.json --cv cv.cv.json --submit --min-score 4 --max 5
```

| Flag | Meaning |
|---|---|
| `--jobs <file>` | Required. A jobs board export, or a pack's jobs file. Only jobs with status `saved` are processed. |
| `--cv <file>` | Required. The CV to export and attach (`.cv.json` or Recto Markdown). |
| `--profile <file>` | Applicant fields. Defaults to `./profile.json` when it exists. Empty name, email, phone and links come from the CV header. |
| `--min-score <n>` | `--submit` guard: the lowest job score allowed (default 4). |
| `--max <n>` | `--submit` guard: the most submissions per day, counted from the log (default 5). |
| `--submit` | Click Submit when every guard passes. Without it, autoapply always stops before Submit. |
| `--dry-run` | Open no browser and write nothing. Print each job's URL, the fields and answers it would fill, and the `--submit` decision. |
| `--log <file>` | JSONL log of every attempt (default `applications.jsonl`). |
| `-h`, `--help` | Usage. |

For each saved job, autoapply exports the CV to a PDF. It opens the application page in a visible Chrome that keeps its own profile in `~/.recto/chrome`, so you can sign in there yourself once. It then fills fields by their labels: first from the job's pack, then from your profile with the same rules as the app's pack. It attaches the PDF and outlines every required field that is still empty in red. By default it then waits while you review and submit in the browser, and asks whether you submitted. A yes marks the job applied in the jobs file, and importing that file back into the app moves the card. Full details are in [cli.md](cli.md#autoapply).

### The guards

With `--submit`, autoapply clicks Submit only when all of these hold:

1. The job's score (the latest evaluation stored on the job, or a local evaluation of its text) is at least `--min-score`.
2. Fewer than `--max` applications were submitted today.
3. No required field is empty.
4. The page shows no CAPTCHA (reCAPTCHA, hCaptcha, Turnstile), no login wall and no account-creation wall.
5. The page has a Submit button.

After clicking Submit, it waits for a confirmation: the page moves on, or shows a "thank you" or "application received" message. It saves a screenshot to `out/applications/<job id>.png`. If any guard fails, or no confirmation appears, it stops before Submit for that job and hands over to you.
