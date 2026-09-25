# Recto Assist — AI suggestions, job match and tracker (design spec)

Date: 2026-09-25 · Branch: `feat/ai-assist` · Status: awaiting owner review
Builds on the v1 spec (`2026-09-24-recto-cv-builder-design.md`), which stays binding where this document is silent.

## 1. Intent

**Owner asked for:** a suggestions section; AI via different providers (API keys, sign-in, local, custom models) that can alter the CV on the fly; putting the CV through an ATS-style check against a job posting (link) with a score; tailor-to-job, job tracker, cover letter, posting-legitimacy check. Inspiration: career-ops.

**Principles (from career-ops, adopted):** a human decides — AI only proposes, every change is accepted per item; AI rephrases, never fabricates; local-first — AI is off by default and nothing leaves the machine until the user connects a provider and confirms; the CV goes only to the provider the user chose; the app never submits applications or sends messages.

**Assumptions:** the existing no-backend, zero-dependency, no-build architecture stays; everything works without AI (local suggestions, local match score, legitimacy heuristics, tracker); AI adds depth.

**Success criteria**
1. With no provider connected: paste a job description → a match score with breakdown, missing keywords (click → where to add them), legitimacy flags, and local suggestions, in < 1 s.
2. With a provider connected: "Suggest improvements" and "Tailor to this job" return diff cards the user accepts/rejects; accepted cards apply as normal undoable content edits; any card that introduces facts absent from the CV is flagged and never included in "Accept all".
3. Each of the 6 connection types works end to end against a stub server in tests (Anthropic, OpenAI, OpenRouter OAuth, Ollama, LM Studio, custom OpenAI-compatible).
4. Job links: Greenhouse/Lever/Ashby URLs import in both local and hosted mode; any URL imports in local mode; pasting text always works.
5. No regressions: all v1 tests, render-check and smoke stay green; app JS+CSS budget raised to ≤ 400 KiB (ruling: AI adds a subsystem).

**Non-goals:** auto-applying, sending email/LinkedIn messages, scraping job boards in bulk (career-ops' portal scanner), salary research, interview prep, accounts or a Recto backend, streaming UI (responses arrive whole; a spinner with Cancel is enough).

## 2. Connections (`src/ai/providers.js`)

| Id | Auth | Endpoint | Notes |
|---|---|---|---|
| `anthropic` | API key | `https://api.anthropic.com/v1/messages` | headers `x-api-key`, `anthropic-version: 2023-06-01`, `anthropic-dangerous-direct-browser-access: true`. Default model `claude-sonnet-5`; list: `claude-opus-5-5`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`. Supports the server-side `web_fetch` tool for job links. |
| `openai` | API key | `https://api.openai.com/v1/chat/completions` | model list from `GET /v1/models` (filtered to chat models). |
| `openrouter` | **OAuth PKCE sign-in** | `https://openrouter.ai/api/v1/chat/completions` | Sign-in: redirect to `https://openrouter.ai/auth?callback_url=<app url>&code_challenge=<S256>&code_challenge_method=S256`; on return (`?code=`), `POST https://openrouter.ai/api/v1/auth/keys { code, code_verifier }` → key. Model list from `GET /api/v1/models`. |
| `ollama` | none | `http://localhost:11434/v1/chat/completions` | OpenAI-compatible; model list `GET /v1/models`. |
| `lmstudio` | none | `http://localhost:1234/v1/chat/completions` | OpenAI-compatible. |
| `custom` | optional key | user base URL + `/chat/completions` | Any OpenAI-compatible server (vLLM, Together, Groq, Azure-compatible gateways…); user types base URL and model. |

Interface: `createClient(connection) → { complete({ system, messages, json?: Schema, maxTokens, signal }) → Promise<{ text, json?, usage? }>, listModels() → Promise<string[]>, test() → Promise<{ ok, error? }> }`. `json` requests structured output: Anthropic via a forced tool call with the schema; OpenAI-compatible via `response_format: { type: 'json_schema' }` falling back to "reply with JSON only" + tolerant parse. All errors normalized to `{ code: 'auth'|'rate-limit'|'network'|'cors'|'bad-response'|'aborted', message }`.

`connection = { provider, model, baseUrl?, apiKey?, remember: boolean }`. Keys live in memory; `remember` stores the connection in `localStorage['recto:ai']`. Keys are never written into `.cv.json`, exports, logs or the tracker.

**CSP change (ruling):** `connect-src 'self' https: http://localhost:* http://127.0.0.1:*`. Needed for user-chosen HTTPS endpoints. Safe because only first-party JS can issue fetches; user Markdown never becomes script and custom CSS is still limited by `img-src`/`font-src` (no remote `url()`). All other directives unchanged.

**Consent:** the first call to a provider in a session shows what will be sent ("your CV text and, if present, the job description") and to whom; "Don't ask again for this provider" is stored with the connection.

## 3. Jobs (`src/jobs/*`, all pure except fetch)

`Job = { id, url, source: 'greenhouse'|'lever'|'ashby'|'url'|'paste', title, company, location, text, postedAt?, fetchedAt, status: 'saved'|'applied'|'interview'|'offer'|'rejected'|'skipped', docIds: string[], evaluations: Evaluation[], notes, createdAt, updatedAt }` in `localStorage['recto:jobs']`, with Export/Import (JSON) in the tracker.

**Fetching a link** (`fetchJob(url, { connection })`), first that works:
1. Known ATS public APIs (CORS-enabled): Greenhouse `boards-api.greenhouse.io/v1/boards/<board>/jobs/<id>`, Lever `api.lever.co/v0/postings/<company>/<id>`, Ashby `api.ashbyhq.com/posting-api/job-board/<board>` (+ match id).
2. Local proxy when served by `serve.js`: `GET /api/fetch?url=` (added to serve.js; only enabled when bound to a loopback host; http/https only; rejects private/loopback/link-local IP targets after DNS resolution (SSRF), 2 MB cap, 10 s timeout, 5 redirects max, each re-checked; returns text via the existing HTML extractor).
3. Anthropic `web_fetch` tool, if connected (asks consent).
4. Otherwise: "Paste the job description" (always available).

`parseJob(text) → { title, company, location, requirements: [{ text, kind: 'must'|'nice', keywords: string[] }], keywords: string[], salary?, postedAt?, signals }` — pure heuristics (section headers like Requirements/Qualifications/Nice to have/Responsibilities, bullet lists, "must/required/preferred/bonus" wording). With AI connected, `extract-job` prompt returns the same shape (preferred when available).

## 4. Match score (`src/jobs/match.js`, pure, no AI)

`matchCv({ doc, source, layout, report, issues }, job) → { score: 0–100, bands: {...}, missing: [{ keyword, kind, where: sectionId|null }], present: [{ keyword, lines: number[] }] }`

- **Keywords 55 %**: must-have keywords weighted 2×, nice 1×; matching on normalized tokens with light stemming, a synonym/alias table (JS/JavaScript, k8s/Kubernetes, PostgreSQL/Postgres, CI/CD…), multi-word phrases, case-insensitive; counts only CV text that ATS extraction sees (`extractText`).
- **Requirements 20 %**: share of `must` requirements with ≥ 1 matched keyword.
- **Parseability 15 %**: from existing preflight — errors −, warns −, multi-column −, non-standard headings −.
- **Essentials 10 %**: name, email, phone, dated experience entries, title alignment (job title words appear in tagline/recent titles).
- UI labels it **"Recto match estimate"** with a one-line honesty note: real ATS scoring differs per employer.
- `missing` suggests a target section (skills keyword → skills section; else the most recent experience entry).

## 5. Legitimacy (`src/jobs/legitimacy.js`, pure + optional AI)

Heuristic signals with severity: posting age > 45 days / no date; reposted (same title+company saved before with a different id); no company name; asks for payment, bank/ID documents, SSN, or messaging apps (Telegram/WhatsApp) before an interview; salary absurdly high for the title or a range spanning > 3×; generic text (low specificity: few concrete tools/responsibilities); mismatched email domain vs company; "urgent"/"no experience, high pay" patterns. Output `{ level: 'ok'|'caution'|'red-flag', signals: [{ code, severity, evidence }] }`. AI evaluation adds its own legitimacy block (§6).

## 6. AI features (`src/ai/prompts.js`, `src/ai/assist.js`)

Every prompt includes the Recto Markdown grammar summary and the **no-fabrication rule**: "Only rephrase, reorder, cut or emphasise facts already present in the CV. Never add employers, titles, dates, degrees, metrics, tools or achievements that are not in the CV. If a suggestion needs a fact the CV lacks, ask for it in `needsInput` instead of inventing it."

| Feature | Output schema (JSON) | Applied as |
|---|---|---|
| Suggest improvements | `{ suggestions: [{ line, expect, replacement, reason, category: 'impact'|'clarity'|'keyword'|'concision'|'grammar'|'structure', needsInput? }] }` | diff cards → content edits |
| Rewrite selection (on the fly) | same, for the selected lines, with an instruction: *stronger*, *shorter*, *quantify*, *fix grammar*, *more formal*, or free text | diff cards |
| Tailor to job | same + `keywordsAdded[]`, `summary` | duplicate doc "<name> — <company>" linked to the job, cards queued there |
| Evaluate fit (career-ops style) | `{ score: 1–5, recommendation: 'apply'|'consider'|'skip', summary, requirements: [{ text, weight, evidence, verdict: 'met'|'partial'|'missing' }], gaps[], levelFit, legitimacy: { level, notes }, pitch }` | stored on the job; shown as a report |
| Cover letter | `{ subject?, paragraphs: string[] }` | new doc "<name> — Cover letter — <company>": header copied from the CV, untitled section with the paragraphs, same layout/template |
| Extract job | §3 shape | job fields |

**Validation (`src/ai/guard.js`, pure):** every suggestion is checked before display: `expect` must equal the current source line (else "stale", hidden); the replacement must parse cleanly as the same line kind (bullet stays bullet, entry stays entry with same field count); **fabrication check** — numbers, dates, capitalized proper nouns/tools and URLs in the replacement that do not occur anywhere in the CV (or, for tailoring, in the CV ∪ job's keywords for skills lines only) mark the card **"Adds new facts — verify"**, excluded from "Accept all". Malformed AI output → one automatic retry with the parse error, then a readable error.

## 7. UI

- **Side panel tabs** become: Check · ATS · **Suggest** · **Job**.
- **Suggest tab:** local suggestions (deterministic, no AI: weak openers like "Responsible for/Worked on", bullets without numbers, passive voice, filler words, long bullets, repeated verbs — each with a one-line tip and, where safe, a fix) + "Improve with AI" button (disabled with "Connect AI" link when none). Diff cards: before/after with word-level highlight, reason, category chip, Accept · Reject · Edit (inline textarea) · Locate; "Accept all safe (n)".
- **Editor:** selecting text shows a small "✨ Rewrite" chip → instruction menu → diff card(s) in the Suggest tab (and inline preview under the selection).
- **Job tab:** input "Paste a job link or description" → job card (title, company, source link opens in a new tab) → **match gauge** (0–100) with the four bands, missing keywords as chips (click → reveal the target section and open an Insert suggestion), present keywords, legitimacy flags → buttons: Evaluate with AI · Tailor CV · Draft cover letter · Save to tracker. Saved jobs remember their score history (local + AI).
- **Top bar:** **Jobs** (tracker dialog: table with company, title, status select, local score, AI score, linked docs, updated; filters by status; open job; delete with confirm; export/import JSON) and **AI** (connections dialog: six provider cards, connect/sign in, model select with list refresh, Test connection, "Remember on this device", Disconnect, privacy explainer).
- All strings via i18n; all network errors become toasts with a retry.

## 8. Modules and files

```
src/ai/providers.js   createClient, PROVIDERS, pkce helpers (openrouter)
src/ai/connections.js load/save/forget connections (memory + opt-in localStorage), consent flags
src/ai/prompts.js     prompt builders + JSON schemas per feature
src/ai/guard.js       validateSuggestions, fabrication check, tolerant JSON parse
src/ai/assist.js      high-level: suggest(), rewrite(), tailor(), evaluate(), coverLetter(), extractJob()
src/jobs/fetch.js     fetchJob (ATS APIs → local proxy → web_fetch → error), ATS URL parsers
src/jobs/parse.js     parseJob heuristics
src/jobs/match.js     matchCv
src/jobs/legitimacy.js legitimacy heuristics
src/jobs/tracker.js   jobs store (localStorage), export/import, score history
src/suggest/local.js  deterministic writing suggestions
src/ui/assist-panel.js  Suggest tab + diff cards
src/ui/job-panel.js     Job tab
src/ui/jobs-dialog.js   tracker dialog
src/ui/ai-dialog.js     connections dialog + consent
styles/assist.css
serve.js              + /api/fetch (loopback-only, SSRF-safe)
test/*.test.js        providers (fake fetch per provider incl. OAuth exchange), guard, prompts parsing, match, parse, legitimacy, tracker, local suggestions, fetch (ATS URL mapping), serve proxy (SSRF: 127.0.0.1, 10.x, 169.254.x, ::1, DNS-rebind to private)
scripts/assist-check.js  browser e2e with a stub OpenAI-compatible server (custom provider): suggest → accept → content changed; tailor → new linked doc; evaluate → tracker entry; cover letter → new doc
```

## 9. Testing

Unit tests for every pure module (§8). Provider tests stub `fetch` and assert request shape (URL, headers, body, JSON-schema/tool wiring) and response normalization, including error codes. `scripts/assist-check.js` runs the whole flow in headless Chrome against a stub model server that returns canned JSON, plus one malformed response to exercise the retry. v1 suites must stay green.

## 10. Later

Streaming responses, bulk portal scanning, interview prep / STAR story bank, salary research, application email drafts, browser extension for one-click job capture.
