// Career-ops style job evaluation (review-jobs spec 3): role summary, gates, two-pass requirement table,
// 1–5 score, legitimacy. Pure, local, never throws.
import { parseJob, canonicalTokens, keywordsIn } from './parse.js'
import { matchCv } from './match.js'
import { checkLegitimacy } from './legitimacy.js'
import { hasWorkAuth } from '../profile.js'

export const IMPORTANCE = ['critical', 'high', 'meaningful']
export const MATCHES = ['strong', 'partial', 'missing', 'na']
export const ARCHETYPES = ['engineering', 'data', 'product', 'design', 'marketing', 'sales', 'operations', 'research', 'other']
export const SENIORITY = ['intern', 'junior', 'mid', 'senior', 'staff', 'principal', 'lead', 'manager', 'director', 'executive']
export const REMOTE_KINDS = ['full', 'hybrid', 'onsite', 'unknown']
export const ROW_BUDGET = 12

const IMPORTANCE_WEIGHT = { critical: 3, high: 2, meaningful: 1 }
const MATCH_CREDIT = { strong: 1, partial: 0.5, missing: 0 }
const UNMET_ORDER = { missing: 0, partial: 1, strong: 2, na: 3 }

// Order matters: first hit wins ("Product Designer" is design, "Data Engineer" is data)
const ARCHETYPE_RE = [
  ['research', /\bresearch/],
  ['data', /\bdata\b|\banalyst|\banalytics|\bmachine learning\b|\bml\b|\bscientist/],
  ['design', /\bdesign|\bux\b|\bui\b/],
  ['product', /\bproduct\b/],
  ['engineering', /\bengineer|\bdeveloper|\bprogrammer|\bsre\b|\bdevops|\bsoftware|\barchitect|\bfront[- ]?end|\bback[- ]?end|\bfull[- ]?stack/],
  ['marketing', /\bmarketing|\bgrowth|\bseo\b|\bcontent|\bbrand/],
  ['sales', /\bsales|\baccount (?:executive|manager)|\bbusiness development|\bsdr\b|\bbdr\b/],
  ['operations', /\boperations|\bops\b|\bsupport|\bcustomer success|\brecruit|\bpeople\b|\bhr\b|\bfinance|\baccountant|\bnurse|\badmin/]
]
const SENIORITY_RE = [
  ['executive', /\b(?:chief|c[etoif]o|vp|vice president|head of|founder)\b/],
  ['director', /\bdirector\b/],
  ['principal', /\bprincipal\b/],
  ['staff', /\bstaff\b/],
  ['lead', /\blead\b|\btech lead\b/],
  ['manager', /\bmanager\b/],
  ['senior', /\bsenior\b|\bsr\.?(?=\s|$)/],
  ['junior', /\bjunior\b|\bjr\.?(?=\s|$)|\bentry[- ]level\b|\bgraduate\b/],
  ['intern', /\bintern(?:ship)?\b/]
]

const CRITICAL_WORDS = /\b(?:must|required|requirement|mandatory|essential|minimum)\b|\b\d+\+?\s*(?:-\s*\d+\s*)?years?\b/i
const RESP_HEAD = /^(?:#+\s*)?(?:(?:key )?responsibilities|what you(?:'|’)?ll do|what you will do|the role|your role|duties|in this role(?: you will)?)\s*:?$/i
const ANY_HEAD = /^(?:#+\s*)?[A-Za-z][\w '’&/-]{1,40}:?$/
const BULLET = /^(?:[-*•·▪◦●]|\d+[.)])\s+(.+)$/

const CLOSED = /\bno longer (?:accepting applications|available|open)\b|\bposition (?:has been|is) filled\b|\bjob (?:has )?(?:closed|expired)\b|\bthis (?:job|position|posting|role) (?:is )?(?:closed|expired)\b/i
const ATTENDANCE = /\bhybrid\b|\b(?:\d+|one|two|three|four|five)\s*(?:days?|x)\s*(?:a|per|each|\/)?\s*week\b[^.\n]*\b(?:office|on[- ]?site|in[- ]person)\b|\bin[- ](?:the[- ])?office\b|\bon[- ]?site\b|\bin[- ]person\b|\brelocat(?:e|ion)\b/i
const NEGATION = /\b(?:no|not|never|without|optional|optionally|occasional(?:ly)?|off-?sites?|retreats?|if you (?:want|prefer|like)|fully remote|100% remote)\b|\bn['’]t\b/i
const NO_SPONSOR = /\b(?:unable|not able|cannot|can ?not|can['’]t|will not|won['’]t|do(?:es)? not|don['’]t|doesn['’]t)\b[^.\n]{0,30}\bsponsor|\bno (?:visa )?sponsorship\b|\bsponsorship (?:is )?not (?:available|offered|provided)\b|\bwithout (?:the need for )?(?:visa |current or future )?sponsorship\b/i
const SPONSORS = /\b(?:visa )?sponsorship (?:is )?(?:available|offered|provided)\b|\bwe (?:will |can |do |happily )?sponsor\b|\bsponsor(?:s|ing)? (?:work )?visas?\b|\bvisa support\b/i
const INJECTION = /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|any|your)\b[^.\n]{0,20}\b(?:instructions?|prompts?|rules|guidelines)\b|\b(?:as an?|if you are an?|note to (?:the )?|attention,?)\s*(?:ai|llm|language model|assistant|chatbot|gpt|screening (?:bot|tool))\b|\b(?:rate|score|rank|mark)\s+(?:this|the|every|all)\s+(?:candidate|applicant|resume|cv)s?\b[^.\n]{0,30}(?:\d+\s*\/\s*\d+|\d+%|highest|top|perfect|strong)|\bsystem prompt\b/i
const COUNTRY_ALIASES = { us: ['us', 'usa', 'united states', 'america'], uk: ['uk', 'gb', 'united kingdom', 'england', 'britain'], gb: ['uk', 'gb', 'united kingdom'], de: ['de', 'germany', 'deutschland'], fr: ['fr', 'france'], ca: ['ca', 'canada'] }

// Words too generic to decide a match on their own
const FILLER = new Set(('year experience experienc work working with the and for our your you are will have has strong excellent good great ' +
  'ability abl able skill knowledge understand understanding build building team teams using use plus a an of in on to or is be as at by ' +
  'must required require preferred ideally bonus nice minimum least other similar related relevant role')
  .split(' '))

const str = v => typeof v === 'string' ? v : ''
const lines = text => str(text).replace(/\r\n?/g, '\n').split('\n').map(l => l.trim())
const firstLine = (text, re, skip = () => false) => lines(text).find(l => l && re.test(l) && !skip(l)) ?? ''
const escape = s => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
const wordRe = w => new RegExp(`(?<![\\p{L}\\p{N}])${escape(w)}(?![\\p{L}\\p{N}])`, 'iu')
const phrase = t => canonicalTokens(t).join(' ')
const hasPhrase = (hay, kw) => { const p = phrase(kw); return p !== '' && hay.includes(` ${p} `) }

// ---- A · role summary

const classify = (text, table, dflt) => table.find(([, re]) => re.test(text))?.[0] ?? dflt

function remoteOf(location, text, geo) {
  if (geo?.mismatch) return 'hybrid'
  const loc = str(location).toLowerCase()
  if (/\bhybrid\b/.test(loc)) return 'hybrid'
  if (/\bremote\b/.test(loc)) return 'full'
  if (/\bon[- ]?site\b|\bin[- ]office\b/.test(loc)) return 'onsite'
  const body = lines(text).filter(l => !NEGATION.test(l)).join('\n')
  if (/\bhybrid\b|\bdays? (?:a|per) week in\b/i.test(body)) return 'hybrid'
  if (/\bfully remote\b|\bremote[- ](?:first|friendly|only)\b|\b100% remote\b/i.test(text)) return 'full'
  if (/\bon[- ]?site\b|\bin[- ]office\b/i.test(body)) return 'onsite'
  return 'unknown'
}

function tldrOf(p, text) {
  const skip = l => l === p.title || l === p.company || l.length < 40 || BULLET.test(l) || /:$/.test(l)
  const line = lines(text).find(l => l && !skip(l)) ?? ''
  const sentence = (line.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? line).slice(0, 200)
  return sentence || [p.title, p.company, p.location].filter(Boolean).join(' · ')
}

// ---- gates

function liveness(text, status) {
  const quote = firstLine(text, CLOSED)
  if (quote) return { status: 'closed', quote }
  if (status === 404 || status === 410) return { status: 'closed', quote: '' }
  if (Number.isInteger(status) && status >= 200 && status < 300) return { status: 'open', quote: '' }
  return { status: 'unknown', quote: '' }
}

function geoGate(location, text) {
  if (!/\bremote\b/i.test(location)) return null
  const quote = firstLine(text, ATTENDANCE, l => NEGATION.test(l) || l === location)
  return { mismatch: !!quote, quote }
}

// ponytail: country match is a substring check on the posting's location plus a few aliases; a geocoder would be exact
function authorizedFor(profile, location) {
  const loc = ` ${str(location).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')} `
  return (profile.authorizedIn ?? []).some(c => {
    const k = String(c).toLowerCase()
    return [k, ...(COUNTRY_ALIASES[k] ?? [])].some(a => loc.includes(` ${a} `))
  })
}

function workAuthGate(profile, location, text) {
  if (!hasWorkAuth(profile)) return null
  const needed = profile.needsSponsorship === true && !authorizedFor(profile, location)
  if (!needed) return { tier: 'not-needed', quote: '' }
  const no = firstLine(text, NO_SPONSOR)
  if (no) return { tier: 'no-sponsorship', quote: no }
  const yes = firstLine(text, SPONSORS)
  return yes ? { tier: 'sponsors', quote: yes } : { tier: 'unstated', quote: '' }
}

function dealBreakerGate(profile, text) {
  const terms = (profile.dealBreakers ?? []).filter(t => typeof t === 'string' && t.trim())
  if (!terms.length) return null
  return terms.flatMap(term => {
    const quote = firstLine(text, wordRe(term.trim()))
    return quote ? [{ term, quote }] : []
  })
}

// ---- B · requirement table

// Pass 1: requirements and their importance from the JD alone
function jdRequirements(p, text) {
  const reqs = p.requirements.map(r => ({
    text: r.text, keywords: r.keywords,
    importance: r.kind === 'nice' ? 'meaningful' : CRITICAL_WORDS.test(r.text) ? 'critical' : 'high'
  }))
  const seen = new Set(reqs.map(r => r.text))
  let inResp = false
  for (const l of lines(text)) {
    if (!l) continue
    const b = l.match(BULLET)
    if (!b && RESP_HEAD.test(l)) { inResp = true; continue }
    if (!b && ANY_HEAD.test(l)) { inResp = false; continue }
    if (inResp && b && !seen.has(b[1])) {
      seen.add(b[1])
      reqs.push({ text: b[1], keywords: keywordsIn(b[1]), importance: 'meaningful' })
    }
  }
  return reqs
}

// CV lines grouped by section/entry (a "strong" match has every term in one group)
function cvGroups(source) {
  const all = str(source).split('\n')
  const groups = [[]]
  all.forEach((text, i) => {
    if (/^#{2,3}(?:\s|$)/.test(text)) groups.push([])
    if (text.trim()) groups.at(-1).push({ line: i + 1, text, hay: ` ${phrase(text)} ` })
  })
  return groups.filter(g => g.length)
}

function terms(req) {
  if (req.keywords.length) return req.keywords
  return [...new Set(canonicalTokens(req.text).filter(w => w.length > 2 && !FILLER.has(w) && !/^\d+$/.test(w)))]
}

// Pass 2: match against the CV
function matchRow(req, groups) {
  const want = terms(req)
  const row = { requirement: req.keywords.length ? req.keywords.join(', ') : req.text.slice(0, 80), jdSignal: req.text, importance: req.importance, keywords: req.keywords, match: 'na', evidence: null }
  if (!want.length) return row
  const hits = entry => want.filter(k => req.keywords.length ? hasPhrase(entry.hay, k) : entry.hay.includes(` ${k} `))
  const best = entries => entries.map(e => ({ e, n: hits(e).length })).sort((a, b) => b.n - a.n)[0]
  // ponytail: loose-word requirements (no known skill) count as strong at 75% word coverage in one group; a synonym list would sharpen it
  const need = req.keywords.length ? want.length : Math.ceil(want.length * 0.75)
  const covered = g => new Set(g.flatMap(hits)).size
  const strong = groups.find(g => covered(g) >= need)
  if (strong) return { ...row, match: 'strong', evidence: quote(best(strong)) }
  const top = best(groups.flat())
  return top?.n ? { ...row, match: 'partial', evidence: quote(top) } : { ...row, match: 'missing' }
}
const quote = hit => hit ? { line: hit.e.line, text: hit.e.text } : null

function budget(rows) {
  const sorted = [...rows].sort((a, b) => IMPORTANCE.indexOf(a.importance) - IMPORTANCE.indexOf(b.importance) || UNMET_ORDER[a.match] - UNMET_ORDER[b.match])
  const keep = Math.max(ROW_BUDGET, sorted.filter(r => r.importance !== 'meaningful').length)
  return { rows: sorted.slice(0, keep), dropped: Math.max(0, sorted.length - keep) }
}

// ---- score

const round1 = n => Math.round(n * 10) / 10
export const recommendationFor = score => score >= 4 ? 'apply' : score >= 3 ? 'consider' : 'skip'

/** Applies the gate caps (⛔/closed 1.5, deal-breaker 2.0) to a 1–5 score. */
export function capScore(score, gates) {
  const caps = []
  if (gates.workAuth?.tier === 'no-sponsorship') caps.push('no-sponsorship')
  if (gates.liveness?.status === 'closed') caps.push('closed')
  if (gates.dealBreakers?.length) caps.push('deal-breaker')
  let s = score
  if (caps.includes('no-sponsorship') || caps.includes('closed')) s = Math.min(s, 1.5)
  if (caps.includes('deal-breaker')) s = Math.min(s, 2)
  return { score: round1(s), caps }
}

function coverage(rows, match) {
  const scored = rows.filter(r => r.match !== 'na')
  const total = scored.reduce((s, r) => s + IMPORTANCE_WEIGHT[r.importance], 0)
  if (!total) return (match?.score ?? 0) / 100 // no usable requirements: fall back to the keyword match estimate
  return scored.reduce((s, r) => s + IMPORTANCE_WEIGHT[r.importance] * MATCH_CREDIT[r.match], 0) / total
}

// ---- G · legitimacy

function legitimacy(job, text, opts) {
  const base = checkLegitimacy(job, opts)
  const inj = firstLine(text, INJECTION)
  if (!inj) return base
  return { level: 'red-flag', signals: [...base.signals, { code: 'prompt-injection', severity: 'high', evidence: inj }] }
}

/**
 * `{ source: 'local', role: { archetype, seniority, remote, tldr }, gates: { liveness, geo, workAuth, dealBreakers },
 *   rows: [{ requirement, jdSignal, importance, match, keywords, evidence: { line, text } | null }], dropped,
 *   score, recommendation, caps, legitimacy, match }`.
 * `liveness` is the HTTP status of the posting fetch (URL jobs); `saved` feeds legitimacy's repost check.
 */
export function evaluateJob({ source = '', doc, layout, issues } = {}, job, { profile, now = new Date(), liveness: status, saved = [] } = {}) {
  const j = job && typeof job === 'object' ? job : {}
  const text = str(j.text)
  const p = parseJob(text, { now })
  const title = str(j.title) || p.title
  const location = str(j.location) || p.location
  const prof = profile && typeof profile === 'object' ? profile : {}

  const geo = geoGate(location, text)
  const gates = {
    liveness: liveness(text, status),
    geo,
    workAuth: workAuthGate(prof, location, text),
    dealBreakers: dealBreakerGate(prof, text)
  }
  const role = {
    archetype: classify(title.toLowerCase(), ARCHETYPE_RE, 'other'),
    seniority: classify(title.toLowerCase(), SENIORITY_RE, 'mid'),
    remote: remoteOf(location, text, geo),
    tldr: tldrOf({ ...p, title }, text)
  }

  const groups = cvGroups(source)
  const all = jdRequirements(p, text).map(r => matchRow(r, groups))
  const match = matchCv({ doc, source, layout, issues }, p)
  const { score, caps } = capScore(1 + 4 * coverage(all, match), gates)
  return {
    source: 'local', role, gates, ...budget(all), score, recommendation: recommendationFor(score), caps,
    legitimacy: legitimacy({ ...j, title, location }, text, { saved, now, parsed: p }), match
  }
}
