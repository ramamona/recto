import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { analyzeLines, tokenizeLine, caretHint, snippetEdit } from '../src/ui/editor.js'

const t = (key, vars) => vars ? `${key}(${Object.values(vars).join(',')})` : key
const SRC = '# Jane\nEngineer\njane@x.dev · +49 151 0000000\n\n## Work {#work}\n### Dev | Acme | 2020 – 2021 | Berlin\n- Did **a lot**\n  and more\n---\nPlain [link](https://x.dev) `c`'
const lines = SRC.split('\n')

test('analyzeLines tracks kind and region', () => {
  const info = analyzeLines(lines)
  assert.deepEqual(info.map(i => i.kind), ['name', 'text', 'text', 'blank', 'section', 'entry', 'bullet', 'cont', 'rule', 'text'])
  assert.deepEqual(info.map(i => i.region), ['name', 'header', 'header', 'header', 'body', 'body', 'body', 'body', 'body', 'body'])
  assert.equal(analyzeLines(['intro', '# Jane'])[0].region, 'pre')
  assert.equal(analyzeLines(['# A', '## S', '# B'])[2].kind, 'text') // extra name is paragraph text
})

test('tokens always reproduce the line exactly', () => {
  const info = analyzeLines(lines)
  lines.forEach((l, i) => assert.equal(tokenizeLine(l, info[i]).map(x => x[1]).join(''), l))
  const hostile = ['### a \\| b | c | d | e | f', '**unclosed', '_x_y_', '## {#id}', '[a](b', '\\\\*x*']
  for (const l of hostile) assert.equal(tokenizeLine(l, analyzeLines([l])[0]).map(x => x[1]).join(''), l)
})

test('entry fields are coloured by position, escaped pipes stay in the field', () => {
  const line = '### A \\| B | Org | 2020 | City'
  const toks = tokenizeLine(line, { kind: 'entry', region: 'body' })
  const f = cls => toks.filter(x => x[0]?.includes(cls)).map(x => x[1]).join('')
  assert.equal(f('ed-f0'), ' A \\| B ')
  assert.equal(f('ed-f2'), ' 2020 ')
  assert.equal(toks.filter(x => x[0] === 'ed-pipe').length, 3)
})

test('inline markup gets classes', () => {
  const toks = tokenizeLine('x **b** *i* `c` [l](https://a.b) \\*', { kind: 'text', region: 'body' })
  const cls = s => toks.find(x => x[1] === s)?.[0]
  assert.match(cls('**b**'), /ed-strong/)
  assert.match(cls('*i*'), /ed-em/)
  assert.match(cls('`c`'), /ed-code/)
  assert.match(cls('[l](https://a.b)'), /ed-link/)
  assert.match(cls('\\*'), /ed-esc/)
})

test('caret hint names the context', () => {
  const info = analyzeLines(lines)
  const hint = (n, col = 0) => caretHint(lines[n - 1], col, info[n - 1], t, n === 3)
  assert.equal(hint(1), 'editor.hint.name')
  assert.equal(hint(2), 'editor.hint.tagline')
  assert.equal(hint(3), 'editor.hint.contact')
  assert.equal(hint(5), 'editor.hint.section')
  assert.equal(hint(6, 5), 'editor.hint.entry(1,4,editor.field.title)')
  assert.equal(hint(6, 20), 'editor.hint.entry(3,4,editor.field.date)')
  assert.equal(hint(7), 'editor.hint.bullet')
  assert.equal(hint(8), 'editor.hint.bullet')
  assert.equal(hint(9), 'editor.hint.rule')
  assert.equal(hint(10), 'editor.hint.paragraph')
})

test('snippets land on their own line with the first placeholder selected', () => {
  const ph = { 'editor.ph.title': 'Job title', 'editor.ph.org': 'Organisation', 'editor.ph.date': 'Jan 2024 – Present', 'editor.ph.city': 'City' }
  const tt = k => ph[k] ?? k
  const e = snippetEdit('## Work\nabc', 9, 'entry', tt)
  assert.equal(e.at, 11)
  assert.equal(e.text, '\n### Job title | Organisation | Jan 2024 – Present | City')
  const after = '## Work\nabc' + e.text
  assert.equal(after.slice(e.selStart, e.selEnd), 'Job title')
  const empty = snippetEdit('a\n\n', 2, 'rule', tt)
  assert.deepEqual([empty.at, empty.text, empty.selStart, empty.selEnd], [2, '---', 5, 5])
  const br = snippetEdit('ab', 1, 'break', tt)
  assert.deepEqual([br.at, br.text, br.selStart], [1, '\\\n', 3])
  const sec = snippetEdit('x', 1, 'section', tt)
  assert.equal(sec.text, '\n\n## editor.ph.section')
})

test('highlighting the sample takes < 5 ms', () => {
  const { content } = JSON.parse(readFileSync(new URL('../samples/sample.cv.json', import.meta.url), 'utf8'))
  const ls = content.split('\n')
  const run = () => { const info = analyzeLines(ls); ls.forEach((l, i) => tokenizeLine(l, info[i])) }
  for (let i = 0; i < 5; i++) run() // warm up
  const t0 = performance.now()
  run()
  assert.ok(performance.now() - t0 < 5)
})
