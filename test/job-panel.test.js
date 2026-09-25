import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isJobUrl, probeProxy, mergeJob, withSignal, latestEvaluation } from '../src/ui/job-panel.js'

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

test('latestEvaluation picks the newest AI evaluation, ignoring local scores', () => {
  const job = { evaluations: [{ kind: 'ai', score: 3, at: '1' }, { kind: 'local', score: 80, at: '2' }, { kind: 'ai', score: 4, at: '3' }] }
  assert.equal(latestEvaluation(job).score, 4)
  assert.equal(latestEvaluation({ evaluations: [{ kind: 'local', score: 70 }] }), null)
  assert.equal(latestEvaluation(null), null)
})
