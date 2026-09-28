// Candidate profile (review-jobs spec 3 + discover-apply spec 3 applicant fields) in localStorage['recto:profile'].
// Empty fields = those checks are skipped.

export const PROFILE_KEY = 'recto:profile'
export const REMOTE = ['remote', 'hybrid', 'onsite', 'any']

export const APPLICANT_FIELDS = ['firstName', 'lastName', 'email', 'phone', 'linkedin', 'github', 'website', 'city', 'country', 'salaryExpectation', 'noticePeriod']
export const EEO_FIELDS = ['gender', 'race', 'veteran', 'disability']

const text = v => typeof v === 'string' ? v.trim() : ''
const list = v => Array.isArray(v) ? [...new Set(v.filter(s => typeof s === 'string').map(s => s.trim()).filter(Boolean))] : []

function defaultStorage() {
  try { if (globalThis.localStorage) return globalThis.localStorage } catch {}
  return null
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
    ...Object.fromEntries(APPLICANT_FIELDS.map(k => [k, text(o[k])])),
    willingToRelocate: typeof o.willingToRelocate === 'boolean' ? o.willingToRelocate : null,
    eeo: Object.fromEntries(EEO_FIELDS.map(k => [k, text(o.eeo?.[k]) || 'decline']))
  }
  if (text(o.pronouns)) out.pronouns = text(o.pronouns)
  const min = Number(o.salaryMin)
  if (o.salaryMin != null && o.salaryMin !== '' && Number.isFinite(min) && min >= 0) out.salaryMin = min
  if (typeof o.currency === 'string' && o.currency.trim()) out.currency = o.currency.trim()
  return out
}

/** Whether the profile says anything about work authorization (else that gate is skipped). */
export const hasWorkAuth = p => list(p?.authorizedIn).length > 0 || p?.needsSponsorship === true

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
