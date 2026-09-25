// End-to-end assist check (assist spec §1 success criteria, §8, §9): drives the real app in headless Chrome
// against a stub OpenAI-compatible server (the 'custom' provider) and asserts the whole AI + jobs flow.
// No real provider is ever contacted. Usage: node scripts/assist-check.js  (exit 1 on any failure)
//
// Driven through window.recto (store, ctx) wherever possible (panel switching, the tracker, the doc list) and
// through src/ui/assist-panel.js's and src/ui/job-panel.js's own class names otherwise, since neither module
// exposes data-testid hooks. Selectors relied on (all scoped to avoid the locale-dependent button text):
//   .as-bar .ui-btn--primary        Suggest tab: "Improve with AI" button
//   .as-card, .is-ok / .is-new-facts / .is-stale / .is-invalid   diff cards, status is a class
//   .as-bar > button:not(.ui-btn--primary)   Suggest tab: "Accept all safe" button (only rendered once shown)
//   #job-input                      Job tab: paste-a-link-or-description textarea (job-panel.js sets this id)
//   .job-form__bar button           Job tab: "Analyze" button
//   .job-gauge__num                 Job tab: match gauge's number (SVG <text>)
//   .job-actions button (1..4)      Job tab: Evaluate with AI, Tailor CV, Draft cover letter, Save to tracker
//   [data-action="ats-chip"]        Top bar: always-on ATS score chip (review-jobs spec §4)
//   .rv-checks .rv-check            Review tab: one <li> per weighted ATS check (src/ats/score.js, 8 checks)
//   .job-reqs tbody tr              Job tab: local (no-AI) two-pass requirement table, renders after Analyze
//   .board[open], [data-job=ID]     Jobs board dialog and its cards (draggable, also movable with arrow keys)
//   .cmd-bar[open], .cmd-bar__input, .cmd-bar__item   Command bar (Cmd/Ctrl-K), its filter box and result rows

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
  await waitUntil(page, `document.querySelector('.as-bar .ui-btn--primary')`, { what: '"Improve with AI" button' })
  const before = await page.evaluate('window.recto.store.state.content', { awaitPromise: false })
  await click(page, '.as-bar .ui-btn--primary')
  await waitUntil(page, `document.querySelectorAll('.as-card').length >= 2`, { what: 'diff cards' })
  const statuses = await page.evaluate(`[...document.querySelectorAll('.as-card')].map(c => [...c.classList].find(k => k.startsWith('is-')))`, { awaitPromise: false })
  if (!statuses.includes('is-new-facts')) problems.push(`expected a "new facts" card among ${JSON.stringify(statuses)}`)
  await waitUntil(page, `document.querySelector('.as-bar > button:not(.ui-btn--primary)')`, { what: '"Accept all safe" button' })
  await click(page, '.as-bar > button:not(.ui-btn--primary)')
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
    console.log('assist-check: all flows passed (suggest, job match, evaluate, tailor, cover letter, ATS chip, review checks, job evaluation table, jobs board, command bar), no console errors')
  }
}

main().catch(err => {
  console.error('assist-check: crashed', err)
  process.exitCode = 1
})
