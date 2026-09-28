// Apply queue pure helpers (career-suite spec §4): missing-question groups, bank refill, bundle, tracker updates.
// Uses the real answer bank (src/jobs/answers.js), so groups are exactly what one saved answer refills.
import test from 'node:test'
import assert from 'node:assert/strict'
import { missingQuestions, fillFromBank, rememberAnswers, buildBundle, trackerUpdate, FINISHED } from '../src/ui/apply-queue.js'
import { bundleError } from '../cli/autoapply.js'

const NOW = new Date('2026-09-28T12:00:00Z')

const q = (question, extra = {}) => ({ question, type: 'text', required: true, answer: '', source: 'unanswered', ...extra })
const PACKS = [
  { jobId: 'a', pack: { fields: [], answers: [q('Will you now or in the future require visa sponsorship?'), q('Why Acme?'), q('Cover letter', { required: false }), q('Email', { answer: 'x@y.z', source: 'profile' })] } },
  { jobId: 'b', pack: { fields: [], answers: [q('Do you require sponsorship?', { type: 'choice', options: ['Yes', 'No'] }), q('Why do you want to work at Beta?', { type: 'textarea' })] } },
  { jobId: 'c', pack: { fields: [], answers: [q('Do you have a current police check?'), q('Do you have a current police check ?')] } },
  { jobId: 'd', pack: null }
]

test('missingQuestions groups required unanswered questions across packs by rule and similarity', () => {
  const groups = missingQuestions(PACKS)
  assert.deepEqual(groups.map(g => [g.question, g.jobIds]), [
    ['Will you now or in the future require visa sponsorship?', ['a', 'b']],
    ['Why Acme?', ['a']],
    ['Why do you want to work at Beta?', ['b']],
    ['Do you have a current police check?', ['c']]
  ])
  assert.deepEqual(groups[0].members.map(m => [m.jobId, m.index]), [['a', 0], ['b', 0]])
  assert.deepEqual(groups[0].options, ['Yes', 'No'], 'a choice member gives the group its options')
  assert.equal(groups[2].type, 'textarea')
  assert.equal(groups[3].members.length, 2, 'duplicates in one pack are one group')
  assert.deepEqual(missingQuestions([]), [])
})

test('fillFromBank answers unanswered questions from the bank with source bank and leaves the rest', () => {
  const bank = [{ question: 'Do you require sponsorship?', answer: 'no' }, { question: 'Why Acme?', answer: 'Tools.' }]
  const pack = { fields: [], answers: [q('Do you require sponsorship?', { options: ['Yes', 'No'] }), q('Why Acme?'), q('Email', { answer: 'x@y.z', source: 'profile' }), q('Unknown?')] }
  const out = fillFromBank(pack, bank)
  assert.deepEqual(out.answers.map(a => [a.answer, a.source]), [['No', 'bank'], ['Tools.', 'bank'], ['x@y.z', 'profile'], ['', 'unanswered']])
  assert.equal(pack.answers[0].answer, '', 'input untouched')
  assert.equal(fillFromBank(null, bank), null)
})

test('rememberAnswers writes each non-empty group answer to the bank, which then refills every member', () => {
  const groups = missingQuestions(PACKS)
  const bank = rememberAnswers([], groups, ['No', '  ', 'I like tools', ''], NOW)
  assert.deepEqual(bank.map(e => [e.question, e.answer, e.options]).sort(), [
    ['Why do you want to work at Beta?', 'I like tools', undefined],
    ['Will you now or in the future require visa sponsorship?', 'No', ['Yes', 'No']]
  ])
  const [a, b] = PACKS.map(p => fillFromBank(p.pack, bank))
  assert.deepEqual([a.answers[0], b.answers[0], b.answers[1]].map(x => [x.answer, x.source]), [['No', 'bank'], ['No', 'bank'], ['I like tools', 'bank']])
  assert.equal(a.answers[1].answer, '', 'skipped group stays unanswered')
})

test('buildBundle is a valid autoapply bundle with only what autoapply reads', () => {
  const jobs = [{ id: 'a', title: 'Engineer', company: 'Acme', location: 'Sydney', url: 'https://x.example/a', applyUrl: 'https://x.example/apply', status: 'saved',
    text: 'JD', evaluations: [{ score: 4.5 }], pack: { answers: [], fields: [] }, docIds: ['d1'], notes: 'private' }]
  const b = buildBundle({ jobs, cv: { name: 'Me', content: '# Me', layout: { page: 'A4' }, extra: 1 }, profile: { city: 'Sydney' }, mode: 'submit', minScore: 4, max: 10 })
  assert.equal(bundleError(b), null)
  assert.equal(b.format, 'recto-apply')
  assert.equal(b.mode, 'submit')
  assert.deepEqual(b.cv, { name: 'Me', content: '# Me', layout: { page: 'A4' } })
  assert.deepEqual(Object.keys(b.jobs[0]).sort(), ['applyUrl', 'company', 'evaluations', 'id', 'location', 'pack', 'status', 'text', 'title', 'url'])
  assert.equal(buildBundle({ jobs, cv: { content: '' }, profile: {}, mode: 'anything' }).mode, 'review')
})

test('trackerUpdate: submitted → applied with an applyLog entry; filled/blocked/skipped stay saved with the reason', () => {
  const job = { id: 'a', status: 'saved', applyLog: [{ at: 'old', result: 'filled', reason: '' }] }
  const applied = trackerUpdate(job, { state: 'submitted', reason: '' }, NOW)
  assert.equal(applied.status, 'applied')
  assert.deepEqual(applied.applyLog, [...job.applyLog, { at: NOW.toISOString(), result: 'submitted', reason: '' }])
  const blocked = trackerUpdate({ id: 'b', status: 'saved' }, { state: 'blocked', reason: 'captcha' }, NOW)
  assert.equal(blocked.status, 'saved')
  assert.deepEqual(blocked.applyLog, [{ at: NOW.toISOString(), result: 'blocked', reason: 'captcha' }])
  for (const state of ['queued', 'filling', 'waiting-for-you']) assert.equal(trackerUpdate(job, { state }, NOW), null, state)
  assert.deepEqual(FINISHED, ['submitted', 'filled', 'blocked', 'skipped'])
})
