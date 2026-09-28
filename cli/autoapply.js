// `recto autoapply` (discover-apply spec 4): fills Greenhouse, Lever and Ashby application forms in a visible Chrome,
// attaches the CV PDF and stops before Submit unless --submit and every guard passes. Other forms (SmartRecruiters,
// Workable, unknown) get a label-based fill and always stop for the user. `--bundle` + `--progress-json` drive it from
// the app's apply queue through serve.js (career-suite spec §4).
// Never solves or bypasses CAPTCHAs, never logs in, never creates accounts: those always hand back to the user.
import { access, appendFile, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { parse } from '../src/model/markdown.js'
import { migrateFile } from '../src/model/layout.js'
import { evaluateJob } from '../src/jobs/evaluate.js'
import * as profiles from '../src/profile.js'
import { DECLINE_RE, ruleAnswer, ruleOf } from '../src/jobs/pack.js'
import { findAnswer as bankAnswer } from '../src/jobs/answers.js'
import { launch as launchChrome } from './chrome.js'

const CONFIRM_TIMEOUT = 20000
const CONFIRM_RE = /thank you|thanks for applying|application (has been |was )?(received|submitted)|we('ve| have) received your application/i
const ATS = { greenhouse: /(^|\.)greenhouse\.io$/, lever: /(^|\.)lever\.co$/, ashby: /(^|\.)ashbyhq\.com$/ }
// Hosts named for the log only: their forms get the generic filler, which never submits
const FILL_ONLY = { smartrecruiters: /(^|\.)smartrecruiters\.com$/, workable: /(^|\.)workable\.com$/ }
const MAX_BUNDLE_JOBS = 200

const str = v => typeof v === 'string' ? v.trim() : ''
const norm = s => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const safe = s => String(s).replace(/[^\w.-]+/g, '_')
const firstLine = err => String(err?.message ?? err).split('\n')[0]

/** Applicant fields: the profile's, with name, email, phone and links prefilled from the CV header; EEO defaults to decline. */
export function applicant(profile, doc) {
  const raw = profile && typeof profile === 'object' ? profile : {}
  // raw first: keeps applicant fields even if normalizeProfile predates them; prefillProfile is guarded the same way
  const p = { ...raw, ...profiles.normalizeProfile(raw) }
  const eeo = p.eeo && typeof p.eeo === 'object' ? p.eeo : {}
  return { ...(profiles.prefillProfile?.(p, doc) ?? p), eeo: Object.fromEntries(profiles.EEO_FIELDS.map(k => [k, str(eeo[k]) || 'decline'])) }
}

// Standard questions the dry-run plan lists when the pack doesn't cover them; answered by pack.js's rules (same as the app)
const PLAN_LABELS = ['First name', 'Last name', 'Email', 'Phone', 'LinkedIn', 'GitHub', 'Website', 'Pronouns', 'Sponsorship',
  'Work authorization', 'Relocation', 'Location', 'Salary expectation', 'Notice period', 'How did you hear', 'Gender',
  'Race/ethnicity', 'Veteran status', 'Disability', 'Visa type', 'Earliest start date', 'Security clearance', 'Police check',
  "Driver's licence", 'Highest education', 'Years of experience']

/** The option to choose for `value`: 'decline' → a decline/prefer-not option, Yes/No → the option starting with it. */
export function pickOption(options, value) {
  const v = norm(value)
  if (!v) return null
  if (v === 'decline') return options.find(o => DECLINE_RE.test(o)) ?? null
  if (v === 'yes' || v === 'no') return options.find(o => norm(o) === v || norm(o).startsWith(v + ' ')) ?? null
  return options.find(o => norm(o) === v) ?? options.find(o => norm(o).length > 2 && (norm(o).includes(v) || v.includes(norm(o)))) ?? null
}

/** `{ value, source }` for a form field ({ label, options }): pack answer, then pack field, then rule, then the answer
 * bank (`applicant.answers`); null = leave it. `location` is the job's, for country-specific questions. */
export function resolveField(field, { applicant: a, pack, location = '', findAnswer = bankAnswer } = {}) {
  const label = norm(field.label)
  if (!label) return null
  const same = q => {
    const n = norm(q)
    return n === label || (Math.min(n.length, label.length) >= 12 && (n.includes(label) || label.includes(n)))
  }
  const answer = pack?.answers?.find(x => same(x?.question) && str(x.answer))
  const known = pack?.fields?.find(x => same(x?.label) && str(x.value))
  if (!answer && !known) {
    const r = ruleAnswer({ label: field.label, type: field.kind, options: field.options ?? [] }, { p: a, where: `${field.label} ${location}` })
    if (r) return { value: r.answer, source: r.source }
    const b = findAnswer(Array.isArray(a?.answers) ? a.answers : [], field.label, { options: field.options ?? [] })
    return b && str(b.answer) ? { value: str(b.answer), source: 'bank' } : null
  }
  const hit = answer ? { value: str(answer.answer), source: answer.source ?? 'pack' } : { value: str(known.value), source: 'pack' }
  if (!field.options?.length) return hit
  const option = pickOption(field.options, hit.value)
  return option ? { value: option, source: hit.source } : null
}

/** What would be filled without seeing the form (dry run): pack entries, then rules the pack doesn't cover. */
export function planFields(a, pack, location = '') {
  const out = [
    ...(pack?.fields ?? []).filter(f => str(f?.label)).map(f => ({ label: f.label, value: str(f.value), source: 'pack' })),
    ...(pack?.answers ?? []).filter(x => str(x?.question)).map(x => ({
      label: x.question, value: str(x.answer), source: str(x.answer) ? x.source ?? 'pack' : 'unanswered', required: x.required === true
    }))
  ]
  for (const label of PLAN_LABELS) {
    const r = ruleAnswer({ label }, { p: a, where: `${label} ${location}` })
    if (r && !out.some(p => ruleOf(p.label) === ruleOf(label))) out.push({ label, value: r.answer, source: r.source })
  }
  return out
}

/** Every --submit guard that fails (empty = may submit). Walls are 'captcha' | 'login' | 'account'. */
export function submitGuards({ score, minScore, submittedToday, max, unfilled = [], walls = [], hasSubmit = true }) {
  return [
    !(Number.isFinite(score) && score >= minScore) && 'score',
    submittedToday >= max && 'daily-cap',
    unfilled.length > 0 && 'unfilled-required',
    ...walls,
    !hasSubmit && 'no-submit-button'
  ].filter(Boolean)
}

/** Submissions logged on `now`'s local day (JSONL text). */
export function countToday(text, now) {
  const day = now.toDateString()
  return String(text ?? '').split('\n').filter(line => {
    try {
      const e = JSON.parse(line)
      return e?.result === 'submitted' && new Date(e.at).toDateString() === day
    } catch {
      return false
    }
  }).length
}

/** 'greenhouse' | 'lever' | 'ashby' (submittable), 'smartrecruiters' | 'workable' | 'generic' (fill only), by host,
 * then by the form markers found in the page. */
export function detectAts(url, dom = {}) {
  let host = ''
  try { host = new URL(url).hostname } catch {}
  const all = { ...ATS, ...FILL_ONLY }
  return Object.keys(all).find(k => all[k].test(host)) ?? Object.keys(ATS).find(k => dom[k]) ?? 'generic'
}

const isObj = v => v && typeof v === 'object' && !Array.isArray(v)

/** What is wrong with an apply-queue bundle ({ jobs, cv: { name, content, layout }, profile?, mode?, minScore?, max? }), or null. */
export function bundleError(b) {
  if (!isObj(b)) return 'not a JSON object'
  if (!Array.isArray(b.jobs) || !b.jobs.length) return 'jobs must be a non-empty list'
  if (b.jobs.length > MAX_BUNDLE_JOBS) return `at most ${MAX_BUNDLE_JOBS} jobs`
  if (!b.jobs.every(isObj)) return 'every job must be an object'
  if (!isObj(b.cv) || typeof b.cv.content !== 'string') return 'cv.content must be text'
  if (b.profile != null && !isObj(b.profile)) return 'profile must be an object'
  if (b.minScore != null && !(Number.isFinite(b.minScore) && b.minScore >= 0 && b.minScore <= 5)) return 'minScore must be 0–5'
  if (b.max != null && !(Number.isInteger(b.max) && b.max >= 0)) return 'max must be a whole number'
  if (b.mode != null && !['review', 'submit'].includes(b.mode)) return 'mode must be review or submit'
  return null
}

/** The application form URL (http/https only): Lever and Ashby postings have the form on a sub-page. */
export function applyUrlOf(job) {
  const url = [job?.applyUrl, job?.pack?.applyUrl, job?.url].map(str).find(Boolean) ?? ''
  if (!/^https?:\/\//i.test(url)) return null
  if (/^https:\/\/jobs\.lever\.co\/[^/]+\/[^/?#]+\/?$/.test(url)) return url.replace(/\/?$/, '/apply')
  if (/^https:\/\/jobs\.ashbyhq\.com\/[^/]+\/[^/?#]+\/?$/.test(url)) return url.replace(/\/?$/, '/application')
  return url
}

// Runs inside the application page (serialised with toString). 'scan' tags each control with data-recto-key and
// describes it; 'fill' sets values like a user would (events included); 'mark' outlines unfilled required fields.
// Password fields are never listed, so they are never filled.
function inPage(action, arg) {
  const CONTAINER = 'fieldset, [role=radiogroup], [role=group], .application-question, .field, .ashby-application-form-field-entry'
  const clean = s => (s ?? '').replace(/[*✱]/g, ' ').replace(/\s+/g, ' ').trim()
  const textOf = node => {
    if (!node) return ''
    const c = node.cloneNode(true)
    c.querySelectorAll('input, select, textarea, option, script, style').forEach(n => n.remove())
    return c.textContent
  }
  const byKey = key => [...document.querySelectorAll(`[data-recto-key="${key}"]`)]
  const optionLabel = el => clean(textOf(el.labels?.[0]) || el.value)
  const setValue = (el, v) => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  if (action === 'fill') {
    for (const { key, value } of arg) {
      const els = byKey(key)
      const el = els[0]
      if (!el) continue
      if (el.tagName === 'SELECT') {
        const o = [...el.options].find(o => clean(o.text) === value)
        if (o) setValue(el, o.value)
      } else if (el.type === 'radio' || el.type === 'checkbox') {
        const m = els.find(m => optionLabel(m) === value)
        if (m && !m.checked) m.click()
      } else setValue(el, value)
    }
    return true
  }
  if (action === 'mark') {
    arg.forEach((key, i) => {
      const el = byKey(key)[0]
      const box = el?.closest(CONTAINER) ?? el
      if (!box) return
      box.style.outline = '3px solid #d93025'
      box.style.outlineOffset = '2px'
      if (i === 0) box.scrollIntoView({ block: 'center' })
    })
    return true
  }

  const rawLabel = (el, group) => {
    const own = group ? '' : (textOf(el.labels?.[0]) || el.getAttribute('aria-label') ||
      (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id => textOf(document.getElementById(id))).join(' '))
    if (clean(own)) return own
    const box = el.closest(CONTAINER)
    const legend = box?.querySelector('legend')
    if (legend) return textOf(legend)
    if (box) {
      const c = box.cloneNode(true)
      c.querySelectorAll('label:has(input), input, select, textarea').forEach(n => n.remove())
      if (clean(c.textContent)) return c.textContent
    }
    return el.placeholder || el.name || ''
  }
  const fields = []
  const seen = new Set()
  for (const el of document.querySelectorAll('input, select, textarea')) {
    const type = el.tagName === 'INPUT' ? el.type : el.tagName.toLowerCase()
    if (el.disabled || ['hidden', 'submit', 'button', 'reset', 'image', 'password', 'search'].includes(type)) continue
    if (type === 'radio' && !el.name) continue
    const sameName = el.name ? document.querySelectorAll(`input[type=${type}][name="${CSS.escape(el.name)}"]`) : []
    const choice = type === 'radio' || (type === 'checkbox' && sameName.length > 1)
    if (choice && seen.has(el.name)) continue
    if (choice) seen.add(el.name)
    const members = choice ? [...sameName] : [el]
    const key = `f${fields.length}`
    members.forEach(m => m.setAttribute('data-recto-key', key))
    const raw = rawLabel(el, choice)
    const checked = members.find(m => m.checked)
    fields.push({
      key,
      kind: choice ? 'choice' : ['select', 'textarea', 'file', 'checkbox'].includes(type) ? type : 'text',
      name: el.name,
      label: clean(raw),
      required: members.some(m => m.required || m.getAttribute('aria-required') === 'true') || /[*✱]/.test(raw),
      options: type === 'select' ? [...el.options].filter(o => o.value !== '' && !o.disabled).map(o => clean(o.text))
        : choice ? members.map(optionLabel) : [],
      value: choice ? (checked ? optionLabel(checked) : '')
        : type === 'select' ? (el.value !== '' && el.selectedIndex >= 0 ? clean(el.options[el.selectedIndex].text) : '')
        : type === 'file' ? el.files?.[0]?.name ?? ''
        : type === 'checkbox' ? (el.checked ? 'checked' : '')
        : el.value.trim()
    })
  }
  const frames = [...document.querySelectorAll('iframe')].map(f => `${f.src} ${f.title}`).join(' ')
  const text = document.body?.innerText ?? ''
  const walls = []
  if (/captcha|turnstile|challenges\.cloudflare\.com/i.test(frames) ||
    document.querySelector('.g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey], [data-hcaptcha-widget-id]')) walls.push('captcha')
  if (document.querySelector('input[type=password]') || /\b(sign|log) ?in to (apply|continue)\b/i.test(text)) walls.push('login')
  if (/\bcreate (an |your )?account\b|\b(sign up|register) to apply\b/i.test(text)) walls.push('account')
  const buttons = [...document.querySelectorAll('button, input[type=submit], input[type=button]')]
  const submit = buttons.find(b => /submit/i.test(`${b.id} ${b.innerText || b.value}`)) ?? document.querySelector('form [type=submit]')
  document.querySelectorAll('[data-recto-submit]').forEach(b => b.removeAttribute('data-recto-submit'))
  submit?.setAttribute('data-recto-submit', '')
  const has = sel => !!document.querySelector(sel)
  const ats = {
    greenhouse: has('#application_form, #grnhse_app, [name^="job_application["]'),
    lever: has('.application-page, [name^="urls["], [name^="cards["]'),
    ashby: has('.ashby-application-form-container, [id^="_systemfield_"]')
  }
  return { fields, walls, ats, submit: !!submit }
}

const inPageCall = (action, arg = null) => `(${inPage})(${JSON.stringify(action)}, ${JSON.stringify(arg)})`

async function fillForm(page, url, ctx) {
  const scan = await page.evaluate(inPageCall('scan'))
  const fills = scan.fields.filter(f => !f.value && f.kind !== 'file' && f.kind !== 'checkbox')
    .map(f => ({ key: f.key, value: resolveField(f, ctx)?.value })).filter(f => f.value)
  await page.evaluate(inPageCall('fill', fills))
  const resume = scan.fields.find(f => f.kind === 'file' && /\b(resume|cv)\b/.test(norm(`${f.label} ${f.name}`)))
  if (resume && !resume.value) await page.setFileInputFiles(`[data-recto-key="${resume.key}"]`, [ctx.pdf])
  const after = await page.evaluate(inPageCall('scan'))
  const unfilled = after.fields.filter(f => f.required && !f.value)
  await page.evaluate(inPageCall('mark', unfilled.map(f => f.key)))
  return { ...after, ats: detectAts(url, after.ats), unfilled }
}

// Confirmation = the page left the form (fully loaded) or shows a thank-you / application-received message
async function submitAndConfirm(page, timeout) {
  const start = (await page.evaluate('location.href')).split('#')[0]
  await page.click('[data-recto-submit]')
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    await delay(250)
    const s = await page.evaluate('({ href: location.href, ready: document.readyState, text: document.body?.innerText ?? "" })', { timeout: 2000 }).catch(() => null)
    if (s && (CONFIRM_RE.test(s.text) || (s.ready === 'complete' && s.href.split('#')[0] !== start))) return true
  }
  return false
}

function scoreOf(job, cv, profile) {
  const stored = [...(Array.isArray(job.evaluations) ? job.evaluations : [])].reverse().find(e => Number.isFinite(e?.score))?.score
  if (Number.isFinite(stored)) return stored
  if (!str(job.text)) return null
  try { return evaluateJob(cv, { text: job.text, url: job.url }, { profile }).score } catch { return null }
}

async function readJson(path, what, UsageError) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (err) {
    throw new UsageError(`autoapply: cannot read ${what} ${path}: ${err.code ?? err.message}`)
  }
}

/** Runs autoapply; returns one result per saved job ({ jobId, result, reason, ats?, fields?, unfilled?, walls? }).
 * `opts.bundle` (apply-queue file: jobs + cv + profile + minScore/max) replaces jobs/cv/profile and is the tracker file
 * written back; flags win over its minScore/max. `opts.progressJson`: one y/n answer per waiting job instead of two prompts.
 * deps: readInput(path) → Recto file, exportPdf(file, out), launch, ask(question) → answer, emit(event) (progress events),
 * findAnswer (answer bank lookup), now, print, UsageError. */
export async function autoapply(opts, deps) {
  const {
    bundle: bundlePath, cv: cvPath, profile: profilePath, submit = false, dryRun = false, progressJson = false,
    log: logPath = 'applications.jsonl', outDir = join('out', 'applications'), confirmTimeout = CONFIRM_TIMEOUT
  } = opts
  const {
    readInput, exportPdf, launch = launchChrome, ask = async () => '', emit = () => {}, findAnswer = bankAnswer,
    now = () => new Date(), print = s => process.stdout.write(s + '\n'), UsageError = Error
  } = deps
  const jobsPath = bundlePath ?? opts.jobs
  const data = await readJson(jobsPath, bundlePath ? 'bundle' : 'jobs', UsageError)
  const problem = bundlePath && bundleError(data)
  if (problem) throw new UsageError(`autoapply: ${jobsPath} is not an apply bundle: ${problem}`)
  const list = Array.isArray(data) ? data : data?.jobs
  if (!Array.isArray(list)) throw new UsageError(`autoapply: ${jobsPath} is not a jobs export (expected { "jobs": [...] })`)
  const profile = bundlePath && data.profile ? data.profile : profilePath ? await readJson(profilePath, 'profile', UsageError) : {}
  const file = bundlePath ? migrateFile({ ...data.cv, format: 'recto', version: 1 }).file : await readInput(cvPath)
  const minScore = opts.minScore ?? (bundlePath ? data.minScore : null) ?? 4
  const max = opts.max ?? (bundlePath ? data.max : null) ?? 5
  const doc = parse(file.content)
  const cv = { source: file.content, doc, layout: file.layout }
  const a = applicant(profile, doc)
  const mode = submit ? 'submit' : 'review'
  let submittedToday = countToday(await readFile(logPath, 'utf8').catch(() => ''), now())
  const results = []
  let browser, pdfMaster

  const record = async (job, result, reason, extra = {}) => {
    const entry = { at: now().toISOString(), jobId: job.id, company: str(job.company), title: str(job.title), url: applyUrlOf(job) ?? str(job.url), mode, result, reason }
    await appendFile(logPath, JSON.stringify(entry) + '\n')
    results.push({ ...entry, ...extra })
    emit({ type: 'job', id: job.id, state: result, reason })
  }
  const markApplied = async job => {
    const at = now().toISOString()
    job.status = 'applied'
    job.statusHistory = [...(Array.isArray(job.statusHistory) ? job.statusHistory : []), { status: 'applied', at }]
    job.updatedAt = at
    await writeFile(jobsPath, JSON.stringify(data, null, 2) + '\n')
  }
  const pdfName = pack => {
    const name = basename(str(pack?.pdfName) || [a.firstName, a.lastName, 'CV'].filter(Boolean).join('-')).replace(/[^\w.-]+/g, '-')
    return /\.pdf$/i.test(name) ? name : `${name}.pdf`
  }
  // Same CV for every job: export once, copy under each job's file name
  const pdfFor = async (job, pack) => {
    const out = resolve(outDir, safe(job.id), pdfName(pack))
    await mkdir(dirname(out), { recursive: true })
    if (pdfMaster) await copyFile(pdfMaster, out)
    else {
      await exportPdf(file, out)
      pdfMaster = out
    }
    return out
  }

  const saved = list.filter(j => j && typeof j === 'object' && j.status === 'saved')
  saved.forEach((job, i) => { job.id ??= `job-${i + 1}` })
  for (const job of saved) emit({ type: 'job', id: job.id, state: 'queued' })
  try {
    for (const [i, job] of saved.entries()) {
      const url = applyUrlOf(job)
      const pack = job.pack && typeof job.pack === 'object' ? job.pack : null
      const score = scoreOf(job, cv, a)
      print(`[${i + 1}/${saved.length}] ${str(job.title) || 'Untitled'} — ${str(job.company) || '?'} (${detectAts(url ?? '')})`)
      if (!url) {
        print('  skipped: no application URL')
        if (!dryRun) await record(job, 'skipped', 'no-apply-url')
        continue
      }
      print(`  ${url}`)

      if (dryRun) {
        print(`  pdf: ${pdfName(pack)} · score: ${score ?? 'none'} (min ${minScore})`)
        for (const p of planFields(a, pack, str(job.location))) print(`  ${p.label}: ${p.value || '(unanswered)'} (${p.source})`)
        const unanswered = (pack?.answers ?? []).filter(x => x?.required && !str(x.answer))
        const failing = submitGuards({ score, minScore, submittedToday, max, unfilled: unanswered })
        if (!submit) print('  review: fills the form and stops before Submit')
        else if (failing.length) print(`  --submit: stop before Submit: ${failing.join(', ')}`)
        else {
          submittedToday++
          print('  --submit: would submit if the page shows no CAPTCHA, login or account wall and every required field fills')
        }
        continue
      }

      let pdf, page
      try {
        pdf = await pdfFor(job, pack)
      } catch (err) {
        print(`  skipped: PDF export failed (${firstLine(err)})`)
        await record(job, 'skipped', 'pdf-export-failed')
        continue
      }
      emit({ type: 'job', id: job.id, state: 'filling' })
      browser ??= await launch({ headless: false, userDataDir: join(homedir(), '.recto', 'chrome') })
      try {
        page = await browser.newPage(url)
      } catch (err) {
        print(`  skipped: ${firstLine(err)}`)
        await record(job, 'skipped', 'load-failed')
        continue
      }
      try {
        const form = await fillForm(page, url, { applicant: a, pack, pdf, location: str(job.location), findAnswer })
        const extra = { ats: form.ats, fields: form.fields, unfilled: form.unfilled, walls: form.walls }
        print(`  ${form.ats}: filled ${form.fields.filter(f => f.value).length}/${form.fields.length} fields, attached ${basename(pdf)}`)
        if (form.unfilled.length) print(`  unfilled required (outlined in red): ${form.unfilled.map(f => f.label).join('; ')}`)
        if (form.walls.length) print(`  ${form.walls.join(', ')} wall detected: that part is yours to do in the browser`)
        const failing = submit
          ? submitGuards({ score, minScore, submittedToday, max, unfilled: form.unfilled, walls: form.walls, hasSubmit: form.submit })
          : []
        // generic filler: a form we do not know is never submitted, even when every guard passes
        if (submit && !failing.length && !Object.hasOwn(ATS, form.ats)) failing.push('unsupported-ats')
        if (submit && !failing.length) {
          if (await submitAndConfirm(page, confirmTimeout)) {
            await mkdir(resolve(outDir), { recursive: true })
            const shot = resolve(outDir, `${safe(job.id)}.png`)
            await writeFile(shot, await page.screenshot())
            submittedToday++
            await markApplied(job)
            await record(job, 'submitted', '', extra)
            print(`  submitted (confirmation: ${shot})`)
            continue
          }
          failing.push('no-confirmation')
        }
        if (failing.length) print(`  not submitting: ${failing.join(', ')}`)
        let yes
        if (progressJson) {
          emit({ type: 'wait', id: job.id })
          yes = /^y/i.test(str(await ask('')))
        } else {
          await ask('  Review and submit in the browser, then press Enter ')
          yes = /^y/i.test(str(await ask('  Did you submit? [y/N] ')))
        }
        if (yes) {
          submittedToday++
          await markApplied(job)
        }
        await record(job, yes ? 'submitted' : failing.length ? 'blocked' : 'filled', (failing.length ? failing : form.walls).join(', '), extra)
      } catch (err) {
        // One broken page (CDP timeout, unmatched submit control) must not abort the rest of the run
        print(`  skipped: fill failed (${firstLine(err)})`)
        await record(job, 'skipped', 'fill-failed', { error: firstLine(err) })
      } finally {
        await page.close().catch(() => {})
      }
    }
  } finally {
    await browser?.close()
  }
  const summary = {}
  for (const r of results) summary[r.result] = (summary[r.result] ?? 0) + 1
  emit({ type: 'done', summary })
  return results
}

// Line-based prompts on stdin; EOF (piped or closed stdin) answers '' so nothing is ever assumed submitted
// (to `out`: stderr under --progress-json, whose stdout carries only JSON events)
function stdinPrompt(out = process.stdout) {
  let rl, lines
  return {
    async ask(question) {
      out.write(question)
      rl ??= createInterface({ input: process.stdin, terminal: false })
      lines ??= rl[Symbol.asyncIterator]()
      const { value } = await lines.next()
      return value ?? ''
    },
    close: () => rl?.close()
  }
}

/** CLI entry (`recto autoapply ...`); recto.js passes its readInput, exportFile, UsageError and usage text. */
export async function main(argv, { readInput, exportPdf, UsageError = Error, usage = '' } = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      jobs: { type: 'string' }, cv: { type: 'string' }, profile: { type: 'string' }, 'min-score': { type: 'string' },
      max: { type: 'string' }, submit: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, log: { type: 'string' },
      bundle: { type: 'string' }, 'progress-json': { type: 'boolean' }, help: { type: 'boolean', short: 'h' }
    }
  })
  if (values.help) {
    process.stdout.write(usage + '\n')
    return 0
  }
  if (!values.bundle && (!values.jobs || !values.cv)) throw new UsageError('autoapply needs --jobs <jobs.json> and --cv <cv>, or --bundle <recto-apply.json>')
  const num = (flag, fallback, whole) => {
    const raw = values[flag]
    if (raw === undefined) return fallback
    const n = Number(raw)
    if (raw.trim() === '' || !Number.isFinite(n) || n < 0 || (whole && !Number.isInteger(n))) throw new UsageError(`autoapply: --${flag} expects a ${whole ? 'whole ' : ''}number, got "${raw}"`)
    return n
  }
  const progressJson = !!values['progress-json']
  const opts = {
    jobs: values.jobs, cv: values.cv, bundle: values.bundle, minScore: num('min-score'), max: num('max', undefined, true),
    submit: !!values.submit, dryRun: !!values['dry-run'], log: values.log ?? 'applications.jsonl', progressJson,
    profile: values.profile ?? (await access('profile.json').then(() => 'profile.json', () => null))
  }
  const out = progressJson ? process.stderr : process.stdout
  const prompt = stdinPrompt(out)
  const extra = progressJson ? { emit: e => process.stdout.write(JSON.stringify(e) + '\n'), print: s => out.write(s + '\n') } : {}
  try {
    await autoapply(opts, { readInput, exportPdf, UsageError, ask: prompt.ask, ...extra })
    return 0
  } finally {
    prompt.close()
  }
}
