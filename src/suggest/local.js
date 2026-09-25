// Deterministic writing suggestions for bullets (assist spec §7 Suggest tab). Pure, no AI.
import { classifyLine, inlineText } from '../model/markdown.js'
import { categorize, primaryLang } from '../model/categories.js'

export const LOCAL_CODES = ['weak-opener', 'no-metric', 'passive', 'filler', 'long-bullet', 'repeated-verb']

const MAX_WORDS = 30
const MIN_REPEATS = 3
const WEAK_RE = /^(responsible for|worked on|helped|assisted with|tasked with|involved in)\b/i
// ponytail: regular -ed participles plus a short irregular list; misses rarer irregulars
const PASSIVE_RE = /\b(was|were)\s+(\w+ed|built|made|done|given|taken|written|chosen|led|run|held|sent|shown|seen|known|won|kept|set|put|brought|sold|taught|found)\b/i
const FILLERS = ['very', 'really', 'various', 'successfully', 'basically', 'actually', 'quite', 'extremely', 'literally']
const FILLER_RE = new RegExp(`\\b(${FILLERS.join('|')})\\b`, 'gi')
const METRIC_SECTIONS = ['experience']

const listItems = blocks => blocks.flatMap(b => b.type === 'list' ? b.items : b.type === 'entry' ? listItems(b.blocks) : [])
const words = text => text.split(/\s+/).filter(Boolean)
const hint = (line, code, vars = {}, fix) => ({ line, code, message: `suggest.local.${code}`, vars, ...(fix ? { fix } : {}) })

/**
 * Writing tips for every bullet of `doc` (parsed from `source`). English-only rules
 * (weak-opener, passive, filler) run only when `lang` is English.
 */
export function localSuggestions (source, doc, lang = 'en') {
  const lines = String(source ?? '').split('\n')
  const english = primaryLang(lang) === 'en'
  const out = []
  for (const section of doc.sections) {
    const items = listItems(section.blocks).map(item => ({ item, text: inlineText(item.inlines).trim() })).filter(b => b.text)
    const metric = METRIC_SECTIONS.includes(categorize(section.title))
    for (const { item, text } of items) {
      const { line } = item
      if (english) {
        const weak = WEAK_RE.exec(text)
        if (weak) out.push(hint(line, 'weak-opener', { phrase: weak[1] }))
      }
      if (metric && !/\d/.test(text)) out.push(hint(line, 'no-metric'))
      if (english && PASSIVE_RE.test(text)) out.push(hint(line, 'passive'))
      if (english) out.push(...fillers(lines, line, text))
      const n = words(text).length
      if (n > MAX_WORDS) out.push(hint(line, 'long-bullet', { words: n, max: MAX_WORDS }))
    }
    out.push(...repeatedVerbs(items))
  }
  return out.sort((a, b) => a.line - b.line)
}

function fillers (lines, line, text) {
  const seen = new Set()
  const out = []
  for (const [word] of text.matchAll(FILLER_RE)) {
    if (seen.has(word.toLowerCase())) continue
    seen.add(word.toLowerCase())
    out.push(hint(line, 'filler', { word }, fillerFix(lines, line, word)))
  }
  return out
}

// Removes the word from a single-line bullet when it is followed by another word; otherwise no fix.
function fillerFix (lines, line, word) {
  const src = lines[line - 1]
  if (src == null || classifyLine(lines[line] ?? '', 'bullet') === 'cont') return undefined
  const m = new RegExp(`\\b${word}\\s+(?=\\p{L})`, 'u').exec(src)
  if (!m) return undefined
  let rest = src.slice(m.index + m[0].length)
  if (/^\p{Lu}/u.test(word)) rest = rest.charAt(0).toUpperCase() + rest.slice(1)
  const text = src.slice(0, m.index) + rest
  if (classifyLine(text, 'blank') !== 'bullet') return undefined
  return { kind: 'content', edits: [{ line, expect: src, text }] }
}

function repeatedVerbs (items) {
  const byVerb = new Map()
  for (const { item, text } of items) {
    const verb = words(text)[0]?.toLowerCase()
    if (!verb || !/^\p{L}+$/u.test(verb)) continue
    byVerb.set(verb, [...(byVerb.get(verb) ?? []), item.line])
  }
  return [...byVerb].filter(([, at]) => at.length >= MIN_REPEATS)
    .flatMap(([verb, at]) => at.map(line => hint(line, 'repeated-verb', { verb, count: at.length })))
}
