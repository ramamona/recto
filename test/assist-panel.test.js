import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wordDiff, visibleCards, safeEdits, withSignal } from '../src/ui/assist-panel.js'

const side = (parts, op) => parts.filter(([o]) => o === '=' || o === op).map(([, s]) => s).join('')

test('wordDiff: both sides reassemble exactly, whitespace included', () => {
  const a = '- Responsible for  the build pipeline'
  const b = '- Rebuilt the build pipeline, cutting deploys'
  const parts = wordDiff(a, b)
  assert.equal(side(parts, '-'), a)
  assert.equal(side(parts, '+'), b)
})

test('wordDiff: marks only the changed words', () => {
  assert.deepEqual(wordDiff('Led a team', 'Led a large team'), [['=', 'Led a '], ['+', 'large '], ['=', 'team']])
  assert.deepEqual(wordDiff('very fast', 'fast'), [['-', 'very '], ['=', 'fast']])
  assert.deepEqual(wordDiff('same', 'same'), [['=', 'same']])
  assert.deepEqual(wordDiff('', 'new'), [['+', 'new']])
  assert.deepEqual(wordDiff('old', ''), [['-', 'old']])
})

const content = ['# Jane', '', '## Experience', '- Worked on APIs', '- Helped the team'].join('\n')
const card = (line, expect, replacement, status = 'ok') => ({ line, expect, replacement, reason: '', category: 'impact', status, newFacts: [] })

test('visibleCards hides stale and invalid cards, including ones made stale by later edits', () => {
  const ok = card(4, '- Worked on APIs', '- Built APIs')
  const invalid = card(4, '- Worked on APIs', 'Built APIs', 'invalid')
  const changed = card(5, '- Helped the old team', '- Supported the team')
  const flagged = card(1, '# Jane', '# Jane', 'stale')
  const facts = card(5, '- Helped the team', '- Helped 12 teams', 'new-facts')
  assert.deepEqual(visibleCards([ok, invalid, changed, flagged, facts], content), [ok, facts])
  assert.deepEqual(visibleCards(undefined, content), [])
})

test('safeEdits: ok cards only, one per line, never new-facts or invalid', () => {
  const cards = [
    card(4, '- Worked on APIs', '- Built APIs'),
    card(4, '- Worked on APIs', '- Designed APIs'),
    card(5, '- Helped the team', '- Helped 12 teams', 'new-facts'),
    card(5, '- Helped the team', 'Helped', 'invalid'),
    card(5, '- Helped the old team', '- Mentored the team'),
  ]
  assert.deepEqual(safeEdits(cards, content), [{ line: 4, expect: '- Worked on APIs', text: '- Built APIs' }])
  assert.deepEqual(safeEdits([], content), [])
})

test('withSignal passes the abort signal to every complete() call', async () => {
  const seen = []
  const client = { complete: async o => { seen.push(o); return { text: 'x' } }, listModels: () => [] }
  const signal = new AbortController().signal
  const wrapped = withSignal(client, signal)
  await wrapped.complete({ messages: [] })
  assert.equal(seen[0].signal, signal)
  assert.equal(wrapped.listModels, client.listModels)
})
