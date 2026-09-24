// Zero-dependency static server for Recto. Also used by the CLI and smoke test.
import http from 'node:http'
import { realpathSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

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

export function createServer({ root = HERE, extra = {} } = {}) {
  const base = resolve(root)
  return http.createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, 'Method Not Allowed', undefined, { Allow: 'GET, HEAD' })
    const path = req.url.split(/[?#]/)[0]
    if (!path.startsWith('/')) return send(req, res, 400, 'Bad Request')
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
