// Validates AI suggestions before display (spec assist §6). Pure.
import { classifyLine, splitEntryFields } from '../model/markdown.js'

// Outermost JSON object in text (tolerates code fences and surrounding prose).
export function parseJsonLoose(text) {
  const s = String(text ?? '')
  const start = s.indexOf('{')
  if (start < 0) throw new SyntaxError('No JSON object found')
  let depth = 0
  let inString = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return JSON.parse(s.slice(start, i + 1))
  }
  throw new SyntaxError('Unterminated JSON object')
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi
const NUM_RE = /(?<![\p{L}\p{N}])\d+(?:[.,]\d+)*%?/gu
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}+#]*/gu

const trimUrl = u => u.replace(/[.,;:!?]+$/, '')

// Facts a text asserts: URLs, numbers, and capitalized words not at a sentence start.
function factsOf(text) {
  const urls = (text.match(URL_RE) ?? []).map(trimUrl)
  const rest = text.replace(URL_RE, ' ')
  const nums = rest.match(NUM_RE) ?? []
  const caps = []
  const body = rest.replace(/^\s*(#{1,3}|[-*•])\s+/, '')
  for (const m of body.matchAll(WORD_RE)) {
    if (!/^\p{Lu}/u.test(m[0])) continue
    const before = body.slice(0, m.index).trimEnd()
    if (before === '' || /[.!?]$/.test(before)) continue // ponytail: a sentence-initial new noun slips through; POS tagging would be needed
    caps.push(m[0])
  }
  return [...urls, ...nums, ...caps]
}

function knownSet(texts) {
  const set = new Set()
  for (const t of texts) {
    const s = String(t)
    for (const u of s.match(URL_RE) ?? []) set.add(trimUrl(u).toLowerCase())
    const rest = s.replace(URL_RE, ' ')
    for (const n of rest.match(NUM_RE) ?? []) set.add(n.toLowerCase())
    for (const w of rest.match(WORD_RE) ?? []) set.add(w.toLowerCase())
  }
  return set
}

function lineKinds(lines) {
  const kinds = []
  lines.forEach((l, i) => { kinds.push(classifyLine(l, kinds[i - 1])) })
  return kinds
}

function check(s, lines, kinds, known) {
  const i = s?.line - 1
  if (!Number.isInteger(i) || i < 0 || i >= lines.length || s.expect !== lines[i]) return { status: 'stale', newFacts: [] }
  const r = s.replacement
  if (typeof r !== 'string' || /[\r\n]/.test(r)) return { status: 'invalid', newFacts: [] }
  const kind = classifyLine(r, kinds[i - 1])
  if (kind !== kinds[i]) return { status: 'invalid', newFacts: [] }
  if (kind === 'entry' && splitEntryFields(r).length !== splitEntryFields(lines[i]).length) return { status: 'invalid', newFacts: [] }
  const newFacts = [...new Set(factsOf(r).filter(f => !known.has(f.toLowerCase())))]
  return { status: newFacts.length ? 'new-facts' : 'ok', newFacts }
}

// doc is part of the contract (spec §6) for callers; the checks here only need the source lines.
export function validateSuggestions(source, doc, suggestions, { extraFacts = [] } = {}) {
  const lines = String(source ?? '').split(/\r?\n/)
  const kinds = lineKinds(lines)
  const known = knownSet([source, ...extraFacts])
  return (suggestions ?? []).map(s => ({ ...s, ...check(s, lines, kinds, known) }))
}
