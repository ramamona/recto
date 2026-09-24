import test from 'node:test'
import assert from 'node:assert/strict'
import { remix, ACCENTS } from '../src/model/remix.js'
import { defaultLayout, applyLayoutOps, getPath } from '../src/model/layout.js'

// Park-Miller LCG: deterministic rand() in [0, 1)
const seeded = seed => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646

const lum = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

test('ACCENTS: 12 distinct 6-digit hex colours, each >= 4.5:1 on white', () => {
  assert.equal(new Set(ACCENTS).size, 12)
  for (const c of ACCENTS) {
    assert.match(c, /^#[0-9a-f]{6}$/)
    assert.ok(1.05 / (lum(c) + 0.05) >= 4.5, c)
  }
})

test('remix is deterministic for a seeded rand', () => {
  assert.deepEqual(remix(defaultLayout(), seeded(7)), remix(defaultLayout(), seeded(7)))
  assert.notDeepEqual(remix(defaultLayout(), seeded(7)), remix(defaultLayout(), seeded(8)))
})

test('remix ops only touch theme and survive normalizeLayout unchanged', () => {
  for (let s = 1; s <= 200; s++) {
    const layout = defaultLayout()
    const ops = remix(layout, seeded(s))
    assert.ok(ops.length >= 7)
    const next = applyLayoutOps(layout, ops)
    for (const { path, value } of ops) {
      assert.equal(path[0], 'theme')
      assert.equal(getPath(next, path), value)
    }
    assert.notEqual(next.theme.colorAccent, layout.theme.colorAccent)
    assert.deepEqual({ ...next, theme: layout.theme }, layout)
  }
})

test('remix tolerates a rand returning 1', () => {
  assert.ok(remix(defaultLayout(), () => 1).every(op => op.value !== undefined))
})
