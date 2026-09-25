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
