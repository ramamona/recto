// fitToPages (spec 4.7): binary-search theme density for the largest value whose render fits `pages`,
// never letting body text drop below 9 pt. Renders into a hidden probe host so the visible canvas never flickers.
import { RANGES, applyLayoutOps, normalizeLayout } from '../model/layout.js'
import { createPagesHost, layoutPages } from './pages.js'

const MIN_BODY_PT = 9
const STEPS = 8

// Smallest density keeping sizeBody × (1 + (d − 1) × 0.35) ≥ 9 pt; rounded up so the floor always holds.
const floorDensity = sizeBody => Math.ceil((1 + (MIN_BODY_PT / sizeBody - 1) / 0.35) * 1000) / 1000

/** Resolves { density, reachedFloor, layout }; reachedFloor = even the lowest allowed density doesn't fit. */
export async function fitToPages(doc, layout, host, pages) {
  layout = normalizeLayout(layout)
  const [min, max] = RANGES.density
  const withDensity = d => applyLayoutOps(layout, [{ path: ['theme', 'density'], value: d }])
  const document = host.ownerDocument
  const box = document.createElement('div')
  box.style.cssText = 'position: absolute; left: -30000mm; top: 0; visibility: hidden'
  document.body.append(box)
  const probe = createPagesHost(box)
  const fits = async d => (await layoutPages(doc, withDensity(d), probe)).report.pageCount <= pages
  try {
    let lo = Math.min(max, Math.max(min, floorDensity(layout.theme.sizeBody)))
    let hi = max
    if (!(await fits(lo))) return { density: lo, reachedFloor: true, layout: withDensity(lo) }
    if (await fits(hi)) lo = hi
    for (let i = 0; i < STEPS && hi - lo > 0.001; i++) {
      const mid = (lo + hi) / 2
      if (await fits(mid)) lo = mid
      else hi = mid
    }
    const density = Math.floor(lo * 1000) / 1000 // never above the value that was seen to fit
    return { density, reachedFloor: false, layout: withDensity(density) }
  } finally {
    box.remove()
  }
}
