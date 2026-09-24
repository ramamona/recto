// Preflight (spec 6.1): content rules over source/AST/layout, render rules over the RenderReport. Pure.
import { parseInline, inlineText, parseDateRange, formatDate, detectContact, classifyLine, splitEntryFields, joinEntryFields, DATE_STYLES } from '../model/markdown.js'
import { sectionConfig } from '../model/layout.js'
import { categorize, isStandardHeading, LANGS } from '../model/categories.js'
import { contrastRatio, bestTextColor } from './contrast.js'
import { allContacts } from './ats.js'

const CONTENT = ['missing-name', 'missing-email', 'missing-phone', 'invalid-email', 'invalid-url', 'phone-format',
  'entry-date', 'date-format-mixed', 'date-order', 'date-future', 'not-reverse-chronological',
  'bullet-too-long', 'too-many-bullets', 'bullet-punctuation-mixed', 'repeated-word',
  'invisible-characters', 'special-characters', 'empty-section', 'untitled-section', 'markup-diagnostic',
  'nonstandard-heading', 'hidden-link-target', 'photo-present', 'custom-css', 'margin-too-small', 'line-height-tight']
const RENDER = ['page-overflow', 'pages-over-target', 'sparse-last-page', 'forced-split', 'font-too-small',
  'low-contrast', 'missing-font', 'multi-column', 'column-interrupts-entry']

export const RULES = [...CONTENT.map(id => ({ id, needsReport: false })), ...RENDER.map(id => ({ id, needsReport: true }))]
export const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 }

const MAX_BULLET_CHARS = 200
const MAX_BULLETS = 6
const MIN_MARGIN = 7
const MIN_CONTRAST = 4.5

export function runPreflight ({ source, doc, layout, report = null, placement = null, now = new Date(), lang = layout.lang }) {
  const lines = String(source ?? '').split('\n') // same split as applyContentEdits, so `expect` matches
  const kinds = []
  lines.forEach((l, i) => kinds.push(classifyLine(l, kinds[i - 1] ?? 'blank')))
  const sections = doc.sections.map(section => ({ section, config: sectionConfig(layout, section) })).filter(s => !s.config.hidden)
  const c = { doc, layout, report, placement, now, lang, lines, kinds, sections }
  c.units = units(c)
  const issues = [contactRules, entryRules, bulletRules, repeatedWords, characterRules, sectionRules, linkRules, layoutRules]
    .flatMap(rule => rule(c))
  for (const d of doc.diagnostics) issues.push({ rule: 'markup-diagnostic', severity: 'warn', msg: `diag.${d.code}`, vars: d.vars, line: d.line })
  if (report) issues.push(...reportRules(c))
  if (placement) issues.push(...columnInterrupts(c))
  return issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.line ?? 0) - (b.line ?? 0))
}

// ---------- helpers ----------

function issue (rule, severity, vars = {}, at = {}) {
  const out = { rule, severity, msg: `preflight.${rule}`, vars }
  for (const k of ['line', 'sectionId', 'page', 'fix']) if (at[k] != null) out[k] = at[k]
  return out
}

const edit = (c, line, text) => ({ line, expect: c.lines[line - 1], text })
const contentFix = edits => edits.length ? { kind: 'content', edits } : undefined
const layoutFix = (path, value) => ({ kind: 'layout', ops: [{ path, value }] })

/** Last 1-based source line of the paragraph or bullet starting at `line` (continuation lines). */
function lastLine (kinds, line) {
  const cont = kinds[line - 1] === 'bullet' ? ['cont'] : ['text', 'name']
  let end = line
  while (cont.includes(kinds[end])) end++
  return end
}

const listItems = blocks => blocks.flatMap(b => b.type === 'list' ? b.items : b.type === 'entry' ? listItems(b.blocks) : [])
const entries = c => c.sections.flatMap(({ section }) => section.blocks.filter(b => b.type === 'entry').map(e => ({ e, section })))

// ---------- contacts ----------

function contactRules ({ doc, lang }) {
  const all = allContacts(doc, lang)
  const out = []
  if (!doc.header?.name.trim()) out.push(issue('missing-name', 'error', {}, { line: doc.header?.line }))
  if (!all.some(x => x.kind === 'email' && x.valid)) out.push(issue('missing-email', 'warn'))
  if (!all.some(x => x.kind === 'phone')) out.push(issue('missing-phone', 'info'))
  for (const x of all) {
    const vars = { value: x.text }, at = { line: x.line }
    if (x.kind === 'email' && !x.valid) out.push(issue('invalid-email', 'error', vars, at))
    if (x.kind === 'url' && !x.valid) out.push(issue('invalid-url', 'warn', vars, at))
    if (x.kind === 'phone' && !/^tel:\+/i.test(x.href ?? '')) out.push(issue('phone-format', 'info', vars, at))
  }
  return out
}

// ---------- dates ----------

const DATED = ['experience', 'education', 'volunteering']
const MONTH_STYLES = DATE_STYLES.filter(s => s !== 'YYYY')
const monthKey = (p, m) => p.y * 12 + (p.m ?? m) // year-only: January as a start, December as an end
const unescape = s => s.replace(/\\([*_[\]()|#\\`])/g, '$1')
// Same languages as the parser, so a fix it accepts is one parse() accepts.
const parseAny = s => LANGS.reduce((r, l) => r ?? parseDateRange(s, l), null)
const entryFields = (c, e) => splitEntryFields(c.lines[e.line - 1].replace(/^###/, ''))

function entryRules (c) {
  const out = []
  const nowKey = c.now.getFullYear() * 12 + c.now.getMonth() + 1
  const list = entries(c)
  for (const { e, section } of list) {
    const title = inlineText(e.title), at = { line: e.line, sectionId: section.id }
    const r = e.dateRange
    if (!r && DATED.includes(categorize(section.title, c.lang))) out.push(issue('entry-date', 'warn', { title }, { ...at, fix: moveDate(c, e) }))
    if (!r) continue
    if (r.end && monthKey(r.end, 12) < monthKey(r.start, 1)) out.push(issue('date-order', 'error', { title }, at))
    if (monthKey(r.start, 1) > nowKey) out.push(issue('date-future', 'warn', { title }, at))
  }
  for (const { section } of c.sections) {
    const dated = section.blocks.filter(b => b.type === 'entry' && b.dateRange)
    const bad = dated.find((e, i) => i > 0 && newer(rank(e), rank(dated[i - 1])))
    if (bad) out.push(issue('not-reverse-chronological', 'info', { section: section.title || section.id }, { line: bad.line, sectionId: section.id }))
  }
  return [...out, ...dateStyles(c, list)]
}

const rank = ({ dateRange: r }) => [r.current ? Infinity : monthKey(r.end, 12), monthKey(r.start, 1)]
const newer = ([a, a2], [b, b2]) => a > b || (a === b && a2 > b2)

// Another field that parses as a date moves to field 3.
function moveDate (c, e) {
  const f = entryFields(c, e)
  const i = f.findIndex((v, k) => k !== 2 && v && parseAny(unescape(v)))
  if (i < 0) return
  const [date] = f.splice(i, 1)
  while (f.length < 2) f.push('')
  f.splice(2, 0, date)
  return contentFix([edit(c, e.line, joinEntryFields(f))])
}

// Month-precision tokens: digit forms first, so 'a 2021-03' can't be eaten by the word form.
const MONTH_TOKENS = [/(?<!\d)(?:\d{4}-\d{1,2}|\d{1,2}\/\d{4})(?!\d)/g, /(?<!\p{L})\p{L}+\.?\s+\d{4}(?!\d)/gu]

/** Rewrites month-precision dates that don't already fit `style`; year-only dates and all other text stay. */
function restyle (date, style, lang, seen) {
  return MONTH_TOKENS.reduce((s, re) => s.replace(re, tok => {
    const r = parseAny(tok)
    if (!r?.start.m || r.current || r.end.y !== r.start.y || r.end.m !== r.start.m) return tok
    seen?.add(r.style)
    return fits(tok, r, style) ? tok : formatDate(r.start, style, lang)
  }), date)
}

// The parser calls 'May 2020' short ('Mon YYYY'), but it is also the long form.
const fits = (tok, r, style) => r.style === style ||
  (style === 'Month YYYY' && r.style === 'Mon YYYY' && LANGS.some(l => formatDate(r.start, style, l).toLowerCase() === tok.toLowerCase()))

function dateStyles (c, list) {
  const dated = list.filter(({ e }) => e.dateRange && e.dateRange.style !== 'YYYY').map(x => ({ ...x, f: entryFields(c, x.e) }))
  const conforms = style => dated.filter(x => restyle(x.f[2], style, c.lang) === x.f[2])
  const candidates = [...new Set([...dated.map(x => x.e.dateRange.style), ...MONTH_STYLES])] // ties: first seen
  const style = candidates.reduce((a, b) => conforms(b).length > conforms(a).length ? b : a)
  const ok = new Set(conforms(style))
  const odd = dated.filter(x => !ok.has(x))
  if (!odd.length) return []
  const seen = new Set()
  const edits = dated.map(x => {
    const f = [...x.f]
    f[2] = restyle(f[2], style, c.lang, seen)
    return ok.has(x) ? null : edit(c, x.e.line, joinEntryFields(f))
  }).filter(Boolean)
  const [{ e, section }] = odd
  return [issue('date-format-mixed', 'info', { styles: [...seen].join(', ') }, { line: e.line, sectionId: section.id, fix: contentFix(edits) })]
}

// ---------- bullets ----------

const ABBREVIATION = /(?:^|[\s(])(?:etc|inc|ltd|co|corp|e\.g|i\.e|vs|jr|sr)\.$/i
const INITIAL = /(?:^|[\s(.])\p{Lu}\.$/u
const leaf = inlines => {
  const n = inlines.at(-1)
  return n?.c && n.t !== 'link' ? leaf(n.c) : n
}

/** 'dot' | 'none', or null when the ending is exempt (other punctuation, link, code, URL, initial, abbreviation). */
function bulletEnd (item) {
  const text = inlineText(item.inlines).trimEnd()
  const last = leaf(item.inlines)
  if (!text || last?.t === 'link' || last?.t === 'code' || /[?!:;,)…]$/.test(text)) return null
  const word = text.split(/\s/).at(-1).replace(/\.$/, '')
  if (detectContact(word).kind !== 'text' || ABBREVIATION.test(text) || INITIAL.test(text)) return null
  return text.endsWith('.') ? 'dot' : 'none'
}

// Adds or removes one '.' at the end of the bullet's last source line.
function punctuate (c, item, add) {
  const n = lastLine(c.kinds, item.line)
  const raw = c.lines[n - 1], t = raw.trimEnd()
  if (t.endsWith('\\') || (!add && !t.endsWith('.'))) return null // a trailing '\' is a hard break
  return edit(c, n, (add ? t + '.' : t.slice(0, -1)) + raw.slice(t.length))
}

function bulletRules (c) {
  const out = []
  for (const { section } of c.sections) {
    for (const e of section.blocks.filter(b => b.type === 'entry')) {
      const count = listItems(e.blocks).length
      if (count > MAX_BULLETS) out.push(issue('too-many-bullets', 'info', { count, max: MAX_BULLETS }, { line: e.line, sectionId: section.id }))
    }
    const items = listItems(section.blocks)
    for (const it of items) {
      const length = inlineText(it.inlines).length
      if (length > MAX_BULLET_CHARS) out.push(issue('bullet-too-long', 'info', { length, max: MAX_BULLET_CHARS }, { line: it.line, sectionId: section.id }))
    }
    const ends = items.map(it => ({ it, end: bulletEnd(it) })).filter(x => x.end)
    const dots = ends.filter(x => x.end === 'dot').length
    if (!dots || dots === ends.length) continue
    const add = dots * 2 > ends.length // majority style; a tie drops the periods
    const odd = ends.filter(x => (x.end === 'dot') !== add)
    const edits = odd.map(x => punctuate(c, x.it, add)).filter(Boolean)
    out.push(issue('bullet-punctuation-mixed', 'info', {}, { line: odd[0].it.line, sectionId: section.id, fix: contentFix(edits) }))
  }
  return out
}

// ---------- text ----------

/** Every inline run with where it lives: taglines, section titles, entry heads, paragraphs, bullets. */
function units (c) {
  const out = []
  const add = (inlines, line, section, multiline) => out.push({
    inlines, line, end: multiline ? lastLine(c.kinds, line) : line, sectionId: section?.id,
    header: !section, contact: !!section && categorize(section.title, c.lang) === 'contact',
  })
  for (const t of c.doc.header?.taglines ?? []) add(t.inlines, t.line)
  for (const { section } of c.sections) {
    add(section.titleInlines, section.line, section)
    const walk = blocks => {
      for (const b of blocks) {
        if (b.type === 'entry') { add(b.title, b.line, section); add(b.org, b.line, section); walk(b.blocks) }
        if (b.type === 'paragraph') add(b.inlines, b.line, section, true)
        if (b.type === 'list') for (const it of b.items) add(it.inlines, it.line, section, true)
      }
    }
    walk(section.blocks)
  }
  return out
}

function * texts (inlines) {
  for (const n of inlines) {
    if (n.t === 'text') yield n.v
    else if (n.c) yield * texts(n.c)
  }
}

const PAIR = /(?<![\p{L}\p{N}])(\p{L}+)(?=\s+(\p{L}+)(?![\p{L}\p{N}]))/gu
const DOUBLED_OK = ['that', 'had']
const capital = w => /^\p{Lu}/u.test(w)

function repeatedWords (c) {
  const out = [], done = new Set()
  for (const u of c.units) {
    for (const v of texts(u.inlines)) {
      for (const [, a, b] of v.matchAll(PAIR)) {
        const w = a.toLowerCase()
        if (w !== b.toLowerCase() || DOUBLED_OK.includes(w) || (capital(a) && capital(b))) continue
        const re = new RegExp(`(?<![\\p{L}\\p{N}])(${a})\\s+${a}(?![\\p{L}\\p{N}])`, 'iu') // letters only: safe
        let line = u.line, fix
        for (let n = u.line; n <= u.end && !fix; n++) {
          if (c.lines[n - 1].search(re) < 0) continue
          line = n
          fix = contentFix([edit(c, n, c.lines[n - 1].replace(re, '$1'))])
        }
        if (done.has(`${line}:${w}`)) continue
        done.add(`${line}:${w}`)
        out.push(issue('repeated-word', 'info', { word: a }, { line, sectionId: u.sectionId, fix }))
      }
    }
  }
  return out
}

const INVISIBLE = /[­​-‍⁠﻿]/g
const SPECIAL = /[\p{Extended_Pictographic}\p{Co}☀-➿■-◿]/gu
const TYPOGRAPHY = '©®™•·–—…‘’“”→×' // never flagged

function characterRules (c) {
  const out = [], edits = [], chars = new Set()
  let count = 0, first
  c.lines.forEach((l, i) => {
    const n = l.match(INVISIBLE)?.length ?? 0
    if (n) { count += n; edits.push(edit(c, i + 1, l.replace(INVISIBLE, ''))) }
    for (const [ch] of l.matchAll(SPECIAL)) {
      if (TYPOGRAPHY.includes(ch)) continue
      chars.add(ch)
      first ??= i + 1
    }
  })
  if (count) out.push(issue('invisible-characters', 'warn', { count }, { line: edits[0].line, fix: contentFix(edits) }))
  if (chars.size) out.push(issue('special-characters', 'warn', { chars: [...chars].join(' ') }, { line: first }))
  return out
}

// ---------- sections ----------

function sectionRules ({ sections, lang }) {
  const out = []
  for (const { section: s, config } of sections) {
    const at = { line: s.line, sectionId: s.id }, titled = !!s.title.trim(), vars = { section: s.title || s.id }
    if (!s.blocks.length) out.push(issue('empty-section', 'warn', vars, at))
    else if (!titled || !config.showTitle) {
      out.push(issue('untitled-section', 'warn', vars, { ...at, fix: titled ? layoutFix(['sections', s.id, 'showTitle'], true) : undefined }))
    }
    if (titled && !isStandardHeading(s.title, lang)) out.push(issue('nonstandard-heading', 'info', { title: s.title }, at))
  }
  return out
}

// ---------- links ----------

const shown = s => s.trim().replace(/^(?:https?:\/\/|mailto:|tel:)/i, '').replace(/^www\./i, '').replace(/\/+$/, '')
const sameTarget = (text, href) => /^tel:/i.test(href)
  ? text.replace(/\D/g, '') === href.replace(/\D/g, '')
  : shown(text).toLowerCase() === shown(href).toLowerCase()

function * links (inlines) {
  for (const [i, n] of inlines.entries()) {
    if (n.t === 'link') yield [n, inlines.slice(i + 1)]
    else if (n.c) yield * links(n.c)
  }
}

function closing (s, i, open, close) {
  let depth = 0
  for (let j = i; j < s.length; j++) {
    if (s[j] === '\\') j++
    else if (s[j] === open) depth++
    else if (s[j] === close && --depth === 0) return j
  }
  return -1
}

/** [start, end) of the `[text](href)` source span in `line` that parses to this link, or null. */
function linkSpan (line, href, text) {
  for (let i = line.indexOf('['); i >= 0; i = line.indexOf('[', i + 1)) {
    if (line[i - 1] === '\\') continue
    const j = closing(line, i, '[', ']')
    const k = j > 0 && line[j + 1] === '(' ? closing(line, j + 1, '(', ')') : -1
    if (k < 0) continue
    const nodes = parseInline(line.slice(i, k + 1))
    if (nodes.length === 1 && nodes[0].t === 'link' && nodes[0].href === href && inlineText(nodes[0].c) === text) return [i, k + 1]
  }
  return null
}

// Header and contact sections replace the link with its target (keeping it a detected contact);
// elsewhere the target is appended in parentheses.
function hiddenLink (c, { text, href, line, end = line, sectionId, header, replace }) {
  const target = shown(href)
  let at = line, fix
  for (let n = line; n <= end && !fix; n++) {
    const raw = c.lines[n - 1], span = linkSpan(raw, href, text)
    if (!span) continue
    const [a, b] = span
    const repl = detectContact(target).kind === detectContact(href).kind ? target : href
    at = n
    fix = contentFix([edit(c, n, replace ? raw.slice(0, a) + repl + raw.slice(b) : `${raw.slice(0, b)} (${target})${raw.slice(b)}`)])
  }
  return issue('hidden-link-target', header ? 'warn' : 'info', { text, href: target }, { line: at, sectionId, fix })
}

function linkRules (c) {
  const out = []
  for (const x of c.doc.header?.contacts ?? []) {
    if (x.href && !sameTarget(x.text, x.href)) out.push(hiddenLink(c, { ...x, header: true, replace: true }))
  }
  for (const u of c.units) {
    for (const [n, rest] of links(u.inlines)) {
      const text = inlineText(n.c), after = /^\s*\(([^)]*)\)/.exec(inlineText(rest))
      if (sameTarget(text, n.href) || (after && sameTarget(after[1], n.href))) continue
      out.push(hiddenLink(c, { ...u, text, href: n.href, replace: u.header || u.contact }))
    }
  }
  return out
}

// ---------- layout ----------

function layoutRules ({ layout: { header, customCss, page, theme } }) {
  const out = []
  if (header.photo) out.push(issue('photo-present', 'info'))
  if (customCss.trim()) out.push(issue('custom-css', 'info'))
  for (const [side, value] of Object.entries(page.margins)) {
    if (value < MIN_MARGIN) out.push(issue('margin-too-small', 'warn', { side, value, min: MIN_MARGIN }, { fix: layoutFix(['page', 'margins', side], 10) }))
  }
  if (theme.lineHeight < 1.15) out.push(issue('line-height-tight', 'warn', { value: theme.lineHeight }, { fix: layoutFix(['theme', 'lineHeight'], 1.25) }))
  return out
}

// ---------- render ----------

const where = x => ({ page: x.page, line: x.line, sectionId: x.sectionId })
const round2 = x => Math.round(x * 100) / 100

/** One item per key: the one with the lowest score. */
function worst (items, key, score) {
  const m = new Map()
  for (const x of items) if (!m.has(key(x)) || score(x) < score(m.get(key(x)))) m.set(key(x), x)
  return [...m.values()]
}

// Rendered size = token × density factor (spec 3.5), so the fix aims the rendered size at `min`.
function sizeFix (theme, token, min) {
  if (!token) return
  const value = Math.ceil(min / (1 + (theme.density - 1) * 0.35) * 4) / 4
  return value > theme[token] ? layoutFix(['theme', token], value) : undefined
}

function reportRules ({ layout, report: r }) {
  const out = []
  for (const f of r.flags ?? []) {
    if (f.kind === 'overflow' || f.kind === 'verify-failed') out.push(issue('page-overflow', 'error', { page: f.page }, where(f)))
    if (f.kind === 'forced-split') out.push(issue('forced-split', 'info', { page: f.page }, where(f)))
  }
  if (r.pageCount > r.targetPages) {
    out.push(issue('pages-over-target', 'warn', { pages: r.pageCount, target: r.targetPages }, { fix: { kind: 'action', action: 'fit-pages', pages: r.targetPages } }))
  }
  if (r.pageCount > 1 && r.lastPageFill < 0.15) {
    out.push(issue('sparse-last-page', 'info', { fill: Math.round(r.lastPageFill * 100) }, { page: r.pageCount, fix: { kind: 'action', action: 'fit-pages', pages: r.pageCount - 1 } }))
  }
  const styles = r.textStyles ?? []
  const minSize = s => s.role === 'small' ? [8, 7] : [9, 7.5]
  const small = styles.filter(s => s.fontSizePt < minSize(s)[0])
  for (const s of worst(small, s => s.sizeToken ?? `${s.sectionId}:${s.role}`, s => s.fontSizePt)) {
    const [min, hard] = minSize(s)
    out.push(issue('font-too-small', s.fontSizePt < hard ? 'error' : 'warn', { size: round2(s.fontSizePt), min }, { ...where(s), fix: sizeFix(layout.theme, s.sizeToken, min) }))
  }
  const low = styles.map(s => ({ s, ratio: contrastRatio(s.color, s.background) })).filter(x => x.ratio < MIN_CONTRAST) // NaN stays silent
  for (const { s, ratio } of worst(low, x => `${x.s.colorPath?.join('.') ?? x.s.color}|${x.s.background}`, x => x.ratio)) {
    const fix = s.colorPath ? layoutFix(s.colorPath, bestTextColor(s.background)) : undefined
    out.push(issue('low-contrast', ratio < 3 ? 'error' : 'warn', { ratio, min: MIN_CONTRAST }, { ...where(s), fix }))
  }
  for (const f of r.fontsMissing ?? []) out.push(issue('missing-font', 'warn', { family: f.replace(/^font:/, '') }))
  const p = (r.pages ?? []).findIndex(pg => pg.columnsWithText?.length >= 2)
  if (p >= 0) {
    const order = layout.grid.readingOrder.filter(id => r.pages[p].columnsWithText.includes(id)).join(' → ')
    out.push(issue('multi-column', 'warn', { order }, { page: p + 1 }))
  }
  return out
}

// An entry in the first stream column that spills onto the next page while a later column has
// text on the same page: an extractor reads the later column in the middle of the entry.
function columnInterrupts ({ doc, layout, placement }) {
  const [first, ...later] = layout.grid.readingOrder
  const busy = new Set(placement.filter(a => later.includes(a.colId) && a.kind !== 'rule').map(a => a.page))
  const out = []
  for (const s of doc.sections) {
    for (const e of s.blocks) {
      if (e.type !== 'entry') continue
      const last = Math.max(e.line, ...e.blocks.flatMap(b => b.type === 'list' ? b.items.map(i => i.line) : [b.line]))
      const pages = placement.filter(a => a.colId === first && a.sectionId === s.id && a.line >= e.line && a.line <= last).map(a => a.page)
      if (!pages.length) continue
      const max = Math.max(...pages)
      for (let p = Math.min(...pages); p < max; p++) {
        if (!busy.has(p)) continue
        out.push(issue('column-interrupts-entry', 'warn', { title: inlineText(e.title) }, { line: e.line, sectionId: s.id, page: p }))
        break
      }
    }
  }
  return out
}
