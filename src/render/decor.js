// Decor layer (spec 3.7) and column backgrounds (spec 4.5): one aria-hidden SVG per page and z layer, in mm.
import { columnGeometry, contentBox } from '../model/layout.js'

const SVG = 'http://www.w3.org/2000/svg'
const BG_PAD = 4 // mm a non-bleeding column background extends past the column box

export const onPage = (pages, n) =>
  pages === 'all' || (pages === 'first' ? n === 1 : pages === 'rest' ? n > 1 : Array.isArray(pages) && pages.includes(n))

/** Column background rects in mm from the page's top-left, from live geometry (margins, gutter, page size). */
export function columnBgRects(layout) {
  const { width: W, height: H } = layout.page
  const { gutter, columns } = layout.grid
  const box = contentBox(layout)
  const geo = columnGeometry(layout)
  const clamp = (v, max) => Math.min(max, Math.max(0, v))
  return columns.flatMap((c, i) => {
    if (!c.bg) return []
    const { x, w } = geo[i]
    const left = i > 0 ? x - gutter / 2 : c.bleed ? 0 : clamp(x - BG_PAD, W)
    const right = i < columns.length - 1 ? x + w + gutter / 2 : c.bleed ? W : clamp(x + w + BG_PAD, W)
    const top = c.bleed ? 0 : clamp(box.y - BG_PAD, H)
    const bottom = c.bleed ? H : clamp(box.y + box.h + BG_PAD, H)
    return [{ colId: c.id, x: left, y: top, w: right - left, h: bottom - top, fill: c.bg }]
  })
}

/** Decor geometry with positive w/h: the model allows negative sizes (a drag up/left), SVG rects don't. */
export const decorBox = d => ({ x: Math.min(d.x, d.x + d.w), y: Math.min(d.y, d.y + d.h), w: Math.abs(d.w), h: Math.abs(d.h) })

function shape(document, d) {
  const attrs = { opacity: d.opacity }
  let tag
  if (d.kind === 'line') {
    const stroke = d.stroke ?? d.fill
    if (!stroke) return null
    tag = 'line'
    Object.assign(attrs, { x1: d.x, y1: d.y, x2: d.x + d.w, y2: d.y + d.h, stroke, 'stroke-width': d.strokeWidth, 'stroke-linecap': 'round' })
  } else {
    const b = decorBox(d)
    tag = d.kind
    if (d.kind === 'ellipse') Object.assign(attrs, { cx: b.x + b.w / 2, cy: b.y + b.h / 2, rx: b.w / 2, ry: b.h / 2 })
    else Object.assign(attrs, { x: b.x, y: b.y, width: b.w, height: b.h, rx: d.radius })
    attrs.fill = d.fill ?? 'none'
    if (d.stroke) Object.assign(attrs, { stroke: d.stroke, 'stroke-width': d.strokeWidth })
  }
  const el = document.createElementNS(SVG, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  el.dataset.decor = d.id
  return el
}

/** `pageIndex` is 1-based. The back layer also paints column backgrounds (under every decor item). */
export function renderDecor(layout, pageIndex, pageCount, z, document = globalThis.document) {
  const { width: W, height: H } = layout.page
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('class', `cv-decor cv-${z}`)
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
  svg.setAttribute('width', `${W}mm`)
  svg.setAttribute('height', `${H}mm`)
  svg.setAttribute('preserveAspectRatio', 'none')
  if (z === 'back') {
    for (const r of columnBgRects(layout)) {
      const rect = document.createElementNS(SVG, 'rect')
      for (const [k, v] of Object.entries({ class: 'cv-col-bg', x: r.x, y: r.y, width: r.w, height: r.h, fill: r.fill })) rect.setAttribute(k, v)
      rect.dataset.col = r.colId
      svg.append(rect)
    }
  }
  for (const d of layout.decor) {
    if (d.z !== z || !onPage(d.pages, pageIndex)) continue
    const el = shape(document, d)
    if (el) svg.append(el)
  }
  return svg
}
