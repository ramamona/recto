// Layout model (spec 3.4–3.7): defaults, normalization, ops, section config and geometry.
// Pure: geometry in mm, font sizes in pt. Every layout that leaves this module is normalized.
import { CATEGORIES, categorize } from './categories.js'

export const PAGE_SIZES = { A4: [210, 297], Letter: [215.9, 279.4], Legal: [215.9, 355.6], A5: [148, 210] }

export const FONT_PRESETS = ['system-ui', 'neo-grotesque', 'humanist', 'geometric', 'transitional', 'old-style', 'didone', 'slab', 'mono']

export const VARIANTS = ['list', 'compact', 'timeline', 'tags', 'grid']

// Theme enums (3.5) keyed by token, plus the other layout enums (first value = default).
export const ENUMS = {
  headingCase: ['none', 'upper', 'small-caps'],
  headingRule: ['none', 'below', 'above', 'bar'],
  nameCase: ['none', 'upper'],
  bulletChar: ['•', '◦', '▪', '–', '-', '·', ''],
  dateStyle: ['right', 'inline', 'below', 'left'],
  linkStyle: ['plain', 'underline', 'accent'],
  colorHeading: ['accent', 'text'], // or a hex colour
  pageSize: ['A4', 'Letter', 'Legal', 'A5', 'custom'],
  align: ['left', 'center', 'right'],
  photoShape: ['circle', 'rounded', 'square'],
  photoPosition: ['left', 'right'],
  panelBorder: ['none', 'solid', 'dashed'],
  decorKind: ['rect', 'line', 'ellipse'],
  decorZ: ['back', 'front'],
  decorPages: ['all', 'first', 'rest'], // or an array of 1-based page numbers
}

export const THEME_DEFAULTS = Object.freeze({
  fontBody: 'neo-grotesque', fontHeading: 'neo-grotesque', fontMono: 'mono',
  sizeName: 24, sizeSection: 11, sizeEntry: 10.5, sizeBody: 9.75, sizeSmall: 8.75,
  lineHeight: 1.35,
  gapParagraph: 1.2, gapEntry: 3, gapSection: 5,
  density: 1,
  colorText: '#111827', colorMuted: '#4b5563', colorAccent: '#1d4ed8', colorRule: '#d1d5db', colorPage: '#ffffff',
  colorHeading: 'accent',
  headingCase: 'upper', headingLetterSpacing: 0.06, headingWeight: 700, nameWeight: 700,
  headingRule: 'below', nameCase: 'none', bulletChar: '•', dateStyle: 'right', linkStyle: 'plain',
})

// [min, max] of every numeric theme token
export const RANGES = {
  sizeName: [6, 48], sizeSection: [6, 48], sizeEntry: [6, 48], sizeBody: [6, 48], sizeSmall: [6, 48],
  lineHeight: [1, 2],
  gapParagraph: [0, 20], gapEntry: [0, 20], gapSection: [0, 20],
  density: [0.7, 1.2],
  headingLetterSpacing: [0, 0.08], // wider breaks text extraction
  headingWeight: [300, 900], nameWeight: [300, 900],
}

// column: null = first grid column, resolved by sectionConfig
export const SECTION_DEFAULTS = Object.freeze({
  column: null, hidden: false, variant: 'list',
  showTitle: true, ruleAbove: false, ruleBelow: false,
  breakBefore: false, keepTogether: true, panel: null,
})

const MAX_STR = 20000
const COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const SIDES = ['top', 'right', 'bottom', 'left']
const FLAGS = ['hidden', 'showTitle', 'ruleAbove', 'ruleBelow', 'breakBefore', 'keepTogether']

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const obj = v => isObj(v) ? v : {}
const list = v => Array.isArray(v) ? v : []
const num = (v, min, max, def) => typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def
const oneOf = (v, options, def) => options.includes(v) ? v : def
const isColor = v => typeof v === 'string' && COLOR.test(v)
const color = (v, def) => isColor(v) ? v : def
const isId = v => typeof v === 'string' && v.length <= MAX_STR && /^[a-z0-9-]+$/.test(v)
const isFont = v => FONT_PRESETS.includes(v) || (typeof v === 'string' && v.length <= MAX_STR && /^font:(?=.*\S)[^\p{Cc}]+$/u.test(v))

export function defaultLayout(size = 'A4') {
  return normalizeLayout({ page: { size } })
}

/** Never throws; always returns a fresh, fully populated layout (no references into `input`). */
export function normalizeLayout(input) {
  const l = obj(input)
  const page = normPage(obj(l.page))
  return {
    version: 1,
    lang: normLang(l.lang),
    page,
    grid: normGrid(obj(l.grid)),
    header: normHeader(obj(l.header)),
    theme: normTheme(obj(l.theme)),
    sectionDefaults: normConfigs(l.sectionDefaults, k => k === '*' || CATEGORIES.includes(k)),
    sections: normConfigs(l.sections, isId),
    decor: normDecor(list(l.decor), page),
    customCss: typeof l.customCss === 'string' ? l.customCss.slice(0, 50000) : '',
  }
}

function normLang(v) {
  try { return typeof v === 'string' && v ? Intl.getCanonicalLocales(v)[0] : 'en' } catch { return 'en' }
}

function normPage(p) {
  const size = oneOf(p.size, ENUMS.pageSize, 'A4')
  const [width, height] = PAGE_SIZES[size] ?? [num(p.width, 80, 600, 210), num(p.height, 80, 600, 297)]
  const m = obj(p.margins)
  return {
    size, width, height,
    margins: Object.fromEntries(SIDES.map(k => [k, num(m[k], 0, 60, 16)])),
    targetPages: Math.round(num(p.targetPages, 1, 10, 1)),
  }
}

function normGrid(g) {
  const columns = []
  const taken = id => id === 'full' || columns.some(c => c.id === id) // 'full' is a headerSpan value
  for (const c of list(g.columns).filter(isObj).slice(0, 3)) {
    let id = isId(c.id) && !taken(c.id) ? c.id : null
    for (let n = columns.length + 1; !id; n++) if (!taken(`col-${n}`)) id = `col-${n}`
    const col = { id, width: num(c.width, 0.2, 5, 1) }
    if (isColor(c.bg)) col.bg = c.bg
    if (typeof c.bleed === 'boolean') col.bleed = c.bleed
    for (const k of ['textColor', 'mutedColor', 'accentColor']) if (isColor(c[k])) col[k] = c[k]
    columns.push(col)
  }
  if (!columns.length) columns.push({ id: 'main', width: 1 })
  const ids = columns.map(c => c.id)
  const widestFirst = [...columns].sort((a, b) => b.width - a.width).map(c => c.id) // stable: ties keep visual order
  return {
    columns,
    gutter: num(g.gutter, 0, 40, 8),
    headerSpan: ids.includes(g.headerSpan) ? g.headerSpan : 'full',
    readingOrder: [...new Set([...list(g.readingOrder).filter(id => ids.includes(id)), ...widestFirst])],
  }
}

const PHOTO_SRC = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/

function normHeader(h) {
  const p = obj(h.photo)
  const ok = typeof p.src === 'string' && p.src.length <= 200000 && PHOTO_SRC.test(p.src)
  return {
    align: oneOf(h.align, ENUMS.align, 'left'),
    photo: ok ? {
      src: p.src,
      size: num(p.size, 10, 80, 28),
      shape: oneOf(p.shape, ENUMS.photoShape, 'circle'),
      position: oneOf(p.position, ENUMS.photoPosition, 'left'),
    } : null,
  }
}

function themeValue(k, v, def) {
  if (k in RANGES) return num(v, ...RANGES[k], def)
  if (k.startsWith('font')) return isFont(v) ? v : def
  if (k === 'colorHeading') return ENUMS.colorHeading.includes(v) || isColor(v) ? v : def
  if (k.startsWith('color')) return color(v, def)
  return oneOf(v, ENUMS[k], def)
}

function normTheme(t) {
  return Object.fromEntries(Object.entries(THEME_DEFAULTS).map(([k, def]) => [k, themeValue(k, t[k], def)]))
}

// Partial SectionConfig: keeps only valid keys. A column id not in the grid is kept (resolved by sectionConfig).
function normSectionConfig(c) {
  const out = {}
  if (isId(c.column)) out.column = c.column
  if (VARIANTS.includes(c.variant)) out.variant = c.variant
  for (const k of FLAGS) if (typeof c[k] === 'boolean') out[k] = c[k]
  if (c.panel === null) out.panel = null
  else if (isObj(c.panel)) {
    const p = c.panel
    out.panel = {
      bg: color(p.bg, '#f4f4f5'),
      border: oneOf(p.border, ENUMS.panelBorder, 'none'),
      borderColor: color(p.borderColor, '#e4e4e7'),
      borderWidth: num(p.borderWidth, 0, 5, 0.3),
      radius: num(p.radius, 0, 20, 2),
      padding: num(p.padding, 0, 20, 3),
    }
  }
  return out
}

function normConfigs(m, keyOk) {
  return Object.fromEntries(Object.entries(obj(m))
    .filter(([k, v]) => keyOk(k) && isObj(v))
    .map(([k, v]) => [k, normSectionConfig(v)]))
}

function normDecor(items, page) {
  items = items.filter(isObj)
  const used = new Set()
  const ids = items.map(d => isId(d.id) && !used.has(d.id) ? (used.add(d.id), d.id) : null)
  let n = 1
  const nextId = () => {
    while (used.has(`d${n}`)) n++
    used.add(`d${n}`)
    return `d${n}`
  }
  const pos = (v, max, def) => num(v, -50, max + 50, def)
  return items.map((d, i) => {
    const pages = Array.isArray(d.pages) ? [...new Set(d.pages.filter(p => Number.isInteger(p) && p >= 1))] : d.pages
    return {
      id: ids[i] ?? nextId(),
      kind: oneOf(d.kind, ENUMS.decorKind, 'rect'),
      pages: Array.isArray(pages) ? (pages.length ? pages : 'all') : oneOf(pages, ENUMS.decorPages, 'all'),
      x: pos(d.x, page.width, 0), y: pos(d.y, page.height, 0),
      w: pos(d.w, page.width, 10), h: pos(d.h, page.height, 10),
      fill: color(d.fill, null), stroke: color(d.stroke, null),
      strokeWidth: num(d.strokeWidth, 0, 10, 0.5),
      radius: num(d.radius, 0, 100, 0),
      opacity: num(d.opacity, 0, 1, 1),
      z: oneOf(d.z, ENUMS.decorZ, 'back'),
    }
  })
}

/** Load a `*.cv.json` container (object or JSON string). Never throws; unknown keys are dropped. */
export function migrateFile(json) {
  const warnings = []
  let f = json
  if (typeof f === 'string') { try { f = JSON.parse(f) } catch { f = null } }
  if (!isObj(f)) {
    warnings.push('invalid-file')
    f = {}
  } else if (typeof f.version === 'number' && f.version > 1) warnings.push('newer-version')
  const file = {
    format: 'recto',
    version: 1,
    name: typeof f.name === 'string' ? f.name.slice(0, MAX_STR) : '',
    content: typeof f.content === 'string' ? f.content.replace(/\r\n?/g, '\n') : '',
    layout: normalizeLayout(f.layout),
  }
  const fonts = list(f.fonts)
    .filter(x => isObj(x) && typeof x.family === 'string' && x.family && typeof x.data === 'string')
    .map(({ family, data }) => ({ family, data }))
  if (fonts.length) file.fonts = fonts
  return { file, warnings }
}

export const getPath = (o, path) => path.reduce((cur, k) => cur == null ? undefined : cur[k], o)

/** Immutable: sets each op's value at its path (creating objects; `undefined` deletes), then normalizes. */
export function applyLayoutOps(layout, ops) {
  const out = normalizeLayout(layout) // fresh copy, safe to mutate
  for (const op of list(ops)) {
    const path = op?.path
    if (!Array.isArray(path) || !path.length || path.includes('__proto__')) continue
    let cur = out
    for (const k of path.slice(0, -1)) {
      if (!Object.hasOwn(cur, k) || cur[k] === null || typeof cur[k] !== 'object') cur[k] = {}
      cur = cur[k]
    }
    const last = path.at(-1)
    // clone so a later op writing into this value never mutates the caller's object
    if (op.value !== undefined) cur[last] = typeof op.value === 'object' ? structuredClone(op.value) : op.value
    else if (Array.isArray(cur) && Number.isInteger(last)) cur.splice(last, 1)
    else delete cur[last]
  }
  return normalizeLayout(out)
}

/** The only place section config is resolved (layout must be normalized). */
export function sectionConfig(layout, section) {
  const { grid, sectionDefaults: d } = layout
  const cat = categorize(section.title, layout.lang)
  const c = { ...SECTION_DEFAULTS, column: grid.columns[0].id, ...d['*'], ...(cat && d[cat]), ...layout.sections[section.id] }
  if (!grid.columns.some(col => col.id === c.column)) c.column = grid.readingOrder[0]
  return c
}

export function placeSections(doc, layout) {
  const out = Object.fromEntries(layout.grid.columns.map(c => [c.id, []]))
  for (const section of doc.sections) {
    const config = sectionConfig(layout, section)
    if (!config.hidden) out[config.column].push({ section, config })
  }
  return out
}

/** Carry a section's config across a title edit: exactly one id replaced in place by a new one. */
export function renameSectionIds(prevDoc, nextDoc, layout) {
  const a = list(prevDoc?.sections).map(s => s.id)
  const b = list(nextDoc?.sections).map(s => s.id)
  if (a.length !== b.length) return layout
  const changed = a.flatMap((id, i) => id === b[i] ? [] : [i])
  if (changed.length !== 1) return layout
  const from = a[changed[0]], to = b[changed[0]]
  if (b.includes(from) || a.includes(to) || !Object.hasOwn(layout.sections, from)) return layout
  return applyLayoutOps(layout, [{ path: ['sections', to], value: layout.sections[from] }, { path: ['sections', from], value: undefined }])
}

export function contentBox({ page: { width, height, margins: m } }) {
  return { x: m.left, y: m.top, w: Math.max(0, width - m.left - m.right), h: Math.max(0, height - m.top - m.bottom) }
}

/** Column boxes in mm from the page's left edge. */
export function columnGeometry(layout) {
  const { columns, gutter } = layout.grid
  const box = contentBox(layout)
  const fr = columns.reduce((s, c) => s + c.width, 0)
  const free = Math.max(0, box.w - gutter * (columns.length - 1))
  let x = box.x
  return columns.map(c => {
    const w = free * c.width / fr
    const g = { id: c.id, x, w }
    x += w + gutter
    return g
  })
}
