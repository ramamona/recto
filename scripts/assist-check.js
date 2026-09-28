// End-to-end assist check (assist spec §1 success criteria, §8, §9): drives the real app in headless Chrome
// against a stub OpenAI-compatible server (the 'custom' provider) and asserts the whole AI + jobs flow.
// No real provider is ever contacted. Usage: node scripts/assist-check.js  (exit 1 on any failure)
//
// Driven through window.recto (store, ctx) wherever possible (panel switching, the tracker, the doc list) and
// through src/ui/assist-panel.js's and src/ui/job-panel.js's own class names otherwise, since neither module
// exposes data-testid hooks. Selectors relied on (all scoped to avoid the locale-dependent button text):
//   [data-action="ai-analyse"]      Suggest tab: "Analyse my CV" / "Re-analyse" button
//   .as-card, .is-ok / .is-new-facts / .is-stale / .is-invalid   diff cards, status is a class
//   [data-action="ai-accept-all"]   Suggest tab: "Accept all safe" button (only rendered once shown)
//   #job-input                      Job tab: paste-a-link-or-description textarea (job-panel.js sets this id)
//   .job-form__bar button           Job tab: "Analyze" button
//   .job-gauge__num                 Job tab: match gauge's number (SVG <text>)
//   .job-actions button (1..4)      Job tab: Evaluate with AI, Tailor CV, Draft cover letter, Save to tracker
//   [data-action="ats-chip"]        Top bar: always-on ATS score chip (review-jobs spec §4)
//   .rv-checks .rv-check            Review tab: one <li> per weighted ATS check (src/ats/score.js, 8 checks)
//   .job-reqs tbody tr              Job tab: local (no-AI) two-pass requirement table, renders after Analyze
//   .board[open], [data-job=ID]     Jobs board dialog and its cards (draggable, also movable with arrow keys)
//   .cmd-bar[open], .cmd-bar__input, .cmd-bar__item   Command bar (Cmd/Ctrl-K), its filter box and result rows
//   [data-action="discover"], .discover[open]          Top bar Discover button and the Discover view
//   [data-action="discover-scan"], .dc-card[data-source][data-posting]   Scan button and result cards
//   [data-action="discover-save|discover-prepare"]     per-card actions; .dc-attrib a = "via Remotive" link
//   .pack[open], .pack-cli, [data-action="pack-applied"]  Application pack view, its autoapply hint, Mark applied
// Career suite (career-suite spec §1, §7):
//   [data-action="profile"], .cp[open], [name=…], [data-action="profile-save"]   Top bar Profile button, Candidate profile view
//   .pack-q[data-source], .pack-badge.is-bank, [data-action="pack-answer-remember"]   pack answers and the answer bank
//   [data-action="board-select|board-apply-selected"]   board card checkbox, header Apply to selected
//   .aq[open], .aq-q, .aq-q__asked, [data-action="applyq-save-answers|applyq-start"], .aq-cli, .aq-row.is-<state>   apply queue
//   .ws-tab[data-tab], .ws-panel, [data-mode] [data-action="ws-generate"], textarea[data-draft="reply"],
//   [data-action="ws-reply|ws-reply-move"]   job workspace in the board drawer
//   .pipeline[open], [data-field="pipeline-input"], [data-action="pipeline-process|pipeline-close"], .pl-row.is-done   Pipeline inbox
//   .insights[open] [data-card="funnel"] .ins-funnel__num   Insights funnel

import http from 'node:http'
import { createServer, listen } from '../serve.js'
import { launch } from '../cli/chrome.js'

const READY_TIMEOUT = 30000
const ACTION_TIMEOUT = 15000

const JD = `Senior Backend Engineer at Globex Systems
Location: Remote

Requirements:
- 5+ years building distributed systems
- Strong experience with Kubernetes and PostgreSQL
- Must have led a small engineering team

Nice to have:
- Experience with Go
`

const BRIEF_TITLE = 'Initrode research brief'

// ---------------- stub OpenAI-compatible server ----------------

const NUMBERED = /^(\d+)│ (.*)$/gm // "N│ text" (src/ai/prompts.js numberSource)

const extractLines = text => [...text.matchAll(NUMBERED)].map(([, n, t]) => ({ line: Number(n), text: t }))
const isBullet = l => /^- /.test(l.text)
const toggle = t => t.endsWith('.') ? t.slice(0, -1) : `${t}.`

// One safe rewrite (no new facts) and one that fabricates an employer, to exercise the fabrication guard
// (src/ai/guard.js): the guard flags a capitalized name not already in the CV and excludes it from "Accept all".
function suggestionsPayload(bodyText) {
  const bullets = extractLines(bodyText).filter(isBullet)
  const out = []
  if (bullets[0]) out.push({ line: bullets[0].line, expect: bullets[0].text, replacement: toggle(bullets[0].text), reason: 'Tightens the phrasing.', category: 'clarity' })
  const risky = bullets[1] ?? bullets[0]
  if (risky) out.push({ line: risky.line, expect: risky.text, replacement: `${risky.text} at Globex Corp`, reason: 'Names the employer.', category: 'impact' })
  return { suggestions: out }
}

// Detects the feature from the instruction sentence in the prompt (assist spec §6), not the schema name:
// src/ai/prompts.js's EVALUATION schema has no title, so response_format.json_schema.name is 'result' for it.
function featureOf(body) {
  const text = (body.messages ?? []).map(m => m.content).join('\n')
  if (text.includes('Suggest improvements to this CV')) return 'suggest'
  if (text.includes('Rewrite lines')) return 'rewrite'
  if (text.includes('Tailor this CV to the job')) return 'tailor'
  if (text.includes('Evaluate how well this CV fits the job')) return 'evaluate'
  if (text.includes('Write a concise cover letter')) return 'coverLetter'
  if (text.includes('You extract structured fields from job postings')) return 'extractJob'
  if (/^Task: /m.test(text)) return 'brief' // src/ai/prompts.js briefPrompt: every career mode (research, outreach…)
  return null
}

function payloadFor(feature, body) {
  const text = (body.messages ?? []).map(m => m.content).join('\n')
  if (feature === 'suggest' || feature === 'rewrite') return suggestionsPayload(text)
  if (feature === 'tailor') return { ...suggestionsPayload(text), keywordsAdded: ['Kubernetes'], summary: 'Tailored to emphasise matching experience.' }
  if (feature === 'evaluate') {
    return {
      score: 4, recommendation: 'apply', summary: 'Strong match for the role.',
      requirements: [{ text: 'Distributed systems experience', weight: 1, evidence: 'See experience section.', verdict: 'met' }],
      gaps: [], levelFit: 'Matches the level.', legitimacy: { level: 'ok', notes: 'No red flags.' }, pitch: 'A strong candidate.',
    }
  }
  if (feature === 'coverLetter') {
    return { subject: 'Application for Senior Backend Engineer', paragraphs: ['I am excited to apply for this role.', 'My experience lines up well with what you need.', 'I would welcome the chance to talk further.'] }
  }
  if (feature === 'brief') return { title: BRIEF_TITLE, sections: [{ heading: 'What they do', body: 'They build developer platforms.', items: ['Remote-first team'] }], needsInput: [] }
  return { title: 'Senior Backend Engineer', company: 'Globex Systems', location: 'Remote', requirements: [], keywords: [] }
}

/** Canned OpenAI-compatible /chat/completions server: one malformed reply per feature exercises the retry
 * in src/ai/assist.js's ask(), then canned JSON built from the real CV lines the request carries. */
function startStub() {
  const served = new Set() // features whose first (malformed) reply has already gone out
  const server = http.createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*') // cross-port fetch from the app needs CORS, like real local servers
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-methods': 'POST, GET, OPTIONS', 'access-control-allow-headers': 'content-type, authorization' })
      return res.end()
    }
    if (req.method === 'GET' && req.url.startsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ data: [{ id: 'stub-model' }] }))
    }
    if (req.method !== 'POST' || !req.url.startsWith('/chat/completions')) {
      res.writeHead(404)
      return res.end()
    }
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      let body
      try { body = JSON.parse(raw) } catch { body = {} }
      const feature = featureOf(body)
      const first = feature && !served.has(feature)
      if (first) served.add(feature)
      const content = first ? 'Sorry, I cannot help with that right now.' /* no JSON: forces the one retry */
        : JSON.stringify(payloadFor(feature, body))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }))
  })
}

// ---------------- driving helpers ----------------

function withTimeout(promise, ms, what) {
  let timer
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: timed out after ${ms} ms`)), ms) })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** Polls a boolean page expression until it is true (or times out). */
async function waitUntil(page, expr, { timeout = ACTION_TIMEOUT, what = expr } = {}) {
  await withTimeout(page.evaluate(`new Promise(res => {
    const poll = () => { if (${expr}) return res(true); setTimeout(poll, 50) }
    poll()
  })`), timeout, what)
}

async function click(page, selector) {
  await page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error(${JSON.stringify(`missing ${selector}`)}); el.click() })()`, { awaitPromise: false })
}

// ---------------- flows ----------------

async function collectConsoleErrors(page) {
  await page.evaluate(`(() => {
    window.__assistErrors = []
    addEventListener('error', e => window.__assistErrors.push(String(e.message ?? e.error)))
    addEventListener('unhandledrejection', e => window.__assistErrors.push('unhandledrejection: ' + String(e.reason)))
    const orig = console.error.bind(console)
    console.error = (...a) => { window.__assistErrors.push(a.map(String).join(' ')); orig(...a) }
  })()`, { awaitPromise: false })
}

// Sets the 'custom' connection and pre-grants consent directly through src/ai/connections.js, so the app's
// own AI dialog and consent prompt never need a click; ctx.ai.getClient() reads the same module singleton.
async function connectStubProvider(page, stubUrl) {
  await page.evaluate(`(async () => {
    const { setConnection, grantConsent } = await import('/src/ai/connections.js')
    setConnection({ provider: 'custom', baseUrl: ${JSON.stringify(stubUrl)}, model: 'stub-model', remember: false })
    grantConsent('custom', { persist: false })
  })()`)
}

async function suggestFlow(page, problems) {
  await page.evaluate("window.recto.store.setUi({ panel: 'suggest' })", { awaitPromise: false })
  await waitUntil(page, `document.querySelector('[data-action="ai-analyse"]')`, { what: '"Analyse my CV" button' })
  const before = await page.evaluate('window.recto.store.state.content', { awaitPromise: false })
  await click(page, '[data-action="ai-analyse"]')
  await waitUntil(page, `document.querySelectorAll('.as-card').length >= 2`, { what: 'diff cards' })
  const statuses = await page.evaluate(`[...document.querySelectorAll('.as-card')].map(c => [...c.classList].find(k => k.startsWith('is-')))`, { awaitPromise: false })
  if (!statuses.includes('is-new-facts')) problems.push(`expected a "new facts" card among ${JSON.stringify(statuses)}`)
  await waitUntil(page, `document.querySelector('[data-action="ai-accept-all"]')`, { what: '"Accept all safe" button' })
  await click(page, '[data-action="ai-accept-all"]')
  await waitUntil(page, `window.recto.store.state.content !== ${JSON.stringify(before)}`, { what: 'content changed after accept all safe' })
  const after = await page.evaluate('window.recto.store.state.content', { awaitPromise: false })
  if (after.includes('Globex Corp')) problems.push('the "new facts" card was applied by Accept all safe')
}

async function jobFlow(page, problems) {
  await page.evaluate("window.recto.store.setUi({ panel: 'job' })", { awaitPromise: false })
  await waitUntil(page, `document.getElementById('job-input')`, { what: 'job input' })
  await page.evaluate(`(() => {
    const el = document.getElementById('job-input')
    el.value = ${JSON.stringify(JD)}
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })()`, { awaitPromise: false })
  await click(page, '.job-form__bar button')
  await waitUntil(page, `document.querySelector('.job-gauge__num')`, { what: 'match gauge' })
  const score = await page.evaluate(`Number(document.querySelector('.job-gauge__num').textContent)`, { awaitPromise: false })
  if (!(score >= 0 && score <= 100)) problems.push(`match score is not a 0-100 number: ${score}`)
}

async function evaluateFlow(page, problems) {
  await click(page, '.job-actions button:nth-child(1)') // Evaluate with AI
  await waitUntil(page, `document.querySelector('.job-eval')`, { what: 'evaluation report renders' })
  const hasEvaluation = await page.evaluate(`window.recto.ctx.tracker.list().some(j => (j.evaluations ?? []).length > 0)`, { awaitPromise: false })
  if (!hasEvaluation) problems.push('Evaluate with AI: no evaluation landed in the tracker')
}

async function tailorFlow(page, problems) {
  const before = await page.evaluate('window.recto.store.state.docs.map(d => d.id)', { awaitPromise: false })
  await click(page, '.job-actions button:nth-child(2)') // Tailor CV
  await waitUntil(page, `window.recto.store.state.docs.length > ${before.length}`, { what: 'tailored doc appears' })
  const docs = await page.evaluate('window.recto.store.state.docs', { awaitPromise: false })
  const created = docs.find(d => !before.includes(d.id))
  if (!created) problems.push('Tailor CV: no new doc found')
  else if (!created.name?.includes('—')) problems.push(`Tailor CV: new doc name "${created.name}" does not look like "<name> — <company>"`)
}

async function coverLetterFlow(page, problems) {
  // Tailor CV leaves the side panel on 'suggest' and switches the open doc; Job tab needs remounting.
  await page.evaluate("window.recto.store.setUi({ panel: 'job' })", { awaitPromise: false })
  await waitUntil(page, `document.querySelector('.job-actions')`, { what: 'job actions' })
  const before = await page.evaluate('window.recto.store.state.docs.map(d => d.id)', { awaitPromise: false })
  await click(page, '.job-actions button:nth-child(3)') // Draft cover letter
  await waitUntil(page, `window.recto.store.state.docs.length > ${before.length}`, { what: 'cover letter doc appears' })
  const docs = await page.evaluate('window.recto.store.state.docs', { awaitPromise: false })
  const created = docs.find(d => !before.includes(d.id))
  if (!created) { problems.push('Draft cover letter: no new doc found'); return }
  // open it under the design tab so the canvas renders and store.setRender() populates issues (spec 4.6/4.7)
  await page.evaluate(`(() => { window.recto.store.openDoc(${JSON.stringify(created.id)}); window.recto.store.setUi({ tab: 'design' }) })()`, { awaitPromise: false })
  const issues = await withTimeout(page.evaluate(`new Promise(res => {
    let last = null, since = 0
    const poll = () => {
      const r = window.recto.store.state.report
      if (r && r === last && Date.now() - since > 500) return res(window.recto.store.state.issues)
      if (r !== last) { last = r; since = Date.now() }
      setTimeout(poll, 50)
    }
    poll()
  })`), READY_TIMEOUT, 'cover letter render')
  // coverLetterDoc() (src/ai/assist.js, spec §6) deliberately writes the letter as one untitled "##" section,
  // which preflight's untitled-section rule always warns on; that single expected warning is not a defect.
  const unexpected = issues.filter(i => !(i.rule === 'untitled-section' && i.severity === 'warn'))
  if (unexpected.length) problems.push(`cover letter doc has ${unexpected.length} unexpected diagnostic(s): ${JSON.stringify(unexpected)}`)
}

// review-jobs spec §1.1: the ATS chip is always visible with a score and grade, no job and no AI needed.
async function atsChipFlow(page, problems) {
  await waitUntil(page, `document.querySelector('[data-action="ats-chip"]')`, { what: 'ATS chip' })
  const text = await page.evaluate(`document.querySelector('[data-action="ats-chip"]').textContent`, { awaitPromise: false })
  if (!/ATS \d+.*[A-F]/.test(text)) problems.push(`ATS chip does not show a score and grade: ${JSON.stringify(text)}`)
}

// review-jobs spec §2: the Review tab lists all 8 weighted ats/score.js checks.
async function reviewFlow(page, problems) {
  await page.evaluate("window.recto.ctx.openPanel ? window.recto.ctx.openPanel('review') : window.recto.store.setUi({ panel: 'review' })", { awaitPromise: false })
  await waitUntil(page, `document.querySelectorAll('.rv-checks .rv-check').length === 8`, { what: '8 ATS checks in the Review tab' })
}

// review-jobs spec §3: pasting a JD renders the local (no-AI) two-pass requirement table straight away.
async function jobEvalTableFlow(page, problems) {
  await page.evaluate("window.recto.ctx.openPanel ? window.recto.ctx.openPanel('job') : window.recto.store.setUi({ panel: 'job' })", { awaitPromise: false })
  await waitUntil(page, `document.getElementById('job-input')`, { what: 'job input' })
  await page.evaluate(`(() => {
    const el = document.getElementById('job-input')
    el.value = ${JSON.stringify(JD)}
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })()`, { awaitPromise: false })
  await click(page, '.job-form__bar button')
  await waitUntil(page, `document.querySelectorAll('.job-reqs tbody tr').length > 0`, { what: 'job evaluation table renders' })
}

// review-jobs spec §5: the board opens, and moving a card (arrow keys stand in for drag-and-drop in headless
// Chrome) from Applied to Rejected persists through the tracker.
async function boardFlow(page, problems) {
  const id = await page.evaluate(`window.recto.ctx.tracker.save({ title: 'Backend Engineer', company: 'Acme', status: 'applied' }).id`, { awaitPromise: false })
  await page.evaluate('window.recto.ctx.openJobsDialog()', { awaitPromise: false })
  await waitUntil(page, `document.querySelector('.board[open]')`, { what: 'board dialog opens' })
  const card = `document.querySelector('[data-job="${id}"]')`
  await waitUntil(page, card, { what: 'seeded card renders' })
  await page.evaluate(`${card}.focus()`, { awaitPromise: false })
  for (let i = 0; i < 3; i++) { // saved < applied < interview < offer < rejected: 3 steps right of applied
    await page.evaluate(`${card}.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))`, { awaitPromise: false })
  }
  const status = await page.evaluate(`window.recto.ctx.tracker.get(${JSON.stringify(id)})?.status`, { awaitPromise: false })
  if (status !== 'rejected') problems.push(`moving the card 3 steps right of "applied" landed on "${status}", expected "rejected"`)
  await click(page, '[data-action="board-close"]').catch(() => {})
}

// review-jobs spec §4: Cmd/Ctrl-K opens the command bar, filters to "Jobs board" and runs it.
async function commandBarFlow(page, problems) {
  await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, metaKey: true, bubbles: true, cancelable: true }))`, { awaitPromise: false })
  await waitUntil(page, `document.querySelector('.cmd-bar[open]')`, { what: 'command bar opens' })
  await page.evaluate(`(() => {
    const input = document.querySelector('.cmd-bar__input')
    input.value = 'Jobs board'
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`, { awaitPromise: false })
  await waitUntil(page, `document.querySelector('.cmd-bar__item')?.textContent.includes('Jobs board')`, { what: '"Jobs board" is the top match' })
  await page.evaluate(`document.querySelector('.cmd-bar__input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`, { awaitPromise: false })
  await waitUntil(page, `document.querySelector('.board[open]')`, { what: 'board opens from the command bar' })
  await click(page, '[data-action="board-close"]').catch(() => {})
}

// discover-apply spec §1.1–1.2, §5: Discover (stubbed sources) → Save → Prepare application → Mark applied
// moves the card to Applied on the board. The five public sources are answered by a window.fetch override,
// so no third-party host is ever contacted.
async function discoverFlow(page, problems) {
  await page.evaluate(`(() => {
    const day = 864e5
    const recent = new Date(Date.now() - 2 * day).toISOString()
    const json = body => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }))
    const gh = { id: 101, title: 'Backend Engineer', absolute_url: 'https://boards.greenhouse.io/acme/jobs/101', location: { name: 'Remote' },
      updated_at: recent, first_published: recent, company_name: 'Acme',
      content: '&lt;p&gt;We need a Backend Engineer with JavaScript, Node.js and PostgreSQL experience. Remote.&lt;/p&gt;' }
    const questions = [
      { label: 'First Name', required: true, fields: [{ name: 'first_name', type: 'input_text', values: [] }] },
      { label: 'Will you now or in the future require visa sponsorship?', required: true,
        fields: [{ name: 'question_2', type: 'multi_value_single_select', values: [{ label: 'Yes', value: 1 }, { label: 'No', value: 0 }] }] },
      { label: 'Why do you want to work at Acme?', required: false, fields: [{ name: 'question_3', type: 'textarea', values: [] }] },
    ]
    const remotive = { id: 555, url: 'https://remotive.com/remote-jobs/software-dev/frontend-engineer-555', title: 'Frontend Engineer',
      company_name: 'Remo Co', category: 'Software Development', job_type: 'full_time', publication_date: recent,
      candidate_required_location: 'Worldwide', salary: '', description: '<p>Frontend Engineer, JavaScript and CSS. Fully remote.</p>' }
    const real = window.fetch.bind(window)
    window.__discoverHosts = []
    window.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href)
      if (url.origin === location.origin) return real(input, init)
      window.__discoverHosts.push(url.host)
      if (url.host === 'boards-api.greenhouse.io') return json(/\\/jobs\\/101/.test(url.pathname) ? { ...gh, questions } : { jobs: [gh], meta: { total: 1 } })
      if (url.host === 'remotive.com') return json({ 'job-count': 1, jobs: [remotive] })
      if (url.host === 'api.lever.co') return json([])
      if (url.host === 'api.ashbyhq.com') return json({ jobs: [] })
      if (url.host === 'www.arbeitnow.com') return json({ data: [], links: {}, meta: {} })
      if (url.host === 'jobicy.com') return json({ jobCount: 0, jobs: [] })
      return Promise.reject(new TypeError('assist-check: unexpected host ' + url.host))
    }
    localStorage.setItem('recto:companies', JSON.stringify([{ source: 'greenhouse', board: 'acme', name: 'Acme' }]))
    localStorage.setItem('recto:discover', JSON.stringify({ roles: [], locations: [], remote: 'any', maxAgeDays: 30, minScore: 0,
      feeds: { remotive: { enabled: true, query: 'engineer' }, arbeitnow: { enabled: false } } }))
  })()`, { awaitPromise: false })
  await waitUntil(page, `document.querySelector('[data-action="discover"]')`, { what: 'Discover button' })
  await click(page, '[data-action="discover"]')
  await waitUntil(page, `document.querySelector('.discover[open] [data-action="discover-scan"]')`, { what: 'Discover view opens' })
  await click(page, '[data-action="discover-scan"]')
  await waitUntil(page, `document.querySelector('.dc-card[data-source="greenhouse"]') && document.querySelector('.dc-card[data-source="remotive"]')`, { what: 'scan results (greenhouse + remotive cards)' })
  const via = await page.evaluate(`document.querySelector('.dc-card[data-source="remotive"] .dc-attrib a')?.getAttribute('href') ?? ''`, { awaitPromise: false })
  if (!/^https:\/\/remotive\.com\//.test(via)) problems.push(`Remotive card lacks its "via Remotive" link back (got ${JSON.stringify(via)})`)
  const id = await page.evaluate(`document.querySelector('.dc-card[data-source="greenhouse"]').dataset.posting`, { awaitPromise: false })
  const card = `.dc-card[data-posting="${id}"]`
  await click(page, `${card} [data-action="discover-save"]`)
  await waitUntil(page, `window.recto.ctx.tracker.get(${JSON.stringify(id)})?.status === 'saved'`, { what: 'Save puts the posting in the tracker' })
  await click(page, `.dc-card[data-posting="${id}"] [data-action="discover-prepare"]`)
  await waitUntil(page, `document.querySelector('.pack[open] .pack-cli')`, { what: 'application pack view opens' })
  const cli = await page.evaluate(`document.querySelector('.pack[open] .pack-cli').textContent`, { awaitPromise: false })
  if (!cli.startsWith('recto autoapply --jobs ') || !cli.includes(id.replace(/:/g, '-')) || !cli.includes('.cv.json')) problems.push(`pack CLI hint is not this job's autoapply command: ${JSON.stringify(cli)}`)
  await waitUntil(page, `document.querySelectorAll('.pack[open] .pack-q').length > 0`, { what: 'pack questions render' })
  await click(page, '.pack[open] [data-action="pack-applied"]')
  await waitUntil(page, `window.recto.ctx.tracker.get(${JSON.stringify(id)})?.status === 'applied'`, { what: 'Mark applied updates the tracker' })
  // The pack, apply URL and questions live on the tracker job; reopening the pack reuses its tailored CV (no new copy)
  const stored = () => page.evaluate(`(() => { const j = window.recto.ctx.tracker.get(${JSON.stringify(id)})
    return { cvDocId: j.pack?.cvDocId ?? null, applyUrl: j.applyUrl ?? null, board: j.board ?? null, docs: window.recto.store.state.docs.length } })()`, { awaitPromise: false })
  const first = await stored()
  if (!first.cvDocId || !first.applyUrl || first.board !== 'acme') problems.push(`tracker job lacks pack/applyUrl/board: ${JSON.stringify(first)}`)
  await page.evaluate(`document.querySelectorAll('dialog[open]').forEach(d => d.close())`, { awaitPromise: false })
  await page.evaluate(`window.recto.ctx.openPack(${JSON.stringify(id)})`, { awaitPromise: false })
  await waitUntil(page, `document.querySelectorAll('.pack[open] .pack-q').length > 0`, { what: 'stored pack reopens' })
  const again = await stored()
  if (again.docs !== first.docs || again.cvDocId !== first.cvDocId) problems.push(`reopening the pack made another CV copy: ${JSON.stringify({ first, again })}`)
  await page.evaluate(`document.querySelectorAll('dialog[open]').forEach(d => d.close())`, { awaitPromise: false })
  await page.evaluate('window.recto.ctx.openJobsDialog()', { awaitPromise: false })
  await waitUntil(page, `document.querySelector('.board[open] .board-col[data-status="applied"] [data-job="${id}"]')`, { what: 'board card in Applied' })
  await click(page, '[data-action="board-close"]').catch(() => {})
  const hosts = await page.evaluate('window.__discoverHosts', { awaitPromise: false })
  if (hosts.some(h => !['boards-api.greenhouse.io', 'remotive.com'].includes(h))) problems.push(`Discover contacted a disabled source: ${JSON.stringify(hosts)}`)
}

// ---------------- career suite flows ----------------

// Custom Greenhouse questions no profile rule answers; each pair is worded differently but similar (answers.js ≥ 0.6)
const BANK_Q = ['Which conference talk inspired you most recently?', 'Which conference talk has inspired you most recently?']
const QUEUE_Q = ['Which on-call rotation tooling have you used day to day?', 'Which on-call rotation tooling have you used day-to-day?']
const ghQuestion = (label, name) => ({ label, required: true, fields: [{ name, type: 'input_text', values: [] }] })
const ghQuestions = custom => [ghQuestion('First Name', 'first_name'), ghQuestion(custom, 'question_9')]
const GH_DETAILS = {
  'globex/201': ghQuestions(BANK_Q[0]), 'globex/202': ghQuestions(BANK_Q[1]),
  'initech/301': ghQuestions(QUEUE_Q[0]), 'initech/302': ghQuestions(QUEUE_Q[1]),
}
const ghJob = (board, company, n, title) => ({
  id: `greenhouse:${board}:${n}`, source: 'greenhouse', board, title, company, location: 'Sydney, NSW', status: 'saved',
  url: `https://boards.greenhouse.io/${board}/jobs/${n}`, applyUrl: `https://job-boards.greenhouse.io/${board}/jobs/${n}`,
})
const PROFILE_JOBS = [ghJob('globex', 'Globex', 201, 'Backend Engineer'), ghJob('globex', 'Globex', 202, 'Senior Backend Engineer')]
const QUEUE_JOBS = [ghJob('initech', 'Initech', 301, 'Platform Engineer'), ghJob('initech', 'Initech', 302, 'Site Reliability Engineer')]
const REJECTION = 'Thank you for your interest in the Platform Engineer role. Unfortunately, we have decided not to move forward with your application at this time. We wish you the best in your search.'
// Pipeline items split on blank lines, so each JD is one block
const PIPELINE_JDS = `Staff Data Engineer at Initrode
Location: Melbourne, VIC
Requirements:
- 6+ years building data pipelines
- Strong experience with Python and PostgreSQL

Frontend Engineer at Hooli
Location: Remote
Requirements:
- 4+ years with JavaScript and CSS
- Experience with accessibility`

const closeDialogs = page => page.evaluate(`document.querySelectorAll('dialog[open]').forEach(d => d.close())`, { awaitPromise: false })
const tracked = (page, id) => page.evaluate(`window.recto.ctx.tracker.get(${JSON.stringify(id)})`, { awaitPromise: false })
const savedProfile = page => page.evaluate(`JSON.parse(localStorage.getItem('recto:profile') ?? '{}')`, { awaitPromise: false })

async function setField(page, selector, value, event = 'input') {
  await page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) throw new Error(${JSON.stringify(`missing ${selector}`)})
    el.value = ${JSON.stringify(value)}
    el.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true }))
  })()`, { awaitPromise: false })
}

async function seedJobs(page, jobs) {
  await page.evaluate(`${JSON.stringify(jobs)}.forEach(j => window.recto.ctx.tracker.save(j))`, { awaitPromise: false })
}

// Layered over discoverFlow's fetch stub (anything not handled here falls through to it): Greenhouse job details with
// the questions above, and serve.js's /api/apply bridge, answered 404 until a flow sets window.__bridge. Downloads are
// recorded in window.__downloads instead of being written to disk.
async function careerStubs(page) {
  await page.evaluate(`(() => {
    const details = ${JSON.stringify(GH_DETAILS)}
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    window.__bridge = null
    window.__applyCalls = []
    window.__downloads = []
    const apply = (url, init = {}) => {
      const method = init.method ?? 'GET'
      window.__applyCalls.push({ method, path: url.pathname, token: init.headers?.['x-recto-token'] ?? null, body: init.body ? JSON.parse(init.body) : null })
      const b = window.__bridge
      if (!b) return json({ error: 'not-found' }, 404)
      if (url.pathname === '/api/apply') return method === 'GET' ? json({ bridge: true, token: b.token }) : json({ started: true }, 202)
      if (url.pathname === '/api/apply/status') {
        return ++b.polls < 2 ? json({ running: true, jobs: b.jobs.map(j => ({ id: j.id, state: 'filling' })) })
          : json({ running: false, stopped: false, exitCode: 0, summary: { submitted: 1, blocked: 1 }, jobs: b.jobs })
      }
      return json({ error: 'not-found' }, 404)
    }
    const prev = window.fetch
    window.fetch = (input, init) => {
      const url = new URL(String(input?.url ?? input), location.href)
      const m = url.host === 'boards-api.greenhouse.io' && url.pathname.match(/boards\\/([^/]+)\\/jobs\\/(\\d+)$/)
      if (m && details[m[1] + '/' + m[2]]) return Promise.resolve(json({ id: Number(m[2]), title: 'Engineer', questions: details[m[1] + '/' + m[2]] }))
      if (url.origin === location.origin && url.pathname.startsWith('/api/apply')) return Promise.resolve(apply(url, init))
      return prev(input, init)
    }
    const anchorClick = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function () { return this.download ? void window.__downloads.push(this.download) : anchorClick.call(this) }
    // the pack answer whose label is exactly this question
    window.__packQ = text => [...document.querySelectorAll('.pack[open] .pack-q')].find(q => q.querySelector('.pack-q__label')?.firstChild?.textContent === text)
  })()`, { awaitPromise: false })
}

// career-suite spec §1 criteria 2–3: fill the profile (country preset, work rights, notice, salary), answer a custom
// question with Remember on, then a second job's similar question is answered from the bank with source `bank`.
async function profileBankFlow(page, problems) {
  await click(page, '[data-action="profile"]')
  await waitUntil(page, `document.querySelector('.cp[open] [data-action="profile-save"]')`, { what: 'Candidate profile opens' })
  await setField(page, '.cp[open] select[name="country"]', 'Australia', 'change')
  await waitUntil(page, `document.querySelector('.cp[open] select[name="workRights"] option[value="nz-citizen"]')`, { what: 'Australian work-rights options' })
  await setField(page, '.cp[open] select[name="workRights"]', 'citizen', 'change')
  await setField(page, '.cp[open] input[name="noticePeriod"]', '4 weeks')
  await setField(page, '.cp[open] input[name="salaryExpectation"]', '150000')
  await click(page, '.cp[open] [data-action="profile-save"]')
  await waitUntil(page, `!document.querySelector('.cp[open]')`, { what: 'profile saves and closes' })
  const p = await savedProfile(page)
  const want = { country: 'Australia', workRights: 'citizen', noticePeriod: '4 weeks', salaryExpectation: '150000' }
  for (const [k, v] of Object.entries(want)) if (p[k] !== v) problems.push(`profile ${k} is ${JSON.stringify(p[k])}, expected ${JSON.stringify(v)}`)

  const [first, second] = PROFILE_JOBS
  const answer = 'Designing Data-Intensive Applications, at YOW! 2025'
  await seedJobs(page, PROFILE_JOBS)
  await page.evaluate(`window.recto.ctx.openPack(${JSON.stringify(first.id)})`, { awaitPromise: false })
  const q1 = `window.__packQ(${JSON.stringify(BANK_Q[0])})`
  await waitUntil(page, q1, { what: 'first pack shows the custom question' })
  const before = await page.evaluate(`({ source: ${q1}.dataset.source, remember: ${q1}.querySelector('.pack-q__remember input').checked })`, { awaitPromise: false })
  if (before.source !== 'unanswered' || !before.remember) problems.push(`custom question should start unanswered with Remember on: ${JSON.stringify(before)}`)
  await page.evaluate(`(() => {
    const q = ${q1}
    q.querySelector('input:not([type=checkbox]), textarea').value = ${JSON.stringify(answer)}
    q.querySelector('[data-action="pack-answer-remember"]').click()
  })()`, { awaitPromise: false })
  await waitUntil(page, `(JSON.parse(localStorage.getItem('recto:profile') ?? '{}').answers ?? []).some(a => a.question === ${JSON.stringify(BANK_Q[0])} && a.answer === ${JSON.stringify(answer)})`, { what: 'answer saved to the bank' })
  await closeDialogs(page)

  await page.evaluate(`window.recto.ctx.openPack(${JSON.stringify(second.id)})`, { awaitPromise: false })
  const q2 = `window.__packQ(${JSON.stringify(BANK_Q[1])})`
  await waitUntil(page, `${q2}?.dataset.source === 'bank'`, { what: 'second pack answers the similar question from the bank' })
  const shown = await page.evaluate(`({ badge: !!${q2}.querySelector('.pack-badge.is-bank'), value: ${q2}.querySelector('input:not([type=checkbox]), textarea').value })`, { awaitPromise: false })
  if (!shown.badge || shown.value !== answer) problems.push(`bank answer not shown with its badge: ${JSON.stringify(shown)}`)
  const stored = (await tracked(page, second.id))?.pack?.answers?.find(a => a.question === BANK_Q[1])
  if (stored?.source !== 'bank' || stored.answer !== answer) problems.push(`second pack stored ${JSON.stringify(stored)}, expected the bank answer`)
  await closeDialogs(page)
}

// career-suite spec §4: select 2 saved jobs on the board → Apply to selected → one grouped missing question → answer →
// Run without a bridge gives the bundle and command; a second run through a stubbed bridge updates the tracker per job.
async function applyQueueFlow(page, problems) {
  const [a, b] = QUEUE_JOBS
  await seedJobs(page, QUEUE_JOBS)
  await page.evaluate('window.recto.ctx.openJobsDialog()', { awaitPromise: false })
  for (const j of QUEUE_JOBS) {
    const box = `.board[open] .board-card[data-job="${j.id}"] [data-action="board-select"]`
    await waitUntil(page, `document.querySelector(${JSON.stringify(box)})`, { what: `board card ${j.id}` })
    await click(page, box)
  }
  await waitUntil(page, `document.querySelector('[data-action="board-apply-selected"]')?.textContent.includes('2')`, { what: 'Apply to selected (2)' })
  await click(page, '[data-action="board-apply-selected"]')
  await waitUntil(page, `document.querySelector('.aq[open] .aq-q')`, { timeout: READY_TIMEOUT, what: 'queue prepares packs and asks the missing question' })
  const asked = await page.evaluate(`[...document.querySelectorAll('.aq[open] .aq-q')].map(q => ({ label: q.querySelector('.aq-q__label').textContent, asked: q.querySelector('.aq-q__asked').textContent }))`, { awaitPromise: false })
  if (asked.length !== 1 || !QUEUE_Q.includes(asked[0].label) || !asked[0].asked.includes('2')) problems.push(`expected the similar question once, asked by 2 jobs: ${JSON.stringify(asked)}`)
  const answer = 'PagerDuty and Opsgenie'
  await setField(page, '#aq-q-0', answer)
  await click(page, '.aq[open] [data-action="applyq-save-answers"]')
  await waitUntil(page, `document.querySelector('.aq[open] [data-action="applyq-start"]')`, { what: 'Run step' })
  for (const j of QUEUE_JOBS) {
    const got = (await tracked(page, j.id))?.pack?.answers?.find(x => QUEUE_Q.includes(x.question))
    if (got?.answer !== answer || got.source !== 'bank') problems.push(`queue answer did not refill ${j.id}: ${JSON.stringify(got)}`)
  }
  await click(page, '.aq[open] [data-action="applyq-start"]')
  await waitUntil(page, `document.querySelector('.aq[open] .aq-cli')`, { what: 'no-bridge download step' })
  const hosted = await page.evaluate(`({ cli: document.querySelector('.aq[open] .aq-cli').textContent, downloads: window.__downloads })`, { awaitPromise: false })
  if (hosted.cli !== 'node cli/recto.js autoapply --bundle recto-apply.json') problems.push(`hosted command is ${JSON.stringify(hosted.cli)}`)
  if (!hosted.downloads.includes('recto-apply.json')) problems.push(`recto-apply.json was not downloaded: ${JSON.stringify(hosted.downloads)}`)
  await closeDialogs(page)

  // second pass: a stubbed local bridge reports one job submitted and one blocked
  const token = 'assist-check-token'
  await page.evaluate(`(() => {
    window.__bridge = { token: ${JSON.stringify(token)}, polls: 0, jobs: [{ id: ${JSON.stringify(a.id)}, state: 'submitted' }, { id: ${JSON.stringify(b.id)}, state: 'blocked', reason: 'captcha' }] }
    window.__applyCalls = []
    window.recto.ctx.openApplyQueue({ jobIds: ${JSON.stringify([a.id, b.id])} })
  })()`, { awaitPromise: false })
  await waitUntil(page, `document.querySelector('.aq[open] [data-action="applyq-start"]')`, { what: 'queue skips straight to Run (answers already in the bank)' })
  await click(page, '.aq[open] [data-action="applyq-start"]')
  await waitUntil(page, `document.querySelector('.aq[open] .aq-row.is-submitted') && document.querySelector('.aq[open] .aq-row.is-blocked')`, { what: 'bridge run finishes' })
  const post = await page.evaluate(`window.__applyCalls.find(c => c.method === 'POST' && c.path === '/api/apply')`, { awaitPromise: false })
  if (post?.token !== token || JSON.stringify(post.body?.jobs?.map(j => j.id).sort()) !== JSON.stringify([a.id, b.id].sort())) problems.push(`bridge start did not carry the token and both jobs: ${JSON.stringify(post && { token: post.token, jobs: post.body?.jobs?.map(j => j.id) })}`)
  const [ja, jb] = [await tracked(page, a.id), await tracked(page, b.id)]
  if (ja?.status !== 'applied') problems.push(`submitted job is "${ja?.status}", expected "applied"`)
  if (jb?.status !== 'saved' || jb.applyLog?.at(-1)?.reason !== 'captcha') problems.push(`blocked job should stay saved with its reason: ${JSON.stringify({ status: jb?.status, applyLog: jb?.applyLog })}`)
  await closeDialogs(page)
}

// career-suite spec §7: the board drawer's workspace tabs render, Research generates a brief (stub AI), and a pasted
// rejection email is classified and moves the job to Rejected.
async function workspaceFlow(page, problems) {
  const job = { title: 'Platform Engineer', company: 'Initrode', location: 'Remote', status: 'applied', text: JD }
  const id = await page.evaluate(`window.recto.ctx.tracker.save(${JSON.stringify(job)}).id`, { awaitPromise: false })
  await page.evaluate('window.recto.ctx.openJobsDialog()', { awaitPromise: false })
  const card = `.board[open] .board-card[data-job="${id}"]`
  await waitUntil(page, `document.querySelector(${JSON.stringify(card)})`, { what: 'workspace job card' })
  await click(page, card)
  await waitUntil(page, `document.querySelectorAll('.board[open] .board-drawer .ws-tab').length === 7`, { what: 'workspace tabs' })
  for (const tab of ['overview', 'pack', 'research', 'outreach', 'interview', 'offer', 'followups']) {
    await click(page, `.board-drawer .ws-tab[data-tab="${tab}"]`)
    await waitUntil(page, `document.querySelector('.board-drawer .ws-tab[data-tab="${tab}"][aria-selected="true"]') && document.querySelector('.board-drawer .ws-panel')?.childElementCount > 0`, { what: `${tab} tab renders` })
  }
  await click(page, '.board-drawer .ws-tab[data-tab="research"]')
  await waitUntil(page, `document.querySelector('.ws-panel [data-mode="research"] [data-action="ws-generate"]')`, { what: 'Research Generate button' })
  await click(page, '.ws-panel [data-mode="research"] [data-action="ws-generate"]')
  await waitUntil(page, `document.querySelector('.ws-panel [data-mode="research"] .ws-brief h4')?.textContent === ${JSON.stringify(BRIEF_TITLE)}`, { what: 'research brief renders' })
  if ((await tracked(page, id))?.artifacts?.research?.title !== BRIEF_TITLE) problems.push('research brief was not stored on the job')

  await click(page, '.board-drawer .ws-tab[data-tab="followups"]')
  await waitUntil(page, `document.querySelector('.ws-panel textarea[data-draft="reply"]')`, { what: 'Follow-ups reply box' })
  await setField(page, '.ws-panel textarea[data-draft="reply"]', REJECTION)
  await click(page, '.ws-panel [data-action="ws-reply"]')
  await waitUntil(page, `document.querySelector('.ws-panel [data-action="ws-reply-move"]')`, { what: 'reply classified with a Move button' })
  await click(page, '.ws-panel [data-action="ws-reply-move"]')
  await waitUntil(page, `window.recto.ctx.tracker.get(${JSON.stringify(id)})?.status === 'rejected'`, { what: 'job moves to Rejected' })
  await waitUntil(page, `document.querySelector('.board-drawer [data-field="outcome-stage"]')`, { what: 'Overview shows the outcome fields' })
  await closeDialogs(page)
}

// career-suite spec §6–7: two pasted JDs → Process all → two saved pipeline jobs; Insights' funnel counts them.
async function pipelineInsightsFlow(page, problems) {
  const before = await page.evaluate('window.recto.ctx.tracker.list().length', { awaitPromise: false })
  await page.evaluate('window.recto.ctx.openPipeline()', { awaitPromise: false })
  await waitUntil(page, `document.querySelector('.pipeline[open] [data-field="pipeline-input"]')`, { what: 'Pipeline inbox opens' })
  await setField(page, '.pipeline[open] [data-field="pipeline-input"]', PIPELINE_JDS)
  await click(page, '.pipeline[open] [data-action="pipeline-process"]')
  await waitUntil(page, `document.querySelectorAll('.pipeline[open] .pl-row.is-done').length === 2`, { timeout: READY_TIMEOUT, what: 'both pipeline items processed' })
  const jobs = await page.evaluate(`window.recto.ctx.tracker.list().filter(j => j.source === 'pipeline').map(j => ({ title: j.title, status: j.status, pack: !!j.pack, evaluations: j.evaluations.length }))`, { awaitPromise: false })
  const ok = jobs.length === 2 && jobs.every(j => j.status === 'saved' && j.pack && j.evaluations > 0)
  if (!ok) problems.push(`expected 2 saved pipeline jobs with a pack and an evaluation: ${JSON.stringify(jobs)}`)
  await click(page, '.pipeline[open] [data-action="pipeline-close"]')
  const total = await page.evaluate('window.recto.ctx.tracker.list().length', { awaitPromise: false })
  if (total !== before + 2) problems.push(`tracker grew by ${total - before} jobs, expected 2`)
  await page.evaluate('window.recto.ctx.openInsights()', { awaitPromise: false })
  await waitUntil(page, `document.querySelector('.insights[open] [data-card="funnel"] .ins-funnel__num')`, { what: 'Insights funnel' })
  const saved = await page.evaluate(`parseInt(document.querySelector('.insights[open] [data-card="funnel"] .ins-funnel__num').textContent, 10)`, { awaitPromise: false })
  if (saved !== total) problems.push(`funnel's first stage shows ${saved}, expected all ${total} tracked jobs`)
  await closeDialogs(page)
}

// ---------------- main ----------------

async function main() {
  const problems = []
  const appServer = createServer()
  const { url: appBase } = await listen(appServer, { port: 0 })
  const { server: stubServer, url: stubUrl } = await startStub()
  const browser = await launch()
  try {
    const page = await browser.newPage(`${appBase}/`)
    try {
      await collectConsoleErrors(page)
      await waitUntil(page, 'window.recto?.store?.state?.content', { timeout: READY_TIMEOUT, what: 'app ready' })
      await connectStubProvider(page, stubUrl)
      // each flow needs the previous one's doc/panel state; a broken flow fails fast but the rest still run
      for (const [name, flow] of [
        ['suggest', suggestFlow], ['job', jobFlow], ['evaluate', evaluateFlow], ['tailor', tailorFlow], ['cover letter', coverLetterFlow],
        ['ATS chip', atsChipFlow], ['review checks', reviewFlow], ['job evaluation table', jobEvalTableFlow], ['jobs board', boardFlow], ['command bar', commandBarFlow],
        ['discover', discoverFlow], ['career stubs', careerStubs], ['profile → answer bank', profileBankFlow],
        ['apply queue', applyQueueFlow], ['job workspace', workspaceFlow], ['pipeline → insights', pipelineInsightsFlow],
      ]) {
        try {
          await flow(page, problems)
        } catch (err) {
          problems.push(`${name} flow: ${err.message}`)
        }
      }
      const errors = await page.evaluate('window.__assistErrors', { awaitPromise: false }).catch(() => [])
      for (const e of errors) problems.push(`console error: ${e}`)
    } finally {
      await page.close().catch(() => {})
    }
  } finally {
    await browser.close()
    await new Promise(r => stubServer.close(r))
    await new Promise(r => appServer.close(r))
  }
  if (problems.length) {
    console.error(`assist-check: ${problems.length} problem(s)`)
    for (const p of problems) console.error(`  - ${p}`)
    process.exitCode = 1
  } else {
    console.log('assist-check: all flows passed (suggest, job match, evaluate, tailor, cover letter, ATS chip, review checks, job evaluation table, jobs board, command bar, discover → pack → applied, profile → answer bank, apply queue (download + bridge), job workspace, pipeline → insights), no console errors')
  }
}

main().catch(err => {
  console.error('assist-check: crashed', err)
  process.exitCode = 1
})
