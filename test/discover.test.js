import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse } from '../src/model/markdown.js'
import {
  discover, CONCURRENCY, TIMEOUT_MS, DISCOVER_KEY,
  normalizeDiscoverSettings, loadDiscoverSettings, saveDiscoverSettings
} from '../src/jobs/discover.js'

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/sources/${name}.json`, import.meta.url), 'utf8'))
const SOURCE = JSON.parse(readFileSync(new URL('../samples/sample.cv.json', import.meta.url), 'utf8')).content
const cv = { source: SOURCE, doc: parse(SOURCE), layout: { lang: 'en' } }
const NOW = new Date('2026-09-28T12:00:00Z')
const COMPANIES = [
  { source: 'greenhouse', board: 'airbnb', name: 'Airbnb' },
  { source: 'lever', board: 'palantir', name: 'Palantir' },
  { source: 'ashby', board: 'openai', name: 'OpenAI' }
]
const FEEDS = { remotive: { enabled: true, query: 'engineer' }, arbeitnow: { enabled: true } }
const ROUTES = {
  'https://boards-api.greenhouse.io/v1/boards/airbnb/jobs?content=true': 'greenhouse',
  'https://api.lever.co/v0/postings/palantir?mode=json': 'lever',
  'https://api.ashbyhq.com/posting-api/job-board/openai?includeCompensation=true': 'ashby',
  'https://remotive.com/api/remote-jobs?search=engineer&limit=100': 'remotive',
  'https://www.arbeitnow.com/api/job-board-api?page=1': 'arbeitnow'
}
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

function fakeFetch (overrides = {}) {
  const calls = []
  const fetch = async (url, init) => {
    calls.push(url)
    if (url in overrides) return overrides[url](init)
    return ROUTES[url] ? reply(200, fixture(ROUTES[url])) : reply(404, {})
  }
  return { fetch, calls }
}

const run = (opts = {}) => {
  const { fetch, calls } = fakeFetch(opts.overrides)
  return discover({ companies: COMPANIES, feeds: FEEDS, profile: {}, cv, tracker: [], now: NOW, fetch, ...opts }).then(r => ({ ...r, calls }))
}
const ids = r => r.results.map(x => x.posting.id).sort()

// Within 30 days of NOW in the fixtures
const RECENT = [
  'arbeitnow:arbeitnow:ai-solutions-engineer-munchen-358086',
  'arbeitnow:arbeitnow:influencer-marketing-manager-vollzeit-100-remote-dusseldorf-323221',
  'arbeitnow:arbeitnow:sales-manager-berlin-21112',
  'ashby:openai:2250282b-7f1a-43e6-bf55-e603cbf0fd89',
  'greenhouse:airbnb:8214375',
  'greenhouse:airbnb:8214444',
  'lever:palantir:2bc07b65-3f3a-4565-8d7c-d015bed92166',
  'remotive:remotive:2091131',
  'remotive:remotive:2091141',
  'remotive:remotive:2091144'
]

test('constants match the spec', () => {
  assert.equal(CONCURRENCY, 6)
  assert.equal(TIMEOUT_MS, 10000)
  assert.equal(DISCOVER_KEY, 'recto:discover')
})

test('discover: all five sources → ranked, evaluated results within 30 days', async () => {
  const r = await run()
  assert.deepEqual(r.errors, [])
  assert.deepEqual([...r.calls].sort(), Object.keys(ROUTES).sort())
  assert.deepEqual(ids(r), RECENT)
  for (const x of r.results) {
    assert.deepEqual(Object.keys(x).sort(), ['evaluation', 'legitimacy', 'match', 'posting'])
    assert.equal(x.evaluation.source, 'local')
    assert.ok(x.evaluation.score >= 1 && x.evaluation.score <= 5)
    assert.equal(x.match, x.evaluation.match)
    assert.ok(Number.isInteger(x.match.score))
    assert.equal(x.legitimacy, x.evaluation.legitimacy)
    assert.equal(x.evaluation.gates.liveness.status, 'open')
  }
  for (let i = 1; i < r.results.length; i++) {
    const a = r.results[i - 1], b = r.results[i]
    const order = b.evaluation.score - a.evaluation.score || b.match.score - a.match.score || Date.parse(b.posting.postedAt) - Date.parse(a.posting.postedAt)
    assert.ok(order <= 0, `rank ${i}: ${a.posting.id} before ${b.posting.id}`)
  }
})

test('discover: ranking ties break on match, then recency', async () => {
  const job = (id, title, postedAt) => ({ id, title, company_name: 'Acme', location: 'Remote', publication_date: postedAt, url: `https://remotive.com/remote-jobs/x/${id}`, description: '<p>Build things with care and attention to detail for our team.</p>' })
  const overrides = {
    'https://remotive.com/api/remote-jobs?search=engineer&limit=100': () => reply(200, { jobs: [job(1, 'Older Engineer', '2026-09-20T00:00:00'), job(2, 'Newer Engineer', '2026-09-26T00:00:00')] })
  }
  const r = await run({ companies: [], feeds: { remotive: FEEDS.remotive }, overrides })
  assert.deepEqual(r.results.map(x => x.posting.id), ['remotive:remotive:2', 'remotive:remotive:1'])
})

test('discover: older postings need a larger max age', async () => {
  const r = await run({ settings: { maxAgeDays: 1000 } })
  assert.equal(r.results.length, 14)
  const week = await run({ settings: { maxAgeDays: 7 } })
  assert.ok(week.results.every(x => NOW - Date.parse(x.posting.postedAt) <= 7 * 864e5))
  assert.ok(week.results.length < RECENT.length)
})

test('discover: target-role keywords must all appear in the title', async () => {
  const r = await run({ profile: { targetRoles: ['engineer'] } })
  assert.deepEqual(ids(r), [
    'arbeitnow:arbeitnow:ai-solutions-engineer-munchen-358086',
    'ashby:openai:2250282b-7f1a-43e6-bf55-e603cbf0fd89',
    'greenhouse:airbnb:8214375',
    'greenhouse:airbnb:8214444',
    'remotive:remotive:2091131'
  ])
  const two = await run({ settings: { roles: ['support engineer', 'marketing manager'] } })
  assert.deepEqual(ids(two), [
    'arbeitnow:arbeitnow:influencer-marketing-manager-vollzeit-100-remote-dusseldorf-323221',
    'greenhouse:airbnb:8214375'
  ])
})

test('discover: remote and location preferences', async () => {
  const remote = await run({ profile: { remote: 'remote' } })
  assert.deepEqual(ids(remote), [
    'arbeitnow:arbeitnow:influencer-marketing-manager-vollzeit-100-remote-dusseldorf-323221',
    'greenhouse:airbnb:8214444',
    'remotive:remotive:2091131',
    'remotive:remotive:2091141',
    'remotive:remotive:2091144'
  ])
  const onsite = await run({ profile: { remote: 'onsite', locations: ['San Francisco, CA'] } })
  assert.deepEqual(ids(onsite), ['greenhouse:airbnb:8214375'])
  const any = await run({ profile: { remote: 'any', locations: ['Berlin'] } })
  assert.deepEqual(ids(any), [
    'arbeitnow:arbeitnow:influencer-marketing-manager-vollzeit-100-remote-dusseldorf-323221',
    'arbeitnow:arbeitnow:sales-manager-berlin-21112',
    'greenhouse:airbnb:8214444',
    'remotive:remotive:2091131',
    'remotive:remotive:2091141',
    'remotive:remotive:2091144'
  ])
  // settings override the profile
  const override = await run({ profile: { remote: 'remote' }, settings: { remote: 'hybrid', locations: ['München'] } })
  assert.deepEqual(ids(override), ['arbeitnow:arbeitnow:ai-solutions-engineer-munchen-358086'])
})

test('discover: deal-breakers from the profile and the minimum score drop results', async () => {
  const r = await run({ profile: { dealBreakers: ['Palantir'] } })
  assert.deepEqual(ids(r), RECENT.filter(id => !id.startsWith('lever:')))
  const all = await run()
  const scores = all.results.map(x => x.evaluation.score).sort((a, b) => a - b)
  const min = scores[Math.floor(scores.length / 2)]
  const high = await run({ settings: { minScore: min } })
  assert.ok(high.results.length > 0 && high.results.length < all.results.length)
  assert.ok(high.results.every(x => x.evaluation.score >= min))
})

test('discover: tracker jobs are skipped unless saved; matched by id or URL', async () => {
  const tracker = [
    { id: 'greenhouse:airbnb:8214444', status: 'applied' },
    { id: 'remotive:remotive:2091141', status: 'saved' },
    { id: 'other-id', url: 'https://www.arbeitnow.com/jobs/companies/checkoutcom/sales-manager-berlin-21112', status: 'skipped' },
    { id: 'uuid-1', url: 'https://jobs.lever.co/palantir/2bc07b65-3f3a-4565-8d7c-d015bed92166', status: 'rejected' }
  ]
  const r = await run({ tracker })
  assert.deepEqual(ids(r), RECENT.filter(id => ![
    'greenhouse:airbnb:8214444', 'arbeitnow:arbeitnow:sales-manager-berlin-21112', 'lever:palantir:2bc07b65-3f3a-4565-8d7c-d015bed92166'
  ].includes(id)))
  // a tracker object works too
  const obj = await run({ tracker: { list: () => tracker } })
  assert.deepEqual(ids(obj), ids(r))
})

test('discover: de-duplicates repeated companies and the same job seen on two sources', async () => {
  const gh = fixture('greenhouse').jobs.find(j => j.id === 8214444)
  const copy = { slug: 'copy-1', company_name: 'Airbnb', title: gh.title, location: gh.location.name.trim(), remote: true, url: 'https://www.arbeitnow.com/jobs/companies/airbnb/copy-1', description: '<p>Same job, reposted by an aggregator with a few words.</p>', created_at: 1790500000 }
  const overrides = { 'https://www.arbeitnow.com/api/job-board-api?page=1': () => reply(200, { data: [copy] }) }
  const r = await run({ companies: [...COMPANIES, { source: 'greenhouse', board: 'Airbnb', name: 'Airbnb again' }], overrides })
  assert.equal(r.calls.filter(u => /greenhouse/.test(u)).length, 1)
  assert.ok(!ids(r).includes('arbeitnow:arbeitnow:copy-1'), 'the ATS copy wins')
  assert.ok(ids(r).includes('greenhouse:airbnb:8214444'))
  assert.equal(new Set(ids(r)).size, r.results.length)
})

test('discover: failures become errors and the rest still scan', async () => {
  const overrides = {
    'https://api.lever.co/v0/postings/palantir?mode=json': () => { throw new TypeError('Failed to fetch') },
    'https://api.ashbyhq.com/posting-api/job-board/openai?includeCompensation=true': () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token') } })
  }
  const r = await run({ companies: [...COMPANIES, { source: 'greenhouse', board: 'nope', name: 'Nope' }], overrides })
  assert.deepEqual(r.errors.sort((a, b) => a.board.localeCompare(b.board)), [
    { source: 'greenhouse', board: 'nope', message: 'HTTP 404' },
    { source: 'ashby', board: 'openai', message: 'Unexpected token' },
    { source: 'lever', board: 'palantir', message: 'Failed to fetch' }
  ])
  assert.ok(ids(r).includes('greenhouse:airbnb:8214444'))
  assert.ok(!ids(r).some(id => id.startsWith('lever:') || id.startsWith('ashby:')))
})

test('discover: a request slower than the timeout is aborted and reported', async () => {
  const hang = init => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))
  const r = await run({ timeoutMs: 20, overrides: { 'https://api.lever.co/v0/postings/palantir?mode=json': hang } })
  assert.deepEqual(r.errors, [{ source: 'lever', board: 'palantir', message: 'timeout' }])
  assert.ok(r.results.length > 0)
})

test('discover: at most 6 requests in flight, progress reported per request', async () => {
  let active = 0, peak = 0
  const companies = Array.from({ length: 14 }, (_, i) => ({ source: 'greenhouse', board: `c${i}`, name: `C${i}` }))
  const fetch = async () => {
    peak = Math.max(peak, ++active)
    await new Promise(resolve => setTimeout(resolve, 5))
    active--
    return reply(200, { jobs: [] })
  }
  const progress = []
  const r = await discover({ companies, feeds: FEEDS, profile: {}, cv, tracker: [], now: NOW, fetch, onProgress: p => progress.push(p) })
  assert.equal(peak, CONCURRENCY)
  assert.deepEqual(r, { results: [], errors: [] })
  assert.equal(progress.length, 17)
  assert.deepEqual(progress[0], { done: 0, total: 16 })
  assert.deepEqual(progress.at(-1).done, 16)
  assert.ok(progress.slice(1).every(p => p.total === 16 && typeof p.source === 'string' && typeof p.board === 'string'))
})

test('discover: disabled feeds are not requested; the remotive query falls back to the first role', async () => {
  const off = await run({ feeds: { remotive: { enabled: false }, arbeitnow: { enabled: false } } })
  assert.equal(off.calls.length, 3)
  const { fetch, calls } = fakeFetch()
  await discover({ companies: [], feeds: { remotive: { enabled: true, query: '' } }, profile: { targetRoles: ['Data Engineer'] }, cv, tracker: [], now: NOW, fetch })
  assert.deepEqual(calls, ['https://remotive.com/api/remote-jobs?search=Data%20Engineer&limit=100'])
})

test('discover: the caller aborting rejects with AbortError', async () => {
  const ctrl = new AbortController()
  const fetch = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason))
    ctrl.abort()
  })
  await assert.rejects(discover({ companies: COMPANIES, profile: {}, cv, now: NOW, fetch, signal: ctrl.signal }), { name: 'AbortError' })
})

test('discover: never throws on missing or junk inputs', async () => {
  const { fetch } = fakeFetch()
  assert.deepEqual(await discover({ fetch }), { results: [], errors: [] })
  const r = await discover({ companies: 'x', feeds: 7, profile: 'x', cv: null, tracker: 'x', settings: 'x', now: NOW, fetch })
  assert.deepEqual(r, { results: [], errors: [] })
  const noCv = await discover({ companies: COMPANIES, now: NOW, fetch })
  assert.equal(noCv.results.length, 4)
})

test('settings: defaults come from the profile; junk is dropped', () => {
  const profile = { targetRoles: ['Frontend Engineer'], locations: ['Berlin'], remote: 'hybrid' }
  assert.deepEqual(normalizeDiscoverSettings(null, profile), {
    roles: ['Frontend Engineer'], locations: ['Berlin'], remote: 'hybrid', maxAgeDays: 30, minScore: 0,
    feeds: { remotive: { enabled: false, query: '' }, arbeitnow: { enabled: false } }
  })
  assert.deepEqual(normalizeDiscoverSettings({
    roles: [' Designer ', 'Designer', 3], locations: [], remote: 'mars', maxAgeDays: -2, minScore: 9,
    feeds: { remotive: { enabled: true, query: ' react ' }, arbeitnow: { enabled: 'yes' } }
  }, profile), {
    roles: ['Designer'], locations: [], remote: 'hybrid', maxAgeDays: 30, minScore: 5,
    feeds: { remotive: { enabled: true, query: 'react' }, arbeitnow: { enabled: false } }
  })
  assert.equal(normalizeDiscoverSettings({ maxAgeDays: '14', minScore: '3.5' }).maxAgeDays, 14)
  assert.equal(normalizeDiscoverSettings({ minScore: '3.5' }).minScore, 3.5)
  assert.equal(normalizeDiscoverSettings({}).remote, 'any')
})

test('settings: load/save round trip through recto:discover', () => {
  const m = new Map()
  const storage = { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }
  const profile = { targetRoles: ['Engineer'] }
  assert.deepEqual(loadDiscoverSettings(storage, profile).roles, ['Engineer'])
  const saved = saveDiscoverSettings({ roles: ['Designer'], minScore: 4, feeds: { arbeitnow: { enabled: true } } }, storage)
  assert.deepEqual(JSON.parse(m.get(DISCOVER_KEY)), saved)
  assert.deepEqual(loadDiscoverSettings(storage, profile), saved)
  assert.equal(saved.feeds.arbeitnow.enabled, true)
  m.set(DISCOVER_KEY, '{bad')
  assert.deepEqual(loadDiscoverSettings(storage, profile), normalizeDiscoverSettings(null, profile))
  const throwing = { getItem () { throw new Error('blocked') }, setItem () { throw new Error('blocked') } }
  assert.deepEqual(loadDiscoverSettings(throwing, profile), normalizeDiscoverSettings(null, profile))
  assert.doesNotThrow(() => saveDiscoverSettings({}, throwing))
})
