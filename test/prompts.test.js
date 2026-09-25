import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as P from '../src/ai/prompts.js'

const SOURCE = '# Jo Doe\njo@doe.dev\n\n## Experience\n### Engineer | Acme | 2020 – 2022\n- Led the billing rewrite'
const JOB = { title: 'Staff Engineer', company: 'Globex', text: 'We need Go and Kubernetes.', keywords: ['Go', 'Kubernetes'] }
const text = p => p.system + '\n' + p.messages.map(m => m.content).join('\n')

const builders = {
  suggestPrompt: { source: SOURCE },
  rewritePrompt: { source: SOURCE, lines: [6], instruction: 'shorter' },
  tailorPrompt: { source: SOURCE, job: JOB },
  evaluatePrompt: { source: SOURCE, job: JOB },
  coverLetterPrompt: { source: SOURCE, job: JOB },
}

test('every CV prompt carries the rule, the grammar and the numbered source', () => {
  for (const [name, args] of Object.entries(builders)) {
    const p = P[name](args)
    const t = text(p)
    assert.ok(t.includes(P.NO_FABRICATION), name)
    assert.ok(t.includes(P.GRAMMAR), name)
    assert.ok(t.includes('6│ - Led the billing rewrite'), name)
    assert.ok(t.includes('1│ # Jo Doe'), name)
    assert.equal(p.messages[0].role, 'user')
    assert.equal(typeof p.json, 'object')
    assert.equal(p.json.type, 'object')
    assert.ok(p.json.title)
  }
})

test('the no-fabrication rule is the spec text', () => {
  assert.ok(P.NO_FABRICATION.startsWith('Only rephrase, reorder, cut or emphasise facts already present in the CV.'))
  assert.ok(P.NO_FABRICATION.endsWith('ask for it in `needsInput` instead of inventing it.'))
})

test('numberSource pads nothing and keeps blank lines', () => {
  assert.equal(P.numberSource('a\n\nb'), '1│ a\n2│ \n3│ b')
})

test('rewrite names the selected lines and maps instruction ids', () => {
  const t = text(P.rewritePrompt({ source: SOURCE, lines: [5, 6], instruction: 'quantify' }))
  assert.match(t, /lines 5, 6/)
  assert.match(t, /number/i)
  assert.match(text(P.rewritePrompt({ source: SOURCE, lines: [6], instruction: 'Make it punchy' })), /Make it punchy/)
})

test('job prompts include the posting', () => {
  for (const name of ['tailorPrompt', 'evaluatePrompt', 'coverLetterPrompt']) {
    const t = text(P[name]({ source: SOURCE, job: JOB }))
    assert.ok(t.includes('We need Go and Kubernetes.'), name)
    assert.ok(t.includes('Globex'), name)
  }
})

test('schemas match spec §6', () => {
  const s = P.suggestPrompt({ source: SOURCE }).json
  const item = s.properties.suggestions.items
  assert.deepEqual(item.required, ['line', 'expect', 'replacement', 'reason', 'category'])
  assert.deepEqual(item.properties.category.enum, ['impact', 'clarity', 'keyword', 'concision', 'grammar', 'structure'])
  const t = P.tailorPrompt({ source: SOURCE, job: JOB }).json
  assert.ok(t.properties.keywordsAdded && t.properties.summary)
  const e = P.evaluatePrompt({ source: SOURCE, job: JOB }).json
  assert.deepEqual(e.properties.recommendation.enum, ['apply', 'consider', 'skip'])
  assert.deepEqual(e.properties.requirements.items.properties.verdict.enum, ['met', 'partial', 'missing'])
  assert.deepEqual(P.coverLetterPrompt({ source: SOURCE, job: JOB }).json.required, ['paragraphs'])
})

test('extractJobPrompt returns the §3 shape schema and includes the text', () => {
  const p = P.extractJobPrompt({ text: 'Senior Go Engineer at Globex' })
  assert.ok(text(p).includes('Senior Go Engineer at Globex'))
  for (const k of ['title', 'company', 'location', 'requirements', 'keywords']) assert.ok(p.json.properties[k], k)
  assert.deepEqual(p.json.properties.requirements.items.properties.kind.enum, ['must', 'nice'])
})
