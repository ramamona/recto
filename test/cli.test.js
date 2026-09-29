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
function recto(args, env = {}, cwd) {
  return new Promise(resolve => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, timeout: 120000, cwd }, (err, stdout, stderr) => {
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
  for (const c of ['ats', 'evaluate', 'tips', 'apply', 'profile']) assert.match(r.stdout, new RegExp(`recto ${c} `))
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

const CV_MD = '# Jamie Doe\njamie@example.com · +1 555 000 0000\n\n## Experience\n### Engineer | Acme | 2020 – 2022\n- Built the billing service in Go\n- Cut deploy time by 40%\n\n## Skills\n- Go, Kubernetes\n'

test('ats --json: score, grade, checks and fields; content-only note without a browser', async () => {
  const r = await recto(['ats', SAMPLE, '--json'], NO_CHROME)
  const j = JSON.parse(r.stdout)
  assert.equal(typeof j.score, 'number')
  assert.match(j.grade, /^[A-F]$/)
  assert.ok(Array.isArray(j.checks) && j.checks.every(c => c.id && 'earned' in c && Array.isArray(c.items)))
  assert.equal(j.fields.name, 'Alex Morgan')
  assert.match(r.stderr, /content rules only/)
  assert.equal(r.code, j.grade === 'F' || j.checks.some(c => c.items.some(i => i.severity === 'critical')) ? 1 : 0)
  const text = await recto(['ats', SAMPLE], NO_CHROME)
  assert.match(text.stdout, /ATS score \d+\/100/)
})

test('ats exits 1 on an empty CV (grade F)', async () => {
  const r = await recto(['ats', await md('empty.md', '# X\n'), '--json'], NO_CHROME)
  assert.equal(JSON.parse(r.stdout).grade, 'F')
  assert.equal(r.code, 1)
})

test('evaluate --job file: rows, gates, score; text and JSON', async () => {
  const cv = await md('ev.md', CV_MD)
  const job = await md('job.txt', 'Senior Go Engineer\nRemote\nRequirements\n- 5+ years Go\n- Kubernetes required\n- Rust\n')
  const r = await recto(['evaluate', cv, '--job', job, '--json'])
  assert.equal(r.code, 0, r.stderr)
  const j = JSON.parse(r.stdout)
  for (const k of ['role', 'gates', 'rows', 'score', 'recommendation', 'legitimacy']) assert.ok(k in j, k)
  assert.ok(j.rows.some(x => x.match === 'strong'))
  const t = await recto(['evaluate', cv, '--job', job])
  assert.match(t.stdout, /Score [\d.]+\/5 → (apply|consider|skip)/)
  assert.equal((await recto(['evaluate', cv])).code, 2)
})

test('tips --json lists local suggestions', async () => {
  const r = await recto(['tips', await md('tips.md', '# Jo\n\n## Experience\n### Dev | Co | 2020\n- Responsible for very many things\n'), '--json'])
  assert.equal(r.code, 0, r.stderr)
  const codes = JSON.parse(r.stdout).map(s => s.code)
  assert.ok(codes.includes('weak-opener') && codes.includes('filler'), codes.join())
})

test('apply: writes a valid edit, refuses a fabricated number and a stale expect (exit 1)', async () => {
  const cv = await md('apply.md', CV_MD)
  const edits = await md('edits.json', JSON.stringify([
    { line: 6, expect: '- Built the billing service in Go', replacement: '- Built the Go billing service' },
    { line: 7, expect: '- Cut deploy time by 40%', replacement: '- Cut deploy time by 75%' },
    { line: 10, expect: '- Go, Kubernetes, Rust', replacement: '- Go' }
  ]))
  const r = await recto(['apply', cv, '--edits', edits, '--json'])
  assert.equal(r.code, 1)
  const j = JSON.parse(r.stdout)
  assert.deepEqual(j.applied, [6])
  assert.deepEqual(j.refused.map(x => [x.line, x.status]), [[7, 'new-facts'], [10, 'stale']])
  assert.match(r.stderr, /75%/)
  const text = await readFile(cv, 'utf8')
  assert.match(text, /- Built the Go billing service/)
  assert.match(text, /by 40%/)
})

test('apply --allow-new-facts -o writes a container elsewhere and shows a diff', async () => {
  const cv = await md('apply2.md', CV_MD)
  const edits = await md('edits2.json', JSON.stringify([{ line: 7, expect: '- Cut deploy time by 40%', replacement: '- Cut deploy time by 75%' }]))
  const r = await recto(['apply', cv, '--edits', edits, '--allow-new-facts', '-o', out('applied.cv.json')])
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /-- Cut deploy time by 40%\n\+- Cut deploy time by 75%/)
  assert.match(JSON.parse(await readFile(out('applied.cv.json'), 'utf8')).content, /75%/)
  assert.equal(await readFile(cv, 'utf8'), CV_MD)
})

test('profile: --set writes profile.json, reading it back; evaluate picks it up', async () => {
  const r = await recto(['profile', '--set', 'locations=Berlin, Remote', '--set', 'needsSponsorship=true', '--set', 'salaryMin=90000', '--json'], {}, dir)
  assert.equal(r.code, 0, r.stderr)
  const j = JSON.parse(r.stdout)
  assert.deepEqual(j.locations, ['Berlin', 'Remote'])
  assert.equal(j.needsSponsorship, true)
  assert.equal(j.salaryMin, 90000)
  assert.deepEqual(JSON.parse(await readFile(out('profile.json'), 'utf8')), j)
  const show = await recto(['profile'], {}, dir)
  assert.match(show.stdout, /locations: Berlin, Remote/)
  assert.equal((await recto(['profile', '--set', 'nokey'], {}, dir)).code, 2)
  const job = await md('nosponsor.txt', 'Go Engineer\nBerlin\nWe do not offer visa sponsorship.\n- Go\n')
  const ev = await recto(['evaluate', await md('p.md', CV_MD), '--job', job, '--json'], {}, dir)
  assert.equal(JSON.parse(ev.stdout).gates.workAuth.tier, 'no-sponsorship')
})

test('apply accepts the { suggestions: [...] } shape the review mode emits', async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { spawnSync } = await import('node:child_process')
  const dir = mkdtempSync(join(tmpdir(), 'recto-apply-'))
  writeFileSync(join(dir, 'cv.md'), '# Jane\n## Work\n- Responsible for building the API\n')
  writeFileSync(join(dir, 'e.json'), JSON.stringify({ suggestions: [{ line: 3, expect: '- Responsible for building the API', replacement: '- Built the API' }] }))
  const r = spawnSync(process.execPath, [new URL('../cli/recto.js', import.meta.url).pathname, 'apply', join(dir, 'cv.md'), '--edits', join(dir, 'e.json'), '-o', join(dir, 'out.md')])
  assert.equal(r.status, 0, String(r.stderr))
  assert.match(readFileSync(join(dir, 'out.md'), 'utf8'), /- Built the API/)
})

test('discover: scans boards and feeds offline (--fixtures), writes a tracker export of saved jobs with local evaluations', async () => {
  const fx = async name => JSON.parse(await readFile(new URL(`./fixtures/sources/${name}.json`, import.meta.url), 'utf8'))
  const now = new Date().toISOString() // keep the fixtures inside the 30-day window
  const sr = await fx('smartrecruiters')
  sr.content.forEach(c => { c.releasedDate = now })
  const jobicy = await fx('jobicy')
  jobicy.jobs.forEach(j => { j.pubDate = now })
  const SR = 'https://api.smartrecruiters.com/v1/companies/Carsales/postings'
  const routes = { [`${SR}?limit=100&offset=0&country=au`]: sr, 'https://jobicy.com/api/v2/remote-jobs?count=50&geo=australia': jobicy }
  for (const c of sr.content) routes[`${SR}/${c.id}`] = await fx('smartrecruiters-detail')
  const json = async (name, v) => { await writeFile(out(name), JSON.stringify(v)); return out(name) }
  const args = ['discover', '--cv', SAMPLE, '--profile', await json('dp.json', {}), '--companies', await json('dc.json', [{ source: 'smartrecruiters', board: 'Carsales', name: 'Carsales' }]),
    '--fixtures', await json('routes.json', routes), '--country', 'AU']
  const r = await recto([...args, '--out', out('found.json')])
  assert.equal(r.code, 0, r.stderr)
  const data = JSON.parse(await readFile(out('found.json'), 'utf8'))
  assert.equal(data.format, 'recto-jobs')
  assert.equal(data.version, 1)
  assert.equal(data.jobs.length, 6) // the Jobicy role titled "…, Singapore | APAC" is pinned to Singapore
  for (const j of data.jobs) {
    assert.equal(j.status, 'saved')
    assert.equal(j.evaluations.length, 1)
    assert.equal(j.evaluations[0].source, 'local')
    assert.ok(j.evaluations[0].score >= 1 && j.evaluations[0].score <= 5)
    assert.ok(j.title && j.company && j.url && j.applyUrl)
  }
  assert.ok(data.jobs.some(j => j.id.startsWith('smartrecruiters:Carsales:') && /Why this opportunity/.test(j.text)))
  assert.match(r.stdout, /6 jobs/)

  const high = await recto([...args, '--out', out('high.json'), '--min-score', '5'])
  assert.equal(high.code, 0, high.stderr)
  assert.ok(JSON.parse(await readFile(out('high.json'), 'utf8')).jobs.length < 6)
  assert.equal((await recto([...args, '--country', 'Narnia'])).code, 2)
  assert.equal((await recto([...args, '--min-score', 'lots'])).code, 2)
  const missing = await recto(['discover', ...args.slice(1, 5), '--companies', await json('none.json', [{ source: 'lever', board: 'nope' }]), '--fixtures', out('routes.json'), '--out', out('none-out.json')])
  assert.equal(missing.code, 0, missing.stderr)
  assert.match(missing.stderr, /lever · nope: HTTP 404/)
})
