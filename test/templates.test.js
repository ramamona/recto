import test from 'node:test'
import assert from 'node:assert/strict'
import { applyTemplate } from '../src/model/templates.js'
import { normalizeLayout, THEME_DEFAULTS } from '../src/model/layout.js'

const photo = { src: 'data:image/jpeg;base64,AAAA', size: 30, shape: 'square', position: 'right' }
const old = normalizeLayout({
  lang: 'de',
  customCss: '.cv-name { letter-spacing: 0 }',
  page: { size: 'Letter', targetPages: 2, margins: { top: 20, right: 20, bottom: 20, left: 20 } },
  grid: { columns: [{ id: 'a', width: 1 }, { id: 'b', width: 1 }], gutter: 12 },
  header: { align: 'right', photo },
  theme: { colorAccent: '#b91c1c', lineHeight: 1.6 },
  decor: [{ kind: 'rect', fill: '#000000' }],
  sectionDefaults: { skills: { variant: 'grid' } },
  sections: { work: { variant: 'compact' }, skills: { hidden: true, variant: 'tags' }, old: { hidden: false } },
})
const template = {
  id: 'modern',
  name: 'Modern',
  targetPages: 1,
  layout: {
    lang: 'fr',
    customCss: 'x',
    page: { size: 'A5', width: 100, height: 100, targetPages: 3, margins: { top: 12, left: 0 } },
    grid: { columns: [{ id: 'side', width: 1, bg: '#1f2937', bleed: true }, { id: 'main', width: 2.4 }], gutter: 6, headerSpan: 'main' },
    header: { align: 'center', photo: null },
    theme: { fontHeading: 'geometric', colorAccent: '#0f766e' },
    decor: [{ kind: 'line', x: 16, y: 10, w: 178, h: 0, stroke: '#0f766e', strokeWidth: 1 }],
    sections: { work: { hidden: true } },
  },
  sectionDefaults: { skills: { column: 'side', variant: 'tags' } },
}

test('applyTemplate keeps lang, customCss, photo, page size and target', () => {
  const l = applyTemplate(old, template)
  assert.equal(l.lang, 'de')
  assert.equal(l.customCss, old.customCss)
  assert.deepEqual(l.header.photo, photo)
  assert.deepEqual([l.page.size, l.page.width, l.page.height, l.page.targetPages], ['Letter', 215.9, 279.4, 2])
})

test('applyTemplate replaces grid, theme, margins, header align and decor', () => {
  const l = applyTemplate(old, template)
  assert.deepEqual(l.grid.columns, [{ id: 'side', width: 1, bg: '#1f2937', bleed: true }, { id: 'main', width: 2.4 }])
  assert.deepEqual([l.grid.gutter, l.grid.headerSpan, l.grid.readingOrder], [6, 'main', ['main', 'side']])
  assert.equal(l.theme.fontHeading, 'geometric')
  assert.equal(l.theme.colorAccent, '#0f766e')
  assert.equal(l.theme.lineHeight, THEME_DEFAULTS.lineHeight)
  assert.deepEqual(l.page.margins, { top: 12, right: 16, bottom: 16, left: 0 })
  assert.equal(l.header.align, 'center')
  assert.deepEqual(l.decor.map(d => [d.kind, d.stroke]), [['line', '#0f766e']])
  assert.deepEqual(l.sectionDefaults, { skills: { column: 'side', variant: 'tags' } })
})

test('applyTemplate resets sections keeping only hidden flags', () => {
  assert.deepEqual(applyTemplate(old, template).sections, { skills: { hidden: true } })
})

test('applyTemplate without layout parts falls back to defaults', () => {
  for (const t of [null, {}, { layout: 5, sectionDefaults: [] }]) {
    const l = applyTemplate(old, t)
    assert.deepEqual(l.grid.columns, [{ id: 'main', width: 1 }])
    assert.deepEqual(l.theme, THEME_DEFAULTS)
    assert.deepEqual(l.decor, [])
    assert.deepEqual(l.sectionDefaults, {})
    assert.equal(l.lang, 'de')
  }
})
