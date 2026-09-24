// Center pane (spec 5.3): the paged canvas. Owns the render loop (content/layout → layoutPages → setRender),
// zoom, rulers and an overlay layer outside .cv-page (handles, section grips, decor selection, X-ray numbers).
// The overlay lives inside the zoom wrapper, so its children use unscaled px, or mm inside a page box.
import { normalizeLayout } from '../model/layout.js'
import { fitToPages } from '../render/fit.js'
import { createPagesHost, layoutPages } from '../render/pages.js'
import { mountDecorTools } from './decor-tools.js'
import { clamp, debounce, h, isTyping, on, svg } from './dom.js'
import { drawHandles } from './handles.js'

const PX_PER_MM = 96 / 25.4
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2]
const TEXT_DEBOUNCE_MS = 120
const STAGE_PAD = 28 // px around the pages, room for the rulers (matches canvas.css)
const RULER_PX = 14
const SNAP_PX = 6
const TOOLS = ['select', 'line', 'rect', 'ellipse']
// dims decor in X-ray on screen only; the page itself is never restyled for print
const XRAY_CSS = '@media screen { :host([data-xray]) .cv-decor { opacity: 0.15; } }'

const firstGE = (list, px) => list.find(v => v * px >= 1) ?? list.at(-1)

// Ruler along one page edge: viewBox in mm, sized so it stays RULER_PX tall on screen at any zoom.
function ruler(axis, length, [startMargin, endMargin], zoom) {
  const pxPerMm = PX_PER_MM * zoom
  const depth = RULER_PX / pxPerMm
  const minor = firstGE([1, 2, 5, 10], pxPerMm / 4)
  const label = firstGE([10, 20, 50, 100], pxPerMm / 40)
  const horizontal = axis === 'x'
  const at = (along, across) => horizontal ? `${along} ${across}` : `${across} ${along}`
  let d = ''
  const labels = []
  for (let v = 0; v <= length + 1e-6; v += minor) {
    const len = v % label === 0 ? 0.65 : v % (label / 2) === 0 ? 0.45 : 0.25
    d += `M${at(v, depth)}L${at(v, depth * (1 - len))}`
    if (v % label === 0 && v) {
      labels.push(svg('text', horizontal ? { x: v + 3 / pxPerMm, y: depth * 0.55 } : { x: depth * 0.08, y: v - 2 / pxPerMm }, String(v)))
    }
  }
  const band = (from, size) => svg('rect', horizontal
    ? { class: 'cvs-ruler__margin', x: from, y: 0, width: size, height: depth }
    : { class: 'cvs-ruler__margin', x: 0, y: from, width: depth, height: size })
  const [w, hgt] = horizontal ? [length, depth] : [depth, length]
  return svg('svg', {
    class: `cvs-ruler cvs-ruler--${axis}`,
    viewBox: `0 0 ${w} ${hgt}`,
    style: horizontal
      ? { left: '0', top: `${-depth - 2 / pxPerMm}mm`, width: `${w}mm`, height: `${hgt}mm` }
      : { top: '0', left: `${-depth - 2 / pxPerMm}mm`, width: `${w}mm`, height: `${hgt}mm` },
    'font-size': 9 / pxPerMm
  },
  svg('rect', { class: 'cvs-ruler__bg', x: 0, y: 0, width: w, height: hgt }),
  band(0, startMargin), band(length - endMargin, endMargin),
  svg('path', { d, 'stroke-width': 1 / pxPerMm }),
  ...labels)
}

export function mountCanvas(root, store, ctx = {}) {
  const t = (...a) => (ctx.t ?? (k => k))(...a)
  let zoom = 1
  let pages = [] // [{ n, x, y, w, h }] in overlay px
  let suppressClick = false
  let dragging = false
  let dragSeq = 0

  // ---------- DOM ----------
  const toolBtns = Object.fromEntries(TOOLS.map(tool => [tool, h('button', {
    class: 'ui-btn ui-btn--sm', type: 'button', 'aria-pressed': String(tool === 'select'),
    title: t(`canvas.tool.${tool}.hint`), onClick: () => decor.setTool(tool)
  }, t(`canvas.tool.${tool}`))]))
  const xrayBtn = h('button', {
    class: 'ui-btn ui-btn--sm', type: 'button', 'aria-pressed': 'false', title: t('canvas.xray.hint'),
    onClick: () => store.setUi({ xray: !store.state.ui.xray })
  }, t('canvas.xray'))
  const zoomSelect = h('select', {
    class: 'ui-select cvs-zoom-select', 'aria-label': t('canvas.zoom'),
    onChange: e => store.setUi({ zoom: e.target.value === 'fit' ? 'fit' : Number(e.target.value) })
  }, h('option', { value: 'fit' }, t('canvas.zoom.fit')), ZOOMS.map(z => h('option', { value: String(z) }, `${z * 100} %`)))
  const stepZoom = dir => {
    const next = dir > 0 ? ZOOMS.find(z => z > zoom + 1e-3) : ZOOMS.findLast(z => z < zoom - 1e-3)
    store.setUi({ zoom: next ?? (dir > 0 ? ZOOMS.at(-1) : ZOOMS[0]) })
  }
  const toolbar = h('div', { class: 'cvs-toolbar', role: 'toolbar', 'aria-label': t('canvas.toolbar') },
    h('div', { class: 'cvs-group', role: 'group', 'aria-label': t('canvas.tools') }, TOOLS.map(k => toolBtns[k])),
    h('span', { class: 'ui-sep' }),
    xrayBtn,
    h('span', { class: 'ui-spacer' }),
    h('button', { class: 'ui-btn ui-btn--sm ui-btn--icon', type: 'button', 'aria-label': t('canvas.zoom.out'), title: t('canvas.zoom.out'), onClick: () => stepZoom(-1) }, '−'),
    zoomSelect,
    h('button', { class: 'ui-btn ui-btn--sm ui-btn--icon', type: 'button', 'aria-label': t('canvas.zoom.in'), title: t('canvas.zoom.in'), onClick: () => stepZoom(1) }, '+'))

  const hostEl = h('div', { class: 'cvs-host' })
  const layer = h('div', { class: 'cvs-layer' })
  const guidesLayer = h('div', { class: 'cvs-layer' })
  const hoverBox = h('div', { class: 'cvs-outline', hidden: true })
  const grip = h('div', { class: 'cvs-grip', hidden: true, title: t('canvas.grip') })
  const dropLine = h('div', { class: 'cvs-drop', hidden: true })
  const readoutEl = h('div', { class: 'cvs-readout', hidden: true })
  const overlay = h('div', { class: 'cvs-overlay', 'aria-hidden': 'true' }, layer, hoverBox, grip, dropLine, guidesLayer, readoutEl)
  const zoomBox = h('div', { class: 'cvs-zoom' }, hostEl, overlay)
  const stage = h('div', { class: 'cvs-stage' }, zoomBox)
  const viewport = h('div', { class: 'cvs-viewport', tabIndex: 0, role: 'region', 'aria-label': t('canvas.pages') }, stage)
  root.classList.add('cvs')
  root.replaceChildren(toolbar, viewport)
  const host = createPagesHost(hostEl)
  host.append(h('style', null, XRAY_CSS))

  // ---------- geometry ----------
  function toOverlay(clientX, clientY) {
    const r = zoomBox.getBoundingClientRect()
    return { x: (clientX - r.left) / zoom, y: (clientY - r.top) / zoom }
  }
  function box(el) {
    const r = el.getBoundingClientRect()
    const o = toOverlay(r.left, r.top)
    return { x: o.x, y: o.y, w: r.width / zoom, h: r.height / zoom }
  }
  const px = b => ({ left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` })
  const pageEls = () => [...host.querySelectorAll('.cv-page[data-page]')]
  const pageAt = ({ x, y }) => pages.find(p => x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h) ?? null
  const inner = e => e.composedPath()[0]
  const fromOverlay = e => overlay.contains(inner(e))
  const sectionOf = e => (fromOverlay(e) ? null : inner(e).closest?.('.cv-section')) ?? null

  // ---------- drags ----------
  function startDrag(e, move, end) {
    e.preventDefault()
    e.stopPropagation()
    suppressClick = true
    dragging = true
    hideHover()
    const key = `canvas:${++dragSeq}`
    const offs = [
      on(window, 'pointermove', ev => move(ev, key)),
      on(window, 'pointerup', ev => finish(ev)),
      on(window, 'pointercancel', ev => finish(ev, true))
    ]
    function finish(ev, cancelled = false) {
      offs.forEach(off => off())
      dragging = false
      readoutEl.hidden = true
      guidesLayer.replaceChildren()
      end?.(ev, key, cancelled)
    }
  }

  const view = {
    store,
    t,
    tol: () => SNAP_PX / (PX_PER_MM * zoom),
    pointMm(e, page) {
      const o = toOverlay(e.clientX, e.clientY)
      return { x: (o.x - page.x) / PX_PER_MM, y: (o.y - page.y) / PX_PER_MM }
    },
    drag: (e, page, move, end) => startDrag(e, (ev, key) => move(view.pointMm(ev, page), ev, key), (ev, key) => end?.(key)),
    readout(text, ev) {
      const o = toOverlay(ev.clientX, ev.clientY)
      readoutEl.textContent = text
      Object.assign(readoutEl.style, { left: `${o.x}px`, top: `${o.y}px` })
      readoutEl.hidden = false
    },
    guides(list) {
      guidesLayer.replaceChildren(...list.map(g => h('div', {
        class: `cvs-guide cvs-guide--${g.axis}`,
        style: g.axis === 'x'
          ? { left: `${g.page.x + g.at * PX_PER_MM}px`, top: `${g.page.y}px`, height: `${g.page.h}px` }
          : { top: `${g.page.y + g.at * PX_PER_MM}px`, left: `${g.page.x}px`, width: `${g.page.w}px` }
      })))
    }
  }

  const decor = mountDecorTools(view, {
    onToolChange(tool) {
      for (const [k, b] of Object.entries(toolBtns)) b.setAttribute('aria-pressed', String(k === tool))
      zoomBox.classList.toggle('is-drawing', tool !== 'select')
    }
  })

  // ---------- render loop: one render at a time, coalesced to the latest state ----------
  let rendering = false
  let dirty = false
  async function render() {
    textRender.cancel()
    if (rendering) {
      dirty = true
      return
    }
    rendering = true
    try {
      do {
        dirty = false
        const { doc, layout } = store.state
        try {
          const result = await layoutPages(doc, layout, host)
          if (!dirty && store.state.doc === doc && store.state.layout === layout) store.setRender(result)
        } catch (err) {
          console.error('canvas: render failed', err)
        }
      } while (dirty)
    } finally {
      rendering = false
    }
    applyZoom()
  }
  const textRender = debounce(render, TEXT_DEBOUNCE_MS)

  // ---------- zoom ----------
  function applyZoom() {
    const natW = hostEl.offsetWidth
    const natH = hostEl.offsetHeight
    const z = store.state.ui.zoom
    const want = z === 'fit' ? (viewport.clientWidth - 2 * STAGE_PAD) / natW : Number(z) > 5 ? Number(z) / 100 : Number(z)
    zoom = natW ? clamp(Number.isFinite(want) && want > 0 ? want : 1, z === 'fit' ? 0.2 : 0.5, 2) : 1
    zoomBox.style.transform = `scale(${zoom})`
    stage.style.width = `${natW * zoom}px`
    stage.style.height = `${natH * zoom}px`
    overlay.style.setProperty('--inv', String(1 / zoom))
    zoomSelect.value = z === 'fit' ? 'fit' : String(zoom)
    drawOverlay()
  }

  // ---------- overlay ----------
  function hideHover() {
    hoverBox.hidden = true
    grip.hidden = true
  }

  function showHover(sec) {
    if (!sec || dragging) return hideHover()
    const b = box(sec)
    Object.assign(hoverBox.style, px(b))
    hoverBox.hidden = false
    grip.dataset.section = sec.dataset.section
    Object.assign(grip.style, { left: `${b.x}px`, top: `${b.y}px` })
    grip.hidden = false
  }

  function badges() {
    const seen = new Map()
    return (store.state.placement ?? []).flatMap((a, i) => {
      const page = host.querySelector(`.cv-page[data-page="${a.page}"]`)
      let el
      if (a.kind === 'header') el = page?.querySelector('.cv-header')
      else {
        const k = `${a.page}|${a.colId}|${a.line}`
        const n = seen.get(k) ?? 0
        seen.set(k, n + 1)
        el = page?.querySelectorAll(`.cv-col[data-col="${CSS.escape(a.colId)}"] [data-atom][data-line="${a.line}"]`)[n]
      }
      if (!el) return []
      const b = box(el)
      return [h('div', { class: 'cvs-badge', style: { left: `${b.x}px`, top: `${b.y}px` } }, String(i + 1))]
    })
  }

  function drawOverlay() {
    const { layout, selection, ui } = store.state
    hostEl.toggleAttribute('data-xray', !!ui.xray)
    xrayBtn.setAttribute('aria-pressed', String(!!ui.xray))
    pages = pageEls().map(el => ({ n: Number(el.dataset.page), ...box(el) }))
    const { width: W, height: H, margins: m } = layout.page
    const outlines = selection?.kind === 'section'
      ? [...host.querySelectorAll(`.cv-section[data-section="${CSS.escape(selection.id)}"]`)]
          .map(el => h('div', { class: 'cvs-outline is-selected', style: px(box(el)) }))
      : []
    layer.replaceChildren(
      ...pages.map(p => h('div', { class: 'cvs-page', style: px(p) },
        p.n === 1 && ruler('x', W, [m.left, m.right], zoom),
        ruler('y', H, [m.top, m.bottom], zoom),
        ...drawHandles(view, p),
        ...decor.overlay(p))),
      ...outlines,
      ...(ui.xray ? badges() : []))
    hideHover()
  }

  // ---------- section drag (grip) ----------
  function dropTarget(ev) {
    const o = toOverlay(ev.clientX, ev.clientY)
    const page = pageAt(o) ?? pages.reduce((best, p) => !best || Math.abs(p.y + p.h / 2 - o.y) < Math.abs(best.y + best.h / 2 - o.y) ? p : best, null)
    if (!page) return null
    const pageEl = host.querySelector(`.cv-page[data-page="${page.n}"]`)
    const cols = [...pageEl.querySelectorAll('.cv-col[data-col]')].map(el => ({ el, b: box(el) }))
    const dist = c => o.x < c.b.x ? c.b.x - o.x : o.x > c.b.x + c.b.w ? o.x - c.b.x - c.b.w : 0
    const col = cols.reduce((best, c) => !best || dist(c) < dist(best) ? c : best, null)
    if (!col) return null
    const colId = col.el.dataset.col
    const here = [...col.el.querySelectorAll(':scope > .cv-section')].map(el => ({ id: el.dataset.section, b: box(el) }))
    const firstPage = new Map() // this column's sections in stream order → page of their first fragment
    for (const el of host.querySelectorAll(`.cv-page[data-page] .cv-col[data-col="${CSS.escape(colId)}"] > .cv-section`)) {
      if (!firstPage.has(el.dataset.section)) firstPage.set(el.dataset.section, Number(el.closest('.cv-page').dataset.page))
    }
    const order = [...firstPage.keys()]
    const hit = here.find(s => s.b.y + s.b.h / 2 > o.y)
    if (hit) return { colId, before: hit.id, line: { x: hit.b.x, y: hit.b.y, w: hit.b.w } }
    const last = here.at(-1)
    const before = last ? order[order.indexOf(last.id) + 1] ?? null : order.find(id => firstPage.get(id) > page.n) ?? null
    const y = last ? last.b.y + last.b.h : col.b.y
    return { colId, before, line: { x: col.b.x, y, w: col.b.w } }
  }

  on(grip, 'pointerdown', e => {
    if (e.button !== 0) return
    const id = grip.dataset.section
    let target = null
    startDrag(e, ev => {
      target = dropTarget(ev)
      dropLine.hidden = !target
      if (target) Object.assign(dropLine.style, { left: `${target.line.x}px`, top: `${target.line.y}px`, width: `${target.line.w}px` })
    }, (ev, key, cancelled) => {
      dropLine.hidden = true
      if (cancelled || !target || target.before === id) return
      store.moveSection(id, target.colId, target.before)
    })
  })

  // ---------- pointer and keyboard ----------
  on(zoomBox, 'pointerdown', e => {
    suppressClick = false
    if (e.button !== 0 || fromOverlay(e)) return
    viewport.focus({ preventScroll: true })
    const page = pageAt(toOverlay(e.clientX, e.clientY))
    if (!page) return
    decor.pointerDown(e, page, view.pointMm(e, page), { overSection: sectionOf(e)?.dataset.section ?? null })
  })

  on(zoomBox, 'click', e => {
    if (suppressClick || fromOverlay(e)) {
      suppressClick = false
      return
    }
    const sec = sectionOf(e)
    const section = sec && store.state.doc.sections.find(s => s.id === sec.dataset.section)
    if (!section) return store.select(null)
    store.select({ kind: 'section', id: section.id })
    store.reveal(section.line)
  })

  on(zoomBox, 'dblclick', e => {
    if (fromOverlay(e)) return
    const line = Number(inner(e).closest?.('[data-line]')?.dataset.line)
    if (line) ctx.editor?.focusLine(line)
  })

  on(zoomBox, 'pointermove', e => {
    if (dragging || e.buttons || inner(e) === grip) return
    if (!fromOverlay(e)) showHover(sectionOf(e))
  })
  on(viewport, 'pointerleave', hideHover)

  on(root, 'keydown', e => { // root, so Esc also works right after picking a tool in the toolbar
    if (isTyping(e.target) || e.metaKey || e.ctrlKey) return
    if (decor.key(e)) e.preventDefault()
  })

  // ---------- store ----------
  store.subscribe((state, changed) => {
    if (changed.has('layout') || changed.has('docId')) render()
    else if (changed.has('content')) textRender()
    if (changed.has('ui')) applyZoom()
    else if (!rendering && (changed.has('selection') || changed.has('placement'))) drawOverlay()
    if (changed.has('reveal') && state.reveal) {
      host.querySelector(`.cv-page[data-page] [data-line="${state.reveal.line}"]`)?.scrollIntoView({ block: 'nearest' })
    }
  })
  new ResizeObserver(() => { if (store.state.ui.zoom === 'fit') applyZoom() }).observe(viewport)
  if (document.fonts) on(document.fonts, 'loadingdone', () => render())
  render()

  // ---------- off-screen renders (fit, evaluate) ----------
  async function offscreen(fn) {
    const probeBox = h('div', { class: 'cvs-probe', 'aria-hidden': 'true' })
    document.body.append(probeBox)
    try {
      return await fn(createPagesHost(probeBox))
    } finally {
      probeBox.remove()
    }
  }

  return {
    host,
    print() {
      const prev = zoomBox.style.transform
      zoomBox.style.transform = 'none'
      try {
        window.print()
      } finally {
        zoomBox.style.transform = prev
      }
    },
    /** Fits the CV onto `pages` by density (one history step). */
    async fit(pages) {
      const { doc, layout } = store.state
      const { density, reachedFloor } = await fitToPages(doc, layout, host, pages)
      store.setLayout([{ path: ['theme', 'density'], value: density }])
      return { reachedFloor }
    },
    /** Preflight issues `layout` would have with the current content, rendered off-screen. */
    async evaluate(layout) {
      const { doc, content } = store.state
      layout = normalizeLayout(layout)
      const { report, placement } = await offscreen(probe => layoutPages(doc, layout, probe))
      return ctx.runPreflight?.({ source: content, doc, layout, report, placement, now: new Date(), lang: layout.lang }) ?? []
    },
    relayout: () => render()
  }
}
