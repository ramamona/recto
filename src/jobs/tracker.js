// Job tracker store (assist spec 3): jobs in localStorage['recto:jobs'], export/import JSON. Never throws on bad data.

export const JOBS_KEY = 'recto:jobs'
export const STATUSES = ['saved', 'applied', 'interview', 'offer', 'rejected', 'no-response', 'skipped']
export const STALE_DAYS = 21
const SOURCES = ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'remotive', 'arbeitnow', 'jobicy', 'pipeline', 'url', 'paste']
const MAX_QUESTIONS = 100
const MAX_PACK = 200_000 // chars of JSON: answers are short; a pack past this is junk
const FORMAT = 'recto-jobs'
export const OUTCOME_STAGES = ['screen', 'interview', 'final', 'offer', '']
export const FOLLOW_UP_KINDS = ['follow-up', 'thank-you', 'check-in']
export const CONTACT_KINDS = ['recruiter', 'hiring-manager', 'peer', 'other']
const MAX_STR = 5000
const MAX_LIST = 50
const MAX_ARTIFACT = 50_000 // chars of JSON per mode
const MAX_APPLY_LOG = 200

const str = v => typeof v === 'string' ? v : ''
const isJob = j => j && typeof j === 'object' && !Array.isArray(j)
// Application pack (src/jobs/pack.js) and form questions are kept as given when well-formed; junk or oversized is dropped
const packOf = v => isJob(v) && Array.isArray(v.answers) && Array.isArray(v.fields) && JSON.stringify(v).length <= MAX_PACK ? v : null
const questionsOf = v => Array.isArray(v) ? v.filter(q => isJob(q) && str(q.label)).slice(0, MAX_QUESTIONS) : []

// Career-suite fields (suite spec 5): all optional, capped, junk dropped; empty values are left out so old jobs load unchanged
const cap = v => typeof v === 'number' && Number.isFinite(v) ? String(v) : str(v).slice(0, MAX_STR)
const numOrStr = v => typeof v === 'number' && Number.isFinite(v) ? v : cap(v)
const safeLink = v => /^(?:https?:|mailto:|tel:)/i.test(str(v)) ? cap(v) : ''
const listOf = (v, fn, max = MAX_LIST) => Array.isArray(v) ? v.map(e => isJob(e) ? fn(e) : null).filter(Boolean).slice(0, max) : []
const outcomeOf = o => ({ stage: OUTCOME_STAGES.includes(o.stage) ? o.stage : '', reason: cap(o.reason), at: cap(o.at) })
const followUpOf = f => str(f.due) && FOLLOW_UP_KINDS.includes(f.kind) ? { due: cap(f.due), kind: f.kind, done: f.done === true } : null
const contactOf = c => str(c.name) ? { name: cap(c.name), role: cap(c.role), kind: CONTACT_KINDS.includes(c.kind) ? c.kind : 'other', url: safeLink(c.url), note: cap(c.note) } : null
const interviewOf = i => ({ at: cap(i.at), round: cap(i.round), notes: cap(i.notes), debrief: cap(i.debrief) })
const applyEntryOf = e => str(e.at) && str(e.result) ? { at: cap(e.at), result: cap(e.result), reason: cap(e.reason) } : null
function offerOf(o) {
  const out = {}
  const base = o.base === '' || o.base == null ? NaN : Number(o.base)
  if (Number.isFinite(base) && base >= 0) out.base = base
  return { ...out, currency: cap(o.currency), super: numOrStr(o.super), bonus: numOrStr(o.bonus), equity: numOrStr(o.equity), notes: cap(o.notes), deadline: cap(o.deadline) }
}
// Latest AI brief per mode, kept as given when well-formed and under the size cap
function artifactsOf(a) {
  const ok = ([mode, b]) => /^[a-z][a-z-]{0,39}$/.test(mode) && isJob(b) && Array.isArray(b.sections) && JSON.stringify(b).length <= MAX_ARTIFACT
  const kept = Object.entries(a).filter(ok).slice(0, MAX_LIST)
  return kept.length ? Object.fromEntries(kept) : null
}
function suiteFields(j) {
  const out = {}
  if (isJob(j.outcome)) out.outcome = outcomeOf(j.outcome)
  if (isJob(j.offer)) out.offer = offerOf(j.offer)
  const artifacts = isJob(j.artifacts) && artifactsOf(j.artifacts)
  if (artifacts) out.artifacts = artifacts
  const lists = {
    followUps: listOf(j.followUps, followUpOf),
    contacts: listOf(j.contacts, contactOf),
    interviews: listOf(j.interviews, interviewOf),
    applyLog: Array.isArray(j.applyLog) ? listOf(j.applyLog, applyEntryOf, Infinity).slice(-MAX_APPLY_LOG) : []
  }
  for (const [k, v] of Object.entries(lists)) if (v.length) out[k] = v
  return out
}
const newId = () => globalThis.crypto?.randomUUID?.() ?? `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

// localStorage itself can throw on access (blocked site data); fall back to memory
function defaultStorage() {
  try { if (globalThis.localStorage) return globalThis.localStorage } catch {}
  const m = new Map()
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }
}

// Valid history as stored, else one entry for the current status (jobs saved before statusHistory existed)
function historyOf(j, status, at) {
  const h = Array.isArray(j.statusHistory) ? j.statusHistory.filter(e => isJob(e) && STATUSES.includes(e.status) && str(e.at)) : []
  return h.length ? h.map(({ status, at }) => ({ status, at })) : [{ status, at }]
}
const migrate = j => ({ ...j, statusHistory: historyOf(j, j.status, str(j.updatedAt) || str(j.createdAt)) })

/** Applied with no status change for `days` days: the board suggests No response (never automatic). */
export function staleApplied(job, now, days = STALE_DAYS) {
  if (job?.status !== 'applied') return false
  const last = Date.parse(job.statusHistory?.at(-1)?.at ?? job.updatedAt)
  return Number.isFinite(last) && +now - last >= days * 864e5
}

function clean(j, stamp) {
  const out = {
    id: str(j.id) || newId(),
    url: str(j.url),
    source: SOURCES.includes(j.source) ? j.source : j.url ? 'url' : 'paste',
    title: str(j.title), company: str(j.company), location: str(j.location), text: str(j.text),
    fetchedAt: str(j.fetchedAt) || stamp,
    status: STATUSES.includes(j.status) ? j.status : 'saved',
    docIds: Array.isArray(j.docIds) ? [...new Set(j.docIds.filter(d => typeof d === 'string'))] : [],
    evaluations: Array.isArray(j.evaluations) ? j.evaluations.filter(isJob) : [],
    notes: str(j.notes),
    createdAt: str(j.createdAt) || stamp,
    updatedAt: str(j.updatedAt) || stamp
  }
  out.statusHistory = historyOf(j, out.status, out.updatedAt)
  if (str(j.postedAt)) out.postedAt = j.postedAt
  if (/^https?:\/\//i.test(str(j.applyUrl))) out.applyUrl = j.applyUrl
  if (str(j.board)) out.board = j.board
  const questions = questionsOf(j.questions)
  if (questions.length) out.questions = questions
  const pack = packOf(j.pack)
  if (pack) out.pack = pack
  return Object.assign(out, suiteFields(j))
}

/** `{ list, get, save, remove, addEvaluation, link, export, import }` over `storage`; `now` is injectable for tests.
 * `save` appends `{ status, at }` to `statusHistory` on creation and on every status change. */
export function createTracker(storage = defaultStorage(), { now = () => new Date() } = {}) {
  const stamp = () => now().toISOString()

  function read() {
    try {
      const data = JSON.parse(storage.getItem(JOBS_KEY) ?? '[]')
      return Array.isArray(data) ? data.filter(j => isJob(j) && typeof j.id === 'string' && j.id).map(migrate) : []
    } catch {
      return []
    }
  }
  const write = jobs => storage.setItem(JOBS_KEY, JSON.stringify(jobs))

  function update(id, change) {
    const jobs = read()
    const i = jobs.findIndex(j => j.id === id)
    if (i < 0) return null
    jobs[i] = { ...change(jobs[i]), updatedAt: stamp() }
    write(jobs)
    return jobs[i]
  }

  return {
    list: () => read().sort((a, b) => str(b.updatedAt).localeCompare(str(a.updatedAt))),
    get: id => read().find(j => j.id === id) ?? null,
    save(job) {
      const jobs = read()
      const i = jobs.findIndex(j => j.id === job?.id)
      const t = stamp()
      const prev = i < 0 ? { status: null, statusHistory: [] } : jobs[i]
      const saved = clean({ ...job, createdAt: i < 0 ? t : prev.createdAt, updatedAt: t, statusHistory: null }, t)
      // stored history wins over the caller's; append only when the status changes (incl. creation)
      saved.statusHistory = prev.status === saved.status ? prev.statusHistory
        : [...prev.statusHistory, { status: saved.status, at: t }]
      if (i < 0) jobs.push(saved)
      else jobs[i] = saved
      write(jobs)
      return saved
    },
    remove(id) {
      const jobs = read()
      const kept = jobs.filter(j => j.id !== id)
      if (kept.length === jobs.length) return false
      write(kept)
      return true
    },
    addEvaluation: (id, ev) => update(id, j => ({ ...j, evaluations: [...(j.evaluations ?? []), { at: stamp(), ...ev }] })),
    link: (id, docId) => update(id, j => ({ ...j, docIds: [...new Set([...(j.docIds ?? []), docId])] })),
    export: () => JSON.stringify({ format: FORMAT, version: 1, jobs: read() }, null, 2),
    import(json) {
      let data
      try { data = typeof json === 'string' ? JSON.parse(json) : json } catch { return { added: 0, warnings: [{ code: 'invalid-json' }] } }
      const list = Array.isArray(data) ? data : Array.isArray(data?.jobs) ? data.jobs : null
      if (!list) return { added: 0, warnings: [{ code: 'invalid-json' }] }
      const jobs = read()
      const ids = new Set(jobs.map(j => j.id))
      const warnings = []
      let added = 0
      list.forEach((j, index) => {
        if (!isJob(j) || !['title', 'company', 'text', 'url'].some(k => str(j[k]))) return warnings.push({ code: 'invalid-job', index })
        if (ids.has(j.id)) return warnings.push({ code: 'duplicate', index })
        const job = clean(j, stamp())
        ids.add(job.id)
        jobs.push(job)
        added++
      })
      if (added) write(jobs)
      return { added, warnings }
    }
  }
}
