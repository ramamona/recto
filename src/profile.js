// Candidate profile (review-jobs spec 3, discover-apply spec 3, career-suite spec §3) in localStorage['recto:profile'].
// Empty fields = those checks are skipped. The fields every profile had stay always present; the v2 fields appear only
// when set, so old profiles load (and compare) unchanged.
import { REGIONS, countryOf, detectCountry, DEFAULT_COUNTRY } from './jobs/region.js'

export const PROFILE_KEY = 'recto:profile'
export const REMOTE = ['remote', 'hybrid', 'onsite', 'any']

export const APPLICANT_FIELDS = ['firstName', 'lastName', 'email', 'phone', 'linkedin', 'github', 'website', 'city', 'country', 'salaryExpectation', 'noticePeriod']
export const EEO_FIELDS = ['gender', 'race', 'veteran', 'disability']
// Asked only where a preset (or the form) shows them; 'decline' unless the candidate says otherwise
export const EEO_EXTRA = ['indigenous', 'lgbtq']

export const WORK_RIGHTS = ['citizen', 'permanent-resident', 'nz-citizen', 'settled-status', 'visa', 'needs-visa']
export const EMPLOYMENT_TYPES = ['full-time', 'part-time', 'contract', 'casual', 'internship']
export const TRAVEL = ['none', 'occasional', 'frequent']
export const SALARY_BASIS = ['base', 'base-plus-retirement', 'total-package']
export const CHECK_STATES = ['current', 'willing', 'no']
export const CHECKS = ['policeCheck', 'workingWithChildren', 'backgroundCheck']
export const REFEREES_DEFAULT = 'Available on request'
// Optional text fields (v2) and their caps
const TEXTS = { preferredName: 200, portfolio: 500, street: 300, state: 100, postcode: 20, visaType: 200, salaryExpectation: 500,
  dayRate: 200, clearance: 200, highestEducation: 300, referees: 2000 }
export const MAX_STORIES = 50
const STORY_TEXT = ['situation', 'task', 'action', 'result', 'reflection']

const text = (v, max = 500) => typeof v === 'string' ? v.trim().slice(0, max) : ''
const list = (v, max = 50) => Array.isArray(v) ? [...new Set(v.filter(s => typeof s === 'string').map(s => s.trim().slice(0, 200)).filter(Boolean))].slice(0, max) : []
const oneOf = (v, allowed) => allowed.includes(v) ? v : ''
const bool = v => typeof v === 'boolean' ? v : null
const num = (v, max) => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 && n <= max ? n : null
}
// YYYY-MM-DD that is a real calendar date
const date = v => {
  const s = text(v, 10)
  const d = new Date(`${s}T00:00:00Z`)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s) ? s : ''
}
// A preset country is stored by its name ('au' → 'Australia'); anything else as typed
const countryName = v => { const c = countryOf(v); return c ? REGIONS[c].name : text(v, 100) }

function defaultStorage() {
  try { if (globalThis.localStorage) return globalThis.localStorage } catch {}
  return null
}

function answersOf(v) {
  if (!Array.isArray(v)) return []
  const seen = new Set()
  const out = []
  for (const e of v) {
    const question = text(e?.question, 500)
    const answer = text(e?.answer, 5000)
    if (!question || !answer) continue
    let id = text(e.id, 100) || `ans-${out.length}`
    while (seen.has(id)) id += 'x'
    seen.add(id)
    const options = list(e.options, 100)
    out.push({ id, question, answer, ...(options.length ? { options } : {}), updatedAt: text(e.updatedAt, 40), uses: Math.max(0, Math.trunc(Number(e.uses)) || 0) })
    if (out.length === 500) break
  }
  return out
}

function storiesOf(v) {
  if (!Array.isArray(v)) return []
  const out = []
  const seen = new Set()
  for (const s of v) {
    let id = text(s?.id, 100) || `story-${out.length}`
    while (seen.has(id)) id += 'x'
    const story = { id, title: text(s?.title, 200),
      ...Object.fromEntries(STORY_TEXT.map(k => [k, text(s?.[k], 5000)])), tags: list(s?.tags, 20),
      sourceLines: Array.isArray(s?.sourceLines) ? s.sourceLines.filter(l => (typeof l === 'string' && l.trim()) || (Number.isInteger(l) && l >= 0))
        .map(l => typeof l === 'string' ? l.trim().slice(0, 500) : l).slice(0, 20) : [] }
    if (!story.title && !STORY_TEXT.some(k => story[k])) continue
    seen.add(id)
    out.push(story)
    if (out.length === MAX_STORIES) break
  }
  return out
}

/** The spec shape with defaults; unknown keys and junk values are dropped. */
export function normalizeProfile(p) {
  const o = p && typeof p === 'object' ? p : {}
  const out = {
    authorizedIn: list(o.authorizedIn),
    needsSponsorship: o.needsSponsorship === true,
    locations: list(o.locations),
    remote: REMOTE.includes(o.remote) ? o.remote : 'any',
    targetRoles: list(o.targetRoles),
    dealBreakers: list(o.dealBreakers),
    ...Object.fromEntries(APPLICANT_FIELDS.map(k => [k, text(o[k], TEXTS[k])])),
    country: countryName(o.country),
    willingToRelocate: bool(o.willingToRelocate),
    eeo: Object.fromEntries(EEO_FIELDS.map(k => [k, text(o.eeo?.[k], 200) || 'decline']))
  }
  for (const k of EEO_EXTRA) { const v = text(o.eeo?.[k], 200); if (v && v !== 'decline') out.eeo[k] = v }
  const opt = {
    pronouns: text(o.pronouns, 100),
    ...Object.fromEntries(Object.entries(TEXTS).filter(([k]) => !(k in out)).map(([k, max]) => [k, text(o[k], max)])),
    workRights: oneOf(o.workRights, WORK_RIGHTS),
    visaExpiry: date(o.visaExpiry),
    earliestStart: date(o.earliestStart),
    willingToTravel: oneOf(o.willingToTravel, TRAVEL),
    salaryBasis: oneOf(o.salaryBasis, SALARY_BASIS),
    currency: text(o.currency, 10),
    ...Object.fromEntries(CHECKS.map(k => [k, oneOf(o[k], CHECK_STATES)])),
    employmentTypes: EMPLOYMENT_TYPES.filter(t => Array.isArray(o.employmentTypes) && o.employmentTypes.includes(t)),
    languages: list(o.languages, 30),
    driversLicence: bool(o.driversLicence),
    ownVehicle: bool(o.ownVehicle),
    salaryMin: num(o.salaryMin, 1e9),
    yearsExperience: num(o.yearsExperience, 80),
    answers: answersOf(o.answers),
    stories: storiesOf(o.stories)
  }
  for (const [k, v] of Object.entries(opt)) if (v !== '' && v !== null && !(Array.isArray(v) && !v.length)) out[k] = v
  return out
}

/** Whether the profile says anything about work authorization (else that gate is skipped). */
export const hasWorkAuth = p => list(p?.authorizedIn).length > 0 || p?.needsSponsorship === true || WORK_RIGHTS.includes(p?.workRights)

/** Countries the candidate may work in: `authorizedIn` plus their own country when `workRights` grants it
 * (an NZ citizen in Australia may also work in New Zealand). */
export function workCountries(p) {
  const out = list(p?.authorizedIn)
  const own = text(p?.country)
  if (own && ['citizen', 'permanent-resident', 'nz-citizen', 'settled-status', 'visa'].includes(p?.workRights)) out.push(own)
  if (p?.workRights === 'nz-citizen') out.push('NZ')
  return [...new Set(out)]
}

/** The country presets follow: the profile's, else the browser's, else DEFAULT_COUNTRY. */
export const activeCountry = (p, env = {}) => countryOf(p?.country) || detectCountry(env) || DEFAULT_COUNTRY

const LINKS = [['linkedin', /(^|\.)linkedin\.com$/], ['github', /(^|\.)github\.com$/], ['website', /./]]
const hostOf = href => { try { return new URL(href).hostname.toLowerCase() } catch { return '' } }

/** Empty name, email, phone and link fields filled from the CV header (a parsed doc); the profile's own values win. */
export function prefillProfile(profile, doc) {
  const h = doc?.header
  if (!h) return profile
  const contacts = (h.contacts ?? []).filter(c => c.valid)
  const first = kind => contacts.find(c => c.kind === kind)?.text ?? ''
  const words = text(h.name).split(/\s+/).filter(Boolean)
  const found = {
    firstName: words.length > 1 ? words.slice(0, -1).join(' ') : words.join(''),
    lastName: words.length > 1 ? words.at(-1) : '',
    email: first('email'),
    phone: first('phone')
  }
  const urls = contacts.filter(c => c.kind === 'url')
  for (const [k, re] of LINKS) found[k] = urls.find(c => re.test(hostOf(c.href)) && !Object.values(found).includes(c.href))?.href ?? ''
  const out = { ...profile }
  for (const [k, v] of Object.entries(found)) if (!out[k] && v) out[k] = v
  return out
}

export function loadProfile(storage = defaultStorage()) {
  try { return normalizeProfile(JSON.parse(storage?.getItem(PROFILE_KEY) ?? 'null')) } catch { return normalizeProfile(null) }
}

export function saveProfile(p, storage = defaultStorage()) {
  const out = normalizeProfile(p)
  try { storage?.setItem(PROFILE_KEY, JSON.stringify(out)) } catch {}
  return out
}
