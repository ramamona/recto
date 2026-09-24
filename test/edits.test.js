import test from 'node:test'
import assert from 'node:assert/strict'
import { applyContentEdits, moveSectionSource, setEntryField } from '../src/model/edits.js'

test('applyContentEdits replaces and deletes bottom-up', () => {
  const r = applyContentEdits('a\nb\nc\nd', [{ line: 2, expect: 'b', text: null }, { line: 4, expect: 'd', text: 'D' }, { line: 1, expect: 'a', text: 'A' }])
  assert.deepEqual(r, { content: 'A\nc\nD', stale: false })
})

test('applyContentEdits is stale when any expect mismatches', () => {
  assert.deepEqual(applyContentEdits('a\nb', [{ line: 1, expect: 'a', text: 'A' }, { line: 2, expect: 'x', text: 'B' }]), { content: 'a\nb', stale: true })
  assert.equal(applyContentEdits('a', [{ line: 5, expect: 'a', text: 'A' }]).stale, true)
  assert.deepEqual(applyContentEdits('a', []), { content: 'a', stale: false })
})

// Lines: 1 '# N', 2 '', 3 '## A', 4 'a1', 5 'a2', 6 '', 7 '## B', 8 'b1', 9 '', 10 '', 11 '## C', 12 'c1', 13 ''
const src = '# N\n\n## A\na1\na2\n\n## B\nb1\n\n\n## C\nc1\n'
const doc = { header: null, diagnostics: [], sections: [
  { id: 'a', line: 3, endLine: 5 },
  { id: 'b', line: 7, endLine: 8 },
  { id: 'c', line: 11, endLine: 12 },
] }

test('moveSectionSource before a section', () => {
  assert.equal(moveSectionSource(src, doc, 'c', 'a', null), '# N\n\n## C\nc1\n\n## A\na1\na2\n\n## B\nb1\n')
  assert.equal(moveSectionSource(src, doc, 'a', 'c', null), '# N\n\n## B\nb1\n\n## A\na1\na2\n\n## C\nc1\n')
})

test('moveSectionSource after a section', () => {
  assert.equal(moveSectionSource(src, doc, 'a', null, 'b'), '# N\n\n## B\nb1\n\n## A\na1\na2\n\n## C\nc1\n')
  assert.equal(moveSectionSource(src, doc, 'c', null, 'a'), '# N\n\n## A\na1\na2\n\n## C\nc1\n\n## B\nb1\n')
})

test('moveSectionSource to EOF', () => {
  // only the junctions the move creates are normalized; the untouched B/C gap keeps its two blanks
  assert.equal(moveSectionSource(src, doc, 'a', null, null), '# N\n\n## B\nb1\n\n\n## C\nc1\n\n## A\na1\na2\n')
  assert.equal(moveSectionSource(src.trimEnd(), doc, 'b', null, null), '# N\n\n## A\na1\na2\n\n## C\nc1\n\n## B\nb1')
})

test('moveSectionSource without a header and with unknown ids', () => {
  const s = '## A\na\n\n## B\nb'
  const d = { sections: [{ id: 'a', line: 1, endLine: 2 }, { id: 'b', line: 4, endLine: 5 }] }
  assert.equal(moveSectionSource(s, d, 'b', 'a', null), '## B\nb\n\n## A\na')
  assert.equal(moveSectionSource(s, d, 'x', 'a', null), s)
  assert.equal(moveSectionSource(s, d, 'a', 'x', null), s)
  assert.equal(moveSectionSource(s, d, 'a', 'a', null), s)
})

test('setEntryField rewrites one field, keeping escapes byte-for-byte', () => {
  assert.equal(setEntryField('### A \\| B | Org  |  Jan 2020 | Berlin', 2, '2020 – 2021'), '### A \\| B | Org | 2020 – 2021 | Berlin')
  assert.equal(setEntryField('### [x](https://a.dev/?q=a\\|b) | Org', 1, 'New'), '### [x](https://a.dev/?q=a\\|b) | New')
  assert.equal(setEntryField('### T', 2, '2021'), '### T |  | 2021')
  assert.equal(setEntryField('### T | O | 2020', 2, ''), '### T | O')
})

test('setEntryField: an escaped backslash does not escape the pipe', () => {
  assert.equal(setEntryField('### A \\\\| B', 1, 'C'), '### A \\\\ | C')
})

test('setEntryField leaves non-entry lines alone', () => {
  assert.equal(setEntryField('## Skills', 0, 'x'), '## Skills')
  assert.equal(setEntryField('#### T', 0, 'x'), '#### T')
})
