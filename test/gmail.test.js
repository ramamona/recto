import test from 'node:test'
import assert from 'node:assert/strict'
import { gmailAuthUrl, takeGmailToken, gmailToken, scanGmail, statusFromMail, suggestStatuses } from '../src/jobs/gmail.js'

function memStorage() {
  const m = new Map()
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }
}

test('auth URL is read-only and carries a state that the return must match', () => {
  const storage = memStorage()
  const url = new URL(gmailAuthUrl({ clientId: 'cid', redirectUri: 'https://x.test/app', storage }))
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly')
  assert.equal(url.searchParams.get('response_type'), 'token')
  const state = url.searchParams.get('state')
  const back = `https://x.test/app#access_token=tok&state=${state}&expires_in=3600`
  const ok = takeGmailToken(back, { storage, now: () => 0 })
  assert.equal(ok.url, 'https://x.test/app')
  assert.equal(gmailToken({ storage, now: () => 1000 }), 'tok')
  assert.equal(gmailToken({ storage, now: () => 3600 * 1000 + 1 }), null, 'expired token is not used')
})

test('a return with a wrong state stores nothing', () => {
  const storage = memStorage()
  gmailAuthUrl({ clientId: 'cid', redirectUri: 'https://x.test/app', storage })
  const r = takeGmailToken('https://x.test/app#access_token=tok&state=forged', { storage })
  assert.equal(r.error, 'state')
  assert.equal(gmailToken({ storage }), null)
  assert.equal(takeGmailToken('https://x.test/app', { storage }), null, 'no fragment: nothing to do')
})

test('scan lists metadata only, with bearer auth, and skips failed reads', async () => {
  const calls = []
  const fetch = async (url, opts) => {
    calls.push([url, opts.headers.authorization])
    if (url.includes('/messages?q=')) return { ok: true, json: async () => ({ messages: [{ id: 'a' }, { id: 'b' }] }) }
    if (url.endsWith('/b?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date')) return { ok: false }
    return { ok: true, json: async () => ({ snippet: 'We regret to inform you', payload: { headers: [{ name: 'Subject', value: 'Acme update' }, { name: 'From', value: 'jobs@acme.com' }, { name: 'Date', value: 'Mon, 1 Jun 2026' }] } }) }
  }
  const msgs = await scanGmail({ token: 'tok', fetch })
  assert.deepEqual(msgs, [{ id: 'a', subject: 'Acme update', from: 'jobs@acme.com', date: 'Mon, 1 Jun 2026', snippet: 'We regret to inform you' }])
  assert.ok(calls.every(([, a]) => a === 'Bearer tok'))
  await assert.rejects(scanGmail({ token: 'x', fetch: async () => ({ ok: false, status: 401 }) }), { status: 401 })
})

test('mail text maps to a status; the strongest signal wins', () => {
  assert.equal(statusFromMail('We are pleased to offer you the role'), 'offer')
  assert.equal(statusFromMail('Unfortunately we will not be moving forward'), 'rejected')
  assert.equal(statusFromMail('Next steps: schedule a call with our recruiter'), 'interview')
  assert.equal(statusFromMail('Thank you for applying to Acme'), 'applied')
  assert.equal(statusFromMail('Your monthly newsletter'), null)
})

test('suggestions match by company, never downgrade, and skip short names', () => {
  const jobs = [
    { id: 'j1', company: 'Acme', title: 'Engineer', status: 'applied' },
    { id: 'j2', company: 'Acme', title: 'Designer', status: 'offer' },
    { id: 'j3', company: 'Ab', title: 'Tiny', status: 'applied' },
    { id: 'j4', company: 'Brightside', title: 'PM', status: 'saved' }
  ]
  const mail = [
    { id: 'm1', subject: 'Interview with Acme', from: 'hr@acme.com', snippet: 'next steps', date: 'd1' },
    { id: 'm2', subject: 'Thank you for applying to Ab', from: 'x@ab.io', snippet: '', date: 'd2' },
    { id: 'm3', subject: 'Brightside application received', from: 'a@brightside.co', snippet: '', date: 'd3' }
  ]
  const s = suggestStatuses(mail, jobs)
  assert.deepEqual(s.map(x => [x.jobId, x.status]), [['j1', 'interview'], ['j4', 'applied']])
})
