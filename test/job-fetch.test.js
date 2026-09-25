import test from 'node:test'
import assert from 'node:assert/strict'
import { parseAtsUrl, fetchJob } from '../src/jobs/fetch.js'

test('Greenhouse URLs, including job-boards, EU and gh_jid query forms', () => {
  const gh = (board, id) => ({ source: 'greenhouse', apiUrl: `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}`, id })
  assert.deepEqual(parseAtsUrl('https://boards.greenhouse.io/acme/jobs/4012345'), gh('acme', '4012345'))
  assert.deepEqual(parseAtsUrl('https://job-boards.greenhouse.io/acme/jobs/4012345?utm=x'), gh('acme', '4012345'))
  assert.deepEqual(parseAtsUrl('https://job-boards.eu.greenhouse.io/acme/jobs/77'), gh('acme', '77'))
  assert.deepEqual(parseAtsUrl('https://boards.greenhouse.io/acme?gh_jid=55'), gh('acme', '55'))
  assert.deepEqual(parseAtsUrl('https://boards.greenhouse.io/embed/job_app?for=acme&token=66'), gh('acme', '66'))
  assert.deepEqual(parseAtsUrl('https://www.acme.com/careers/job?gh_jid=88'), gh('acme', '88'))
})

test('Lever and Ashby URLs', () => {
  const id = '5ac21346-8e0c-4494-8e7a-3eb92ff77902'
  assert.deepEqual(parseAtsUrl(`https://jobs.lever.co/acme/${id}`), { source: 'lever', apiUrl: `https://api.lever.co/v0/postings/acme/${id}`, id })
  assert.deepEqual(parseAtsUrl(`https://jobs.lever.co/acme/${id}/apply?lever-source=x`), { source: 'lever', apiUrl: `https://api.lever.co/v0/postings/acme/${id}`, id })
  assert.deepEqual(parseAtsUrl(`https://jobs.eu.lever.co/acme/${id}`), { source: 'lever', apiUrl: `https://api.eu.lever.co/v0/postings/acme/${id}`, id })
  assert.deepEqual(parseAtsUrl(`https://jobs.ashbyhq.com/acme/${id}`), { source: 'ashby', apiUrl: 'https://api.ashbyhq.com/posting-api/job-board/acme', id })
  assert.deepEqual(parseAtsUrl(`https://jobs.ashbyhq.com/acme/${id}/application`), { source: 'ashby', apiUrl: 'https://api.ashbyhq.com/posting-api/job-board/acme', id })
})

test('non-ATS, malformed and non-http URLs are null', () => {
  for (const u of ['https://example.com/jobs/1', 'https://boards.greenhouse.io/acme', 'https://jobs.lever.co/acme', 'not a url', 'ftp://boards.greenhouse.io/a/jobs/1', '', null]) {
    assert.equal(parseAtsUrl(u), null, String(u))
  }
})

const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
const fail = () => { throw new TypeError('Failed to fetch') }
function fakeFetch(routes) {
  const calls = []
  const f = async url => { calls.push(String(url)); const r = routes[String(url)]; return r ? r() : fail() }
  f.calls = calls
  return f
}

test('Greenhouse API → job with decoded HTML content', async () => {
  const f = fakeFetch({
    'https://boards-api.greenhouse.io/v1/boards/acme/jobs/1': () => json({
      title: 'Engineer', location: { name: 'Berlin' }, company_name: 'Acme Inc', first_published: '2026-09-01T10:00:00Z',
      content: '&lt;h2&gt;Requirements&lt;/h2&gt;&lt;ul&gt;&lt;li&gt;Go &amp;amp; SQL&lt;/li&gt;&lt;/ul&gt;'
    })
  })
  const j = await fetchJob('https://boards.greenhouse.io/acme/jobs/1', { fetch: f })
  assert.deepEqual(j, { url: 'https://boards.greenhouse.io/acme/jobs/1', source: 'greenhouse', title: 'Engineer', company: 'Acme Inc', location: 'Berlin', postedAt: '2026-09-01', text: 'Requirements\n• Go & SQL' })
})

test('Lever API → job text from description and lists', async () => {
  const f = fakeFetch({
    'https://api.lever.co/v0/postings/acme/x1': () => json({
      text: 'Designer', categories: { location: 'Remote' }, createdAt: Date.UTC(2026, 7, 20),
      descriptionPlain: 'We design things.', lists: [{ text: 'Requirements', content: '<li>Figma</li><li>Research</li>' }], additionalPlain: 'Benefits: lots.'
    })
  })
  const j = await fetchJob('https://jobs.lever.co/acme/x1', { fetch: f })
  assert.equal(j.source, 'lever')
  assert.equal(j.title, 'Designer')
  assert.equal(j.company, 'acme')
  assert.equal(j.location, 'Remote')
  assert.equal(j.postedAt, '2026-08-20')
  assert.equal(j.text, 'We design things.\n\nRequirements\n• Figma\n• Research\n\nBenefits: lots.')
})

test('Ashby API picks the job by id; a missing id falls through', async () => {
  const board = () => json({ jobs: [{ id: 'other', title: 'No' }, { id: 'j9', title: 'Analyst', location: 'NYC', descriptionHtml: '<p>Use SQL</p>', publishedAt: '2026-09-02T00:00:00Z' }] })
  const f = fakeFetch({ 'https://api.ashbyhq.com/posting-api/job-board/acme': board })
  const j = await fetchJob('https://jobs.ashbyhq.com/acme/j9', { fetch: f })
  assert.deepEqual([j.source, j.title, j.location, j.text, j.postedAt, j.company], ['ashby', 'Analyst', 'NYC', 'Use SQL', '2026-09-02', 'acme'])
  await assert.rejects(fetchJob('https://jobs.ashbyhq.com/acme/zzz', { fetch: f }), { code: 'needs-paste' })
})

test('order: ATS API fails → local proxy → webFetch → needs-paste', async () => {
  const url = 'https://boards.greenhouse.io/acme/jobs/1'
  const proxied = `http://127.0.0.1:8710/api/fetch?url=${encodeURIComponent(url)}`
  const viaProxy = fakeFetch({ [proxied]: () => json({ url, contentType: 'text/html', text: 'From proxy' }) })
  const a = await fetchJob(url, { fetch: viaProxy, proxyBase: 'http://127.0.0.1:8710' })
  assert.deepEqual([a.source, a.text, a.url], ['url', 'From proxy', url])
  assert.deepEqual(viaProxy.calls, ['https://boards-api.greenhouse.io/v1/boards/acme/jobs/1', proxied])

  const web = []
  const b = await fetchJob('https://example.com/job', { fetch: fakeFetch({}), webFetch: async u => { web.push(u); return 'From web_fetch' } })
  assert.deepEqual([b.source, b.text, web], ['url', 'From web_fetch', ['https://example.com/job']])

  const noProxy = fakeFetch({})
  await assert.rejects(fetchJob('https://example.com/job', { fetch: noProxy }), { code: 'needs-paste' })
  assert.deepEqual(noProxy.calls, [], 'no proxy call without proxyBase')
  const proxyErr = fakeFetch({ [`http://p/api/fetch?url=${encodeURIComponent('https://example.com/job')}`]: () => new Response('{"error":"blocked"}', { status: 403 }) })
  await assert.rejects(fetchJob('https://example.com/job', { fetch: proxyErr, proxyBase: 'http://p', webFetch: async () => { throw new Error('no') } }), { code: 'needs-paste' })
  await assert.rejects(fetchJob('javascript:alert(1)', { fetch: noProxy }), { code: 'needs-paste' })
})

test('an aborted fetch rejects with AbortError instead of falling through', async () => {
  const ac = new AbortController()
  ac.abort()
  const f = async (url, { signal }) => { signal.throwIfAborted() }
  await assert.rejects(fetchJob('https://example.com/x', { fetch: f, proxyBase: 'http://p', signal: ac.signal }), { name: 'AbortError' })
})
