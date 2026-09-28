# CLI

`cli/recto.js` builds and checks CVs without opening the app, for scripts and CI. It uses only the Node standard library (Node 20 or newer). PDF output and the full check drive a headless Chromium-based browser through the same print mode the app uses, so the PDF matches the canvas.

```
node cli/recto.js export <in> -o <out> [--template <id>]
node cli/recto.js check <in> [--template <id>]
node cli/recto.js ats <in> [--template <id>] [--json]
node cli/recto.js evaluate <in> --job <file.txt|url> [--profile <profile.json>] [--json]
node cli/recto.js tips <in> [--json]
node cli/recto.js apply <in> --edits <edits.json> [--allow-new-facts] [-o <out>] [--json]
node cli/recto.js profile [--set key=value ...] [--file <profile.json>] [--json]
node cli/recto.js autoapply --jobs <jobs.json> --cv <in> [--profile <profile.json>] [--min-score 4] [--max 5] [--submit] [--dry-run] [--log <applications.jsonl>]
node cli/recto.js --help
```

## Input

| File | Read as |
|---|---|
| `.cv.json` | A Recto document, as saved by the app. Embedded fonts and the photo are used. Older versions are migrated, and any warnings go to stderr. |
| `.json` | A Recto document if it has `"format": "recto"`, otherwise [JSON Resume](https://jsonresume.org/schema). JSON Resume is converted to Recto Markdown with the default layout. |
| `.md`, `.txt` | [Recto Markdown](syntax.md) with the default layout (A4, one column). The document name is the file name. |

`--template <id>` applies a built-in template (`classic`, `modern`, `minimal`, `compact`, `timeline`, `executive`, `academic`, `bold`) before exporting or checking, exactly as the gallery does. Without it, the layout stored in the file is used.

## `export`

The output format comes from the extension of `-o`:

| Output | Content | Needs a browser |
|---|---|---|
| `.pdf` | The printed CV: real, selectable text, A4/Letter/… from the layout, one PDF page per canvas page | yes |
| `.txt` | The plain text an ATS extracts, in PDF stream order: what the ATS panel shows | no |
| `.cv.json` | A Recto document (useful to turn Markdown or JSON Resume into a file the app opens) | no |
| `.json` | JSON Resume | no |

```sh
node cli/recto.js export cv.cv.json -o cv.pdf
node cli/recto.js export cv.md -o cv.pdf --template modern
node cli/recto.js export cv.cv.json -o cv.txt
node cli/recto.js export resume.json -o cv.cv.json      # JSON Resume → Recto
node cli/recto.js export cv.cv.json -o resume.json      # Recto → JSON Resume
```

After printing, the CLI counts the pages in the PDF and compares them with the render report. If they differ (the browser broke pages differently from the canvas), the PDF is still written, and the CLI prints an error and exits 1.

## `check`

Runs preflight and prints one line per issue to stdout, then a summary:

```
$ node cli/recto.js check samples/sample.cv.json --template modern
warn  page 1: Your layout has more than one column with text. Applicant tracking systems read it in this order: main → side. For ATS-heavy applications, a one-column template is safer. [multi-column]
0 errors, 1 warnings, 0 info
```

Each line is `severity`, the source line or page, the message and the rule id in brackets. `check` renders the CV in the browser so it can run every rule, including page overflow, target pages, font sizes, contrast and missing fonts. If no browser can be started, it says so on stderr and runs only the content rules (contact details, dates, bullets, headings, markup and so on).

## Tools for agents

`ats`, `evaluate`, `tips`, `apply` and `profile` are deterministic (no AI) and meant for scripts and coding agents. Each takes the same inputs as `export`. With `--json` they print one JSON value to stdout; otherwise readable text.

### `ats`

The ATS report from the app's Review tab: a 0–100 score, grade A–F, eight weighted checks with their items, and the fields an ATS would fill in (`{ score, grade, checks: [{ id, weight, earned, items }], fields }`). Like `check`, it renders in the browser when one is available and otherwise runs on content only, with a note on stderr. Exits 1 on grade F or any `critical` item.

```sh
node cli/recto.js ats cv.cv.json
node cli/recto.js ats cv.md --template classic --json | jq .grade
```

### `evaluate`

Scores the CV against a job posting, as the Job tab does locally: role summary, gates (posting still open, location, work authorization, deal-breakers), a requirement table with the CV line that supports each one, a 1–5 score and a recommendation (apply, consider, skip), and legitimacy signals. `--job` is a text file or a URL; Greenhouse, Lever and Ashby links use their public APIs, other pages are fetched and reduced to text. If a URL can't be fetched, save the posting to a file. `--profile` (default `./profile.json` when present) supplies the candidate profile for the gates.

```sh
node cli/recto.js evaluate cv.cv.json --job posting.txt
node cli/recto.js evaluate cv.md --job https://boards.greenhouse.io/acme/jobs/123 --json
```

### `tips`

The Suggest tab's writing tips for each bullet (weak opener, no metric, passive voice, filler words, long bullets, repeated verbs), as `[{ line, code, message, vars, fix? }]` with `--json`.

```sh
node cli/recto.js tips cv.md
```

### `apply`

Applies line edits, such as an agent's suggestions, with the same guard the app uses for AI suggestions. `edits.json` is an array of `{ "line": 12, "expect": "<the line's current text>", "replacement": "<the new line>" }`. An edit is refused when `expect` no longer matches (stale), when the replacement changes the kind of line (a bullet must stay a bullet, an entry keeps its fields), or when it adds facts that are not in the CV: new numbers, names or links. Pass `--allow-new-facts` only after checking those facts are true. Accepted edits are printed as a diff and written to `-o`, or back to the input file (Markdown stays Markdown, a `.cv.json` stays a Recto file, JSON Resume stays JSON Resume). Refusals go to stderr, and the exit code is 1 if any edit was refused.

```sh
node cli/recto.js apply cv.md --edits edits.json
node cli/recto.js apply cv.cv.json --edits edits.json -o cv.edited.cv.json --json
```

### `profile`

Reads or updates the candidate profile in `./profile.json` (or `--file`): `authorizedIn`, `needsSponsorship`, `locations`, `remote` (`remote`, `hybrid`, `onsite`, `any`), `targetRoles`, `dealBreakers`, `salaryMin`, `currency`. List values are comma-separated. Unknown keys are dropped.

```sh
node cli/recto.js profile --set locations="Berlin, Remote" --set needsSponsorship=true --set dealBreakers="on-call"
node cli/recto.js profile --json
```

## `autoapply`

Fills in the application forms of your saved jobs, in a Chrome window you can see. By default it stops before Submit so you review and submit yourself. Many job sites forbid automated submissions; you are responsible for using it. See [discover-apply.md](discover-apply.md).

```sh
node cli/recto.js autoapply --jobs jobs.json --cv cv.cv.json --dry-run    # print the plan, open nothing
node cli/recto.js autoapply --jobs jobs.json --cv cv.cv.json              # fill, then you review and submit
node cli/recto.js autoapply --jobs jobs.json --cv cv.cv.json --submit --min-score 4 --max 5
```

`--jobs` is the jobs board export from the app. Only jobs with status `saved` are processed. `--profile` (default `./profile.json` when present) supplies the applicant fields. Name, email, phone and links you leave empty are taken from the CV header. For each job, autoapply:

1. Exports the CV to `out/applications/<job id>/<First>-<Last>-CV.pdf`, or to the pack's `pdfName` when the job has an application pack.
2. Opens the job's application page in a visible Chrome with its own persistent profile in `~/.recto/chrome`. You can sign in there yourself once, and it stays signed in. Lever and Ashby posting links go to their `/apply` and `/application` pages.
3. Detects Greenhouse, Lever or Ashby from the URL and the page, and fills fields by their labels. Answers come from the job's application pack first (including drafted answers to custom questions), then from your profile: name, email, phone, LinkedIn/GitHub/website, location, work authorization (only when the question or the job location names a country in `authorizedIn`; codes and names match each other, so `US` matches "United States"), sponsorship, relocation, salary, notice period, and "How did you hear" (Company careers page). Equal-opportunity questions (gender, race, veteran, disability) are answered with the decline option. Password fields are never filled.
4. Attaches the PDF to the resume field and outlines every required field still empty in red.

Then, by default, it prints "Review and submit in the browser, then press Enter", waits, and asks "Did you submit? [y/N]". If you answer yes, the job is marked applied.

With `--submit` it clicks Submit itself, but only if all of these hold:

- the job's score (the latest evaluation stored on the job, or a local evaluation of its text) is at least `--min-score` (default 4);
- fewer than `--max` applications (default 5) were submitted today, counted from the log;
- no required field is left empty;
- the page has no CAPTCHA (reCAPTCHA, hCaptcha, Turnstile) and no login or account-creation wall.

After clicking Submit, it waits for a confirmation: the page moves on, or shows "thank you" or "application received". It then saves a screenshot to `out/applications/<job id>.png` and marks the job applied. If any condition fails, or no confirmation appears, it falls back to stopping before Submit for that job. Autoapply never solves or bypasses a CAPTCHA, never signs in and never creates an account. Those steps are always left to you.

Every attempt is appended to the log (`--log`, default `applications.jsonl`) as one JSON line: `{ at, jobId, company, title, url, mode, result, reason }`. `mode` is `review` or `submit`. `result` is `submitted`, `filled`, `skipped` (for example, no application URL) or `blocked` (a `--submit` guard failed; `reason` lists which ones). Applied jobs are written back to the jobs file with status `applied` and a status-history entry. Import that file into the app and the cards move on the board.

`--dry-run` opens no browser and writes nothing. For each job, it prints the application URL, the fields and answers it would fill, and the `--submit` decision based on the score, the daily cap and any unanswered required pack answers. CAPTCHA, login and form fields can only be checked in the browser. The prompts read from stdin, so piped or closed stdin answers "no".

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success. For `check`: no errors (warnings and info don't fail). |
| 1 | `check` found at least one error, `export` wrote a PDF whose page count differs from the render, `ats` graded F or found a critical item, or `apply` refused an edit. |
| 2 | Usage error, unreadable or invalid input, unknown template, or a failure such as no browser for a PDF. |

Warnings (for example, JSON Resume fields that have no Recto equivalent) and errors go to stderr.

## The browser

The CLI looks for Chrome, Chromium, Microsoft Edge or Brave in their standard install locations on macOS, Windows and Linux (on Linux, `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser` or `microsoft-edge` on the `PATH`). To use another browser, or one in a non-standard place, set `CHROME_PATH`:

```sh
CHROME_PATH=/opt/chromium/chrome node cli/recto.js export cv.cv.json -o cv.pdf
```

It launches the browser headless with a throwaway profile and talks to it over `--remote-debugging-pipe`, so no port is opened. The document is served from a temporary local server bound to `127.0.0.1` on a random port. When `CI` is set on Linux, the browser gets `--no-sandbox`, because GitHub's Ubuntu runners block the Chrome sandbox.

Page breaks depend on the fonts installed. On Linux, install `fonts-liberation` so the built-in font stacks resolve to metric-compatible fonts. For identical breaks on every machine, upload a custom font in the app and save the `.cv.json`, which embeds it.

## CI example: build your CV on every push

Keep your CV in its own repository as `cv.cv.json` (or `cv.md`) and add `.github/workflows/cv.yml`:

```yaml
name: CV
on: [push]
jobs:
  pdf:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/checkout@v4
        with:
          repository: ramamona/recto
          path: recto
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: sudo apt-get update && sudo apt-get install -y fonts-liberation
      - run: node recto/cli/recto.js check cv.cv.json
      - run: node recto/cli/recto.js export cv.cv.json -o cv.pdf
      - run: node recto/cli/recto.js export cv.cv.json -o cv.txt
      - uses: actions/upload-artifact@v4
        with:
          name: cv
          path: |
            cv.pdf
            cv.txt
```

`ubuntu-latest` already has Chrome. The `check` step fails the build on any preflight error, before a broken PDF is built. To pin the Recto version, add `ref: <tag or commit>` to the second checkout.
