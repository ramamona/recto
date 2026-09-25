import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { localSuggestions, LOCAL_CODES } from '../src/suggest/local.js'
import { parse } from '../src/model/markdown.js'
import { applyContentEdits } from '../src/model/edits.js'

const SAMPLE = JSON.parse(readFileSync(new URL('../samples/sample.cv.json', import.meta.url), 'utf8')).content
const cv = body => `# Jo Doe\njo@doe.dev\n\n## Experience\n### Engineer | Acme | 2020 – 2022\n${body}\n`
const run = (source, lang) => localSuggestions(source, parse(source), lang)
const codes = (source, lang) => run(source, lang).map(s => s.code)
const of = (source, code, lang) => run(source, lang).filter(s => s.code === code)

test('weak openers fire on each phrase and not on strong verbs', () => {
  for (const p of ['Responsible for', 'Worked on', 'Helped', 'Assisted with', 'Tasked with', 'Involved in']) {
    const [s] = of(cv(`- ${p} the billing service for 3 teams`), 'weak-opener')
    assert.ok(s, p)
    assert.equal(s.line, 6)
    assert.equal(s.message, 'suggest.local.weak-opener')
    assert.equal(s.vars.phrase, p)
  }
  assert.deepEqual(of(cv('- Led the billing rewrite for 3 teams'), 'weak-opener'), [])
  assert.deepEqual(of(cv('- Helpful tooling for 3 teams'), 'weak-opener'), [])
})

test('no-metric only for experience bullets without a digit', () => {
  assert.equal(of(cv('- Led the billing rewrite'), 'no-metric').length, 1)
  assert.deepEqual(of(cv('- Cut costs by 30%'), 'no-metric'), [])
  const skills = '# Jo\n\n## Skills\n- Go, Rust\n'
  assert.deepEqual(of(skills, 'no-metric'), [])
})

test('passive voice', () => {
  assert.equal(of(cv('- The API was redesigned for 3 teams'), 'passive').length, 1)
  assert.equal(of(cv('- Dashboards were built for 40 users'), 'passive').length, 1)
  assert.deepEqual(of(cv('- Redesigned the API for 3 teams'), 'passive'), [])
})

test('filler words get a mechanical fix that keeps the line a bullet', () => {
  const source = cv('- Successfully shipped a very fast importer for 3 teams')
  const found = of(source, 'filler')
  assert.deepEqual(found.map(s => s.vars.word), ['Successfully', 'very'])
  const r = applyContentEdits(source, found[0].fix.edits)
  assert.equal(r.stale, false)
  assert.equal(r.content.split('\n')[5], '- Shipped a very fast importer for 3 teams')
  assert.equal(applyContentEdits(source, found[1].fix.edits).content.split('\n')[5], '- Successfully shipped a fast importer for 3 teams')
  assert.deepEqual(of(cv('- Shipped an importer for 3 teams'), 'filler'), [])
})

test('filler in a multi-line bullet gets no fix', () => {
  const [s] = of(cv('- Shipped a very fast importer\n  for 3 teams'), 'filler')
  assert.equal(s.fix, undefined)
})

test('long bullets over 30 words', () => {
  const long = '- Led ' + Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ')
  const [s] = of(cv(long), 'long-bullet')
  assert.equal(s.vars.words, 31)
  assert.deepEqual(of(cv('- Led ' + 'x '.repeat(28) + '1'), 'long-bullet'), [])
})

test('repeated first verb 3+ times in one section', () => {
  const src = cv('- Built a queue for 3 teams\n- Built a cache for 2 teams\n- built an API for 4 teams\n- Led 5 people')
  const found = of(src, 'repeated-verb')
  assert.deepEqual(found.map(s => s.line), [6, 7, 8])
  assert.deepEqual(found[0].vars, { verb: 'built', count: 3 })
  assert.deepEqual(of(cv('- Built a queue for 3\n- Built a cache for 2\n- Led 5'), 'repeated-verb'), [])
})

test('English-only rules are skipped for other languages', () => {
  const src = cv('- Responsible for a very long list\n- Tickets were closed')
  assert.deepEqual(new Set(codes(src, 'de')), new Set(['no-metric']))
  assert.ok(codes(src, 'en-GB').includes('weak-opener'))
})

test('sample CV: no weak openers, some bullets without metrics, fixes carry the current line', () => {
  const found = run(SAMPLE)
  assert.equal(found.filter(s => s.code === 'weak-opener').length, 0)
  assert.ok(found.filter(s => s.code === 'no-metric').length > 0)
  const lines = SAMPLE.split('\n')
  for (const s of found) {
    assert.ok(LOCAL_CODES.includes(s.code))
    for (const e of s.fix?.edits ?? []) assert.equal(e.expect, lines[e.line - 1])
  }
})

test('never throws on odd input', () => {
  assert.deepEqual(run(''), [])
  assert.doesNotThrow(() => run('## \n- \n-  \n### |||\n- x'))
})
