import test from 'node:test'
import assert from 'node:assert/strict'
import { FONT_STACKS, resolveFont, scaledTheme, themeToCss, themeAttrs, columnCss } from '../src/render/theme.js'
import { THEME_DEFAULTS } from '../src/model/layout.js'

const TOKENS = [
  'font-body', 'font-heading', 'font-mono',
  'size-name', 'size-section', 'size-entry', 'size-body', 'size-small',
  'line-height', 'gap-paragraph', 'gap-entry', 'gap-section',
  'color-text', 'color-muted', 'color-accent', 'color-heading', 'color-rule', 'color-page',
  'heading-transform', 'heading-size-factor', 'heading-letter-spacing', 'heading-weight',
  'name-weight', 'name-transform', 'bullet-char', 'link-decoration', 'link-color'
]

const decls = css => Object.fromEntries(css.split('\n').map(l => l.match(/^(--cv-[a-z-]+): (.+);$/).slice(1)))

test('themeToCss emits exactly the contract properties, one per line', () => {
  const d = decls(themeToCss(THEME_DEFAULTS))
  assert.deepEqual(Object.keys(d).sort(), TOKENS.map(t => '--cv-' + t).sort())
  assert.equal(d['--cv-size-body'], '9.75pt')
  assert.equal(d['--cv-gap-entry'], '3mm')
  assert.equal(d['--cv-line-height'], '1.35')
  assert.equal(d['--cv-color-heading'], '#1d4ed8')
  assert.equal(d['--cv-heading-transform'], 'uppercase')
  assert.equal(d['--cv-heading-size-factor'], '1')
  assert.equal(d['--cv-heading-letter-spacing'], '0.06em')
  assert.equal(d['--cv-heading-weight'], '700')
  assert.equal(d['--cv-name-transform'], 'none')
  assert.equal(d['--cv-bullet-char'], '"•"')
  assert.equal(d['--cv-link-decoration'], 'none')
  assert.equal(d['--cv-link-color'], 'inherit')
  assert.equal(d['--cv-font-body'], FONT_STACKS['neo-grotesque'])
  assert.equal(d['--cv-font-mono'], FONT_STACKS.mono)
})

test('themeToCss maps enums', () => {
  const d = decls(themeToCss({
    ...THEME_DEFAULTS, colorHeading: 'text', headingCase: 'small-caps', nameCase: 'upper',
    bulletChar: '', linkStyle: 'accent'
  }))
  assert.equal(d['--cv-color-heading'], '#111827')
  assert.equal(d['--cv-heading-transform'], 'uppercase')
  assert.equal(d['--cv-heading-size-factor'], '0.82')
  assert.equal(d['--cv-name-transform'], 'uppercase')
  assert.equal(d['--cv-bullet-char'], '""')
  assert.equal(d['--cv-link-color'], '#1d4ed8')
  assert.equal(d['--cv-link-decoration'], 'none')
  const e = decls(themeToCss({ ...THEME_DEFAULTS, colorHeading: '#ff0000', headingCase: 'none', linkStyle: 'underline' }))
  assert.equal(e['--cv-color-heading'], '#ff0000')
  assert.equal(e['--cv-heading-transform'], 'none')
  assert.equal(e['--cv-link-decoration'], 'underline')
  assert.equal(e['--cv-link-color'], 'inherit')
})

test('density scales gaps, line height and font sizes', () => {
  const t = scaledTheme({ ...THEME_DEFAULTS, density: 1.2 })
  assert.equal(t.gapEntry, 3.6)
  assert.equal(t.gapSection, 6)
  assert.equal(t.gapParagraph, 1.44)
  assert.equal(t.lineHeight, 1.42)
  assert.equal(t.sizeBody, 10.43) // 9.75 × 1.07
  assert.equal(t.sizeName, 25.68)
  const d = decls(themeToCss({ ...THEME_DEFAULTS, density: 1.2 }))
  assert.equal(d['--cv-gap-entry'], '3.6mm')
  assert.equal(d['--cv-size-body'], '10.43pt')
  assert.equal(d['--cv-line-height'], '1.42')
  const small = scaledTheme({ ...THEME_DEFAULTS, density: 0.7 })
  assert.equal(small.gapSection, 3.5)
  assert.equal(small.lineHeight, 1.25)
  assert.equal(small.sizeBody, 8.73) // 9.75 × 0.895
  assert.deepEqual(scaledTheme(THEME_DEFAULTS), THEME_DEFAULTS)
})

test('resolveFont: presets, custom families escaped, unknown falls back', () => {
  const sans = "Arial, 'Liberation Sans', Arimo, sans-serif"
  const serif = "'Times New Roman', 'Liberation Serif', Tinos, serif"
  const mono = "'Courier New', 'Liberation Mono', Cousine, monospace"
  for (const k of ['system-ui', 'neo-grotesque', 'humanist', 'geometric']) assert.ok(FONT_STACKS[k].endsWith(sans), k)
  for (const k of ['transitional', 'old-style', 'didone', 'slab']) assert.ok(FONT_STACKS[k].endsWith(serif), k)
  assert.ok(FONT_STACKS.mono.endsWith(mono))
  assert.equal(Object.keys(FONT_STACKS).length, 9)
  assert.equal(resolveFont('didone'), FONT_STACKS.didone)
  assert.equal(resolveFont('font:My "Font"'), `"My \\"Font\\"", ${FONT_STACKS['neo-grotesque']}`)
  assert.equal(resolveFont('font:a\\b'), `"a\\\\b", ${FONT_STACKS['neo-grotesque']}`)
  assert.equal(resolveFont('font:x\n}</style>'), `"x\\a }\\3c /style>", ${FONT_STACKS['neo-grotesque']}`)
  for (const bad of ['nope', 'toString', '__proto__', 'font:', 'font:  ', undefined, 42]) {
    assert.equal(resolveFont(bad), FONT_STACKS['neo-grotesque'], String(bad))
  }
  const css = themeToCss({ ...THEME_DEFAULTS, fontHeading: 'font:My "Font"' })
  assert.match(css, /^--cv-font-heading: "My \\"Font\\"", Inter/m)
})

test('output uses no rem, vh or vw units', () => {
  for (const density of [0.7, 1, 1.2]) {
    const css = themeToCss({ ...THEME_DEFAULTS, density })
    assert.doesNotMatch(css, /\d(rem|vh|vw)\b|%/)
  }
})

test('themeAttrs exposes enum tokens as data attributes', () => {
  assert.deepEqual(themeAttrs(THEME_DEFAULTS), {
    'data-heading-rule': 'below', 'data-date-style': 'right', 'data-link-style': 'plain', 'data-heading-case': 'upper'
  })
})

test('columnCss emits only present overrides', () => {
  assert.equal(columnCss({ id: 'main', width: 1 }), '')
  assert.equal(columnCss({ id: 'side', textColor: '#ffffff', accentColor: '#fde68a' }),
    '--cv-col-text: #ffffff;\n--cv-col-accent: #fde68a;')
  assert.equal(columnCss({ mutedColor: '#e5e7eb' }), '--cv-col-muted: #e5e7eb;')
})
