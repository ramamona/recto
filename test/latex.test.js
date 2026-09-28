import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse } from '../src/model/markdown.js'
import { toLatex } from '../src/io/latex.js'

const sample = JSON.parse(readFileSync(new URL('../samples/sample.cv.json', import.meta.url))).content

test('wraps a self-contained article with only geometry, hyperref, enumitem', () => {
  const tex = toLatex(parse(sample))
  assert.match(tex, /^\\documentclass/)
  assert.match(tex, /\\usepackage(\[[^\]]*\])?\{geometry\}/)
  assert.match(tex, /\\usepackage\{hyperref\}/)
  assert.match(tex, /\\usepackage\{enumitem\}/)
  assert.equal((tex.match(/\\usepackage/g) ?? []).length, 3)
  assert.match(tex, /\\begin\{document\}/)
  assert.match(tex, /\\end\{document\}\s*$/)
  assert.equal((tex.match(/\\begin\{document\}/g) ?? []).length, 1)
  assert.equal((tex.match(/\\end\{document\}/g) ?? []).length, 1)
})

test('renders name, tagline and contacts, linking only http(s)/mailto/tel', () => {
  const tex = toLatex(parse(sample))
  assert.match(tex, /Alex Morgan/)
  assert.match(tex, /Senior Software Engineer/)
  assert.match(tex, /\\href\{mailto:alex\.morgan@example\.com\}\{alex\.morgan@example\.com\}/)
  assert.match(tex, /\\href\{tel:\+14155550142\}\{\+1 415 555 0142\}/)
  assert.match(tex, /\\href\{https:\/\/alexmorgan\.dev\}\{alexmorgan\.dev\}/)
  // a plain-text contact (city/state) is never wrapped in \href
  assert.doesNotMatch(tex, /\\href\{[^}]*\}\{San Francisco, CA\}/)
})

test('renders sections, entries and bullets', () => {
  const tex = toLatex(parse(sample))
  assert.match(tex, /\\section\*\{Experience\}/)
  assert.match(tex, /\\textbf\{Senior Software Engineer, Lumen Labs\}/)
  assert.match(tex, /Mar 2022/)
  assert.match(tex, /San Francisco, CA/)
  assert.match(tex, /\\begin\{itemize\}/)
  assert.match(tex, /\\item Led the rebuild/)
  assert.match(tex, /\\end\{itemize\}/)
})

test('converts inline emphasis to \\textbf and \\emph', () => {
  const doc = parse('# Jane\n\n## Summary\nA **bold** claim and an *emph* aside.\n')
  const tex = toLatex(doc)
  assert.match(tex, /\\textbf\{bold\}/)
  assert.match(tex, /\\emph\{emph\}/)
})

test('converts an inline markdown link to \\href', () => {
  const doc = parse('# Jane\n\n## Projects\n### [Recto](https://example.com/recto)\nA CV builder.\n')
  const tex = toLatex(doc)
  assert.match(tex, /\\href\{https:\/\/example\.com\/recto\}\{Recto\}/)
})

test('escapes every LaTeX special character in user text', () => {
  const doc = parse('# A \\ B { C } D $ E & F # G ^ H _ I % J ~ K\n')
  const tex = toLatex(doc)
  assert.match(tex, /A \\textbackslash\{\} B/)
  assert.match(tex, /B \\\{ C \\\} D/)
  assert.match(tex, /D \\\$ E/)
  assert.match(tex, /E \\& F/)
  assert.match(tex, /F \\# G/)
  assert.match(tex, /G \\textasciicircum\{\} H/)
  assert.match(tex, /H \\_ I/)
  assert.match(tex, /I \\% J/)
  assert.match(tex, /J \\textasciitilde\{\} K/)
})

test('renders a rule as a horizontal rule', () => {
  const doc = parse('# Jane\n\n## Summary\nBefore.\n\n---\n\nAfter.\n')
  const tex = toLatex(doc)
  assert.match(tex, /\\hrulefill/)
})

test('falls back to the given name when the document has no header', () => {
  const doc = parse('## Summary\nNo header line here.\n')
  const tex = toLatex(doc, undefined, { name: 'Fallback Name' })
  assert.match(tex, /Fallback Name/)
})

test('never throws on an empty or foreign document', () => {
  assert.doesNotThrow(() => toLatex(parse('')))
  for (const bad of [null, undefined, {}, { sections: 'x' }]) assert.doesNotThrow(() => toLatex(bad, bad))
  assert.equal(typeof toLatex(parse('')), 'string')
})

test('skips sections hidden in the layout', () => {
  const doc = parse('# A\n\n## Summary\nKeep me.\n\n## Secret\nHide me.\n')
  const secret = doc.sections.find(s => s.title === 'Secret').id
  const tex = toLatex(doc, { sections: { [secret]: { hidden: true } } })
  assert.match(tex, /Keep me/)
  assert.doesNotMatch(tex, /Hide me|\\section\*\{Secret\}/)
})

test('follows the layout column reading order', () => {
  const doc = parse('# A\n\n## One\nfirst\n\n## Two\nsecond\n')
  const [one, two] = doc.sections.map(s => s.id)
  const layout = {
    grid: { columns: [{ id: 'side', width: 1 }, { id: 'main', width: 2 }], readingOrder: ['main', 'side'] },
    sections: { [one]: { column: 'side' }, [two]: { column: 'main' } },
  }
  const tex = toLatex(doc, layout)
  assert.ok(tex.indexOf('second') < tex.indexOf('first'))
})
