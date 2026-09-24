// layoutPages (spec 4.3–4.6): render atoms, measure them on a hidden page, paginate, build the pages,
// verify every page column against real layout, and report. Also the pages host and the paint check (4.2).
import { getPath, normalizeLayout } from '../model/layout.js'
import { composite, parseColor, toHex } from '../preflight/contrast.js'
import { columnBgRects, decorBox, onPage, renderDecor } from './decor.js'
import { paginate, usedHeight } from './paginate.js'
import { renderAtoms } from './render.js'
import { columnCss, themeAttrs, themeToCss } from './theme.js'

const PX_PER_MM = 96 / 25.4
const MAX_VERIFY = 5
const CSS_URL = new URL('../../styles/cv.css', import.meta.url).href
const sheetLoaded = new WeakMap() // ShadowRoot → Promise settled once cv.css has loaded (or failed)

/** Attaches the pages shadow root: cv.css, theme and custom-CSS style slots, and the `.cv-pages` container. */
export function createPagesHost(container) {
  const document = container.ownerDocument
  const root = container.attachShadow({ mode: 'open' })
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = CSS_URL
  sheetLoaded.set(root, new Promise(done => { link.onload = link.onerror = done }))
  const slot = name => {
    const style = document.createElement('style')
    style.setAttribute(name, '')
    return style
  }
  const pages = document.createElement('div')
  pages.className = 'cv-pages'
  root.append(link, slot('data-theme'), slot('data-custom'), pages)
  return root
}

// Page box, grid tracks and column placement; readingOrder is DOM order, grid-column keeps the visual order.
function layoutCss(layout) {
  const { width, height, margins: m } = layout.page
  const { columns, gutter, headerSpan } = layout.grid
  const pos = id => columns.findIndex(c => c.id === id) + 1
  const underHeader = id => headerSpan === 'full' || headerSpan === id
  const firstPage = '.cv-page:is([data-page="1"], .cv-measure)'
  return [
    `.cv-pages {\n${themeToCss(layout.theme)}\n}`,
    `.cv-page { width: ${width}mm; height: ${height}mm; padding: ${m.top}mm ${m.right}mm ${m.bottom}mm ${m.left}mm; }`,
    `.cv-page-grid { grid-template-columns: ${columns.map(c => `minmax(0, ${c.width}fr)`).join(' ')}; column-gap: ${gutter}mm; }`,
    `.cv-header { grid-column: ${headerSpan === 'full' ? '1 / -1' : pos(headerSpan)}; }`,
    ...columns.map(c => `.cv-col[data-col="${c.id}"] { grid-column: ${pos(c.id)}; ${columnCss(c).replace(/\n/g, ' ')} }`),
    ...columns.map(c => `${firstPage} .cv-col[data-col="${c.id}"] { grid-row: ${underHeader(c.id) ? 2 : '1 / -1'}; }`)
  ].join('\n')
}

function applyStyles(layout, host) {
  const root = host.querySelector('.cv-pages')
  root.setAttribute('lang', layout.lang)
  for (const [k, v] of Object.entries(themeAttrs(layout.theme))) root.setAttribute(k, v)
  const heading = layout.theme.colorHeading
  root.dataset.headingColor = heading === 'accent' || heading === 'text' ? heading : 'custom'
  host.querySelector('style[data-theme]').textContent = layoutCss(layout)
  host.querySelector('style[data-custom]').textContent = layout.customCss
  // @page is ignored inside shadow roots, so it lives in a light-DOM <style> (spec 4.6)
  const pageStyle = host.ownerDocument.getElementById('recto-page')
  if (pageStyle) pageStyle.textContent = `@page { size: ${layout.page.width}mm ${layout.page.height}mm; margin: 0; }`
  return root
}

// Appends atoms to a column cell, cloning each wrapper template once per consecutive run of its key.
// The first atom and every wrapper opened with it get .cv-first (margin-top: 0).
function fillColumn(col, atoms, indices) {
  const open = []
  const clones = []
  indices.forEach((i, n) => {
    const a = atoms[i]
    let depth = 0
    while (depth < open.length && depth < a.wrap.length && open[depth].key === a.wrap[depth].key) depth++
    open.length = depth
    for (let k = depth; k < a.wrap.length; k++) {
      const el = a.wrap[k].el.cloneNode(false)
      el.classList.toggle('cv-first', n === 0)
      const parent = k ? open[k - 1].el : col
      parent.append(el)
      open.push({ key: a.wrap[k].key, el })
      clones.push({ key: a.wrap[k].key, el })
    }
    a.el.classList.toggle('cv-first', n === 0)
    const parent = open.length ? open[open.length - 1].el : col
    parent.append(a.el)
  })
  return clones
}

function buildGrid(ctx, header, indicesByCol) {
  const { document, layout, atoms } = ctx
  const grid = document.createElement('div')
  grid.className = 'cv-page-grid'
  if (header) grid.append(header)
  const cols = {}
  const clones = []
  for (const id of layout.grid.readingOrder) {
    const col = document.createElement('div')
    col.className = 'cv-col'
    col.dataset.col = id
    clones.push(...fillColumn(col, atoms[id], indicesByCol[id]))
    grid.append(col)
    cols[id] = col
  }
  return { grid, cols, clones }
}

const px = v => parseFloat(v) || 0

// Spec 4.3 step 2: h / hStart / hEnd per atom from one continuous hidden page (fractional rects).
function measure(ctx, root) {
  const { document, layout, atoms, header } = ctx
  const all = Object.fromEntries(Object.entries(atoms).map(([id, list]) => [id, list.map((_, i) => i)]))
  const page = document.createElement('div')
  page.className = 'cv-page cv-measure'
  const { grid, cols } = buildGrid(ctx, header, all)
  page.append(grid)
  root.append(page)
  const view = document.defaultView
  // rects are in transformed (zoomed) space; the page's CSS width is exact, so it gives the scale
  const scale = page.getBoundingClientRect().width / (layout.page.width * PX_PER_MM) || 1
  const edges = new Map()
  const edgesOf = el => {
    if (!edges.has(el)) {
      const cs = view.getComputedStyle(el)
      edges.set(el, [px(cs.paddingTop) + px(cs.borderTopWidth), px(cs.paddingBottom) + px(cs.borderBottomWidth)])
    }
    return edges.get(el)
  }
  const measured = {}
  for (const [id, list] of Object.entries(atoms)) {
    const m = list.map(a => {
      const r = a.el.getBoundingClientRect()
      let start = 0
      let end = 0
      for (let w = a.el.parentElement; w !== cols[id]; w = w.parentElement) {
        const [t, b] = edgesOf(w)
        start += t
        end += b
      }
      return { top: r.top / scale, hStart: start, hEnd: r.height / scale + end }
    })
    measured[id] = list.map((a, i) => ({
      h: i < list.length - 1 ? m[i + 1].top - m[i].top : m[i].hEnd,
      hStart: m[i].hStart,
      hEnd: m[i].hEnd,
      keepWithNext: a.keepWithNext,
      group: a.group,
      breakBefore: a.breakBefore
    }))
  }
  let headerHeight = 0
  if (header) {
    const cs = view.getComputedStyle(header)
    headerHeight = header.getBoundingClientRect().height / scale + px(cs.marginTop) + px(cs.marginBottom)
  }
  page.remove()
  return { measured, headerHeight, scale }
}

function buildPages(ctx, pagination) {
  const { document, layout, header } = ctx
  const count = pagination.pages.length
  const clones = []
  const cols = []
  const pages = pagination.pages.map((byCol, p) => {
    const page = document.createElement('div')
    page.className = 'cv-page'
    page.dataset.page = p + 1
    const g = buildGrid(ctx, p === 0 ? header : null, byCol)
    page.append(renderDecor(layout, p + 1, count, 'back', document), g.grid, renderDecor(layout, p + 1, count, 'front', document))
    cols.push(g.cols)
    clones.push(...g.clones.map(c => ({ ...c, page: p })))
    return page
  })
  // .cv-cont-prev / .cv-cont-next: styling hooks on wrapper fragments that continue across pages
  const first = new Map()
  const last = new Map()
  for (const c of clones) {
    if (!first.has(c.key)) first.set(c.key, c.page)
    last.set(c.key, c.page)
  }
  for (const c of clones) {
    c.el.classList.toggle('cv-cont-prev', c.page > first.get(c.key))
    c.el.classList.toggle('cv-cont-next', c.page < last.get(c.key))
  }
  return { pages, cols }
}

// Spec 4.3 step 5: first page column whose content overflows its cell (layout px, unaffected by zoom).
function firstOverflow(ctx, pagination, built) {
  for (const [p, byCol] of pagination.pages.entries()) {
    for (const id of ctx.layout.grid.readingOrder) {
      const col = built.cols[p][id]
      const excess = col.scrollHeight - col.clientHeight
      if (excess <= 1) continue
      const lone = byCol[id].length === 1 && pagination.flags.some(f => f.kind === 'overflow' && f.page === p + 1 && f.colId === id)
      if (!lone) return { p, id, excess }
    }
  }
  return null
}

/** Renders `doc` into `host` (from createPagesHost). Resolves with the page elements, report and placement. */
export async function layoutPages(doc, layout, host) {
  layout = normalizeLayout(layout)
  const document = host.ownerDocument
  const { header, columns: atoms } = renderAtoms(doc, layout, document)
  const photo = header?.querySelector('.cv-photo')
  await Promise.all([sheetLoaded.get(host), document.fonts?.ready, photo?.decode().catch(() => {})])

  // synchronous from here on, so the visible pages never show a half-built state
  const root = applyStyles(layout, host)
  const ctx = { document, layout, atoms, header }
  const { measured, headerHeight, scale } = measure(ctx, root)
  const { top, bottom } = layout.page.margins
  const contentHeight = (layout.page.height - top - bottom) * PX_PER_MM
  const underHeader = id => layout.grid.headerSpan === 'full' || layout.grid.headerSpan === id
  const capacityFirst = Object.fromEntries(Object.keys(atoms).map(id => [id, contentHeight - (underHeader(id) ? headerHeight : 0)]))
  const capacity = (p, id) => p === 0 ? capacityFirst[id] : contentHeight
  const capacityOverride = {}
  let pagination, built, failed
  for (let pass = 1; ; pass++) {
    pagination = paginate({ columns: measured, capacityFirst, capacityRest: contentHeight, capacityOverride, epsilon: 0.5 })
    built = buildPages(ctx, pagination)
    root.replaceChildren(...built.pages)
    failed = firstOverflow(ctx, pagination, built)
    if (!failed || pass === MAX_VERIFY) break
    const cap = capacityOverride[failed.p]?.[failed.id] ?? capacity(failed.p, failed.id)
    capacityOverride[failed.p] = { ...capacityOverride[failed.p], [failed.id]: cap - failed.excess - 1 }
  }
  const run = { ...ctx, doc, pagination, built, measured, capacity, scale }
  return { pages: built.pages, report: buildReport(run, failed), placement: buildPlacement(run) }
}

// ---------- report (spec 4.3 step 6) ----------

// Every placed atom in stream order: page 1 header, then per page each column in readingOrder.
function placedAtoms({ layout, atoms, header, doc, pagination }) {
  const out = []
  pagination.pages.forEach((byCol, p) => {
    if (p === 0 && header) out.push({ el: header, page: 1, colId: null, sectionId: null, line: doc.header.line, kind: 'header' })
    for (const id of layout.grid.readingOrder) {
      for (const i of byCol[id]) {
        const a = atoms[id][i]
        out.push({ el: a.el, page: p + 1, colId: id, sectionId: a.sectionId, line: a.line, kind: a.kind })
      }
    }
  })
  return out
}

function buildPlacement(run) {
  return placedAtoms(run).map(({ page, colId, sectionId, line, kind }) => ({ page, colId, sectionId, line, kind }))
}

function buildReport(run, failed) {
  const { layout, atoms, pagination, measured, capacity } = run
  const flags = pagination.flags.map(f => {
    const a = atoms[f.colId][f.atom]
    return { kind: f.kind, page: f.page, colId: f.colId, sectionId: a.sectionId, line: a.line }
  })
  if (failed) {
    const a = atoms[failed.id][pagination.pages[failed.p][failed.id].at(-1)] // an overflowing column holds atoms
    flags.push({ kind: 'verify-failed', page: failed.p + 1, colId: failed.id, sectionId: a.sectionId, line: a.line })
  }
  const last = pagination.pages.length - 1
  const fill = Math.max(0, ...layout.grid.readingOrder.map(id => {
    const ix = pagination.pages[last][id]
    const cap = capacity(last, id)
    return ix.length ? (cap > 0 ? usedHeight(measured[id], ix) / cap : 1) : 0
  }))
  const placed = placedAtoms(run)
  return {
    pageCount: pagination.pages.length,
    targetPages: layout.page.targetPages,
    lastPageFill: Math.round(fill * 1000) / 1000,
    flags,
    textStyles: textStyles(run, placed),
    fontsMissing: fontsMissing(layout.theme, run.document),
    pages: pagination.pages.map((_, p) => pageSummary(layout, placed.filter(a => a.page === p + 1)))
  }
}

function pageSummary(layout, placed) {
  const lines = el => el.innerText.split('\n').map(s => s.trim()).filter(Boolean)
  const withText = placed.filter(a => a.el.textContent.trim())
  const firstLines = withText.length ? lines(withText[0].el) : []
  const lastLines = withText.length ? lines(withText.at(-1).el) : []
  return {
    firstText: firstLines[0] ?? '',
    lastText: lastLines.at(-1) ?? '',
    columnsWithText: layout.grid.readingOrder.filter(id => withText.some(a => a.colId === id))
  }
}

function fontsMissing(theme, document) {
  const loaded = new Set()
  document.fonts?.forEach(f => { if (f.status === 'loaded') loaded.add(f.family.replace(/^(["'])(.*)\1$/, '$2')) })
  const wanted = new Set([theme.fontBody, theme.fontHeading, theme.fontMono].filter(v => v.startsWith('font:')))
  return [...wanted].filter(v => !loaded.has(v.slice(5).trim()))
}

// role + size token per text element, by its nearest contract class (first match wins)
const ROLES = [
  ['.cv-name', 'name', 'sizeName'],
  ['.cv-section-title', 'heading', 'sizeSection'],
  ['.cv-date, .cv-location, .cv-entry-meta, .cv-contacts, .cv-tags', 'small', 'sizeSmall'],
  ['.cv-entry-head, .cv-tagline', 'body', 'sizeEntry'],
  ['*', 'body', 'sizeBody']
]
const MUTED = '.cv-date, .cv-location, .cv-entry-meta, .cv-tag-sep, .cv-contacts, .cv-tagline'
const COL_KEY = { text: 'textColor', muted: 'mutedColor', accent: 'accentColor' }
const THEME_KEY = { text: 'colorText', muted: 'colorMuted', accent: 'colorAccent' }
const THEME_OF_COL = { textColor: 'colorText', mutedColor: 'colorMuted', accentColor: 'colorAccent' }

// Which layout colour cv.css uses for this element; a column with its own colour or a background owns it.
function colorPath(el, layout, colIndex) {
  const col = colIndex >= 0 ? layout.grid.columns[colIndex] : null
  let src = layout.theme.linkStyle === 'accent' && el.closest('a') ? 'accent'
    : el.closest('.cv-section-title') ? 'heading'
      : el.closest(MUTED) ? 'muted' : 'text'
  const ownedByColumn = s => col && (col[COL_KEY[s]] || col.bg)
  if (src === 'heading') {
    const mode = layout.theme.colorHeading
    if ((mode !== 'accent' && mode !== 'text') || !ownedByColumn(mode)) return ['theme', 'colorHeading']
    src = mode
  }
  return ownedByColumn(src) ? ['grid', 'columns', colIndex, COL_KEY[src]] : ['theme', THEME_KEY[src]]
}

function colorAt(layout, path) {
  const v = getPath(layout, path)
  if (path[1] === 'colorHeading') return v === 'accent' ? layout.theme.colorAccent : v === 'text' ? layout.theme.colorText : v
  return v ?? layout.theme[THEME_OF_COL[path[3]]] // column without its own colour inherits the theme's
}

const hexOf = s => {
  const c = parseColor(s)
  return c ? toHex(c) : null
}

// Opaque backdrop behind an atom, bottom-up: page → column bg → back decor under the atom box → element backgrounds.
function backgroundOf(run, atomEl, pageEl, pageNo) {
  const { layout, scale } = run
  const view = run.document.defaultView
  const pr = pageEl.getBoundingClientRect()
  const r = atomEl.getBoundingClientRect()
  const mm = v => v / scale / PX_PER_MM
  const box = { x: mm(r.left - pr.left), y: mm(r.top - pr.top), w: mm(r.width), h: mm(r.height) }
  const hits = d => d.x < box.x + box.w && box.x < d.x + d.w && d.y < box.y + box.h && box.y < d.y + d.h
  const chain = []
  for (let el = atomEl; el && el !== pageEl; el = el.parentElement) chain.unshift(el)
  const bg = el => [view.getComputedStyle(el).backgroundColor, 1]
  const layers = [
    bg(pageEl),
    ...columnBgRects(layout).filter(hits).map(b => [b.fill, 1]),
    ...layout.decor.filter(d => d.z === 'back' && d.kind !== 'line' && d.fill && onPage(d.pages, pageNo) && hits(decorBox(d)))
      .map(d => [d.fill, d.opacity]),
    ...chain.map(bg)
  ]
  let c = { r: 255, g: 255, b: 255, a: 1 }
  for (const [color, opacity] of layers) {
    const top = parseColor(color)
    if (top && top.a > 0) c = composite({ ...top, a: top.a * opacity }, c)
  }
  return toHex(c)
}

function textStyles(run, placed) {
  const { layout, built, document } = run
  const view = document.defaultView
  const out = []
  for (const a of placed) {
    const pageEl = built.pages[a.page - 1]
    const background = backgroundOf(run, a.el, pageEl, a.page)
    const colIndex = layout.grid.columns.findIndex(c => c.id === a.colId)
    const seen = new Set()
    const walker = document.createTreeWalker(a.el, 4 /* NodeFilter.SHOW_TEXT */)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.data.trim()) continue
      const el = node.parentElement
      const cs = view.getComputedStyle(el)
      const [, role, sizeToken] = ROLES.find(([sel]) => el.closest(sel))
      const fg = parseColor(cs.color)
      const color = fg ? toHex(composite(fg, parseColor(background))) : cs.color
      const fontSizePt = Math.round(px(cs.fontSize) * 75) / 100
      const key = [role, fontSizePt, color, cs.fontFamily].join('|')
      if (seen.has(key)) continue
      seen.add(key)
      const path = colorPath(el, layout, colIndex)
      out.push({
        sectionId: a.sectionId, line: a.line, page: a.page, role, sizeToken, fontSizePt, color,
        colorPath: hexOf(colorAt(layout, path)) === color ? path : null,
        background, family: cs.fontFamily
      })
    }
  }
  return out
}

// ---------- paint invariant (spec 4.2) ----------

const FORBIDDEN = [
  ['float', v => v !== 'none'],
  ['position', v => v !== 'static'],
  ['transform', v => v !== 'none'],
  ['opacity', v => parseFloat(v) < 1],
  ['z-index', v => v !== 'auto'],
  ['filter', v => v !== 'none'],
  ['order', v => v !== '0']
]

/** Text-bearing elements inside a page with a computed style that would reorder PDF text. */
export function paintViolations(host) {
  const view = host.ownerDocument.defaultView
  const out = []
  for (const el of host.querySelectorAll('.cv-page *')) {
    const text = el.textContent.trim()
    if (!text) continue
    const cs = view.getComputedStyle(el)
    for (const [prop, bad] of FORBIDDEN) {
      const value = cs.getPropertyValue(prop)
      if (bad(value)) out.push({ selector: el.localName + [...el.classList].map(c => '.' + c).join(''), prop, value, text: text.slice(0, 60) })
    }
  }
  return out
}
