import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findChrome, countPdfPages } from '../cli/chrome.js'

const CLI = fileURLToPath(new URL('../cli/recto.js', import.meta.url))
const SAMPLE = fileURLToPath(new URL('../samples/sample.cv.json', import.meta.url))
const TEMPLATES = fileURLToPath(new URL('../templates/index.json', import.meta.url))
const chrome = findChrome()
const NO_CHROME = { CHROME_PATH: '/nonexistent/recto-chrome' }

let dir

// Resolves (never rejects) with the exit code and both streams
function recto(args, env = {}) {
  return new Promise(resolve => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, timeout: 120000 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr })
    })
  })
}

const out = name => join(dir, name)
const md = async (name, text) => {
  await writeFile(out(name), text)
  return out(name)
}

before(async () => { dir = await mkdtemp(join(tmpdir(), 'recto-cli-')) })
after(() => rm(dir, { recursive: true, force: true }))

test('--help prints usage and exits 0', async () => {
  const r = await recto(['--help'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /recto export <in> -o <out>/)
})

test('usage errors exit 2 with a message on stderr', async () => {
  for (const args of [[], ['frobnicate'], ['export', SAMPLE], ['export', SAMPLE, '-o', out('x.docx')], ['check'], ['check', SAMPLE, '--bogus']]) {
    const r = await recto(args)
    assert.equal(r.code, 2, args.join(' '))
    assert.notEqual(r.stderr.trim(), '', args.join(' '))
  }
})

test('input errors exit 2: missing file, unknown extension, invalid JSON', async () => {
  assert.equal((await recto(['check', out('nope.cv.json')])).code, 2)
  assert.equal((await recto(['check', await md('cv.docx', 'x')])).code, 2)
  const bad = await recto(['check', await md('bad.json', '{ not json')])
  assert.equal(bad.code, 2)
  assert.match(bad.stderr, /JSON/)
})

test('export .cv.json → .txt starts with the name (logical order)', async () => {
  const r = await recto(['export', SAMPLE, '-o', out('x.txt')])
  assert.equal(r.code, 0, r.stderr)
  const text = await readFile(out('x.txt'), 'utf8')
  assert.ok(text.startsWith('Alex Morgan'), text.slice(0, 40))
})

test('export .cv.json → .json is JSON Resume', async () => {
  const r = await recto(['export', SAMPLE, '-o', out('x.json')])
  assert.equal(r.code, 0, r.stderr)
  const json = JSON.parse(await readFile(out('x.json'), 'utf8'))
  assert.equal(json.basics.name, 'Alex Morgan')
  assert.ok(Array.isArray(json.work) && json.work.length > 0)
})

test('export .md input works; .json input (JSON Resume) round-trips to Markdown text', async () => {
  const src = await md('sample.md', '# Jamie Doe\njamie@example.com\n\n## Experience\n### Engineer | Acme | 2020 – 2022\n- Built things\n')
  const r = await recto(['export', src, '-o', out('md.json')])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(JSON.parse(await readFile(out('md.json'), 'utf8')).basics.name, 'Jamie Doe')
  const back = await recto(['export', out('md.json'), '-o', out('back.txt')])
  assert.equal(back.code, 0, back.stderr)
  assert.match(await readFile(out('back.txt'), 'utf8'), /^Jamie Doe\n[\s\S]*Engineer/)
})

test('export → .cv.json writes a Recto container', async () => {
  const src = await md('c.md', '# Pat Lee\n')
  assert.equal((await recto(['export', src, '-o', out('c.cv.json')])).code, 0)
  const file = JSON.parse(await readFile(out('c.cv.json'), 'utf8'))
  assert.equal(file.format, 'recto')
  assert.equal(file.content, '# Pat Lee\n')
})

test('check: a javascript: link is a warning (exit 0, message printed)', async () => {
  const src = await md('js.md', '# Jamie Doe\njamie@example.com · +1 555 000 0000\n\n## Links\n- [click](javascript:alert(1))\n')
  const r = await recto(['check', src], NO_CHROME)
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /isn't allowed/)
  assert.match(r.stdout, /warn/)
  assert.match(r.stderr, /content rules only/i)
})

test('check: a document without a name exits 1', async () => {
  const src = await md('noname.md', 'jamie@example.com\n\n## Skills\n- Go\n')
  const r = await recto(['check', src], NO_CHROME)
  assert.equal(r.code, 1)
  assert.match(r.stdout, /Add your name/)
})

test('--template: unknown id exits 2', async () => {
  const r = await recto(['export', SAMPLE, '-o', out('t.txt'), '--template', 'no-such-template'])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /no-such-template/)
})

test('--template: a known template applies', { skip: !existsSync(TEMPLATES) && 'templates/index.json not present yet' }, async () => {
  const [id] = JSON.parse(await readFile(TEMPLATES, 'utf8')).templates
  const r = await recto(['export', SAMPLE, '-o', out('t.json'), '--template', id])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(JSON.parse(await readFile(out('t.json'), 'utf8')).basics.name, 'Alex Morgan')
})

test('export → .pdf through headless Chrome', { skip: !chrome && 'no Chrome/Chromium found' }, async () => {
  const r = await recto(['export', SAMPLE, '-o', out('x.pdf')])
  assert.equal(r.code, 0, r.stderr)
  assert.ok(countPdfPages(await readFile(out('x.pdf'))) >= 1)
})

test('check with Chrome runs render rules on the sample (no errors)', { skip: !chrome && 'no Chrome/Chromium found' }, async () => {
  const r = await recto(['check', SAMPLE])
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.doesNotMatch(r.stderr, /content rules only/i)
})
