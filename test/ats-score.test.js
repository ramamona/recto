import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { atsReport, GRADE } from '../src/ats/score.js'
import { runPreflight } from '../src/preflight/rules.js'
import { parse } from '../src/model/markdown.js'
import { defaultLayout, normalizeLayout } from '../src/model/layout.js'

const NOW = new Date(2026, 8, 15)
const SAMPLE = JSON.parse(readFileSync(new URL('../samples/sample.cv.json', import.meta.url), 'utf8')).content
const IDS = ['text', 'headings', 'contact', 'order', 'entries', 'chars', 'hidden', 'length']
const report = (o = {}) => ({ pageCount: 1, targetPages: 1, lastPageFill: 0.6, flags: [], textStyles: [], fontsMissing: [], pages: [{ columnsWithText: ['main'] }], ...o })

function run (source, { layout = defaultLayout(), report = null, placement = null, issues } = {}) {
  const doc = parse(source)
  issues ??= runPreflight({ source, doc, layout, report, placement, now: NOW })
  return atsReport({ source, doc, layout, report, placement, issues })
}
const check = (r, id) => r.checks.find(c => c.id === id)
const lost = (r, id) => check(r, id).weight - check(r, id).earned
const lines = (src, map) => src.split('\n').map((l, i) => map(l, i + 1)).filter(l => l != null).join('\n')

test('GRADE bands', () => {
  assert.deepEqual([100, 90, 89, 80, 79, 70, 69, 60, 59, 0].map(GRADE), ['A', 'A', 'B', 'B', 'C', 'C', 'D', 'D', 'F', 'F'])
})

test('sample CV with the default layout: grade A, every check reported, weights sum to 100', () => {
  const r = run(SAMPLE, { report: report() })
  assert.deepEqual(r.checks.map(c => c.id), IDS)
  assert.equal(r.checks.reduce((s, c) => s + c.weight, 0), 100)
  assert.ok(r.score >= 90, `score ${r.score}`)
  assert.equal(r.grade, 'A')
  assert.equal(r.score, r.checks.reduce((s, c) => s + c.earned, 0))
  for (const c of r.checks) {
    assert.ok(c.earned >= 0 && c.earned <= c.weight, c.id)
    for (const i of c.items) assert.ok(['critical', 'warning', 'info'].includes(i.severity) && typeof i.msg === 'string')
  }
})

test('removing Education deducts from headings', () => {
  const r = run(lines(SAMPLE, (l, n) => n >= 27 && n <= 29 ? null : l))
  assert.equal(lost(r, 'headings'), 6 - 3)
  assert.ok(check(r, 'headings').items.some(i => i.msg === 'ats.headings.missing' && i.vars.section === 'education'))
  assert.equal(r.fields.education.length, 0)
  assert.equal(r.fields.missing.education, 'no-section')
})

test('non-standard heading deducts 2 (max 6) and links the preflight issue; optional sections add a capped bonus', () => {
  const r = run(SAMPLE.replace('## Skills', '## My Toolbox'))
  assert.equal(lost(r, 'headings'), 6 + 2 - 3) // missing skills, non-standard heading, +1 each for Summary/Projects/Certifications
  const i = check(r, 'headings').items.find(i => i.msg === 'preflight.nonstandard-heading')
  assert.equal(i.line, 30)
  assert.equal(i.severity, 'info')
})

test('no email: critical item and contact deduction', () => {
  const r = run(SAMPLE.replace('alex.morgan@example.com · ', ''))
  assert.equal(lost(r, 'contact'), 8)
  assert.ok(check(r, 'contact').items.some(i => i.severity === 'critical'))
  assert.equal(r.fields.email, '')
  assert.equal(r.fields.missing.email, 'not-found')
})

test('two columns with text in both: order −10', () => {
  const layout = normalizeLayout({
    grid: { columns: [{ id: 'main', width: 2 }, { id: 'side', width: 1 }], readingOrder: ['main', 'side'] },
    sections: { skills: { column: 'side' } },
  })
  const P = (page, colId, sectionId, line, kind) => ({ page, colId, sectionId, line, kind })
  const placement = [
    P(1, null, null, 1, 'header'),
    P(1, 'main', 'summary', 5, 'title'), P(1, 'main', 'summary', 6, 'p'),
    P(1, 'side', 'skills', 30, 'title'), P(1, 'side', 'skills', 31, 'li'),
  ]
  const r = run(SAMPLE, { layout, placement })
  assert.equal(lost(r, 'order'), 10)
  // header not first in the stream: another −5
  assert.equal(lost(run(SAMPLE, { layout, placement: [...placement.slice(1), placement[0]] }), 'order'), 15)
  // without placement the layout decides
  assert.equal(lost(run(SAMPLE, { layout }), 'order'), 10)
  assert.equal(lost(run(SAMPLE), 'order'), 0)
})

test('incomplete entry: entries deduction with a Locate line', () => {
  const r = run(SAMPLE.replace(' | Jun 2019 – Feb 2022 | Remote', ''))
  const c = check(r, 'entries')
  assert.equal(c.earned, Math.round(15 * 3 / 4))
  const item = c.items.find(i => i.line === 13)
  assert.ok(item)
  assert.equal(item.sectionId, 'experience')
  assert.deepEqual(item.vars.missing, ['start'])
})

test('custom font: chars info, −2', () => {
  const r = run(SAMPLE, { layout: normalizeLayout({ theme: { fontBody: 'font:Inter' } }) })
  assert.equal(lost(r, 'chars'), 2)
  assert.ok(check(r, 'chars').items.some(i => i.severity === 'info' && i.vars.family === 'Inter'))
})

test('invisible characters: chars deduction with the preflight fix', () => {
  const r = run(SAMPLE.replace('Lumen Labs', 'Lumen​ Labs'))
  const i = check(r, 'chars').items.find(i => i.msg === 'preflight.invisible-characters')
  assert.ok(i?.fix)
  assert.ok(lost(r, 'chars') > 0)
})

test('low-contrast error issue: hidden deduction', () => {
  const doc = parse(SAMPLE)
  const issues = [{ rule: 'low-contrast', severity: 'error', msg: 'preflight.low-contrast', vars: { ratio: 1.2, min: 4.5 }, line: 6, sectionId: 'summary', fix: { kind: 'layout', ops: [] } }]
  const r = atsReport({ source: SAMPLE, doc, layout: defaultLayout(), issues })
  assert.ok(lost(r, 'hidden') > 0)
  assert.deepEqual(check(r, 'hidden').items[0].fix, issues[0].fix)
  assert.equal(lost(run(SAMPLE, { issues: [{ ...issues[0], severity: 'warn' }] }), 'hidden'), 0)
})

test('text under 6 pt and hiding custom CSS: hidden deductions', () => {
  const tiny = run(SAMPLE, { report: report({ textStyles: [{ fontSizePt: 5, line: 6, sectionId: 'summary' }] }) })
  assert.ok(lost(tiny, 'hidden') > 0)
  const css = run(SAMPLE, { layout: normalizeLayout({ customCss: '.cv-summary { display: none }' }) })
  assert.ok(lost(css, 'hidden') > 0)
})

test('3 pages: length deduction', () => {
  assert.equal(lost(run(SAMPLE, { report: report({ pageCount: 3, targetPages: 1 }) }), 'length'), 2)
  assert.equal(lost(run(SAMPLE, { report: report({ pageCount: 2, targetPages: 2 }) }), 'length'), 0)
})

test('empty doc never throws: F with a critical text item', () => {
  const r = run('')
  assert.equal(r.grade, 'F')
  assert.ok(check(r, 'text').items.some(i => i.severity === 'critical'))
  assert.deepEqual(r.checks.map(c => c.id), IDS)
  assert.doesNotThrow(() => atsReport({}))
  assert.doesNotThrow(() => atsReport({ doc: parse(''), layout: defaultLayout(), report: {}, placement: [], issues: [] }))
})

test('fields: the mock applicant form for the sample', () => {
  const f = run(SAMPLE).fields
  assert.equal(f.name, 'Alex Morgan')
  assert.equal(f.email, 'alex.morgan@example.com')
  assert.equal(f.phone, '+1 415 555 0142')
  assert.equal(f.location, 'San Francisco, CA')
  assert.deepEqual(f.links.map(l => l.url), ['https://alexmorgan.dev', 'https://github.com/alexmorgan'])
  assert.equal(f.work.length, 3)
  assert.deepEqual(f.work[0], { title: 'Senior Software Engineer', company: 'Lumen Labs', start: '2022-03', end: null, current: true, location: 'San Francisco, CA', missing: [], line: 9, sectionId: 'experience' })
  assert.deepEqual(f.work.map(w => [w.start, w.end]), [['2022-03', null], ['2019-06', '2022-02'], ['2016-07', '2019-05']])
  assert.equal(f.education.length, 1)
  assert.equal(f.education[0].company, 'University of Washington')
  assert.deepEqual(f.skills, ['TypeScript', 'Go', 'Python', 'SQL', 'React', 'Node.js', 'GraphQL', 'CSS', 'PostgreSQL', 'Kubernetes', 'Terraform', 'AWS'])
  assert.deepEqual(f.missing, {})
})

test('fields: a missing org shows missing company', () => {
  const f = run(SAMPLE.replace('| Northwind Analytics |', '| |')).fields
  assert.deepEqual(f.work[1].missing, ['company'])
})

test('deterministic: same input, same output', () => {
  const a = run(SAMPLE, { report: report({ pageCount: 3 }) })
  const b = run(SAMPLE, { report: report({ pageCount: 3 }) })
  assert.deepEqual(a, b)
})
