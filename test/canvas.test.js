import test from 'node:test'
import assert from 'node:assert/strict'
const R = new URL('../src', import.meta.url).href
const { snap, marginValue, gutterValue, columnResizeOps } = await import(`${R}/ui/handles.js`)
const { hitDecor, resizeDecor, newDecor, nudgeOps } = await import(`${R}/ui/decor-tools.js`)
const { defaultLayout, applyLayoutOps, columnGeometry } = await import(`${R}/model/layout.js`)

test('snap: nearest target within tolerance, else 1 mm grid; free = 0.1 mm', () => {
  assert.deepEqual(snap(24.6, [30], 1, false), { v: 25, target: null })
  assert.deepEqual(snap(29.4, [30, 29], 1, false), { v: 29, target: 29 })
  assert.deepEqual(snap(29.4, [30], 1, true), { v: 29.4, target: null })
})

test('marginValue maps a pointer position to the side value', () => {
  const l = defaultLayout('A4')
  assert.equal(marginValue(l, 'left', { x: 25, y: 0 }), 25)
  assert.equal(marginValue(l, 'right', { x: 200, y: 0 }), 10)
  assert.equal(marginValue(l, 'top', { x: 0, y: 12 }), 12)
  assert.equal(marginValue(l, 'bottom', { x: 0, y: 280 }), 17)
})

const twoCol = () => applyLayoutOps(defaultLayout('A4'), [
  { path: ['grid', 'columns'], value: [{ id: 'main', width: 2 }, { id: 'side', width: 1 }] },
  { path: ['grid', 'readingOrder'], value: ['main', 'side'] },
])

test('gutterValue is twice the distance from the gutter centre', () => {
  const l = twoCol()
  const [a] = columnGeometry(l)
  const mid = a.x + a.w + l.grid.gutter / 2
  assert.equal(gutterValue(l, 0, mid + 6), 12)
  assert.equal(gutterValue(l, 0, mid - 3), 6)
})

test('columnResizeOps moves the boundary and keeps the pair fr sum', () => {
  const l = twoCol()
  const [a, b] = columnGeometry(l)
  const mid = a.x + a.w + l.grid.gutter / 2
  const next = applyLayoutOps(l, columnResizeOps(l, 0, mid - 20))
  const [a2, b2] = columnGeometry(next)
  assert.ok(Math.abs(a2.w - (a.w - 20)) < 0.1)
  assert.ok(Math.abs(b2.w - (b.w + 20)) < 0.1)
  assert.ok(Math.abs(next.grid.columns[0].width + next.grid.columns[1].width - 3) < 0.01)
  const far = applyLayoutOps(l, columnResizeOps(l, 0, 0))
  assert.ok(far.grid.columns[0].width >= 0.2)
})

test('hitDecor: front before back, page filter, line tolerance', () => {
  let l = defaultLayout('A4')
  l = applyLayoutOps(l, [{ path: ['decor'], value: [
    { id: 'a', kind: 'rect', x: 10, y: 10, w: 50, h: 50, fill: '#eeeeee', z: 'back' },
    { id: 'b', kind: 'rect', x: 20, y: 20, w: 10, h: 10, fill: '#cccccc', z: 'front', pages: [2] },
    { id: 'c', kind: 'line', x: 0, y: 100, w: 100, h: 0, stroke: '#000000', z: 'back' },
    { id: 'e', kind: 'ellipse', x: 10, y: 10, w: 50, h: 50, fill: '#eeeeee', z: 'front', pages: 'first' },
  ] }])
  assert.equal(hitDecor(l, 1, 25, 25), 'e')
  assert.equal(hitDecor(l, 2, 25, 25), 'b')
  assert.equal(hitDecor(l, 2, 15, 15), 'a')
  assert.equal(hitDecor(l, 1, 50, 100.8), 'c')
  assert.equal(hitDecor(l, 1, 50, 104), null)
  assert.equal(hitDecor(l, 1, 150, 150), null)
})

test('resizeDecor: box handles move edges; line handles move endpoints', () => {
  const box = { kind: 'rect', x: 10, y: 10, w: 20, h: 20 }
  assert.deepEqual(resizeDecor(box, 'se', 40, 50), { x: 10, y: 10, w: 30, h: 40 })
  assert.deepEqual(resizeDecor(box, 'nw', 40, 5), { x: 30, y: 5, w: 10, h: 25 })
  assert.deepEqual(resizeDecor(box, 'e', 50, 99), { x: 10, y: 10, w: 40, h: 20 })
  const line = { kind: 'line', x: 10, y: 10, w: 20, h: 0 }
  assert.deepEqual(resizeDecor(line, 'p1', 0, 5), { x: 0, y: 5, w: 30, h: 5 })
  assert.deepEqual(resizeDecor(line, 'p2', 50, 10), { x: 10, y: 10, w: 40, h: 0 })
})

test('newDecor makes a unique id and a visible item of the kind', () => {
  const l = applyLayoutOps(defaultLayout('A4'), [{ path: ['decor'], value: [{ id: 'd1', kind: 'rect' }] }])
  const line = newDecor(l, 'line', 1, 5, 6)
  assert.equal(line.kind, 'line')
  assert.notEqual(line.id, 'd1')
  assert.ok(line.stroke)
  assert.deepEqual(line.pages, [1])
  assert.equal(newDecor(l, 'rect', 2, 0, 0).fill != null, true)
})

test('nudgeOps shifts x and y of the item by index', () => {
  const l = applyLayoutOps(defaultLayout('A4'), [{ path: ['decor'], value: [{ id: 'q', kind: 'rect', x: 10, y: 10 }] }])
  const next = applyLayoutOps(l, nudgeOps(l, 'q', 5, -1))
  assert.equal(next.decor[0].x, 15)
  assert.equal(next.decor[0].y, 9)
  assert.deepEqual(nudgeOps(l, 'missing', 1, 1), [])
})
