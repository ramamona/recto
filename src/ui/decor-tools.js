// Decor tools (spec 3.7, 5.3 Center): draw Line / Panel / Ellipse on a page, select, move, resize, nudge,
// delete and z toggle. Pure helpers work in page mm; every drag is one history entry (coalesceKey).
import { columnGeometry } from '../model/layout.js'
import { decorBox, onPage } from '../render/decor.js'
import { h } from './dom.js'
import { fmt, snap } from './handles.js'

const MIN_SIZE = 1 // mm; a smaller draw becomes a default-sized item
const DEFAULT_SIZE = { line: [40, 0], rect: [40, 20], ellipse: [20, 20] }
const BOX_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

const indexOf = (layout, id) => layout.decor.findIndex(d => d.id === id)
const byId = (layout, id) => layout.decor.find(d => d.id === id) ?? null

function segmentDistance(d, x, y) {
  const len2 = d.w * d.w + d.h * d.h
  const k = len2 ? Math.max(0, Math.min(1, ((x - d.x) * d.w + (y - d.y) * d.h) / len2)) : 0
  return Math.hypot(x - (d.x + k * d.w), y - (d.y + k * d.h))
}

function hits(d, x, y, tol) {
  if (d.kind === 'line') return segmentDistance(d, x, y) <= Math.max(tol, d.strokeWidth / 2)
  const b = decorBox(d)
  return x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol
}

/** Topmost decor item on 1-based `page` under page point (x, y) mm: front layer first, later items on top. */
export function hitDecor(layout, page, x, y, tol = 1.5) {
  const layer = z => layout.decor.filter(d => d.z === z).reverse()
  const topFirst = [...layer('front'), ...layer('back')]
  return topFirst.find(d => onPage(d.pages, page) && hits(d, x, y, tol))?.id ?? null
}

/** New geometry when `handle` (a box compass point, or 'p1'/'p2' for a line) is dragged to (x, y). */
export function resizeDecor(d, handle, x, y) {
  if (d.kind === 'line') {
    return handle === 'p1'
      ? { x, y, w: d.x + d.w - x, h: d.y + d.h - y }
      : { x: d.x, y: d.y, w: x - d.x, h: y - d.y }
  }
  const b = decorBox(d)
  let [l, t, r, btm] = [b.x, b.y, b.x + b.w, b.y + b.h]
  if (handle.includes('w')) l = x
  if (handle.includes('e')) r = x
  if (handle.includes('n')) t = y
  if (handle.includes('s')) btm = y
  return { x: Math.min(l, r), y: Math.min(t, btm), w: Math.abs(r - l), h: Math.abs(btm - t) }
}

/** A fresh item of `kind` at (x, y) on `page`, with an id unused in `layout`. */
export function newDecor(layout, kind, page, x, y) {
  const used = new Set(layout.decor.map(d => d.id))
  let n = 1
  while (used.has(`d${n}`)) n++
  const { colorAccent, colorRule } = layout.theme
  return {
    id: `d${n}`, kind, pages: [page], x, y, w: 0, h: 0,
    fill: kind === 'rect' ? '#f1f5f9' : null,
    stroke: kind === 'line' ? colorAccent : kind === 'ellipse' ? colorRule : null,
    strokeWidth: kind === 'line' ? 0.6 : 0.3, radius: 0, opacity: 1, z: 'back'
  }
}

const geomOps = (i, g) => Object.entries(g).map(([k, value]) => ({ path: ['decor', i, k], value: Math.round(value * 10) / 10 }))

export function nudgeOps(layout, id, dx, dy) {
  const i = indexOf(layout, id)
  if (i < 0) return []
  const d = layout.decor[i]
  return geomOps(i, { x: d.x + dx, y: d.y + dy })
}

// Snap targets in page mm: edges, centre, margins and column edges.
function targets(layout) {
  const { width: W, height: H, margins: m } = layout.page
  return {
    x: [0, W / 2, W, m.left, W - m.right, ...columnGeometry(layout).flatMap(c => [c.x, c.x + c.w])],
    y: [0, H / 2, H, m.top, H - m.bottom]
  }
}

// Best shift that puts one of the candidate positions on a target; without one, the first candidate on the 1 mm grid.
function snapShift(candidates, list, tol, free) {
  let best = null
  for (const c of candidates) {
    const s = snap(c, list, tol, free)
    if (s.target != null && (best == null || Math.abs(s.v - c) < Math.abs(best.shift))) best = { shift: s.v - c, at: s.target }
  }
  return best ?? { shift: snap(candidates[0], [], tol, free).v - candidates[0], at: null }
}

export function mountDecorTools(view, { onToolChange = () => {} } = {}) {
  const { store, t } = view
  let tool = 'select'

  function setTool(next) {
    tool = next
    onToolChange(tool)
  }

  const guidesFor = (page, sx, sy) => view.guides([
    ...(sx.at != null ? [{ page, axis: 'x', at: sx.at }] : []),
    ...(sy.at != null ? [{ page, axis: 'y', at: sy.at }] : [])
  ])

  function snapPoint(page, pt, ev) {
    const tg = targets(store.state.layout)
    const sx = snapShift([pt.x], tg.x, view.tol(), ev.altKey)
    const sy = snapShift([pt.y], tg.y, view.tol(), ev.altKey)
    guidesFor(page, sx, sy)
    return { x: pt.x + sx.shift, y: pt.y + sy.shift }
  }

  function draw(e, page, start) {
    const kind = tool
    const s = snapPoint(page, start, e)
    const item = newDecor(store.state.layout, kind, page.n, s.x, s.y)
    let added = false
    view.drag(e, page, (pt, ev, key) => {
      let p = snapPoint(page, pt, ev)
      if (kind === 'line' && ev.shiftKey) p = Math.abs(p.x - s.x) >= Math.abs(p.y - s.y) ? { x: p.x, y: s.y } : { x: s.x, y: p.y }
      const g = { x: s.x, y: s.y, w: p.x - s.x, h: p.y - s.y }
      const layout = store.state.layout
      if (!added) store.setLayout([{ path: ['decor', layout.decor.length], value: { ...item, ...g } }], { coalesceKey: key })
      else store.setLayout(geomOps(indexOf(layout, item.id), g), { coalesceKey: key })
      added = true
      view.readout(t('canvas.readout.size', { w: fmt(Math.abs(g.w)), h: fmt(Math.abs(g.h)) }), ev)
    }, key => {
      const layout = store.state.layout
      const d = byId(layout, item.id)
      if (!d || (Math.abs(d.w) < MIN_SIZE && Math.abs(d.h) < MIN_SIZE)) {
        const [w, hh] = DEFAULT_SIZE[kind]
        const value = { ...item, w, h: hh }
        const i = d ? indexOf(layout, item.id) : layout.decor.length
        store.setLayout([{ path: ['decor', i], value }], { coalesceKey: key })
      } else if (kind !== 'line') {
        store.setLayout(geomOps(indexOf(layout, item.id), decorBox(d)), { coalesceKey: key })
      }
      store.select({ kind: 'decor', id: item.id })
      setTool('select')
    })
  }

  function move(e, page, start, id) {
    const d0 = byId(store.state.layout, id)
    const b0 = decorBox(d0)
    view.drag(e, page, (pt, ev, key) => {
      const layout = store.state.layout
      const tg = targets(layout)
      const dx = pt.x - start.x
      const dy = pt.y - start.y
      const bx = b0.x + dx
      const by = b0.y + dy
      const sx = snapShift([bx, bx + b0.w / 2, bx + b0.w], tg.x, view.tol(), ev.altKey)
      const sy = snapShift([by, by + b0.h / 2, by + b0.h], tg.y, view.tol(), ev.altKey)
      guidesFor(page, sx, sy)
      const g = { x: d0.x + dx + sx.shift, y: d0.y + dy + sy.shift }
      const i = indexOf(layout, id)
      if (i >= 0) store.setLayout(geomOps(i, g), { coalesceKey: key })
      view.readout(t('canvas.readout.position', { x: fmt(g.x), y: fmt(g.y) }), ev)
    })
  }

  function resize(e, page, id, handle) {
    const d0 = byId(store.state.layout, id)
    view.drag(e, page, (pt, ev, key) => {
      const layout = store.state.layout
      const p = snapPoint(page, pt, ev)
      const g = resizeDecor(d0, handle, p.x, p.y)
      const i = indexOf(layout, id)
      if (i >= 0) store.setLayout(geomOps(i, g), { coalesceKey: key })
      view.readout(t('canvas.readout.size', { w: fmt(Math.abs(g.w)), h: fmt(Math.abs(g.h)) }), ev)
    })
  }

  /** Canvas pointerdown on a page at page point `pt` (`overSection`: id of the section under it); true when taken. */
  function pointerDown(e, page, pt, { overSection }) {
    if (tool !== 'select') {
      draw(e, page, pt)
      return true
    }
    const layout = store.state.layout
    const id = hitDecor(layout, page.n, pt.x, pt.y, view.tol())
    // text wins over back decor it sits on, except when that section (or the item) is already selected:
    // a second click reaches the decor underneath. Front decor always wins.
    const d = id && byId(layout, id)
    const sel = store.state.selection
    const through = sel?.id === (sel?.kind === 'decor' ? id : overSection)
    if (!d || (overSection && d.z === 'back' && !through)) return false
    store.select({ kind: 'decor', id })
    move(e, page, pt, id)
    return true
  }

  /** Selection box and resize handles for one page box. */
  function overlay(page) {
    const sel = store.state.selection
    const d = sel?.kind === 'decor' ? byId(store.state.layout, sel.id) : null
    if (!d || !onPage(d.pages, page.n)) return []
    const b = decorBox(d)
    const at = (x, y) => ({ left: `${x}mm`, top: `${y}mm` })
    const box = h('div', {
      class: 'cvs-decor-sel',
      style: { ...at(b.x, b.y), width: `${b.w}mm`, height: `${b.h}mm` },
      title: t(`canvas.tool.${d.kind}`),
      onPointerdown: e => move(e, page, view.pointMm(e, page), d.id)
    })
    const points = d.kind === 'line'
      ? [['p1', d.x, d.y], ['p2', d.x + d.w, d.y + d.h]]
      : BOX_HANDLES.map(k => [k,
        k.includes('w') ? b.x : k.includes('e') ? b.x + b.w : b.x + b.w / 2,
        k.includes('n') ? b.y : k.includes('s') ? b.y + b.h : b.y + b.h / 2])
    const handles = points.map(([k, x, y]) => h('div', {
      class: `cvs-knob cvs-knob--${k}`,
      style: at(x, y),
      title: t('canvas.handle.resize'),
      onPointerdown: e => resize(e, page, d.id, k)
    }))
    return [box, ...handles]
  }

  /** Arrow nudge, Delete, [ / ] z order and Esc for the selected item; true when handled. */
  function key(e) {
    if (e.key === 'Escape' && tool !== 'select') {
      setTool('select')
      return true
    }
    const sel = store.state.selection
    const layout = store.state.layout
    const i = sel?.kind === 'decor' ? indexOf(layout, sel.id) : -1
    if (i < 0) return false
    const step = e.shiftKey ? 5 : 1
    const arrows = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
    if (arrows[e.key]) store.setLayout(nudgeOps(layout, sel.id, ...arrows[e.key]), { coalesceKey: `nudge:${sel.id}` })
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      store.setLayout([{ path: ['decor', i], value: undefined }])
      store.select(null)
    } else if (e.key === '[' || e.key === ']') {
      store.setLayout([{ path: ['decor', i, 'z'], value: e.key === '[' ? 'back' : 'front' }])
    } else if (e.key === 'Escape') store.select(null)
    else return false
    return true
  }

  return { get tool() { return tool }, setTool, pointerDown, overlay, key }
}
