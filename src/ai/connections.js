// Active AI connection and consent flags (spec assist §2). Memory first; localStorage['recto:ai'] only on opt-in.
import { PROVIDERS } from './providers.js'

export const PROVIDER_IDS = Object.keys(PROVIDERS)

const KEY = 'recto:ai'
let current = null
let forgotten = false
const sessionConsent = new Set()

const storageOf = opts => {
  try { return opts?.storage ?? globalThis.localStorage } catch { return undefined }
}

function read(storage) {
  try {
    const v = JSON.parse(storage?.getItem(KEY) ?? 'null')
    return v && typeof v === 'object' ? v : {}
  } catch { return {} }
}

function write(storage, { connection, consent = [] }) {
  try {
    if (connection || consent.length) storage?.setItem(KEY, JSON.stringify(connection ? { connection, consent } : { consent }))
    else storage?.removeItem(KEY)
  } catch { /* storage unavailable: memory still holds the state */ }
}

export function getConnection(opts) {
  if (current) return { ...current }
  if (forgotten) return null
  const stored = read(storageOf(opts)).connection
  return stored && PROVIDER_IDS.includes(stored.provider) ? stored : null
}

export function setConnection(conn, opts) {
  if (!PROVIDER_IDS.includes(conn?.provider)) throw new TypeError(`Unknown provider: ${conn?.provider}`)
  current = { ...conn }
  forgotten = false
  const storage = storageOf(opts)
  write(storage, { ...read(storage), connection: conn.remember ? current : undefined })
}

export function forgetConnection(opts) {
  current = null
  forgotten = true
  sessionConsent.clear()
  try { storageOf(opts)?.removeItem(KEY) } catch { /* nothing stored */ }
}

export function hasConsent(provider, opts) {
  if (sessionConsent.has(provider)) return true
  const consent = read(storageOf(opts)).consent
  return Array.isArray(consent) && consent.includes(provider)
}

export function grantConsent(provider, { persist = false, ...opts } = {}) {
  sessionConsent.add(provider)
  if (!persist) return
  const storage = storageOf(opts)
  const saved = read(storage)
  const consent = Array.isArray(saved.consent) ? saved.consent : []
  if (!consent.includes(provider)) write(storage, { ...saved, consent: [...consent, provider] })
}
