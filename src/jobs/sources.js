// Job sources (discover-apply spec 2): ATS board and remote-feed adapters → normalized Postings, plus the
// company list store (career-suite spec §2 adds SmartRecruiters, Workable, Jobicy and findBoards). Pure; network only
// through the injected fetch.
import { extractHtml } from '../io/extract.js'
import { regionOf } from './region.js'

export const ATS = ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable']
export const TIMEOUT_MS = 10000
const SR_PAGE = 100
const SR_MAX = 300
export const COMPANIES_KEY = 'recto:companies'
const FORMAT = 'recto-companies'

const str = v => typeof v === 'string' ? v : ''
const isObj = v => v && typeof v === 'object' && !Array.isArray(v)
const items = v => Array.isArray(v) ? v.filter(isObj) : []
const enc = encodeURIComponent
const htmlText = html => extractHtml(str(html)).text
const safeUrl = v => /^https?:\/\//i.test(str(v)) ? v : ''

// Numbers are epoch ms; strings without a zone are UTC (Remotive)
function iso(v) {
  const s = typeof v === 'string' && /T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(v) ? `${v}Z` : v
  const d = typeof s === 'number' || (typeof s === 'string' && s) ? new Date(s) : null
  return d && !isNaN(d) ? d.toISOString() : ''
}

// Workplace type when the source states it, else "remote" in the location, else unknown
function remoteFrom(kind, location) {
  const k = str(kind).toLowerCase().replace(/[^a-z]/g, '')
  if (k === 'remote') return true
  if (['hybrid', 'onsite', 'inoffice', 'office'].includes(k)) return false
  return /\bremote\b/i.test(str(location)) ? true : null
}

function posting(source, board, jobId, f) {
  const title = str(f.title).trim()
  if (jobId == null || jobId === '' || !title) return []
  const p = {
    id: `${source}:${board}:${jobId}`, source, board,
    company: str(f.company).trim(), title, location: str(f.location).trim(), remote: f.remote ?? null,
    url: safeUrl(f.url), applyUrl: safeUrl(f.applyUrl) || safeUrl(f.url), postedAt: iso(f.postedAt), text: str(f.text)
  }
  const salary = str(f.salary).trim()
  if (salary) p.salary = salary
  return [p]
}

const workplaceMeta = j => items(j.metadata).find(m => /workplace/i.test(str(m.name)))?.value
// Non-empty location parts, repeats dropped ("New York, New York, United States" → "New York, United States")
const place = (...parts) => [...new Set(parts.map(p => str(p).trim()).filter(Boolean))].join(', ')

export const SOURCES = {
  greenhouse: {
    listUrl: board => `https://boards-api.greenhouse.io/v1/boards/${enc(board)}/jobs?content=true`,
    detailUrl: (board, id) => `https://boards-api.greenhouse.io/v1/boards/${enc(board)}/jobs/${enc(id)}?questions=true`,
    parse: (data, { board, name }) => items(data?.jobs).flatMap(j => {
      const content = str(j.content)
      const location = str(j.location?.name)
      return posting('greenhouse', board, j.id, {
        title: j.title, company: j.company_name || name, location, remote: remoteFrom(workplaceMeta(j), location),
        url: j.absolute_url, applyUrl: `https://job-boards.greenhouse.io/${enc(board)}/jobs/${enc(j.id)}`,
        postedAt: j.first_published || j.updated_at,
        // The API returns the description HTML entity-escaped
        text: htmlText(/&lt;/.test(content) ? htmlText(content) : content)
      })
    })
  },
  lever: {
    listUrl: site => `https://api.lever.co/v0/postings/${enc(site)}?mode=json`,
    parse: (data, { board, name }) => items(data).flatMap(j => {
      const location = str(j.categories?.location)
      const pay = isObj(j.salaryRange) && j.salaryRange
      return posting('lever', board, j.id, {
        title: j.text, company: name, location, remote: remoteFrom(j.workplaceType, location),
        url: j.hostedUrl, applyUrl: j.applyUrl, postedAt: j.createdAt,
        text: [j.descriptionPlain, ...items(j.lists).map(l => `${str(l.text)}\n${htmlText(l.content)}`), j.additionalPlain]
          .filter(s => typeof s === 'string' && s.trim()).join('\n\n'),
        salary: pay ? `${pay.min ?? ''}–${pay.max ?? ''} ${str(pay.currency)} ${str(pay.interval).replace(/-salary$/, '').replace(/-/g, ' ')}` : ''
      })
    })
  },
  ashby: {
    listUrl: board => `https://api.ashbyhq.com/posting-api/job-board/${enc(board)}?includeCompensation=true`,
    parse: (data, { board, name }) => items(data?.jobs).filter(j => j.isListed !== false).flatMap(j => {
      const kind = j.workplaceType ?? (j.isRemote === true ? 'remote' : j.isRemote === false ? 'onsite' : '')
      const pay = j.compensation
      return posting('ashby', board, j.id, {
        title: j.title, company: name, location: j.location, remote: remoteFrom(kind, j.location),
        url: j.jobUrl, applyUrl: j.applyUrl, postedAt: j.publishedAt,
        text: str(j.descriptionPlain) || htmlText(j.descriptionHtml),
        salary: str(pay?.scrapeableCompensationSalarySummary) || str(pay?.compensationTierSummary)
      })
    })
  },
  smartrecruiters: {
    listUrl: (id, { offset = 0, country = '' } = {}) =>
      `https://api.smartrecruiters.com/v1/companies/${enc(id)}/postings?limit=${SR_PAGE}&offset=${offset}${country ? `&country=${enc(country)}` : ''}`,
    detailUrl: (id, postingId) => `https://api.smartrecruiters.com/v1/companies/${enc(id)}/postings/${enc(postingId)}`,
    // The list has no description: fetchDetails adds `text` from the job ad
    parse: (data, { board, name }) => items(data?.content).flatMap(j => {
      const l = isObj(j.location) ? j.location : {}
      return posting('smartrecruiters', board, j.id, {
        title: j.name, company: name || j.company?.name, remote: typeof l.remote === 'boolean' ? l.remote : null,
        location: place(...str(l.fullLocation).split(',')) || place(l.city, l.region, l.country),
        url: `https://jobs.smartrecruiters.com/${enc(board)}/${enc(j.id)}`, postedAt: j.releasedDate
      })
    })
  },
  workable: {
    listUrl: sub => `https://apply.workable.com/api/v1/widget/accounts/${enc(sub)}?details=true`,
    parse: (data, { board, name }) => items(data?.jobs).flatMap(j => {
      const location = place(j.city, j.state, j.country)
      return posting('workable', board, j.shortcode, {
        title: j.title, company: name || data.name, location, remote: j.telecommuting === true ? true : remoteFrom('', location),
        url: j.url, applyUrl: j.application_url, postedAt: j.published_on, text: htmlText(j.description)
      })
    })
  },
  // Terms: show "via Remotive" / "via Jobicy" and link back to the posting (the UI does, keyed on source)
  remotive: {
    listUrl: query => `https://remotive.com/api/remote-jobs?search=${enc(str(query))}&limit=100`,
    parse: data => items(data?.jobs).flatMap(j => posting('remotive', 'remotive', j.id, {
      title: j.title, company: j.company_name, location: j.candidate_required_location, remote: true,
      url: j.url, postedAt: j.publication_date, text: htmlText(j.description), salary: j.salary
    }))
  },
  arbeitnow: {
    listUrl: (page = 1) => `https://www.arbeitnow.com/api/job-board-api?page=${page}`,
    parse: data => items(data?.data).flatMap(j => posting('arbeitnow', 'arbeitnow', j.slug, {
      title: j.title, company: j.company_name, location: j.location,
      remote: typeof j.remote === 'boolean' ? j.remote : remoteFrom('', j.location),
      url: j.url, postedAt: Number.isFinite(j.created_at) ? j.created_at * 1000 : null, text: htmlText(j.description)
    }))
  },
  // SEEK's own site search: undocumented and outside SEEK's terms for automated use, so it is opt-in (off by default).
  // `site` from the country preset (www.seek.com.au, www.seek.co.nz); 20 results a page. Applying stays on SEEK.
  seek: {
    listUrl: ({ site, keywords = '', where = '', page = 1 }) =>
      `https://${site}/api/jobsearch/v5/search?keywords=${enc(keywords)}&where=${enc(where)}&page=${page}`,
    parse: (data, { board }) => items(data?.data).flatMap(j => posting('seek', 'seek', j.id, {
      title: j.title, company: j.companyName || j.advertiser?.description,
      location: place(items(j.locations)[0]?.label, regionOf(items(j.locations)[0]?.countryCode)?.name),
      remote: remoteFrom(j.workArrangements?.displayText ?? '', ''),
      url: /^www\.seek\.co(m\.au|\.nz)$/.test(board) ? `https://${board}/job/${enc(j.id)}` : '',
      postedAt: j.listingDate, text: [j.teaser, ...(Array.isArray(j.bulletPoints) ? j.bulletPoints : [])].map(str).filter(Boolean).join('\n'),
      salary: j.salaryLabel
    }))
  },
  // Adzuna's official search API (free key from developer.adzuna.com); `country` from the preset (au, gb, us, …)
  adzuna: {
    listUrl: ({ country, appId, appKey, what = '', where = '', page = 1 }) =>
      `https://api.adzuna.com/v1/api/jobs/${enc(country)}/search/${page}?app_id=${enc(appId)}&app_key=${enc(appKey)}` +
      `&results_per_page=50&max_days_old=30&what=${enc(what)}&where=${enc(where)}&content-type=application/json`,
    parse: data => items(data?.results).flatMap(j => posting('adzuna', 'adzuna', j.id, {
      title: htmlText(j.title), company: j.company?.display_name, location: j.location?.display_name,
      remote: remoteFrom('', `${str(j.title)} ${str(j.location?.display_name)}`),
      url: j.redirect_url, postedAt: j.created, text: htmlText(j.description),
      salary: j.salary_min ? `${Math.round(j.salary_min)}${j.salary_max && j.salary_max !== j.salary_min ? `–${Math.round(j.salary_max)}` : ''}` : ''
    }))
  },
  jobicy: {
    listUrl: geo => `https://jobicy.com/api/v2/remote-jobs?count=50${str(geo) ? `&geo=${enc(geo)}` : ''}`,
    parse: data => items(data?.jobs).flatMap(j => posting('jobicy', 'jobicy', j.id, {
      title: j.jobTitle, company: j.companyName, location: place(...str(j.jobGeo).split(',')), remote: true,
      url: j.url, postedAt: j.pubDate, text: htmlText(j.jobDescription),
      salary: j.salaryMin || j.salaryMax ? `${j.salaryMin ?? ''}–${j.salaryMax ?? ''} ${str(j.salaryCurrency)} ${str(j.salaryPeriod)}`.trim() : ''
    }))
  }
}

/** `data` (a source's JSON response) → Posting[]; `company` = `{ board, name }` for ATS boards. Never throws. */
export function parsePostings(source, data, company = {}) {
  if (!Object.hasOwn(SOURCES, source)) return []
  try {
    return SOURCES[source].parse(data, { board: str(company.board), name: str(company.name) })
  } catch {
    return []
  }
}

/** Greenhouse job detail (`?questions=true`) → `{ label, name, type, required, options? }[]`, hidden fields dropped. */
export function parseQuestions(detail) {
  return [...items(detail?.questions), ...items(detail?.location_questions)].flatMap(q => items(q.fields)
    .filter(f => str(f.name) && str(f.type) && f.type !== 'input_hidden')
    .map(f => {
      const out = { label: str(q.label).trim(), name: f.name, type: f.type, required: q.required === true }
      const options = items(f.values).map(v => str(v.label)).filter(Boolean)
      if (options.length) out.options = options
      return out
    }))
}

/** GET JSON with a per-request timeout (rejects `Error('timeout')`) that also honours the caller's `signal`. */
export async function getJson(url, { fetch = globalThis.fetch, signal, timeoutMs = TIMEOUT_MS } = {}) {
  const ctrl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; ctrl.abort() }, timeoutMs)
  const forward = () => ctrl.abort(signal.reason)
  if (signal?.aborted) forward()
  signal?.addEventListener('abort', forward, { once: true })
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } catch (err) {
    if (timedOut && !signal?.aborted) throw new Error('timeout')
    throw err
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forward)
  }
}

const jobIdOf = p => p.id.slice(`${p.source}:${p.board}:`.length)

/** Adds `questions` to a Greenhouse posting and `text` to a SmartRecruiters one (one detail request); others as is. */
export async function fetchDetails(p, { fetch, signal, timeoutMs } = {}) {
  if (p?.source === 'smartrecruiters') {
    const ad = await getJson(SOURCES.smartrecruiters.detailUrl(p.board, jobIdOf(p)), { fetch, signal, timeoutMs })
    const sections = isObj(ad?.jobAd?.sections) ? Object.values(ad.jobAd.sections) : []
    return { ...p, text: sections.map(s => htmlText(s?.text).trim()).filter(Boolean).join('\n\n') }
  }
  if (p?.source !== 'greenhouse') return p
  const detail = await getJson(SOURCES.greenhouse.detailUrl(p.board, jobIdOf(p)), { fetch, signal, timeoutMs })
  return { ...p, questions: parseQuestions(detail) }
}

/** A company board's Postings. SmartRecruiters pages until `totalFound` (max 300), filtered to `country` when it has a preset. */
export async function fetchPostings(company, { country, ...opts } = {}) {
  const { source, board } = company
  if (source !== 'smartrecruiters') return parsePostings(source, await getJson(SOURCES[source].listUrl(board), opts), company)
  const code = regionOf(country)?.feeds?.smartrecruiters ?? ''
  const out = []
  for (let offset = 0; offset < SR_MAX; offset += SR_PAGE) {
    const data = await getJson(SOURCES.smartrecruiters.listUrl(board, { offset, country: code }), opts)
    out.push(...parsePostings(source, data, company))
    if (offset + SR_PAGE >= Math.min(Number(data?.totalFound) || 0, SR_MAX)) break
  }
  return out
}

// ---- board finder ("career-ops discover")

/** Board slugs for a company name: 'Culture Amp' → cultureamp, culture-amp, culture_amp (and 'harrison.ai' as written). */
export function slugVariants(name) {
  const words = str(name).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const raw = str(name).trim().toLowerCase().replace(/\s+/g, '-')
  return [...new Set([words.join(''), words.join('-'), words.join('_'), raw].filter(Boolean))]
}

// SmartRecruiters ids are case-insensitive, so CamelCase ('CultureAmp') replaces the plain compact slug
function srVariants(name) {
  const camel = str(name).split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join('')
  const seen = new Set()
  return [camel, ...slugVariants(name)].filter(v => v && !seen.has(v.toLowerCase()) && seen.add(v.toLowerCase()))
}

/** `[{ source, board, name, jobs }]` for every slug variant of `name` whose board has jobs, probed in parallel. Never throws. */
export async function findBoards(name, { fetch = globalThis.fetch, signal, timeoutMs = TIMEOUT_MS } = {}) {
  const label = str(name).trim()
  if (!label || signal?.aborted) return []
  const probes = ATS.flatMap(source => (source === 'smartrecruiters' ? srVariants(label) : slugVariants(label)).map(board => ({ source, board })))
  const found = await Promise.all(probes.map(async ({ source, board }) => {
    try {
      const data = await getJson(SOURCES[source].listUrl(board), { fetch, signal, timeoutMs })
      const jobs = Number.isFinite(data?.totalFound) ? data.totalFound : parsePostings(source, data, { board, name: label }).length
      return jobs > 0 ? [{ source, board, name: label, jobs }] : []
    } catch {
      return []
    }
  }))
  return signal?.aborted ? [] : found.flat()
}

// ---- companies store

function defaultStorage() {
  try { if (globalThis.localStorage) return globalThis.localStorage } catch {}
  return null
}

/** `{ source, board, name }[]`: ATS sources only, board required, first of each source+board (case-insensitive) kept. */
export function normalizeCompanies(list) {
  if (!Array.isArray(list)) return []
  const seen = new Set()
  return list.flatMap(c => {
    const board = str(c?.board).trim()
    if (!isObj(c) || !ATS.includes(c.source) || !board) return []
    const key = `${c.source}:${board.toLowerCase()}`
    if (seen.has(key)) return []
    seen.add(key)
    return [{ source: c.source, board, name: str(c.name).trim() || board }]
  })
}

/** The saved list, or `starter` (data/companies.json, fetched by the caller) until one is saved. */
export function loadCompanies(storage = defaultStorage(), starter = []) {
  try {
    const raw = storage?.getItem(COMPANIES_KEY)
    const data = raw == null ? null : JSON.parse(raw)
    if (Array.isArray(data)) return normalizeCompanies(data)
  } catch {}
  return normalizeCompanies(starter)
}

export function saveCompanies(list, storage = defaultStorage()) {
  const out = normalizeCompanies(list)
  try { storage?.setItem(COMPANIES_KEY, JSON.stringify(out)) } catch {}
  return out
}

export const exportCompanies = list => JSON.stringify({ format: FORMAT, version: 1, companies: normalizeCompanies(list) }, null, 2)

/** JSON string, array or `{ companies }` → `{ companies, warnings: [{ code, index? }] }`; the caller merges. */
export function importCompanies(json) {
  let data
  try { data = typeof json === 'string' ? JSON.parse(json) : json } catch { return { companies: [], warnings: [{ code: 'invalid-json' }] } }
  const list = Array.isArray(data) ? data : Array.isArray(data?.companies) ? data.companies : null
  if (!list) return { companies: [], warnings: [{ code: 'invalid-json' }] }
  const warnings = list.flatMap((c, index) => normalizeCompanies([c]).length ? [] : [{ code: 'invalid-company', index }])
  return { companies: normalizeCompanies(list), warnings }
}
