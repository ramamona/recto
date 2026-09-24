import test from 'node:test'
import assert from 'node:assert/strict'
import { parseColor, toHex, composite, relativeLuminance, contrastRatio, bestTextColor } from '../src/preflight/contrast.js'

test('parseColor accepts hex, rgb(), rgba() and keywords', () => {
  assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 })
  assert.deepEqual(parseColor('#1D4ED8'), { r: 29, g: 78, b: 216, a: 1 })
  assert.deepEqual(parseColor('#00000080'), { r: 0, g: 0, b: 0, a: 128 / 255 })
  assert.deepEqual(parseColor('rgb(17, 24, 39)'), { r: 17, g: 24, b: 39, a: 1 })
  assert.deepEqual(parseColor('rgba(0, 0, 0, 0.5)'), { r: 0, g: 0, b: 0, a: 0.5 })
  assert.deepEqual(parseColor('rgb(0 0 0 / 0.25)'), { r: 0, g: 0, b: 0, a: 0.25 })
  assert.deepEqual(parseColor(' transparent '), { r: 0, g: 0, b: 0, a: 0 })
  assert.deepEqual(parseColor('White'), { r: 255, g: 255, b: 255, a: 1 })
  assert.deepEqual(parseColor('black'), { r: 0, g: 0, b: 0, a: 1 })
  for (const bad of ['', '#ff', '#fffff', '#ggg', 'red', 'rgb(1,2)', 'rgb(123)', 'rgb(1.2.3, 0, 0)', '__proto__', 'constructor', 'rgb(300, 0, 0)', null, undefined, 42]) {
    assert.equal(parseColor(bad), null, String(bad))
  }
})

test('toHex rounds and clamps', () => {
  assert.equal(toHex({ r: 29, g: 78, b: 216 }), '#1d4ed8')
  assert.equal(toHex({ r: 127.5, g: -3, b: 300 }), '#8000ff')
})

test('composite 50% black over white is mid grey', () => {
  const c = composite(parseColor('rgba(0, 0, 0, 0.5)'), parseColor('#ffffff'))
  assert.equal(c.a, 1)
  for (const ch of ['r', 'g', 'b']) assert.ok(Math.abs(c[ch] - 0x80) <= 1)
  assert.equal(toHex(c), '#808080')
  assert.deepEqual(composite(parseColor('#1d4ed8'), parseColor('#fff')), { r: 29, g: 78, b: 216, a: 1 })
})

test('WCAG luminance and contrast', () => {
  assert.equal(relativeLuminance(parseColor('#ffffff')), 1)
  assert.equal(relativeLuminance(parseColor('#000')), 0)
  assert.equal(contrastRatio('#000', '#fff'), 21)
  assert.equal(contrastRatio('#fff', '#000'), 21)
  assert.equal(contrastRatio('#767676', '#fff'), 4.54)
  assert.equal(contrastRatio('#fff', '#fff'), 1)
  // translucent text is composited over the background first
  const half = contrastRatio('rgba(0, 0, 0, 0.5)', '#ffffff')
  assert.ok(half >= contrastRatio('#808080', '#fff') && half <= contrastRatio('#7f7f7f', '#fff'), String(half))
  assert.ok(Number.isNaN(contrastRatio('bogus', '#fff')))
})

test('bestTextColor picks the higher-contrast of black and white', () => {
  assert.equal(bestTextColor('#1d4ed8'), '#ffffff')
  assert.equal(bestTextColor('#ffffff'), '#000000')
  assert.equal(bestTextColor('#fde68a'), '#000000')
  assert.equal(bestTextColor('#111827'), '#ffffff')
})
