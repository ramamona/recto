// CV text → Recto Markdown (spec 6.5, refined by Task 19): used for pasted text and for text extracted
// from uploaded PDF/Word files. Pure module. Returns { content, notes }; notes flag low-confidence guesses
// as { line, code, vars } with `line` the 1-based line of `content` they are about.
import { detectContact, parseDateRange } from '../model/markdown.js'
import { categorize, presentWords, rangeWords } from '../model/categories.js'
import { DEFAULT_CONTACT_SEP } from '../model/separators.js'
import { escText, escLine, guardLine } from './jsonresume.js'

const PART_SEP = /\s+[|·•●▪○■–]\s+|\t+|\s{2,}/ // how contact lines separate their parts
const BULLET = /^(?:[•▪●○■·►▸◦‣]\s*|[–*-]\s+|(?:\d{1,2}|[a-z])[.)]\s+)/
const RULE = /^[=\-_*~–—•·]{3,}$/
const CV_WORD = /^(?:curriculum vitae|currículum(?: vitae)?|resume|résumé|cv|lebenslauf)$/i
const LABEL_LINE = /^\p{L}[\p{L} -]{0,19}:\s*\S/u
const LOCATION = /^\p{Lu}[\p{L} .'-]*,\s*\p{Lu}[\p{L} .'-]*$/u
const LABEL_ITEM = /^(\p{L}[\p{L}\p{N} &/+#.-]{0,30}?)\s*:\s+(\S.*)$/u
const ROLE = new RegExp([
  String.raw`\b(?:engineer|manager|developer|designer|analyst|intern|lead|director|consultant|student|architect|scientist|officer|specialist|coordinator|assistant|associate|administrator|head|vp|president|founder|owner|programmer|researcher|teacher|professor|lecturer|editor|writer|recruiter|accountant|technician|advisor|trainee|mba|ph\.?\s?d|bachelor|master|diplom\w*|abitur|licence|licenciatura|doctor)\b`,
  String.raw`\b[bm]\.?\s?(?:sc|s|a|eng)\.?(?=[\s,]|$)`,
  'entwickler|ingenieur|leiter|berater|praktikant|werkstudent|développeu|ingénieur|stagiaire|desarrollador|ingeniero|gerente',
].join('|'), 'iu')
const ORG = /\b(?:inc|llc|ltd|gmbh|ag|se|corp|corporation|company|university|universität|universidad|université|college|school|institute|hochschule|academy|bank|group|labs?|technologies|solutions|foundation)\b/iu
const DURATION = /\s*[·(]?\s*\b\d+\s*(?:yrs?|years?|mos?|months?|jahre?n?|monate?n?)\b(?:\s+\d+\s*(?:mos?|months?|monate?n?)\b)?\s*\)?/giu
const EMPLOYMENT = /\s*·\s*(?:full-time|part-time|self-employed|freelance|contract|internship|apprenticeship|seasonal|vollzeit|teilzeit)\b/giu
const EDGE = /^[\s|,;·–—-]+|[\s|,;·–—-]+$/g
const ENTRY_CATS = new Set(['experience', 'education', 'projects', 'volunteering', 'certifications'])
const LIST_CATS = new Set(['skills', 'languages', 'interests'])
// Split order for an entry head without pipes (the two-space gap first: it is the extractors' column break).
const SPLITS = [/\s{2,}/, /\s+—\s+/, /\s+–\s+/, /\s+-\s+/, /\s+·\s+/, [/\s+(?:at|bei|chez)\s+/iu], [/,\s+/]]

const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const words = s => s.split(/\s+/).filter(Boolean).length
const isRole = s => ROLE.test(s)
const isPlace = s => (LOCATION.test(s) && words(s) <= 5 && !isRole(s)) || /^(?:remote|hybrid|on-?site)\b/i.test(s)
const clean = s => s.replace(EMPLOYMENT, '').replace(DURATION, '').replace(/\(\s*\)/g, '').replace(EDGE, '').trim()

// ---------- dates ----------

const DATE_RES = new Map()
function dateRe(lang) {
  if (DATE_RES.has(lang)) return DATE_RES.get(lang)
  const pt = String.raw`(?:\p{L}{3,10}\.?\s\d{4}|\d{1,2}\/\d{4}|\d{4}(?:-\d{1,2})?)(?!\d)`
  const present = presentWords(lang).map(escRe).join('|')
  const range = String.raw`\s*(?:[–—-]|\s(?:${rangeWords(lang).map(escRe).join('|')}))\s*(?:${pt}|(?:${present})(?!\p{L}))`
  const re = new RegExp(`${pt}(${range})?`, 'iuy')
  DATE_RES.set(lang, re)
  return re
}

const SEP_BEFORE = /(?:^|\s{2,}|[|,(–—·-]\s*)$/
const SEP_AFTER = /^(?:$|\s{2,}|\s*[|,)–—·])/

/** The first date range on a line (a single date only when set off by a separator); null if none. */
function findDate(line, lang = 'en') {
  const re = dateRe(lang)
  let single = null
  for (let i = 0; i < line.length; i++) {
    if (i && /[\p{L}\p{N}]/u.test(line[i - 1])) continue // matches start at token boundaries only
    re.lastIndex = i
    const m = re.exec(line)
    if (!m || !parseDateRange(m[0], lang)) continue
    const hit = { start: i, end: i + m[0].length, text: m[0].replace(/\s+/g, ' ') }
    if (m[1]) return hit
    single ??= SEP_BEFORE.test(line.slice(0, hit.start)) && SEP_AFTER.test(line.slice(hit.end)) ? hit : null
  }
  return single
}

// ---------- entry heads ----------

function splitPlain(s, order = SPLITS) {
  for (const sep of order) {
    const [re, once] = Array.isArray(sep) ? [sep[0], true] : [sep, false]
    const m = re.exec(s)
    if (!m) continue
    const parts = once ? [s.slice(0, m.index), s.slice(m.index + m[0].length)] : s.split(re)
    return parts.map(clean).filter(Boolean)
  }
  return [s]
}

// `Title, Org | City` splits the first pipe part at its comma first (the ATS text export writes this shape).
function splitFields(s, piped) {
  if (!s) return []
  if (!piped) return splitPlain(s)
  const parts = s.split('|').map(clean).filter(Boolean)
  if (parts.length && parts.length < 3) {
    const sub = splitPlain(parts[0], [SPLITS[6], ...SPLITS.slice(0, 6)])
    if (sub.length > 1) return [...sub, ...parts.slice(1)]
  }
  return parts
}

// The part that reads like a role (or a degree) is the title; failing that, an organisation is not.
function assign(fields) {
  const f = [...fields]
  const role = f.findIndex(isRole)
  if (role > 0 && !isRole(f[0])) f.unshift(...f.splice(role, 1))
  else if (role < 0 && f.length > 1 && ORG.test(f[0]) && !ORG.test(f[1])) [f[0], f[1]] = [f[1], f[0]]
  return [f[0] ?? '', f[1] ?? '', f.slice(2).join(', ')]
}

// ---------- lines ----------

const isSentence = s => /[;:]$/.test(s) || (/[.!?]$/.test(s) && words(s) > 4)

function headingOf(lines, i, lang) {
  const line = lines[i], s = line.replace(/\s*:$/, '')
  if (!s || s.length > 60 || BULLET.test(line)) return null
  if (categorize(s, lang)) return { title: s, dict: true }
  const n = words(s)
  if (n <= 6 && /^[=-]{3,}$/.test(lines[i + 1] ?? '')) return { title: s, underline: true }
  if (n <= 5 && /\p{Lu}/u.test(s) && s === s.toUpperCase() && !/[\d,@|]/.test(s)) return { title: s }
  return null
}

function contactParts(line) {
  const parts = line.split(PART_SEP).map(p => p.trim()).filter(Boolean)
  if (parts.some(p => detectContact(p, 0).kind !== 'text') || LABEL_LINE.test(line)) return parts
  return isPlace(line) ? [line] : null
}

const isNameLike = line => words(line) <= 6 && /\p{L}/u.test(line) && !/[\d@|:]/.test(line) && !categorize(line) && !/[.!?]$/.test(line)

export function fromPlainText(text, lang = 'en') {
  const lines = String(text ?? '').split(/\r\n?|\n/).map(l => l.replace(/[\u00ad\u200b-\u200d]/g, '').trim()) // trim drops a BOM
  const out = [], notes = []
  const note = code => notes.push({ line: out.length, code, vars: {} })

  // ---------- header: up to the first heading ----------
  let i = 0, seen = 0, name = null, nameAt = 0, afterName = false
  const taglines = [], contacts = []
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (!line || RULE.test(line)) continue
    if (name === null && CV_WORD.test(line.replace(/\s*:$/, ''))) { seen++; continue } // a 'Résumé' title, not a heading
    const head = headingOf(lines, i, lang)
    if (head && (head.dict || name !== null) && !(afterName && isRole(line))) break
    seen++
    const wasAfter = afterName
    afterName = false
    const parts = seen <= 8 && contactParts(line)
    if (parts) contacts.push(...parts)
    else if (name === null && isNameLike(line)) { name = line; nameAt = seen; afterName = true }
    else taglines.push(wasAfter || !BULLET.test(line) ? line : line.replace(BULLET, ''))
  }
  const guessed = name === null ? (name = taglines.shift() ?? (contacts.length ? '' : null)) !== null : nameAt !== 1
  if (name !== null) {
    out.push('# ' + escLine(name))
    if (guessed) note('guessed-name')
    if (!contacts.length) note('no-contacts')
    out.push(...taglines.map(escLine))
    if (contacts.length) out.push(guardLine(contacts.map(escText).join(DEFAULT_CONTACT_SEP)))
  }

  // ---------- sections ----------
  let cat = null, sections = 0
  const pending = [] // entry sections: text lines that may still turn out to be part of an entry head
  const blank = () => { if (out.length && out.at(-1) !== '') out.push('') }
  const flush = () => pending.splice(0).forEach(textLine)
  function textLine(line) {
    const label = LIST_CATS.has(cat) && LABEL_ITEM.exec(line)
    if (label) out.push(`- **${escText(label[1])}:** ${escText(label[2])}`)
    else if (LIST_CATS.has(cat) && line.includes(',')) out.push('- ' + escText(line))
    else out.push(escLine(line))
  }
  function bullet(line) {
    const item = line.replace(BULLET, '')
    const label = LIST_CATS.has(cat) && LABEL_ITEM.exec(item)
    if (label) out.push(`- **${escText(label[1])}:** ${escText(label[2])}`)
    else if (item) out.push('- ' + escText(item)) // a lone bullet glyph line is dropped
  }
  const headEligible = line => line && !BULLET.test(line) && !RULE.test(line) && words(line) <= 8 && !isSentence(line) && !findDate(line, lang)

  function entry(line, date) {
    const rest = clean(line.slice(0, date.start) + (line.includes('|') ? ' | ' : '  ') + line.slice(date.end))
    const fields = splitFields(rest, line.includes('|'))
    const heads = []
    while (heads.length < 2 - fields.length && pending.length && headEligible(pending.at(-1))) heads.unshift(clean(pending.pop()))
    flush()
    fields.unshift(...heads.filter(Boolean))
    let merged = heads.length > 0
    const next = lines[i + 1]
    if (headEligible(next) && !headingOf(lines, i + 1, lang) &&
      (fields.length < 2 ? isRole(next) || ORG.test(next) : fields.length === 2 && isPlace(next) || !rest && words(next) <= 4)) {
      fields.push(clean(next))
      merged = true
      i++
    }
    const f = assign(fields.filter(Boolean))
    f.splice(2, 0, date.text)
    while (f.length && !f.at(-1)) f.pop()
    out.push(('### ' + f.map((v, k) => k === 2 ? v : escText(v)).join(' | ')).replace(/ {2,}/g, ' '))
    if (fields.length < 2) note('unsplit-entry')
    else if (merged) note('guessed-entry')
  }

  for (; i < lines.length; i++) {
    const line = lines[i]
    if (!line) { flush(); blank(); continue }
    if (RULE.test(line)) continue
    if (BULLET.test(line)) { flush(); bullet(line); continue }
    if (/^\p{Ll}/u.test(line) && /^- /.test(out.at(-1) ?? '') && !pending.length) { out[out.length - 1] += ' ' + escText(line); continue }
    const head = headingOf(lines, i, lang)
    if (head) {
      flush()
      blank()
      out.push('## ' + escText(head.title))
      cat = categorize(head.title, lang)
      sections++
      if (head.underline) i++
      continue
    }
    const date = ENTRY_CATS.has(cat) && words(line) <= 16 && !/\.$/.test(line) && findDate(line, lang)
    if (date) entry(line, date)
    else if (ENTRY_CATS.has(cat)) pending.push(line)
    else textLine(line)
  }
  flush()
  if (out.at(-1) === '') out.pop()
  if (out.length && !sections) notes.push({ line: 1, code: 'no-sections', vars: {} })
  return { content: out.length ? out.join('\n') + '\n' : '', notes }
}
