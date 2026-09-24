import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse } from '../src/model/markdown.js'
import { defaultLayout, normalizeLayout } from '../src/model/layout.js'
import { extractText, extractFields, allContacts } from '../src/preflight/ats.js'

const sample = JSON.parse(readFileSync(new URL('../samples/sample.cv.json', import.meta.url))).content
const doc = parse(sample)

const SAMPLE_TEXT = `Alex Morgan
Senior Software Engineer · Developer Tools
alex.morgan@example.com · +1 415 555 0142 · alexmorgan.dev · github.com/alexmorgan · San Francisco, CA

Summary
Product-minded engineer with 8 years of experience building developer tools and web platforms. Happiest with fast feedback loops, boring infrastructure and interfaces that explain themselves.

Experience
Senior Software Engineer, Lumen Labs | Mar 2022 – Present | San Francisco, CA
- Led the rebuild of the build pipeline, cutting median CI time from 18 to 6 minutes
- Designed a plugin API now used by 40+ internal teams
- Mentored five engineers; two promoted to senior
Software Engineer, Northwind Analytics | Jun 2019 – Feb 2022 | Remote
- Shipped a query editor with live previews used by 12,000 analysts weekly
- Reduced dashboard load time by 60% by moving aggregation to materialized views
- Rewrote the on-call playbook and halved pages per week
Software Engineer, Contoso Retail | Jul 2016 – May 2019 | Seattle, WA
- Built the inventory sync service handling 2M updates per day
- Introduced contract tests between 14 services, catching breaking changes before deploy

Projects
Recto, Open source | 2026
- Text-first CV builder with a live paged canvas and ATS preflight
Tidewatch, Side project | 2023
- Tide and swell forecasts for surfers, 3,000 monthly users

Education
B.S. Computer Science, University of Washington | Sep 2012 – Jun 2016 | Seattle, WA

Skills
- Languages: TypeScript, Go, Python, SQL
- Web: React, Node.js, GraphQL, CSS
- Infrastructure: PostgreSQL, Kubernetes, Terraform, AWS

Languages
- English: Native
- Spanish: Professional working proficiency

Certifications
AWS Certified Solutions Architect – Associate, Amazon Web Services | Aug 2021`

const twoCol = (extra = {}) => normalizeLayout({
  grid: { columns: [{ id: 'main', width: 2 }, { id: 'side', width: 1 }], readingOrder: ['main', 'side'] },
  sections: { skills: { column: 'side' } },
  ...extra,
})

test('logical extractText of the sample', () => {
  const text = extractText(doc, defaultLayout())
  assert.deepEqual(text.split('\n').slice(0, 6), [
    'Alex Morgan',
    'Senior Software Engineer · Developer Tools',
    'alex.morgan@example.com · +1 415 555 0142 · alexmorgan.dev · github.com/alexmorgan · San Francisco, CA',
    '',
    'Summary',
    'Product-minded engineer with 8 years of experience building developer tools and web platforms. Happiest with fast feedback loops, boring infrastructure and interfaces that explain themselves.',
  ])
  assert.equal(text, SAMPLE_TEXT)
})

test('logical order follows readingOrder: side column after every main section', () => {
  const text = extractText(doc, twoCol())
  const at = s => text.indexOf('\n' + s + '\n')
  assert.ok(at('Skills') > at('Certifications'))
  assert.ok(text.endsWith('- Infrastructure: PostgreSQL, Kubernetes, Terraform, AWS'))
  const flipped = extractText(doc, twoCol({ grid: { columns: [{ id: 'main', width: 2 }, { id: 'side', width: 1 }], readingOrder: ['side', 'main'] } }))
  assert.ok(flipped.indexOf('\nSkills\n') < flipped.indexOf('\nSummary\n'))
})

// Page 1: header, main (summary, first experience entry), side (skills); page 2: main (second entry).
const P = (page, colId, sectionId, line, kind) => ({ page, colId, sectionId, line, kind })
const placement = [
  P(1, null, null, 1, 'header'),
  P(1, 'main', 'summary', 5, 'title'), P(1, 'main', 'summary', 6, 'p'),
  P(1, 'main', 'experience', 8, 'title'), P(1, 'main', 'experience', 9, 'entry-head'),
  P(1, 'main', 'experience', 10, 'li'), P(1, 'main', 'experience', 11, 'li'), P(1, 'main', 'experience', 12, 'li'),
  P(1, 'side', 'skills', 30, 'title'), P(1, 'side', 'skills', 31, 'li'), P(1, 'side', 'skills', 32, 'li'), P(1, 'side', 'skills', 33, 'li'),
  P(2, 'main', 'experience', 13, 'entry-head'), P(2, 'main', 'experience', 14, 'li'),
]

test('with placement: stream order, side of page 1 before main of page 2', () => {
  const text = extractText(doc, twoCol(), placement)
  assert.equal(text, `${SAMPLE_TEXT.split('\n').slice(0, 13).join('\n')}

Skills
- Languages: TypeScript, Go, Python, SQL
- Web: React, Node.js, GraphQL, CSS
- Infrastructure: PostgreSQL, Kubernetes, Terraform, AWS

Software Engineer, Northwind Analytics | Jun 2019 – Feb 2022 | Remote
- Shipped a query editor with live previews used by 12,000 analysts weekly`)
  assert.ok(!text.includes('--- page'))
  // the ATS panel renders one page at a time by filtering the placement
  assert.equal(extractText(doc, twoCol(), placement.filter(p => p.page === 2)),
    'Software Engineer, Northwind Analytics | Jun 2019 – Feb 2022 | Remote\n- Shipped a query editor with live previews used by 12,000 analysts weekly')
  // stale placement lines are skipped, never thrown on
  assert.equal(extractText(doc, twoCol(), [P(1, 'main', 'x', 999, 'p')]), '')
})

test('tags variant: one line per item, chips joined with TAG_SEP (list atom or logical)', () => {
  const layout = twoCol({ sectionDefaults: { skills: { variant: 'tags' } } })
  const want = 'Skills\nLanguages: TypeScript · Go · Python · SQL\nWeb: React · Node.js · GraphQL · CSS\nInfrastructure: PostgreSQL · Kubernetes · Terraform · AWS'
  assert.ok(extractText(doc, layout).endsWith('\n\n' + want))
  assert.equal(extractText(doc, layout, [P(1, 'side', 'skills', 30, 'title'), P(1, 'side', 'skills', 31, 'list')]), want)
  assert.equal(extractText(parse('# N\n## Skills\n- Go, Rust'), normalizeLayout({ sectionDefaults: { skills: { variant: 'tags' } } })), 'N\n\nSkills\nGo · Rust')
})

test('titles, rules, hidden sections, labels and hard breaks', () => {
  const d = parse('# N\nEmail: n@x.dev · Berlin\n## \nUntitled para\n## Kept {#k}\nline one\\\nline two\n---\n## Gone\n- x\n## Quiet\n- y')
  const layout = normalizeLayout({ sections: { gone: { hidden: true }, quiet: { showTitle: false } } })
  const text = extractText(d, layout)
  assert.equal(text, 'N\nEmail: n@x.dev · Berlin\n\nUntitled para\n\nKept\nline one\nline two\n\n- y')
  assert.equal(extractText(parse(''), defaultLayout()), '')
  assert.equal(extractText(parse('## A\n### | Org | 2020'), {}), 'A\nOrg | 2020')
})

test('extractFields of the sample', () => {
  const f = extractFields(doc, defaultLayout())
  assert.equal(f.name, 'Alex Morgan')
  assert.equal(f.label, 'Senior Software Engineer · Developer Tools')
  assert.deepEqual(f.emails, ['alex.morgan@example.com'])
  assert.deepEqual(f.phones, ['+1 415 555 0142'])
  assert.deepEqual(f.urls, ['https://alexmorgan.dev', 'https://github.com/alexmorgan'])
  assert.equal(f.location, 'San Francisco, CA')
  assert.deepEqual(f.sections.map(s => s.category), ['summary', 'experience', 'projects', 'education', 'skills', 'languages', 'certifications'])
  const exp = f.sections.find(s => s.id === 'experience')
  assert.equal(exp.title, 'Experience')
  assert.equal(exp.entries.length, 3)
  assert.deepEqual(exp.entries[0], {
    title: 'Senior Software Engineer', org: 'Lumen Labs', start: '2022-03', end: null, current: true, location: 'San Francisco, CA',
    bullets: ['Led the rebuild of the build pipeline, cutting median CI time from 18 to 6 minutes', 'Designed a plugin API now used by 40+ internal teams', 'Mentored five engineers; two promoted to senior'],
  })
  assert.equal(exp.entries[1].end, '2022-02')
  assert.equal(f.sections.find(s => s.id === 'projects').entries[0].start, '2026')
  const empty = extractFields(parse(''), {})
  assert.deepEqual(empty, { name: '', label: '', emails: [], phones: [], urls: [], location: '', sections: [] })
})

test('allContacts: header first, then contact sections', () => {
  const d = parse('# N\na@b.dev\n## Contact\n- +49 151 0000000\n## Skills\n- b@c.dev')
  assert.deepEqual(allContacts(d, 'en').map(c => c.kind), ['email', 'phone'])
  assert.deepEqual(allContacts(parse('## Kontakt\n- x@y.dev'), 'de').map(c => c.text), ['x@y.dev'])
})
