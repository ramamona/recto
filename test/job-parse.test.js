import test from 'node:test'
import assert from 'node:assert/strict'
import { parseJob, keywordsIn } from '../src/jobs/parse.js'

export const JD_BACKEND = `Senior Backend Engineer
Company: Acme Robotics
Location: Berlin, Germany (Hybrid)
Posted on 2026-09-01

About the role
You will design and run the services behind our fleet dashboard.

Responsibilities
- Build APIs in Go and Python
- Own services running on Kubernetes

Requirements
- 5+ years of experience with Go or Python
- Must have strong PostgreSQL skills
- Experience with k8s and Docker
- Solid understanding of CI/CD

Nice to have
- Experience with Terraform
- Kafka is a plus

Salary: €70,000 – €90,000 per year`

const JD_FRONTEND = `Frontend Developer at Brightside
Remote (US)

What you'll need:
* 3 years building web apps in JavaScript and React
* TypeScript required
* GraphQL experience preferred
* Bonus: Storybook

Compensation
$120k - $150k

Date posted: Aug 15, 2026`

const JD_DATA = `Job title: Data Analyst
Company: Northwind Health
Location: Chicago, IL

Qualifications
1. Advanced SQL
2. Tableau or Power BI
3. Excel is required

Preferred Qualifications
- Python for data analysis
- Experience in healthcare

Pay: $35 - $45 an hour`

test('parses title, company, location, salary and date from labelled lines', () => {
  const j = parseJob(JD_BACKEND)
  assert.equal(j.title, 'Senior Backend Engineer')
  assert.equal(j.company, 'Acme Robotics')
  assert.equal(j.location, 'Berlin, Germany (Hybrid)')
  assert.equal(j.postedAt, '2026-09-01')
  assert.deepEqual({ ...j.salary, text: undefined }, { text: undefined, min: 70000, max: 90000, currency: 'EUR', period: 'year' })
})

test('Requirements are must, Nice to have is nice, bullets become requirements', () => {
  const j = parseJob(JD_BACKEND)
  const must = j.requirements.filter(r => r.kind === 'must').map(r => r.text)
  const nice = j.requirements.filter(r => r.kind === 'nice').map(r => r.text)
  assert.deepEqual(must, ['5+ years of experience with Go or Python', 'Must have strong PostgreSQL skills', 'Experience with k8s and Docker', 'Solid understanding of CI/CD'])
  assert.deepEqual(nice, ['Experience with Terraform', 'Kafka is a plus'])
  assert.deepEqual(j.requirements[2].keywords, ['Kubernetes', 'Docker'])
  for (const k of ['Go', 'Python', 'PostgreSQL', 'Kubernetes', 'Docker', 'CI/CD', 'Terraform', 'Kafka']) assert.ok(j.keywords.includes(k), k)
})

test('"at Company" title line, remote location, $k salary, "Date posted" and wording overrides', () => {
  const j = parseJob(JD_FRONTEND)
  assert.equal(j.title, 'Frontend Developer')
  assert.equal(j.company, 'Brightside')
  assert.equal(j.location, 'Remote (US)')
  assert.equal(j.postedAt, '2026-08-15')
  assert.deepEqual([j.salary.min, j.salary.max, j.salary.currency], [120000, 150000, 'USD'])
  const kind = t => j.requirements.find(r => r.text.includes(t)).kind
  assert.equal(kind('TypeScript'), 'must')
  assert.equal(kind('GraphQL'), 'nice')
  assert.equal(kind('Storybook'), 'nice')
  assert.equal(kind('React'), 'must')
  assert.ok(j.keywords.includes('JavaScript') && j.keywords.includes('React'))
})

test('numbered lists, Preferred Qualifications, hourly pay', () => {
  const j = parseJob(JD_DATA)
  assert.equal(j.title, 'Data Analyst')
  assert.equal(j.company, 'Northwind Health')
  assert.equal(j.location, 'Chicago, IL')
  assert.deepEqual(j.requirements.map(r => [r.text, r.kind]), [
    ['Advanced SQL', 'must'], ['Tableau or Power BI', 'must'], ['Excel is required', 'must'],
    ['Python for data analysis', 'nice'], ['Experience in healthcare', 'nice']
  ])
  assert.deepEqual([j.salary.min, j.salary.max, j.salary.period], [35, 45, 'hour'])
  assert.equal(j.postedAt, undefined)
})

test('relative dates use now; signals carry emails and word count', () => {
  const j = parseJob('Engineer\nPosted 3 days ago\nApply to jobs@acme.io', { now: new Date('2026-09-25T12:00:00Z') })
  assert.equal(j.postedAt, '2026-09-22')
  assert.deepEqual(j.signals.emails, ['jobs@acme.io'])
  assert.equal(j.signals.words, 8)
})

test('empty or junk input never throws', () => {
  for (const t of ['', null, undefined, '   \n\n', '- \n#\n:']) {
    const j = parseJob(t)
    assert.deepEqual(j.requirements, [])
    assert.deepEqual(j.keywords, [])
    assert.equal(j.salary, undefined)
  }
})

test('keywordsIn finds tools, acronyms and aliases, canonical names, no stopwords', () => {
  assert.deepEqual(keywordsIn('We use JS, k8s and Postgres on AWS. You will love it.'), ['JavaScript', 'Kubernetes', 'PostgreSQL', 'AWS'])
  assert.deepEqual(keywordsIn('Experience with Node.js, C++ and C#'), ['Node.js', 'C++', 'C#'])
})
