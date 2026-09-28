import test from 'node:test'
import assert from 'node:assert/strict'
import {
  funnel, rates, rejections, reposts, calibration, skillGaps, adjacentTitles,
  cadence, followUpsDue, classifyReply, salaryGap, compare, atsOf, bandOf
} from '../src/jobs/insights.js'

const h = (...pairs) => pairs.map(([status, at]) => ({ status, at }))
const job = (id, statuses, extra = {}) => ({
  id, title: 'Engineer', company: 'Acme', source: 'greenhouse', url: '', text: '',
  status: statuses.at(-1), statusHistory: h(...statuses.map((s, i) => [s, `2026-09-0${i + 1}T00:00:00.000Z`])), evaluations: [], ...extra
})

const jobs = [
  job('a', ['saved']),
  job('b', ['saved', 'applied'], { evaluations: [{ score: 4.6, role: { remote: 'full', archetype: 'engineering' } }] }),
  job('c', ['saved', 'applied', 'interview'], { source: 'lever', evaluations: [{ score: 4.2 }] }),
  job('d', ['saved', 'applied', 'interview', 'offer'], { source: 'lever', evaluations: [{ score: 2.5 }, { score: 4.1 }] }),
  job('e', ['saved', 'applied', 'rejected'], { outcome: { stage: 'screen', reason: 'Not enough React', at: '' }, evaluations: [{ score: 3.4 }] }),
  job('f', ['saved', 'applied', 'rejected'], { outcome: { stage: '', reason: '', at: '' }, evaluations: [{ score: 2 }] }),
  job('g', ['saved', 'applied', 'no-response'], { source: 'url', url: 'https://jobs.lever.co/acme/1' })
]

test('bandOf and atsOf', () => {
  assert.deepEqual([2.9, 3, 3.9, 4, 4.4, 4.5, 5, undefined].map(bandOf), ['<3', '3-3.9', '3-3.9', '4-4.4', '4-4.4', '4.5+', '4.5+', 'unscored'])
  assert.equal(atsOf({ source: 'workable', url: 'https://x.example' }), 'workable')
  assert.equal(atsOf({ source: 'remotive', url: 'https://boards.greenhouse.io/acme/jobs/1' }), 'greenhouse')
  assert.equal(atsOf({ source: 'url', applyUrl: 'https://acme.wd3.myworkdayjobs.com/x', url: 'https://acme.example/jobs' }), 'workday')
  assert.equal(atsOf({ source: 'url', url: 'https://www.careers.acme.example/jobs/1' }), 'careers.acme.example')
  assert.equal(atsOf({ source: 'paste' }), 'unknown')
})

test('funnel counts each stage reached, with conversion from the previous stage', () => {
  assert.deepEqual(funnel(jobs), [
    { stage: 'saved', count: 7, rate: 1 },
    { stage: 'applied', count: 6, rate: 0.86 },
    { stage: 'responded', count: 3, rate: 0.5 },
    { stage: 'interview', count: 2, rate: 0.67 },
    { stage: 'offer', count: 1, rate: 0.5 }
  ])
  assert.deepEqual(funnel([]).map(s => s.count), [0, 0, 0, 0, 0])
  assert.equal(funnel([]).at(-1).rate, 0)
})

test('rates by source, ats, band, remote and archetype; sorted by applied desc', () => {
  assert.deepEqual(rates(jobs, 'source'), [
    { key: 'greenhouse', applied: 3, responded: 1, interviews: 0, offers: 0, rate: 0.33 },
    { key: 'lever', applied: 2, responded: 2, interviews: 2, offers: 1, rate: 1 },
    { key: 'url', applied: 1, responded: 0, interviews: 0, offers: 0, rate: 0 }
  ])
  assert.deepEqual(rates(jobs, 'ats').map(r => [r.key, r.applied]), [['lever', 3], ['greenhouse', 3]])
  assert.deepEqual(rates(jobs, 'band').map(r => r.key), ['4-4.4', '3-3.9', '4.5+', '<3', 'unscored'])
  assert.deepEqual(rates(jobs, 'remote').map(r => [r.key, r.applied]), [['unknown', 5], ['full', 1]])
  assert.deepEqual(rates(jobs, 'archetype').map(r => r.key), ['other', 'engineering'])
  assert.deepEqual(rates([], 'source'), [])
})

test('rejections: stages and reasons', () => {
  const r = rejections([...jobs, job('h', ['saved', 'applied', 'rejected'], { outcome: { stage: 'screen', reason: ' not enough react ' } })])
  assert.equal(r.total, 3)
  assert.deepEqual(r.stages, [{ stage: 'screen', count: 2 }, { stage: 'unknown', count: 1 }])
  assert.deepEqual(r.reasons, [{ reason: 'not enough react', count: 2 }])
})

test('reposts: same company and normalised title under other ids, or a refreshed posting date', () => {
  const list = [
    { id: '1', company: 'Acme Pty Ltd', title: 'Senior Engineer', postedAt: '2026-08-01' },
    { id: '2', company: 'acme pty ltd', title: 'Senior  Engineer!', postedAt: '2026-09-01' },
    { id: '3', company: 'Other', title: 'Senior Engineer', postedAt: '2026-09-01' },
    { id: '4', company: 'Fresh', title: 'Designer', postedAt: '2026-09-20', createdAt: '2026-09-01T00:00:00.000Z' }
  ]
  assert.deepEqual(reposts(list), [
    { company: 'Acme Pty Ltd', title: 'Senior Engineer', ids: ['1', '2'], dates: ['2026-08-01', '2026-09-01'], reason: 'duplicate' },
    { company: 'Fresh', title: 'Designer', ids: ['4'], dates: ['2026-09-20'], reason: 'refreshed' }
  ])
  assert.deepEqual(reposts([]), [])
})

test('calibration: interview rate per score band over applied jobs', () => {
  assert.deepEqual(calibration(jobs), [
    { band: '<3', applied: 1, interviews: 0, rate: 0 },
    { band: '3-3.9', applied: 1, interviews: 0, rate: 0 },
    { band: '4-4.4', applied: 2, interviews: 2, rate: 1 },
    { band: '4.5+', applied: 1, interviews: 0, rate: 0 }
  ])
})

test('skillGaps counts missing requirement keywords once per job', () => {
  const ev = kws => ({ evaluations: [{ score: 3, rows: kws.map(k => ({ match: 'missing', keywords: k })).concat([{ match: 'strong', keywords: ['css'] }]) }] })
  const list = [job('1', ['saved'], ev([['react', 'typescript'], ['react']])), job('2', ['saved'], ev([['react'], ['aws']])), job('3', ['saved'])]
  assert.deepEqual(skillGaps(list), [{ skill: 'react', count: 2 }, { skill: 'aws', count: 1 }, { skill: 'typescript', count: 1 }])
  assert.equal(skillGaps(list, 1).length, 1)
})

test('adjacentTitles from a static map, without the input titles', () => {
  const t = adjacentTitles(['frontend'])
  assert.ok(t.includes('UI Engineer') && t.includes('Full-stack Engineer') && t.includes('Design Engineer'))
  assert.ok(adjacentTitles(['Senior Frontend Engineer', 'data']).includes('Analytics Engineer'))
  assert.deepEqual(adjacentTitles(['zzz']), [])
  assert.deepEqual(adjacentTitles(), [])
})

test('cadence: applied → +7 d and +14 d follow-ups; stored done flags and custom items merge', () => {
  const j = { status: 'applied', statusHistory: h(['saved', '2026-09-01T10:00:00.000Z'], ['applied', '2026-09-02T10:00:00.000Z']),
    followUps: [{ due: '2026-09-09', kind: 'follow-up', done: true }, { due: '2026-09-12', kind: 'check-in', done: false }] }
  assert.deepEqual(cadence(j), [
    { due: '2026-09-09', kind: 'follow-up', done: true },
    { due: '2026-09-12', kind: 'check-in', done: false },
    { due: '2026-09-16', kind: 'follow-up', done: false }
  ])
  assert.deepEqual(followUpsDue(j, new Date('2026-09-15T00:00:00.000Z')), [{ due: '2026-09-12', kind: 'check-in', done: false }])
  assert.equal(followUpsDue(j, new Date('2026-09-16T08:00:00.000Z')).length, 2)
  assert.deepEqual(cadence({ status: 'rejected', statusHistory: h(['applied', '2026-09-02T00:00:00.000Z'], ['rejected', '2026-09-05T00:00:00.000Z']) }), [], 'status moved on')
  assert.deepEqual(cadence(null), [])
  assert.deepEqual(followUpsDue({ ...j, status: 'rejected' }, new Date('2026-10-01T00:00:00.000Z')), [], 'a closed job has nothing due, stored items included')
})

test('cadence: interview → thank-you +1 d after each interview, check-in +7 d after the last', () => {
  const j = { status: 'interview', statusHistory: h(['applied', '2026-09-01T00:00:00.000Z'], ['interview', '2026-09-05T00:00:00.000Z']),
    interviews: [{ at: '2026-09-10T03:00:00.000Z' }, { at: '2026-09-17T03:00:00.000Z' }, { at: '' }] }
  assert.deepEqual(cadence(j).map(f => [f.due, f.kind]), [['2026-09-11', 'thank-you'], ['2026-09-18', 'thank-you'], ['2026-09-24', 'check-in']])
  const noDates = { status: 'interview', statusHistory: h(['interview', '2026-09-05T00:00:00.000Z']) }
  assert.deepEqual(cadence(noDates).map(f => [f.due, f.kind]), [['2026-09-12', 'check-in']], 'falls back to the status date')
})

test('classifyReply: regex kinds, status, confidence and the quoted sentence', () => {
  const rej = classifyReply('Hi Sam,\nThank you for your interest. Unfortunately, we will not be moving forward with your application. We wish you well.')
  assert.equal(rej.kind, 'rejection')
  assert.equal(rej.status, 'rejected')
  assert.equal(rej.quote, 'Unfortunately, we will not be moving forward with your application.')
  assert.ok(rej.confidence >= 0.5 && rej.confidence < 1)
  const cases = [
    ['We have decided to proceed with other candidates.', 'rejection', 'rejected'],
    ['We would like to schedule a call with you next week.', 'interview', 'interview'],
    ['We would love to invite you to an interview. Please share your availability.', 'interview', 'interview'],
    ['We are pleased to offer you the role. Your offer letter is attached.', 'offer', 'offer'],
    ['Could you send us a copy of your portfolio?', 'info-request', ''],
    ['We have received your application and will review it shortly.', 'auto-ack', 'applied'],
    ['Thank you for applying to Acme!', 'auto-ack', 'applied']
  ]
  for (const [text, kind, status] of cases) {
    const r = classifyReply(text)
    assert.deepEqual([r.kind, r.status], [kind, status], text)
    assert.ok(r.quote && text.includes(r.quote), text)
  }
  const strong = classifyReply('We are pleased to offer you the position. Congratulations! The offer letter is attached.')
  const weak = classifyReply('Congratulations!')
  assert.ok(strong.confidence > weak.confidence)
  const mixed = classifyReply('Thank you for applying. We would like to schedule an interview.')
  assert.equal(mixed.kind, 'interview')
  assert.ok(mixed.confidence < 0.5, 'competing signals lower confidence')
  assert.deepEqual(classifyReply('See you at the barbecue'), { kind: 'other', status: '', confidence: 0, quote: '' })
  assert.deepEqual(classifyReply(null), { kind: 'other', status: '', confidence: 0, quote: '' })
})

test('salaryGap: absolute and percent gaps; missing values give null', () => {
  assert.deepEqual(salaryGap({ desired: 150000, advertised: 140000, offered: 135000 }), {
    desired: 150000, advertised: 140000, offered: 135000,
    offeredVsDesired: { diff: -15000, pct: -10 },
    offeredVsAdvertised: { diff: -5000, pct: -3.6 },
    advertisedVsDesired: { diff: -10000, pct: -6.7 }
  })
  const partial = salaryGap({ desired: '120000', offered: 132000 })
  assert.deepEqual(partial.offeredVsDesired, { diff: 12000, pct: 10 })
  assert.equal(partial.advertised, null)
  assert.equal(partial.offeredVsAdvertised, null)
  assert.equal(salaryGap({ desired: 'A$150,000 + super' }).desired, 150000)
  assert.equal(salaryGap({ desired: '150k' }).desired, 150000)
  assert.equal(salaryGap({ desired: 'negotiable', offered: -5 }).desired, null)
  assert.equal(salaryGap({ offered: -5 }).offered, null)
  assert.deepEqual(salaryGap({ desired: 0, offered: 10 }).offeredVsDesired, { diff: 10, pct: null })
  assert.deepEqual(salaryGap(), { desired: null, advertised: null, offered: null, offeredVsDesired: null, offeredVsAdvertised: null, advertisedVsDesired: null })
})

test('compare: one row per job with the latest evaluation, salary text and top 3 gaps', () => {
  const rows = [
    { requirement: 'React', match: 'missing' }, { requirement: 'CSS', match: 'strong' }, { requirement: 'AWS', match: 'partial' },
    { requirement: 'Go', match: 'missing' }, { requirement: 'SQL', match: 'missing' }
  ]
  const a = {
    id: 'a', title: 'Engineer', company: 'Acme', location: 'Sydney NSW', text: 'Salary: $150,000 - $170,000 per year\nBuild things',
    evaluations: [
      { score: 3, rows, role: { remote: 'hybrid' }, caps: [], legitimacy: { level: 'ok' }, recommendation: 'consider' },
      { score: 4.2, recommendation: 'apply', match: 78 }
    ]
  }
  const [r, empty] = compare([a, { id: 'b' }])
  assert.deepEqual(r, {
    id: 'a', title: 'Engineer', company: 'Acme', location: 'Sydney NSW', remote: 'hybrid', score: 4.2, match: 78,
    recommendation: 'apply', caps: [], legitimacy: 'ok', salary: '$150,000 - $170,000', gaps: ['React', 'AWS', 'Go']
  })
  assert.deepEqual(empty, { id: 'b', title: '', company: '', location: '', remote: 'unknown', score: null, match: null, recommendation: '', caps: [], legitimacy: '', salary: '', gaps: [] })
})
