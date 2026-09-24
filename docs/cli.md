# CLI

`cli/recto.js` builds and checks CVs without opening the app, for scripts and CI. It uses only the Node standard library (Node 20 or newer). PDF output and the full check drive a headless Chromium-based browser through the same print mode the app uses, so the PDF matches the canvas.

```
node cli/recto.js export <in> -o <out> [--template <id>]
node cli/recto.js check <in> [--template <id>]
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

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success. For `check`: no errors (warnings and info don't fail). |
| 1 | `check` found at least one error, or `export` wrote a PDF whose page count differs from the render. |
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
