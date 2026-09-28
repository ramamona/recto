import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createAssist, coverLetterDoc } from '../src/ai/assist.js'
import { parse } from '../src/model/markdown.js'

const SAMPLE = JSON.parse(readFileSync(new URL('../samples/sample.cv.json', import.meta.url), 'utf8')).content
const LINE = SAMPLE.split('\n').findIndex(l => l.startsWith('- Mentored')) + 1
const EXPECT = SAMPLE.split('\n')[LINE - 1]
const state = { content: SAMPLE, doc: parse(SAMPLE), layout: { lang: 'en' } }
const JOB = { title: 'Staff Engineer', company: 'Globex', text: 'Go, Kubernetes', keywords: ['Kubernetes'] }

function fakeClient (...replies) {
  const calls = []
  return {
    calls,
    async complete (req) {
      calls.push(req)
      const r = replies.shift()
      if (r instanceof Error) throw r
      return typeof r === 'string' ? { text: r } : r
    },
  }
}
const suggestion = (o = {}) => ({ line: LINE, expect: EXPECT, replacement: '- Mentored five engineers, two of whom were promoted to senior', reason: 'Clearer', category: 'clarity', ...o })
const assist = client => createAssist({ client, getState: () => state })

test('suggest with valid JSON returns validated suggestions', async () => {
  const client = fakeClient(JSON.stringify({ suggestions: [suggestion()] }))
  const { suggestions } = await assist(client).suggest()
  assert.equal(suggestions.length, 1)
  assert.equal(suggestions[0].status, 'ok')
  assert.equal(client.calls.length, 1)
  assert.ok(client.calls[0].json)
  assert.ok(client.calls[0].system.includes('Only rephrase'))
})

test('structured json from the client is used directly', async () => {
  const client = fakeClient({ text: '', json: { suggestions: [suggestion()] } })
  assert.equal((await assist(client).suggest()).suggestions.length, 1)
})

test('fenced JSON parses', async () => {
  const client = fakeClient('Here you go:\n```json\n' + JSON.stringify({ suggestions: [suggestion()] }) + '\n```')
  assert.equal((await assist(client).suggest()).suggestions[0].status, 'ok')
})

test('stale and fabricated suggestions are marked', async () => {
  const client = fakeClient(JSON.stringify({ suggestions: [
    suggestion({ expect: '- something else' }),
    suggestion({ replacement: '- Mentored 47 engineers at Initech' }),
  ] }))
  const { suggestions } = await assist(client).suggest()
  assert.deepEqual(suggestions.map(s => s.status), ['stale', 'new-facts'])
})

test('malformed then valid: one retry carrying the parse error', async () => {
  const client = fakeClient('not json at all', JSON.stringify({ suggestions: [suggestion()] }))
  const { suggestions } = await assist(client).rewrite([LINE], 'shorter')
  assert.equal(suggestions.length, 1)
  assert.equal(client.calls.length, 2)
  const retry = client.calls[1].messages
  assert.equal(retry.at(-2).role, 'assistant')
  assert.equal(retry.at(-2).content, 'not json at all')
  assert.match(retry.at(-1).content, /not valid JSON/)
})

test('wrong shape counts as malformed', async () => {
  const client = fakeClient('{"foo": 1}', JSON.stringify({ suggestions: [] }))
  assert.deepEqual((await assist(client).suggest()).suggestions, [])
  assert.equal(client.calls.length, 2)
})

test('malformed twice gives a readable error', async () => {
  const client = fakeClient('nope', '{ still nope')
  await assert.rejects(assist(client).suggest(), err => err.code === 'bad-response' && /couldn't be read/.test(err.message))
  assert.equal(client.calls.length, 2)
})

test('client errors pass through without retry', async () => {
  const client = fakeClient(Object.assign(new Error('bad key'), { code: 'auth' }))
  await assert.rejects(assist(client).suggest(), { code: 'auth' })
  assert.equal(client.calls.length, 1)
})

test('no client gives a readable error', async () => {
  await assert.rejects(createAssist({ client: null, getState: () => state }).suggest(), { code: 'no-client' })
})

test('tailor returns suggestions plus keywordsAdded and summary; job keywords are allowed facts', async () => {
  const client = fakeClient(JSON.stringify({
    suggestions: [suggestion({ replacement: '- Mentored five engineers on Kubernetes; two promoted to senior' })],
    keywordsAdded: ['Kubernetes'], summary: 'Tuned for platform work',
  }))
  const r = await assist(client).tailor(JOB)
  assert.deepEqual(r.keywordsAdded, ['Kubernetes'])
  assert.equal(r.summary, 'Tuned for platform work')
  assert.equal(r.suggestions.length, 1)
  assert.ok(client.calls[0].messages[0].content.includes('Go, Kubernetes'))
})

test('evaluate merges AI over the local evaluation; unquotable evidence is dropped', async () => {
  const lines = SAMPLE.split('\n')
  const k8s = lines.findIndex(l => l.includes('Kubernetes')) + 1
  const local = {
    source: 'local', role: { archetype: 'engineering', seniority: 'staff', remote: 'unknown', tldr: 'Local' },
    gates: { liveness: { status: 'unknown', quote: '' }, geo: null, workAuth: { tier: 'no-sponsorship', quote: 'No sponsorship.' }, dealBreakers: null },
    rows: [
      { requirement: 'Kubernetes', jdSignal: 'Kubernetes in production', importance: 'critical', match: 'missing', keywords: ['Kubernetes'], evidence: null },
      { requirement: 'Go', jdSignal: 'Go', importance: 'high', match: 'missing', keywords: ['Go'], evidence: null },
      { requirement: 'Rust', jdSignal: 'Rust', importance: 'meaningful', match: 'missing', keywords: ['Rust'], evidence: null }
    ],
    dropped: 0, score: 1.5, recommendation: 'skip', caps: ['no-sponsorship'], legitimacy: { level: 'ok', signals: [] }, match: { score: 40 }
  }
  const reply = {
    score: 4.6, recommendation: 'apply', role: { archetype: 'data', seniority: 'wizard', remote: 'full', tldr: 'Platform role' },
    rows: [
      { jdSignal: 'kubernetes in production ', importance: 'meaningful', match: 'strong', evidence: { line: k8s, text: 'Kubernetes' } },
      { jdSignal: 'Go', match: 'strong', evidence: { line: 3, text: 'Built compilers at Google for 10 years' } },
      { jdSignal: 'Invented row', importance: 'critical', match: 'strong', evidence: { line: 1, text: '# Alex Morgan' } }
    ],
    gaps: ['Rust'], pitch: 'Hi'
  }
  const client = fakeClient(JSON.stringify(reply))
  const r = await assist(client).evaluate(JOB, { local })
  assert.equal(r.source, 'ai')
  assert.ok(client.calls[0].messages[0].content.includes('[critical] Kubernetes in production'))
  assert.deepEqual(r.role, { archetype: 'data', seniority: 'staff', remote: 'full', tldr: 'Platform role' })
  const [kube, go, rust] = r.rows
  assert.equal(kube.importance, 'critical', 'importance stays local (pass 1)')
  assert.equal(kube.match, 'strong')
  assert.deepEqual(kube.evidence, { line: k8s, text: lines[k8s - 1] })
  assert.equal(go.match, 'missing', 'unquotable evidence → AI match claim dropped')
  assert.equal(go.evidence, null)
  assert.equal(rust.match, 'missing')
  assert.equal(r.rows.length, 3, 'rows the local pass did not find are not invented')
  assert.equal(r.score, 1.5, 'local caps still apply')
  assert.equal(r.recommendation, 'skip')
  assert.deepEqual(r.gates, local.gates)
  assert.deepEqual([r.gaps, r.pitch], [['Rust'], 'Hi'])
})

test('evaluate without a local evaluation computes one; old-shape replies still merge', async () => {
  const job = { ...JOB, text: 'Requirements\n- Must know Kubernetes\n- Go experience' }
  const client = fakeClient(JSON.stringify({ score: 9, recommendation: 'apply', summary: 'Good', requirements: [] }))
  const r = await assist(client).evaluate(job)
  assert.equal(r.source, 'ai')
  assert.equal(r.score, 5)
  assert.equal(r.recommendation, 'apply')
  assert.equal(r.rows.find(x => /Kubernetes/.test(x.jdSignal)).importance, 'critical')
})

test('coverLetter and extractJob return normalized objects', async () => {
  const cl = await assist(fakeClient(JSON.stringify({ subject: 'Staff Engineer', paragraphs: ['Dear team,', '', 7, 'Thanks.'] }))).coverLetter(JOB)
  assert.deepEqual(cl, { subject: 'Staff Engineer', paragraphs: ['Dear team,', 'Thanks.'] })
  const j = await assist(fakeClient(JSON.stringify({ title: 'Go Dev', company: 'Globex', requirements: [{ text: 'Go', kind: 'must', keywords: ['Go'] }] }))).extractJob('text')
  assert.equal(j.title, 'Go Dev')
  assert.equal(j.location, '')
  assert.deepEqual(j.keywords, [])
  assert.equal(j.requirements[0].kind, 'must')
})

test('coverLetterDoc copies the CV header and parses with 0 diagnostics', () => {
  const letter = { subject: 'Application: Staff Engineer', paragraphs: ['Dear *Globex* team,', '- I led [things](javascript:x) | fast', '## not a heading\nsecond line', 'Thanks — Alex'] }
  const out = coverLetterDoc(SAMPLE, parse(SAMPLE), letter)
  const doc = parse(out)
  assert.deepEqual(doc.diagnostics, [])
  assert.equal(doc.header.name, 'Alex Morgan')
  assert.ok(out.startsWith(SAMPLE.split('\n').slice(0, 3).join('\n') + '\n\n##\n'))
  assert.equal(doc.sections.length, 1)
  assert.equal(doc.sections[0].title, '')
  const paras = doc.sections[0].blocks
  assert.equal(paras.length, 5)
  assert.ok(paras.every(b => b.type === 'paragraph'))
})

test('coverLetterDoc without a CV header still parses', () => {
  const out = coverLetterDoc('', parse(''), { paragraphs: ['Hello'] })
  assert.deepEqual(parse(out).diagnostics, [])
})

test('the playbook loads once per assist and reaches the prompt; a failed load falls back', async () => {
  let loads = 0
  const pb = { core: 'PB-CORE', writing: 'W', grammar: 'G', modes: { review: 'M' } }
  const client = fakeClient(JSON.stringify({ suggestions: [] }), JSON.stringify({ suggestions: [] }))
  const a = createAssist({ client, getState: () => state, loadPlaybook: async () => { loads++; return pb } })
  await a.suggest()
  await a.suggest()
  assert.equal(loads, 1)
  assert.ok(client.calls[0].system.startsWith('PB-CORE'))
  assert.ok(client.calls[0].system.includes('Only rephrase'))
  const c2 = fakeClient(JSON.stringify({ suggestions: [] }))
  await createAssist({ client: c2, getState: () => state, loadPlaybook: () => { throw new Error('404') } }).suggest()
  assert.ok(c2.calls[0].system.startsWith('You are a careful CV editor'))
})

const QS = [{ label: 'Why do you want to work at Globex?' }, { label: 'Describe your mentoring experience.' }, { label: 'Anything else?' }]

test('answer drafts free-text answers aligned to the questions, via the answer schema', async () => {
  const client = fakeClient(JSON.stringify({ answers: [
    { n: 2, answer: 'I mentored engineers on the team.' },
    { n: 1, answer: 'Globex builds the kind of platform I work on.' },
  ] }))
  const { answers } = await assist(client).answer(JOB, QS, { profile: { city: 'Berlin' } })
  assert.equal(answers.length, 3)
  assert.deepEqual(answers.map(a => a.status), ['ok', 'ok', 'empty'])
  assert.equal(answers[0].answer, 'Globex builds the kind of platform I work on.')
  assert.equal(answers[2].answer, '')
  assert.equal(client.calls[0].json.title, 'answers')
  assert.match(client.calls[0].messages[0].content, /Berlin/)
})

test('answer never passes invented facts: new names or numbers are flagged, needsInput kept', async () => {
  const client = fakeClient(JSON.stringify({ answers: [
    { n: 1, answer: 'I led 47 engineers at Initech.' },
    { n: 2, answer: '', needsInput: 'How many people did you mentor?' },
    { n: 3, answer: 'I live in Berlin and can start after my notice period.' },
  ] }))
  const { answers } = await assist(client).answer(JOB, QS, { profile: { city: 'Berlin' } })
  assert.equal(answers[0].status, 'new-facts')
  assert.deepEqual(answers[0].newFacts, ['47', 'Initech'])
  assert.equal(answers[1].status, 'empty')
  assert.equal(answers[1].needsInput, 'How many people did you mentor?')
  assert.equal(answers[2].status, 'ok')
})

test('answer without a client throws no-client', async () => {
  await assert.rejects(createAssist({ client: null, getState: () => state }).answer(JOB, QS), { code: 'no-client' })
})

// ---------- career-ops modes (Task 53) ----------
import { BRIEF_MODES, NO_FABRICATION } from '../src/ai/prompts.js'
import { loadPlaybook } from '../src/ai/playbook.js'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BRIEF = { title: ' Research ', sections: [{ heading: ' Culture ', body: ' Small team. ', items: [' Remote-first ', 3, '', null] }], needsInput: ['Salary range?', 7] }
const ALL_TEXT = c => c.calls.map(r => r.system + '\n' + r.messages.map(m => m.content).join('\n')).join('\n')

test('brief: the mode list is the spec list; unknown modes are rejected before any call', async () => {
  assert.deepEqual(BRIEF_MODES, ['research', 'outreach', 'email', 'interview-prep', 'interview-plan', 'debrief', 'redflags', 'negotiate', 'offer-review', 'followup', 'compare', 'training', 'project', 'titles', 'upskill'])
  const client = fakeClient()
  await assert.rejects(assist(client).brief('hack', { job: JOB }), { code: 'bad-mode' })
  await assert.rejects(assist(client).brief('toString', { job: JOB }), { code: 'bad-mode' })
  assert.equal(client.calls.length, 0)
})

test('brief: every mode carries the rule and the brief schema, and normalizes the reply (trim, junk dropped)', async () => {
  for (const mode of BRIEF_MODES) {
    const extra = mode === 'compare' ? { jobs: [JOB, { ...JOB, title: 'Lead Engineer' }] } : {}
    const client = fakeClient(JSON.stringify({ ...BRIEF, sections: [...BRIEF.sections, 'junk', { heading: '', body: '', items: [] }] }))
    const b = await assist(client).brief(mode, { job: JOB, notes: 'n', extra })
    assert.deepEqual(b, { title: 'Research', sections: [{ heading: 'Culture', body: 'Small team.', items: ['Remote-first'] }], needsInput: ['Salary range?'] }, mode)
    assert.equal(client.calls[0].json.title, 'brief', mode)
    assert.ok(client.calls[0].system.includes(NO_FABRICATION), mode)
  }
})

test('brief: caps long strings and long lists; empty title falls back to the mode', async () => {
  const long = 'word '.repeat(2000)
  const client = fakeClient(JSON.stringify({ title: '', sections: Array.from({ length: 30 }, () => ({ heading: long, body: long, items: Array(50).fill(long) })) }))
  const b = await assist(client).brief('research', { job: JOB })
  assert.equal(b.title, 'research')
  assert.ok(b.sections.length <= 12)
  assert.ok(b.sections[0].heading.length <= 120 && b.sections[0].body.length <= 2000)
  assert.ok(b.sections[0].items.length <= 20 && b.sections[0].items[0].length <= 500)
  assert.deepEqual(b.needsInput, [])
})

test('brief: bad JSON is retried once, then a readable error', async () => {
  const client = fakeClient('nope', JSON.stringify(BRIEF))
  assert.equal((await assist(client).brief('email', { job: JOB })).title, 'Research')
  assert.equal(client.calls.length, 2)
  const c2 = fakeClient('nope', '{"title": "x"}')
  await assert.rejects(assist(c2).brief('email', { job: JOB }), { code: 'bad-response' })
})

test('brief outreach: each LinkedIn note is at most 300 chars, cut at a word boundary', async () => {
  const note = 'Hi Sam, I saw the Staff Engineer role at Globex and would love to connect about the platform team. '.repeat(5)
  const client = fakeClient(JSON.stringify({ title: 'Outreach', sections: [{ heading: 'Recruiter', body: note, items: [] }, { heading: 'Peer', body: 'Short note.', items: [] }] }))
  const b = await assist(client).brief('outreach', { job: JOB })
  const body = b.sections[0].body
  assert.ok(body.length <= 300)
  assert.ok(note.startsWith(body))
  assert.equal(note[body.length], ' ')
  assert.equal(b.sections[1].body, 'Short note.')
})

test('brief research/redflags: unverified rule and no invented URLs (URLs not in the input are removed)', async () => {
  for (const mode of ['research', 'redflags']) {
    const client = fakeClient(JSON.stringify({ title: 'R', sections: [{ heading: 'Links', body: 'See https://globex.example/careers and https://made-up.example/x', items: ['https://made-up.example/y'] }] }))
    const b = await assist(client).brief(mode, { job: { ...JOB, text: 'Apply at https://globex.example/careers' }, notes: 'They raised money last year.' })
    assert.match(ALL_TEXT(client), /unverified/i, mode)
    assert.match(ALL_TEXT(client), /They raised money last year/, mode)
    assert.equal(b.sections[0].body, 'See https://globex.example/careers and')
    assert.deepEqual(b.sections[0].items, [])
  }
})

test('brief compare: needs 2–5 jobs; the jobs reach the prompt', async () => {
  const client = fakeClient(JSON.stringify(BRIEF))
  await assert.rejects(assist(client).brief('compare', { extra: { jobs: [JOB] } }), { code: 'bad-input' })
  await assert.rejects(assist(client).brief('compare', { extra: { jobs: Array(6).fill(JOB) } }), { code: 'bad-input' })
  await assert.rejects(assist(client).brief('compare', {}), { code: 'bad-input' })
  assert.equal(client.calls.length, 0)
  await assist(client).brief('compare', { extra: { jobs: [{ ...JOB, evaluation: { score: 4.2 } }, { title: 'Data Lead', company: 'Initech' }] } })
  const t = ALL_TEXT(client)
  assert.match(t, /Data Lead/)
  assert.match(t, /4\.2/)
})

test('brief offer-review/negotiate: offer and salary fields go in; contacts and EEO do not; not legal advice', async () => {
  for (const mode of ['offer-review', 'negotiate']) {
    const client = fakeClient(JSON.stringify(BRIEF))
    await assist(client).brief(mode, { job: JOB, extra: {
      offer: { base: 150000, currency: 'AUD', clauses: 'non-compete 12 months' },
      profile: { salaryExpectation: '160k', salaryMin: 140000, currency: 'AUD', email: 'jo@doe.dev', eeo: { gender: 'Female' } },
    } })
    const t = ALL_TEXT(client)
    assert.match(t, /150000/, mode)
    assert.match(t, /non-compete/, mode)
    assert.match(t, /160k/, mode)
    assert.match(t, /140000/, mode)
    assert.ok(!t.includes('jo@doe.dev') && !t.includes('Female'), mode)
    assert.match(t, /not legal/i, mode)
  }
})

test('practice: feedback, integer score clamped to 1–5 and a next question', async () => {
  const client = fakeClient(JSON.stringify({ feedback: ' Good structure. ', score: 7.6, next: ' Tell me about a failure. ' }))
  const r = await assist(client).practice({ job: JOB, question: 'Why Globex?', answer: 'Because platforms.' })
  assert.deepEqual(r, { feedback: 'Good structure.', score: 5, next: 'Tell me about a failure.' })
  assert.match(client.calls[0].messages[0].content, /Because platforms/)
  assert.equal(client.calls[0].json.title, 'practice')
  const c2 = fakeClient('{"feedback": "x"}', JSON.stringify({ feedback: 'ok', score: 2.4 }))
  assert.deepEqual(await assist(c2).practice({ question: 'q', answer: 'a' }), { feedback: 'ok', score: 2, next: '' })
  assert.equal(c2.calls.length, 2)
})

test('stories: only stories citing existing CV lines survive; citations are cleaned', async () => {
  const n = SAMPLE.split('\n').length
  const story = (o = {}) => ({ title: 'Mentoring', situation: 's', task: 't', action: 'I mentored engineers.', result: 'r', tags: ['leadership', 4], sourceLines: [LINE], ...o })
  const client = fakeClient(JSON.stringify({ stories: [
    story(),
    story({ title: 'Mixed', sourceLines: [LINE, 0, n + 5, 'x', 2.5] }),
    story({ title: 'None', sourceLines: [] }),
    story({ title: 'Out of range', sourceLines: [n + 1] }),
    story({ title: 'Missing' , sourceLines: undefined }),
    'junk',
  ] }))
  const list = await assist(client).stories()
  assert.deepEqual(list.map(s => s.title), ['Mentoring', 'Mixed'])
  assert.deepEqual(list[1].sourceLines, [LINE])
  assert.deepEqual(list[0].tags, ['leadership'])
  assert.equal(client.calls[0].json.title, 'stories')
  assert.ok(client.calls[0].system.includes(NO_FABRICATION))
})

test('stories: invented names or numbers are reported as newFacts', async () => {
  const client = fakeClient(JSON.stringify({ stories: [{ title: 'X', situation: '', task: '', action: 'I led 47 engineers at Initech.', result: '', sourceLines: [LINE] }] }))
  const [s] = await assist(client).stories()
  assert.deepEqual(s.newFacts, ['47', 'Initech'])
})

test('addToCv: suggestions validated by the guard with the pasted text as known facts', async () => {
  const text = 'I also mentored at Initech for 3 months.'
  const client = fakeClient(JSON.stringify({ suggestions: [
    suggestion({ replacement: '- Mentored five engineers at Initech for 3 months; two promoted to senior' }),
    suggestion({ replacement: '- Mentored 99 engineers at Hooli' }),
  ] }))
  const { suggestions } = await assist(client).addToCv(text)
  assert.deepEqual(suggestions.map(s => s.status), ['ok', 'new-facts'])
  assert.match(client.calls[0].messages[0].content, /mentored at Initech/)
  assert.ok(client.calls[0].system.includes(NO_FABRICATION))
})

test('classifyReply: kind whitelisted, status from kind, confidence clamped, quote must be in the text', async () => {
  const text = 'Thanks for applying. We would like to invite you to an interview next week.'
  const cases = [
    [{ kind: 'interview', status: 'offer', confidence: 1.7, quote: 'invite you to an interview' }, { kind: 'interview', status: 'interview', confidence: 1, quote: 'invite you to an interview' }],
    [{ kind: 'rejection', confidence: 0.8, quote: 'not in the text' }, { kind: 'rejection', status: 'rejected', confidence: 0.8, quote: '' }],
    [{ kind: 'offer', confidence: -1 }, { kind: 'offer', status: 'offer', confidence: 0, quote: '' }],
    [{ kind: 'info-request', confidence: 0.5 }, { kind: 'info-request', status: '', confidence: 0.5, quote: '' }],
    [{ kind: 'spam', confidence: 'x' }, { kind: 'other', status: '', confidence: 0, quote: '' }],
  ]
  for (const [reply, want] of cases) {
    const client = fakeClient(JSON.stringify(reply))
    assert.deepEqual(await assist(client).classifyReply(text), want)
    assert.equal(client.calls[0].json.title, 'reply')
  }
})

test('playbook: career modes load by file name when present; a missing career mode file does not reject', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recto-pb53-'))
  try {
    await mkdir(join(dir, 'agent/modes'), { recursive: true })
    const files = ['recto', 'writing', 'grammar', 'modes/review', 'modes/rewrite', 'modes/tailor', 'modes/evaluate', 'modes/cover-letter', 'modes/extract-job', 'modes/answer', 'modes/interview-prep']
    for (const f of files) await writeFile(join(dir, `agent/${f}.md`), `# ${f}\n`)
    const pb = await loadPlaybook({ read: p => readFile(join(dir, p), 'utf8') })
    assert.equal(pb.modes['interview-prep'], '# modes/interview-prep')
    assert.ok(!('research' in pb.modes))
    const client = fakeClient(JSON.stringify(BRIEF), JSON.stringify(BRIEF))
    const a = createAssist({ client, getState: () => state, loadPlaybook: async () => pb })
    await a.brief('interview-prep', { job: JOB })
    await a.brief('research', { job: JOB })
    assert.ok(client.calls[0].system.includes('# modes/interview-prep'))
    assert.ok(client.calls[1].system.includes(NO_FABRICATION))
    assert.match(client.calls[1].messages[0].content, /unverified/i)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('the real career mode files all exist, load and follow the mode format', async () => {
  const pb = await loadPlaybook()
  for (const m of [...BRIEF_MODES, 'practice', 'stories', 'add', 'reply']) {
    const t = pb.modes[m]
    assert.ok(t, m)
    assert.match(t, /^# Mode: /, m)
    for (const h of ['## Method', '## Output contract', '## Quality bar', '## Common mistakes']) assert.ok(t.includes(h), `${m} ${h}`)
  }
})
