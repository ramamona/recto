// Job-search insights over tracker jobs (suite spec 6): funnel, rates, rejections, reposts, calibration, skill gaps,
// adjacent titles, follow-up cadence, reply classification, salary gap, compare. Pure; `now` is injectable.
import { parseJob } from './parse.js'

const DAY = 864e5
const APPLIED = ['applied', 'interview', 'offer', 'rejected', 'no-response']
const BANDS = ['<3', '3-3.9', '4-4.4', '4.5+']
const BOARD_SOURCES = ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable']
const ATS_HOSTS = [
  ['greenhouse.io', 'greenhouse'], ['lever.co', 'lever'], ['ashbyhq.com', 'ashby'], ['smartrecruiters.com', 'smartrecruiters'],
  ['workable.com', 'workable'], ['myworkdayjobs.com', 'workday'], ['bamboohr.com', 'bamboohr'], ['recruitee.com', 'recruitee'],
  ['jobvite.com', 'jobvite'], ['icims.com', 'icims'], ['teamtailor.com', 'teamtailor'], ['pageuppeople.com', 'pageup'],
  ['livehire.com', 'livehire'], ['jobadder.com', 'jobadder'], ['successfactors.com', 'successfactors']
]

const str = v => typeof v === 'string' ? v : ''
const arr = v => Array.isArray(v) ? v : []
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d
const ratio = (a, b) => b ? round(a / b) : 0
const day = ms => new Date(ms).toISOString().slice(0, 10)
const norm = s => str(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const byKey = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0
const byCount = (a, b) => b.count - a.count || byKey(a, b)

// Later evaluations override earlier ones field by field (a quick score record keeps the older full rows/role)
const evalOf = job => Object.assign({}, ...arr(job?.evaluations).filter(e => e && typeof e === 'object'))
const statusesOf = job => new Set([job?.status, ...arr(job?.statusHistory).map(e => e?.status)])
const reached = (job, ...s) => s.some(x => statusesOf(job).has(x))
const isApplied = job => reached(job, ...APPLIED)
const isResponded = job => reached(job, 'interview', 'offer') || (job?.status === 'rejected' && !!str(job.outcome?.stage))
const scoreOf = job => { const s = Number(evalOf(job).score); return Number.isFinite(s) ? s : undefined }

export function bandOf(score) {
  if (!Number.isFinite(score)) return 'unscored'
  return score < 3 ? '<3' : score < 4 ? '3-3.9' : score < 4.5 ? '4-4.4' : '4.5+'
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, '') } catch { return '' }
}

/** ATS behind a job: the board source itself, else a known ATS host of its apply/posting URL, else that host. */
export function atsOf(job) {
  if (BOARD_SOURCES.includes(job?.source)) return job.source
  const host = hostOf(job?.applyUrl) || hostOf(job?.url)
  if (!host) return 'unknown'
  return ATS_HOSTS.find(([h]) => host === h || host.endsWith('.' + h))?.[1] ?? host
}

const KEYS = {
  source: j => str(j.source) || 'unknown',
  ats: atsOf,
  band: j => bandOf(scoreOf(j)),
  remote: j => str(evalOf(j).role?.remote) || 'unknown',
  archetype: j => str(evalOf(j).role?.archetype) || 'other'
}

/** `[{ stage, count, rate }]` for saved → applied → responded → interview → offer; rate is conversion from the previous stage. */
export function funnel(jobs) {
  const list = arr(jobs)
  const counts = [
    ['saved', list.length],
    ['applied', list.filter(isApplied).length],
    ['responded', list.filter(isResponded).length],
    ['interview', list.filter(j => reached(j, 'interview', 'offer')).length],
    ['offer', list.filter(j => reached(j, 'offer')).length]
  ]
  return counts.map(([stage, count], i) => ({ stage, count, rate: i ? ratio(count, counts[i - 1][1]) : list.length ? 1 : 0 }))
}

/** Response rate of applied jobs grouped `by` source | ats | band | remote | archetype, most applied first. */
export function rates(jobs, by) {
  const keyOf = KEYS[by] ?? KEYS.source
  const groups = new Map()
  for (const j of arr(jobs).filter(isApplied)) {
    const key = keyOf(j)
    const g = groups.get(key) ?? { key, applied: 0, responded: 0, interviews: 0, offers: 0 }
    g.applied++
    if (isResponded(j)) g.responded++
    if (reached(j, 'interview', 'offer')) g.interviews++
    if (reached(j, 'offer')) g.offers++
    groups.set(key, g)
  }
  return [...groups.values()].map(g => ({ ...g, rate: ratio(g.responded, g.applied) }))
    .sort((a, b) => b.applied - a.applied || b.rate - a.rate || byKey(a, b))
}

const tally = (values, name) => {
  const m = new Map()
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1)
  return [...m].map(([key, count]) => ({ key, count })).sort(byCount).map(({ key, count }) => ({ [name]: key, count }))
}

/** Rejected jobs: `{ total, stages: [{ stage, count }], reasons: [{ reason, count }] }` (stage '' is 'unknown'). */
export function rejections(jobs) {
  const rejected = arr(jobs).filter(j => j?.status === 'rejected')
  return {
    total: rejected.length,
    stages: tally(rejected.map(j => str(j.outcome?.stage) || 'unknown'), 'stage'),
    reasons: tally(rejected.map(j => str(j.outcome?.reason).trim().toLowerCase()).filter(Boolean), 'reason')
  }
}

/** Repost / ghost suspects: same company + normalised title under several ids, or a posting date newer than first seen. */
export function reposts(jobs) {
  const groups = new Map()
  for (const j of arr(jobs).filter(j => j && str(j.title) && str(j.company))) {
    const key = norm(j.company) + '|' + norm(j.title)
    groups.set(key, [...groups.get(key) ?? [], j])
  }
  const out = []
  for (const g of groups.values()) {
    const refreshed = g.length === 1 && Date.parse(g[0].postedAt) > Date.parse(g[0].createdAt) + DAY
    if (g.length < 2 && !refreshed) continue
    out.push({ company: g[0].company, title: g[0].title, ids: g.map(j => j.id), dates: g.map(j => str(j.postedAt)), reason: refreshed ? 'refreshed' : 'duplicate' })
  }
  return out
}

/** Score band → share of applied jobs that reached interview. */
export function calibration(jobs) {
  const applied = arr(jobs).filter(isApplied)
  return BANDS.map(band => {
    const inBand = applied.filter(j => bandOf(scoreOf(j)) === band)
    const interviews = inBand.filter(j => reached(j, 'interview', 'offer')).length
    return { band, applied: inBand.length, interviews, rate: ratio(interviews, inBand.length) }
  })
}

/** Keywords of missing requirements across evaluations, counted once per job, most frequent first. */
export function skillGaps(jobs, limit = 20) {
  const perJob = arr(jobs).flatMap(j => [...new Set(arr(evalOf(j).rows).filter(r => r?.match === 'missing')
    .flatMap(r => arr(r.keywords)).filter(k => typeof k === 'string' && k.trim()).map(k => k.trim().toLowerCase()))])
  return tally(perJob, 'skill').slice(0, limit)
}

const ADJACENT = {
  frontend: ['UI Engineer', 'Full-stack Engineer', 'Design Engineer', 'Web Developer'],
  backend: ['Platform Engineer', 'API Engineer', 'Full-stack Engineer', 'Data Engineer'],
  'full-stack': ['Frontend Engineer', 'Backend Engineer', 'Product Engineer'],
  mobile: ['iOS Engineer', 'Android Engineer', 'React Native Developer', 'Frontend Engineer'],
  devops: ['Site Reliability Engineer', 'Platform Engineer', 'Cloud Engineer', 'Infrastructure Engineer'],
  qa: ['Test Automation Engineer', 'Software Engineer in Test', 'Quality Engineer'],
  engineering: ['Software Engineer', 'Solutions Engineer', 'Technical Lead', 'Platform Engineer'],
  data: ['Data Analyst', 'Analytics Engineer', 'Data Engineer', 'Business Intelligence Analyst'],
  product: ['Product Owner', 'Business Analyst', 'Technical Product Manager', 'Program Manager'],
  design: ['UX Designer', 'Product Designer', 'UX Researcher', 'Design Engineer'],
  marketing: ['Growth Marketer', 'Content Strategist', 'Digital Marketing Specialist', 'Brand Manager'],
  sales: ['Account Manager', 'Customer Success Manager', 'Business Development Manager', 'Solutions Consultant'],
  operations: ['Project Coordinator', 'Business Operations Analyst', 'Program Coordinator', 'Office Manager'],
  research: ['Research Scientist', 'Data Scientist', 'UX Researcher', 'Research Engineer']
}
const ALIASES = { 'front end': 'frontend', 'back end': 'backend', 'full stack': 'full-stack', fullstack: 'full-stack', ios: 'mobile', android: 'mobile', sre: 'devops', 'software engineer': 'engineering', developer: 'engineering', analyst: 'data', designer: 'design', ux: 'design' }

/** Titles next to the given archetypes / target roles (static map; the AI 'titles' mode goes further). */
export function adjacentTitles(archetypes = []) {
  const inputs = arr(archetypes).map(a => ` ${norm(a)} `)
  const has = (hay, k) => hay.includes(` ${norm(k)} `)
  const keys = new Set(inputs.flatMap(hay => [
    ...Object.keys(ADJACENT).filter(k => has(hay, k) || has(hay, k.replace('-', ''))),
    ...Object.entries(ALIASES).filter(([a]) => has(hay, a)).map(([, k]) => k)
  ]))
  const own = new Set(inputs.map(s => s.trim()))
  return [...new Set([...keys].flatMap(k => ADJACENT[k]))].filter(t => !own.has(norm(t)))
}

const statusAt = (job, status) => arr(job.statusHistory).filter(e => e?.status === status).at(-1)?.at

/** Follow-up plan: applied → follow-up +7 d and +14 d; interview → thank-you +1 d per interview, check-in +7 d after the last.
 * Stored `followUps` supply done flags and extra (user-added) items. Due dates are YYYY-MM-DD. */
export function cadence(job) {
  if (!job || typeof job !== 'object') return []
  const plan = []
  const add = (ms, days, kind) => Number.isFinite(ms) && plan.push({ due: day(ms + days * DAY), kind })
  if (job.status === 'applied') {
    const at = Date.parse(statusAt(job, 'applied') ?? job.updatedAt)
    add(at, 7, 'follow-up')
    add(at, 14, 'follow-up')
  } else if (job.status === 'interview') {
    const dates = arr(job.interviews).map(i => Date.parse(i?.at)).filter(Number.isFinite).sort((a, b) => a - b)
    for (const at of dates) add(at, 1, 'thank-you')
    add(dates.at(-1) ?? Date.parse(statusAt(job, 'interview') ?? job.updatedAt), 7, 'check-in')
  }
  const stored = arr(job.followUps).filter(f => f && str(f.due) && str(f.kind))
  const same = (a, b) => a.due === b.due && a.kind === b.kind
  const items = [
    ...plan.map(p => ({ ...p, done: stored.some(s => same(s, p) && s.done === true) })),
    ...stored.filter(s => !plan.some(p => same(s, p))).map(({ due, kind, done }) => ({ due, kind, done: done === true }))
  ]
  return items.sort((a, b) => a.due < b.due ? -1 : a.due > b.due ? 1 : 0)
}

/** Cadence items due on or before `now` and not done; a closed job (rejected, no-response, skipped) has none. */
export function followUpsDue(job, now = new Date()) {
  if (['rejected', 'no-response', 'skipped'].includes(job?.status)) return []
  return cadence(job).filter(f => !f.done && Date.parse(f.due) <= +now)
}

// Reply signals per kind; on a tie the earlier kind wins
const REPLY = [
  ['offer', 'offer', [/\bpleased to offer\b/i, /\boffer letter\b/i, /\b(?:happy|delighted|excited|thrilled) to (?:offer|extend)\b/i, /\bextend(?:ing)? (?:you )?an offer\b/i, /\boffer of employment\b/i, /\bcongratulations\b/i]],
  ['rejection', 'rejected', [/\bunfortunately\b/i, /\bnot (?:be )?(?:moving|proceeding|progressing|going) (?:forward|further|ahead)\b/i, /\bother candidates\b/i, /\bregret to (?:inform|advise)\b/i, /\bnot (?:been )?(?:selected|successful|shortlisted)\b/i, /\bunsuccessful\b/i, /\b(?:position|role) has (?:now )?been filled\b/i, /\bdecided not to (?:proceed|progress|move forward)\b/i, /\bkeep your (?:details|cv|resume|profile) on file\b/i]],
  ['interview', 'interview', [/\bschedule (?:a|an|the)?\s*(?:call|interview|chat|meeting|time)\b/i, /\binvite you (?:to|for) (?:a|an)?\s*(?:interview|call|chat|conversation)\b/i, /\b(?:phone|video|technical|first|second|final)[- ](?:screen|interview|round)\b/i, /\byour availability\b/i, /\bbook a time\b|\bcalendly\b/i, /\blike to (?:meet|chat|talk|speak) (?:with )?you\b/i]],
  ['info-request', '', [/\bcould you (?:please )?(?:send|provide|share|confirm|let us know)\b/i, /\bcan you (?:please )?(?:send|provide|share|confirm)\b/i, /\bplease (?:send|provide|share|complete|fill|confirm)\b/i, /\b(?:additional|more|further) (?:information|details)\b/i]],
  ['auto-ack', 'applied', [/\b(?:have |'ve )?received your application\b/i, /\bthank you for (?:applying|your application|your interest)\b/i, /\bapplication (?:has been )?(?:received|submitted)\b/i, /\bautomated (?:message|email|response)\b|\bdo not reply\b|\bno-?reply\b/i]]
]

const sentences = text => text.split(/\n+/).flatMap(l => l.match(/[^.!?]+[.!?]*/g) ?? []).map(s => s.trim()).filter(Boolean)

/** `{ kind: offer|rejection|interview|info-request|auto-ack|other, status, confidence 0–1, quote }` by regex signals.
 * Confidence grows with the winning kind's signals and drops with competing ones; below 0.5 the UI may ask the AI. */
export function classifyReply(text) {
  const t = str(text)
  const hits = REPLY.map(([kind, status, res]) => ({ kind, status, res: res.filter(re => re.test(t)) }))
  const total = hits.reduce((n, h) => n + h.res.length, 0)
  const best = hits.reduce((a, b) => b.res.length > a.res.length ? b : a)
  if (!best.res.length) return { kind: 'other', status: '', confidence: 0, quote: '' }
  const quote = sentences(t).find(s => best.res.some(re => re.test(s))) ?? ''
  return { kind: best.kind, status: best.status, confidence: round(best.res.length / (total + 1)), quote: quote.slice(0, 300) }
}

// "A$150,000 + super", "150k", 150000 → 150000; anything else (or negative) → null
// ponytail: first number only, so "130-150k" reads 130; a range parser if profiles hold ranges
function money(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null
  const m = str(v).replace(/[,\s]/g, '').match(/^[^\d-]*(\d+(?:\.\d+)?)(k)?/i)
  return m ? Number(m[1]) * (m[2] ? 1000 : 1) : null
}
const gap = (to, from) => to == null || from == null ? null : { diff: to - from, pct: from ? round((to - from) / from * 100, 1) : null }

/** Salary gaps in absolute terms and % of the second value; missing values give null. */
export function salaryGap({ desired, advertised, offered } = {}) {
  const d = money(desired), a = money(advertised), o = money(offered)
  return { desired: d, advertised: a, offered: o, offeredVsDesired: gap(o, d), offeredVsAdvertised: gap(o, a), advertisedVsDesired: gap(a, d) }
}

/** One row per job for side-by-side comparison, from its latest evaluation. */
export function compare(jobs) {
  return arr(jobs).filter(j => j && typeof j === 'object').map(j => {
    const ev = evalOf(j)
    const score = Number(ev.score), match = Number(typeof ev.match === 'object' ? ev.match?.score : ev.match)
    return {
      id: str(j.id), title: str(j.title), company: str(j.company), location: str(j.location),
      remote: str(ev.role?.remote) || 'unknown',
      score: ev.score != null && Number.isFinite(score) ? score : null,
      match: ev.match != null && Number.isFinite(match) ? match : null,
      recommendation: str(ev.recommendation), caps: arr(ev.caps).filter(c => typeof c === 'string'),
      legitimacy: str(ev.legitimacy?.level), salary: str(j.text) ? parseJob(j.text).salary?.text ?? '' : '',
      gaps: arr(ev.rows).filter(r => r?.match === 'missing' || r?.match === 'partial').map(r => str(r.requirement)).filter(Boolean).slice(0, 3)
    }
  })
}
