// JSON Resume export/import (spec 6.4). Pure module; never throws on foreign input.
// Warnings are `{ code, vars }`: 'unparseable-date', 'section-not-exported', 'edited-outside', 'invalid-file'.
import { parse, inlineText, parseDateRange, formatDate, detectContact, joinEntryFields } from '../model/markdown.js'
import { normalizeLayout, defaultLayout, sectionConfig } from '../model/layout.js'
import { categorize } from '../model/categories.js'
import { DEFAULT_CONTACT_SEP } from '../model/separators.js'
import { allContacts, emailOf, entryFields, splitLabel } from '../preflight/ats.js'

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const obj = v => isObj(v) ? v : {}
const arr = v => Array.isArray(v) ? v : []
const str = v => typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
// Drops missing and empty-string values; arrays stay even when empty (`keywords: []`).
const compact = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== ''))

// ---------- export ----------

const NETWORKS = {
  'linkedin.com': 'LinkedIn', 'github.com': 'GitHub', 'gitlab.com': 'GitLab', 'x.com': 'X', 'twitter.com': 'Twitter',
  'stackoverflow.com': 'StackOverflow', 'medium.com': 'Medium', 'behance.net': 'Behance', 'dribbble.com': 'Dribbble',
}

function profile(href) {
  let u
  try { u = new URL(href) } catch { return null }
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  const domain = Object.keys(NETWORKS).find(d => host === d || host.endsWith('.' + d))
  return domain ? compact({ network: NETWORKS[domain], username: u.pathname.split('/').filter(Boolean).pop(), url: href }) : null
}

function basics(doc, lang, summary) {
  const contacts = allContacts(doc, lang)
  const first = kind => contacts.find(c => c.kind === kind)
  const urls = contacts.filter(c => c.kind === 'url' && c.href).map(c => c.href)
  const email = first('email'), loc = first('text')?.text ?? '', cut = loc.lastIndexOf(',')
  const tagline = doc.header?.taglines[0]
  return compact({
    name: doc.header?.name,
    label: tagline && inlineText(tagline.inlines),
    email: email && emailOf(email),
    phone: first('phone')?.text,
    url: urls.find(u => !profile(u)),
    summary,
    location: loc ? compact(cut < 0 ? { city: loc } : { city: loc.slice(0, cut).trim(), region: loc.slice(cut + 1).trim() }) : null,
    profiles: urls.map(profile).filter(Boolean),
  })
}

function firstLink(inlines) {
  for (const n of inlines) {
    const href = n.t === 'link' ? n.href : n.c && firstLink(n.c)
    if (href) return href
  }
  return null
}

const paragraphs = blocks => blocks.filter(b => b.type === 'paragraph').map(b => inlineText(b.inlines))

function entryData(e, warnings) {
  if (e.date && !e.dateRange) warnings.push({ code: 'unparseable-date', vars: { title: inlineText(e.title), date: e.date } })
  return { ...entryFields(e), url: firstLink([...e.title, ...e.org]), summary: paragraphs(e.blocks).join('\n') }
}

// category → [JSON Resume key, entry → item]
const ENTRIES = {
  experience: ['work', d => ({ position: d.title, name: d.org, url: d.url, location: d.location, startDate: d.start, endDate: d.end, summary: d.summary, highlights: d.bullets })],
  volunteering: ['volunteer', d => ({ position: d.title, organization: d.org, url: d.url, startDate: d.start, endDate: d.end, summary: d.summary, highlights: d.bullets })],
  education: ['education', d => ({ area: d.title, institution: d.org, url: d.url, startDate: d.start, endDate: d.end, courses: d.bullets })],
  projects: ['projects', d => ({ name: d.title, entity: d.org, description: d.summary, highlights: d.bullets, startDate: d.start, endDate: d.end, url: d.url })],
  awards: ['awards', d => ({ title: d.title, awarder: d.org, date: d.start, summary: d.summary })],
  certifications: ['certificates', d => ({ name: d.title, issuer: d.org, date: d.start, url: d.url })],
  publications: ['publications', d => ({ name: d.title, publisher: d.org, releaseDate: d.start, url: d.url, summary: d.summary })],
  references: ['references', d => ({ name: d.title, reference: d.summary })],
}

const splitList = s => s.split(',').map(t => t.trim()).filter(Boolean)
function keywordItem(inlines) {
  const { label, rest } = splitLabel(inlines)
  return label ? { name: label, keywords: splitList(rest) } : { name: rest, keywords: [] }
}
const keywordEntry = d => ({ name: d.title, level: d.org, keywords: d.bullets })

// category → [JSON Resume key, list item → item, entry → item]
const LISTS = {
  skills: ['skills', keywordItem, keywordEntry],
  interests: ['interests', keywordItem, keywordEntry],
  languages: ['languages', inlines => {
    const { label, rest } = splitLabel(inlines)
    return label ? { language: label, fluency: rest } : { language: rest }
  }, d => ({ language: d.title, fluency: d.org })],
}

export function toJsonResume(input) {
  const { content, layout } = obj(input)
  const source = typeof content === 'string' ? content : ''
  const l = normalizeLayout(layout)
  const doc = parse(source)
  const warnings = [], out = {}, summary = []
  const add = (key, item) => (out[key] ??= []).push(compact(item))
  for (const s of doc.sections) {
    if (sectionConfig(l, s).hidden) continue
    const cat = categorize(s.title, l.lang)
    if (cat === 'summary') summary.push(...paragraphs(s.blocks))
    else if (ENTRIES[cat]) {
      const [key, map] = ENTRIES[cat]
      for (const b of s.blocks) if (b.type === 'entry') add(key, map(entryData(b, warnings)))
    } else if (LISTS[cat]) {
      const [key, item, entry] = LISTS[cat]
      for (const b of s.blocks) {
        if (b.type === 'list') b.items.forEach(i => add(key, item(i.inlines)))
        else if (b.type === 'entry') add(key, entry(entryFields(b)))
      }
    } else warnings.push({ code: 'section-not-exported', vars: { section: s.title } })
  }
  const json = { basics: basics(doc, l.lang, summary.join('\n\n')), ...out, meta: { recto: { content: source, layout: l } } }
  return { json, warnings }
}

// ---------- import ----------

// Inline escapes for generated text; whitespace runs (newlines too) collapse to one space. A bare URL the
// parser will autolink keeps its characters raw (backslashes inside an autolink are kept), except `|`.
const ESCAPE = /(?<![\w.+-])https?:\/\/[^\s<>]+|[\\*_[\]|`]/gi
export const escText = s => str(s).replace(/[^\S\u00a0]+/g, ' ').trim()
  .replace(ESCAPE, m => m.length > 1 ? m.replaceAll('|', '\\|') : '\\' + m)
// Keeps a generated line from reading as a block. '-' and '•' have no backslash escape (spec 3.2), so the
// space after them becomes an en space: not a bullet, and it collapses back to ' ' when parsed.
export const guardLine = s => s.replace(/^#/, '\\#').replace(/^([-•])[ \u00a0]/, '$1\u2002').replace(/^-{3,}$/, ' $&')
export const escLine = s => guardLine(escText(s))

const paras = s => str(s).split('\n').map(escLine).filter(Boolean).flatMap((p, i) => i ? ['', p] : [p])

/** An http(s) URL as the parser would link it, or null; no characters that would break `[t](url)` or `|`. */
function safeUrl(v) {
  const c = detectContact(str(v).trim(), 0)
  return c.kind === 'url' && c.valid && /^[^\s()\\|]+$/.test(c.href) ? c.href : null
}
// 'https://github.com/jane' → 'github.com/jane' when that still reads as a URL and needs no escaping.
function shortUrl(href) {
  const s = href.replace(/^https:\/\//i, '').replace(/\/$/, '')
  return /^[a-z0-9.-]+(\/[a-z0-9.~-]+)*$/i.test(s) && detectContact(s, 0).kind === 'url' ? s : href
}

function datePoint(v, warnings) {
  const t = str(v).trim()
  if (!t) return null
  const m = /^(\d{4})(?:-(\d\d))?/.exec(t)
  const p = m ? { y: +m[1], ...(m[2] && { m: +m[2] }) } : parseDateRange(t)?.start
  if (p && p.y >= 1900 && p.y <= 2100 && !(p.m < 1 || p.m > 12)) return p
  warnings.push({ code: 'unparseable-date', vars: { date: t } })
  return null
}
const fmt = p => formatDate(p, p.m ? 'Mon YYYY' : 'YYYY', 'en')
const single = (v, w) => { const p = datePoint(v, w); return p ? fmt(p) : '' }
// JSON Resume: a missing endDate means current.
function range(x, w) {
  const a = datePoint(x.startDate, w), b = datePoint(x.endDate, w)
  if (!a) return b ? fmt(b) : ''
  if (!b) return `${fmt(a)} – Present`
  return fmt(a) === fmt(b) ? fmt(a) : `${fmt(a)} – ${fmt(b)}`
}

function entry(x, { title, org, linkTitle, date, location, summary, bullets }) {
  let t = escText(title), o = escText(org)
  const href = safeUrl(str(x.url) || str(x.website))
  if (href && t && (linkTitle || !o)) t = `[${t}](${href})`
  else if (href && o) o = `[${o}](${href})`
  const items = arr(bullets).map(escText).filter(Boolean).map(b => '- ' + b)
  return [joinEntryFields([t, o, escText(date), escText(location)]), ...paras(summary), ...items]
}

function keywordLine(name, keywords) {
  const n = escText(name), k = arr(keywords).map(escText).filter(Boolean).join(', ')
  return n && k ? [`- **${n}:** ${k}`] : n || k ? ['- ' + (n || k)] : []
}

// [JSON Resume key, heading, item → lines]
const SECTIONS = [
  ['work', 'Experience', (x, w) => entry(x, { title: x.position, org: str(x.name) || str(x.company), date: range(x, w), location: x.location, summary: x.summary, bullets: x.highlights })],
  ['volunteer', 'Volunteering', (x, w) => entry(x, { title: x.position, org: x.organization, date: range(x, w), summary: x.summary, bullets: x.highlights })],
  ['education', 'Education', (x, w) => entry(x, { title: [x.studyType, x.area].map(str).filter(Boolean).join(', '), org: x.institution, date: range(x, w), bullets: x.courses })],
  ['projects', 'Projects', (x, w) => entry(x, { title: x.name, org: x.entity, linkTitle: true, date: range(x, w), summary: x.description, bullets: x.highlights })],
  ['awards', 'Awards', (x, w) => entry(x, { title: x.title, org: x.awarder, date: single(x.date, w), summary: x.summary })],
  ['certificates', 'Certifications', (x, w) => entry(x, { title: x.name, org: x.issuer, linkTitle: true, date: single(x.date, w) })],
  ['publications', 'Publications', (x, w) => entry(x, { title: x.name, org: x.publisher, linkTitle: true, date: single(x.releaseDate, w), summary: x.summary })],
  // An entry owns the bullets after it, so skills with a level (entries) go after the plain ones.
  ['skills', 'Skills', x => str(x.level) ? entry(x, { title: x.name, org: x.level, bullets: x.keywords }) : keywordLine(x.name, x.keywords)],
  ['languages', 'Languages', x => keywordLine(x.language, [x.fluency])],
  ['interests', 'Interests', x => keywordLine(x.name, x.keywords)],
  ['references', 'References', x => entry(x, { title: x.name, summary: x.reference })],
]

function headerLines(b) {
  const loc = obj(b.location)
  const location = str(b.location) || [loc.city, loc.region || loc.countryCode].map(str).filter(Boolean).join(', ')
  // URLs stay unescaped: a scheme URL autolinks whole, and shortUrl output has no markup characters.
  const urls = [str(b.url) || str(b.website), ...arr(b.profiles).map(p => obj(p).url)].map(safeUrl).filter(Boolean).map(shortUrl)
  const contacts = [escText(b.email), escText(b.phone), ...urls, escText(location)].filter(Boolean)
  const lines = [escLine(b.label), guardLine(contacts.join(DEFAULT_CONTACT_SEP))].filter(Boolean)
  const name = guardLine(escText(b.name))
  return name || lines.length ? ['# ' + name, ...lines] : []
}

function toMarkdown(j, warnings) {
  const blocks = [headerLines(obj(j.basics))]
  const summary = paras(obj(j.basics).summary)
  if (summary.length) blocks.push(['## Summary', ...summary])
  for (const [key, heading, render] of SECTIONS) {
    const items = arr(j[key]).filter(isObj)
    if (key === 'skills') items.sort((a, b) => !!str(a.level) - !!str(b.level))
    const lines = items.flatMap(x => render(x, warnings))
    if (lines.length) blocks.push([`## ${heading}`, ...lines])
  }
  const text = blocks.filter(b => b.length).map(b => b.join('\n')).join('\n\n')
  return text && text + '\n'
}

function same(a, b) {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && same(a[k], b[k]))
}

export function fromJsonResume(input) {
  let j = input
  if (typeof j === 'string') { try { j = JSON.parse(j) } catch { j = null } }
  if (!isObj(j)) return { content: '', layout: defaultLayout(), warnings: [{ code: 'invalid-file', vars: {} }] }
  const { meta, ...fields } = j
  const recto = isObj(meta) && isObj(meta.recto) && typeof meta.recto.content === 'string' ? meta.recto : null
  if (recto) {
    const { meta: _, ...expected } = toJsonResume(recto).json
    if (same(expected, fields)) return { content: recto.content, layout: normalizeLayout(recto.layout), warnings: [] }
  }
  const warnings = recto ? [{ code: 'edited-outside', vars: {} }] : []
  const content = toMarkdown(j, warnings)
  return { content, layout: recto ? normalizeLayout(recto.layout) : defaultLayout(), warnings }
}
