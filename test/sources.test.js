import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  SOURCES, ATS, parsePostings, parseQuestions, fetchDetails,
  COMPANIES_KEY, normalizeCompanies, loadCompanies, saveCompanies, importCompanies, exportCompanies
} from '../src/jobs/sources.js'

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/sources/${name}.json`, import.meta.url), 'utf8'))
const memory = (init = {}) => {
  const m = new Map(Object.entries(init))
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), map: m }
}
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function assertPosting(p, source, board) {
  assert.equal(p.source, source)
  assert.equal(p.board, board)
  assert.ok(p.id.startsWith(`${source}:${board}:`), p.id)
  for (const k of ['company', 'title', 'location', 'url', 'applyUrl', 'text']) assert.equal(typeof p[k], 'string', k)
  assert.ok(p.title && p.company && p.text.length > 200, `${p.id} has title, company, text`)
  assert.ok(/^https:\/\//.test(p.url) && /^https:\/\//.test(p.applyUrl), p.id)
  assert.ok(p.remote === true || p.remote === false || p.remote === null)
  assert.match(p.postedAt, ISO)
  assert.doesNotMatch(p.text, /<\/?(?:p|div|li|span|strong)\b|&lt;|&amp;|&nbsp;/, `${p.id} text is plain`)
}

test('source URLs are exactly the spec endpoints', () => {
  assert.equal(SOURCES.greenhouse.listUrl('airbnb'), 'https://boards-api.greenhouse.io/v1/boards/airbnb/jobs?content=true')
  assert.equal(SOURCES.greenhouse.detailUrl('airbnb', '8232207'), 'https://boards-api.greenhouse.io/v1/boards/airbnb/jobs/8232207?questions=true')
  assert.equal(SOURCES.lever.listUrl('palantir'), 'https://api.lever.co/v0/postings/palantir?mode=json')
  assert.equal(SOURCES.ashby.listUrl('openai'), 'https://api.ashbyhq.com/posting-api/job-board/openai?includeCompensation=true')
  assert.equal(SOURCES.remotive.listUrl('react native'), 'https://remotive.com/api/remote-jobs?search=react%20native&limit=100')
  assert.equal(SOURCES.remotive.listUrl(''), 'https://remotive.com/api/remote-jobs?search=&limit=100')
  assert.equal(SOURCES.arbeitnow.listUrl(), 'https://www.arbeitnow.com/api/job-board-api?page=1')
  assert.equal(SOURCES.arbeitnow.listUrl(3), 'https://www.arbeitnow.com/api/job-board-api?page=3')
  assert.equal(SOURCES.greenhouse.listUrl('a/b'), 'https://boards-api.greenhouse.io/v1/boards/a%2Fb/jobs?content=true')
  assert.deepEqual(ATS, ['greenhouse', 'lever', 'ashby'])
})

test('greenhouse: real board response → postings', () => {
  const ps = parsePostings('greenhouse', fixture('greenhouse'), { board: 'airbnb', name: 'Airbnb' })
  assert.equal(ps.length, 3)
  ps.forEach(p => assertPosting(p, 'greenhouse', 'airbnb'))
  const p = ps.find(p => p.id === 'greenhouse:airbnb:8214444')
  assert.equal(p.title, 'Business Systems Engineer, Tech Foundations')
  assert.equal(p.company, 'Airbnb')
  assert.equal(p.location, 'San Francisco, CA')
  assert.equal(p.remote, true) // metadata Workplace Type: Remote
  assert.equal(p.url, 'https://careers.airbnb.com/positions/8214444?gh_jid=8214444')
  assert.equal(p.applyUrl, 'https://job-boards.greenhouse.io/airbnb/jobs/8214444')
  assert.equal(p.postedAt.slice(0, 10), '2026-09-18')
  assert.equal(ps.find(p => p.id === 'greenhouse:airbnb:8214375').remote, false) // Onsite
  assert.equal(ps.find(p => p.id === 'greenhouse:airbnb:7532824').remote, false) // Hybrid
})

test('lever: real postings → postings (hosted and apply URLs, workplace type)', () => {
  const ps = parsePostings('lever', fixture('lever'), { board: 'palantir', name: 'Palantir' })
  assert.equal(ps.length, 2)
  ps.forEach(p => assertPosting(p, 'lever', 'palantir'))
  const p = ps.find(p => p.id === 'lever:palantir:6fe5515f-f677-4d98-8ac2-1775a425f5e7')
  assert.equal(p.title, 'Backend Software Engineer - Infrastructure')
  assert.equal(p.company, 'Palantir')
  assert.equal(p.location, 'New York, NY')
  assert.equal(p.remote, false) // hybrid
  assert.equal(p.url, 'https://jobs.lever.co/palantir/6fe5515f-f677-4d98-8ac2-1775a425f5e7')
  assert.equal(p.applyUrl, 'https://jobs.lever.co/palantir/6fe5515f-f677-4d98-8ac2-1775a425f5e7/apply')
  assert.equal(p.postedAt.slice(0, 10), '2025-08-06')
  const [remote] = parsePostings('lever', [{ ...fixture('lever')[0], workplaceType: 'remote', salaryRange: { min: 100000, max: 150000, currency: 'USD', interval: 'per-year-salary' } }], { board: 'palantir', name: 'Palantir' })
  assert.equal(remote.remote, true)
  assert.equal(remote.salary, '100000–150000 USD per year')
})

test('ashby: real board → postings with compensation', () => {
  const ps = parsePostings('ashby', fixture('ashby'), { board: 'openai', name: 'OpenAI' })
  assert.equal(ps.length, 3)
  ps.forEach(p => assertPosting(p, 'ashby', 'openai'))
  const se = ps.find(p => p.title === 'Software Engineer, Scaled Abuse')
  assert.equal(se.id, 'ashby:openai:3c67f712-697d-48d8-b05c-01be896e61da')
  assert.equal(se.company, 'OpenAI')
  assert.equal(se.remote, null) // not stated
  assert.equal(se.applyUrl, 'https://jobs.ashbyhq.com/openai/3c67f712-697d-48d8-b05c-01be896e61da/application')
  assert.ok(se.salary && /\$\d/.test(se.salary), se.salary)
  assert.equal(ps.find(p => p.location === 'US - Remote').remote, true)
  assert.equal(ps.find(p => /Wireless/.test(p.title)).remote, false) // OnSite
})

test('remotive: feed → remote postings with Remotive attribution', () => {
  const ps = parsePostings('remotive', fixture('remotive'))
  assert.equal(ps.length, 3)
  ps.forEach(p => assertPosting(p, 'remotive', 'remotive'))
  const p = ps.find(p => p.id === 'remotive:remotive:2091141')
  assert.equal(p.title, 'Frontend Web Application Developer')
  assert.equal(p.remote, true)
  assert.equal(p.url, p.applyUrl)
  assert.match(p.url, /^https:\/\/remotive\.com\//)
  assert.equal(p.salary, '$90k - $105k')
  assert.equal(p.postedAt, '2026-09-18T16:43:22.000Z') // no zone in the API → UTC
  assert.ok(!('salary' in ps.find(p => p.id === 'remotive:remotive:2091144')), 'empty salary is omitted')
})

test('arbeitnow: feed → postings', () => {
  const ps = parsePostings('arbeitnow', fixture('arbeitnow'))
  assert.equal(ps.length, 3)
  ps.forEach(p => assertPosting(p, 'arbeitnow', 'arbeitnow'))
  const p = ps.find(p => p.id === 'arbeitnow:arbeitnow:ai-solutions-engineer-munchen-358086')
  assert.equal(p.title, 'AI Solutions Engineer (m/w/d)')
  assert.equal(p.location, 'München')
  assert.equal(p.remote, false)
  assert.equal(p.postedAt.slice(0, 10), '2026-09-27')
  assert.equal(ps.find(p => /Influencer/.test(p.title)).remote, true)
})

test('parsePostings never throws on junk and skips jobs without id or title', () => {
  for (const source of ['greenhouse', 'lever', 'ashby', 'remotive', 'arbeitnow', 'nope']) {
    for (const junk of [null, undefined, 'x', 42, {}, [], { jobs: 'x' }, { data: {} }, [null, 1, 'a'], { jobs: [{}], data: [{}] }]) {
      assert.deepEqual(parsePostings(source, junk, { board: 'b', name: 'B' }), [], `${source} ${JSON.stringify(junk)}`)
    }
  }
  const [p] = parsePostings('lever', [{ id: 'x', text: 'Engineer', createdAt: 'garbage' }], { board: 'acme', name: 'Acme' })
  assert.equal(p.postedAt, '')
  assert.equal(p.location, '')
  assert.equal(p.remote, null)
  assert.equal(p.url, '')
})

test('parseQuestions: greenhouse detail → Question[] (hidden fields dropped, options as labels)', () => {
  const qs = parseQuestions(fixture('greenhouse-detail'))
  assert.deepEqual(qs[0], { label: 'First Name', name: 'first_name', type: 'input_text', required: true })
  const resume = qs.filter(q => q.label === 'Resume/CV')
  assert.deepEqual(resume.map(q => q.type), ['input_file', 'textarea'])
  const heard = qs.find(q => q.label === 'How did you hear about this job?')
  assert.equal(heard.required, true)
  assert.equal(heard.type, 'multi_value_single_select')
  assert.ok(heard.options.includes('Other'))
  assert.ok(qs.some(q => q.label === 'Location' && q.name === 'location'), 'location questions included')
  assert.ok(!qs.some(q => q.type === 'input_hidden'))
  assert.ok(qs.every(q => typeof q.label === 'string' && typeof q.name === 'string' && typeof q.required === 'boolean'))
  assert.deepEqual(parseQuestions(null), [])
  assert.deepEqual(parseQuestions({ questions: [null, { fields: 'x' }] }), [])
})

test('fetchDetails: greenhouse postings gain questions; others are returned untouched without a request', async () => {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, signal: init?.signal })
    return { ok: true, status: 200, json: async () => fixture('greenhouse-detail') }
  }
  const [gh] = parsePostings('greenhouse', fixture('greenhouse'), { board: 'airbnb', name: 'Airbnb' })
  const out = await fetchDetails(gh, { fetch })
  assert.equal(calls[0].url, `https://boards-api.greenhouse.io/v1/boards/airbnb/jobs/${gh.id.split(':')[2]}?questions=true`)
  assert.ok(out.questions.length > 5)
  assert.equal(out.id, gh.id)
  assert.ok(!('questions' in gh), 'input not mutated')

  const [lv] = parsePostings('lever', fixture('lever'), { board: 'palantir', name: 'Palantir' })
  assert.equal(await fetchDetails(lv, { fetch }), lv)
  assert.equal(calls.length, 1)

  const failing = async () => ({ ok: false, status: 404, json: async () => ({}) })
  await assert.rejects(fetchDetails(gh, { fetch: failing }), /HTTP 404/)
  const ctrl = new AbortController()
  const cancelled = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason))
    ctrl.abort()
  })
  await assert.rejects(fetchDetails(gh, { fetch: cancelled, signal: ctrl.signal }), { name: 'AbortError' })
})

test('companies: normalize drops junk and duplicates', () => {
  const list = normalizeCompanies([
    { source: 'greenhouse', board: ' stripe ', name: 'Stripe' },
    { source: 'greenhouse', board: 'Stripe', name: 'Dup' },
    { source: 'lever', board: 'palantir' },
    { source: 'remotive', board: 'x', name: 'X' },
    { source: 'ashby', board: '', name: 'Empty' },
    null, 'x', { source: 'ashby', board: 'openai', name: 'OpenAI', extra: 1 }
  ])
  assert.deepEqual(list, [
    { source: 'greenhouse', board: 'stripe', name: 'Stripe' },
    { source: 'lever', board: 'palantir', name: 'palantir' },
    { source: 'ashby', board: 'openai', name: 'OpenAI' }
  ])
  assert.deepEqual(normalizeCompanies('nope'), [])
})

test('companies store: starter set until saved, then the saved list; import/export round trip', () => {
  const starter = [{ source: 'greenhouse', board: 'airbnb', name: 'Airbnb' }]
  const storage = memory()
  assert.deepEqual(loadCompanies(storage, starter), starter)
  assert.deepEqual(loadCompanies(null, starter), starter)
  saveCompanies([{ source: 'lever', board: 'palantir', name: 'Palantir' }], storage)
  assert.deepEqual(JSON.parse(storage.map.get(COMPANIES_KEY)), [{ source: 'lever', board: 'palantir', name: 'Palantir' }])
  assert.deepEqual(loadCompanies(storage, starter), [{ source: 'lever', board: 'palantir', name: 'Palantir' }])
  saveCompanies([], storage)
  assert.deepEqual(loadCompanies(storage, starter), [], 'an emptied list stays empty')
  assert.deepEqual(loadCompanies(memory({ [COMPANIES_KEY]: '{bad' }), starter), starter)
  const throwing = { getItem () { throw new Error('blocked') }, setItem () { throw new Error('blocked') } }
  assert.deepEqual(loadCompanies(throwing, starter), starter)
  assert.doesNotThrow(() => saveCompanies(starter, throwing))

  const json = exportCompanies(starter)
  assert.deepEqual(JSON.parse(json), { format: 'recto-companies', version: 1, companies: starter })
  assert.deepEqual(importCompanies(json), { companies: starter, warnings: [] })
  assert.deepEqual(importCompanies(starter).companies, starter)
  assert.deepEqual(importCompanies('{bad'), { companies: [], warnings: [{ code: 'invalid-json' }] })
  assert.deepEqual(importCompanies({ nope: 1 }), { companies: [], warnings: [{ code: 'invalid-json' }] })
  const partial = importCompanies([...starter, { source: 'workday', board: 'x' }])
  assert.deepEqual(partial, { companies: starter, warnings: [{ code: 'invalid-company', index: 1 }] })
})

test('data/companies.json: ~40 verified boards across the three ATS', () => {
  const list = JSON.parse(readFileSync(new URL('../data/companies.json', import.meta.url), 'utf8'))
  assert.ok(Array.isArray(list) && list.length >= 35 && list.length <= 45, `${list.length}`)
  assert.deepEqual(normalizeCompanies(list), list, 'already normalized, no duplicates')
  for (const s of ATS) assert.ok(list.filter(c => c.source === s).length >= 8, s)
})
