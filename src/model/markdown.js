// Recto Markdown (spec 3.2) → AST (spec 3.3). Pure module: no DOM, never throws on any input.
import { LANGS, categorize, presentWords, rangeWords } from './categories.js'
import { HEADER_SEPARATORS, DEFAULT_CONTACT_SEP } from './separators.js'

export const DATE_STYLES = ['YYYY', 'YYYY-MM', 'MM/YYYY', 'Mon YYYY', 'Month YYYY']
export const DIAG_CODES = ['text-before-name', 'extra-name', 'header-markup', 'unclosed-emphasis', 'unsafe-link', 'entry-extra-fields', 'unparseable-date']
export const ENTRY_FIELDS = ['title', 'org', 'date', 'location']

const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const SEP_RE = new RegExp(HEADER_SEPARATORS.map(escRe).join('|'))
const PART_RE = new RegExp(`${SEP_RE.source}|\\n`)
const unescape = s => s.replace(/\\([*_[\]()|#\\`])/g, '$1')

// ---------- lines ----------

/** Line kind per the spec 3.2 table (first match wins). `prev` = previous line's kind, for continuations. */
export function classifyLine(line, prev) {
  const n = line.replace(/\t/g, '  ').replace(/\u00a0/g, ' ')
  if (!n.trim()) return 'blank'
  if (/^-{3,}\s*$/.test(n)) return 'rule'
  if (n.startsWith('# ')) return 'name'
  if (/^##(\s|$)/.test(n)) return 'section'
  if (/^###(\s|$)/.test(n)) return 'entry'
  if (/^\s*[-*•] /.test(n)) return 'bullet'
  if ((prev === 'bullet' || prev === 'cont') && /^\s{2,}\S/.test(n)) return 'cont'
  return 'text'
}

// Consecutive lines join with a space; an unescaped trailing backslash is a hard break ('\n' → br).
function joinLines(lines) {
  return lines.map(l => l.trim())
    .map(l => /(^|[^\\])(\\\\)*\\$/.test(l) ? l.slice(0, -1).trimEnd() + '\n' : l + ' ')
    .join('').trim()
}

// ---------- document ----------

export function parse(source) {
  const lines = String(source ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
  const diagnostics = []
  const diag = (line, code, vars = {}) => diagnostics.push({ line, code, vars })
  const inl = (text, line) => parseInline(text, { line, diagnostics })
  const doc = { header: null, sections: [], diagnostics }
  const explicitIds = []
  let region = 'pre', prev = 'blank', warnedPre = false, sepFound = false
  let section = null, entry = null, list = null, item = null, para = null, lastLine = 0

  const closeItem = () => { if (item) item.node.inlines = inl(joinLines(item.lines), item.node.line); item = null }
  const closePara = () => { if (para) para.node.inlines = inl(joinLines(para.lines), para.node.line); para = null }
  const closeList = () => { closeItem(); list = null }
  const closeSection = () => {
    closePara(); closeList(); entry = null
    if (!section) return
    section.endLine = lastLine
    if (categorize(section.title) === 'contact') section.contacts = sectionContacts(section.blocks)
  }
  const blocks = () => (entry ?? section).blocks

  const startSection = (raw, line) => {
    closeSection()
    region = 'body'
    lastLine = line
    const rest = raw.slice(2)
    const m = /^(.*?)\s*\{#([a-z0-9-]+)\}\s*$/.exec(rest)
    const titleInlines = inl((m ? m[1] : rest).trim(), line)
    section = { id: '', explicitId: false, title: inlineText(titleInlines), titleInlines, line, endLine: line, contacts: [], blocks: [] }
    doc.sections.push(section)
    explicitIds.push(m?.[2])
  }

  const headerLine = (kind, text, line) => {
    const { header } = doc
    if (kind === 'bullet' || kind === 'entry') diag(line, 'header-markup')
    if (kind === 'name') diag(line, 'extra-name')
    const inlines = inl(text, line)
    const contacts = text.split(SEP_RE).filter(p => p.trim()).map(p => detectContact(p, line))
    if (!contacts.some(isContactLike)) return header.taglines.push({ line, inlines })
    header.contacts.push(...contacts)
    const sep = !sepFound && SEP_RE.exec(text)
    if (sep) { header.contactSep = sep[0]; sepFound = true }
  }

  const bodyLine = (kind, raw, line) => {
    if (kind === 'blank') { closePara(); closeList(); return }
    lastLine = line
    if (kind === 'rule') {
      closePara(); closeList(); entry = null
      section.blocks.push({ type: 'rule', line })
    } else if (kind === 'entry') {
      closePara(); closeList()
      entry = readEntry(raw.slice(3), line, diag, inl)
      section.blocks.push(entry)
    } else if (kind === 'bullet') {
      closePara(); closeItem()
      if (!list) blocks().push(list = { type: 'list', line, items: [] })
      item = { node: { line, inlines: [] }, lines: [raw.replace(/^\s*[-*•]\s/, '')] }
      list.items.push(item.node)
    } else if (kind === 'cont') {
      item.lines.push(raw)
    } else {
      if (kind === 'name') diag(line, 'extra-name')
      closeList()
      if (!para) {
        para = { node: { type: 'paragraph', line, inlines: [] }, lines: [] }
        blocks().push(para.node)
      }
      para.lines.push(raw)
    }
  }

  lines.forEach((raw, i) => {
    const line = i + 1, kind = classifyLine(raw, prev)
    prev = kind
    if (kind === 'section') return startSection(raw, line)
    if (region === 'body') return bodyLine(kind, raw, line)
    if (region === 'header') {
      if (kind === 'rule') doc.header.rule = true
      else if (kind !== 'blank') headerLine(kind, raw.trim(), line)
    } else if (kind === 'name') {
      doc.header = { name: inlineText(inl(raw.slice(2).trim(), line)), line, rule: false, contactSep: DEFAULT_CONTACT_SEP, taglines: [], contacts: [] }
      region = 'header'
    } else if (kind !== 'blank' && !warnedPre) {
      warnedPre = true
      diag(line, 'text-before-name')
    }
  })
  closeSection()
  assignIds(doc.sections, explicitIds)
  diagnostics.sort((a, b) => a.line - b.line)
  return doc
}

function readEntry(raw, line, diag, inl) {
  const f = splitEntryFields(raw)
  if (f.length > 4) {
    diag(line, 'entry-extra-fields', { count: f.length })
    f.splice(3, f.length, f.slice(3).join(' | '))
  }
  const date = unescape(f[2] ?? ''), location = unescape(f[3] ?? '')
  const dateRange = date ? parseAnyDate(date) : null
  if (date && !dateRange) diag(line, 'unparseable-date', { date })
  return { type: 'entry', line, title: inl(f[0], line), org: inl(f[1] ?? '', line), date, location, dateRange, blocks: [] }
}

// parse() has no CV language, so entry dates accept every supported language (each includes English).
function parseAnyDate(text) {
  for (const lang of LANGS) {
    const r = parseDateRange(text, lang)
    if (r) return r
  }
  return null
}

/** Raw text after `### ` split on unescaped `|`; fields trimmed, escapes kept (so fixes can rewrite one field byte-for-byte). */
export function splitEntryFields(raw) {
  const out = ['']
  const s = String(raw ?? '')
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) out[out.length - 1] += s[i] + s[++i]
    else if (s[i] === '|') out.push('')
    else out[out.length - 1] += s[i]
  }
  return out.map(f => f.trim())
}

export function joinEntryFields(fields) {
  const f = [...fields]
  while (f.length && !f[f.length - 1]) f.pop()
  return '### ' + f.join(' | ')
}

function assignIds(sections, explicitIds) {
  const taken = new Set()
  sections.forEach((s, i) => {
    const id = explicitIds[i]
    if (id && !taken.has(id)) { taken.add(id); s.id = id; s.explicitId = true }
  })
  sections.forEach((s, i) => {
    if (s.explicitId) return
    const base = explicitIds[i] ?? slugify(s.title)
    let id = base
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
    taken.add(id)
    s.id = id
  })
}

export function slugify(s) {
  return String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section'
}

// ---------- inline ----------

const ESCAPABLE = '*_[]()|#\\`'
const ALNUM = /[\p{L}\p{N}]/u
const WS_RUN = /[^\S\u00a0]+/g // NBSP is kept: in content it is deliberate
const URL_AT = /https?:\/\/[^\s<>]+/iy
const EMAIL_AT = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/y

export function parseInline(text, ctx) {
  const { nodes, diags } = inline(String(text ?? ''), false)
  if (ctx?.diagnostics) for (const d of diags) ctx.diagnostics.push({ line: ctx.line, ...d })
  return nodes
}

export function inlineText(inlines) {
  return (inlines ?? []).map(n => n.t === 'br' ? '\n' : n.c ? inlineText(n.c) : n.v ?? '').join('')
}

// Single pass: escapes, code, links and autolinks become nodes; emphasis uses a delimiter stack, so
// unmatched markers stay literal in linear time (no backtracking).
function inline(s, inLink) {
  const out = [], stack = [], diags = []
  let buf = '', i = 0
  const flush = () => { if (buf) out.push({ t: 'text', v: buf }); buf = '' }
  const unmatched = d => { out[d.idx] = { t: 'text', v: d.mark }; diags.push({ code: 'unclosed-emphasis', vars: { marker: d.mark } }) }

  while (i < s.length) {
    const ch = s[i]
    if (ch === '\\' && i + 1 < s.length && ESCAPABLE.includes(s[i + 1])) { buf += s[i + 1]; i += 2; continue }
    if (ch === '\n') { flush(); out.push({ t: 'br' }); i++; continue }
    if (ch === '`') {
      const j = s.indexOf('`', i + 1)
      if (j > 0) { flush(); out.push({ t: 'code', v: s.slice(i + 1, j) }); i = j + 1; continue }
    }
    if (ch === '[' && !inLink) {
      const r = link(s, i)
      if (r) { flush(); out.push(...r.nodes); diags.push(...r.diags); i = r.i; continue }
    }
    if (ch === '*' || ch === '_') {
      const mark = ch === '*' && s[i + 1] === '*' ? '**' : ch
      const { open, close } = flanking(s, i, mark)
      const k = close ? stack.findLastIndex(d => d.mark === mark) : -1
      if (k >= 0) {
        flush()
        const d = stack[k]
        stack.splice(k).slice(1).forEach(unmatched)
        const c = mergeText(out.splice(d.idx + 1))
        out[d.idx] = c.length ? { t: mark === '**' ? 'strong' : 'em', c } : { t: 'text', v: mark + mark }
      } else if (open) {
        flush()
        stack.push({ mark, idx: out.push({ t: 'delim' }) - 1 })
      } else buf += mark
      i += mark.length
      continue
    }
    const a = inLink ? null : autolink(s, i)
    if (a) { flush(); out.push(a.node); i = a.i; continue }
    buf += ch
    i++
  }
  flush()
  stack.forEach(unmatched)
  return { nodes: mergeText(out), diags }
}

function flanking(s, i, mark) {
  const before = s[i - 1] ?? ' ', after = s[i + mark.length] ?? ' '
  let open = !/\s/.test(after), close = !/\s/.test(before)
  if (mark === '_') { open &&= !ALNUM.test(before); close &&= !ALNUM.test(after) } // snake_case stays text
  return { open, close }
}

function mergeText(nodes) {
  const out = []
  for (const n of nodes) {
    const last = out[out.length - 1]
    if (n.t !== 'text') out.push(n)
    else if (last?.t === 'text') last.v += n.v
    else out.push({ t: 'text', v: n.v })
  }
  for (const n of out) if (n.t === 'text') n.v = n.v.replace(WS_RUN, ' ')
  return out
}

function matchBracket(s, i, open, close) {
  if (s.indexOf(close, i) < 0) return -1
  let depth = 0
  for (let j = i; j < s.length; j++) {
    if (s[j] === '\\') j++
    else if (s[j] === open) depth++
    else if (s[j] === close && --depth === 0) return j
  }
  return -1
}

function link(s, i) {
  const close = matchBracket(s, i, '[', ']')
  if (close < 0 || s[close + 1] !== '(') return null
  const stop = matchBracket(s, close + 1, '(', ')')
  if (stop < 0) return null
  const url = s.slice(close + 2, stop).trim()
  const inner = inline(s.slice(i + 1, close), true)
  const href = safeHref(unescape(url))
  if (!href) return { nodes: inner.nodes, diags: [...inner.diags, { code: 'unsafe-link', vars: { url } }], i: stop + 1 }
  const c = inner.nodes.length ? inner.nodes : [{ t: 'text', v: url }]
  return { nodes: [{ t: 'link', href, c }], diags: inner.diags, i: stop + 1 }
}

const count = (s, ch) => s.split(ch).length - 1

function autolink(s, i) {
  if (i > 0 && /[\w.+-]/.test(s[i - 1])) return null
  URL_AT.lastIndex = i
  const m = URL_AT.exec(s)
  if (m) {
    // Drop trailing punctuation, and a trailing ')' while parentheses are unbalanced ('*_' too, so **url** works).
    let len = m[0].length, excess = count(m[0], ')') - count(m[0], '(')
    for (;;) {
      const c = m[0][len - 1]
      if ('.,;:!?\'"*_'.includes(c)) len--
      else if (c === ')' && excess > 0) { len--; excess-- }
      else break
    }
    const url = m[0].slice(0, len)
    if (/^https?:\/\/[^/]/i.test(url)) return { node: { t: 'link', href: url, c: [{ t: 'text', v: url }] }, i: i + len }
  }
  EMAIL_AT.lastIndex = i
  const e = EMAIL_AT.exec(s)
  return e && { node: { t: 'link', href: 'mailto:' + e[0], c: [{ t: 'text', v: e[0] }] }, i: i + e[0].length }
}

// ---------- links and contacts ----------

const ALLOWED = /^(https?|mailto|tel):/i
const SCHEME = /^[a-z][a-z0-9+.-]*:/i
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const TLDS = new Set('com org net io dev app me co ai page site xyz info eu uk de fr es it nl ch at se no dk fi pl in ca au us'.split(' '))
const LABEL_RE = /^\p{L}[\p{L} ]{0,19}:\s*/u
const NO_LABEL = /^(?:[a-z][a-z0-9+.-]*:\/\/|(?:mailto|tel):\S+$)/i // `https:` / `tel:` are schemes, not labels

function isBareDomain(t) {
  const m = /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.exec(t)
  return !!m && (!!m[2] || TLDS.has(m[1].slice(1)))
}

function safeHref(h) {
  if (!h || /\s/.test(h)) return null
  if (ALLOWED.test(h)) return h
  if (SCHEME.test(h)) return null
  if (EMAIL_RE.test(h)) return 'mailto:' + h
  if (/^www\./i.test(h) || isBareDomain(h)) return 'https://' + h
  return null
}

function validUrl(href) {
  try {
    const u = new URL(href)
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.includes('.')
  } catch { return false }
}

function hrefContact(text, href) {
  const kind = /^mailto:/i.test(href) ? 'email' : /^tel:/i.test(href) ? 'phone' : 'url'
  const valid = kind === 'email' ? EMAIL_RE.test(href.slice(7).split('?')[0]) : kind === 'phone' || validUrl(href)
  return { kind, text, href, valid }
}

function contactOf(s) {
  const md = /^\[([^\]]*)\]\((\S*)\)$/.exec(s)
  if (md) {
    const href = safeHref(unescape(md[2])), text = inlineText(parseInline(md[1]))
    return href ? hrefContact(text, href) : { kind: 'text', text, valid: true }
  }
  const t = unescape(s)
  if (!/\s/.test(t)) {
    if (SCHEME.test(t)) {
      const href = safeHref(t)
      return href ? hrefContact(t, href) : { kind: 'url', text: t, valid: false }
    }
    if (t.includes('@')) return { kind: 'email', text: t, href: 'mailto:' + t, valid: EMAIL_RE.test(t) }
    if (/^www\./i.test(t) || isBareDomain(t)) return hrefContact(t, 'https://' + t)
  }
  if (/^[+\d\s().-]+$/.test(t) && t.replace(/\D/g, '').length >= 7) {
    return { kind: 'phone', text: t, href: 'tel:' + t.replace(/[^\d+]/g, ''), valid: true }
  }
  return { kind: 'text', text: inlineText(parseInline(s)), valid: true }
}

/** Loose detection, strict validation (spec 3.2). Always returns a Contact; kind 'text' when not contact-like. */
export function detectContact(part, line) {
  let s = String(part ?? '').trim(), label
  const lm = !NO_LABEL.test(s) && LABEL_RE.exec(s)
  if (lm) { label = lm[0].replace(/\s*:\s*$/, ''); s = s.slice(lm[0].length) }
  return { ...contactOf(s), ...(label && { label }), line }
}

export const isContactLike = c => c.kind !== 'text'

// Links are written back as [text](href) so detectContact still sees their target.
const sourceText = inlines => inlines.map(n =>
  n.t === 'link' ? `[${inlineText(n.c)}](${n.href})` : n.t === 'br' ? '\n' : n.c ? sourceText(n.c) : n.v).join('')

function sectionContacts(blocks) {
  const units = blocks.flatMap(b => b.type === 'list' ? b.items : b.type === 'paragraph' ? [b] : [])
  return units.flatMap(u => sourceText(u.inlines).split(PART_RE)
    .filter(p => p.trim()).map(p => detectContact(p, u.line)).filter(isContactLike))
}

// ---------- dates ----------

const LOCALES = new Map()

function monthNames(lang, opts) {
  const f = new Intl.DateTimeFormat(lang, { ...opts, timeZone: 'UTC' })
  return Array.from({ length: 12 }, (_, m) => f.formatToParts(Date.UTC(2000, m, 1)).find(p => p.type === 'month').value)
}

function locale(lang) {
  if (LOCALES.has(lang)) return LOCALES.get(lang)
  let L
  try {
    const short = monthNames(lang, { month: 'short', year: 'numeric' }) // format form: 'März', not standalone 'Mär'
    const long = monthNames(lang, { month: 'long', year: 'numeric' })
    const lookup = new Map()
    const add = (names, style) => names.forEach((n, i) => lookup.set(n.toLowerCase().replace(/\.$/, ''), [i + 1, style]))
    // Standalone and format forms, CV language plus English; short wins when equal ('May', 'März').
    for (const [month, style] of [['long', 'Month YYYY'], ['short', 'Mon YYYY']]) {
      for (const l of new Set([lang, 'en'])) for (const year of [undefined, 'numeric']) add(monthNames(l, { month, year }), style)
    }
    lookup.set('sept', [9, 'Mon YYYY'])
    const words = rangeWords(lang).map(escRe).join('|')
    L = {
      short, long, lookup,
      present: presentWords(lang),
      sep: new RegExp(`\\s*[–—]\\s*|\\s+-\\s+|-|\\s+(?:${words})\\s+`, 'giu'),
      tail: new RegExp(`(?:\\s*[–—-]|(?:^|\\s)(?:${words}))$`, 'iu'),
    }
  } catch {
    return locale('en') // invalid language tag
  }
  LOCALES.set(lang, L)
  return L
}

function point(str, L) {
  const s = str.trim()
  const mk = (y, m, style) => y < 1900 || y > 2100 || m < 1 || m > 12 ? null : { p: m ? { y, m } : { y }, style }
  let m
  if ((m = /^(\d{4})$/.exec(s))) return mk(+m[1], undefined, 'YYYY')
  if ((m = /^(\d{4})-(\d{1,2})$/.exec(s))) return mk(+m[1], +m[2], 'YYYY-MM')
  if ((m = /^(\d{1,2})\/(\d{4})$/.exec(s))) return mk(+m[2], +m[1], 'MM/YYYY')
  if ((m = /^(\p{L}+)\.? (\d{4})$/u.exec(s))) {
    const hit = L.lookup.get(m[1])
    if (hit) return mk(+m[2], hit[0], hit[1])
  }
  return null
}

export function parseDateRange(text, lang = 'en') {
  const L = locale(lang)
  let s = String(text ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
  const present = L.present.find(w => s.endsWith(w) && !/\p{L}/u.test(s[s.length - w.length - 1] ?? ''))
  if (present) {
    const start = point(s.slice(0, -present.length).trim().replace(L.tail, ''), L)
    return start && { start: start.p, end: null, current: true, style: start.style }
  }
  const single = point(s, L)
  if (single) return { start: single.p, end: { ...single.p }, current: false, style: single.style }
  for (const m of s.matchAll(L.sep)) {
    const a = point(s.slice(0, m.index), L), b = point(s.slice(m.index + m[0].length), L)
    if (a && b) return { start: a.p, end: b.p, current: false, style: a.style }
  }
  return null
}

const pad = m => String(m).padStart(2, '0')

export function formatDate(point, style, lang = 'en') {
  if (!point) return ''
  const { y, m } = point
  if (!(m >= 1 && m <= 12) || style === 'YYYY') return String(y)
  if (style === 'YYYY-MM') return `${y}-${pad(m)}`
  if (style === 'MM/YYYY') return `${pad(m)}/${y}`
  const name = locale(lang)[style === 'Month YYYY' ? 'long' : 'short'][m - 1].replace(/\.$/, '')
  return name[0].toUpperCase() + name.slice(1) + ' ' + y
}
