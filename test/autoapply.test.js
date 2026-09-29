import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findChrome, launch, chromeArgs } from '../cli/chrome.js'
import { createServer, listen } from '../serve.js'
import { parse } from '../src/model/markdown.js'
import { DECLINE } from '../src/jobs/pack.js'
import { EEO_FIELDS } from '../src/profile.js'
import {
  applicant, resolveField, pickOption, submitGuards, countToday, detectAts, applyUrlOf, planFields, autoapply, bundleError
} from '../cli/autoapply.js'

const CLI = fileURLToPath(new URL('../cli/recto.js', import.meta.url))
const SAMPLE = fileURLToPath(new URL('../samples/sample.cv.json', import.meta.url))
const chrome = findChrome()
const NOW = new Date('2026-09-28T12:00:00Z')
const THANKS = '<!doctype html><title>Thanks</title><h1>Thank you for applying!</h1><p>Your application has been received.</p>'

// Name, email, phone and links come from the sample CV header
const PROFILE = {
  authorizedIn: ['United States'], needsSponsorship: false, linkedin: 'https://www.linkedin.com/in/alexmorgan',
  city: 'San Francisco', country: 'United States', salaryExpectation: 'USD 180,000', noticePeriod: '4 weeks', willingToRelocate: false
}
const LEVER_PACK = {
  jobId: 'lever', pdfName: 'Alex-Morgan-CV.pdf', fields: [],
  answers: [{ question: 'Why do you want to work at Acme?', type: 'textarea', required: true, answer: 'I build developer tools and Acme ships them.', source: 'ai' }]
}

let dir, server, base
const received = []

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'recto-autoapply-'))
  server = createServer({ extra: { '/__forms/received': { body: THANKS, type: 'text/html; charset=utf-8' } } })
  server.on('request', req => { if (req.url.startsWith('/__forms/received')) received.push(new URL(req.url, 'http://x').searchParams) })
  base = (await listen(server, { port: 0 })).url
  await writeFile(join(dir, 'profile.json'), JSON.stringify(PROFILE))
})
after(async () => {
  server.close()
  await rm(dir, { recursive: true, force: true })
})

const form = name => `${base}/test/fixtures/forms/${name}.html`
const job = (id, extra = {}) => ({
  id, title: `${id} engineer`, company: 'Acme', url: form(id), status: 'saved', source: 'url',
  evaluations: [{ at: NOW.toISOString(), score: 4.5 }], statusHistory: [{ status: 'saved', at: NOW.toISOString() }], ...extra
})

async function setup(name, jobs, log = []) {
  const d = join(dir, name)
  const paths = { jobs: join(d, 'jobs.json'), log: join(d, 'applications.jsonl'), outDir: join(d, 'out') }
  await rm(d, { recursive: true, force: true })
  await mkdir(d, { recursive: true })
  await writeFile(paths.jobs, JSON.stringify({ format: 'recto-jobs', version: 1, jobs }, null, 2))
  if (log.length) await writeFile(paths.log, log.map(e => JSON.stringify(e)).join('\n') + '\n')
  return paths
}

const readLog = async path => (await readFile(path, 'utf8')).trim().split('\n').map(l => JSON.parse(l))
const readJobs = async path => JSON.parse(await readFile(path, 'utf8')).jobs

function deps(answers = {}) {
  const asked = []
  return {
    asked,
    readInput: async p => JSON.parse(await readFile(p, 'utf8')),
    exportPdf: async (file, out) => writeFile(out, '%PDF-1.4 test\n'),
    launch: () => launch(), // headless, temporary profile
    ask: async q => { asked.push(q); return /Did you submit/.test(q) ? (answers[asked.filter(x => /Did you submit/.test(x)).length - 1] ?? '') : '' },
    now: () => NOW,
    print: () => {}
  }
}

const run = (paths, opts, d) => autoapply({ cv: SAMPLE, profile: join(dir, 'profile.json'), ...paths, ...opts }, d)

// ---------- pure ----------

test('applicant prefills name, email, phone and links from the CV header, profile wins', async () => {
  const file = JSON.parse(await readFile(SAMPLE, 'utf8'))
  const a = applicant({ ...PROFILE, email: 'me@work.example' }, parse(file.content))
  assert.equal(a.firstName, 'Alex')
  assert.equal(a.lastName, 'Morgan')
  assert.equal(a.email, 'me@work.example')
  assert.equal(a.phone, '+1 415 555 0142')
  assert.equal(a.github, 'https://github.com/alexmorgan')
  assert.equal(a.website, 'https://alexmorgan.dev')
  assert.equal(a.linkedin, 'https://www.linkedin.com/in/alexmorgan')
  assert.deepEqual(applicant(null, null).eeo, Object.fromEntries(EEO_FIELDS.map(k => [k, 'decline'])))
  assert.ok(EEO_FIELDS.includes('gender') && EEO_FIELDS.includes('disability'))
})

test('resolveField maps standard labels by rule, EEO to decline, and prefers pack answers', () => {
  const a = applicant(PROFILE, parse('# Alex Morgan\nalex@example.com · +1 415 555 0142'))
  const r = (label, extra = {}) => resolveField({ label, kind: 'text', options: [], ...extra }, { applicant: a })?.value
  assert.equal(r('First Name'), 'Alex')
  assert.equal(r('Full name'), 'Alex Morgan')
  assert.equal(r('Email'), 'alex@example.com')
  assert.equal(r('Location (City)'), 'San Francisco')
  assert.equal(r('Location'), 'San Francisco, United States')
  assert.equal(r('Are you willing to relocate?'), 'No')
  assert.equal(r('Will you now or in the future require sponsorship for employment visa status?'), 'No')
  assert.equal(r('Are you legally authorized to work in the United States?'), 'Yes')
  // country not named in the question or the job location → unanswered, never a guessed Yes
  assert.equal(r('Are you legally authorized to work in the country in which this job is located?'), undefined)
  assert.equal(r('Are you legally authorized to work in Germany?'), undefined)
  // same rules as the app's pack (src/jobs/pack.js): country codes and names are aliases
  const us = applicant({ authorizedIn: ['US'] }, null)
  assert.equal(resolveField({ label: 'Are you legally authorized to work in the United States?', options: ['Yes', 'No'] }, { applicant: us })?.value, 'Yes')
  assert.equal(resolveField({ label: 'Are you authorized to work in the USA?', options: [] }, { applicant: applicant({ authorizedIn: ['United States'] }, null) })?.value, 'Yes')
  assert.equal(resolveField({ label: 'Are you authorized to work with us?', options: [] }, { applicant: us }), null, 'the word "us" is not the US')
  assert.equal(resolveField({ label: 'Are you authorized to work in the country where this job is located?', options: [] },
    { applicant: a, location: 'Austin, United States' })?.value, 'Yes')
  assert.equal(r('How did you hear about this job?'), 'Company careers page')
  assert.equal(r('What is your notice period?'), '4 weeks')
  assert.equal(r('Why do you want to work here?'), undefined)
  assert.equal(r('Gender', { kind: 'select', options: ['Male', 'Female', 'Decline To Self Identify'] }), 'Decline To Self Identify')
  assert.equal(r('Veteran Status', { kind: 'select', options: ['I am not a protected veteran', "I don't wish to answer"] }), "I don't wish to answer")
  assert.equal(r('Gender', { kind: 'select', options: ['Male', 'Female'] }), undefined) // no decline option → left for the user
  // No work-auth facts in the profile → those questions stay unanswered, never guessed
  const bare = applicant({}, null)
  assert.equal(resolveField({ label: 'Do you require visa sponsorship?', kind: 'text', options: [] }, { applicant: bare }), null)
  const pack = { answers: [{ question: 'Why do you want to work at Acme?', answer: 'Because.', source: 'ai' }], fields: [{ label: 'Email', value: 'pack@example.com' }] }
  assert.deepEqual(resolveField({ label: 'Why do you want to work at Acme? *', kind: 'textarea', options: [] }, { applicant: a, pack }), { value: 'Because.', source: 'ai' })
  assert.equal(resolveField({ label: 'Email', kind: 'text', options: [] }, { applicant: a, pack }).value, 'pack@example.com')
})

test('pickOption matches yes/no, decline and plain text; ignores unknowns', () => {
  assert.equal(pickOption(['Yes', 'No'], 'No'), 'No')
  assert.equal(pickOption(['Yes, I am', 'No, I am not'], 'Yes'), 'Yes, I am')
  assert.equal(pickOption(['Male', 'I do not want to answer'], 'decline'), 'I do not want to answer')
  assert.equal(pickOption(['Remote', 'San Francisco'], 'san francisco'), 'San Francisco')
  assert.equal(pickOption(['A', 'B'], 'C'), null)
})

test('submitGuards lists every failing guard', () => {
  const ok = { score: 4.5, minScore: 4, submittedToday: 0, max: 5, unfilled: [], walls: [], hasSubmit: true }
  assert.deepEqual(submitGuards(ok), [])
  assert.deepEqual(submitGuards({ ...ok, score: 3.9 }), ['score'])
  assert.deepEqual(submitGuards({ ...ok, score: null }), ['score'])
  assert.deepEqual(submitGuards({ ...ok, submittedToday: 5 }), ['daily-cap'])
  assert.deepEqual(submitGuards({ ...ok, unfilled: [{ label: 'x' }], walls: ['captcha', 'login'], hasSubmit: false }),
    ['unfilled-required', 'captcha', 'login', 'no-submit-button'])
})

test('countToday counts submitted entries on the same local day and ignores junk', () => {
  const lines = [
    { at: NOW.toISOString(), result: 'submitted' }, { at: NOW.toISOString(), result: 'filled' },
    { at: '2026-09-20T12:00:00Z', result: 'submitted' }
  ].map(e => JSON.stringify(e)).join('\n') + '\nnot json\n'
  assert.equal(countToday(lines, NOW), 1)
  assert.equal(countToday('', NOW), 0)
})

test('detectAts and applyUrlOf use the URL, then the DOM markers', () => {
  assert.equal(detectAts('https://boards.greenhouse.io/acme/jobs/1'), 'greenhouse')
  assert.equal(detectAts('https://job-boards.greenhouse.io/acme/jobs/1'), 'greenhouse')
  assert.equal(detectAts('https://jobs.lever.co/acme/abc/apply'), 'lever')
  assert.equal(detectAts('https://jobs.ashbyhq.com/acme/abc/application'), 'ashby')
  assert.equal(detectAts('http://127.0.0.1/x', { lever: true }), 'lever')
  assert.equal(detectAts('http://127.0.0.1/x'), 'generic')
  assert.equal(applyUrlOf({ url: 'https://jobs.lever.co/acme/abc' }), 'https://jobs.lever.co/acme/abc/apply')
  assert.equal(applyUrlOf({ url: 'https://jobs.ashbyhq.com/acme/abc' }), 'https://jobs.ashbyhq.com/acme/abc/application')
  assert.equal(applyUrlOf({ url: 'https://x.example/a', applyUrl: 'https://x.example/apply' }), 'https://x.example/apply')
  assert.equal(applyUrlOf({ url: 'javascript:alert(1)' }), null)
  assert.equal(applyUrlOf({}), null)
})

test('planFields lists pack entries, then rule-based fields not already covered', () => {
  const a = applicant(PROFILE, parse('# Alex Morgan\nalex@example.com'))
  const plan = planFields(a, { fields: [{ label: 'Email', value: 'p@example.com' }], answers: [{ question: 'Why us?', required: true, answer: '', source: 'unanswered' }] })
  assert.deepEqual(plan.find(p => p.label === 'Email'), { label: 'Email', value: 'p@example.com', source: 'pack' })
  assert.deepEqual(plan.find(p => p.label === 'Why us?'), { label: 'Why us?', value: '', source: 'unanswered', required: true })
  assert.equal(plan.filter(p => p.label === 'Email').length, 1)
  assert.equal(plan.find(p => p.label === 'Gender').value, DECLINE)
})

test('chromeArgs drops --headless when a visible window is asked for', () => {
  assert.ok(!chromeArgs({ platform: 'darwin', env: {}, headless: false }).some(f => f.startsWith('--headless')))
  assert.ok(chromeArgs({ platform: 'darwin', env: {} }).includes('--headless=new'))
})

// ---------- CLI ----------

function recto(args, cwd) {
  return new Promise(resolve => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, CHROME_PATH: '/nonexistent/recto-chrome' }, timeout: 60000, cwd }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr })
    })
  })
}

test('recto autoapply --dry-run prints the plan and guard decisions without a browser or side effects', async () => {
  const paths = await setup('dry', [
    job('greenhouse', { url: 'https://boards.greenhouse.io/acme/jobs/1' }),
    job('lever', { url: 'https://jobs.lever.co/acme/abc', pack: LEVER_PACK, evaluations: [{ score: 3 }] }),
    job('done', { status: 'applied' })
  ])
  const before = await readFile(paths.jobs, 'utf8')
  const r = await recto(['autoapply', '--jobs', paths.jobs, '--cv', SAMPLE, '--profile', join(dir, 'profile.json'), '--submit', '--dry-run', '--log', paths.log])
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /greenhouse engineer — Acme \(greenhouse\)/)
  assert.match(r.stdout, /https:\/\/jobs\.lever\.co\/acme\/abc\/apply/)
  assert.match(r.stdout, /First name: Alex \(profile\)/)
  assert.match(r.stdout, /Why do you want to work at Acme\?: I build developer tools/)
  assert.match(r.stdout, /would submit/)
  assert.match(r.stdout, /stop before Submit: score/)
  assert.doesNotMatch(r.stdout, /done engineer/)
  assert.equal(existsSync(paths.log), false)
  assert.equal(await readFile(paths.jobs, 'utf8'), before)
})

test('recto autoapply usage errors exit 2', async () => {
  for (const args of [['autoapply'], ['autoapply', '--jobs', 'x.json'], ['autoapply', '--jobs', 'x.json', '--cv', SAMPLE, '--max', 'lots']]) {
    const r = await recto(args)
    assert.equal(r.code, 2, args.join(' '))
    assert.match(r.stderr, /autoapply/)
  }
  const help = await recto(['autoapply', '--help'])
  assert.equal(help.code, 0)
  assert.match(help.stdout, /recto autoapply --jobs/)
})

// ---------- browser ----------

const skip = !chrome && 'no Chrome/Chromium found'

test('review mode fills every field, attaches the PDF, stops before Submit and records the answer', { skip }, async () => {
  const paths = await setup('review', [job('greenhouse'), job('lever', { pack: LEVER_PACK }), job('ashby')])
  const d = deps({ 0: 'y', 1: 'n', 2: '' })
  const results = await run(paths, {}, d)
  assert.equal(received.length, 0, 'never submits in review mode')
  assert.equal(d.asked.filter(q => /press Enter/.test(q)).length, 3)

  const [gh, lever, ashby] = results
  assert.deepEqual(results.map(r => r.ats), ['greenhouse', 'lever', 'ashby'])
  const value = (r, label) => r.fields.find(f => f.label.startsWith(label))?.value
  const unfilled = r => r.fields.filter(f => !f.value).map(f => f.label)
  assert.deepEqual(unfilled(gh), ['Cover Letter'])
  assert.deepEqual(unfilled(lever), ['Current company'])
  assert.deepEqual(unfilled(ashby), [])
  for (const r of results) assert.deepEqual(r.unfilled, [])
  assert.equal(value(gh, 'Email'), 'alex.morgan@example.com')
  assert.equal(value(gh, 'Resume/CV'), 'Alex-Morgan-CV.pdf')
  assert.equal(value(gh, 'Are you legally authorized'), 'Yes')
  assert.equal(value(gh, 'Will you now or in the future'), 'No')
  assert.equal(value(gh, 'How did you hear'), 'Company careers page')
  assert.equal(value(gh, 'Gender'), 'Decline To Self Identify')
  assert.equal(value(gh, 'Disability Status'), 'I do not want to answer')
  assert.equal(value(lever, 'Full name'), 'Alex Morgan')
  assert.equal(value(lever, 'Are you willing to relocate?'), 'No')
  assert.equal(value(lever, 'Why do you want to work at Acme?'), LEVER_PACK.answers[0].answer)
  assert.equal(value(lever, 'Resume/CV'), 'Alex-Morgan-CV.pdf')
  assert.equal(value(ashby, 'Where are you based?'), 'San Francisco, United States')
  assert.equal(value(ashby, 'Will you now or in the future require visa sponsorship'), 'No')
  assert.equal(value(ashby, 'Gender'), 'Decline to self-identify')

  const log = await readLog(paths.log)
  assert.deepEqual(log.map(e => [e.jobId, e.mode, e.result]), [['greenhouse', 'review', 'submitted'], ['lever', 'review', 'filled'], ['ashby', 'review', 'filled']])
  assert.deepEqual(Object.keys(log[0]).sort(), ['at', 'company', 'jobId', 'mode', 'reason', 'result', 'title', 'url'])
  const jobs = await readJobs(paths.jobs)
  assert.equal(jobs[0].status, 'applied')
  assert.deepEqual(jobs[0].statusHistory.at(-1), { status: 'applied', at: NOW.toISOString() })
  assert.equal(jobs[1].status, 'saved')
})

test('--submit submits clean forms, refuses CAPTCHA and login walls, skips jobs without a URL', { skip }, async () => {
  received.length = 0
  const paths = await setup('submit', [
    job('greenhouse'), job('lever', { pack: LEVER_PACK }), job('ashby'), job('captcha'), job('login'), job('nourl', { url: '' })
  ])
  const d = deps()
  const results = await run(paths, { submit: true }, d)
  assert.deepEqual(results.map(r => [r.jobId, r.result, r.reason]), [
    ['greenhouse', 'submitted', ''], ['lever', 'submitted', ''], ['ashby', 'submitted', ''],
    ['captcha', 'blocked', 'captcha'], ['login', 'blocked', 'login, account'], ['nourl', 'skipped', 'no-apply-url']
  ])
  assert.equal(received.length, 3)
  assert.equal(received[0].get('job_application[first_name]'), 'Alex')
  assert.equal(received[0].get('job_application[resume]'), 'Alex-Morgan-CV.pdf')
  assert.equal(received[1].get('cards[3f1c][field1]'), LEVER_PACK.answers[0].answer)
  assert.equal(received[2].get('sponsorship'), 'no')
  assert.ok(received.every(q => !q.has('password')))
  for (const id of ['greenhouse', 'lever', 'ashby']) {
    const png = await readFile(join(paths.outDir, `${id}.png`))
    assert.equal(png.subarray(1, 4).toString(), 'PNG')
  }
  // blocked jobs fall back to stop-before-submit and ask the user
  assert.equal(d.asked.filter(q => /Did you submit/.test(q)).length, 2)
  const jobs = await readJobs(paths.jobs)
  assert.deepEqual(jobs.map(j => j.status), ['applied', 'applied', 'applied', 'saved', 'saved', 'saved'])
  const log = await readLog(paths.log)
  assert.deepEqual(log.map(e => e.result), ['submitted', 'submitted', 'submitted', 'blocked', 'blocked', 'skipped'])
  assert.ok(log.every(e => e.mode === 'submit'))
})

test('a page that throws mid-fill is recorded as skipped and the run continues', async () => {
  const paths = await setup('throws', [job('boom'), job('nourl', { url: '' })])
  const page = { evaluate: async () => { throw new Error('Timed out after 60000 ms') }, close: async () => {} }
  const results = await run(paths, {}, { ...deps(), launch: async () => ({ newPage: async () => page, close: async () => {} }) })
  assert.deepEqual(results.map(r => [r.jobId, r.result, r.reason]), [['boom', 'skipped', 'fill-failed'], ['nourl', 'skipped', 'no-apply-url']])
  assert.equal(results[0].error, 'Timed out after 60000 ms')
  assert.deepEqual((await readLog(paths.log)).map(e => e.reason), ['fill-failed', 'no-apply-url'])
})

test('--submit enforces the daily cap counted from the log', { skip }, async () => {
  received.length = 0
  const today = { at: NOW.toISOString(), result: 'submitted' }
  const paths = await setup('cap', [job('greenhouse'), job('ashby')], [today, today, today, today, { ...today, at: '2026-09-27T12:00:00Z' }])
  const results = await run(paths, { submit: true, max: 5 }, deps())
  assert.deepEqual(results.map(r => [r.result, r.reason]), [['submitted', ''], ['blocked', 'daily-cap']])
  assert.equal(received.length, 1)
})

// ---------- one-click apply (career-suite spec §4): bundle, progress events, answer bank, generic filler ----------

// Stand-in for src/jobs/answers.js findAnswer: exact question match, choice answers must be one of the options
const fakeFind = (bank, question, { options = [] } = {}) => {
  const entry = (bank ?? []).find(e => e.question === question)
  if (!entry || (options.length && !options.includes(entry.answer))) return null
  return { answer: entry.answer, entry }
}
const BANK = [{ question: 'Do you hold a current police check?', answer: 'Yes' }, { question: 'What is your notice period?', answer: '12 weeks' },
  { question: 'Which visa subclass do you hold?', answer: 'Subclass 482' }]

test('resolveField falls back to the answer bank after the pack and the rules', () => {
  const a = applicant({ ...PROFILE, answers: BANK }, null)
  const r = (label, extra = {}) => resolveField({ label, kind: 'text', options: [], ...extra }, { applicant: a, findAnswer: fakeFind, ...extra.ctx })
  assert.deepEqual(r('Do you hold a current police check?'), { value: 'Yes', source: 'bank' })
  assert.deepEqual(r('Do you hold a current police check?', { kind: 'choice', options: ['Yes', 'No'] }), { value: 'Yes', source: 'bank' })
  assert.deepEqual(r('What is your notice period?'), { value: '4 weeks', source: 'profile' }, 'rules win over the bank')
  assert.equal(r('What is your favourite colour?'), null)
  const pack = { answers: [{ question: 'Which visa subclass do you hold?', answer: 'None', source: 'you' }], fields: [] }
  assert.equal(r('Which visa subclass do you hold?', { ctx: { pack } }).value, 'None', 'the pack wins over the bank')
  assert.equal(resolveField({ label: 'Which visa subclass do you hold?', options: [] }, { applicant: applicant({}, null), findAnswer: fakeFind }), null)
})

test('bundleError accepts a queue bundle and names what is wrong otherwise', () => {
  const ok = { format: 'recto-apply', version: 1, jobs: [{ id: 'a' }], cv: { name: 'Me', content: '# Me', layout: {} }, profile: {}, minScore: 4, max: 10, mode: 'review' }
  assert.equal(bundleError(ok), null)
  assert.equal(bundleError({ jobs: [{}], cv: { content: '' } }), null, 'optional fields may be missing')
  for (const bad of [null, [], 'x', { ...ok, jobs: [] }, { ...ok, jobs: 'x' }, { ...ok, jobs: [1] }, { ...ok, jobs: Array(201).fill({}) },
    { ...ok, cv: null }, { ...ok, cv: { content: 1 } }, { ...ok, profile: [] }, { ...ok, minScore: 'high' }, { ...ok, minScore: 9 },
    { ...ok, max: -1 }, { ...ok, max: 1.5 }, { ...ok, mode: 'yolo' }]) {
    assert.match(bundleError(bad) ?? '', /\w/, JSON.stringify(bad)?.slice(0, 60))
  }
})

test('detectAts names SmartRecruiters and Workable hosts', () => {
  assert.equal(detectAts('https://jobs.smartrecruiters.com/Canva/123'), 'smartrecruiters')
  assert.equal(detectAts('https://apply.workable.com/acme/j/ABC/'), 'workable')
})

// A form page that records what autoapply does to it; `fields` as inPage('scan') describes them
function fakePage(fields, calls) {
  const state = fields.map(f => ({ required: false, options: [], value: '', name: '', ...f }))
  return {
    evaluate: async expr => {
      const [, action, arg] = /\)\("(\w+)", (.*)\)$/s.exec(expr)
      calls.push(action)
      if (action === 'fill') for (const { key, value } of JSON.parse(arg)) state.find(f => f.key === key).value = value
      return action === 'scan' ? { fields: state.map(f => ({ ...f })), walls: [], ats: {}, submit: true } : true
    },
    setFileInputFiles: async (sel, files) => {
      calls.push('attach')
      state.find(f => sel.includes(`"${f.key}"`)).value = files[0].split(/[\\/]/).pop()
    },
    click: async () => calls.push('click'),
    screenshot: async () => Buffer.from('png'),
    close: async () => {}
  }
}
const FORM = [
  { key: 'f0', kind: 'text', label: 'First name', required: true },
  { key: 'f1', kind: 'text', label: 'Do you hold a current police check?', required: true },
  { key: 'f2', kind: 'file', label: 'Resume/CV', required: true }
]

async function bundleSetup(name, jobs, extra = {}) {
  const paths = await setup(name, [])
  const cv = JSON.parse(await readFile(SAMPLE, 'utf8'))
  const bundle = join(dir, name, 'recto-apply.json')
  await writeFile(bundle, JSON.stringify({ format: 'recto-apply', version: 1, jobs, cv: { name: cv.name, content: cv.content, layout: cv.layout }, profile: { ...PROFILE, answers: BANK }, ...extra }))
  return { ...paths, bundle }
}

function fakeDeps(pages, answers = []) {
  const calls = [], events = [], asked = []
  return {
    calls, events, asked,
    readInput: () => assert.fail('a bundle carries its CV'),
    exportPdf: async (file, out) => writeFile(out, '%PDF-1.4 test\n'),
    launch: async () => ({ newPage: async () => pages.shift(), close: async () => {} }),
    ask: async q => { asked.push(q); return answers.shift() ?? '' },
    emit: e => events.push(e),
    findAnswer: fakeFind,
    now: () => NOW,
    print: () => {}
  }
}

test('the generic filler fills by label from rules and the bank, attaches the CV and never submits, even with --submit', async () => {
  const jobs = [job('sr', { url: 'https://jobs.smartrecruiters.com/Acme/123' }), job('other', { url: 'https://careers.example/apply' })]
  const paths = await bundleSetup('generic', jobs)
  const calls = []
  const d = fakeDeps([fakePage(FORM, calls), fakePage(FORM, calls)])
  const results = await autoapply({ bundle: paths.bundle, log: paths.log, outDir: paths.outDir, submit: true }, d)
  assert.deepEqual(results.map(r => [r.jobId, r.ats, r.result, r.reason]), [['sr', 'smartrecruiters', 'blocked', 'unsupported-ats'], ['other', 'generic', 'blocked', 'unsupported-ats']])
  assert.ok(!calls.includes('click'), 'never clicks Submit')
  assert.equal(calls.filter(c => c === 'attach').length, 2)
  const value = label => results[0].fields.find(f => f.label === label).value
  assert.equal(value('First name'), 'Alex')
  assert.equal(value('Do you hold a current police check?'), 'Yes')
  assert.equal(value('Resume/CV'), 'Alex-Morgan-CV.pdf')
  assert.equal(d.asked.length, 4, 'hands every job back to the user')
  assert.deepEqual((await readJobs(paths.bundle)).map(j => j.status), ['saved', 'saved'])
})

test('--progress-json emits job states, one wait per job answered by a y/n line, then a summary; the bundle is the tracker file', async () => {
  const jobs = [job('gh', { url: 'https://boards.greenhouse.io/acme/jobs/1' }), job('wk', { url: 'https://apply.workable.com/acme/j/1/' }), job('nourl', { url: '' })]
  const paths = await bundleSetup('progress', jobs, { minScore: 4, max: 10 })
  const calls = []
  const d = fakeDeps([fakePage(FORM, calls), fakePage(FORM, calls)], ['y', 'n'])
  await autoapply({ bundle: paths.bundle, log: paths.log, outDir: paths.outDir, progressJson: true }, d)
  assert.deepEqual(d.events, [
    { type: 'job', id: 'gh', state: 'queued' }, { type: 'job', id: 'wk', state: 'queued' }, { type: 'job', id: 'nourl', state: 'queued' },
    { type: 'job', id: 'gh', state: 'filling' }, { type: 'wait', id: 'gh' }, { type: 'job', id: 'gh', state: 'submitted', reason: '' },
    { type: 'job', id: 'wk', state: 'filling' }, { type: 'wait', id: 'wk' }, { type: 'job', id: 'wk', state: 'filled', reason: '' },
    { type: 'job', id: 'nourl', state: 'skipped', reason: 'no-apply-url' },
    { type: 'done', summary: { submitted: 1, filled: 1, skipped: 1 } }
  ])
  assert.equal(d.asked.length, 2, 'one y/n line per waiting job')
  const saved = await readJobs(paths.bundle)
  assert.deepEqual(saved.map(j => j.status), ['applied', 'saved', 'saved'])
  assert.deepEqual(saved[0].statusHistory.at(-1), { status: 'applied', at: NOW.toISOString() })
})

test('bundle minScore and max apply unless the flags override them', async () => {
  const jobs = [job('gh', { url: 'https://boards.greenhouse.io/acme/jobs/1', evaluations: [{ score: 4.2 }] })]
  const paths = await bundleSetup('limits', jobs, { minScore: 4.5, max: 10 })
  const run1 = await autoapply({ bundle: paths.bundle, log: paths.log, outDir: paths.outDir, submit: true }, fakeDeps([fakePage(FORM.slice(0, 2), [])]))
  assert.deepEqual(run1.map(r => [r.result, r.reason]), [['blocked', 'score']])
  const run2 = await autoapply({ bundle: paths.bundle, log: paths.log, outDir: paths.outDir, submit: true, minScore: 4, max: 0 }, fakeDeps([fakePage(FORM.slice(0, 2), [])]))
  assert.deepEqual(run2.map(r => [r.result, r.reason]), [['blocked', 'daily-cap']])
})

test('recto autoapply --bundle --progress-json keeps stdout to JSON lines; a malformed bundle exits 2', async () => {
  const paths = await bundleSetup('cli-bundle', [job('greenhouse', { url: 'https://boards.greenhouse.io/acme/jobs/1' })])
  const r = await recto(['autoapply', '--bundle', paths.bundle, '--progress-json', '--dry-run', '--log', paths.log])
  assert.equal(r.code, 0, r.stderr)
  const events = r.stdout.trim().split('\n').map(l => JSON.parse(l))
  assert.deepEqual(events.at(-1), { type: 'done', summary: {} })
  assert.ok(events.every(e => ['job', 'wait', 'done'].includes(e.type)))
  assert.match(r.stderr, /First name: Alex \(profile\)/)
  const bad = join(dir, 'cli-bundle', 'bad.json')
  await writeFile(bad, JSON.stringify({ jobs: 'x', cv: {} }))
  const r2 = await recto(['autoapply', '--bundle', bad])
  assert.equal(r2.code, 2)
  assert.match(r2.stderr, /bundle/)
})

test('learnedAnswers: only questions the user answered in the browser, never secrets or files', async () => {
  const { learnedAnswers } = await import('../cli/autoapply.js')
  const filled = [{ key: 'k1', label: 'Email', value: 'a@b.co' }, { key: 'k2', label: 'Do you hold a police check?', value: '' },
    { key: 'k3', label: 'Password', value: '' }, { key: 'k4', label: 'CV', kind: 'file', value: '' }, { key: 'k5', label: 'Years with Go?', value: '' }]
  const latest = [{ key: 'k1', label: 'Email', value: 'a@b.co' }, { key: 'k2', label: 'Do you hold a police check?', kind: 'select', value: 'Yes', options: ['Yes', 'No'] },
    { key: 'k3', label: 'Password', kind: 'password', value: 'hunter2' }, { key: 'k4', label: 'CV', kind: 'file', value: 'cv.pdf' },
    { key: 'k5', label: 'Years with Go?', value: '' }, { key: 'k6', label: 'Tax file number', value: '123' }]
  assert.deepEqual(learnedAnswers(filled, latest), [{ question: 'Do you hold a police check?', answer: 'Yes', options: ['Yes', 'No'] }])
  assert.deepEqual(learnedAnswers(filled, undefined), [])
})
