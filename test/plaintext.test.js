import test from 'node:test'
import assert from 'node:assert/strict'
import { parse, inlineText } from '../src/model/markdown.js'
import { fromPlainText } from '../src/io/plaintext.js'

const pasted = [
  '﻿  JANE DOE',
  'Platform Engineer',
  'jane@doe.dev  |  +49 151 0000000\tlinkedin.com/in/janedoe',
  '',
  'SUMMARY',
  'Engineer who likes boring infrastructure',
  'and fast feedback loops.',
  '',
  '',
  'WORK EXPERIENCE',
  'Staff Engineer, Acme Corp, 2021 – Present',
  '●  Cut deploy time 70% by rebuilding CI',
  '● Mentored 6 engineers; 3 promoted',
  '',
  'Skills:',
  '• Go, Rust, TypeScript',
  '- Kubernetes',
].join('\r\n')

test('converts a pasted CV', () => {
  const md = fromPlainText(pasted)
  assert.equal(md, `# JANE DOE
Platform Engineer
jane@doe.dev · +49 151 0000000 · linkedin.com/in/janedoe

## SUMMARY
Engineer who likes boring infrastructure
and fast feedback loops.

## WORK EXPERIENCE
Staff Engineer, Acme Corp, 2021 – Present
- Cut deploy time 70% by rebuilding CI
- Mentored 6 engineers; 3 promoted

## Skills
- Go, Rust, TypeScript
- Kubernetes
`)
  const doc = parse(md)
  assert.deepEqual(doc.diagnostics, [])
  assert.equal(doc.header.name, 'JANE DOE')
  assert.deepEqual(doc.header.taglines.map(t => inlineText(t.inlines)), ['Platform Engineer'])
  assert.deepEqual(doc.header.contacts.map(c => c.kind), ['email', 'phone', 'url'])
  assert.deepEqual(doc.sections.map(s => s.title), ['SUMMARY', 'WORK EXPERIENCE', 'Skills'])
  assert.deepEqual(doc.sections.map(s => s.blocks.map(b => b.type)), [['paragraph'], ['paragraph', 'list'], ['list']])
  assert.deepEqual(doc.sections[1].blocks[1].items.map(i => inlineText(i.inlines)), ['Cut deploy time 70% by rebuilding CI', 'Mentored 6 engineers; 3 promoted'])
})

test('headings: dictionary words in any case, ALL CAPS up to 4 words', () => {
  const md = fromPlainText('N\nberufserfahrung:\nI LOVE WRITING VERY LOUD LINES\nSKILLS & TOOLS\nsome text', 'de')
  assert.deepEqual(parse(md).sections.map(s => s.title), ['berufserfahrung', 'SKILLS & TOOLS'])
})

test('contact lines only among the 5 lines after the name, before any heading', () => {
  assert.equal(fromPlainText('N\nSKILLS\nx@y.dev   +1 555 555 5555'), '# N\n## SKILLS\nx@y.dev +1 555 555 5555\n')
  const md = fromPlainText('N\na\nb\nc\nd\ne\nx@y.dev   +1 555 555 5555')
  assert.deepEqual(parse(md).header.contacts, [])
  assert.equal(fromPlainText('N\na\nx@y.dev   +1 555 555 5555'), '# N\na\nx@y.dev · +1 555 555 5555\n')
})

test('markup characters in pasted text stay literal', () => {
  const line = '#1 in sales, 5* reviews, snake_case [beta] a|b `x` back\\slash'
  const doc = parse(fromPlainText(`N\nEXPERIENCE\n${line}\n● *starred* bullet`))
  assert.deepEqual(doc.diagnostics, [])
  const [p, list] = doc.sections[0].blocks
  assert.equal(inlineText(p.inlines), line)
  assert.equal(inlineText(list.items[0].inlines), '*starred* bullet')
})

test('empty input', () => {
  assert.equal(fromPlainText(''), '')
  assert.equal(fromPlainText(' \n\t\n'), '')
  assert.equal(fromPlainText(null), '')
})
