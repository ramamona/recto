// Discovery engine (discover-apply spec 2): scan company boards + remote feeds, filter by the profile,
// drop what the tracker already has, evaluate locally and rank. Country-aware per career-suite spec §2. Pure except the injected fetch.
import { ATS, SOURCES, TIMEOUT_MS, getJson, parsePostings, normalizeCompanies, fetchPostings, fetchDetails } from './sources.js'
import { DEFAULT_COUNTRY, countryOf, regionOf, mentionsCountry, inArea, namesPlace } from './region.js'
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

/**
 * `{ roles, locations, remote, maxAgeDays, minScore, country, boards, feeds }` (`boards`: which ATS kinds to scan); roles/locations/remote default from the profile.
 * `country` is a preset code or '' (Any); unset → the profile's country → `detected` (the browser's, UI only) → DEFAULT_COUNTRY.
 */
export function normalizeDiscoverSettings(s, profile, detected = '') {
  const o = obj(s), p = normalizeProfile(profile), f = obj(o.feeds)
  const age = Math.floor(num(o.maxAgeDays)), min = num(o.minScore)
  return {
    roles: Array.isArray(o.roles) ? list(o.roles) : p.targetRoles,
    locations: Array.isArray(o.locations) ? list(o.locations) : p.locations,
    remote: REMOTE.includes(o.remote) ? o.remote : p.remote,
    maxAgeDays: age > 0 ? age : MAX_AGE_DAYS,
    minScore: Number.isFinite(min) ? Math.min(5, Math.max(0, min)) : 0,
    country: o.country === '' ? '' : countryOf(o.country) || countryOf(p.country) || countryOf(detected) || DEFAULT_COUNTRY,
    boards: Array.isArray(o.boards) ? ATS.filter(a => o.boards.includes(a)) : [...ATS],
    feeds: {
      remotive: { enabled: obj(f.remotive).enabled === true, query: str(obj(f.remotive).query).trim() },
      arbeitnow: { enabled: obj(f.arbeitnow).enabled === true },
      jobicy: { enabled: obj(f.jobicy).enabled === true }
    }
  }
}

function defaultStorage() {
  try { if (globalThis.localStorage) return globalThis.localStorage } catch {}
  return null
}

// First scan ever: the country-filtered Jobicy feed is on too (later the user's saved choice wins)
const FIRST_RUN = { feeds: { jobicy: { enabled: true } } }

export function loadDiscoverSettings(storage = defaultStorage(), profile, detected) {
  try {
    const raw = storage?.getItem(DISCOVER_KEY)
    return normalizeDiscoverSettings(raw == null ? FIRST_RUN : JSON.parse(raw), profile, detected)
  } catch { return normalizeDiscoverSettings(null, profile, detected) }
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

// ponytail: a preferred location matches on its first comma part ("Berlin, Germany" → Berlin) as a word; a geocoder would be exact.
// Locations set: only those places. None: anywhere in the country. Remote roles count when open to the country: its
// name or area, or no place at all — in the location *and* the title ("Remote SRE — UK" is not open to Australia).
function placeOk(p, { locations, remote, country }) {
  const listed = locations.some(l => hasWord(p.location, l.split(',')[0].trim()))
  const here = locations.length ? listed : country ? mentionsCountry(p.location, country) : true
  const openTo = where => !country || mentionsCountry(where, country) || inArea(where, country) || !namesPlace(where)
  const away = p.remote === true && (listed || openTo(p.location)) && openTo(p.title)
  if (remote === 'remote') return away
  if (remote === 'onsite') return p.remote !== true && here
  if (remote === 'hybrid') return here
  return away || here
}

const fresh = (p, now, days) => !p.postedAt || +now - Date.parse(p.postedAt) <= days * 864e5

// ---- scan

function tasksFor(companies, s) {
  const tasks = normalizeCompanies(companies).filter(c => (s.boards ?? ATS).includes(c.source)).map(c => ({ source: c.source, board: c.board, company: c }))
  const { remotive, arbeitnow, jobicy } = s.feeds
  if (remotive.enabled) tasks.push({ source: 'remotive', board: 'remotive', url: SOURCES.remotive.listUrl(remotive.query || s.roles[0] || '') })
  if (arbeitnow.enabled) tasks.push({ source: 'arbeitnow', board: 'arbeitnow', url: SOURCES.arbeitnow.listUrl(1) })
  if (jobicy.enabled) tasks.push({ source: 'jobicy', board: 'jobicy', url: SOURCES.jobicy.listUrl(regionOf(s.country)?.feeds?.jobicy ?? '') })
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
  const net = { fetch, signal, timeoutMs }
  const pages = await pool(tasks, CONCURRENCY, async t => {
    let postings = []
    try {
      postings = t.company ? await fetchPostings(t.company, { ...net, country: s.country })
        : parsePostings(t.source, await getJson(t.url, net))
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
  const found = pages.flat().filter(p => {
    const key = `${norm(p.company)}|${norm(p.title)}|${norm(p.location)}`
    if (seen.has(p.id) || seen.has(key)) return false
    seen.add(p.id).add(key)
    return ![p.id, p.url, p.applyUrl].some(k => k && hidden.has(k)) &&
      roleOk(p.title, s.roles) && placeOk(p, s) && fresh(p, now, s.maxAgeDays)
  })
  // SmartRecruiters lists carry no description: one detail request per posting that passed the filters; a failure keeps it text-less
  const candidates = await pool(found, CONCURRENCY, p => p.source === 'smartrecruiters' && !p.text
    ? fetchDetails(p, net).catch(() => p) : p, signal)
  signal?.throwIfAborted()

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
