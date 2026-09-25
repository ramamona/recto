// Job tracker store (assist spec 3): jobs in localStorage['recto:jobs'], export/import JSON. Never throws on bad data.

export const JOBS_KEY = 'recto:jobs'
export const STATUSES = ['saved', 'applied', 'interview', 'offer', 'rejected', 'skipped']
const SOURCES = ['greenhouse', 'lever', 'ashby', 'url', 'paste']
const FORMAT = 'recto-jobs'

const str = v => typeof v === 'string' ? v : ''
const isJob = j => j && typeof j === 'object' && !Array.isArray(j)
const newId = () => globalThis.crypto?.randomUUID?.() ?? `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

// localStorage itself can throw on access (blocked site data); fall back to memory
function defaultStorage() {
  try { if (globalThis.localStorage) return globalThis.localStorage } catch {}
  const m = new Map()
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }
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
  if (str(j.postedAt)) out.postedAt = j.postedAt
  return out
}

/** `{ list, get, save, remove, addEvaluation, link, export, import }` over `storage`; `now` is injectable for tests. */
export function createTracker(storage = defaultStorage(), { now = () => new Date() } = {}) {
  const stamp = () => now().toISOString()

  function read() {
    try {
      const data = JSON.parse(storage.getItem(JOBS_KEY) ?? '[]')
      return Array.isArray(data) ? data.filter(j => isJob(j) && typeof j.id === 'string' && j.id) : []
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
      const saved = clean({ ...job, createdAt: i < 0 ? t : jobs[i].createdAt, updatedAt: t }, t)
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
