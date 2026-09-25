import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, listen } from '../serve.js'

let dir, server, port

// Raw request so the client does not normalise '..' away
function get(path, method = 'GET', p = port) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: p, path, method }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }))
    })
    req.on('error', reject)
    req.end()
  })
}

function close(s) {
  return new Promise(resolve => s.close(resolve))
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'recto-serve-'))
  const root = join(dir, 'root')
  await mkdir(join(root, 'src/model'), { recursive: true })
  await writeFile(join(root, 'index.html'), '<title>t</title>')
  await writeFile(join(root, 'src/model/categories.js'), 'export {}')
  await writeFile(join(dir, 'package.json'), '{"secret":true}')
  server = createServer({
    root,
    extra: {
      '/__cli/doc.json': { body: '{"a":1}', type: 'application/json' },
      '/raw.css': 'p{}'
    }
  })
  ;({ port } = await listen(server, { port: 0 }))
})

after(async () => {
  await close(server)
  await rm(dir, { recursive: true, force: true })
})

test('/ serves index.html as text/html with no-cache', async () => {
  const res = await get('/')
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /^text\/html/)
  assert.equal(res.headers['cache-control'], 'no-cache')
  assert.equal(res.body, '<title>t</title>')
})

test('JS modules get text/javascript, query strings ignored', async () => {
  const res = await get('/src/model/categories.js?v=1')
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /^text\/javascript/)
  assert.match((await get('/?print=/x.cv.json')).headers['content-type'], /^text\/html/)
})

test('path traversal is forbidden', async () => {
  for (const p of ['/../package.json', '/%2e%2e/package.json', '/src/..%2f..%2fpackage.json', '/%2Fetc%2Fpasswd', '/..\\package.json']) {
    const res = await get(p)
    assert.equal(res.status, 403, p)
    assert.doesNotMatch(res.body, /secret/, p)
  }
})

test('directories and missing files are 404', async () => {
  assert.equal((await get('/src/')).status, 404)
  assert.equal((await get('/src')).status, 404)
  assert.equal((await get('/nope.js')).status, 404)
})

test('extra routes are served with their type', async () => {
  const doc = await get('/__cli/doc.json')
  assert.equal(doc.status, 200)
  assert.equal(doc.headers['content-type'], 'application/json')
  assert.equal(doc.body, '{"a":1}')
  const css = await get('/raw.css')
  assert.match(css.headers['content-type'], /^text\/css/)
  assert.equal(css.body, 'p{}')
})

test('only GET and HEAD are allowed', async () => {
  const head = await get('/', 'HEAD')
  assert.equal(head.status, 200)
  assert.equal(head.body, '')
  assert.equal(head.headers['content-length'], '16')
  const post = await get('/', 'POST')
  assert.equal(post.status, 405)
  assert.equal(post.headers.allow, 'GET, HEAD')
})

test('listen moves to the next port when the port is taken', async () => {
  const other = createServer({ root: dir })
  const taken = await listen(other, { port: 0 })
  const next = createServer({ root: dir })
  const res = await listen(next, { port: taken.port })
  assert.equal(res.port, taken.port + 1)
  assert.equal(res.url, `http://127.0.0.1:${taken.port + 1}`)
  await Promise.all([close(other), close(next)])
})

test('listen rejects after the given number of tries', async () => {
  const a = createServer({ root: dir })
  const { port: p } = await listen(a, { port: 0 })
  await assert.rejects(listen(createServer({ root: dir }), { port: p, tries: 1 }), { code: 'EADDRINUSE' })
  await close(a)
})

test('node serve.js prints the URL it listens on', async () => {
  const bin = fileURLToPath(new URL('../serve.js', import.meta.url))
  const child = spawn(process.execPath, [bin, '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] })
  const line = await new Promise((resolve, reject) => {
    child.stdout.setEncoding('utf8').once('data', resolve)
    child.once('exit', code => reject(new Error(`exited ${code}`)))
  })
  child.kill()
  const m = line.match(/^Recto running at http:\/\/127\.0\.0\.1:(\d+)\n$/)
  assert.ok(m, line)
})

// ---- /api/fetch local proxy (SSRF-safe). Injected DNS + fetch: never touches the real internet.

function request(p, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: p, path, method, headers }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString()
        resolve({ status: res.statusCode, headers: res.headers, body, json: /json/.test(res.headers['content-type']) && body ? JSON.parse(body) : null })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

const DNS = {
  'public.example': [{ address: '93.184.216.34', family: 4 }],
  'public6.example': [{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }],
  'rebind.example': [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }],
  'cgnat.example': [{ address: '100.64.1.1', family: 4 }],
  'ula.example': [{ address: 'fd00::1', family: 6 }]
}
const fakeLookup = async host => {
  if (!DNS[host]) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
  return DNS[host]
}
const fetched = []
const redirect = to => new Response(null, { status: 302, headers: { location: to } })
const ROUTES = {
  'https://public.example/job': () => new Response('<html><head><title>x</title><script>evil()</script></head><body><h1>Engineer</h1><ul><li>Go</li></ul></body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }),
  'https://public6.example/plain': () => new Response('Plain JD', { headers: { 'content-type': 'text/plain' } }),
  'https://public.example/pdf': () => new Response('%PDF', { headers: { 'content-type': 'application/pdf' } }),
  'https://public.example/hop': () => redirect('/job'),
  'https://public.example/to-metadata': () => redirect('http://169.254.169.254/latest/meta-data'),
  'https://public.example/to-rebind': () => redirect('https://rebind.example/'),
  'https://public.example/loop': () => redirect('https://public.example/loop'),
  'https://public.example/big': () => new Response('x'.repeat(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'text/plain' } }),
  'https://public.example/gone': () => new Response('no', { status: 404, headers: { 'content-type': 'text/plain' } })
}
const fakeFetch = async (url, opts) => {
  fetched.push(String(url))
  assert.equal(opts.redirect, 'manual')
  assert.ok(opts.signal instanceof AbortSignal)
  return ROUTES[String(url)]()
}
// Closes the server even when an assertion fails, so a failing test cannot hang the run
async function withServer(opts, listenOpts, fn) {
  const s = createServer({ root: dir, ...opts })
  const { port: p } = await listen(s, { port: 0, ...listenOpts })
  try { await fn(p) } finally { s.closeAllConnections(); await close(s) }
}
const api = (p, url, opts) => request(p, '/api/fetch' + (url === undefined ? '' : '?url=' + encodeURIComponent(url)), opts)

test('/api/fetch returns extracted text for a public target, following safe redirects', async () => {
  await withServer({ lookup: fakeLookup, fetch: fakeFetch }, {}, async p => {
    const html = await api(p, 'https://public.example/job')
    assert.equal(html.status, 200)
    assert.deepEqual(html.json, { url: 'https://public.example/job', contentType: 'text/html', text: 'Engineer\n• Go' })
    assert.deepEqual((await api(p, 'https://public6.example/plain')).json, { url: 'https://public6.example/plain', contentType: 'text/plain', text: 'Plain JD' })
    const hop = await api(p, 'https://public.example/hop')
    assert.equal(hop.json.url, 'https://public.example/job')
    assert.equal((await api(p, 'https://public.example/pdf')).status, 415)
    assert.equal((await api(p, 'https://public.example/big')).status, 413)
    assert.equal((await api(p, 'https://public.example/gone')).status, 502)
    assert.equal((await api(p, 'https://public.example/loop')).status, 502)
    assert.equal(fetched.filter(u => u.endsWith('/loop')).length, 6, 'initial request + 5 redirects')
  })
})

test('/api/fetch rejects loopback, private, link-local, CGNAT, ULA and mapped targets before fetching', async () => {
  await withServer({ lookup: fakeLookup, fetch: fakeFetch }, {}, async p => {
    fetched.length = 0
    for (const u of ['http://127.0.0.1/', 'http://10.0.0.1/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/',
      'http://0.0.0.0/', 'http://192.168.1.1/', 'http://172.16.0.1/', 'http://224.0.0.1/', 'http://[fe80::1]/',
      'http://2130706433/', 'https://rebind.example/', 'https://cgnat.example/', 'https://ula.example/', 'https://nxdomain.example/']) {
      const r = await api(p, u)
      assert.equal(r.status, 403, u)
      assert.equal(r.json.error, 'blocked', u)
    }
    assert.deepEqual(fetched, [])
    for (const u of ['https://public.example/to-metadata', 'https://public.example/to-rebind']) assert.equal((await api(p, u)).status, 403, u)
    assert.deepEqual(fetched, ['https://public.example/to-metadata', 'https://public.example/to-rebind'], 'redirect targets are re-checked')
  })
})

test('/api/fetch: bad input is 400 (the app probes with HEAD), foreign Host header is 403', async () => {
  await withServer({ lookup: fakeLookup, fetch: fakeFetch }, {}, async p => {
    for (const u of [undefined, '', 'not a url', 'file:///etc/passwd', 'ftp://public.example/x', 'javascript:alert(1)', 'http://user:pw@public.example/job']) {
      assert.equal((await api(p, u)).status, 400, String(u))
    }
    const head = await api(p, undefined, { method: 'HEAD' })
    assert.equal(head.status, 400)
    assert.equal((await api(p, 'https://public.example/job', { headers: { host: 'evil.example' } })).status, 403)
    assert.equal((await api(p, 'https://public.example/job', { headers: { host: `localhost:${p}` } })).status, 200)
  })
})

test('/api/fetch resolves real hostnames: localhost is blocked', async () => {
  await withServer({ fetch: () => assert.fail('must not fetch') }, {}, async p => {
    const r = await api(p, 'http://localhost:1/')
    assert.equal(r.status, 403)
  })
})

test('/api/fetch is disabled (404) when the server is bound to a non-loopback host', async () => {
  await withServer({ lookup: fakeLookup, fetch: () => assert.fail('must not fetch') }, { host: '0.0.0.0' }, async p => {
    assert.equal((await api(p, 'https://public.example/job')).status, 404)
    assert.equal((await api(p, undefined, { method: 'HEAD' })).status, 404)
  })
})

test('/api/fetch default fetch pins the checked DNS answer: a rebind between check and connect is blocked', async () => {
  let calls = 0
  const rebinding = async () => ++calls === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]
  await withServer({ lookup: rebinding }, {}, async p => {
    const r = await api(p, 'http://sneaky.example/')
    assert.equal(r.status, 403)
    assert.equal(calls, 2)
  })
})
