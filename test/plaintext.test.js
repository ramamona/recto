import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse, inlineText } from '../src/model/markdown.js'
import { normalizeLayout } from '../src/model/layout.js'
import { extractText } from '../src/preflight/ats.js'
import { fromPlainText } from '../src/io/plaintext.js'

const md = (text, lang) => fromPlainText(text, lang).content
const ymd = p => p ? (p.m ? `${p.y}-${String(p.m).padStart(2, '0')}` : String(p.y)) : 'now'
const range = r => r ? `${ymd(r.start)}..${r.current ? 'now' : ymd(r.end)}` : null
const entries = doc => doc.sections.flatMap(s => s.blocks.filter(b => b.type === 'entry').map(e => ({
  section: s.id, title: inlineText(e.title), org: inlineText(e.org), date: range(e.dateRange), location: e.location,
})))

// Converts, asserts a clean parse and returns the doc.
function convert(text, lang = 'en') {
  const { content, notes } = fromPlainText(text, lang)
  const doc = parse(content)
  assert.deepEqual(doc.diagnostics, [], content)
  assert.ok(Array.isArray(notes))
  return { doc, content, notes }
}

test('(1) classic US résumé: Title, Company | City | Jan 2020 – Present', () => {
  const { doc } = convert(`JOHN SMITH
Senior Product Manager
john.smith@gmail.com | (555) 123-4567 | linkedin.com/in/johnsmith
San Francisco, CA

PROFESSIONAL SUMMARY
Product leader with 10 years of experience shipping B2B software.

EXPERIENCE
Senior Product Manager, Stripe | San Francisco, CA | Jan 2020 – Present
• Launched invoicing to 50k merchants
• Grew activation 25% through onboarding experiments
Product Manager, Dropbox | San Francisco, CA | Jun 2016 – Dec 2019
• Owned the sharing roadmap

EDUCATION
MBA, Stanford University | Stanford, CA | 2014 – 2016
B.A. Economics, UC Berkeley | Berkeley, CA | 2008 – 2012

SKILLS
Product: roadmapping, discovery, pricing
Tools: SQL, Figma, Amplitude`)
  assert.equal(doc.header.name, 'JOHN SMITH')
  assert.deepEqual(doc.header.taglines.map(t => inlineText(t.inlines)), ['Senior Product Manager'])
  assert.deepEqual(doc.header.contacts.map(c => c.kind), ['email', 'phone', 'url', 'text'])
  assert.deepEqual(doc.sections.map(s => s.id), ['professional-summary', 'experience', 'education', 'skills'])
  assert.deepEqual(entries(doc), [
    { section: 'experience', title: 'Senior Product Manager', org: 'Stripe', date: '2020-01..now', location: 'San Francisco, CA' },
    { section: 'experience', title: 'Product Manager', org: 'Dropbox', date: '2016-06..2019-12', location: 'San Francisco, CA' },
    { section: 'education', title: 'MBA', org: 'Stanford University', date: '2014..2016', location: 'Stanford, CA' },
    { section: 'education', title: 'B.A. Economics', org: 'UC Berkeley', date: '2008..2012', location: 'Berkeley, CA' },
  ])
  const work = doc.sections[1].blocks[0]
  assert.deepEqual(work.blocks[0].items.map(i => inlineText(i.inlines)), ['Launched invoicing to 50k merchants', 'Grew activation 25% through onboarding experiments'])
  const skills = doc.sections[3].blocks[0]
  assert.deepEqual(skills.items.map(i => i.inlines[0].t), ['strong', 'strong'])
  assert.deepEqual(skills.items.map(i => inlineText(i.inlines)), ['Product: roadmapping, discovery, pricing', 'Tools: SQL, Figma, Amplitude'])
})

test('(2) two-line entries: Company line, then Title + dates', () => {
  const { doc, notes } = convert(`Maria Garcia
maria@garcia.io · +34 600 123 456

Experience
Globant
Frontend Developer   Mar 2018 – Aug 2021
- Built a design system used by 30 teams
Accenture
Junior Developer, 2016 – 2018
- Maintained internal portals

Education
Universidad de Sevilla
Bachelor of Computer Science 2012 – 2016`)
  assert.equal(doc.header.name, 'Maria Garcia')
  assert.deepEqual(doc.header.contacts.map(c => c.kind), ['email', 'phone'])
  assert.deepEqual(doc.sections.map(s => s.id), ['experience', 'education'])
  assert.deepEqual(entries(doc).map(({ title, org, date }) => ({ title, org, date })), [
    { title: 'Frontend Developer', org: 'Globant', date: '2018-03..2021-08' },
    { title: 'Junior Developer', org: 'Accenture', date: '2016..2018' },
    { title: 'Bachelor of Computer Science', org: 'Universidad de Sevilla', date: '2012..2016' },
  ])
  assert.ok(notes.some(n => n.code === 'guessed-entry'))
})

test('(3) German Lebenslauf: Berufserfahrung, 03/2019 – heute', () => {
  const { doc } = convert(`Lebenslauf
Max Mustermann
E-Mail: max@mustermann.de
Telefon: +49 170 1234567
Adresse: Hauptstraße 1, 10115 Berlin

Berufserfahrung
Softwareentwickler | Siemens AG | 03/2019 – heute | München
▪ Entwicklung von Microservices
▪ Betreuung von zwei Werkstudenten
Werkstudent | SAP SE | 10/2016 - 02/2019 | Walldorf

Ausbildung
M.Sc. Informatik, TU München, 2014 – 2016

Sprachen
Deutsch: Muttersprache
Englisch: fließend`, 'de')
  assert.equal(doc.header.name, 'Max Mustermann')
  assert.deepEqual(doc.header.contacts.map(c => [c.kind, c.label]), [['email', 'E-Mail'], ['phone', 'Telefon'], ['text', 'Adresse']])
  assert.deepEqual(doc.sections.map(s => s.id), ['berufserfahrung', 'ausbildung', 'sprachen'])
  assert.deepEqual(entries(doc), [
    { section: 'berufserfahrung', title: 'Softwareentwickler', org: 'Siemens AG', date: '2019-03..now', location: 'München' },
    { section: 'berufserfahrung', title: 'Werkstudent', org: 'SAP SE', date: '2016-10..2019-02', location: 'Walldorf' },
    { section: 'ausbildung', title: 'M.Sc. Informatik', org: 'TU München', date: '2014..2016', location: '' },
  ])
  assert.deepEqual(doc.sections[2].blocks[0].items.map(i => inlineText(i.inlines)), ['Deutsch: Muttersprache', 'Englisch: fließend'])
})

test('(4) right-aligned dates after a two-space gap (extractor output)', () => {
  const { doc } = convert(`Priya Patel
priya.patel@outlook.com  +1 206 555 0199  github.com/priyap

WORK EXPERIENCE

Staff Engineer  Amazon  Seattle, WA  2019 - now
• Led the migration of 200 services to ARM
Software Engineer  Microsoft  2015–2019
• Shipped Azure Functions cold-start improvements
Data Engineer, Stripe  Mar 2014 – Jan 2015
Dublin, Ireland
• Built the payments data pipeline

PROJECTS

Tidepool  2021
• Open-source tide forecasts`)
  assert.equal(doc.header.name, 'Priya Patel')
  assert.deepEqual(doc.header.contacts.map(c => c.kind), ['email', 'phone', 'url'])
  assert.deepEqual(doc.sections.map(s => s.id), ['work-experience', 'projects'])
  assert.deepEqual(entries(doc).map(({ title, org, date, location }) => ({ title, org, date, location })), [
    { title: 'Staff Engineer', org: 'Amazon', date: '2019..now', location: 'Seattle, WA' },
    { title: 'Software Engineer', org: 'Microsoft', date: '2015..2019', location: '' },
    { title: 'Data Engineer', org: 'Stripe', date: '2014-03..2015-01', location: 'Dublin, Ireland' },
    { title: 'Tidepool', org: '', date: '2021..2021', location: '' },
  ])
})

test('(5) LinkedIn export: Title / Company · Full-time / dates · duration / City', () => {
  const { doc } = convert(`Chen Wei
Engineering Manager at Shopify
chen.wei@example.com
www.linkedin.com/in/chenwei

Summary
I build teams that ship.

Experience
Engineering Manager
Shopify · Full-time
Jan 2020 - Present · 4 yrs 9 mos
Ottawa, Ontario, Canada
Grew the checkout team from 4 to 12 engineers.
Senior Developer
Kinaxis · Full-time
May 2015 - Dec 2019 · 4 yrs 8 mos
Kanata, Ontario

Education
Carleton University
Bachelor of Engineering, Software Engineering
2010 - 2015`)
  assert.equal(doc.header.name, 'Chen Wei')
  assert.deepEqual(doc.header.taglines.map(t => inlineText(t.inlines)), ['Engineering Manager at Shopify'])
  assert.deepEqual(doc.header.contacts.map(c => c.kind), ['email', 'url'])
  assert.deepEqual(doc.sections.map(s => s.id), ['summary', 'experience', 'education'])
  assert.deepEqual(entries(doc).map(({ title, org, date, location }) => ({ title, org, date, location })), [
    { title: 'Engineering Manager', org: 'Shopify', date: '2020-01..now', location: 'Ottawa, Ontario, Canada' },
    { title: 'Senior Developer', org: 'Kinaxis', date: '2015-05..2019-12', location: 'Kanata, Ontario' },
    { title: 'Bachelor of Engineering, Software Engineering', org: 'Carleton University', date: '2010..2015', location: '' },
  ])
  assert.equal(inlineText(doc.sections[1].blocks[0].blocks[0].inlines), 'Grew the checkout team from 4 to 12 engineers.')
})

test('(6) messy paste: ALL CAPS headings, ● bullets, wrapped lines, underlined headings', () => {
  const { doc, content } = convert(`\uFEFF  Sam O'Neil  \r
  sam@oneil.dev ·  07700 900123\r
\r
\r
PROFILE\r
Designer who codes. #1 at *everything* | snake_case [beta]\r
\r
WORK HISTORY\r
Lead Designer — Monzo — London — 2020 – Present\r
●  Redesigned the app onboarding flow, lifting conversion\r
   by 18% across all markets\r
● Hired and mentored 4 designers\r
1. Ran weekly design critiques\r
a) Wrote the accessibility guidelines\r
UX Designer at Deliveroo, 2017 - 2020\r
► Built the courier app prototype\r
\r
Tools\r
=====\r
Figma, Sketch, Framer, HTML, CSS\r
\r
INTERESTS\r
Climbing, cycling`)
  assert.equal(doc.header.name, "Sam O'Neil")
  assert.deepEqual(doc.header.contacts.map(c => c.kind), ['email', 'phone'])
  assert.deepEqual(doc.sections.map(s => s.id), ['profile', 'work-history', 'tools', 'interests'])
  assert.deepEqual(inlineText(doc.sections[0].blocks[0].inlines), 'Designer who codes. #1 at *everything* | snake_case [beta]')
  assert.deepEqual(entries(doc).map(({ title, org, date, location }) => ({ title, org, date, location })), [
    { title: 'Lead Designer', org: 'Monzo', date: '2020..now', location: 'London' },
    { title: 'UX Designer', org: 'Deliveroo', date: '2017..2020', location: '' },
  ])
  const [lead] = doc.sections[1].blocks
  assert.deepEqual(lead.blocks[0].items.map(i => inlineText(i.inlines)), [
    'Redesigned the app onboarding flow, lifting conversion by 18% across all markets',
    'Hired and mentored 4 designers', 'Ran weekly design critiques', 'Wrote the accessibility guidelines',
  ])
  assert.deepEqual(doc.sections[2].blocks[0].items.map(i => inlineText(i.inlines)), ['Figma, Sketch, Framer, HTML, CSS'])
  assert.ok(!content.includes('====='))
})

test('round trip: extractText(sample) → fromPlainText recovers name, sections and ≥ 90 % of entries', () => {
  const sample = JSON.parse(readFileSync(new URL('../samples/sample.cv.json', import.meta.url), 'utf8'))
  const original = parse(sample.content)
  const { doc } = convert(extractText(original, normalizeLayout(sample.layout)))
  assert.equal(doc.header.name, original.header.name)
  assert.deepEqual(doc.header.contacts.map(c => c.text), original.header.contacts.map(c => c.text))
  assert.deepEqual(doc.sections.map(s => s.title), original.sections.map(s => s.title))
  const key = e => `${e.section}|${e.title}|${e.org}|${e.date}`
  const got = new Set(entries(doc).map(key))
  const want = entries(original)
  assert.ok(want.length >= 7)
  const hits = want.filter(e => got.has(key(e))).length
  assert.ok(hits / want.length >= 0.9, `${hits}/${want.length}: ${[...got].join('\n')}`)
})

test('notes: guessed name, unsplit entry, no sections, no contacts', () => {
  const codes = text => fromPlainText(text).notes.map(n => n.code)
  assert.deepEqual(codes('Curriculum Vitae\nJane Doe\njane@doe.dev\n\nExperience\nLonelytitleline 2019 – 2020'), ['guessed-name', 'unsplit-entry'])
  assert.deepEqual(codes('Résumé\nJane Doe\njane@doe.dev\nSkills\nGo'), ['guessed-name'])
  assert.deepEqual(codes('Jane Doe\nJust some text here'), ['no-contacts', 'no-sections'])
  const { content, notes } = fromPlainText('Jane Doe\njane@doe.dev\nExperience\nSomething 2019 – 2020')
  assert.equal(content.split('\n')[notes[0].line - 1], '### Something | | 2019 – 2020')
})

test('headings: dictionary words in any case, ALL CAPS up to 5 words, underlined lines', () => {
  const { doc } = convert('N\nn@n.dev\nberufserfahrung:\nI LOVE WRITING VERY LOUD LINES\nSKILLS & TOOLS FOR JOBS\nAWS, GCP, SQL\nMy Stack\n--------\nGo', 'de')
  assert.deepEqual(doc.sections.map(s => s.title), ['berufserfahrung', 'SKILLS & TOOLS FOR JOBS', 'My Stack'])
})

test('contacts only among the first 8 lines, before any heading', () => {
  assert.deepEqual(parse(md('N\nSKILLS\nx@y.dev   +1 555 555 5555')).header.contacts, [])
  assert.deepEqual(parse(md('N\na\nb\nc\nd\ne\nf\ng\nx@y.dev   +1 555 555 5555')).header.contacts.length, 0)
  assert.equal(md('N\na\nx@y.dev   +1 555 555 5555'), '# N\na\nx@y.dev · +1 555 555 5555\n')
})

test('markup characters in pasted text stay literal', () => {
  const line = '#1 in sales, 5* reviews, snake_case [beta] a|b `x` back\\slash'
  const { doc } = convert(`N\nn@n.dev\nSUMMARY\n${line}\n● *starred* bullet\n- ### not an entry`)
  const [p, list] = doc.sections[0].blocks
  assert.equal(inlineText(p.inlines), line)
  assert.deepEqual(list.items.map(i => inlineText(i.inlines)), ['*starred* bullet', '### not an entry'])
})

test('empty input', () => {
  for (const v of ['', ' \n\t\n', null]) assert.deepEqual(fromPlainText(v), { content: '', notes: [] })
})
