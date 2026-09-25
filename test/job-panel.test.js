import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isJobUrl, probeProxy, mergeJob, withSignal, latestEvaluation, gateBanners, evaluationRecord } from '../src/ui/job-panel.js'
import { toProfile, splitList } from '../src/ui/profile-dialog.js'

test('isJobUrl: a single http(s) link, not pasted text', () => {
  assert.equal(isJobUrl('https://jobs.lever.co/acme/123'), true)
  assert.equal(isJobUrl('  http://x.dev/job  '), true)
  assert.equal(isJobUrl('Senior Engineer\nhttps://x.dev'), false)
  assert.equal(isJobUrl('ftp://x.dev'), false)
  assert.equal(isJobUrl('We are hiring'), false)
})

test('probeProxy: HEAD /api/fetch 400 means serve.js proxy is on', async () => {
  const calls = []
  const fetch = status => async (url, init) => { calls.push([url, init.method]); return { status } }
  assert.equal(await probeProxy(fetch(400), 'http://127.0.0.1:5000'), 'http://127.0.0.1:5000')
  assert.deepEqual(calls[0], ['http://127.0.0.1:5000/api/fetch', 'HEAD'])
  assert.equal(await probeProxy(fetch(404), 'https://recto.app'), null)
  assert.equal(await probeProxy(async () => { throw new TypeError('offline') }, 'https://recto.app'), null)
})

test('mergeJob: fetched fields win for ATS sources, parsed fields fill the gaps', () => {
  const parsed = { title: 'Parsed title', company: 'Parsed Co', location: 'Remote', postedAt: '2026-09-01' }
  const url = mergeJob({ url: 'https://x.dev', source: 'url', title: '', company: '', location: '', text: 'x' }, parsed)
  assert.deepEqual([url.title, url.company, url.location, url.postedAt], ['Parsed title', 'Parsed Co', 'Remote', '2026-09-01'])
  const ats = mergeJob({ source: 'lever', title: 'Real title', company: 'acme', location: '', text: 'x', postedAt: '2026-09-20' }, parsed)
  assert.deepEqual([ats.title, ats.company, ats.location, ats.postedAt], ['Real title', 'acme', 'Remote', '2026-09-20'])
  // AI refinement of a pasted job prefers the AI fields
  const refined = mergeJob({ source: 'paste', title: 'Old', company: '', text: 'x' }, { title: 'New', company: 'Co' }, { prefer: true })
  assert.deepEqual([refined.title, refined.company], ['New', 'Co'])
})

test('withSignal injects the abort signal into every complete call', async () => {
  const seen = []
  const client = { complete: async args => { seen.push(args); return { text: 'ok' } }, listModels: async () => [] }
  const ac = new AbortController()
  const c = withSignal(client, ac.signal)
  await c.complete({ messages: [] })
  assert.equal(seen[0].signal, ac.signal)
  assert.equal(typeof c.listModels, 'function')
})

test('latestEvaluation picks the newest AI evaluation by source, ignoring local and old-shape entries', () => {
  const job = { evaluations: [{ source: 'ai', score: 3, rows: [] }, { source: 'local', score: 4.2 }, { source: 'ai', score: 4, rows: [] }, { kind: 'ai', score: 5 }] }
  assert.equal(latestEvaluation(job).score, 4)
  assert.equal(latestEvaluation({ evaluations: [{ source: 'local', score: 3 }] }), null)
  assert.equal(latestEvaluation(null), null)
})

test('gateBanners: one banner per computed gate, with level and verbatim quote', () => {
  const gates = {
    liveness: { status: 'closed', quote: 'We are no longer accepting applications.' },
    geo: { mismatch: true, quote: '3 days per week in our Berlin office' },
    workAuth: { tier: 'no-sponsorship', quote: 'We are unable to offer visa sponsorship.' },
    dealBreakers: [{ term: 'crypto', quote: 'Our crypto trading desk' }]
  }
  assert.deepEqual(gateBanners(gates).map(b => [b.id, b.level, b.quote]), [
    ['liveness', 'error', 'We are no longer accepting applications.'],
    ['geo', 'warn', '3 days per week in our Berlin office'],
    ['workAuth', 'error', 'We are unable to offer visa sponsorship.'],
    ['dealBreaker', 'error', 'Our crypto trading desk']
  ])
  assert.deepEqual(gateBanners(gates).at(-1).vars, { term: 'crypto' })
  // null = not computed: no geo banner, a profile hint instead of work auth, nothing for deal-breakers
  const bare = gateBanners({ liveness: { status: 'unknown', quote: '' }, geo: null, workAuth: null, dealBreakers: null })
  assert.deepEqual(bare.map(b => [b.id, b.level, b.key]), [['liveness', 'info', 'eval.gate.liveness.unknown'], ['workAuth', 'info', 'eval.gate.workAuth.none']])
  const good = gateBanners({ liveness: { status: 'open', quote: '' }, geo: { mismatch: false, quote: '' }, workAuth: { tier: 'sponsors', quote: 'We sponsor visas' }, dealBreakers: [] })
  assert.deepEqual(good.map(b => b.level), ['ok', 'ok', 'ok'])
  assert.deepEqual(gateBanners(undefined), [])
})

test('evaluationRecord drops the bulky match estimate and keeps the report', () => {
  const ev = { source: 'ai', score: 3.8, recommendation: 'consider', rows: [{ requirement: 'Go' }], match: { score: 70, present: [] } }
  const rec = evaluationRecord(ev)
  assert.equal(rec.match, undefined)
  assert.equal(rec.kind, 'ai')
  assert.deepEqual([rec.source, rec.score, rec.recommendation, rec.rows.length], ['ai', 3.8, 'consider', 1])
})

test('profile form: lists split on commas and new lines, blanks become unset', () => {
  assert.deepEqual(splitList(' DE, US\nFR ,, '), ['DE', 'US', 'FR'])
  const p = toProfile({ authorizedIn: 'DE, FR', needsSponsorship: true, locations: 'Berlin', remote: 'hybrid', targetRoles: '', dealBreakers: 'crypto\ngambling', salaryMin: '', currency: ' ' })
  assert.deepEqual(p, { authorizedIn: ['DE', 'FR'], needsSponsorship: true, locations: ['Berlin'], remote: 'hybrid', targetRoles: [], dealBreakers: ['crypto', 'gambling'] })
  assert.equal(toProfile({ salaryMin: '65000', currency: 'EUR' }).salaryMin, 65000)
})
