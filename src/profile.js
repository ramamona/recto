// Candidate profile (review-jobs spec 3) in localStorage['recto:profile']. Empty fields = those checks are skipped.

export const PROFILE_KEY = 'recto:profile'
export const REMOTE = ['remote', 'hybrid', 'onsite', 'any']

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
    dealBreakers: list(o.dealBreakers)
  }
  const min = Number(o.salaryMin)
  if (o.salaryMin != null && o.salaryMin !== '' && Number.isFinite(min) && min >= 0) out.salaryMin = min
  if (typeof o.currency === 'string' && o.currency.trim()) out.currency = o.currency.trim()
  return out
}

/** Whether the profile says anything about work authorization (else that gate is skipped). */
export const hasWorkAuth = p => list(p?.authorizedIn).length > 0 || p?.needsSponsorship === true

export function loadProfile(storage = defaultStorage()) {
  try { return normalizeProfile(JSON.parse(storage?.getItem(PROFILE_KEY) ?? 'null')) } catch { return normalizeProfile(null) }
}

export function saveProfile(p, storage = defaultStorage()) {
  const out = normalizeProfile(p)
  try { storage?.setItem(PROFILE_KEY, JSON.stringify(out)) } catch {}
  return out
}
