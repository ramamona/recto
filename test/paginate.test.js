import test from 'node:test'
import assert from 'node:assert/strict'
import { paginate, usedHeight } from '../src/render/paginate.js'

const A = (h, o = {}) => ({ h, hStart: 0, hEnd: h, keepWithNext: false, group: null, breakBefore: false, ...o })
const run = (atoms, cap = 100, extra = {}) => paginate({ columns: { main: atoms }, capacityFirst: { main: cap }, capacityRest: cap, epsilon: 0.5, ...extra })
const mainPages = r => r.pages.map(p => p.main)

test('all atoms fit on one page', () => {
  const r = run([A(30), A(30), A(40)])
  assert.deepEqual(mainPages(r), [[0, 1, 2]])
  assert.deepEqual(r.flags, [])
})

test('greedy overflow to page 2', () => {
  assert.deepEqual(mainPages(run([A(40), A(40), A(40), A(10)])), [[0, 1], [2, 3]])
})

test('epsilon tolerates sub-pixel overshoot', () => {
  assert.deepEqual(mainPages(run([A(50), A(50.4)])), [[0, 1]])
  assert.deepEqual(mainPages(run([A(50), A(50.6)])), [[0], [1]])
})

test('heading kept with next', () => {
  const r = run([A(60), A(30, { keepWithNext: true }), A(30)])
  assert.deepEqual(r.pages.map(p => p.main), [[0], [1, 2]])
})

test('keepWithNext chains join several atoms', () => {
  const r = run([A(50), A(20, { keepWithNext: true }), A(20, { keepWithNext: true }), A(20)])
  assert.deepEqual(mainPages(r), [[0], [1, 2, 3]])
})

test('group moves whole entry to next page', () => {
  const g = { group: 's:0' }
  const r = run([A(50), A(20, g), A(20, g), A(20, g), A(10)])
  assert.deepEqual(mainPages(r), [[0], [1, 2, 3, 4]])
  assert.deepEqual(r.flags, [])
})

test('adjacent different groups are separate chunks', () => {
  const r = run([A(40, { group: 's:0' }), A(40, { group: 's:0' }), A(40, { group: 's:1' }), A(40, { group: 's:1' })])
  assert.deepEqual(mainPages(r), [[0, 1], [2, 3]])
})

test('group taller than a page is split and flagged forced-split', () => {
  const g = { group: 's:0' }
  const r = run([A(10), A(40, g), A(40, g), A(40, g)])
  assert.deepEqual(mainPages(r), [[0], [1, 2], [3]])
  assert.deepEqual(r.flags, [{ kind: 'forced-split', page: 2, colId: 'main', atom: 1 }])
})

test('oversized atom is flagged and alone', () => {
  const r = run([A(10), A(250), A(10)])
  assert.deepEqual(r.pages.map(p => p.main), [[0], [1], [2]])
  assert.deepEqual(r.flags, [{ kind: 'overflow', page: 2, colId: 'main', atom: 1 }])
})

test('oversized atom inside a chunk flags both overflow and forced-split', () => {
  const r = run([A(20, { keepWithNext: true }), A(250), A(10)])
  assert.deepEqual(mainPages(r), [[0], [1], [2]])
  assert.deepEqual(r.flags, [
    { kind: 'overflow', page: 2, colId: 'main', atom: 1 },
    { kind: 'forced-split', page: 1, colId: 'main', atom: 0 },
  ])
})

test('breakBefore starts a new page, but never an empty one', () => {
  assert.deepEqual(mainPages(run([A(10), A(10, { breakBefore: true }), A(10)])), [[0], [1, 2]])
  assert.deepEqual(mainPages(run([A(10, { breakBefore: true }), A(10)])), [[0, 1]])
})

test('breakBefore atom is never joined into the previous chunk via keepWithNext or group', () => {
  // A(1) keepWithNext (an empty section title) must not pull A(2)'s forced break onto page 1
  assert.deepEqual(mainPages(run([A(10), A(10, { keepWithNext: true }), A(10, { breakBefore: true }), A(10)])), [[0, 1], [2, 3]])
  const g = { group: 's:0' }
  assert.deepEqual(mainPages(run([A(10, g), A(10, { ...g, breakBefore: true }), A(10, g)])), [[0], [1, 2]])
})

test('breakBefore wins over a preceding keepWithNext', () => {
  // a head-only entry (keepWithNext) must not glue onto the next section's breakBefore title
  const k = { keepWithNext: true }
  assert.deepEqual(mainPages(run([A(10, k), A(10, k), A(10, { ...k, breakBefore: true }), A(10)])), [[0, 1], [2, 3]])
})

test('columns flow independently; shorter columns get [] on later pages', () => {
  const r = paginate({
    columns: { main: [A(60), A(60), A(60)], side: [A(20), A(20)] },
    capacityFirst: { main: 100, side: 100 }, capacityRest: 100, epsilon: 0.5,
  })
  assert.deepEqual(r.pages, [{ main: [0], side: [0, 1] }, { main: [1], side: [] }, { main: [2], side: [] }])
})

test('capacityFirst smaller than capacityRest (header on page 1)', () => {
  const r = run([A(30), A(30), A(30), A(30), A(30)], 100, { capacityFirst: { main: 50 } })
  assert.deepEqual(mainPages(r), [[0], [1, 2, 3], [4]])
})

test('capacityOverride shrinks one page only', () => {
  const atoms = [A(30), A(30), A(30), A(30), A(30), A(30)]
  assert.deepEqual(mainPages(run(atoms)), [[0, 1, 2], [3, 4, 5]])
  assert.deepEqual(mainPages(run(atoms, 100, { capacityOverride: { 0: { main: 70 } } })), [[0, 1], [2, 3, 4], [5]])
  assert.deepEqual(mainPages(run(atoms, 100, { capacityOverride: { 1: { side: 10 } } })), [[0, 1, 2], [3, 4, 5]])
})

test('hStart and hEnd are counted, not just h', () => {
  // by h alone 50 + 40 = 90 fits; with hEnd 55 it is 105
  assert.deepEqual(mainPages(run([A(50), A(40, { hEnd: 55 })])), [[0], [1]])
  // hStart of the first atom on the page counts: 10 + 50 + 45 = 105
  assert.deepEqual(mainPages(run([A(50, { hStart: 10 }), A(45)])), [[0], [1]])
  // hStart of a non-first atom does not count
  assert.deepEqual(mainPages(run([A(50), A(45, { hStart: 10 })])), [[0, 1]])
})

test('usedHeight = hStart[first] + sum of h up to last + hEnd[last]', () => {
  const atoms = [A(10, { hStart: 2, hEnd: 12 }), A(20, { hStart: 3, hEnd: 25 }), A(30, { hStart: 4, hEnd: 33 })]
  assert.equal(usedHeight(atoms, [0, 1, 2]), 2 + 10 + 20 + 33)
  assert.equal(usedHeight(atoms, [1]), 3 + 25)
  assert.equal(usedHeight(atoms, []), 0)
})

test('empty input yields one empty page', () => {
  assert.deepEqual(paginate({ columns: { main: [], side: [] }, capacityFirst: { main: 100, side: 100 }, capacityRest: 100, epsilon: 0.5 }).pages, [{ main: [], side: [] }])
})

test('1 000 atoms paginate in < 20 ms', () => {
  const atoms = Array.from({ length: 1000 }, (_, i) => A(10 + (i % 7), { keepWithNext: i % 11 === 0, group: i % 5 < 3 ? `s:${Math.floor(i / 5)}` : null }))
  const t0 = performance.now()
  const r = run(atoms, 300)
  const ms = performance.now() - t0
  assert.equal(r.pages.flatMap(p => p.main).length, 1000)
  assert.ok(ms < 20, `took ${ms.toFixed(1)} ms`)
})
