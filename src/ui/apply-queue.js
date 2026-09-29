// Apply queue (career-suite spec §4): one click from many saved jobs to filled application forms. Steps: prepare a
// pack per job, ask each still-missing required question once (answers go to the bank and refill every pack), then run
// `recto autoapply` through serve.js's local bridge, or hand over one bundle file and one command when hosted.
// Guards stay those of `recto autoapply`: no CAPTCHA solving, no logins or accounts, submit only when the user turns it on.
import { h } from './dom.js'
import { loadProfile, saveProfile } from '../profile.js'
import { buildPack } from '../jobs/pack.js'
import { findAnswer as bankFind, remember as bankRemember } from '../jobs/answers.js'
import { createAssist } from '../ai/assist.js'
import { getConnection } from '../ai/connections.js'
import { download } from '../io/files.js'

/** autoapply's final per-job states: each one updates the tracker once. */
export const FINISHED = ['submitted', 'filled', 'blocked', 'skipped']
export const BUNDLE_FILE = 'recto-apply.json'
const BUNDLE_JOB_KEYS = ['id', 'title', 'company', 'location', 'url', 'applyUrl', 'status', 'text', 'evaluations', 'pack']
const POLL_MS = 1000

const str = v => typeof v === 'string' ? v : ''
const unanswered = a => a?.required === true && !str(a.answer).trim()

/**
 * Required unanswered questions across `[{ jobId, pack }]`, one group per question the same bank answer would fill
 * (answers.js findAnswer tiers: exact → same rule → similar): `[{ question, type, options, jobIds, members: [{ jobId, index }] }]`.
 */
export function missingQuestions(packs, { findAnswer = bankFind } = {}) {
  const groups = []
  for (const { jobId, pack } of packs ?? []) {
    for (const [index, a] of (pack?.answers ?? []).entries()) {
      if (!unanswered(a) || !str(a.question).trim()) continue
      const hit = findAnswer(groups.map(g => ({ question: g.question, answer: '-', group: g })), a.question)
      const group = hit?.entry.group ?? groups[groups.push({ question: a.question, type: 'text', options: [], jobIds: [], members: [] }) - 1]
      group.members.push({ jobId, index })
      if (!group.jobIds.includes(jobId)) group.jobIds.push(jobId)
      if (!group.options.length && a.options?.length) group.options = [...a.options]
      group.type = group.options.length ? 'choice' : a.type === 'textarea' || group.type === 'textarea' ? 'textarea' : 'text'
    }
  }
  return groups
}

/** The pack with unanswered questions filled from the bank (source 'bank'); answered ones untouched. */
export function fillFromBank(pack, bank, { findAnswer = bankFind } = {}) {
  if (!pack) return pack
  return {
    ...pack,
    answers: (pack.answers ?? []).map(a => {
      if (str(a.answer).trim()) return a
      const hit = findAnswer(bank ?? [], a.question, { options: a.options ?? [] })
      return hit ? { ...a, answer: hit.answer, source: 'bank' } : a
    })
  }
}

/** The bank with each group's non-blank answer (`values[i]` for `groups[i]`) remembered. */
export function rememberAnswers(bank, groups, values, now, { remember = bankRemember } = {}) {
  return groups.reduce((b, g, i) => {
    const answer = str(values[i]).trim()
    return answer ? remember(b, { question: g.question, answer, options: g.options }, now) : b
  }, Array.isArray(bank) ? bank : [])
}

/** The `recto autoapply --bundle` file: jobs (only what autoapply reads), one CV, the profile and the run settings. */
export function buildBundle({ jobs, cv, profile, mode, minScore, max }) {
  const pickJob = j => Object.fromEntries(BUNDLE_JOB_KEYS.filter(k => j[k] != null).map(k => [k, j[k]]))
  return {
    format: 'recto-apply', version: 1,
    mode: mode === 'submit' ? 'submit' : 'review',
    ...(Number.isFinite(minScore) ? { minScore } : {}),
    ...(Number.isInteger(max) ? { max } : {}),
    cv: { name: str(cv?.name), content: str(cv?.content), layout: cv?.layout ?? {} },
    profile: profile ?? {},
    jobs: jobs.map(pickJob)
  }
}

/** The tracker job after a finished autoapply state (`{ state, reason }`), or null while it is still running.
 * Submitted → applied (tracker.save appends the history); anything else stays saved with the reason in `applyLog`. */
export function trackerUpdate(job, { state, reason = '' } = {}, now = new Date()) {
  if (!job || !FINISHED.includes(state)) return null
  const entry = { at: now.toISOString(), result: state, reason: str(reason) }
  return { ...job, ...(state === 'submitted' ? { status: 'applied' } : {}), applyLog: [...(Array.isArray(job.applyLog) ? job.applyLog : []), entry] }
}

export const hostedCommand = submit => `node cli/recto.js autoapply --bundle ${BUNDLE_FILE}${submit ? ' --submit' : ''}`

// ---------- bridge client (serve.js /api/apply) ----------

async function probeBridge() {
  try {
    const res = await fetch('/api/apply', { headers: { accept: 'application/json' } })
    const data = res.ok && /json/.test(res.headers.get('content-type') ?? '') ? await res.json() : null
    return data?.bridge === true && typeof data.token === 'string' ? data.token : null
  } catch {
    return null
  }
}

function bridgeClient(token) {
  const call = async (path, body) => {
    const res = await fetch(path, body === undefined ? { headers: { 'x-recto-token': token } }
      : { method: 'POST', headers: { 'content-type': 'application/json', 'x-recto-token': token }, body: JSON.stringify(body) })
    const data = await res.json().catch(() => null)
    if (!res.ok) throw Object.assign(new Error(data?.message || data?.error || `HTTP ${res.status}`), { status: res.status })
    return data
  }
  return {
    start: bundle => call('/api/apply', bundle),
    status: () => call('/api/apply/status'),
    answer: submitted => call('/api/apply/continue', { submitted }),
    stop: () => call('/api/apply/stop', {})
  }
}

// ---------- controller ----------

// Greenhouse exposes the form's questions on the job detail (as pack-view does); others keep the common set
async function withQuestions(job) {
  if (job.questions?.length || job.source !== 'greenhouse') return job
  try {
    const { fetchDetails } = await import('../jobs/sources.js')
    return await fetchDetails({ ...job, board: job.board || job.id.split(':')[1] }, { fetch: (...a) => globalThis.fetch(...a) })
  } catch (err) {
    console.warn('recto: queue questions unavailable', err)
    return job
  }
}

async function pool(items, n, fn) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++])
  }))
}

/** Opens the queue for `jobIds` (tracker ids; only Saved jobs are queued). Returns the dialog's close function. */
export function openApplyQueue(store, ctx, { jobIds = [], tracker = ctx.tracker } = {}) {
  const { t } = ctx
  const all = jobIds.map(id => tracker.get(id)).filter(Boolean)
  const queue = all.filter(j => j.status === 'saved').map(j => j.id)
  const left = all.length - queue.length
  const s = {
    step: 'prepare', done: 0, failed: [], groups: [], values: [],
    mode: 'review', confirmed: false, minScore: 4, max: 10,
    run: null, error: '', handled: new Set(), client: null, hosted: null
  }
  let closed = false

  const body = h('div', { class: 'aq-body' })
  const dialog = h('dialog', { class: 'aq', closedby: 'any', 'aria-label': t('applyq.title') },
    h('header', { class: 'aq-head' }, h('h2', { tabIndex: -1 }, t('applyq.title')),
      h('button', { class: 'ui-btn ui-btn--sm ui-btn--ghost', type: 'button', 'aria-label': t('applyq.close'), onClick: () => close() }, '×')),
    body)
  dialog.addEventListener('close', () => { closed = true }, { once: true })

  const btn = (label, onClick, action, cls = '') => h('button', { class: `ui-btn ui-btn--sm ${cls}`.trim(), type: 'button', dataset: { action }, onClick }, label)
  const jobName = id => { const j = tracker.get(id); return [j?.title || t('job.untitled'), j?.company].filter(Boolean).join(' — ') }
  const packs = () => queue.map(id => ({ jobId: id, pack: tracker.get(id)?.pack ?? null }))
  const savePack = (id, pack) => { const job = tracker.get(id); if (job && pack) tracker.save({ ...job, pack }) }
  const show = () => { if (!closed) render() }

  async function assistant() {
    const client = ctx.ai?.getClient?.()
    if (!client || !(await (ctx.ai.ensureConsent?.(getConnection()?.provider) ?? true))) return undefined
    return createAssist({ client, getState: () => ({ content: store.state.content, doc: store.state.doc }) })
  }

  // 1. Prepare: stored packs are reused (refilled from the bank); others built like the pack view, without a tailored copy
  async function prepare() {
    const profile = loadProfile()
    const assist = await assistant()
    await pool(queue, 2, async id => {
      if (closed) return
      const job = tracker.get(id)
      try {
        const pack = job.pack ? fillFromBank(job.pack, profile.answers) : await buildPack({
          job: await withQuestions(job), profile, assist,
          cv: { docId: job.docIds?.[0] || store.state.docId, content: store.state.content, doc: store.state.doc }
        })
        savePack(id, pack)
      } catch (err) {
        console.warn('recto: queue pack failed', err)
        s.failed.push(id)
      }
      s.done++
      show()
    })
    s.groups = missingQuestions(packs())
    s.values = s.groups.map(() => '')
    s.step = s.groups.length ? 'answers' : 'run'
    show()
  }

  // 2. Missing answers: one input per group; saving writes the bank and refills every pack
  function saveAnswers() {
    const profile = loadProfile()
    const bank = rememberAnswers(profile.answers, s.groups, s.values, new Date())
    saveProfile({ ...profile, answers: bank })
    for (const { jobId, pack } of packs()) savePack(jobId, fillFromBank(pack, bank))
    s.step = 'run'
    render()
  }

  // 3. Run: bridge when serve.js offers one, else the bundle file and the command
  async function start() {
    s.error = ''
    const bundle = buildBundle({
      jobs: queue.map(id => tracker.get(id)).filter(Boolean), profile: loadProfile(),
      cv: { name: store.state.name || store.state.doc.header?.name || t('app.untitled'), content: store.state.content, layout: store.state.layout },
      mode: s.mode, minScore: s.minScore, max: s.max
    })
    const token = await probeBridge()
    if (!token) {
      download(BUNDLE_FILE, JSON.stringify(bundle, null, 2), 'application/json')
      s.hosted = hostedCommand(bundle.mode === 'submit')
      s.step = 'hosted'
      return render()
    }
    s.client = bridgeClient(token)
    try {
      await s.client.start(bundle)
    } catch (err) {
      s.error = err.status === 409 ? t('applyq.busy') : t('applyq.startFailed', { error: err.message })
      return render()
    }
    s.step = 'running'
    poll()
  }

  // Keeps polling after the dialog closes so every finished job still reaches the tracker
  async function poll() {
    try {
      s.run = await s.client.status()
      for (const j of s.run.jobs ?? []) {
        if (s.handled.has(j.id) || !FINISHED.includes(j.state)) continue
        s.handled.add(j.id)
        const next = trackerUpdate(tracker.get(j.id), j, new Date())
        if (next) tracker.save(next)
      }
      // answers the user typed into the employer's form join the profile's bank (the bridge keeps them in order)
      const learned = (s.run.learned ?? []).slice(s.learned ?? 0)
      if (learned.length) {
        s.learned = (s.learned ?? 0) + learned.length
        const profile = loadProfile()
        saveProfile({ ...profile, answers: learned.reduce((b, x) => bankRemember(b, x, new Date()), profile.answers) })
        ctx.toast?.(t('applyq.learned', { count: learned.length }))
      }
      if (!s.run.running) s.step = 'done'
    } catch (err) {
      s.error = t('applyq.lost', { error: err.message })
    }
    show()
    if (s.step === 'running') setTimeout(poll, POLL_MS)
  }

  const act = fn => async () => {
    try { await fn() } catch (err) { s.error = err.message; show() }
  }

  // ---------- view ----------
  function progress() {
    const total = queue.length
    return [h('p', { role: 'status' }, h('span', { class: 'job-spinner', 'aria-hidden': 'true' }), ' ', t('applyq.preparing', { done: s.done, total })),
      h('progress', { class: 'aq-progress', max: total || 1, value: s.done })]
  }

  function answerControl(g, i) {
    const id = `aq-q-${i}`
    const onInput = e => { s.values[i] = e.target.value }
    return g.options.length
      ? h('select', { class: 'ui-select', id, onChange: onInput }, h('option', { value: '' }, t('applyq.choose')),
        g.options.map(o => h('option', { value: o, selected: o === s.values[i] }, o)))
      : g.type === 'textarea' ? h('textarea', { class: 'ui-input aq-q__text', id, rows: 3, value: s.values[i], onInput })
        : h('input', { class: 'ui-input', id, type: 'text', value: s.values[i], onInput })
  }

  function answersStep() {
    return [h('p', {}, t('applyq.missing', { n: s.groups.length })),
      h('form', { class: 'aq-questions', onSubmit: e => { e.preventDefault(); saveAnswers() } },
        s.groups.map((g, i) => h('div', { class: 'aq-q' },
          h('label', { htmlFor: `aq-q-${i}`, class: 'aq-q__label' }, g.question),
          h('span', { class: 'aq-q__asked', title: g.jobIds.map(jobName).join('\n') }, t('applyq.askedBy', { n: g.jobIds.length })),
          answerControl(g, i))),
        h('p', { class: 'ui-muted' }, t('applyq.remembered')),
        h('div', { class: 'aq-actions' },
          h('button', { class: 'ui-btn ui-btn--sm ui-btn--primary', type: 'submit', dataset: { action: 'applyq-save-answers' } }, t('applyq.saveAnswers')),
          btn(t('applyq.skipAnswers'), () => { s.step = 'run'; render() }, 'applyq-skip-answers')))]
  }

  function runStep() {
    const radio = (mode, label) => h('label', { class: 'aq-mode' },
      h('input', { type: 'radio', name: 'aq-mode', value: mode, checked: s.mode === mode, onChange: () => { s.mode = mode; render() } }), label)
    const number = (key, label, step, max) => h('label', { class: 'aq-num' }, label,
      h('input', { class: 'ui-input', type: 'number', min: 0, max, step, value: String(s[key]),
        onChange: e => { const n = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(n) && n >= 0) s[key] = step === 1 ? Math.floor(n) : Math.min(5, n) } }))
    const blocked = s.mode === 'submit' && !s.confirmed
    const missing = packs().reduce((n, { pack }) => n + (pack?.answers ?? []).filter(unanswered).length, 0)
    return [
      missing > 0 && h('p', { class: 'aq-note' }, t('applyq.stillMissing', { n: missing })),
      h('fieldset', { class: 'aq-modes' }, h('legend', {}, t('applyq.mode')),
        radio('review', t('applyq.mode.review')), radio('submit', t('applyq.mode.submit'))),
      s.mode === 'submit' && h('label', { class: 'aq-confirm' },
        h('input', { type: 'checkbox', class: 'ui-check', checked: s.confirmed, onChange: e => { s.confirmed = e.target.checked; render() } }),
        t('applyq.confirm')),
      h('div', { class: 'aq-actions' }, number('minScore', t('applyq.minScore'), 0.1, 5), number('max', t('applyq.max'), 1)),
      h('p', { class: 'ui-muted' }, t('applyq.guards')),
      h('div', { class: 'aq-actions' },
        h('button', { class: 'ui-btn ui-btn--sm ui-btn--primary', type: 'button', disabled: blocked || !queue.length, dataset: { action: 'applyq-start' }, onClick: act(start) },
          t('applyq.start', { n: queue.length })))
    ]
  }

  function rows() {
    const jobs = s.run?.jobs ?? queue.map(id => ({ id, state: 'queued' }))
    return h('ul', { class: 'aq-rows' }, jobs.map(j => h('li', { class: `aq-row is-${j.state}` },
      h('span', { class: 'aq-row__name' }, jobName(j.id)),
      h('span', { class: 'aq-row__state' }, t(`applyq.state.${j.state}`), j.reason && ` · ${j.reason}`),
      j.state === 'waiting-for-you' && s.step === 'running' && h('span', { class: 'aq-actions' },
        btn(t('applyq.submitted'), act(() => s.client.answer(true)), 'applyq-submitted', 'ui-btn--primary'),
        btn(t('applyq.skip'), act(() => s.client.answer(false)), 'applyq-skip')))))
  }

  function summary() {
    const counts = Object.entries(s.run?.summary ?? {}).map(([k, n]) => t(`applyq.state.${k}`) + `: ${n}`).join(' · ')
    return h('p', { role: 'status' }, s.run?.stopped ? t('applyq.stopped') : t('applyq.finished'), counts && ` ${counts}`)
  }

  function render() {
    const parts = [left > 0 && h('p', { class: 'ui-muted' }, t('applyq.notSaved', { n: left })),
      s.failed.length > 0 && h('p', { class: 'aq-note' }, t('applyq.packFailed', { n: s.failed.length }))]
    if (!queue.length) parts.push(h('p', {}, t('applyq.empty')))
    else if (s.step === 'prepare') parts.push(progress())
    else if (s.step === 'answers') parts.push(answersStep())
    else if (s.step === 'run') parts.push(runStep())
    else if (s.step === 'hosted') {
      parts.push(h('p', {}, t('applyq.hosted', { file: BUNDLE_FILE })), h('code', { class: 'aq-cli' }, s.hosted),
        h('div', { class: 'aq-actions' }, btn(t('applyq.copy'), () => navigator.clipboard?.writeText(s.hosted).then(() => ctx.toast?.(t('applyq.copied')), () => {}), 'applyq-copy')),
        h('p', { class: 'ui-muted' }, t('applyq.hostedSafety')))
    } else {
      parts.push(s.step === 'running' ? h('div', { class: 'aq-actions' }, h('p', { role: 'status' }, t('applyq.running')),
        btn(t('applyq.stop'), act(() => s.client.stop()), 'applyq-stop')) : summary(), rows())
    }
    if (s.error) parts.push(h('p', { class: 'aq-error', role: 'alert' }, s.error))
    body.replaceChildren(...parts.flat(Infinity).filter(Boolean))
  }

  const close = ctx.openDialog(dialog)
  render()
  dialog.querySelector('h2').focus()
  if (queue.length) prepare()
  return close
}
