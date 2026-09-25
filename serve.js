// Zero-dependency static server for Recto. Also used by the CLI and smoke test.
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'
import { realpathSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { extractHtml } from './src/io/extract.js'

const HERE = dirname(fileURLToPath(import.meta.url))

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
}

const mimeOf = path => MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'

function send(req, res, status, body = '', type = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

// Returns an absolute file path inside root, 403 for traversal, 400 for bad encoding.
// Rejects rather than normalises: WHATWG URL parsing would silently collapse '..'.
function toFile(root, urlPath) {
  let rel
  try {
    rel = decodeURIComponent(urlPath).slice(1)
  } catch {
    return 400
  }
  if (rel === '') rel = 'index.html'
  if (rel.includes('\0') || isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) return 403
  const file = resolve(root, rel)
  return file.startsWith(root + sep) ? file : 403
}

// ---- /api/fetch: job-page proxy for local mode (assist spec 3). SSRF-safe: every hop's resolved IPs must be public.

const FETCH_CAP = 2 * 1024 * 1024
const FETCH_TIMEOUT = 10_000
const MAX_REDIRECTS = 5

// Separate lists: a BlockList checks IPv4 addresses against ::ffff:0:0/96 rules too
const PRIVATE4 = new net.BlockList()
const PRIVATE6 = new net.BlockList()
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4]]) PRIVATE4.addSubnet(a, p, 'ipv4')
// IPv4-mapped/compatible, NAT64 and 6to4 can all smuggle a private IPv4, so they are blocked wholesale
for (const [a, p] of [['::', 96], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]]) PRIVATE6.addSubnet(a, p, 'ipv6')
PRIVATE6.addAddress('::1', 'ipv6')

const LOOPBACK = new net.BlockList()
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4')
LOOPBACK.addAddress('::1', 'ipv6')
LOOPBACK.addSubnet('::ffff:127.0.0.0', 104, 'ipv6')

const family = ip => net.isIP(ip) === 6 ? 'ipv6' : 'ipv4'
const isPublicIp = ip => net.isIP(ip) === 4 ? !PRIVATE4.check(ip, 'ipv4') : net.isIP(ip) === 6 && !PRIVATE6.check(ip, 'ipv6')
const isLoopbackIp = ip => net.isIP(ip) !== 0 && LOOPBACK.check(ip, family(ip))
const bare = hostname => hostname.replace(/^\[|\]$/g, '')
const blocked = () => Object.assign(new Error('blocked'), { code: 'EBLOCKED' })

const defaultLookup = host => dnsLookup(host, { all: true, verbatim: true })

async function resolvesPublic(hostname, lookup) {
  const host = bare(hostname)
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host).catch(() => [])
  return addrs.length > 0 && addrs.every(a => isPublicIp(a.address))
}

// Node http(s) with the checked addresses pinned at connect time, so DNS cannot change between check and connect
function pinnedFetch(lookup) {
  const pin = (host, opts, cb) => lookup(host).then(all => {
    if (!all.length || !all.every(a => isPublicIp(a.address))) return cb(blocked())
    opts.all ? cb(null, all) : cb(null, all[0].address, all[0].family)
  }, cb)
  return (url, { signal, headers }) => new Promise((resolvePromise, reject) => {
    const u = new URL(url)
    const req = (u.protocol === 'https:' ? https : http).get(u, { signal, headers, lookup: pin }, res => resolvePromise({
      status: res.statusCode,
      headers: { get: name => [res.headers[name.toLowerCase()]].flat()[0] ?? null },
      body: res
    }))
    req.on('error', reject)
  })
}

function discard(body) {
  try { body?.cancel ? body.cancel().catch(() => {}) : body?.destroy?.() } catch {}
}

async function readCapped(body, cap) {
  const chunks = []
  let size = 0
  for await (const chunk of body ?? []) {
    size += chunk.length
    if (size > cap) return null // leaving the loop cancels the stream
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function decode(bytes, contentType) {
  try { return new TextDecoder(/charset=["']?([\w-]+)/i.exec(contentType ?? '')?.[1] ?? 'utf-8').decode(bytes) }
  catch { return new TextDecoder().decode(bytes) }
}

function hostIsLoopback(hostHeader) {
  try {
    const h = bare(new URL(`http://${hostHeader}`).hostname)
    return h === 'localhost' || isLoopbackIp(h)
  } catch {
    return false
  }
}

async function proxyFetch(req, res, { lookup, fetch }) {
  const reply = (status, body) => send(req, res, status, JSON.stringify(body), 'application/json; charset=utf-8')
  // A page on another origin DNS-rebound to 127.0.0.1 would arrive with its own Host header
  if (!hostIsLoopback(req.headers.host)) return reply(403, { error: 'forbidden-host' })
  let target
  try { target = new URL(new URL(req.url, 'http://localhost').searchParams.get('url')) } catch { return reply(400, { error: 'bad-url' }) }
  if (!/^https?:$/.test(target.protocol) || target.username || target.password) return reply(400, { error: 'bad-url' })
  const signal = AbortSignal.timeout(FETCH_TIMEOUT)
  try {
    for (let hop = 0; ; hop++) {
      if (!(await resolvesPublic(target.hostname, lookup))) return reply(403, { error: 'blocked' })
      const r = await fetch(target.href, { redirect: 'manual', signal, headers: { accept: 'text/html, text/plain;q=0.9', 'user-agent': 'Recto' } })
      const location = r.status >= 300 && r.status < 400 ? r.headers.get('location') : null
      if (location) {
        discard(r.body)
        if (hop === MAX_REDIRECTS) return reply(502, { error: 'too-many-redirects' })
        target = new URL(location, target)
        if (!/^https?:$/.test(target.protocol)) return reply(403, { error: 'blocked' })
        continue
      }
      if (r.status < 200 || r.status >= 300) { discard(r.body); return reply(502, { error: 'upstream', status: r.status }) }
      const contentType = (r.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
      if (!['text/html', 'application/xhtml+xml', 'text/plain'].includes(contentType)) { discard(r.body); return reply(415, { error: 'unsupported-type', contentType }) }
      const bytes = await readCapped(r.body, FETCH_CAP)
      if (!bytes) return reply(413, { error: 'too-large' })
      const raw = decode(bytes, r.headers.get('content-type'))
      return reply(200, { url: target.href, contentType, text: contentType === 'text/plain' ? raw : extractHtml(raw).text })
    }
  } catch (err) {
    if (signal.aborted) return reply(504, { error: 'timeout' })
    return reply(err?.code === 'EBLOCKED' ? 403 : 502, { error: err?.code === 'EBLOCKED' ? 'blocked' : 'upstream' })
  }
}

/** `lookup(host) → [{ address, family }]` and `fetch` are injectable for tests; /api/fetch exists only on a loopback bind. */
export function createServer({ root = HERE, extra = {}, lookup = defaultLookup, fetch = pinnedFetch(lookup) } = {}) {
  const base = resolve(root)
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, 'Method Not Allowed', undefined, { Allow: 'GET, HEAD' })
    const path = req.url.split(/[?#]/)[0]
    if (!path.startsWith('/')) return send(req, res, 400, 'Bad Request')
    if (path === '/api/fetch' && isLoopbackIp(server.address()?.address ?? '')) return proxyFetch(req, res, { lookup, fetch })
    if (Object.hasOwn(extra, path)) {
      const route = extra[path]
      const { body, type = mimeOf(path) } = typeof route === 'string' || Buffer.isBuffer(route) ? { body: route } : route
      return send(req, res, 200, body, type)
    }
    const file = toFile(base, path)
    if (file === 400) return send(req, res, 400, 'Bad Request')
    if (file === 403) return send(req, res, 403, 'Forbidden')
    try {
      if (!(await stat(file)).isFile()) return send(req, res, 404, 'Not Found')
      send(req, res, 200, await readFile(file), mimeOf(file))
    } catch {
      send(req, res, 404, 'Not Found')
    }
  })
  return server
}

export function listen(server, { host = '127.0.0.1', port = 8710, tries = 10 } = {}) {
  return new Promise((resolvePromise, reject) => {
    let attempt = 0
    const onError = err => {
      if (err.code === 'EADDRINUSE' && port !== 0 && ++attempt < tries) return server.listen(port + attempt, host)
      server.off('listening', onListening)
      reject(err)
    }
    const onListening = () => {
      server.off('error', onError)
      const actual = server.address().port
      const shown = host.includes(':') ? `[${host}]` : host
      resolvePromise({ url: `http://${shown}:${actual}`, port: actual })
    }
    server.on('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

function isMain() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isMain()) {
  const { values } = parseArgs({ options: { host: { type: 'string' }, port: { type: 'string' } } })
  const { url } = await listen(createServer(), {
    host: values.host,
    port: values.port === undefined ? undefined : Number(values.port)
  })
  console.log(`Recto running at ${url}`)
}
