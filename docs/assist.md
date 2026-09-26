# AI & jobs assist

Everything in this document is optional. With no provider connected, Recto still gives you a local ATS match score, missing-keyword chips, legitimacy flags and deterministic writing suggestions the moment you paste a job description — all computed in your browser, nothing sent anywhere. Connecting a provider adds AI-backed suggestions, tailoring to a specific job, a fit evaluation, and a cover-letter draft.

## Principles

- **A human decides.** AI only proposes. Every suggestion is a diff card you accept, reject or edit — nothing is written to your CV without a click.
- **No fabrication.** AI is instructed to only rephrase, reorder, cut or emphasise facts already in your CV, never to invent an employer, title, date, degree, metric, tool or achievement. Every card is also checked in your browser: if its replacement text contains a number, date, URL or capitalized word/tool that isn't anywhere in your CV (or, when tailoring, in the job's own keywords), it's marked **"Adds new facts — verify"** and left out of "Accept all".
- **Local-first.** AI is off by default. Nothing leaves your machine until you connect a provider in the **AI** dialog (top bar) and confirm the first-use consent prompt, which tells you exactly what will be sent (your CV text, and the job description if one is open) and to which provider.
- **Your data goes to one place.** Only the provider you chose ever sees your CV — never Recto's own servers, because there are none.
- **Recto never acts for you.** It never submits an application or sends a message on your behalf.

## Connecting a provider

Open **AI** in the top bar. Six provider cards:

| Provider | What you need |
|---|---|
| **Anthropic** | An API key from [console.anthropic.com](https://console.anthropic.com). |
| **OpenAI** | An API key from [platform.openai.com](https://platform.openai.com). |
| **OpenRouter** | Click **Sign in** — this opens openrouter.ai, and you're redirected back with a key. No key to copy by hand. |
| **Google Gemini** | Paste an API key from [Google AI Studio](https://aistudio.google.com/apikey). Recto uses Gemini's OpenAI-compatible endpoint; pick any `gemini-*` model from the list. |
| **GitHub Models** | Paste a GitHub token with the `models:read` permission (fine-grained token). GitHub Models is free within limits and has higher limits for Copilot subscribers. Copilot's own chat API isn't available to third-party apps, so this is the supported way to use your GitHub/Copilot access. Model ids look like `openai/gpt-4.1`. |
| **Ollama** (local) | Run Ollama on your machine, pull a model, and set `OLLAMA_ORIGINS` (see below). No key needed. |
| **LM Studio** (local) | Run LM Studio's local server with CORS enabled (see below). No key needed. |
| **Custom** | Any OpenAI-compatible server (vLLM, Together, Groq, an Azure-compatible gateway, your own stub for testing…). You must provide a base URL; a model key is optional. |

Pick a model from the list (**Refresh** re-fetches it), optionally check **Remember on this device** to keep the connection in this browser's `localStorage`, and **Test connection**. **Disconnect** forgets it. An API key you don't choose to remember lives only in memory for this tab and is never written to `.cv.json`, an export, a log, or the job tracker.

### Local models: Ollama

Ollama's server blocks cross-origin requests by default, so a page open at `http://127.0.0.1:8710` (or wherever you're running Recto) can't reach `http://localhost:11434` until you allow it:

```sh
OLLAMA_ORIGINS="http://127.0.0.1:*,http://localhost:*" ollama serve
```

(On macOS with the Ollama app rather than the CLI, set `OLLAMA_ORIGINS` as a launchd environment variable and restart the app.) Then connect the **Ollama** card — no key required.

### Local models: LM Studio

In LM Studio's **Developer** tab, turn on the local server and enable **CORS** in its settings before starting it. Then connect the **LM Studio** card.

### Custom OpenAI-compatible servers

Enter the server's base URL (Recto appends `/chat/completions` itself) and, if the server needs one, a key. The server must reply to `OPTIONS` and `POST` with `Access-Control-Allow-Origin` — the same CORS requirement as Ollama and LM Studio — since the request comes from the page, not from a backend.

## What each feature does

- **Improve with AI** (Suggest tab): rewrites weak bullets and openers, one diff card per change.
- **✨ Rewrite** (Editor): select some text for a targeted rewrite (stronger, shorter, quantify, fix grammar, more formal, or your own instruction).
- **Tailor CV** (Job tab): duplicates the open CV as "\<name\> — \<company\>", linked to the job, and queues cards that lean into the posting's wording for skills you already have.
- **Evaluate with AI** (Job tab): a 1–5 fit score, a recommendation, per-requirement verdicts with evidence cited from your CV, gaps, level fit and a short pitch — saved on the job in your tracker.
- **Draft cover letter** (Job tab): a new linked document with your CV's header and a short, plain-text letter.

A malformed AI reply gets one automatic retry (with the parse error handed back to the model); after that you see a plain-language error instead of a crash.

## The match score

The gauge on the Job tab ("Recto match estimate") is computed entirely locally, whether or not AI is connected: 55% keyword coverage (must-haves count double), 20% share of "must" requirements you show evidence for, 15% parseability (from the same preflight that checks your PDF), 10% essentials (name, email, phone, dated experience, title alignment). Missing keywords are chips you can click to jump to where they'd fit. This is **not** the score a real employer's ATS will show you — every ATS scores differently, and there is no way to reproduce one exactly from outside it. Treat it as a checklist, not a verdict.

## Legitimacy flags

Recto checks a pasted or fetched posting against a set of heuristics before you invest time in it: no posting date or one that's stale (> 45 days), the same title and company reposted under a new listing, no company name given, requests for payment or bank/ID details or a move to a messaging app before any interview, a salary that's implausibly high or spans an unusually wide range, generic text with few concrete tools or responsibilities, an email domain that doesn't match the company, and urgency language ("apply now", "no experience necessary, high pay"). Flags are shown as **ok**, **caution** or **red-flag**, each with the specific evidence. **Evaluate with AI**, when connected, adds its own read on legitimacy to the same report — treat both as signals to look into, not a guarantee either way.

## Job links

Greenhouse, Lever and Ashby links are fetched directly (their APIs allow it from any browser). Any other link works when you're running Recto locally via `node serve.js`, through its built-in proxy — never on a plain static host, since a static host can't safely fetch on your behalf (see [self-hosting.md](self-hosting.md)). Pasting the job text directly always works, everywhere.

## ATS score: what it checks

The **ATS** chip in the top bar (`ATS 86 · B`) is always there — no job, no AI, nothing sent anywhere. It's a deterministic 0–100 score from eight weighted checks (`src/ats/score.js`); clicking it opens the **Review** tab with every check, what was deducted and why, a Locate/Fix for each item, and "What the ATS sees" — a mock applicant form built the way a parser would read your CV, with missing or misparsed fields called out by reason. Grades: **A** ≥ 90, **B** ≥ 80, **C** ≥ 70, **D** ≥ 60, else **F**.

| Check | Weight | Full marks when | Deducted for |
|---|---|---|---|
| `text` | 10 | extracted text ≥ 300 characters | proportionally below that; critical under 100 chars |
| `headings` | 20 | Experience, Education and Skills present with dictionary headings | −6 per missing required section, −2 per non-standard heading (max −6), +1 per optional section (Summary, Projects, Certifications) present |
| `contact` | 15 | a valid email (8 pts), a phone (4 pts) and a location (3 pts) | the corresponding points; an invalid or missing email is critical |
| `order` | 20 | one text column throughout, header rendered first | −10 for multiple text columns, −5 when a section is split across columns, −5 when the header isn't first in reading order |
| `entries` | 15 | every experience/education entry has a title, an organisation and a parseable date | proportional to the share of complete entries |
| `chars` | 10 | standard font presets (5 pts) and no special/invisible characters (5 pts) | −2 for a custom uploaded font (info-level: embedded fonts usually extract fine), −3 for invisible characters, −2 for other special characters |
| `hidden` | 5 | nothing an ATS would treat as hidden | −3 for low-contrast text, −2 for text under 6 pt, −2 for custom CSS that hides or moves text |
| `length` | 5 | 1–2 pages, bullets ≤ 200 characters | −2 per page over 2, up to −3 total for overlong bullets |

The score is the sum of what each check earns (never negative, never over its weight). Checks reuse preflight's own issues where one already covers the same ground, so a check's items link to the same Locate/Fix as the Check tab always has.

## Job evaluation

With a job pasted or fetched, the **Job** tab evaluates it locally the moment it's parsed — no AI needed (`evaluateJob`, `src/jobs/evaluate.js`), inspired by career-ops' two-pass method:

- **Role summary** — archetype, seniority and remote/hybrid/onsite, classified from the title and text, plus a one-line tl;dr.
- **Gates**, shown above the requirement table when they apply: **Liveness** (closed when a URL job's fetch was 404/410 or the text says the role was filled — pasted text is always "unknown"), **Geo-mismatch** (the posting claims remote but the body has a binding attendance requirement, quoted verbatim), **Work authorization** (✅ sponsors / ➖ not needed / ⚠️ unstated / ⛔ no sponsorship — computed only once your [candidate profile](#candidate-profile) says something about authorization), **Deal-breakers** from your profile matched in the JD, quoted.
- **Requirement table (two-pass)** — pass 1 reads only the JD and assigns each requirement an *importance* (critical/stated, high/structural, meaningful/inferred) before your CV is looked at; pass 2 matches it against your CV as strong / partial / missing / n/a, with the CV line quoted as evidence (Locate jumps to it) and the JD's own phrasing alongside it. The table keeps every critical/high row and up to 12 rows total; a "dropped" count says how many lower-priority rows were left out.
- **Score (1–5)** — weighted coverage of the table (critical rows count 3×, high 2×, meaningful 1×; a strong match counts 1, partial 0.5), mapped to 1–5. ⛔ no-sponsorship or a closed posting caps the score at 1.5; a matched deal-breaker caps it at 2.0. ≥ 4.0 recommends **apply**, ≥ 3.0 **consider**, else **skip** — you can always override.
- **Legitimacy (G)** — the same heuristics as [Legitimacy flags](#legitimacy-flags) above, plus a check for imperative text in the JD aimed at an AI reader or reviewer (prompt injection), quoted when found.
- **Refine with AI**, when connected, upgrades the same report with AI-read evidence and wording; AI evidence must still quote a real CV line (validated by the fabrication guard) or it's dropped. Every evaluation — local or AI-refined — is saved on the job in your tracker with its score and recommendation.

### Candidate profile

Open **Candidate profile** from the Job tab or the command bar (`⌘K` / `Ctrl K`) to tell Recto where you're authorized to work, whether you need sponsorship, your target locations and remote preference, target roles, deal-breakers and a minimum salary. Anything you leave blank simply skips that gate — Recto never guesses. It's stored locally (`localStorage['recto:profile']`), never sent anywhere except as part of a Refine-with-AI request you've already consented to.

### Jobs board

**Jobs** in the top bar (or "Jobs board" in the command bar) opens a full-screen board with columns **Saved · Applied · Interview · Offer · Rejected · No response** (plus a collapsed **Skipped**). Drag a card between columns, or focus one and press **←/→**; every move is recorded with a date in the job's status history. A card **Applied** for 21 days with no change gets a "Move to No response?" hint — never automatic. Click a card for its detail drawer: the evaluation report, editable notes, a status timeline, linked CV documents, the source link and delete. The board header has per-column counts, search, and JSON export/import.

## Command bar

Press **⌘K** (macOS) or **Ctrl K** (elsewhere) anywhere in the app for a searchable list of actions: AI features (Improve CV, Rewrite selection, Tailor to the active job, Evaluate it, draft a cover letter), app actions (Templates, Jobs board, exports, Fit to N pages, toggle X-ray, Connect AI, your candidate profile) and jumping to any section of your CV. Type to filter, arrow keys to move, Enter to run; your most recent commands sort first when the box is empty. An action only shows up once the feature it needs is available — nothing appears disabled, unusable items just aren't listed.
