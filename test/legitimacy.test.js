import test from 'node:test'
import assert from 'node:assert/strict'
import { checkLegitimacy } from '../src/jobs/legitimacy.js'

const now = new Date('2026-09-25T00:00:00Z')
const GOOD = `Backend Engineer
Company: Acme Robotics

Requirements
- Go and PostgreSQL
- Kubernetes and Docker
- Terraform on AWS

Apply at careers@acmerobotics.com

Salary: $120,000 - $150,000 per year`
const base = { id: 'a', title: 'Backend Engineer', company: 'Acme Robotics', postedAt: '2026-09-10', url: 'https://acmerobotics.com/jobs/1', text: GOOD }
const check = (patch = {}, opts = {}) => checkLegitimacy({ ...base, ...patch }, { now, ...opts })
const codes = r => r.signals.map(s => s.code)

test('a specific, recent, named posting is ok with no signals', () => {
  assert.deepEqual(check(), { level: 'ok', signals: [] })
})

test('stale and undated postings', () => {
  assert.ok(codes(check({ postedAt: '2026-07-01' })).includes('stale'))
  assert.ok(!codes(check({ postedAt: '2026-09-01' })).includes('stale'))
  const r = check({ postedAt: undefined })
  assert.ok(codes(r).includes('no-date'))
  assert.equal(r.level, 'ok', 'a missing date alone is not a flag')
})

test('reposted: same title and company saved under another id', () => {
  const saved = [{ id: 'b', title: 'backend engineer', company: 'ACME Robotics' }]
  assert.ok(codes(check({}, { saved })).includes('reposted'))
  assert.ok(!codes(check({}, { saved: [{ ...saved[0], id: 'a' }] })).includes('reposted'))
  assert.ok(!codes(check({}, { saved: [{ ...saved[0], title: 'Designer' }] })).includes('reposted'))
})

test('no company name', () => {
  const r = check({ company: '', text: GOOD.replace('Company: Acme Robotics', ''), url: '' })
  assert.ok(codes(r).includes('no-company'))
  assert.equal(r.level, 'caution')
})

test('payment, documents/SSN and messaging apps are red flags', () => {
  for (const [code, line] of [
    ['payment', 'You must pay a $50 training fee before starting.'],
    ['sensitive-data', 'Send your SSN and bank account details with your application.'],
    ['messaging-app', 'Interviews are held on Telegram.']
  ]) {
    const r = check({ text: GOOD + '\n' + line })
    assert.ok(codes(r).includes(code), code)
    assert.equal(r.level, 'red-flag', code)
    assert.match(r.signals.find(s => s.code === code).evidence, /\w/)
  }
  assert.ok(!codes(check({ text: GOOD + '\nWe pay competitively and use Slack.' })).some(c => ['payment', 'messaging-app'].includes(c)))
})

test('salary absurdly high for the title, or a range over 3x', () => {
  assert.ok(codes(check({ text: GOOD.replace('$120,000 - $150,000 per year', '$600,000 - $700,000 per year') })).includes('salary-high'))
  assert.ok(!codes(check({ title: 'Chief Technology Officer', text: GOOD.replace('$120,000 - $150,000 per year', '$600,000 - $700,000 per year') })).includes('salary-high'))
  assert.ok(codes(check({ text: GOOD.replace('$120,000 - $150,000', '$40,000 - $150,000') })).includes('salary-range'))
  assert.ok(!codes(check()).includes('salary-range'))
})

test('generic text with few concrete tools or responsibilities', () => {
  assert.ok(codes(check({ text: 'Great opportunity! Join our amazing team and grow with us. Apply now.' })).includes('generic'))
  assert.ok(!codes(check()).includes('generic'))
})

test('email domain that does not match the company, including free mail', () => {
  assert.ok(codes(check({ text: GOOD.replace('careers@acmerobotics.com', 'acme.hiring@gmail.com') })).includes('email-domain'))
  assert.ok(codes(check({ text: GOOD.replace('careers@acmerobotics.com', 'hr@totally-other.biz') })).includes('email-domain'))
  assert.ok(!codes(check()).includes('email-domain'))
})

test('urgent / no experience high pay patterns', () => {
  assert.ok(codes(check({ text: GOOD + '\nURGENT hiring! No experience needed, earn $5000 per week.' })).includes('pressure'))
  assert.ok(!codes(check()).includes('pressure'))
})

test('empty job never throws', () => {
  const r = checkLegitimacy({}, { now })
  assert.ok(['ok', 'caution', 'red-flag'].includes(r.level))
  assert.ok(checkLegitimacy(null).signals.length)
})
