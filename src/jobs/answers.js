// Answer bank (career-suite spec §1, §3): every answer the candidate gives is saved on the profile and reused for
// similar questions everywhere (app packs, apply queue, `recto autoapply`). Pure: no DOM, storage or network.
import { ruleOf, DECLINE_RE } from './pack.js'
import { regionOf, countriesIn } from './region.js'

export const MAX_ANSWERS = 500
export const MAX_QUESTION = 500
export const MAX_ANSWER = 5000
const SIMILAR = 0.6 // findAnswer reuses at or above this
const SAME = 0.85 // remember updates in place at or above this

const STOP = new Set(('a an the is are was were be been am do does did you your yours i me my we our us they it its this that these those ' +
  'what which who whom how when where why of in on at to for from by with and or if as please any have has had will would can could ' +
  'should shall may might there here currently current').split(' '))

const str = v => typeof v === 'string' ? v : ''
const lower = s => str(s).trim().toLowerCase()
const tokens = q => normalizeQuestion(q).split(' ').filter(Boolean)

/** Lowercase, punctuation stripped, stop words dropped: 'What is your Notice Period?' → 'notice period'. */
export const normalizeQuestion = q => str(q).toLowerCase().replace(/['’]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ')
  .split(' ').filter(w => w && !STOP.has(w)).join(' ')

/** Token Jaccard similarity of two questions, 0–1 (0 when either has no content words). */
export function similarity(a, b) {
  const x = new Set(tokens(a))
  const y = new Set(tokens(b))
  if (!x.size || !y.size) return 0
  let both = 0
  for (const w of x) if (y.has(w)) both++
  return both / (x.size + y.size - both)
}

// A saved answer onto the offered options: exact, 'Yes' → 'Yes, I do', 'Yes, full rights' → 'Yes', 'decline' → the
// decline option. '' when nothing fits (never a guess).
const startsWord = (long, short) => long.startsWith(short) && !/[\p{L}\p{N}]/u.test(long[short.length] ?? '')
export function mapChoice(options, answer) {
  const a = lower(answer)
  if (!a) return ''
  if (a === 'decline') return options.find(o => DECLINE_RE.test(o)) ?? ''
  const opts = options.map(o => [o, lower(o)])
  return (opts.find(([, o]) => o === a) ?? opts.find(([, o]) => startsWord(o, a)) ?? opts.find(([, o]) => o.length > 1 && startsWord(a, o)))?.[0] ?? ''
}

// Two questions naming different countries never share an answer ("work in Australia?" ≠ "work in the US?")
const sameCountries = (a, b) => countriesIn(a).sort().join() === countriesIn(b).sort().join()

/**
 * The saved answer for `question`, or null. Tiers: exact normalized match → same pack rule → similarity ≥ 0.6 (best).
 * With `options`, the answer is mapped onto them; an entry whose answer fits none is skipped.
 */
export function findAnswer(bank, question, { options = [] } = {}) {
  const n = normalizeQuestion(question)
  if (!n || !Array.isArray(bank)) return null
  const entries = bank.filter(e => str(e?.question).trim() && str(e?.answer).trim() && sameCountries(e.question, question))
  const fit = e => {
    const answer = options.length ? mapChoice(options, e.answer) : e.answer
    return answer ? { answer, entry: e } : null
  }
  const rule = ruleOf(question)
  const scored = entries.map(e => [e, similarity(e.question, question)]).filter(([, s]) => s >= SIMILAR).sort((x, y) => y[1] - x[1])
  const tiers = [
    entries.filter(e => normalizeQuestion(e.question) === n),
    rule < 0 ? [] : entries.filter(e => ruleOf(e.question) === rule),
    scored.map(([e]) => e)
  ]
  for (const tier of tiers) for (const e of tier) { const hit = fit(e); if (hit) return hit }
  return null
}

const iso = now => { const d = new Date(now ?? Date.now()); return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString() }
// ponytail: 32-bit string hash for readable ids; collisions get a suffix
const hash = s => { let h = 5381; for (const c of s) h = (h * 33 + c.codePointAt(0)) >>> 0; return h.toString(36) }
const cleanOptions = o => Array.isArray(o) ? o.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim().slice(0, MAX_QUESTION)) : []

/**
 * A new bank with `{ question, answer, options? }` saved: updates the most similar entry (≥ 0.85) in place, else adds it
 * first. Bumps `uses`; capped at 500 entries (oldest dropped). Blank question or answer → the bank unchanged.
 */
export function remember(bank, { question, answer, options } = {}, now) {
  const list = Array.isArray(bank) ? bank : []
  const q = str(question).trim().slice(0, MAX_QUESTION)
  const a = str(answer).trim().slice(0, MAX_ANSWER)
  if (!q || !a) return list
  const opts = cleanOptions(options)
  const updatedAt = iso(now)
  let best = -1
  let score = SAME
  list.forEach((e, i) => { const s = similarity(e?.question, q); if (s >= score && sameCountries(e?.question, q)) { best = i; score = s } })
  if (best >= 0) {
    const e = list[best]
    return list.map((x, i) => i !== best ? x : { ...e, answer: a, ...(opts.length ? { options: opts } : {}), updatedAt, uses: (Number(e.uses) || 0) + 1 })
  }
  let id = `ans-${hash(normalizeQuestion(q) || q)}`
  while (list.some(e => e?.id === id)) id += 'x'
  return [{ id, question: q, answer: a, ...(opts.length ? { options: opts } : {}), updatedAt, uses: 1 }, ...list].slice(0, MAX_ANSWERS)
}

/** Saved answers from an export (`{ answers: [...] }` or a bare array) merged into the bank with `remember`. */
export function importAnswers(bank, data, now) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.answers) ? data.answers : []
  return list.reduceRight((b, e) => remember(b, e ?? {}, e?.updatedAt || now), Array.isArray(bank) ? bank : [])
}

/** The export file body for the answer bank. */
export const exportAnswers = bank => JSON.stringify({ format: 'recto-answers', version: 1, answers: Array.isArray(bank) ? bank : [] }, null, 2)

const set = v => Array.isArray(v) ? v.length > 0 : v != null && v !== ''
const always = () => true

// The "answer once" list (spec §3). `{country}` / `{retirement}` come from the active preset; `check` = the preset check
// that must exist; `diversity` = a preset diversity extra; `filled(p)` = the profile already answers it.
export const COMMON_QUESTIONS = [
  { id: 'rightToWork', section: 'rights', text: 'Do you have the right to work in {country}?', filled: p => p.workRights || set(p.authorizedIn) },
  { id: 'citizenship', section: 'rights', text: 'What is your citizenship or residency status?', filled: p => p.workRights },
  { id: 'visa', section: 'rights', text: 'What visa do you hold and when does it expire?', filled: p => (p.workRights && p.workRights !== 'visa') || p.visaType },
  { id: 'sponsorship', section: 'rights', text: 'Will you now or in the future require visa sponsorship?', filled: p => p.workRights || set(p.authorizedIn) || p.needsSponsorship },
  { id: 'noticePeriod', section: 'pay', text: 'What is your notice period?', filled: p => p.noticePeriod },
  { id: 'earliestStart', section: 'pay', text: 'What is your earliest start date?', filled: p => p.earliestStart || p.noticePeriod },
  { id: 'salary', section: 'pay', text: 'What are your salary expectations (base or including {retirement})?', filled: p => p.salaryExpectation || set(p.salaryMin) },
  { id: 'employmentType', section: 'pay', text: 'What type of employment are you looking for?', filled: p => set(p.employmentTypes) },
  { id: 'relocate', section: 'pay', text: 'Are you willing to relocate?', filled: p => typeof p.willingToRelocate === 'boolean' },
  { id: 'travel', section: 'pay', text: 'Are you willing to travel for work?', filled: p => p.willingToTravel },
  { id: 'policeCheck', section: 'checks', check: 'policeCheck', text: 'Do you have a current police check, or are you willing to obtain one?', filled: p => p.policeCheck },
  { id: 'workingWithChildren', section: 'checks', check: 'workingWithChildren', text: 'Do you hold a working-with-children check?', filled: p => p.workingWithChildren },
  { id: 'backgroundCheck', section: 'checks', check: 'backgroundCheck', text: 'Are you willing to undergo a background check?', filled: p => p.backgroundCheck },
  { id: 'clearance', section: 'checks', text: 'Do you hold a security clearance?', filled: p => p.clearance },
  { id: 'driversLicence', section: 'checks', text: "Do you hold a current driver's licence?", filled: p => typeof p.driversLicence === 'boolean' },
  { id: 'ownVehicle', section: 'checks', text: 'Do you have access to your own vehicle?', filled: p => typeof p.ownVehicle === 'boolean' },
  { id: 'education', section: 'background', text: 'What is your highest level of education?', filled: p => p.highestEducation },
  { id: 'experience', section: 'background', text: 'How many years of experience do you have?', filled: p => set(p.yearsExperience) },
  { id: 'languages', section: 'background', text: 'Which languages do you speak?', filled: p => set(p.languages) },
  { id: 'referees', section: 'background', text: 'Can you provide referees?', filled: always },
  { id: 'heardAbout', section: 'answers', text: 'How did you hear about this job?', filled: always },
  { id: 'gender', section: 'diversity', text: 'What is your gender?', filled: always },
  { id: 'disability', section: 'diversity', text: 'Do you identify as having a disability?', filled: always },
  { id: 'indigenous', section: 'diversity', diversity: 'indigenous', text: 'Do you identify as Aboriginal or Torres Strait Islander?', filled: always },
  { id: 'veteran', section: 'diversity', diversity: 'veteran', text: 'Are you a veteran?', filled: always }
]

/** The common questions for a country (code or name) in its preset's wording; unknown countries get the generic set. */
export function commonQuestions(country) {
  const r = regionOf(country)
  const name = r?.name || str(country).trim() || 'this country'
  const checks = r?.checks ?? ['backgroundCheck']
  const retirement = r?.retirement || 'retirement contributions'
  return COMMON_QUESTIONS
    .filter(q => (!q.check || checks.includes(q.check)) && (!q.diversity || (r?.diversity ?? []).includes(q.diversity)))
    .map(q => ({ ...q, question: q.text.replace('{country}', name).replace('{retirement}', retirement) }))
}

/** `{ answered, total, missing }` over the country's common questions: a profile field or a saved answer counts. */
export function completeness(profile, country) {
  const p = profile ?? {}
  const qs = commonQuestions(country)
  const missing = qs.filter(q => !q.filled(p) && !findAnswer(p.answers, q.question))
  return { answered: qs.length - missing.length, total: qs.length, missing }
}
