// renderAtoms (spec 4.3 step 1): AST + layout → the header element and each column's atoms (DOM contract 4.1).
// User data only ever reaches the DOM through createElement / text nodes / setAttribute.
import { categorize } from '../model/categories.js'
import { placeSections } from '../model/layout.js'
import { inlineText } from '../model/markdown.js'
import { DATE_SEP, ORG_SEP, TAG_SEP } from '../model/separators.js'

const SAFE_HREF = /^(https?:|mailto:|tel:)/i
const LOC_SEP = TAG_SEP // ' · ' before the location in one-line heads; separators.js has no dedicated constant

// h(tag, className, ...children): strings become text nodes; null/'' children are skipped.
const maker = document => (tag, cls, ...children) => {
  const el = document.createElement(tag)
  if (cls) el.className = cls
  el.append(...children.filter(c => c != null && c !== ''))
  return el
}

function link(h, href, children) {
  const a = h('a', null, ...children)
  if (SAFE_HREF.test(href)) a.setAttribute('href', href)
  return a
}

function inlines(h, nodes) {
  return nodes.map(n => {
    if (n.t === 'text') return n.v
    if (n.t === 'br') return h('br')
    if (n.t === 'code') return h('code', null, n.v)
    if (n.t === 'strong' || n.t === 'em') return h(n.t, null, ...inlines(h, n.c))
    if (n.t === 'link') return link(h, n.href, inlines(h, n.c))
    return null
  })
}

// Present fields only, with a visible separator text node between neighbours (spec 4.2).
function joinFields(first, ...rest) {
  const out = first ? [first] : []
  for (const [sep, el] of rest) if (el) out.push(...(out.length ? [sep, el] : [el]))
  return out
}

function contactsEl(h, contacts, sep) {
  const box = h('div', 'cv-contacts')
  contacts.forEach((c, i) => {
    if (i) box.append(sep)
    const value = c.href && c.valid ? link(h, c.href, [c.text]) : c.text
    const el = h('span', 'cv-contact', c.label ? `${c.label}: ` : null, value)
    el.dataset.kind = c.kind
    box.append(el)
  })
  return box
}

function headerEl(h, header, layout) {
  const text = h('div', 'cv-header-text',
    h('h1', 'cv-name', header.name),
    ...header.taglines.map(t => h('p', 'cv-tagline', ...inlines(h, t.inlines))),
    header.contacts.length ? contactsEl(h, header.contacts, header.contactSep) : null)
  const el = h('header', 'cv-header', text)
  el.dataset.atom = 'header'
  el.dataset.line = header.line
  el.dataset.align = layout.header.align
  const photo = layout.header.photo
  if (photo) {
    const img = h('img', 'cv-photo')
    img.setAttribute('src', photo.src) // attribute only: the data URL never reaches CSS url()
    img.setAttribute('alt', '')
    img.dataset.shape = photo.shape
    img.style.width = img.style.height = `${photo.size}mm`
    if (photo.position === 'left') el.prepend(img)
    else el.append(img)
  }
  if (header.rule) el.append(h('hr', 'cv-rule'))
  return el
}

// DOM order = visual order for every date style; `inline` is also the compact variant's head.
function entryHead(h, e, style) {
  const title = e.title.length ? h('span', 'cv-entry-title', ...inlines(h, e.title)) : null
  const org = e.org.length ? h('span', 'cv-org', ...inlines(h, e.org)) : null
  const date = e.date ? h('span', 'cv-date', e.date) : null
  const loc = e.location ? h('span', 'cv-location', e.location) : null
  const main = () => h('span', 'cv-entry-main', ...joinFields(title, [ORG_SEP, org]))
  let parts
  if (style === 'inline') parts = joinFields(title, [ORG_SEP, org], [DATE_SEP, date], [LOC_SEP, loc])
  else if (style === 'below') parts = [main(), date || loc ? h('span', 'cv-entry-meta', ...joinFields(date, [LOC_SEP, loc])) : null]
  else if (style === 'left') parts = [date, main(), loc]
  else parts = [main(), date, loc]
  return h('div', 'cv-entry-head', ...parts)
}

// A leading `**Label:**` (colon inside the bold) becomes the item's label (tags and grid variants).
function splitLabel(nodes) {
  const [first, ...rest] = nodes
  const label = first?.t === 'strong' ? inlineText(first.c).trim() : ''
  return label.endsWith(':') ? { label, rest } : { label: null, rest: nodes }
}

function tagsEl(h, list) {
  const box = h('div', 'cv-tags')
  for (const item of list.items) {
    const { label, rest } = splitLabel(item.inlines)
    const chips = inlineText(rest).split(',').map(s => s.trim()).filter(Boolean)
    const group = h('div', 'cv-tag-group', label && h('span', 'cv-tag-label', label), label && chips.length ? ' ' : null)
    chips.forEach((chip, i) => {
      if (i) group.append(h('span', 'cv-tag-sep', TAG_SEP))
      group.append(h('span', 'cv-tag', chip))
    })
    box.append(group)
  }
  return box
}

function gridEl(h, list) {
  const box = h('div', 'cv-grid')
  for (const item of list.items) {
    const { label, rest } = splitLabel(item.inlines)
    box.append(h('div', 'cv-grid-item', label && h('span', 'cv-label', label), label ? ' ' : null, ...inlines(h, rest)))
  }
  return box
}

function sectionEl(h, section, config, layout) {
  const el = h('section', config.panel ? 'cv-section cv-panel' : 'cv-section')
  el.dataset.section = section.id
  el.dataset.category = categorize(section.title, layout.lang) ?? ''
  el.dataset.variant = config.variant
  if (config.ruleAbove) el.dataset.ruleAbove = ''
  if (config.ruleBelow) el.dataset.ruleBelow = ''
  const p = config.panel
  if (p) {
    // normalized layout values: hex colours and clamped numbers only
    el.style.background = p.bg
    el.style.padding = `${p.padding}mm`
    el.style.borderRadius = `${p.radius}mm`
    if (p.border !== 'none') el.style.border = `${p.borderWidth}mm ${p.border} ${p.borderColor}`
  }
  return el
}

function sectionAtoms(h, section, config, layout) {
  const id = section.id
  const sec = { key: id, el: sectionEl(h, section, config, layout) }
  const headStyle = config.variant === 'compact' ? 'inline' : layout.theme.dateStyle
  const atoms = []
  const add = (el, kind, line, wrap, opts = {}) => {
    el.dataset.atom = kind
    el.dataset.line = line
    atoms.push({ el, kind, sectionId: id, line, keepWithNext: false, group: null, breakBefore: false, wrap: [sec, ...wrap], ...opts })
  }
  const blockAtoms = (b, wrap, key, group) => {
    if (b.type === 'paragraph') add(h('p', 'cv-p', ...inlines(h, b.inlines)), 'p', b.line, wrap, { group })
    else if (b.type === 'rule') add(h('hr', 'cv-rule'), 'rule', b.line, wrap, { group })
    else if (b.type === 'list' && (config.variant === 'tags' || config.variant === 'grid')) {
      add(config.variant === 'tags' ? tagsEl(h, b) : gridEl(h, b), 'list', b.line, wrap, { group })
    } else if (b.type === 'list') {
      const list = { key: `${key}:list`, el: h('ul', 'cv-list') }
      for (const item of b.items) add(h('li', 'cv-li', ...inlines(h, item.inlines)), 'li', item.line, [...wrap, list], { group })
    }
  }

  if (config.showTitle && section.title.trim()) {
    add(h('h2', 'cv-section-title', ...inlines(h, section.titleInlines)), 'title', section.line, [], { keepWithNext: true })
  }
  let entryIndex = 0
  section.blocks.forEach((b, i) => {
    if (b.type !== 'entry') return blockAtoms(b, [], `${id}:${i}`, null)
    const n = entryIndex++
    const entry = { key: `${id}:e${n}`, el: h('div', 'cv-entry') }
    entry.el.dataset.head = headStyle
    const group = config.keepTogether ? `${id}:${n}` : null
    add(entryHead(h, b, headStyle), 'entry-head', b.line, [entry], { keepWithNext: true, group })
    b.blocks.forEach((c, j) => blockAtoms(c, [entry], `${entry.key}:${j}`, group))
  })
  if (atoms.length && config.breakBefore) atoms[0].breakBefore = true
  return atoms
}

/** Atom = { el, kind, sectionId, line, keepWithNext, group, breakBefore, wrap: [{ key, el }] (outer → inner) }. */
export function renderAtoms(doc, layout, document = globalThis.document) {
  const h = maker(document)
  const columns = {}
  for (const [colId, placed] of Object.entries(placeSections(doc, layout))) {
    columns[colId] = placed.flatMap(({ section, config }) => sectionAtoms(h, section, config, layout))
  }
  return { header: doc.header ? headerEl(h, doc.header, layout) : null, columns }
}
