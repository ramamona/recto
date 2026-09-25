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
