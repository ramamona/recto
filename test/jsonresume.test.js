import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse, inlineText } from '../src/model/markdown.js'
import { defaultLayout, normalizeLayout } from '../src/model/layout.js'
import { toJsonResume, fromJsonResume } from '../src/io/jsonresume.js'

const sample = JSON.parse(readFileSync(new URL('../samples/sample.cv.json', import.meta.url))).content
const foreign = JSON.parse(readFileSync(new URL('./fixtures/jsonresume-foreign.json', import.meta.url)))
const layout = normalizeLayout({ page: { targetPages: 2 } })
const withoutMeta = ({ meta, ...rest }) => rest
const clone = o => JSON.parse(JSON.stringify(o))
const codes = warnings => warnings.map(w => w.code)

test('exports the sample', () => {
  const { json, warnings } = toJsonResume({ content: sample, layout })
  assert.deepEqual(warnings, [])
  const b = json.basics
  assert.equal(b.name, 'Alex Morgan')
  assert.equal(b.label, 'Senior Software Engineer · Developer Tools')
  assert.equal(b.email, 'alex.morgan@example.com')
  assert.equal(b.phone, '+1 415 555 0142')
  assert.equal(b.url, 'https://alexmorgan.dev')
  assert.deepEqual(b.location, { city: 'San Francisco', region: 'CA' })
  assert.equal(b.profiles[0].network, 'GitHub')
  assert.deepEqual(b.profiles, [{ network: 'GitHub', username: 'alexmorgan', url: 'https://github.com/alexmorgan' }])
  assert.match(b.summary, /^Product-minded engineer .* explain themselves\.$/)

  assert.equal(json.work.length, 3)
  assert.deepEqual(json.work[0], {
    position: 'Senior Software Engineer', name: 'Lumen Labs', location: 'San Francisco, CA', startDate: '2022-03',
    highlights: ['Led the rebuild of the build pipeline, cutting median CI time from 18 to 6 minutes', 'Designed a plugin API now used by 40+ internal teams', 'Mentored five engineers; two promoted to senior'],
  })
  assert.equal(json.work[0].highlights.length, 3)
  assert.ok(!('endDate' in json.work[0]))
  assert.equal(json.work[1].endDate, '2022-02')
  assert.deepEqual(json.skills[0], { name: 'Languages', keywords: ['TypeScript', 'Go', 'Python', 'SQL'] })
  assert.deepEqual(json.languages[0], { language: 'English', fluency: 'Native' })
  assert.deepEqual(json.education, [{ area: 'B.S. Computer Science', institution: 'University of Washington', startDate: '2012-09', endDate: '2016-06', courses: [] }])
  assert.deepEqual(json.projects[0], { name: 'Recto', entity: 'Open source', startDate: '2026', endDate: '2026', highlights: ['Text-first CV builder with a live paged canvas and ATS preflight'] })
  assert.deepEqual(json.certificates, [{ name: 'AWS Certified Solutions Architect – Associate', issuer: 'Amazon Web Services', date: '2021-08' }])
  assert.equal(json.meta.recto.content, sample)
  assert.deepEqual(json.meta.recto.layout, layout)
})

test('round trip through meta.recto is exact', () => {
  const { json } = toJsonResume({ content: sample, layout })
  for (const input of [json, clone(json), JSON.stringify(json)]) {
    const r = fromJsonResume(input)
    assert.equal(r.content, sample)
    assert.deepEqual(r.layout, layout)
    assert.deepEqual(r.warnings, [])
  }
})

test('edited outside Recto: rebuilt from fields, layout kept, warned', () => {
  const json = clone(toJsonResume({ content: sample, layout }).json)
  json.work[0].position = 'Principal Engineer'
  const r = fromJsonResume(json)
  assert.deepEqual(codes(r.warnings), ['edited-outside'])
  assert.deepEqual(r.layout, layout)
  assert.ok(r.content.includes('\n### Principal Engineer | Lumen Labs | Mar 2022 – Present | San Francisco, CA\n'))
  assert.deepEqual(parse(r.content).diagnostics, [])
  assert.equal(toJsonResume(r).json.work[0].position, 'Principal Engineer')
})

test('rebuilding from fields alone reproduces the same JSON Resume', () => {
  const fields = withoutMeta(toJsonResume({ content: sample, layout }).json)
  const r = fromJsonResume(fields)
  assert.deepEqual(r.warnings, [])
  assert.deepEqual(r.layout, defaultLayout())
  assert.deepEqual(r.content.split('\n').slice(0, 3), sample.split('\n').slice(0, 3))
  assert.deepEqual(parse(r.content).diagnostics, [])
  assert.deepEqual(withoutMeta(toJsonResume(r).json), fields)
})

test('imports a foreign JSON Resume: v0 aliases, markup characters survive', () => {
  const r = fromJsonResume(foreign)
  assert.deepEqual(r.warnings, [])
  assert.deepEqual(r.layout, defaultLayout())
  const doc = parse(r.content)
  assert.deepEqual(doc.diagnostics, [])
  assert.equal(doc.header.name, '# Jane Doe')
  assert.deepEqual(doc.header.contacts.map(c => [c.kind, c.text]), [
    ['email', 'jane_doe@example.com'], ['phone', '+49 151 0000000'], ['url', 'janedoe.dev'], ['url', 'github.com/janedoe'], ['text', 'Berlin, DE'],
  ])
  assert.deepEqual(doc.sections.map(s => s.title), ['Summary', 'Experience', 'Education', 'Projects', 'Awards', 'Skills', 'Languages'])
  const job = doc.sections[1].blocks[0]
  assert.equal(inlineText(job.org), 'Acme | Corp')
  assert.deepEqual(job.blocks[1].items.map(i => inlineText(i.inlines)),
    ['Cut deploy time with *stars* and a | b', 'Multi line highlight', '- starts like a bullet', 'ends with a backslash \\'])

  const { json } = toJsonResume(r)
  assert.equal(json.basics.name, '# Jane Doe')
  assert.equal(json.basics.summary, foreign.basics.summary)
  assert.equal(json.basics.url, 'https://janedoe.dev')
  assert.deepEqual(json.basics.location, { city: 'Berlin', region: 'DE' })
  assert.deepEqual(json.work, [{
    position: 'Staff Engineer', name: 'Acme | Corp', url: 'https://acme.example.com', startDate: '2021-01', summary: 'Led the platform group.',
    highlights: ['Cut deploy time with *stars* and a | b', 'Multi line highlight', '- starts like a bullet', 'ends with a backslash \\'],
  }])
  assert.deepEqual(json.education, [{ area: 'MSc, Computer Science', institution: 'TU Berlin', startDate: '2012', endDate: '2014', courses: ['Distributed_systems'] }])
  assert.deepEqual(json.skills, [{ name: 'Languages', keywords: ['Go', 'Rust'] }, { name: 'Web', level: 'Expert', keywords: ['React'] }])
  assert.deepEqual(json.languages, [{ language: 'German', fluency: 'Native' }])
  assert.deepEqual(json.projects, [{ name: 'Recto', description: 'CV builder', highlights: ['Zero deps'], url: 'https://example.com/recto' }])
  assert.deepEqual(json.awards, [{ title: 'Best `code`', awarder: 'ACM', date: '2019-05', summary: 'For **not** shipping.' }])
})

test('paragraph lines that look like Markdown blocks stay text', () => {
  const summary = '# not a name\n## not a section\n- not a bullet\n• nor this\n* nor this\n---'
  const doc = parse(fromJsonResume({ basics: { name: 'N', summary } }).content)
  assert.deepEqual(doc.diagnostics, [])
  assert.deepEqual(doc.sections.map(s => s.title), ['Summary'])
  assert.deepEqual(doc.sections[0].blocks.map(b => [b.type, inlineText(b.inlines)]), summary.split('\n').map(l => ['paragraph', l]))
})

test('bare URLs in imported text stay unescaped so they still autolink', () => {
  const r = fromJsonResume({ work: [{ position: 'P', highlights: ['See https://x.dev/a_b_c and *c*'] }] })
  const [item] = parse(r.content).sections[0].blocks[0].blocks[0].items
  assert.equal(inlineText(item.inlines), 'See https://x.dev/a_b_c and *c*')
  assert.equal(item.inlines.find(n => n.t === 'link').href, 'https://x.dev/a_b_c')
})

test('export warnings: unparseable dates, unmapped and contact sections; hidden sections skipped', () => {
  const content = '# N\nlinkedin.com/in/jane · https://jane.example.com/ · [Mail me](mailto:a@b.dev)\n## Experience\n### A | B | sometime\n## Hobbies stuff\n- x\n## Contact\n- c@d.dev\n## Awards\n### Prize'
  const { json, warnings } = toJsonResume({ content, layout: { sections: { awards: { hidden: true } } } })
  assert.deepEqual(warnings, [
    { code: 'unparseable-date', vars: { title: 'A', date: 'sometime' } },
    { code: 'section-not-exported', vars: { section: 'Hobbies stuff' } },
    { code: 'section-not-exported', vars: { section: 'Contact' } },
  ])
  assert.deepEqual(json.work, [{ position: 'A', name: 'B', highlights: [] }])
  assert.equal(json.basics.email, 'a@b.dev') // the link's address, not its text
  assert.equal(toJsonResume({ content: '# N\n## Contact\n- c@d.dev' }).json.basics.email, 'c@d.dev')
  assert.equal(json.basics.url, 'https://jane.example.com/')
  assert.deepEqual(json.basics.profiles, [{ network: 'LinkedIn', username: 'jane', url: 'https://linkedin.com/in/jane' }])
  assert.ok(!('awards' in json))
})

test('degenerate and hostile input never throws', () => {
  const { json, warnings } = toJsonResume({ content: '', layout: {} })
  assert.deepEqual(warnings, [])
  assert.equal(json.meta.recto.content, '')
  assert.deepEqual(json.meta.recto.layout, defaultLayout())
  assert.doesNotThrow(() => toJsonResume())
  assert.doesNotThrow(() => toJsonResume({ content: 42, layout: 'x' }))
  for (const bad of [undefined, null, 'not json', '[]', 42, [], { basics: 'x', work: [null, 5, { position: 7, highlights: 'x', startDate: 'soon' }], skills: {} },
    { meta: { recto: { content: 5 } } }, { meta: { recto: { content: '# A', layout: 'x' } }, basics: { name: 'B' } }]) {
    const r = fromJsonResume(bad)
    assert.equal(typeof r.content, 'string')
    assert.deepEqual(parse(r.content).diagnostics.filter(d => d.code !== 'unparseable-date'), [])
    assert.ok(Array.isArray(r.warnings))
    assert.equal(r.layout.version, 1)
  }
  assert.deepEqual(codes(fromJsonResume('not json').warnings), ['invalid-file'])
  assert.deepEqual(codes(fromJsonResume({ work: [{ position: 'P', startDate: 'soon' }] }).warnings), ['unparseable-date'])
})
