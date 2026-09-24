import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultLayout, normalizeLayout, migrateFile, applyLayoutOps, sectionConfig, placeSections, renameSectionIds, columnGeometry, contentBox, getPath, THEME_DEFAULTS, PAGE_SIZES } from '../src/model/layout.js'

const doc = (...titles) => ({ header: null, diagnostics: [], sections: titles.map((t, i) => ({ id: t.toLowerCase(), title: t, titleInlines: [], explicitId: false, line: i + 1, endLine: i + 1, contacts: [], blocks: [] })) })

test('normalizeLayout survives garbage', () => {
  for (const bad of [null, undefined, 42, 'x', [], { page: 'x', grid: { columns: [] }, theme: { sizeBody: 'big', colorText: 'red; }' } }]) {
    const l = normalizeLayout(bad)
    assert.equal(l.version, 1)
    assert.equal(l.grid.columns.length, 1)
    assert.equal(l.theme.sizeBody, THEME_DEFAULTS.sizeBody)
    assert.equal(l.theme.colorText, THEME_DEFAULTS.colorText)
  }
})

test('clamps and enums', () => {
  const l = normalizeLayout({ page: { margins: { top: -5, left: 500 } }, theme: { headingLetterSpacing: 0.3, bulletChar: '★', density: 3 } })
  assert.equal(l.page.margins.top, 0)
  assert.equal(l.page.margins.left, 60)
  assert.equal(l.theme.headingLetterSpacing, 0.08)
  assert.equal(l.theme.bulletChar, '•')
  assert.equal(l.theme.density, 1.2)
})

test('columns, reading order and header span', () => {
  const l = normalizeLayout({ grid: { columns: [{ id: 'side', width: 1 }, { id: 'main', width: 2 }, { id: 'main', width: 1 }, { id: 'x' }], headerSpan: 'nope', readingOrder: ['zzz', 'side'] } })
  assert.equal(l.grid.columns.length, 3)
  assert.equal(new Set(l.grid.columns.map(c => c.id)).size, 3)
  assert.deepEqual([...l.grid.readingOrder].sort(), l.grid.columns.map(c => c.id).sort())
  assert.equal(l.grid.headerSpan, 'full')
  assert.deepEqual(normalizeLayout({ grid: { columns: [{ id: 'side', width: 1 }, { id: 'main', width: 2 }] } }).grid.readingOrder, ['main', 'side'])
})

test('column ids, widths, colours and reading order details', () => {
  const l = normalizeLayout({ grid: { columns: [{ id: 'Bad Id', width: 99, bg: '#123', bleed: true, textColor: 'blue' }, { id: 'full' }, { id: 'col-1' }], headerSpan: 'col-1', readingOrder: ['col-1', 'col-1'] } })
  assert.deepEqual(l.grid.columns.map(c => c.id), ['col-1', 'col-2', 'col-3'])
  assert.deepEqual(l.grid.columns[0], { id: 'col-1', width: 5, bg: '#123', bleed: true })
  assert.equal(l.grid.headerSpan, 'col-1')
  assert.deepEqual(l.grid.readingOrder, ['col-1', 'col-2', 'col-3'])
  // ties keep visual order
  assert.deepEqual(normalizeLayout({ grid: { columns: [{ id: 'a' }, { id: 'b' }] } }).grid.readingOrder, ['a', 'b'])
})

test('page sizes, custom pages and lang', () => {
  assert.deepEqual([defaultLayout('Letter').page.width, defaultLayout('Letter').page.height], PAGE_SIZES.Letter)
  assert.equal(defaultLayout('nope').page.size, 'A4')
  const named = normalizeLayout({ page: { size: 'A5', width: 300, height: 300, targetPages: 4.4 } })
  assert.deepEqual([named.page.width, named.page.height, named.page.targetPages], [148, 210, 4])
  const custom = normalizeLayout({ page: { size: 'custom', width: 10, height: 1000 } })
  assert.deepEqual([custom.page.width, custom.page.height], [80, 600])
  assert.equal(normalizeLayout({ lang: 'de' }).lang, 'de')
  assert.equal(normalizeLayout({ lang: 'not a tag' }).lang, 'en')
})

test('header photo, fonts, colours, custom css', () => {
  const ok = { src: 'data:image/png;base64,AAAA', size: 500, shape: 'oval' }
  assert.deepEqual(normalizeLayout({ header: { align: 'center', photo: ok } }).header, { align: 'center', photo: { src: ok.src, size: 80, shape: 'circle', position: 'left' } })
  assert.equal(normalizeLayout({ header: { photo: { src: 'https://x.dev/a.png' } } }).header.photo, null)
  assert.equal(normalizeLayout({ header: { photo: { src: 'data:image/png;base64,' + 'A'.repeat(200000) } } }).header.photo, null)
  assert.equal(normalizeLayout({ header: { photo: { src: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' } } }).header.photo, null)
  const jpeg = { src: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==' }
  assert.equal(normalizeLayout({ header: { photo: jpeg } }).header.photo.src, jpeg.src)
  const t = normalizeLayout({ theme: { fontBody: 'font:My Font', fontHeading: 'comic', fontMono: 'font:', colorHeading: 'text', colorAccent: '#ABCDEF', colorRule: 'rgb(0,0,0)' } }).theme
  assert.deepEqual([t.fontBody, t.fontHeading, t.fontMono, t.colorHeading, t.colorAccent, t.colorRule], ['font:My Font', THEME_DEFAULTS.fontHeading, 'mono', 'text', '#ABCDEF', THEME_DEFAULTS.colorRule])
  assert.equal(normalizeLayout({ customCss: 'x'.repeat(60000) }).customCss.length, 50000)
  assert.equal(normalizeLayout({ theme: { unknown: 1 } }).theme.unknown, undefined)
})

test('section configs and decor', () => {
  const l = normalizeLayout({
    sectionDefaults: { '*': { variant: 'nope', showTitle: false }, skills: { panel: { bg: 'red', padding: 99 } }, bogus: { hidden: true } },
    sections: { 'Bad Key': { hidden: true }, work: { panel: null, column: 'side', extra: 1 }, junk: 5 },
    decor: [{ id: 'd1' }, { id: 'd1', kind: 'star', pages: [2, 'x', 2, 0], x: -500, w: 5000, opacity: 2 }, { pages: [] }, 7],
  })
  assert.deepEqual(l.sectionDefaults, { '*': { showTitle: false }, skills: { panel: { bg: '#f4f4f5', border: 'none', borderColor: '#e4e4e7', borderWidth: 0.3, radius: 2, padding: 20 } } })
  assert.deepEqual(l.sections, { work: { column: 'side', panel: null } })
  assert.deepEqual(l.decor.map(d => d.id), ['d1', 'd2', 'd3'])
  assert.deepEqual([l.decor[1].kind, l.decor[1].pages, l.decor[1].x, l.decor[1].w, l.decor[1].opacity], ['rect', [2], -50, 260, 1])
  assert.equal(l.decor[2].pages, 'all')
})

test('normalizeLayout is idempotent and never aliases its input', () => {
  const input = { grid: { columns: [{ id: 'side', width: 1, bg: '#eee' }, { id: 'main', width: 2 }] }, sections: { skills: { panel: { bg: '#fafafa' } } }, decor: [{ kind: 'line', pages: [1, 3] }], header: { photo: { src: 'data:image/png;base64,A' } } }
  const once = normalizeLayout(input)
  assert.deepEqual(normalizeLayout(once), once)
  assert.notEqual(normalizeLayout(once).decor[0].pages, once.decor[0].pages)
  assert.notEqual(normalizeLayout(once).sections.skills.panel, once.sections.skills.panel)
})

test('migrateFile never throws', () => {
  assert.equal(migrateFile('not json').warnings[0], 'invalid-file')
  assert.equal(migrateFile({ format: 'recto', version: 9, content: '# A' }).warnings.includes('newer-version'), true)
  const { file } = migrateFile({ format: 'recto', version: 1, content: '# A', layout: null, snapshots: [1], junk: 1 })
  assert.equal(file.content, '# A')
  assert.equal('snapshots' in file, false)
  assert.equal(file.layout.version, 1)
})

test('migrateFile details', () => {
  for (const bad of [null, 5, [], '[]']) {
    const r = migrateFile(bad)
    assert.deepEqual(r.warnings, ['invalid-file'])
    assert.deepEqual(r.file, { format: 'recto', version: 1, name: '', content: '', layout: defaultLayout() })
  }
  const r = migrateFile(JSON.stringify({ format: 'recto', version: 1, name: 'Jane', content: '# A\r\nB\rC', fonts: [{ family: 'F', data: 'AAA', x: 1 }, { family: '' }, 3] }))
  assert.deepEqual(r.warnings, [])
  assert.equal(r.file.name, 'Jane')
  assert.equal(r.file.content, '# A\nB\nC')
  assert.deepEqual(r.file.fonts, [{ family: 'F', data: 'AAA' }])
  assert.equal('fonts' in migrateFile({ content: 1 }).file, false)
  assert.equal(migrateFile({ content: 1 }).file.content, '')
})

test('applyLayoutOps sets, creates and deletes immutably', () => {
  const a = defaultLayout()
  const b = applyLayoutOps(a, [{ path: ['theme', 'lineHeight'], value: 1.5 }, { path: ['sections', 'skills', 'variant'], value: 'tags' }])
  assert.equal(a.theme.lineHeight, THEME_DEFAULTS.lineHeight)
  assert.equal(b.theme.lineHeight, 1.5)
  assert.equal(b.sections.skills.variant, 'tags')
  const c = applyLayoutOps(b, [{ path: ['sections', 'skills'], value: undefined }])
  assert.equal(c.sections.skills, undefined)
})

test('applyLayoutOps: array delete, invalid values, prototype keys', () => {
  const a = normalizeLayout({ decor: [{ id: 'x' }, { id: 'y' }, { id: 'z' }] })
  assert.deepEqual(applyLayoutOps(a, [{ path: ['decor', 1], value: undefined }]).decor.map(d => d.id), ['x', 'z'])
  assert.equal(applyLayoutOps(a, [{ path: ['theme', 'sizeBody'], value: 'huge' }]).theme.sizeBody, THEME_DEFAULTS.sizeBody)
  const b = applyLayoutOps(a, [{ path: ['__proto__', 'polluted'], value: 1 }, { path: ['sections', '__proto__', 'polluted'], value: 1 }, null, { path: [] }])
  assert.equal({}.polluted, undefined)
  assert.deepEqual(b, a)
  const c = applyLayoutOps(a, [{ path: ['sections', 'constructor', 'variant'], value: 'grid' }])
  assert.equal(c.sections.constructor.variant, 'grid')
  assert.equal(getPath(c, ['sections', 'constructor', 'variant']), 'grid')
  assert.equal(getPath(c, ['nope', 3, 'x']), undefined)
  const panel = { bg: '#eeeeee' }
  const d = applyLayoutOps(a, [{ path: ['sections', 'work', 'panel'], value: panel }, { path: ['sections', 'work', 'panel', 'padding'], value: 5 }])
  assert.deepEqual(panel, { bg: '#eeeeee' })
  assert.equal(d.sections.work.panel.padding, 5)
})

test('sectionConfig merge order and column fallback', () => {
  const l = normalizeLayout({ grid: { columns: [{ id: 'main', width: 2 }, { id: 'side', width: 1 }] }, sectionDefaults: { '*': { variant: 'compact' }, skills: { column: 'side', variant: 'tags' } }, sections: { skills: { showTitle: false }, work: { column: 'gone' } } })
  const d = doc('Skills', 'Work')
  assert.deepEqual([sectionConfig(l, d.sections[0]).column, sectionConfig(l, d.sections[0]).variant, sectionConfig(l, d.sections[0]).showTitle], ['side', 'tags', false])
  assert.equal(sectionConfig(l, d.sections[1]).column, 'main')
  assert.equal(sectionConfig(l, d.sections[1]).keepTogether, true)
  const placed = placeSections(d, l)
  assert.deepEqual(Object.keys(placed).sort(), ['main', 'side'])
  assert.deepEqual(placed.side.map(p => p.section.id), ['skills'])
})

test('placeSections skips hidden sections and keeps source order', () => {
  const l = normalizeLayout({ grid: { columns: [{ id: 'a' }, { id: 'b' }] }, sections: { two: { hidden: true }, four: { column: 'b' } } })
  const placed = placeSections(doc('One', 'Two', 'Three', 'Four'), l)
  assert.deepEqual(placed.a.map(p => p.section.id), ['one', 'three'])
  assert.deepEqual(placed.b.map(p => p.config.column), ['b'])
  assert.equal(sectionConfig(l, { id: 'constructor', title: 'Constructor' }).variant, 'list')
})

test('renameSectionIds survives typing through a rename', () => {
  let l = normalizeLayout({ sections: { experience: { variant: 'timeline' } } })
  const steps = [doc('Summary', 'Experience'), doc('Summary', 'Experien'), doc('Summary', 'Experience')]
  for (let i = 1; i < steps.length; i++) l = renameSectionIds(steps[i - 1], steps[i], l)
  assert.equal(l.sections.experience.variant, 'timeline')
  assert.equal(l.sections.experien, undefined)
})

test('renameSectionIds ignores anything but a single in-place rename', () => {
  const l = normalizeLayout({ sections: { a: { variant: 'tags' }, b: { variant: 'grid' } } })
  assert.equal(renameSectionIds(doc('A', 'B'), doc('B', 'A'), l), l)
  assert.equal(renameSectionIds(doc('A', 'B'), doc('A', 'B', 'C'), l), l)
  assert.equal(renameSectionIds(doc('A', 'B'), doc('X', 'Y'), l), l)
  assert.equal(renameSectionIds(doc('A', 'C'), doc('A', 'B'), l), l) // 'b' already exists
  assert.equal(renameSectionIds(null, doc('A'), l), l)
})

test('columnGeometry', () => {
  const l = normalizeLayout({ page: { size: 'A4', margins: { top: 10, right: 10, bottom: 10, left: 10 } }, grid: { columns: [{ id: 'a', width: 1 }, { id: 'b', width: 3 }], gutter: 10 } })
  assert.deepEqual(columnGeometry(l), [{ id: 'a', x: 10, w: 45 }, { id: 'b', x: 65, w: 135 }])
  assert.deepEqual(contentBox(l), { x: 10, y: 10, w: 190, h: 277 })
})
