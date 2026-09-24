import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runPreflight, RULES, SEVERITY_ORDER } from '../src/preflight/rules.js'
import { parse, DIAG_CODES } from '../src/model/markdown.js'
import { defaultLayout, applyLayoutOps } from '../src/model/layout.js'
import { applyContentEdits } from '../src/model/edits.js'

const NOW = new Date(2026, 8, 15)
const EN = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8'))
const SAMPLE = JSON.parse(readFileSync(new URL('../samples/sample.cv.json', import.meta.url), 'utf8'))
const report = (o = {}) => ({ pageCount: 1, targetPages: 1, lastPageFill: 0.6, flags: [], textStyles: [], fontsMissing: [], pages: [{ firstText: '', lastText: '', columnsWithText: ['main'] }], ...o })
const layoutWith = ops => applyLayoutOps(defaultLayout(), ops)

const seen = [] // every issue produced, for the locale checks at the end
function run (source, { layout = defaultLayout(), report = null, placement = null } = {}) {
  const issues = runPreflight({ source, doc: parse(source), layout, report, placement, now: NOW })
  seen.push(...issues)
  for (const i of issues) {
    for (const e of i.fix?.kind === 'content' ? i.fix.edits : []) {
      assert.equal(e.expect, source.split('\n')[e.line - 1], `${i.rule}: expect is the current line`)
    }
  }
  return issues
}
const only = (issues, rule) => issues.filter(i => i.rule === rule)
const one = (issues, rule) => {
  const found = only(issues, rule)
  assert.equal(found.length, 1, `${rule} fires once`)
  return found[0]
}
const none = (issues, rule) => assert.deepEqual(only(issues, rule), [], `${rule} is silent`)
const fixContent = (source, issue) => {
  const r = applyContentEdits(source, issue.fix.edits)
  assert.equal(r.stale, false)
  return r.content
}

// Header with a valid email and an international phone, so contact rules stay quiet.
const cv = body => '# Jane Doe\nEmail: jane@doe.dev · +49 151 0000000\n\n' + body

test('RULES table and severity order', () => {
  assert.deepEqual(SEVERITY_ORDER, { error: 0, warn: 1, info: 2 })
  assert.equal(RULES[0].id, 'missing-name')
  assert.equal(RULES.at(-1).id, 'column-interrupts-entry')
  assert.equal(new Set(RULES.map(r => r.id)).size, 35)
  assert.equal(RULES.find(r => r.id === 'line-height-tight').needsReport, false)
  assert.equal(RULES.find(r => r.id === 'page-overflow').needsReport, true)
  assert.equal(RULES.filter(r => r.needsReport).length, 9)
})

test('sample CV with the default layout has zero errors', () => {
  const issues = run(SAMPLE.content)
  assert.deepEqual(issues.filter(i => i.severity === 'error'), [])
})

test('degenerate documents never throw', () => {
  for (const src of ['', '#', '# ', '##', '## \n---', '###', '- a', '---', '\n\n\n', '# A\n## B {#b}\n## B']) {
    assert.ok(Array.isArray(run(src)))
    assert.ok(Array.isArray(run(src, { report: report({ textStyles: [{}], flags: [{}] }), placement: [] })))
  }
})

test('issues sort error → warn → info, then by line', () => {
  const issues = run('# Jane\njane@doe · 0151 0000000\n## Stuff\n### A | B | 2021 – 2019\n- the the')
  const keys = issues.map(i => [SEVERITY_ORDER[i.severity], i.line ?? 0])
  assert.deepEqual(keys, [...keys].sort((a, b) => a[0] - b[0] || a[1] - b[1]))
  assert.equal(issues[0].severity, 'error')
})

test('report-dependent rules are skipped without a report', () => {
  const needs = new Set(RULES.filter(r => r.needsReport).map(r => r.id))
  const issues = run(cv('## Summary\nHi'), { layout: layoutWith([{ path: ['page', 'targetPages'], value: 1 }]) })
  assert.ok(issues.every(i => !needs.has(i.rule)))
})

// ---------- contacts ----------

test('missing-name', () => {
  const i = one(run('## Summary\nHi'), 'missing-name')
  assert.equal(i.severity, 'error')
  assert.equal(i.msg, 'preflight.missing-name')
  none(run(cv('')), 'missing-name')
})

test('missing-email: header first, then contact sections', () => {
  assert.equal(one(run('# Jane\n+49 151 0000000'), 'missing-email').severity, 'warn')
  none(run(cv('')), 'missing-email')
  none(run('# Jane\n## Contact\n- jane@doe.dev'), 'missing-email')
})

test('missing-phone', () => {
  assert.equal(one(run('# Jane\njane@doe.dev'), 'missing-phone').severity, 'info')
  none(run(cv('')), 'missing-phone')
})

test('invalid-email', () => {
  const i = one(run('# Jane\njane@doe · +49 151 0000000'), 'invalid-email')
  assert.equal(i.severity, 'error')
  assert.equal(i.line, 2)
  assert.deepEqual(i.vars, { value: 'jane@doe' })
  none(run(cv('')), 'invalid-email')
})

test('invalid-url', () => {
  const i = one(run('# Jane\njane@doe.dev · https://bad'), 'invalid-url')
  assert.equal(i.severity, 'warn')
  assert.equal(i.line, 2)
  assert.deepEqual(i.vars, { value: 'https://bad' })
  none(run('# Jane\njane@doe.dev · jane.dev'), 'invalid-url')
})

test('phone-format', () => {
  const i = one(run('# Jane\njane@doe.dev · 0151 0000000'), 'phone-format')
  assert.equal(i.severity, 'info')
  assert.equal(i.line, 2)
  assert.deepEqual(i.vars, { value: '0151 0000000' })
  none(run(cv('')), 'phone-format')
})

// ---------- dates ----------

test('entry-date: fires on empty/unparseable dates in dated categories, fix moves the date', () => {
  const src = cv('## Experience\n### Engineer | Acme | | 2019 – 2021 ')
  const i = one(run(src), 'entry-date')
  assert.equal(i.severity, 'warn')
  assert.equal(i.line, 5)
  assert.equal(i.sectionId, 'experience')
  assert.deepEqual(i.vars, { title: 'Engineer' })
  const fixed = fixContent(src, i)
  assert.equal(fixed.split('\n')[4], '### Engineer | Acme | 2019 – 2021')
  none(run(fixed), 'entry-date')

  const moved = cv('## Education\n### 2019 – 2020 | B.S. | Uni')
  const fixed2 = fixContent(moved, one(run(moved), 'entry-date'))
  assert.equal(fixed2.split('\n')[4], '### B.S. | Uni | 2019 – 2020')
  none(run(fixed2), 'entry-date')

  assert.equal(one(run(cv('## Experience\n### Engineer | Acme')), 'entry-date').fix, undefined)
  none(run(cv('## Experience\n### Engineer | Acme | 2019 – 2021')), 'entry-date')
  none(run(cv('## Projects\n### Tool | Side')), 'entry-date')
})

test('date-format-mixed: rewrites minority month styles only', () => {
  const src = cv([
    '## Experience',
    '### A | Acme | Jan 2020 – Mar 2021',
    '### B | Globex | May 2018 – Dec 2019',
    '### C \\| D | Initech | 2016-01 – 2018-03 | Berlin',
    '### E | Hooli | 2012 – 2015',
  ].join('\n'))
  const i = one(run(src), 'date-format-mixed')
  assert.equal(i.severity, 'info')
  assert.equal(i.line, 7)
  assert.equal(i.vars.styles, 'Mon YYYY, YYYY-MM')
  assert.equal(i.fix.edits.length, 1)
  assert.equal(i.fix.edits[0].text, '### C \\| D | Initech | Jan 2016 – Mar 2018 | Berlin')
  const fixed = fixContent(src, i)
  assert.ok(fixed.includes('### E | Hooli | 2012 – 2015'))
  none(run(fixed), 'date-format-mixed')

  none(run(cv('## Experience\n### A | X | Jan 2020 – Present\n### B | Y | 2015 – 2019')), 'date-format-mixed')
  // 'May' is both a short and a long month name
  none(run(cv('## Experience\n### A | X | January 2020 – Present\n### B | Y | May 2018 – December 2019')), 'date-format-mixed')
})

test('date-order', () => {
  const i = one(run(cv('## Experience\n### Eng | Acme | 2021 – 2019')), 'date-order')
  assert.equal(i.severity, 'error')
  assert.equal(i.line, 5)
  assert.equal(i.sectionId, 'experience')
  assert.deepEqual(i.vars, { title: 'Eng' })
  none(run(cv('## Experience\n### Eng | Acme | 2019 – 2021\n### Eng | Acme | Mar 2020 – 2020')), 'date-order')
})

test('date-future', () => {
  const i = one(run(cv('## Experience\n### Eng | Acme | Jan 2027 – Present')), 'date-future')
  assert.equal(i.severity, 'warn')
  assert.equal(i.line, 5)
  assert.deepEqual(i.vars, { title: 'Eng' })
  none(run(cv('## Experience\n### Eng | Acme | Sep 2026 – Present\n### Eng | Acme | 2026')), 'date-future')
})

test('not-reverse-chronological', () => {
  const i = one(run(cv('## Experience\n### A | X | 2015 – 2017\n### B | Y | 2018 – Present')), 'not-reverse-chronological')
  assert.equal(i.severity, 'info')
  assert.equal(i.line, 6)
  assert.equal(i.sectionId, 'experience')
  assert.deepEqual(i.vars, { section: 'Experience' })
  none(run(cv('## Experience\n### B | Y | 2018 – Present\n### A | X | 2015 – 2017\n### C | Z')), 'not-reverse-chronological')
})

// ---------- bullets and text ----------

test('bullet-too-long', () => {
  const i = one(run(cv('## Summary\n- ' + 'a'.repeat(201))), 'bullet-too-long')
  assert.equal(i.severity, 'info')
  assert.equal(i.line, 5)
  assert.equal(i.sectionId, 'summary')
  assert.deepEqual(i.vars, { length: 201, max: 200 })
  none(run(cv('## Summary\n- ' + 'a'.repeat(200))), 'bullet-too-long')
})

test('too-many-bullets', () => {
  const bullets = n => Array.from({ length: n }, (_, k) => `- Item ${k}`).join('\n')
  const i = one(run(cv('## Projects\n### Tool | Side\n' + bullets(7))), 'too-many-bullets')
  assert.equal(i.severity, 'info')
  assert.equal(i.line, 5)
  assert.equal(i.sectionId, 'projects')
  assert.deepEqual(i.vars, { count: 7, max: 6 })
  none(run(cv('## Experience\n### Eng | Acme | 2020\n' + bullets(6))), 'too-many-bullets')
})

test('bullet-punctuation-mixed: majority wins, fix adds or removes one period', () => {
  const add = cv('## Experience\n- Did one.\n- Did two.\n- Did three.\n- Did four\n- Did\n  five')
  const i = one(run(add), 'bullet-punctuation-mixed')
  assert.equal(i.severity, 'info')
  assert.equal(i.line, 8)
  assert.equal(i.sectionId, 'experience')
  const fixed = fixContent(add, i)
  assert.ok(fixed.endsWith('- Did four.\n- Did\n  five.'))
  none(run(fixed), 'bullet-punctuation-mixed')

  const remove = cv('## Experience\n- Did one.\n- Did two\n- Did three')
  const fixed2 = fixContent(remove, one(run(remove), 'bullet-punctuation-mixed'))
  assert.ok(fixed2.endsWith('- Did one\n- Did two\n- Did three'))
  none(run(fixed2), 'bullet-punctuation-mixed')

  none(run(cv('## Experience\n- Did one.\n- Worked at Acme Inc.\n- Docs at https://x.dev\n- See x.dev\n- Why?\n- Did two.')), 'bullet-punctuation-mixed')
  none(run(cv('## Experience\n- Did one\n- Worked at Acme Inc.\n- Reported to John F.\n- Used `make`')), 'bullet-punctuation-mixed')
})

test('repeated-word: fix removes the duplicate', () => {
  const src = cv('## Summary\nI built the the platform\nand more')
  const i = one(run(src), 'repeated-word')
  assert.equal(i.severity, 'info')
  assert.equal(i.line, 5)
  assert.equal(i.sectionId, 'summary')
  assert.deepEqual(i.vars, { word: 'the' })
  const fixed = fixContent(src, i)
  assert.ok(fixed.includes('I built the platform\nand more'))
  none(run(fixed), 'repeated-word')

  const later = cv('## Summary\nFirst line\nthen The the end')
  assert.equal(one(run(later), 'repeated-word').line, 6)
  none(run(cv('## Summary\nI knew that that was fine. We had had enough. Walla Walla. Go, go. the theme')), 'repeated-word')
})

test('invisible-characters: fix deletes them', () => {
  const src = cv('## Summary\nHel­lo wor​ld\n- x⁠y')
  const i = one(run(src), 'invisible-characters')
  assert.equal(i.severity, 'warn')
  assert.equal(i.line, 5)
  assert.deepEqual(i.vars, { count: 3 })
  const fixed = fixContent(src, i)
  assert.ok(fixed.includes('Hello world\n- xy'))
  none(run(fixed), 'invisible-characters')
  none(run(cv('## Summary\nHello')), 'invisible-characters')
})

test('special-characters', () => {
  const i = one(run(cv('## Summary\n- Shipped 🚀 fast ★\n- 🚀 again')), 'special-characters')
  assert.equal(i.severity, 'warn')
  assert.equal(i.line, 5)
  assert.deepEqual(i.vars, { chars: '🚀 ★' })
  none(run(cv('## Summary\n• · – — … ‘ ’ “ ” → × © ® ™')), 'special-characters')
})

// ---------- sections ----------

test('empty-section', () => {
  const i = one(run(cv('## Awards\n\n## Skills\n- Go')), 'empty-section')
  assert.equal(i.severity, 'warn')
  assert.equal(i.line, 4)
  assert.equal(i.sectionId, 'awards')
  assert.deepEqual(i.vars, { section: 'Awards' })
  none(run(cv('## Skills\n- Go')), 'empty-section')
  none(run(cv('## Awards\n'), { layout: layoutWith([{ path: ['sections', 'awards', 'hidden'], value: true }]) }), 'empty-section')
})

test('untitled-section: fix shows the title when there is one', () => {
  const src = cv('## Summary\nHi')
  const layout = layoutWith([{ path: ['sections', 'summary', 'showTitle'], value: false }])
  const i = one(run(src, { layout }), 'untitled-section')
  assert.equal(i.severity, 'warn')
  assert.equal(i.line, 4)
  assert.equal(i.sectionId, 'summary')
  assert.deepEqual(i.vars, { section: 'Summary' })
  none(run(src, { layout: applyLayoutOps(layout, i.fix.ops) }), 'untitled-section')

  assert.equal(one(run(cv('##\nHi')), 'untitled-section').fix, undefined)
  none(run(src), 'untitled-section')
})

test('markup-diagnostic', () => {
  const i = one(run(cv('## Summary\nSome **bold')), 'markup-diagnostic')
  assert.equal(i.severity, 'warn')
  assert.equal(i.msg, 'diag.unclosed-emphasis')
  assert.equal(i.line, 5)
  assert.deepEqual(i.vars, { marker: '**' })
  none(run(cv('## Summary\nSome **bold**')), 'markup-diagnostic')
})

test('nonstandard-heading', () => {
  const i = one(run(cv('## Stuff I Did\n- x')), 'nonstandard-heading')
  assert.equal(i.severity, 'info')
  assert.equal(i.line, 4)
  assert.equal(i.sectionId, 'stuff-i-did')
  assert.deepEqual(i.vars, { title: 'Stuff I Did' })
  none(run(cv('## Work Experience\n- x')), 'nonstandard-heading')
  none(run(cv('## Berufserfahrung\n- x'), { layout: layoutWith([{ path: ['lang'], value: 'de' }]) }), 'nonstandard-heading')
})

test('hidden-link-target: header replaces the link, body appends the target', () => {
  const head = '# Jane\njane@doe.dev · +49 151 0000000 · [Portfolio](https://www.jane.dev/)'
  const h = one(run(head), 'hidden-link-target')
  assert.equal(h.severity, 'warn')
  assert.equal(h.line, 2)
  assert.deepEqual(h.vars, { text: 'Portfolio', href: 'jane.dev' })
  const fixedHead = fixContent(head, h)
  assert.equal(fixedHead.split('\n')[1], 'jane@doe.dev · +49 151 0000000 · jane.dev')
  none(run(fixedHead), 'hidden-link-target')

  const body = cv('## Projects\n- Built [my site](https://x.dev) in a week')
  const b = one(run(body), 'hidden-link-target')
  assert.equal(b.severity, 'info')
  assert.equal(b.line, 5)
  assert.equal(b.sectionId, 'projects')
  const fixedBody = fixContent(body, b)
  assert.ok(fixedBody.endsWith('- Built [my site](https://x.dev) (x.dev) in a week'))
  none(run(fixedBody), 'hidden-link-target')

  const mail = cv('## Summary\n[Write me](mailto:jane@doe.dev)')
  none(run(fixContent(mail, one(run(mail), 'hidden-link-target'))), 'hidden-link-target')

  none(run(cv('## Projects\n- [x.dev](https://x.dev/) and https://y.dev and [+49 151 000 0000](tel:+491510000000)')), 'hidden-link-target')
})

// ---------- layout ----------

test('photo-present', () => {
  const layout = layoutWith([{ path: ['header', 'photo'], value: { src: 'data:image/jpeg;base64,AAAA' } }])
  assert.equal(one(run(cv(''), { layout }), 'photo-present').severity, 'info')
  none(run(cv('')), 'photo-present')
})

test('custom-css', () => {
  const layout = layoutWith([{ path: ['customCss'], value: '.cv-name { color: red }' }])
  assert.equal(one(run(cv(''), { layout }), 'custom-css').severity, 'info')
  none(run(cv('')), 'custom-css')
})

test('margin-too-small: fix sets 10 mm', () => {
  const layout = layoutWith([{ path: ['page', 'margins', 'left'], value: 5 }])
  const i = one(run(cv(''), { layout }), 'margin-too-small')
  assert.equal(i.severity, 'warn')
  assert.deepEqual(i.vars, { side: 'left', value: 5, min: 7 })
  const fixed = applyLayoutOps(layout, i.fix.ops)
  assert.equal(fixed.page.margins.left, 10)
  none(run(cv(''), { layout: fixed }), 'margin-too-small')
  none(run(cv('')), 'margin-too-small')
})

test('line-height-tight: fix sets 1.25', () => {
  const layout = layoutWith([{ path: ['theme', 'lineHeight'], value: 1.1 }])
  const i = one(run(cv(''), { layout }), 'line-height-tight')
  assert.equal(i.severity, 'warn')
  assert.deepEqual(i.vars, { value: 1.1 })
  const fixed = applyLayoutOps(layout, i.fix.ops)
  assert.equal(fixed.theme.lineHeight, 1.25)
  none(run(cv(''), { layout: fixed }), 'line-height-tight')
  none(run(cv('')), 'line-height-tight')
})

// ---------- render rules ----------

test('page-overflow: overflow and verify-failed flags', () => {
  const flags = [{ kind: 'overflow', page: 2, colId: 'main', sectionId: 'experience', line: 9 }, { kind: 'verify-failed', page: 3, colId: 'main', sectionId: null, line: null }]
  const found = only(run(cv(''), { report: report({ flags }) }), 'page-overflow')
  assert.equal(found.length, 2)
  const [a, b] = [2, 3].map(p => found.find(i => i.page === p))
  assert.equal(a.severity, 'error')
  assert.equal(a.page, 2)
  assert.equal(a.line, 9)
  assert.equal(a.sectionId, 'experience')
  assert.deepEqual(a.vars, { page: 2 })
  assert.equal(b.page, 3)
  assert.equal('sectionId' in b, false)
  none(run(cv(''), { report: report() }), 'page-overflow')
})

test('pages-over-target: fit-pages to the target', () => {
  const i = one(run(cv(''), { report: report({ pageCount: 3, targetPages: 2 }) }), 'pages-over-target')
  assert.equal(i.severity, 'warn')
  assert.deepEqual(i.vars, { pages: 3, target: 2 })
  assert.deepEqual(i.fix, { kind: 'action', action: 'fit-pages', pages: 2 })
  none(run(cv(''), { report: report({ pageCount: i.fix.pages, targetPages: 2 }) }), 'pages-over-target')
})

test('sparse-last-page: fit-pages to one page fewer', () => {
  const i = one(run(cv(''), { report: report({ pageCount: 2, targetPages: 2, lastPageFill: 0.1 }) }), 'sparse-last-page')
  assert.equal(i.severity, 'info')
  assert.equal(i.page, 2)
  assert.deepEqual(i.vars, { fill: 10 })
  assert.deepEqual(i.fix, { kind: 'action', action: 'fit-pages', pages: 1 })
  none(run(cv(''), { report: report({ pageCount: i.fix.pages, lastPageFill: 0.9 }) }), 'sparse-last-page')
  none(run(cv(''), { report: report({ pageCount: 2, targetPages: 2, lastPageFill: 0.2 }) }), 'sparse-last-page')
})

test('forced-split', () => {
  const flags = [{ kind: 'forced-split', page: 1, colId: 'main', sectionId: 'experience', line: 7 }]
  const i = one(run(cv(''), { report: report({ flags }) }), 'forced-split')
  assert.equal(i.severity, 'info')
  assert.equal(i.page, 1)
  assert.equal(i.line, 7)
  assert.deepEqual(i.vars, { page: 1 })
  none(run(cv(''), { report: report() }), 'forced-split')
})

const style = (o = {}) => ({ sectionId: 'summary', line: 5, page: 1, role: 'body', sizeToken: 'sizeBody', fontSizePt: 9.75, color: '#111827', colorPath: ['theme', 'colorText'], background: '#ffffff', family: 'Inter', ...o })

test('font-too-small: warn/error thresholds, fix raises the size token', () => {
  const at = (layout, o) => run(cv(''), { layout, report: report({ textStyles: [style({ fontSizePt: layout.theme.sizeBody, ...o })] }) })
  const layout = layoutWith([{ path: ['theme', 'sizeBody'], value: 8.5 }])
  const i = one(at(layout), 'font-too-small')
  assert.equal(i.severity, 'warn')
  assert.equal(i.line, 5)
  assert.equal(i.page, 1)
  assert.equal(i.sectionId, 'summary')
  assert.deepEqual(i.vars, { size: 8.5, min: 9 })
  assert.deepEqual(i.fix.ops, [{ path: ['theme', 'sizeBody'], value: 9 }])
  none(at(applyLayoutOps(layout, i.fix.ops)), 'font-too-small')

  assert.equal(one(at(layoutWith([{ path: ['theme', 'sizeBody'], value: 7 }])), 'font-too-small').severity, 'error')
  const small = run(cv(''), { layout: layoutWith([{ path: ['theme', 'sizeSmall'], value: 6.5 }]), report: report({ textStyles: [style({ role: 'small', sizeToken: 'sizeSmall', fontSizePt: 7.5 }), style({ role: 'small', sizeToken: 'sizeSmall', fontSizePt: 6.5, line: 6 })] }) })
  const s = one(small, 'font-too-small')
  assert.equal(s.severity, 'error')
  assert.equal(s.line, 6)
  assert.deepEqual(s.vars, { size: 6.5, min: 8 })
  assert.deepEqual(s.fix.ops, [{ path: ['theme', 'sizeSmall'], value: 8 }])
  // density 0.7 scales 9.75 pt to 8.73 pt: the fix compensates so the rendered size reaches 9 pt
  const dense = layoutWith([{ path: ['theme', 'density'], value: 0.7 }])
  assert.deepEqual(one(at(dense, { fontSizePt: 8.73 }), 'font-too-small').fix.ops, [{ path: ['theme', 'sizeBody'], value: 10.25 }])
  none(at(defaultLayout()), 'font-too-small')
  none(run(cv(''), { report: report({ textStyles: [style({ role: 'small', sizeToken: 'sizeSmall', fontSizePt: 8 })] }) }), 'font-too-small')
})

test('low-contrast: warn/error thresholds, fix picks black or white', () => {
  const i = one(run(cv(''), { report: report({ textStyles: [style({ background: '#1d4ed8' }), style({ background: '#1d4ed8', line: 6 })] }) }), 'low-contrast')
  assert.equal(i.severity, 'error')
  assert.equal(i.line, 5)
  assert.deepEqual(i.vars, { ratio: 2.64, min: 4.5 })
  assert.deepEqual(i.fix.ops, [{ path: ['theme', 'colorText'], value: '#ffffff' }])
  const fixed = applyLayoutOps(defaultLayout(), i.fix.ops)
  none(run(cv(''), { report: report({ textStyles: [style({ background: '#1d4ed8', color: fixed.theme.colorText })] }) }), 'low-contrast')

  assert.equal(one(run(cv(''), { report: report({ textStyles: [style({ color: '#777777' })] }) }), 'low-contrast').severity, 'warn')
  assert.equal(one(run(cv(''), { report: report({ textStyles: [style({ color: '#777777', colorPath: null })] }) }), 'low-contrast').fix, undefined)
  none(run(cv(''), { report: report({ textStyles: [style()] }) }), 'low-contrast')
  none(run(cv(''), { report: report({ textStyles: [style({ color: 'oklch(0.9 0 0)' })] }) }), 'low-contrast')
})

test('missing-font', () => {
  const i = one(run(cv(''), { report: report({ fontsMissing: ['font:My Font'] }) }), 'missing-font')
  assert.equal(i.severity, 'warn')
  assert.deepEqual(i.vars, { family: 'My Font' })
  none(run(cv(''), { report: report() }), 'missing-font')
})

const twoCols = () => layoutWith([{ path: ['grid'], value: { columns: [{ id: 'main', width: 2 }, { id: 'side', width: 1 }], readingOrder: ['main', 'side'] } }])

test('multi-column', () => {
  const pages = [{ firstText: '', lastText: '', columnsWithText: ['side', 'main'] }]
  const i = one(run(cv(''), { layout: twoCols(), report: report({ pages }) }), 'multi-column')
  assert.equal(i.severity, 'warn')
  assert.equal(i.page, 1)
  assert.deepEqual(i.vars, { order: 'main → side' })
  none(run(cv(''), { layout: twoCols(), report: report() }), 'multi-column')
})

test('column-interrupts-entry', () => {
  const src = cv('## Experience\n### Eng | Acme | 2020\n- One\n- Two\n## Skills\n- Go')
  const atom = (page, colId, sectionId, line, kind) => ({ page, colId, sectionId, line, kind })
  const base = [atom(1, null, null, 1, 'header'), atom(1, 'main', 'experience', 4, 'title'), atom(1, 'main', 'experience', 5, 'entry-head'), atom(1, 'main', 'experience', 6, 'li')]
  const split = [...base, atom(2, 'main', 'experience', 7, 'li'), atom(1, 'side', 'skills', 9, 'li')]
  const i = one(run(src, { layout: twoCols(), report: report(), placement: split }), 'column-interrupts-entry')
  assert.equal(i.severity, 'warn')
  assert.equal(i.line, 5)
  assert.equal(i.page, 1)
  assert.equal(i.sectionId, 'experience')
  assert.deepEqual(i.vars, { title: 'Eng' })
  none(run(src, { layout: twoCols(), report: report(), placement: [...base, atom(2, 'main', 'experience', 7, 'li'), atom(2, 'side', 'skills', 9, 'li')] }), 'column-interrupts-entry')
  none(run(src, { layout: twoCols(), report: report(), placement: [...base, atom(1, 'main', 'experience', 7, 'li'), atom(1, 'side', 'skills', 9, 'li')] }), 'column-interrupts-entry')
})

// ---------- locale ----------

test('locale part: every rule, fix label and diagnostic has a key, and every {var} is supplied', () => {
  for (const { id } of RULES) assert.equal(typeof EN[`preflight.${id}`], 'string', id)
  for (const code of DIAG_CODES) assert.equal(typeof EN[`diag.${code}`], 'string', code)
  const fixable = new Set(seen.filter(i => i.fix).map(i => i.rule))
  assert.equal(fixable.size, 13)
  for (const id of fixable) assert.equal(typeof EN[`preflight.${id}.fix`], 'string', id + '.fix')
  for (const key of Object.keys(EN).filter(k => /^(preflight|diag)\./.test(k))) assert.match(key, /^(preflight|diag)\.[a-z-]+(\.fix)?$/)
  for (const i of seen) {
    for (const key of [i.msg, ...(i.fix ? [`preflight.${i.rule}.fix`] : [])]) {
      for (const [, v] of EN[key].matchAll(/\{(\w+)\}/g)) assert.ok(v in i.vars, `${key} needs {${v}}`)
    }
  }
})
