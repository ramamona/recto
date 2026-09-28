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
serve.js                    zero-dependency static server (createServer, listen); used by the CLI and smoke test; loopback-only
                            /api/fetch (job-link proxy) and /api/apply (drives `recto autoapply` for the apply queue)
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
  latex.js                  pure: toLatex(doc, layout, { name }) → a self-contained LaTeX article (geometry, hyperref,
                             enumitem only), following the layout's section order, hidden sections and column reading order
  plaintext.js              pure: fromPlainText(text, lang) → { content, notes }; pasted or extracted CV text → Recto Markdown draft
  extract.js                pure: extractFile(File) → { text, kind, warnings }; readers for DOCX, PDF, HTML, RTF, TXT/MD (never throws)
  storage.js                localStorage documents, IndexedDB fonts, photo downscaling
  files.js                  open / save / download, File System Access API where available

src/ai/                     pure; no fetch or storage happens at import, only when called
  providers.js               createClient(connection): one client per provider (Anthropic, OpenAI, OpenRouter, Google Gemini, GitHub Models, Ollama, LM Studio, Custom) behind complete()/listModels()/test(); OpenRouter's PKCE sign-in
  connections.js              the active connection and per-provider consent: memory first, localStorage['recto:ai'] only when the user opts to remember
  guard.js                    validateSuggestions: checks an AI suggestion's line still matches, keeps its Recto Markdown kind, and flags facts (numbers, URLs, capitalized words) not already in the CV as "new-facts"
  prompts.js                  prompt and JSON-Schema builders per feature (suggest, rewrite, tailor, evaluate, cover letter, extract job,
                               practice, stories, add-to-CV, classify-reply) plus BRIEF_MODES/briefPrompt for the 15 career-ops-parity
                               brief modes (research, outreach, email, interview-prep, interview-plan, debrief, redflags, negotiate,
                               offer-review, followup, compare, training, project, titles, upskill); numberSource prefixes each line
                               so replies can cite it; every prompt carries the no-fabrication rule
  assist.js                   createAssist({ client, getState }): prompt → client.complete → tolerant JSON parse with one retry →
                               guard.js validation → normalized result; brief(mode, { job, notes, extra }) → Brief { title,
                               sections[], needsInput[] } for the modes above, practice({ job, question, answer }), stories()
                               (drafted only from cited CV lines), addToCv(text), classifyReply(text)
  playbook.js                  loads agent/modes/*.md keyed by file name for the app's AI prompts (career mode files are optional;
                                a missing one only drops that entry)

src/jobs/                   pure
  region.js                    country presets (career suite): REGIONS (AU, NZ, GB, US, CA, IE, DE, FR, SG, IN — states,
                                currency, retirement wording, clearances, checks, diversity items, feed codes), DEFAULT_COUNTRY,
                                countryOf/regionOf/mentionsCountry/inArea/countriesIn, authorizedFor(authorizedIn, text),
                                detectCountry({ timeZone, language }); the single source of country matching for discover.js,
                                evaluate.js and pack.js
  parse.js                    parseJob(text): postings → { title, company, location, requirements, keywords, salary?, postedAt?, signals }; keywordsIn/canonicalTokens (a ~140-term tech/soft-skill vocabulary plus capitalisation heuristics) back both parsing and matching
  match.js                     matchCv(cv, job): the local Recto match estimate (keywords 55%, requirements 20%, parseability 15%, essentials 10%), no AI
  legitimacy.js                checkLegitimacy(job): heuristic flags (stale/no posting date, reposted, payment or ID requests, messaging-app redirects, implausible salary, generic text, email/domain mismatch, urgency language) → ok/caution/red-flag
  evaluate.js                  evaluateJob({ source, doc, layout, issues }, job, { profile, now, liveness }) → the career-ops-style Evaluation:
                                role summary, gates (liveness, geo-mismatch, work authorization via region.js authorizedFor,
                                deal-breakers), a two-pass requirement table (importance from the JD alone, then matched
                                against the CV with quoted evidence), a 1–5 score capped by the gates, recommendation, and
                                legitimacy incl. a prompt-injection check
  tracker.js                   createTracker(storage): jobs in localStorage['recto:jobs'], CRUD, evaluations (addEvaluation), export/import
                                JSON; STATUSES incl. 'no-response', statusHistory per job, staleApplied(job, now, days=21); keeps a job's
                                applyUrl, board, questions, application pack, and (career suite) optional outcome, followUps,
                                contacts, interviews, offer, per-mode AI artifacts and an applyLog
  sources.js                   job-source adapters (Greenhouse, Lever, Ashby, SmartRecruiters, Workable boards; Remotive,
                                Arbeitnow, Jobicy feeds) → normalized Postings; Greenhouse/SmartRecruiters form questions
                                (fetchDetails); findBoards(name, { fetch }) probes slug variants of a company name across every
                                board for a public one with open roles; the company list in localStorage['recto:companies']
  discover.js                  discover({ companies, settings, profile, cv, tracker, fetch }): scan with concurrency 6, filter by
                                roles/location/remote/age/deal-breakers/country (region.js mentionsCountry/inArea), drop tracked
                                jobs, evaluate locally, rank; scan settings in localStorage['recto:discover'] (incl. country, feeds.jobicy)
  answers.js                   the answer bank (career suite): normalizeQuestion, similarity (token Jaccard), findAnswer(bank, q,
                                { options }) → exact match, then same rule, then similarity ≥ 0.6 (choice answers mapped onto
                                options), remember(bank, { question, answer, options }, now), import/exportAnswers,
                                COMMON_QUESTIONS + commonQuestions(country), completeness(profile, country)
  pack.js                      buildPack({ job, cv, profile, assist }): the application pack (standard fields, rule answers from
                                every candidate-profile field, then the answer bank, then AI drafts for free text only);
                                ruleAnswer/authorizedFor shared with cli/autoapply.js
  insights.js                  (career suite) funnel/rates/rejections/reposts/calibration/skillGaps/adjacentTitles from tracker
                                jobs; cadence/followUpsDue (follow-up scheduling); classifyReply(text) → rule-based reply
                                classification; salaryGap({ desired, advertised, offered }); compare(jobs) → Compare view rows
  fetch.js                     fetchJob(url): Greenhouse/Lever/Ashby public APIs, then the local /api/fetch proxy (serve.js), then an injected webFetch, else rejects with { code: 'needs-paste' }

src/profile.js               pure; localStorage['recto:profile']: loadProfile/saveProfile/normalizeProfile — the full career
                              suite candidate profile (identity, contact, address/country, work rights, availability,
                              compensation, checks, background, preferences, diversity, the answers bank, the story bank), plus
                              the original authorized countries, sponsorship, locations, remote preference, target roles,
                              deal-breakers, salary floor. An empty field means that gate is skipped in evaluateJob, never
                              guessed; old profiles load unchanged.

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
  ai-dialog.js               Connect AI providers dialog (top bar): provider cards, model list, test connection, remember-on-this-device, and the per-provider first-use consent prompt
  jobs-dialog.js              (superseded by jobs-board.js; kept only as dead code — nothing imports it any more)
  jobs-board.js               openJobsBoard(store, ctx): full-screen board (spec §5) — 6 columns + collapsed Skipped,
                              drag-and-drop plus ←/→ keyboard moves (both record a statusHistory entry), stale-applied
                              hint, per-card selection checkboxes and overdue follow-up chip, header Compare/Apply to
                              selected/Apply to all saved/Insights, search/counts/export/import; a card opens job-workspace.js
  assist-panel.js             Suggest tab: AI diff cards (word-level LCS diff, accept/reject/edit per card, "Accept all safe") plus src/suggest/local.js's deterministic tips; also sets ctx.runAssist
  job-panel.js                Job tab: paste a link or text → parseJob/fetchJob, the match gauge, legitimacy flags, the
                              local evaluateJob report (rendered as soon as a job is parsed, no AI needed), "Refine with
                              AI", and the AI actions (Evaluate, Tailor CV, Draft cover letter, Save to tracker); also
                              registers ctx.openProfileDialog
  discover-view.js            openDiscover(store, ctx): full-screen Discover view — country select (region.js), scan
                              settings and company list, Find boards, Scan with progress, filter chips, per-result
                              checkboxes + Select ★≥n + Apply to selected, a Pipeline inbox header button, ranked cards
                              with Save · Skip · Prepare application
  pack-view.js                openPack(store, ctx, jobId): application pack dialog (tailored CV, cover letter, questions
                              with answer-bank "Remember for similar questions", fields, Open application page, Mark
                              applied, the autoapply command); the pack is stored on the tracker job
  profile-dialog.js           openProfileDialog(ctx): full-screen Candidate profile view over src/profile.js — a left
                              section nav, a country select driving preset fields, a completeness meter, saved-answers
                              and story-bank management
  apply-queue.js               openApplyQueue(store, ctx, { jobIds }): the one-click apply queue — prepare packs for every
                              job, one grouped form for missing answers (writes the answer bank), then run via the
                              serve.js /api/apply bridge (status polling, "I submitted it"/Skip, Stop) or, hosted, a
                              downloaded recto-apply.json bundle and the recto autoapply --bundle command
  job-workspace.js             the board drawer's tab strip: Overview, Pack, Research, Outreach, Interview, Offer,
                              Follow-ups; each AI tab stores its result on the tracker job (artifacts[mode]) with
                              Generate/Regenerate and Copy, and needs a connected provider (else "Connect AI providers")
  compare-view.js              openCompare(store, ctx, { jobIds }): a 2–5 job side-by-side table (src/jobs/insights.js
                              compare) plus an optional AI recommendation across them
  insights-view.js             openInsights(store, ctx): full-screen Insights — funnel, response rates, score
                              calibration, rejections, reposts/ghost suspects, top skill gaps (+AI upskill plan),
                              adjacent titles (+AI suggestions), career advice (AI), CSV export of the funnel
  pipeline-view.js             openPipeline(store, ctx): full-screen Pipeline inbox — paste links/JDs, Process all
                              (fetch → parse → evaluate → optional AI deep-evaluate → save → build pack, 2 at a time),
                              per-item state and retry, Apply to processed
  command-bar.js              mountCommandBar(store, ctx): Cmd/Ctrl-K palette over AI actions, app actions (incl.
                              Candidate profile, Discover, Pipeline inbox, Insights, Apply to all saved) and "go to
                              section", fuzzy-filtered, recent commands first; an action whose ctx function isn't
                              wired up yet is left out of the list rather than shown disabled

styles/                     app.css, editor.css, canvas.css, inspector.css, assist.css, board.css, command.css, discover.css
                            (app UI; discover.css also styles the pack and the Pipeline inbox), profile.css, apply.css,
                            insights.css; cv.css (the pages)
locales/en.json             UI strings (flat keys)
templates/                  index.json + one JSON file per template
samples/sample.cv.json      first-run document and smoke-test input
cli/recto.js  cli/chrome.js CLI; minimal DevTools-protocol driver over --remote-debugging-pipe; also `recto discover`
cli/autoapply.js            `recto autoapply`: fills saved jobs' application forms in a visible Chrome, stops before Submit
                            unless --submit and every guard passes (score, daily cap, required fields, CAPTCHA/login/account
                            wall); --bundle/--progress-json for the app's local apply-queue bridge (serve.js /api/apply)
agent/                      the agent playbook; agent/modes/ has the original modes (answer.md drafts screening-question
                            answers with no invented facts) plus 19 career-ops-parity modes (research, outreach, email,
                            interview-prep, interview-plan, practice, debrief, redflags, negotiate, offer-review, followup,
                            compare, training, project, titles, upskill, stories, add, reply), loaded by src/ai/playbook.js
scripts/smoke.js            every template through print mode and PDF
scripts/render-check.js     pagination and paint checks on generated documents
scripts/assist-check.js     end-to-end AI + jobs + career-suite flow in headless Chrome against a stub OpenAI-compatible
                            server (no real provider is ever contacted, every network host stubbed): AI suggestions, job
                            match/evaluate/tailor/cover-letter, the always-on ATS chip, the Review tab's 8 checks, the
                            local job evaluation table, the jobs board (drag/keyboard move persists a status change),
                            the command bar, the candidate profile and answer bank, the apply queue, the job workspace
                            and Insights/Pipeline inbox
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

**AI.** Nothing runs until the user connects a provider in `src/ui/ai-dialog.js`, which calls `src/ai/providers.js`'s `createClient(connection)` and stores the connection with `src/ai/connections.js` (memory only, unless "Remember on this device" opts into `localStorage`). A feature (Suggest tab, rewrite, tailor, evaluate, cover letter) calls `src/ai/assist.js`'s `createAssist({ client, getState })`, which builds a prompt and JSON Schema with `src/ai/prompts.js`, sends it through the client, tolerantly parses the JSON reply (one retry on a bad shape), and validates every suggestion with `src/ai/guard.js`'s `validateSuggestions` — checking the target line hasn't changed, the replacement keeps the line's Recto Markdown kind, and flagging any number, URL or capitalized word not already in the CV as `new-facts` so it's excluded from "Accept all". `src/ui/assist-panel.js` renders the result as diff cards; nothing is written to the document except by an explicit accept. The career suite's 15 `brief` modes (job workspace tabs, Insights) and `practice`/`stories`/`addToCv`/`classifyReply` go through the same `createAssist`, with prompt text loaded per mode from `agent/modes/*.md` via `src/ai/playbook.js`, and every result still passes through `guard.js` or an equivalent citation check before it's shown.

**Jobs.** `src/ui/job-panel.js` turns a pasted link or text into a job: a link goes through `src/jobs/fetch.js`'s `fetchJob`, which tries the Greenhouse/Lever/Ashby public APIs, then the local `/api/fetch` proxy (`serve.js`, local mode only), then an injected `webFetch`, and otherwise asks the user to paste the text. The resulting text is parsed by `src/jobs/parse.js`'s `parseJob` into requirements and keywords, scored against the open CV with `src/jobs/match.js`'s `matchCv` (no AI, ever) and checked with `src/jobs/legitimacy.js`'s `checkLegitimacy`. Saving a job stores it with `src/jobs/tracker.js`'s `createTracker` (`localStorage['recto:jobs']`), browsable in `src/ui/jobs-board.js`. AI job actions (Evaluate, Tailor CV, Draft cover letter) go through the same `createAssist` path as CV suggestions.

**Discover and the answer bank.** `src/ui/discover-view.js` scans `src/jobs/sources.js` adapters through `src/jobs/discover.js`'s `discover()`, filtering by `src/jobs/region.js`'s country matching, then locally evaluates and ranks results — no AI. `src/ui/pack-view.js` and `src/ui/apply-queue.js` build an application pack per job with `src/jobs/pack.js`'s `buildPack`, whose rule answers now cover every `src/profile.js` field; anything the rules don't cover is filled from `src/jobs/answers.js`'s answer bank (`findAnswer`) before falling back to an AI draft for free text only. Saving an answer (in a pack or the apply queue) calls `remember()` and writes it back to the profile with `saveProfile`, so it refills every other pack asking something similar. `src/ui/apply-queue.js` hands the prepared packs to `cli/autoapply.js` — through `serve.js`'s loopback-only `/api/apply` bridge when running locally, or as a downloaded bundle otherwise — which never submits anything unless the user opted into `--submit` and every guard passes.

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
| `npm run assist-check` (`node scripts/assist-check.js`) | End-to-end AI + jobs + career-suite flow in headless Chrome against a stub OpenAI-compatible server (every network host stubbed): suggest, accept/reject, tailor, evaluate, cover letter, the match gauge, the tracker, the always-on ATS chip, the Review tab's 8 checks, the local job evaluation table, the jobs board (drag/keyboard move persists), the command bar, the candidate profile and answer bank, the apply queue (with and without the local bridge), the job workspace's tabs, and Insights with the Pipeline inbox. No real provider is ever contacted |

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

**Career suite** (see [career-suite.md](career-suite.md))

- [ ] Candidate profile: switching country changes the state list, currency and which checks/diversity fields show; the completeness meter and its links work; a saved answer appears in Saved answers with the right source badge.
- [ ] Discover: Find boards returns results and Add works; a scan with a country set only returns matching postings; select results and **Apply to selected** opens the apply queue.
- [ ] Apply queue: a shared question across two jobs is grouped once; answering it fills both packs; the run step's mode radio and the confirmation checkbox behave; with `node serve.js` running, the local bridge shows live per-job state; without it, the download and command are shown instead.
- [ ] Job workspace: every tab renders; an AI tab without a provider shows **Connect AI providers**; pasting a rejection email classifies and offers **Move to Rejected**.
- [ ] Compare (2–5 selected jobs) and Insights (funnel, rates, calibration, reposts, skill gaps, CSV export) render with no data and with data.
- [ ] `node cli/recto.js discover --country US --out jobs.json` writes a jobs file that imports cleanly; `node cli/recto.js export samples/sample.cv.json -o out/cli.tex` produces a `.tex` file.
