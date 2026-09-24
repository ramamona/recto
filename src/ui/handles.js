// Canvas handles (spec 5.3 Center): margin lines on 4 edges, column boundaries and gutter width, with snapping.
// The pure helpers work in page mm; drawHandles builds the overlay elements for one page box (mm units).
import { columnGeometry } from '../model/layout.js'
import { clamp, h } from './dom.js'

const MARGIN_MAX = 60
const GUTTER_MAX = 40
const SIDES = ['top', 'right', 'bottom', 'left']
const round = (v, d = 1000) => Math.round(v * d) / d
export const fmt = v => String(Math.round(v * 10) / 10)

/** Nearest target within `tol`, else the 1 mm grid; `free` (Alt held) keeps 0.1 mm precision. */
export function snap(v, targets, tol, free) {
  if (free) return { v: round(v, 10), target: null }
  let best = null
  for (const t of targets) if (Math.abs(t - v) <= tol && (best == null || Math.abs(t - v) < Math.abs(best - v))) best = t
  return best == null ? { v: Math.round(v), target: null } : { v: best, target: best }
}

/** Margin value for `side` when its edge sits at page point `pt`. */
export function marginValue(layout, side, pt) {
  const { width, height } = layout.page
  return { left: pt.x, right: width - pt.x, top: pt.y, bottom: height - pt.y }[side]
}

const gutterMid = (layout, i) => {
  const g = columnGeometry(layout)[i]
  return g.x + g.w + layout.grid.gutter / 2
}

/** Gutter after `i` dragged by one of its edges to page x. */
export function gutterValue(layout, i, x) {
  return 2 * Math.abs(x - gutterMid(layout, i))
}

/** Width ops moving the boundary between columns i and i+1 to page x; the pair keeps its fr sum. */
export function columnResizeOps(layout, i, x) {
  const geo = columnGeometry(layout)
  const cols = layout.grid.columns
  const g = layout.grid.gutter
  const left = geo[i].x
  const span = geo[i + 1].x + geo[i + 1].w - left - g
  const a = clamp(x - g / 2 - left, 0, span)
  const pair = cols[i].width + cols[i + 1].width
  const wi = round(clamp(span > 0 ? pair * a / span : pair / 2, Math.max(0.2, pair - 5), Math.min(5, pair - 0.2)))
  return [
    { path: ['grid', 'columns', i, 'width'], value: wi },
    { path: ['grid', 'columns', i + 1, 'width'], value: round(pair - wi) }
  ]
}

function marginHandle(view, page, side) {
  const { t, store } = view
  const m = store.state.layout.page.margins
  const { width, height } = store.state.layout.page
  const vertical = side === 'left' || side === 'right'
  const at = { left: m.left, right: width - m.right, top: m.top, bottom: height - m.bottom }[side]
  const label = t('canvas.readout.margin', { side: t(`canvas.side.${side}`), value: fmt(m[side]) })
  return h('div', {
    class: `cvs-handle cvs-handle--${vertical ? 'x' : 'y'} cvs-handle--margin`,
    style: vertical ? { left: `${at}mm` } : { top: `${at}mm` },
    title: label,
    onPointerdown: e => view.drag(e, page, (pt, ev, key) => {
      const layout = store.state.layout
      const others = SIDES.filter(s => s !== side).map(s => layout.page.margins[s])
      const v = clamp(snap(marginValue(layout, side, pt), others, view.tol(), ev.altKey).v, 0, MARGIN_MAX)
      store.setLayout([{ path: ['page', 'margins', side], value: v }], { coalesceKey: key })
      view.readout(t('canvas.readout.margin', { side: t(`canvas.side.${side}`), value: fmt(v) }), ev)
    })
  })
}

function columnHandles(view, page, i) {
  const { t, store } = view
  const layout = store.state.layout
  const geo = columnGeometry(layout)
  const { gutter } = layout.grid
  const { margins: m, height } = layout.page
  const mid = geo[i].x + geo[i].w + gutter / 2
  const box = { top: `${m.top}mm`, height: `${Math.max(0, height - m.top - m.bottom)}mm` }
  const widths = l => columnGeometry(l).slice(i, i + 2).map(c => fmt(c.w))
  const resize = h('div', {
    class: 'cvs-handle cvs-handle--x cvs-handle--column',
    style: { left: `${mid}mm`, ...box },
    title: t('canvas.handle.columns'),
    onPointerdown: e => view.drag(e, page, (pt, ev, key) => {
      const cur = store.state.layout
      const x = snap(pt.x, [cur.page.width / 2], view.tol(), ev.altKey).v
      store.setLayout(columnResizeOps(cur, i, x), { coalesceKey: key })
      const [a, b] = widths(store.state.layout)
      view.readout(t('canvas.readout.columns', { a, b }), ev)
    })
  })
  const edge = dir => h('div', {
    class: 'cvs-handle cvs-knob cvs-handle--gutter',
    style: { left: `${mid + dir * gutter / 2}mm`, top: `${m.top + (height - m.top - m.bottom) / 2}mm` },
    title: t('canvas.handle.gutter'),
    onPointerdown: e => {
      const start = store.state.layout // the gutter centre moves as the gutter changes; measure from the start
      view.drag(e, page, (pt, ev, key) => {
        const v = clamp(snap(gutterValue(start, i, pt.x), [], view.tol(), ev.altKey).v, 0, GUTTER_MAX)
        store.setLayout([{ path: ['grid', 'gutter'], value: v }], { coalesceKey: key })
        view.readout(t('canvas.readout.gutter', { value: fmt(v) }), ev)
      })
    }
  })
  return [resize, edge(-1), edge(1)]
}

/** Handle elements for one page box (children positioned in mm from the page's top-left). */
export function drawHandles(view, page) {
  const cols = view.store.state.layout.grid.columns
  return [
    ...SIDES.map(side => marginHandle(view, page, side)),
    ...cols.slice(1).flatMap((_, i) => columnHandles(view, page, i))
  ]
}
