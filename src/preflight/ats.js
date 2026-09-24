// ATS output (spec 6.2): the plain text an extractor reads, and the fields it would detect. Pure module.
import { inlineText } from '../model/markdown.js'
import { normalizeLayout, placeSections, sectionConfig } from '../model/layout.js'
import { categorize } from '../model/categories.js'
import { TAG_SEP, ORG_SEP, FIELD_SEP } from '../model/separators.js'

/** Header contacts, then contacts found in contact-category sections. */
export function allContacts(doc, lang = 'en') {
  const sections = (doc?.sections ?? []).filter(s => categorize(s.title, lang) === 'contact')
  return [...(doc?.header?.contacts ?? []), ...sections.flatMap(s => s.contacts ?? [])]
}

/** The address, not a link's text: `[Email me](mailto:x@y.dev)` → 'x@y.dev'. */
export const emailOf = c => c.href ? c.href.slice('mailto:'.length).split('?')[0] : c.text

/** `{ y, m? }` → 'YYYY' / 'YYYY-MM'; null when missing. */
const isoDate = p => p ? (p.m ? `${p.y}-${String(p.m).padStart(2, '0')}` : String(p.y)) : null

/** A leading `**Label:**` (or `**Label**:`) → { label, rest }; label is '' when there is none. */
export function splitLabel(inlines) {
  const [first, ...more] = inlines ?? []
  let label = first?.t === 'strong' ? inlineText(first.c).trim() : ''
  let rest = inlineText(more)
  if (label.endsWith(':')) label = label.slice(0, -1).trim()
  else if (label && /^\s*:/.test(rest)) rest = rest.replace(/^\s*:/, '')
  else return { label: '', rest: inlineText(inlines).trim() }
  return { label, rest: rest.trim() }
}

const contactText = c => c.label ? `${c.label}: ${c.text}` : c.text

function headerLines(h) {
  if (!h) return []
  return [h.name, ...h.taglines.map(t => inlineText(t.inlines)), h.contacts.map(contactText).join(h.contactSep)]
}

const entryHead = e => [[inlineText(e.title), inlineText(e.org)].filter(Boolean).join(ORG_SEP), e.date, e.location]
  .filter(Boolean).join(FIELD_SEP)
const bulletLine = item => '- ' + inlineText(item.inlines)

function tagLine(item) {
  const { label, rest } = splitLabel(item.inlines)
  const chips = rest.split(',').map(s => s.trim()).filter(Boolean).join(TAG_SEP)
  return [label && label + ':', chips].filter(Boolean).join(' ')
}

// Mirrors the renderer's atoms (spec 4.3): tags/grid lists are one 'list' atom, other lists one 'li' per item.
function sectionAtoms(section, config) {
  const atoms = []
  const add = (kind, line, text) => atoms.push({ sectionId: section.id, kind, line, text })
  if (config.showTitle && section.title) add('title', section.line, section.title)
  const walk = blocks => blocks.forEach(b => {
    if (b.type === 'entry') { add('entry-head', b.line, entryHead(b)); walk(b.blocks) }
    else if (b.type === 'paragraph') add('p', b.line, inlineText(b.inlines))
    else if (b.type !== 'list') return // rules carry no text
    else if (config.variant === 'tags') add('list', b.line, b.items.map(tagLine).join('\n'))
    else if (config.variant === 'grid') add('list', b.line, b.items.map(bulletLine).join('\n'))
    else b.items.forEach(item => add('li', item.line, bulletLine(item)))
  })
  walk(section.blocks)
  return atoms
}

const atomKey = a => `${a.sectionId}\n${a.line}\n${a.kind}`

/**
 * Logical order without placement (header, then columns in readingOrder, sections in source order);
 * with placement, the rendered stream order. A blank line separates runs of different sections.
 */
export function extractText(doc, layout, placement = null) {
  const l = normalizeLayout(layout)
  const placed = placeSections(doc, l)
  const header = { sectionId: null, text: headerLines(doc.header).filter(Boolean).join('\n') }
  const atoms = l.grid.readingOrder.flatMap(col => placed[col].flatMap(p => sectionAtoms(p.section, p.config)))
  let stream = [header, ...atoms]
  if (placement) {
    const index = new Map(atoms.map(a => [atomKey(a), a]))
    stream = placement.map(p => p.kind === 'header' ? header : index.get(atomKey(p))) // stale entries → undefined
  }
  const out = []
  let prev
  for (const a of stream) {
    const lines = (a?.text ?? '').split('\n').filter(Boolean)
    if (!lines.length) continue
    if (out.length && a.sectionId !== prev) out.push('')
    prev = a.sectionId
    out.push(...lines)
  }
  return out.join('\n')
}

/** An entry as an ATS reads it: plain strings, ISO dates (`end` null when current). */
export function entryFields(e) {
  const r = e.dateRange
  return {
    title: inlineText(e.title), org: inlineText(e.org),
    start: isoDate(r?.start), end: isoDate(r?.end), current: !!r?.current,
    location: e.location,
    bullets: e.blocks.flatMap(b => b.type === 'list' ? b.items.map(i => inlineText(i.inlines)) : []),
  }
}

export function extractFields(doc, layout) {
  const l = normalizeLayout(layout)
  const contacts = allContacts(doc, l.lang)
  const of = kind => contacts.filter(c => c.kind === kind)
  const tagline = doc.header?.taglines[0]
  return {
    name: doc.header?.name ?? '',
    label: tagline ? inlineText(tagline.inlines) : '',
    emails: of('email').map(emailOf),
    phones: of('phone').map(c => c.text),
    urls: of('url').map(c => c.href ?? c.text),
    location: of('text')[0]?.text ?? '',
    sections: doc.sections.filter(s => !sectionConfig(l, s).hidden).map(s => ({
      id: s.id, title: s.title, category: categorize(s.title, l.lang),
      entries: s.blocks.filter(b => b.type === 'entry').map(entryFields),
    })),
  }
}
