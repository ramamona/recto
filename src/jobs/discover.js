// Discovery engine (discover-apply spec 2): scan company boards + remote feeds, filter by the profile,
// drop what the tracker already has, evaluate locally and rank. Pure except the injected fetch.
import { SOURCES, TIMEOUT_MS, getJson, parsePostings, normalizeCompanies } from './sources.js'
import { canonicalTokens } from './parse.js'
import { evaluateJob } from './evaluate.js'
import { normalizeProfile, REMOTE } from '../profile.js'
import { normalizeLayout } from '../model/layout.js'
import { runPreflight } from '../preflight/rules.js'

export { TIMEOUT_MS }
export const CONCURRENCY = 6
export const DISCOVER_KEY = 'recto:discover'
const MAX_AGE_DAYS = 30

const str = v => typeof v === 'string' ? v : ''
const obj = v => v && typeof v === 'object' && !Array.isArray(v) ? v : {}
const list = v => [...new Set((Array.isArray(v) ? v : []).filter(s => typeof s === 'string').map(s => s.trim()).filter(Boolean))]
const num = v => v === '' || v == null ? NaN : Number(v)
const norm = s => str(s).toLowerCase().replace(/\s+/g, ' ').trim()
const escape = s => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
const hasWord = (hay, w) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(w)}(?![\\p{L}\\p{N}])`, 'iu').test(hay)

// ---- settings

/** `{ roles, locations, remote, maxAgeDays, minScore, feeds }`; roles/locations/remote default from the profile. */
export function normalizeDiscoverSettings(s, profile) {
  const o = obj(s), p = normalizeProfile(profile), f = obj(o.feeds)
  const age = Math.floor(num(o.maxAgeDays)), min = num(o.minScore)
  return {
    roles: Array.isArray(o.roles) ? list(o.roles) : p.targetRoles,
    locations: Array.isArray(o.locations) ? list(o.locations) : p.locations,
    remote: REMOTE.includes(o.remote) ? o.remote : p.remote,
    maxAgeDays: age > 0 ? age : MAX_AGE_DAYS,
    minScore: Number.isFinite(min) ? Math.min(5, Math.max(0, min)) : 0,
    feeds: {
      remotive: { enabled: obj(f.remotive).enabled === true, query: str(obj(f.remotive).query).trim() },
      arbeitnow: { enabled: obj(f.arbeitnow).enabled === true }
    }
  }
}

function defaultStorage() {
  try { if (globalThis.localStorage) return globalThis.localStorage } catch {}
  return null
}

export function loadDiscoverSettings(storage = defaultStorage(), profile) {
  try { return normalizeDiscoverSettings(JSON.parse(storage?.getItem(DISCOVER_KEY) ?? 'null'), profile) } catch { return normalizeDiscoverSettings(null, profile) }
}

export function saveDiscoverSettings(s, storage = defaultStorage(), profile) {
  const out = normalizeDiscoverSettings(s, profile)
  try { storage?.setItem(DISCOVER_KEY, JSON.stringify(out)) } catch {}
  return out
}

// ---- filters

// Every word of some target role appears in the title ("support engineer" matches "IT Support Engineer")
function roleOk(title, roles) {
  if (!roles.length) return true
  const words = new Set(canonicalTokens(title))
  return roles.some(r => { const want = canonicalTokens(r); return want.length && want.every(w => words.has(w)) })
}

// ponytail: a preferred location matches on its first comma part ("Berlin, Germany" → Berlin) as a word; a geocoder would be exact
function placeOk(p, { locations, remote }) {
  const here = !locations.length || locations.some(l => hasWord(p.location, l.split(',')[0].trim()))
  if (remote === 'remote') return p.remote === true
  if (remote === 'onsite') return p.remote !== true && here
  if (remote === 'hybrid') return here
  return p.remote === true || here
}

const fresh = (p, now, days) => !p.postedAt || +now - Date.parse(p.postedAt) <= days * 864e5

// ---- scan

function tasksFor(companies, s) {
  const tasks = normalizeCompanies(companies).map(c => ({ source: c.source, board: c.board, url: SOURCES[c.source].listUrl(c.board), company: c }))
  const { remotive, arbeitnow } = s.feeds
  if (remotive.enabled) tasks.push({ source: 'remotive', board: 'remotive', url: SOURCES.remotive.listUrl(remotive.query || s.roles[0] || '') })
  if (arbeitnow.enabled) tasks.push({ source: 'arbeitnow', board: 'arbeitnow', url: SOURCES.arbeitnow.listUrl(1) })
  return tasks
}

// Runs `tasks` with at most `n` in flight; results keep task order
async function pool(tasks, n, run, signal) {
  const out = new Array(tasks.length)
  let next = 0
  const worker = async () => {
    while (next < tasks.length && !signal?.aborted) {
      const i = next++
      out[i] = await run(tasks[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker))
  return out
}

const trackedJobs = t => Array.isArray(t) ? t : typeof t?.list === 'function' ? t.list() : []

/**
 * `{ results: Ranked[], errors: [{ source, board, message }] }`, `Ranked = { posting, evaluation, match, legitimacy }`.
 * `settings` (a `recto:discover` value) overrides the profile's roles/locations/remote; `feeds` overrides `settings.feeds`.
 * `cv` = `{ source, doc, layout, issues? }`. Rejects only when `signal` aborts.
 */
export async function discover({ companies, feeds, settings, profile, cv, tracker, now = new Date(), fetch = globalThis.fetch, signal, onProgress, timeoutMs = TIMEOUT_MS } = {}) {
  const s = normalizeDiscoverSettings(feeds ? { ...obj(settings), feeds } : settings, profile)
  const tasks = tasksFor(companies, s)
  const errors = []
  let done = 0
  onProgress?.({ done, total: tasks.length })
  const pages = await pool(tasks, CONCURRENCY, async t => {
    let postings = []
    try {
      postings = parsePostings(t.source, await getJson(t.url, { fetch, signal, timeoutMs }), t.company)
    } catch (err) {
      if (!signal?.aborted) errors.push({ source: t.source, board: t.board, message: str(err?.message) || String(err) })
    }
    onProgress?.({ done: ++done, total: tasks.length, source: t.source, board: t.board })
    return postings
  }, signal)
  signal?.throwIfAborted()

  const jobs = trackedJobs(tracker).filter(j => j && typeof j === 'object')
  const hidden = new Set(jobs.filter(j => j.status !== 'saved').flatMap(j => [j.id, j.url].filter(Boolean)))
  const seen = new Set()
  const candidates = pages.flat().filter(p => {
    const key = `${norm(p.company)}|${norm(p.title)}|${norm(p.location)}`
    if (seen.has(p.id) || seen.has(key)) return false
    seen.add(p.id).add(key)
    return ![p.id, p.url, p.applyUrl].some(k => k && hidden.has(k)) &&
      roleOk(p.title, s.roles) && placeOk(p, s) && fresh(p, now, s.maxAgeDays)
  })

  const c = obj(cv)
  const layout = normalizeLayout(c.layout)
  // Preflight once for the whole scan (matchCv would rerun it per posting)
  const issues = c.issues ?? (c.doc ? runPreflight({ source: str(c.source), doc: c.doc, layout, now }) : [])
  const opts = { profile: normalizeProfile(profile), now, liveness: 200, saved: jobs }
  const results = candidates.flatMap(posting => {
    const evaluation = evaluateJob({ ...c, layout, issues }, posting, opts)
    if (evaluation.gates.dealBreakers?.length || evaluation.score < s.minScore) return []
    return [{ posting, evaluation, match: evaluation.match, legitimacy: evaluation.legitimacy }]
  })
  results.sort((a, b) => b.evaluation.score - a.evaluation.score || b.match.score - a.match.score ||
    (Date.parse(b.posting.postedAt) || 0) - (Date.parse(a.posting.postedAt) || 0))
  return { results, errors }
}
