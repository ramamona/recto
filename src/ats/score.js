// ATS report (review-jobs spec §2): a deterministic 0–100 score from eight weighted checks,
// plus the mock applicant form an ATS would fill. Pure: reuses preflight issues and their fixes.
import { inlineText } from '../model/markdown.js'
import { normalizeLayout, placeSections, sectionConfig } from '../model/layout.js'
import { categorize } from '../model/categories.js'
import { extractText, extractFields, allContacts, emailOf, splitLabel, entryFields } from '../preflight/ats.js'

export const GRADE = score => score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F'

const EMPTY_DOC = { header: null, sections: [], diagnostics: [] }
const SEVERITY = { error: 'critical', warn: 'warning', info: 'info' }
const REQUIRED = ['experience', 'education', 'skills']
const OPTIONAL = ['summary', 'projects', 'certifications']
// Custom CSS that takes text out of view or out of normal flow.
const HIDING = /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0*)?\s*(?:[;}!]|$)|font-size\s*:\s*0(?![.\d])|position\s*:\s*(?:absolute|fixed)|transform\s*:|text-indent\s*:\s*-|color\s*:\s*transparent/i

function item (severity, msg, vars = {}, at = {}) {
  const out = { severity, msg, vars }
  for (const k of ['line', 'sectionId', 'fix']) if (at[k] != null) out[k] = at[k]
  return out
}
/** A preflight issue as a check item: same key, vars, Locate line and fix. */
const fromIssue = i => item(SEVERITY[i.severity] ?? 'info', i.msg, i.vars ?? {}, i)
const clamp = (earned, weight) => Math.max(0, Math.min(weight, Math.round(earned)))
const done = (id, weight, earned, items) => ({ id, weight, earned: clamp(earned, weight), items })

export function atsReport ({ source, doc, layout, report = null, placement = null, issues = [], lang } = {}) {
  const c = { doc: doc ?? EMPTY_DOC, layout: normalizeLayout(layout), report, placement, issues: issues ?? [] }
  c.lang = lang ?? c.layout.lang
  c.of = rule => c.issues.filter(i => i.rule === rule)
  c.sections = c.doc.sections.filter(s => !sectionConfig(c.layout, s).hidden)
    .map(s => ({ s, cat: categorize(s.title, c.lang) }))
  c.fields = mockForm(c)
  const checks = [textCheck, headingsCheck, contactCheck, orderCheck, entriesCheck, charsCheck, hiddenCheck, lengthCheck].map(f => f(c))
  const score = checks.reduce((sum, x) => sum + x.earned, 0)
  return { score, grade: GRADE(score), checks, fields: c.fields }
}

// ---------- checks ----------

function textCheck ({ doc, layout, placement }) {
  const chars = extractText(doc, layout, placement).trim().length
  const items = chars < 100 ? [item('critical', 'ats.text.tooShort', { chars, min: 300 })]
    : chars < 300 ? [item('warning', 'ats.text.short', { chars, min: 300 })] : []
  return done('text', 10, 10 * Math.min(1, chars / 300), items)
}

function headingsCheck ({ sections, of }) {
  const cats = new Set(sections.map(x => x.cat))
  const missing = REQUIRED.filter(cat => !cats.has(cat))
  const odd = of('nonstandard-heading')
  const bonus = OPTIONAL.filter(cat => cats.has(cat)).length
  const items = [...missing.map(section => item('warning', 'ats.headings.missing', { section })), ...odd.map(fromIssue)]
  return done('headings', 20, 20 - 6 * missing.length - Math.min(6, 2 * odd.length) + bonus, items)
}

function contactCheck ({ fields, of }) {
  const items = [], m = fields.missing
  let earned = 15
  if (m.email) {
    earned -= 8
    items.push(item('critical', 'preflight.missing-email'), ...of('invalid-email').map(fromIssue))
  }
  if (m.phone) { earned -= 4; items.push(item('warning', 'preflight.missing-phone')) }
  if (m.location) { earned -= 3; items.push(item('warning', 'ats.contact.noLocation')) }
  return done('contact', 15, earned, items)
}

function orderCheck (c) {
  const { doc, layout, placement, of } = c
  const items = []
  let earned = 20
  const columns = textColumns(c)
  const multi = of('multi-column')
  if (columns > 1 || multi.length) {
    earned -= 10
    items.push(...(multi.length ? multi.map(fromIssue) : [item('warning', 'ats.order.multiColumn', { columns })]))
  }
  const interrupts = of('column-interrupts-entry')
  if (interrupts.length) { earned -= 5; items.push(...interrupts.map(fromIssue)) }
  const span = layout.grid.headerSpan
  const headerLate = !doc.header ? false
    : placement ? placement.some(p => p.kind === 'header') && placement.find(p => p.kind !== 'rule')?.kind !== 'header'
      : span !== 'full' && span !== layout.grid.readingOrder[0]
  if (headerLate) {
    earned -= 5
    items.push(item('warning', 'ats.order.headerNotFirst', {}, { fix: { kind: 'layout', ops: [{ path: ['grid', 'headerSpan'], value: 'full' }] } }))
  }
  return done('order', 20, earned, items)
}

/** Most text columns on one page: from the placement when rendered, else from the layout. */
function textColumns ({ doc, layout, placement }) {
  if (!placement) return Object.values(placeSections(doc, layout)).filter(col => col.length).length
  const pages = new Map()
  for (const p of placement) {
    if (p.colId == null || p.kind === 'rule') continue
    if (!pages.has(p.page)) pages.set(p.page, new Set())
    pages.get(p.page).add(p.colId)
  }
  return Math.max(0, ...[...pages.values()].map(s => s.size))
}

function entriesCheck ({ fields, of }) {
  const all = [...fields.work, ...fields.education]
  const bad = all.filter(e => e.missing.length)
  const fixes = new Map(of('entry-date').map(i => [i.line, i.fix]))
  const items = bad.map(e => item('warning', 'ats.entries.incomplete', { title: e.title, missing: e.missing },
    { ...e, fix: fixes.get(e.line) }))
  return done('entries', 15, all.length ? 15 * (all.length - bad.length) / all.length : 15, items)
}

function charsCheck ({ layout: { theme }, of }) {
  const families = [...new Set([theme.fontBody, theme.fontHeading, theme.fontMono].filter(f => f.startsWith('font:')))]
  const invisible = of('invisible-characters'), special = of('special-characters')
  const items = [
    ...families.map(f => item('info', 'ats.chars.customFont', { family: f.slice(5).trim() })),
    ...invisible.map(fromIssue), ...special.map(fromIssue),
  ]
  return done('chars', 10, 10 - (families.length ? 2 : 0) - (invisible.length ? 3 : 0) - (special.length ? 2 : 0), items)
}

function hiddenCheck ({ layout, of }) {
  const contrast = of('low-contrast').filter(i => i.severity === 'error')
  const tiny = of('font-too-small').filter(i => i.vars?.size < 6)
  const css = HIDING.test(layout.customCss)
  const items = [...contrast.map(fromIssue), ...tiny.map(fromIssue)]
  if (css) items.push(item('warning', 'ats.hidden.customCss'))
  return done('hidden', 5, 5 - (contrast.length ? 3 : 0) - (tiny.length ? 2 : 0) - (css ? 2 : 0), items)
}

function lengthCheck ({ report, of }) {
  const pages = report?.pageCount ?? 1
  const long = of('bullet-too-long')
  const items = []
  if (pages > 2) items.push(item('warning', 'ats.length.pages', { pages, max: 2 }, { fix: of('pages-over-target')[0]?.fix }))
  items.push(...long.map(fromIssue))
  return done('length', 5, 5 - 2 * Math.max(0, pages - 2) - Math.min(3, long.length), items)
}

// ---------- mock applicant form ----------

function mockForm ({ doc, layout, lang, sections }) {
  const f = extractFields(doc, layout)
  const contacts = allContacts(doc, lang)
  const emails = contacts.filter(x => x.kind === 'email')
  const valid = emails.find(x => x.valid)
  const form = {
    name: f.name.trim(),
    email: valid ? emailOf(valid) : '',
    phone: f.phones[0] ?? '',
    location: f.location,
    links: contacts.filter(x => x.kind === 'url').map(x => ({ label: x.label || x.text, url: x.href ?? x.text })),
    work: entriesOf(sections, 'experience'),
    education: entriesOf(sections, 'education'),
    skills: sections.filter(x => x.cat === 'skills').flatMap(x => skillsOf(x.s.blocks)),
  }
  const has = cat => sections.some(x => x.cat === cat)
  const missing = {}
  for (const k of ['name', 'email', 'phone', 'location']) if (!form[k]) missing[k] = 'not-found'
  if (!valid && emails.length) missing.email = 'invalid'
  for (const [k, cat] of [['work', 'experience'], ['education', 'education'], ['skills', 'skills']]) {
    if (!form[k].length) missing[k] = has(cat) ? 'not-found' : 'no-section'
  }
  form.missing = missing
  return form
}

function entriesOf (sections, cat) {
  return sections.filter(x => x.cat === cat).flatMap(({ s }) => s.blocks.filter(b => b.type === 'entry').map(e => {
    const { title, org: company, start, end, current, location } = entryFields(e)
    const missing = [!title.trim() && 'title', !company.trim() && 'company', !start && 'start'].filter(Boolean)
    return { title, company, start, end, current, location: location ?? '', missing, line: e.line, sectionId: s.id }
  }))
}

function skillsOf (blocks) {
  const split = text => text.split(',').map(t => t.trim()).filter(Boolean)
  return blocks.flatMap(b => b.type === 'list' ? b.items.flatMap(i => split(splitLabel(i.inlines).rest))
    : b.type === 'paragraph' ? split(inlineText(b.inlines)) : [])
}
