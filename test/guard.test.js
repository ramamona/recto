import test from 'node:test'
import assert from 'node:assert/strict'
import { parseJsonLoose, validateSuggestions } from '../src/ai/guard.js'
import { parse } from '../src/model/markdown.js'

test('parseJsonLoose: plain, fenced, wrapped in prose, nested braces in strings', () => {
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 })
  assert.deepEqual(parseJsonLoose('```json\n{"a":[1,2]}\n```'), { a: [1, 2] })
  assert.deepEqual(parseJsonLoose('```\n{"a":2}\n```'), { a: 2 })
  assert.deepEqual(parseJsonLoose('Here you go: {"a":{"b":"}{"}} Thanks!'), { a: { b: '}{' } })
  assert.deepEqual(parseJsonLoose('x {"s":"quote \\" {"} y'), { s: 'quote " {' })
  assert.throws(() => parseJsonLoose('no json'), SyntaxError)
  assert.throws(() => parseJsonLoose('{"a":'), SyntaxError)
})

const source = [
  '# Ada Lovelace',                                       // 1
  'Engineer · ada@example.com · https://ada.dev',          // 2
  '',                                                      // 3
  '## Experience',                                         // 4
  '### Senior Engineer | Acme Corp | 2020 – 2024 | London', // 5
  '- Responsible for the payments API used by 3 teams',    // 6
  '- Worked on migrating services to Docker',              // 7
  '',                                                      // 8
  'Also mentored juniors.',                                // 9
].join('\n')
const doc = parse(source)
const run = s => validateSuggestions(source, doc, s)
const one = (line, replacement, opts) => validateSuggestions(source, doc, [{ line, expect: source.split('\n')[line - 1], replacement, reason: 'r', category: 'impact' }], opts)[0]

test('ok: rephrase using existing facts only', () => {
  const r = one(6, '- Owned the payments API serving 3 teams at Acme Corp')
  assert.equal(r.status, 'ok')
  assert.deepEqual(r.newFacts, [])
  assert.equal(r.reason, 'r')
  assert.equal(one(7, '- Migrated services to docker').status, 'ok')
  assert.equal(one(5, '### Senior engineer | Acme Corp | 2020 – 2024 | London').status, 'ok')
})

test('stale: expect differs from the current line or line out of range', () => {
  const [a, b] = run([
    { line: 6, expect: '- something else', replacement: '- x' },
    { line: 99, expect: '- x', replacement: '- y' },
  ])
  assert.equal(a.status, 'stale')
  assert.equal(b.status, 'stale')
})

test('invalid: line kind changes', () => {
  assert.equal(one(6, 'Owned the payments API used by 3 teams').status, 'invalid')
  assert.equal(one(9, '- Also mentored juniors.').status, 'invalid')
  assert.equal(one(4, 'Experience').status, 'invalid')
  assert.equal(one(6, '- two\n- lines').status, 'invalid')
  assert.equal(one(6, 42).status, 'invalid')
})

test('invalid: entry field count changes', () => {
  assert.equal(one(5, '### Senior Engineer | Acme Corp | 2020 – 2024').status, 'invalid')
  assert.equal(one(5, '### Senior Engineer, Acme Corp | 2020 – 2024 | London').status, 'invalid')
})

test('new-facts: added metric, tool, year, URL', () => {
  const pct = one(6, '- Owned the payments API, cutting latency 47% for 3 teams')
  assert.equal(pct.status, 'new-facts')
  assert.deepEqual(pct.newFacts, ['47%'])
  assert.deepEqual(one(7, '- Migrated services to Docker and Kubernetes').newFacts, ['Kubernetes'])
  assert.deepEqual(one(7, '- Migrated services to Docker in 2019').newFacts, ['2019'])
  assert.deepEqual(one(9, 'Also mentored juniors (see https://blog.test/x).').newFacts, ['https://blog.test/x'])
  assert.deepEqual(one(5, '### Staff Engineer | Acme Corp | 2019 – 2024 | London').newFacts, ['2019'])
})

test('sentence-initial capitals are not facts; mid-sentence ones are', () => {
  assert.equal(one(7, '- Led the migration of services to Docker. Cut costs.').status, 'ok')
  assert.deepEqual(one(7, '- Migrated services to Docker with Terraform. Cut costs.').newFacts, ['Terraform'])
  assert.deepEqual(one(7, '- Migrated services to Docker on AWS').newFacts, ['AWS'])
})

test('extraFacts (tailoring keywords) are accepted, case-insensitively', () => {
  const r = one(7, '- Migrated services to Docker and Kubernetes', { extraFacts: ['kubernetes'] })
  assert.equal(r.status, 'ok')
})

test('stale and invalid carry empty newFacts; order preserved', () => {
  const out = run([
    { line: 7, expect: '- Worked on migrating services to Docker', replacement: '- Migrated services to Docker and Kubernetes' },
    { line: 6, expect: 'nope', replacement: '- x' },
  ])
  assert.deepEqual(out.map(s => [s.status, s.newFacts]), [['new-facts', ['Kubernetes']], ['stale', []]])
})
