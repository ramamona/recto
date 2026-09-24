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
