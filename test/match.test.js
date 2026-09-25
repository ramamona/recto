import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse } from '../src/model/markdown.js'
import { defaultLayout } from '../src/model/layout.js'
import { matchCv } from '../src/jobs/match.js'
import { parseJob } from '../src/jobs/parse.js'

const sample = JSON.parse(readFileSync(new URL('../samples/sample.cv.json', import.meta.url)))
const cv = (source, layout = sample.layout) => ({ source, doc: parse(source), layout })

const JD = `Senior Software Engineer
Company: Lumenary

Requirements
- Strong TypeScript and React
- Experience with Postgres and k8s
- Experience with Kafka
- Mentoring junior engineers

Nice to have
- Terraform
- Rust
- Stakeholder management`

test('sample CV against an overlapping JD: bands, missing with targets, present with lines', () => {
  const r = matchCv(cv(sample.content), parseJob(JD))
  // must: TypeScript React PostgreSQL Kubernetes Kafka Mentoring (6 x 2), nice: Terraform Rust Stakeholder management (3 x 1)
  assert.equal(r.bands.keywords.score, Math.round(100 * (10 + 1) / 15))
  assert.equal(r.bands.requirements.score, 75)
  assert.equal(r.bands.essentials.score, 100)
  assert.deepEqual(Object.fromEntries(Object.entries(r.bands).map(([k, b]) => [k, b.weight])), { keywords: 55, requirements: 20, parseability: 15, essentials: 10 })
  assert.deepEqual(r.missing, [
    { keyword: 'Kafka', kind: 'must', where: 'skills' },
    { keyword: 'Rust', kind: 'nice', where: 'skills' },
    { keyword: 'Stakeholder management', kind: 'nice', where: 'experience' }
  ])
  const pg = r.present.find(p => p.keyword === 'PostgreSQL')
  const lines = sample.content.split('\n')
  assert.ok(pg.lines.length && pg.lines.every(n => lines[n - 1].includes('PostgreSQL')))
  assert.ok(r.present.find(p => p.keyword === 'Mentoring').lines.length, 'stemming: Mentored ~ Mentoring')
  const b = r.bands
  assert.equal(r.score, Math.round((b.keywords.score * 55 + b.requirements.score * 20 + b.parseability.score * 15 + b.essentials.score * 10) / 100))
  assert.ok(r.score >= 0 && r.score <= 100)
})

test('aliases: JS/JavaScript, k8s/Kubernetes, Postgres/PostgreSQL both ways', () => {
  const src = '# Sam\nsam@x.dev\n\n## Skills\n- JavaScript, k8s, Postgres, CI/CD\n'
  const r = matchCv(cv(src), parseJob('Requirements\n- JS\n- Kubernetes\n- PostgreSQL\n- Continuous integration'))
  assert.deepEqual(r.missing, [])
  assert.deepEqual(r.present.map(p => p.keyword), ['JavaScript', 'Kubernetes', 'PostgreSQL', 'CI/CD'])
  assert.ok(r.present.every(p => p.lines[0] === 5))
})

test('only text an ATS reads counts: hidden sections do not match', () => {
  const src = '# Sam\n\n## Skills\n- Kafka\n'
  const layout = { sections: { skills: { hidden: true } } }
  assert.equal(matchCv(cv(src), parseJob('Requirements\n- Kafka')).missing.length, 0)
  assert.equal(matchCv(cv(src, layout), parseJob('Requirements\n- Kafka')).missing.length, 1)
})

test('adding a missing keyword raises the score', () => {
  const job = parseJob(JD)
  const before = matchCv(cv(sample.content), job).score
  const after = matchCv(cv(sample.content.replace('Terraform, AWS', 'Terraform, AWS, Kafka')), job).score
  assert.ok(after > before, `${after} > ${before}`)
})

test('parseability drops with preflight errors, warnings and multi-column', () => {
  const base = cv(sample.content)
  const clean = matchCv({ ...base, issues: [] }, parseJob(JD)).bands.parseability.score
  const bad = matchCv({ ...base, issues: [{ rule: 'missing-name', severity: 'error' }, { rule: 'multi-column', severity: 'warn' }, { rule: 'nonstandard-heading', severity: 'info' }] }, parseJob(JD)).bands.parseability.score
  assert.equal(clean, 100)
  assert.ok(bad < clean)
})

test('essentials: missing contact and title mismatch lower the band', () => {
  const r = matchCv(cv('# Sam\n\n## Experience\n### Baker | Bakery | 2020 – 2021\n'), parseJob('Senior Software Engineer\nRequirements\n- Go'))
  assert.ok(r.bands.essentials.score < 50)
})

test('a raw Job (text only) is parsed; empty CV and empty JD never throw', () => {
  assert.equal(matchCv(cv(sample.content), { text: JD }).missing.length, 3)
  for (const [c, j] of [[cv(''), parseJob('')], [cv(sample.content), {}], [{ source: '', doc: parse('') }, null]]) {
    const r = matchCv(c, j)
    assert.ok(r.score >= 0 && r.score <= 100)
    assert.deepEqual(r.missing, [])
  }
})
