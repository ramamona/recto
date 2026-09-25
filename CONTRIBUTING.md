# Contributing to Recto

Thanks for helping. Templates, translations, bug reports with a `.cv.json` that shows the problem, and fixes are all welcome.

## Ground rules

These rules are not up for negotiation, because they are what make Recto easy to run, host and audit.

- **Zero dependencies.** There are no runtime and no dev dependencies. Don't add a `node_modules`, a lockfile, a bundler, a linter or a test framework. The browser code uses browser APIs, and the tools use the Node standard library.
- **No build step.** Browser code is native ES modules, loaded with relative paths that end in `.js`. What is in the repository is what runs.
- **Node 20 or newer** for the server, the CLI and the tests.
- **Pure modules stay pure.** `src/model`, `src/preflight`, `src/io/jsonresume.js`, `src/io/plaintext.js`, `src/render/theme.js` and `src/render/paginate.js` never touch `document`, `window`, `localStorage` or `fetch`, so Node tests and the CLI can import them.
- **User data never becomes markup.** Build DOM with `createElement`, `textContent` and `setAttribute`. Never assign `innerHTML` from anything but a string literal, and never use `eval` or `new Function`. `test/security.test.js` checks this.
- **The CSP stays.** No inline `<script>`, no requests to other origins, no `url(https://…)`.
- **The ATS paint invariant** ([docs/templates.md](docs/templates.md#ats-paint-invariant)): text inside `.cv-page` stays static and in normal flow.
- **Units.** Geometry is in mm and font sizes in pt. CSS for the CV (`styles/cv.css`, the theme, templates, custom CSS) uses only `pt`, `mm`, `em` or unitless values.
- **Budget.** App JS + CSS stays at or below 300 KB uncompressed (templates, locales and samples excluded).

## Code style

Two-space indent, no semicolons, single quotes. Keep functions small. Write a comment only when the *why* isn't obvious from the code.

## Running things

```sh
npm start                            # = node serve.js, the app at http://127.0.0.1:8710
npm test                             # every test: node --test
node --test test/markdown.test.js    # one test file
npm run smoke                        # every template through headless Chrome, PDFs in out/
npm run assist-check                 # end-to-end AI + jobs flow against a stub provider, no real API calls
node scripts/render-check.js         # pagination and paint checks on generated documents
```

Run `npm test` after any change. Run `npm run smoke` after anything that touches rendering, layout, templates or the CLI/PDF path. Run `npm run assist-check` after a change to `src/ai/`, `src/jobs/`, `src/suggest/local.js`, `src/ui/ai-dialog.js`, `jobs-dialog.js`, `assist-panel.js` or `job-panel.js`. `node scripts/render-check.js` is for chasing a pagination or paint-invariant bug, not part of the usual loop.

The smoke test and `assist-check` need Chrome, Chromium, Edge or Brave. Set `CHROME_PATH` if it isn't installed in a standard place. If `pdftotext` (poppler) is installed, the smoke test also checks the text order of each PDF.

Tests use `node:test` and `node:assert/strict` and live in `test/<name>.test.js`. A change to behavior comes with a test that fails without it.

## Adding a UI string

Add the key to `locales/en.json` (flat keys, `{placeholder}` for variables) and reference it with `t('your.key', vars)` from `src/ui/i18n.js`. Don't hardcode user-facing text in a UI module. `node --test test/i18n.test.js` checks every other locale file has exactly the same keys as `en.json` — you don't need to translate your new string yourself, just add it to `en.json`.

## Adding a template

1. Create `templates/<id>.json` (`id` is `[a-z0-9-]+`). The schema is in [docs/templates.md](docs/templates.md).
2. Add the id to `templates/index.json`.
3. Run `npm run smoke`. It validates the file, renders the sample CV with your template, and fails on any preflight error, on more pages than `targetPages`, on less than 8 % free space on the last page, and on any paint-invariant violation.
4. Look at `out/<id>.pdf`, and open the gallery in the app to see your template with other content.

## Adding a translation

1. Copy `locales/en.json` to `locales/<lang>.json` and translate the values. Keep the keys and the `{placeholders}`.
2. `node --test test/i18n.test.js` checks that the file has exactly the keys of `en.json`.

The app loads the locale that matches the browser language (`de-AT` loads `de.json`) and falls back to English for any missing string.

## Pull requests

- Keep a pull request to one change, and say in the description what you tested by hand.
- `npm test` and `npm run smoke` pass. CI runs both on Ubuntu.
- For anything that touches rendering, attach a before and after PDF or screenshot, and walk through the relevant part of the manual QA checklist in [docs/architecture.md](docs/architecture.md#manual-qa-checklist).

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
