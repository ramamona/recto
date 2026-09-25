# Architecture

Recto is a folder of static files. The browser loads `index.html`, which loads `src/main.js` as a native ES module. There is no build step, no framework and no dependency. The Node tools (`serve.js`, `cli/`, `scripts/`, `test/`) import the same pure modules the browser uses.

## Principles

- **Text is the source of truth for content**, and the layout JSON for everything visual. The canvas edits the layout. It edits content only by moving or rewriting whole source lines, as an undoable step.
- **Pure core, thin shell.** Parsing, layout rules, templates, preflight, ATS extraction, JSON Resume, pagination and the theme are pure functions with no DOM, so Node tests and the CLI run them directly. Only `src/render/pages.js`, `fit.js`, `decor.js`, `render.js` and `src/ui/*` touch the DOM.
- **One render path.** The canvas, the gallery thumbnails, print mode, the CLI's PDF and the smoke test all go through `layoutPages`, so what you see is what prints.
- **Never throw on user input.** Parsing and normalization always return something usable plus diagnostics or warnings.

## Module map

```
index.html                  app shell, CSP meta, stylesheets, <script type=module src=src/main.js>
serve.js                    zero-dependency static server (createServer, listen); used by the CLI and smoke test
src/main.js                 boot: locale, store, storage, UI mounts, shortcuts, banners; ?print mode and window.rectoReady
src/store.js                state snapshot, actions, { content, layout } undo history, autosave wiring

src/model/                  pure
  markdown.js               Recto Markdown → AST: parse, parseInline, inlineText, slugify, parseDateRange, formatDate, detectContact
  categories.js             heading dictionary (en, de, fr, es) → category, present-words, range-words
  layout.js                 defaultLayout, normalizeLayout, migrateFile, applyLayoutOps, sectionConfig, placeSections,
                            renameSectionIds, columnGeometry
  templates.js              applyTemplate (pure); loadTemplates (fetch)
  remix.js                  random tasteful theme variation → layout ops
  edits.js                  source-line edits: fixes, section moves, entry-field rewrites
  separators.js             visible separator strings shared by the renderer and the ATS text

src/render/
  theme.js                  pure: font stacks, theme tokens → --cv-* custom properties
  paginate.js               pure: measured atom heights → pages
  render.js                 AST + layout → DOM atoms (createElement/textContent only)
  pages.js                  layoutPages: measure, paginate, build pages, verify, report; the shadow-root host
  decor.js                  per-page SVG for decor and column backgrounds
  fit.js                    fitToPages: binary search on density

src/preflight/              pure
  rules.js                  runPreflight: content rules and render rules → issues with optional fixes
  contrast.js               colour parsing, compositing, WCAG contrast
  ats.js                    extractText / extractFields: what an ATS reads, in stream order

src/ats/                    pure
  score.js                  atsReport({ source, doc, layout, report, placement, issues, lang }) → { score, grade, checks, fields }:
                             eight weighted checks (text, headings, contact, order, entries, chars, hidden, length) reusing
                             preflight issues where they overlap, plus the mock applicant form (`fields`) an ATS would read

src/io/
  jsonresume.js             pure: toJsonResume, fromJsonResume
  plaintext.js              pure: fromPlainText(text, lang) → { content, notes }; pasted or extracted CV text → Recto Markdown draft
  extract.js                pure: extractFile(File) → { text, kind, warnings }; readers for DOCX, PDF, HTML, RTF, TXT/MD (never throws)
  storage.js                localStorage documents, IndexedDB fonts, photo downscaling
  files.js                  open / save / download, File System Access API where available

src/ai/                     pure; no fetch or storage happens at import, only when called
  providers.js               createClient(connection): one client per provider (Anthropic, OpenAI, OpenRouter, Ollama, LM Studio, Custom) behind complete()/listModels()/test(); OpenRouter's PKCE sign-in
  connections.js              the active connection and per-provider consent: memory first, localStorage['recto:ai'] only when the user opts to remember
  guard.js                    validateSuggestions: checks an AI suggestion's line still matches, keeps its Recto Markdown kind, and flags facts (numbers, URLs, capitalized words) not already in the CV as "new-facts"
  prompts.js                  prompt and JSON-Schema builders per feature (suggest, rewrite, tailor, evaluate, cover letter, extract job); numberSource prefixes each line so replies can cite it
  assist.js                   createAssist({ client, getState }): prompt → client.complete → tolerant JSON parse with one retry → guard.js validation → normalized result

src/jobs/                   pure
  parse.js                    parseJob(text): postings → { title, company, location, requirements, keywords, salary?, postedAt?, signals }; keywordsIn/canonicalTokens (a ~140-term tech/soft-skill vocabulary plus capitalisation heuristics) back both parsing and matching
  match.js                     matchCv(cv, job): the local Recto match estimate (keywords 55%, requirements 20%, parseability 15%, essentials 10%), no AI
  legitimacy.js                checkLegitimacy(job): heuristic flags (stale/no posting date, reposted, payment or ID requests, messaging-app redirects, implausible salary, generic text, email/domain mismatch, urgency language) → ok/caution/red-flag
  evaluate.js                  evaluateJob({ source, doc, layout, issues }, job, { profile, now, liveness }) → the career-ops-style Evaluation:
                                role summary, gates (liveness, geo-mismatch, work authorization, deal-breakers), a two-pass
                                requirement table (importance from the JD alone, then matched against the CV with quoted evidence),
                                a 1–5 score capped by the gates, recommendation, and legitimacy incl. a prompt-injection check
  tracker.js                   createTracker(storage): jobs in localStorage['recto:jobs'], CRUD, evaluations (addEvaluation), export/import
                                JSON; STATUSES incl. 'no-response', statusHistory per job, staleApplied(job, now, days=21)
  fetch.js                     fetchJob(url): Greenhouse/Lever/Ashby public APIs, then the local /api/fetch proxy (serve.js), then an injected webFetch, else rejects with { code: 'needs-paste' }

src/profile.js               pure; localStorage['recto:profile']: loadProfile/saveProfile/normalizeProfile — authorized
                              countries, sponsorship, locations, remote preference, target roles, deal-breakers, salary floor.
                              An empty field means that gate is skipped in evaluateJob, never guessed.

src/suggest/
  local.js                   pure: localSuggestions(source, doc, lang) — deterministic bullet tips (weak opener, no metric, passive voice, filler words, long bullet, repeated verb) with no AI; English-only rules skip other languages

src/ui/
  dom.js  i18n.js           DOM helpers (h, $, on …); t(key, vars) over locales/*.json
  topbar.js                 documents, open/save, import/export (including uploaded .pdf/.docx/.txt/.md/.html/.rtf/.json via src/io/extract.js), templates, undo/redo, print, ATS/match/score chips, save status
  editor.js                 source editor: textarea over a highlighted <pre>, gutter markers, insert menu, syntax popover
  canvas.js                 render loop, zoom, rulers, overlay, section selection and drag, ATS X-ray
  handles.js  decor-tools.js margin/gutter/column handles; drawing and editing decor
  inspector.js              Design tab: Page, Theme, Section, Decor and CSS sub-tabs; makeTabs, shared by panels.js
  panels.js                 right-pane frame: the full-height tab strip Design · Review · Job · Suggest (state.ui.panel);
                             mounts inspector.js, review-panel.js, job-panel.js, assist-panel.js and shows the one selected;
                             exposes ctx.openPanel(name) for the top-bar chips and the command bar
  review-panel.js            Review tab: the ATS score ring/grade, the eight weighted checks with their items (Locate/Fix),
                             "What the ATS sees" mock form, then the existing preflight list and the ATS X-ray text
  gallery.js                template gallery with live thumbnails
  import-review.js          converted-Markdown editor next to a live preview in the current layout, with the converter's low-confidence notes; "Import" creates a new document
  ai-dialog.js               AI connections dialog (top bar): provider cards, model list, test connection, remember-on-this-device, and the per-provider first-use consent prompt
  jobs-dialog.js              (superseded by jobs-board.js; kept only as dead code — nothing imports it any more)
  jobs-board.js               openJobsBoard(store, ctx): full-screen board (spec §5) — 6 columns + collapsed Skipped,
                              drag-and-drop plus ←/→ keyboard moves (both record a statusHistory entry), stale-applied
                              hint, detail drawer, header search/counts/export/import; replaces jobs-dialog.js's role
  assist-panel.js             Suggest tab: AI diff cards (word-level LCS diff, accept/reject/edit per card, "Accept all safe") plus src/suggest/local.js's deterministic tips; also sets ctx.runAssist
  job-panel.js                Job tab: paste a link or text → parseJob/fetchJob, the match gauge, legitimacy flags, the
                              local evaluateJob report (rendered as soon as a job is parsed, no AI needed), "Refine with
                              AI", and the AI actions (Evaluate, Tailor CV, Draft cover letter, Save to tracker); also
                              registers ctx.openProfileDialog
  profile-dialog.js           openProfileDialog(ctx): candidate profile form over src/profile.js
  command-bar.js              mountCommandBar(store, ctx): Cmd/Ctrl-K palette over AI actions, app actions and "go to
                              section", fuzzy-filtered, recent commands first; an action whose ctx function isn't
                              wired up yet is left out of the list rather than shown disabled

styles/                     app.css, editor.css, canvas.css, inspector.css, assist.css, board.css, command.css (app UI); cv.css (the pages)
locales/en.json             UI strings (flat keys)
templates/                  index.json + one JSON file per template
samples/sample.cv.json      first-run document and smoke-test input
cli/recto.js  cli/chrome.js CLI; minimal DevTools-protocol driver over --remote-debugging-pipe
scripts/smoke.js            every template through print mode and PDF
scripts/render-check.js     pagination and paint checks on generated documents
scripts/assist-check.js     end-to-end AI + jobs flow in headless Chrome against a stub OpenAI-compatible server (no real
                            provider is ever contacted): AI suggestions, job match/evaluate/tailor/cover-letter, the
                            always-on ATS chip, the Review tab's 8 checks, the local job evaluation table, the jobs
                            board (drag/keyboard move persists a status change) and the command bar
test/*.test.js              node --test
```

## Data flow

```
 source text ──parse──▶ AST (doc) ──┐
                                    ├─▶ layoutPages ─▶ pages in a shadow root ─▶ report + placement
 layout JSON ──normalize──▶ layout ─┘                                               │
      ▲                                                                             ▼
      └── inspector, handles, decor tools, templates, remix, fixes      runPreflight ─▶ issues ─▶ Check panel, badge,
                                                                                               editor markers
```

1. **Store.** `store.setContent(text)` parses synchronously and carries section settings over a rename (`renameSectionIds`). `store.setLayout(ops)` applies `[{ path, value }]` operations through `applyLayoutOps`, which always ends in `normalizeLayout`. History keeps 100 `{ content, layout }` snapshots. Typing coalesces within 1 s, and a drag is one entry. Autosave to `localStorage` runs 500 ms after the last change.
2. **Render.** `src/ui/canvas.js` subscribes to content and layout. Text changes are debounced by 120 ms, drags render immediately. It calls `layoutPages(doc, layout, host)` and hands the result to `store.setRender({ report, placement })`, which runs preflight.
3. **Preflight.** Content rules look at the source, the AST and the layout. Render rules look at the `RenderReport` (page count, fill, flags, text sizes and colours, missing fonts). Each issue has a message key, variables, a location and, when possible, a fix: a layout op, a guarded line edit, or an action such as fit-to-pages.

## Render pipeline (`layoutPages`)

The pages live in a shadow root whose stylesheet stack is `cv.css`, then the theme variables, then the user's custom CSS. That keeps the app's styles out and the CV's styles in.

1. **Atoms.** `renderAtoms(doc, layout)` builds the header and, per column, a list of *atoms*: a section title, an entry head, a paragraph, a bullet, a whole tags or grid list, or a rule. Each atom knows its wrappers (section, entry, list) as shallow templates, whether it must stay with the next atom (titles and entry heads), and its keep-together group (an entry).
2. **Measure.** The atoms are laid out continuously on a hidden page with the same width, grid and styles. For each atom Recto records its advance `h`, the extra height `hEnd` when it ends a page (closing padding and borders of its wrappers) and `hStart` when it starts one. CV CSS uses only `margin-top` and every wrapper is a flow-root, so these heights add up exactly.
3. **Paginate.** `paginate` (pure) places chunks of atoms greedily per column. A chunk is atoms joined by keep-with-next or by a group. A chunk that doesn't fit moves to the next page. A chunk taller than a page is split at atom boundaries (`forced-split`), and a single atom taller than a page is placed alone (`overflow`), so a page is never empty and the loop always ends. Columns flow independently.
4. **Build.** Each page is a `.cv-page` of the real paper size in mm, with a grid for the columns and the header on page 1. Wrappers re-open on each page as complete boxes.
5. **Verify.** Each page column is checked against real layout (`scrollHeight` against `clientHeight`). On overflow, the capacity of that page column shrinks by the excess and the pages are rebuilt. This is repeated up to 5 times, and capacities only shrink.
6. **Report.** Page count, last-page fill, flags, the size, colour and background of every text style, fonts that failed to load, the first and last text of each page, and the **placement**: every atom in PDF stream order. The ATS panel, X-ray numbers and the smoke test's PDF text check use the placement.

**Printing** prints the shadow host itself. A light-DOM `<style id="recto-page">` holds `@page { size: W H; margin: 0 }` (which doesn't work inside a shadow root). Print CSS hides the app UI and puts each `.cv-page` on its own sheet. Chromium prints exactly what the canvas shows.

**The ATS paint invariant.** Chromium writes PDF text in paint order. So inside `.cv-page`, text-bearing elements are static and in normal flow: no float, positioning, transform, opacity, z-index, filter or order. Only the page, the decor SVGs and letterless pseudo-elements are positioned. Canvas affordances live in an overlay outside the pages. Separators between contacts, tags and fields are real text nodes from `separators.js`, so the PDF text has them too.

## File import and AI/jobs data flow

**Importing a file.** `topbar.js` reads the chosen file with `src/io/extract.js`'s `extractFile(file)`, which sniffs the format from its bytes (falling back to the extension), picks a reader (DOCX unzips `word/document.xml`; PDF decodes its content streams; HTML, RTF and TXT/MD are read directly) and always returns `{ text, kind, warnings }` — it never throws. The plain text goes through `src/io/plaintext.js`'s `fromPlainText(text, lang)`, a pure heuristic converter (entry heads, dates, bullets, contact detection) that returns `{ content, notes }`, where `notes` flags low-confidence guesses by line. `src/ui/import-review.js` shows the converted Markdown next to a live preview rendered with `layoutPages` in the current document's layout; only clicking **Import** creates a new document. Pasted text follows the same `fromPlainText` path without the file-reading step.

**AI.** Nothing runs until the user connects a provider in `src/ui/ai-dialog.js`, which calls `src/ai/providers.js`'s `createClient(connection)` and stores the connection with `src/ai/connections.js` (memory only, unless "Remember on this device" opts into `localStorage`). A feature (Suggest tab, rewrite, tailor, evaluate, cover letter) calls `src/ai/assist.js`'s `createAssist({ client, getState })`, which builds a prompt and JSON Schema with `src/ai/prompts.js`, sends it through the client, tolerantly parses the JSON reply (one retry on a bad shape), and validates every suggestion with `src/ai/guard.js`'s `validateSuggestions` — checking the target line hasn't changed, the replacement keeps the line's Recto Markdown kind, and flagging any number, URL or capitalized word not already in the CV as `new-facts` so it's excluded from "Accept all". `src/ui/assist-panel.js` renders the result as diff cards; nothing is written to the document except by an explicit accept.

**Jobs.** `src/ui/job-panel.js` turns a pasted link or text into a job: a link goes through `src/jobs/fetch.js`'s `fetchJob`, which tries the Greenhouse/Lever/Ashby public APIs, then the local `/api/fetch` proxy (`serve.js`, local mode only), then an injected `webFetch`, and otherwise asks the user to paste the text. The resulting text is parsed by `src/jobs/parse.js`'s `parseJob` into requirements and keywords, scored against the open CV with `src/jobs/match.js`'s `matchCv` (no AI, ever) and checked with `src/jobs/legitimacy.js`'s `checkLegitimacy`. Saving a job stores it with `src/jobs/tracker.js`'s `createTracker` (`localStorage['recto:jobs']`), browsable in `src/ui/jobs-dialog.js`. AI job actions (Evaluate, Tailor CV, Draft cover letter) go through the same `createAssist` path as CV suggestions.

## Print mode

`index.html?print=<relative url of a .cv.json>[&template=<id>][&report=1]` renders only the pages at zoom 1, without the app UI or `localStorage`. It sets `window.rectoReady` to a promise that resolves to `{ report, issues, placement, violations }` once the document, the template, the embedded fonts, the photo and the render are all done. `violations` lists the text elements that break the paint invariant (only with `report=1`). The CLI and the smoke test open this URL in headless Chrome over the DevTools protocol, await `rectoReady` and call `Page.printToPDF` with `preferCSSPageSize`.

## Security model

- A strict CSP in `index.html`: scripts and connections only from the same origin, no inline script, no `eval`, no plugins, no forms, no `<base>`.
- Markdown never becomes HTML. Raw HTML is text, and links are limited to `http`, `https`, `mailto` and `tel`.
- The DOM is built with `createElement`, `textContent` and `setAttribute`. `test/security.test.js` scans `src/` for `innerHTML`, `outerHTML` or `insertAdjacentHTML` with a non-literal value and for `eval` or `new Function`, checks the CSP, and feeds hostile Markdown through the parser.
- Loaded files and layouts are normalized: unknown keys are dropped, and numbers, enums and colours are clamped or replaced by defaults.
- Custom CSS can't load anything from another origin (the CSP blocks it). Font names are emitted as escaped CSS strings.

## Testing

| Command | What it covers |
|---|---|
| `npm test` (`node --test`) | Parser grammar and edge cases, dates, categories, layout normalization, migration, ops and section config, templates, content edits, pagination, theme CSS, contrast, every preflight rule and its fix, ATS text, JSON Resume round trip, paste import, remix, the store, the server, locale key parity, and the security scan |
| `npm run smoke` | Every template renders the sample with zero preflight errors, within its target pages and with at least 8 % free on the last page, with no overflow and no paint-invariant violation. The PDF page count matches, and with `pdftotext` installed, the PDF text has the name, email and section titles in placement order |
| `node scripts/render-check.js` | Pagination and the paint invariant on generated documents (long sections, multi-page, columns) |
| `npm run assist-check` (`node scripts/assist-check.js`) | End-to-end AI + jobs flow in headless Chrome against a stub OpenAI-compatible server: suggest, accept/reject, tailor, evaluate, cover letter, the match gauge, the tracker, the always-on ATS chip, the Review tab's 8 checks, the local job evaluation table, the jobs board (drag/keyboard move persists) and the command bar. No real provider is ever contacted |

CI runs `npm test` and `npm run smoke` on `ubuntu-latest` with Node 22, `fonts-liberation` and `poppler-utils`.

## Manual QA checklist

Run through this before a release, in Chrome at least and in Firefox and Safari for the print steps. Start from a fresh browser profile (or clear the site's data).

**First run and editing**

- [ ] `node serve.js`, open the URL: the sample CV loads, the first-run note says the CV lives in this browser.
- [ ] Opening `index.html` from disk (`file://`) is the documented unsupported case: it fails, and the README says so.
- [ ] Type in the editor: the pages update without a visible lag. Headings, entry fields, bullets and links are highlighted.
- [ ] Insert menu: Section, Entry, Bullet, Rule, Untitled panel and Line break insert at the caret with the placeholder selected.
- [ ] `?` popover shows the syntax. A markup diagnostic links to it.
- [ ] Moving the caret selects the section on the canvas. Clicking a section jumps the editor to its line. Double-clicking text on the canvas focuses that line.
- [ ] Undo and redo (`Cmd/Ctrl+Z`, `Shift+Cmd/Ctrl+Z`) outside the textarea undo layout and content changes. Inside the textarea it is native text undo.

**Canvas handles**

- [ ] Drag each of the 4 margin handles: live mm readout, snapping to 1 mm, margins, column edges and the page centre; `Alt` disables snapping. One undo step per drag. The inspector's margin inputs follow.
- [ ] Drag the gutter and each column boundary in a 2- and a 3-column layout. Widths and the gutter update in the inspector.
- [ ] Zoom: fit width, 50 % to 200 %. Handles stay under the pointer at every zoom. Rulers show mm.

**Sections**

- [ ] Drag a section by its grip within a column, then to another column. The drop indicator is right, the source lines move in the editor, and one undo reverts both.
- [ ] Section inspector: variant (list, compact, timeline, tags, grid), title on/off, rules, break before, keep together, panel with each border style. Hide a section and show it again.

**Decor**

- [ ] Draw a line, a panel and an ellipse. Select, move, resize and nudge with the arrow keys (1 mm, `Shift` 5 mm). `[` and `]` switch front and back. `Delete` removes it. Each is one undo step.
- [ ] Decor on `all`, `first`, `rest` and specific pages in a 2-page CV.
- [ ] ATS X-ray: decor dims, blocks are numbered in stream order, and the numbers match the ATS panel.

**Design**

- [ ] Every inspector control changes the pages, and every drag has a numeric input.
- [ ] Templates gallery: thumbnails show the current content. Applying one is one undo step with an Undo toast. The page size and target pages are kept.
- [ ] Remix gives a new look with no new preflight errors and undoes in one step.
- [ ] Fit to N pages reaches the target, or says it can't without body text below 9 pt.
- [ ] Upload a custom font (`.woff2`, `.ttf`), use it, reload: it is still there. Save a `.cv.json`, open it in a fresh profile: the font is embedded.
- [ ] Photo upload: shape and position work, and a large photo is downscaled.
- [ ] Custom CSS applies to the canvas and the PDF. `url(https://…)` in it is blocked (a CSP report in the console, no request).

**Checks**

- [ ] The Check panel lists errors, then warnings, then info. Locate jumps to the line or the page. Fix applies and undoes in one step. A fix on an edited line shows as stale.
- [ ] The ATS panel text matches `pdftotext -raw` of the printed PDF. Copy and Download `.txt` work.

**Files and storage**

- [ ] New, duplicate, rename, delete (the confirm names the document), switch documents.
- [ ] Save and Save as (`Cmd/Ctrl+S`, `Shift+Cmd/Ctrl+S`): File System Access in Chromium, a download elsewhere. The save status in the top bar is right.
- [ ] Import `.cv.json`, `.md`, JSON Resume and pasted text. Export `.txt`, JSON Resume and `.cv.json`, and re-import each.
- [ ] Open the same document in two tabs and edit one: the other shows "Changed in another tab".

**Print**

- [ ] Chrome: **Export → PDF (print)** or `Cmd/Ctrl+P`, **Save as PDF**. Same pages and breaks as the canvas, backgrounds present, no app UI, selectable text, PDF title "<Name> — CV".
- [ ] Firefox and Safari: the one-time print checklist appears (paper size, 100 % scale, headers and footers off, background graphics on). Following it gives a correct PDF.
- [ ] `node cli/recto.js export samples/sample.cv.json -o out/cli.pdf` matches the Chrome print.

**Accessibility and layout**

- [ ] Every control is reachable and usable with the keyboard, with a visible focus ring and a label.
- [ ] Light and dark UI both meet WCAG AA contrast. The CV page stays paper-coloured.
- [ ] `prefers-reduced-motion` turns animations off.
- [ ] Below 900 px wide the panes become the tabs Write, Design and Check.
