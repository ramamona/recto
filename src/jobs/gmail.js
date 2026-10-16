// Gmail link (optional). Read-only (gmail.readonly), user-supplied Google OAuth client ID, implicit token flow:
// the browser navigates to Google and back, so no script is loaded and the CSP stays as it is. The token lives in
// sessionStorage (this tab only). Mail is only read to suggest status changes; the user confirms each one.
// Pure apart from the injected fetch and storage.

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
export const GMAIL_CONFIG_KEY = 'recto:gmail' // { clientId } in localStorage: the client ID is public, not a secret
const TOKEN_KEY = 'recto:gmail-token'
const STATE_KEY = 'recto:gmail-state'
const API = 'https://gmail.googleapis.com/gmail/v1/users/me/messages'
const QUERY = 'newer_than:120d (subject:(application OR interview OR offer OR unfortunately OR "next steps") OR "thank you for applying")'
// ponytail: first 50 matching mails only, no paging; add nextPageToken paging if a search really needs more
const MAX_MESSAGES = 50
const RANK = { saved: 0, applied: 1, 'no-response': 1, interview: 2, offer: 3, rejected: 3 }

const storageOf = s => s ?? globalThis.sessionStorage
const rand = () => globalThis.crypto.getRandomValues(new Uint8Array(16)).reduce((a, b) => a + b.toString(16).padStart(2, '0'), '')

/** The Google sign-in URL. The state value is kept in sessionStorage and checked when the user comes back. */
export function gmailAuthUrl({ clientId, redirectUri, storage }) {
  const state = rand()
  storageOf(storage).setItem(STATE_KEY, state)
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  for (const [k, v] of Object.entries({ client_id: clientId, redirect_uri: redirectUri, response_type: 'token', scope: GMAIL_SCOPE, state, prompt: 'consent' })) url.searchParams.set(k, v)
  return url.toString()
}

/** On return, takes `access_token` from the URL fragment if the state matches, stores it, and returns the URL without it. */
export function takeGmailToken(href, { storage, now = () => Date.now() } = {}) {
  const s = storageOf(storage)
  const url = new URL(href)
  const frag = new URLSearchParams(url.hash.slice(1))
  if (!frag.has('access_token')) return null
  url.hash = ''
  const expected = s.getItem(STATE_KEY)
  s.removeItem(STATE_KEY)
  if (!expected || frag.get('state') !== expected) return { url: url.href, error: 'state' }
  const expiresIn = Number(frag.get('expires_in')) || 3600
  s.setItem(TOKEN_KEY, JSON.stringify({ token: frag.get('access_token'), exp: now() + expiresIn * 1000 }))
  return { url: url.href }
}

/** The stored token, or null when none is held or it has expired. */
export function gmailToken({ storage, now = () => Date.now() } = {}) {
  try {
    const { token, exp } = JSON.parse(storageOf(storage).getItem(TOKEN_KEY) ?? 'null') ?? {}
    return typeof token === 'string' && exp > now() ? token : null
  } catch {
    return null
  }
}

export function gmailSignOut({ storage } = {}) {
  storageOf(storage).removeItem(TOKEN_KEY)
}

const header = (msg, name) => msg.payload?.headers?.find(h => h.name?.toLowerCase() === name)?.value ?? ''

/** Lists job-related mail (metadata and snippet only, never bodies) → [{ id, subject, from, date, snippet }]. */
export async function scanGmail({ token, fetch = globalThis.fetch }) {
  const auth = { authorization: `Bearer ${token}` }
  const list = await fetch(`${API}?${new URLSearchParams({ q: QUERY, maxResults: String(MAX_MESSAGES) })}`, { headers: auth })
  if (!list.ok) throw Object.assign(new Error(`gmail ${list.status}`), { status: list.status })
  const { messages = [] } = await list.json()
  const qs = new URLSearchParams([['format', 'metadata'], ['metadataHeaders', 'Subject'], ['metadataHeaders', 'From'], ['metadataHeaders', 'Date']])
  return Promise.all(messages.map(async m => {
    const r = await fetch(`${API}/${encodeURIComponent(m.id)}?${qs}`, { headers: auth })
    if (!r.ok) return null
    const msg = await r.json()
    return { id: m.id, subject: header(msg, 'subject'), from: header(msg, 'from'), date: header(msg, 'date'), snippet: msg.snippet ?? '' }
  })).then(all => all.filter(Boolean))
}

/** Mail text → the status it suggests, or null. Rules are deliberately plain; the user confirms every suggestion. */
export function statusFromMail(text) {
  if (/pleased to offer|offer letter|we'?d like to offer|extend (you )?an offer/i.test(text)) return 'offer'
  if (/unfortunately|regret to inform|not (be )?moving forward|unsuccessful|not (been )?selected|other candidates/i.test(text)) return 'rejected'
  if (/interview|phone screen|schedule a (call|chat)|next steps/i.test(text)) return 'interview'
  if (/thank you for (applying|your application)|application (received|submitted)|we received your application|you applied/i.test(text)) return 'applied'
  return null
}

/** Mail matched to tracked jobs by company name → suggestions to move a job forward. Never downgrades; rejected only from an open stage. */
export function suggestStatuses(messages, jobs) {
  const out = []
  for (const job of jobs) {
    const company = (job.company ?? '').trim().toLowerCase()
    if (company.length < 3 || !(job.status in RANK)) continue
    for (const m of messages) {
      if (!`${m.from} ${m.subject}`.toLowerCase().includes(company)) continue
      const status = statusFromMail(`${m.subject} ${m.snippet}`)
      if (status && RANK[status] > RANK[job.status]) {
        out.push({ jobId: job.id, title: job.title, company: job.company, status, mailId: m.id, subject: m.subject, date: m.date })
        break
      }
    }
  }
  return out
}
