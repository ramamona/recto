import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '../src/model/markdown.js'

const root = new URL('..', import.meta.url).pathname
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  "font-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"

// A string literal with no interpolation, e.g. '' or `<b>x</b>`.
const LITERAL = /^\s*(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\$])*`)\s*[;,)]?\s*$/

/** Returns the offending snippets in a JS source. */
export function unsafeSinks(src) {
  const bad = []
  for (const line of src.split('\n')) {
    for (const m of line.matchAll(/\b(?:inner|outer)HTML\s*\+?=(?!=)(.*)$/g)) if (!LITERAL.test(m[1])) bad.push(m[0])
    for (const m of line.matchAll(/\binsertAdjacentHTML\(\s*[^,]*,(.*)$/g)) if (!LITERAL.test(m[1])) bad.push(m[0])
    for (const m of line.matchAll(/\b(?:eval|new\s+Function)\s*\(/g)) bad.push(m[0])
  }
  return bad
}

test('unsafeSinks flags non-literal HTML and eval, allows literals', () => {
  assert.equal(unsafeSinks("el.innerHTML = ''").length, 0)
  assert.equal(unsafeSinks('el.innerHTML = `<b>x</b>`').length, 0)
  assert.equal(unsafeSinks("if (k === 'innerHTML') throw x").length, 0)
  assert.equal(unsafeSinks('el.innerHTML = name').length, 1)
  assert.equal(unsafeSinks('el.innerHTML += `<b>${name}</b>`').length, 1)
  assert.equal(unsafeSinks('el.outerHTML = html').length, 1)
  assert.equal(unsafeSinks("el.insertAdjacentHTML('beforeend', html)").length, 1)
  assert.equal(unsafeSinks("el.insertAdjacentHTML('beforeend', '<hr>')").length, 0)
  assert.equal(unsafeSinks('eval(code)').length, 1)
  assert.equal(unsafeSinks("new Function('return 1')").length, 1)
  assert.equal(unsafeSinks('retrieval(x)').length, 0)
})

test('src never builds HTML from non-literals or evaluates code', () => {
  const files = readdirSync(join(root, 'src'), { recursive: true }).filter(f => f.endsWith('.js'))
  assert.ok(files.length > 10)
  for (const f of files) assert.deepEqual(unsafeSinks(readFileSync(join(root, 'src', f), 'utf8')), [], f)
})

test('index.html carries the exact CSP', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8')
  assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="${CSP}">`))
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>')
})

const HOSTILE = [
  '# Eve <script>alert(1)</script>',
  'Email: eve@evil.dev · [site](javascript:alert(1)) · [x](JaVaScRiPt:alert(1))',
  '',
  '## About <img src=x onerror=alert(1)>',
  '<script>alert(2)</script>',
  '- [click](javascript:alert(1)) [d](data:text/html,hi) [v](vbscript:x) [f](file:///etc/passwd)',
  '- <a href="javascript:alert(3)">a</a> <iframe src=//evil>',
  '### Role | [Org](  javascript:alert(1)) | 2020 | <b>here</b>'
].join('\n')

function hrefs(doc) {
  const out = []
  const walk = v => {
    if (Array.isArray(v)) return v.forEach(walk)
    if (v && typeof v === 'object') {
      if (typeof v.href === 'string') out.push(v.href)
      Object.values(v).forEach(walk)
    }
  }
  walk(doc)
  return out
}

function texts(doc) {
  const out = []
  const walk = v => {
    if (Array.isArray(v)) return v.forEach(walk)
    if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => typeof x === 'string' && k !== 'href' ? out.push(x) : walk(x))
  }
  walk(doc)
  return out.join('\n')
}

test('hostile Markdown yields only allow-listed link schemes', () => {
  const doc = parse(HOSTILE)
  for (const href of hrefs(doc)) assert.match(href, /^(https?:|mailto:|tel:)/i, href)
  assert.ok(doc.diagnostics.some(d => d.code === 'unsafe-link'))
})

test('hostile Markdown keeps raw HTML as literal text', () => {
  const doc = parse(HOSTILE)
  const all = texts(doc)
  assert.ok(doc.header.name.includes('<script>alert(1)</script>'))
  assert.ok(all.includes('<script>alert(2)</script>'))
  assert.ok(all.includes('<img src=x onerror=alert(1)>'))
  assert.ok(all.includes('<iframe src=//evil>'))
  assert.ok(!doc.sections.some(s => s.blocks.some(b => !['entry', 'paragraph', 'list', 'rule'].includes(b.type))))
})
