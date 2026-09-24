import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { RULES } from '../src/preflight/rules.js'
import { DIAG_CODES } from '../src/model/markdown.js'

const root = new URL('..', import.meta.url).pathname
const readJson = p => JSON.parse(readFileSync(join(root, p), 'utf8'))
const en = readJson('locales/en.json')
const missing = keys => keys.filter(k => !(k in en))

// t('a.b') and t(cond ? 'a.b' : 'c.d'); keys built from template literals are covered by the RULES/DIAG checks
// and by the UI modules' own tests.
export function literalKeys(src) {
  const keys = new Set()
  for (const m of src.matchAll(/\bt\(\s*'([^'\n]+)'(?!\s*\+)/g)) keys.add(m[1])
  for (const m of src.matchAll(/\bt\([^,()'`\n]*\?\s*'([^'\n]+)'\s*:\s*'([^'\n]+)'/g)) keys.add(m[1]).add(m[2])
  return [...keys]
}

test('literalKeys finds plain and ternary literals, skips template keys', () => {
  const src = "t('a.b'); t(x ? 'c.d' : 'e.f', { n }); t(`g.${h}`); t('pre.' + k); set('no.key'); t(issue.msg)"
  assert.deepEqual(literalKeys(src).sort(), ['a.b', 'c.d', 'e.f'])
})

test('every preflight rule has a message key', () => {
  assert.deepEqual(missing(RULES.map(r => `preflight.${r.id}`)), [])
})

test('every parser diagnostic has a message key', () => {
  assert.deepEqual(missing(DIAG_CODES.map(c => `diag.${c}`)), [])
})

test('every locale has exactly the keys of en.json', () => {
  const want = Object.keys(en).sort()
  for (const f of readdirSync(join(root, 'locales')).filter(f => f.endsWith('.json'))) {
    assert.deepEqual(Object.keys(readJson(`locales/${f}`)).sort(), want, f)
  }
})

test('every literal t() key in the UI exists in en.json', () => {
  const files = [...readdirSync(join(root, 'src/ui')).filter(f => f.endsWith('.js')).map(f => `src/ui/${f}`), 'src/main.js']
  for (const f of files) {
    assert.deepEqual(missing(literalKeys(readFileSync(join(root, f), 'utf8'))), [], f)
  }
})
