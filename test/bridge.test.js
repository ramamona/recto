// Apply bridge in serve.js (career-suite spec §4): loopback-only, same-origin, token, JSON, 5 MB cap, one run at a time.
// A fake child stands in for `recto autoapply`, so nothing launches Chrome.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { createServer, listen } from '../serve.js'

const CLI = fileURLToPath(new URL('../cli/recto.js', import.meta.url))
const BODY = {
  jobs: [{ id: 'a', title: 'Engineer', company: 'Acme', status: 'saved', url: 'https://boards.greenhouse.io/acme/jobs/1' }, { id: 'b', title: 'Dev', company: 'Beta', status: 'saved', url: 'https://x.example/b' }],
  cv: { name: 'Me', content: '# Alex Morgan', layout: {} }, profile: { city: 'Sydney' }, mode: 'review', minScore: 4, max: 10
}

function fakeSpawner() {
  const calls = []
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stdin = new PassThrough()
    child.input = ''
    child.stdin.on('data', c => { child.input += c })
    child.killed = false
    child.kill = () => { child.killed = true; child.finish(null) }
    child.send = e => child.stdout.write(JSON.stringify(e) + '\n')
    child.finish = code => { child.stdout.end(); setImmediate(() => child.emit('close', code)) }
    calls.push({ cmd, args, opts, child })
    return child
  }
  return { spawn, calls }
}

function request(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString()
        resolve({ status: res.statusCode, json: /json/.test(res.headers['content-type']) && text ? JSON.parse(text) : null })
      })
    })
    req.on('error', err => err.code === 'EPIPE' || err.code === 'ECONNRESET' ? resolve({ status: 'reset' }) : reject(err))
    req.end(body)
  })
}

async function withBridge(fn, listenOpts = {}) {
  const fake = fakeSpawner()
  const s = createServer({ spawn: fake.spawn })
  const { port } = await listen(s, { port: 0, ...listenOpts })
  const origin = `http://127.0.0.1:${port}`
  const same = { 'sec-fetch-site': 'same-origin' }
  const token = async () => (await request(port, '/api/apply', { headers: same })).json?.token
  const post = async (path, body, headers = {}) => request(port, path, {
    method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { origin, 'content-type': 'application/json', 'x-recto-token': await token(), ...headers }
  })
  const status = async () => (await request(port, '/api/apply/status', { headers: { ...same, 'x-recto-token': await token() } })).json
  try {
    await fn({ port, origin, same, token, post, status, fake })
  } finally {
    for (const c of fake.calls) if (!c.child.killed) c.child.finish(0)
    s.closeAllConnections()
    await new Promise(r => s.close(r))
  }
}

async function until(check, what) {
  for (let i = 0; i < 200; i++) {
    const v = await check()
    if (v) return v
    await new Promise(r => setTimeout(r, 10))
  }
  assert.fail(`timed out waiting for ${what}`)
}

test('GET /api/apply returns a stable per-process token to same-origin callers only', async () => {
  await withBridge(async ({ port, origin, same, token }) => {
    const r = await request(port, '/api/apply', { headers: same })
    assert.equal(r.status, 200)
    assert.equal(r.json.bridge, true)
    assert.match(r.json.token, /^[0-9a-f]{48}$/)
    assert.equal(await token(), r.json.token)
    assert.equal((await request(port, '/api/apply', { headers: { origin } })).status, 200)
    for (const headers of [{}, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'none' }, { origin: 'http://evil.example' },
      { ...same, origin: 'http://evil.example' }, { ...same, host: 'evil.example' }, { origin: 'http://evil.example', host: 'evil.example' }]) {
      const res = await request(port, '/api/apply', { headers })
      assert.equal(res.status, 403, JSON.stringify(headers))
      assert.equal(res.json?.token, undefined)
    }
  })
})

test('the bridge does not exist on a non-loopback bind', async () => {
  await withBridge(async ({ port, same }) => {
    assert.equal((await request(port, '/api/apply', { headers: same })).status, 404)
    assert.equal((await request(port, '/api/apply', { method: 'POST', headers: { ...same, 'content-type': 'application/json' }, body: '{}' })).status, 405, 'static server only')
  }, { host: '0.0.0.0' })
})

test('POSTs need the token, the same origin, JSON, a body under 5 MB and a valid bundle; none of them spawns', async () => {
  await withBridge(async ({ post, fake }) => {
    assert.equal((await post('/api/apply', BODY, { 'x-recto-token': '' })).status, 403, 'no token')
    assert.equal((await post('/api/apply', BODY, { 'x-recto-token': 'f'.repeat(48) })).status, 403, 'wrong token')
    assert.equal((await post('/api/apply', BODY, { 'x-recto-token': 'short' })).status, 403, 'short token')
    assert.equal((await post('/api/apply', BODY, { origin: 'http://evil.example' })).status, 403, 'foreign origin')
    assert.equal((await post('/api/apply', BODY, { origin: '' , 'sec-fetch-site': 'cross-site' })).status, 403, 'cross-site')
    assert.equal((await post('/api/apply', BODY, { host: 'evil.example' })).status, 403, 'foreign host')
    assert.equal((await post('/api/apply', BODY, { 'content-type': 'text/plain' })).status, 415, 'not JSON')
    assert.equal((await post('/api/apply', 'not json')).status, 400, 'bad JSON')
    assert.equal((await post('/api/apply', { ...BODY, jobs: [] })).status, 400, 'no jobs')
    assert.equal((await post('/api/apply', { ...BODY, cv: { content: 3 } })).status, 400, 'no CV')
    assert.equal((await post('/api/apply', { ...BODY, mode: 'yolo' })).status, 400, 'bad mode')
    const big = await post('/api/apply', JSON.stringify({ ...BODY, pad: 'x'.repeat(5 * 1024 * 1024) }))
    assert.ok([413, 'reset'].includes(big.status), String(big.status))
    assert.equal((await post('/api/apply/stop', {})).status, 409, 'nothing running')
    assert.equal((await post('/api/apply/continue', { submitted: true })).status, 409, 'nothing waiting')
    assert.equal(fake.calls.length, 0)
  })
})

test('status needs the token too', async () => {
  await withBridge(async ({ port, same }) => {
    assert.equal((await request(port, '/api/apply/status', { headers: same })).status, 403)
    assert.equal((await request(port, '/api/apply/status', { headers: { 'x-recto-token': 'x' } })).status, 403)
  })
})

test('a run spawns autoapply without a shell, tracks JSON-lines progress, forwards answers and allows one run at a time', async () => {
  await withBridge(async ({ post, status, fake }) => {
    const r = await post('/api/apply', BODY)
    assert.equal(r.status, 202)
    assert.equal(fake.calls.length, 1)
    const { cmd, args, opts, child } = fake.calls[0]
    assert.equal(cmd, process.execPath)
    assert.equal(args[0], CLI)
    assert.deepEqual(args.slice(1, 2), ['autoapply'])
    assert.equal(args[2], '--bundle')
    assert.deepEqual(args.slice(4), ['--progress-json'])
    assert.ok(!opts?.shell)
    const bundle = JSON.parse(await readFile(args[3], 'utf8'))
    assert.deepEqual(bundle.jobs, BODY.jobs)
    assert.deepEqual(bundle.cv, BODY.cv)
    assert.deepEqual(bundle.profile, BODY.profile)
    assert.equal(bundle.minScore, 4)
    assert.equal(bundle.max, 10)
    assert.equal(bundle.format, 'recto-apply')

    assert.equal((await post('/api/apply', BODY)).status, 409, 'one run at a time')
    assert.equal(fake.calls.length, 1)

    let s = await status()
    assert.equal(s.running, true)
    assert.deepEqual(s.jobs.map(j => [j.id, j.state]), [['a', 'queued'], ['b', 'queued']])

    child.send({ type: 'job', id: 'a', state: 'filling' })
    child.stdout.write('not json\n')
    child.send({ type: 'wait', id: 'a' })
    s = await until(async () => { const x = await status(); return x.waiting === 'a' && x }, 'waiting')
    assert.equal(s.jobs[0].state, 'waiting-for-you')

    assert.equal((await post('/api/apply/continue', { submitted: 'yes' })).status, 400, 'boolean only')
    assert.equal((await post('/api/apply/continue', { submitted: true })).status, 200)
    assert.equal(child.input, 'y\n')
    assert.equal((await status()).waiting, null)
    child.send({ type: 'job', id: 'a', state: 'submitted', reason: '' })
    child.send({ type: 'job', id: 'b', state: 'blocked', reason: 'captcha' })
    child.send({ type: 'done', summary: { submitted: 1, blocked: 1 } })
    child.finish(0)
    s = await until(async () => { const x = await status(); return !x.running && x }, 'exit')
    assert.deepEqual(s.jobs.map(j => [j.id, j.state, j.reason ?? '']), [['a', 'submitted', ''], ['b', 'blocked', 'captcha']])
    assert.deepEqual(s.summary, { submitted: 1, blocked: 1 })
    assert.equal(s.exitCode, 0)
    await until(() => !existsSync(args[3]), 'bundle removed')

    assert.equal((await post('/api/apply', { ...BODY, mode: 'submit' })).status, 202, 'a new run after the last one ended')
    assert.deepEqual(fake.calls[1].args.slice(4), ['--progress-json', '--submit'])
  })
})

test('stop kills the run', async () => {
  await withBridge(async ({ post, status, fake }) => {
    assert.equal((await post('/api/apply', BODY)).status, 202)
    assert.equal((await post('/api/apply/stop', {})).status, 200)
    assert.equal(fake.calls[0].child.killed, true)
    const s = await until(async () => { const x = await status(); return !x.running && x }, 'stopped')
    assert.equal(s.stopped, true)
  })
})

test('two concurrent starts spawn only one run', async () => {
  await withBridge(async ({ post, fake }) => {
    const codes = (await Promise.all([post('/api/apply', BODY), post('/api/apply', BODY)])).map(r => r.status).sort()
    assert.deepEqual(codes, [202, 409])
    assert.equal(fake.calls.length, 1)
  })
})
