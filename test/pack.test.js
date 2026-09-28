import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPack, COMMON_QUESTIONS } from '../src/jobs/pack.js'
import { createAssist } from '../src/ai/assist.js'
import { parse } from '../src/model/markdown.js'

const CONTENT = '# Ada Lovelace\nada@x.dev · +44 20 1234 5678 · [LinkedIn](https://linkedin.com/in/ada) · github.com/ada\n\n## Experience\n### Engineer | Acme | 2020 – 2024\n- Built the analytical engine billing service'
const CV = { docId: 'doc-1', content: CONTENT }
const NOW = () => new Date('2026-09-28T10:00:00Z')
const PROFILE = {
  authorizedIn: ['US'], needsSponsorship: false, willingToRelocate: true,
  salaryExpectation: '150000 USD', noticePeriod: '4 weeks', website: 'https://ada.dev', city: 'New York', country: 'United States'
}
const YES_NO = [{ label: 'Yes', value: 1 }, { label: 'No', value: 0 }]
const q = (label, o = {}) => ({ label, name: `question_${label.length}`, type: 'input_text', required: false, ...o })
const job = (questions, o = {}) => ({ id: 'job-1', title: 'Staff Engineer', company: 'Globex', location: 'New York, NY, US', text: 'Build billing.', questions, ...o })
const answerFor = (pack, label) => pack.answers.find(a => a.question === label)
const fakeAssist = (fn) => ({ calls: [], async answer (...args) { this.calls.push(args); return fn(...args) } })

test('standard questions are answered by rules from the profile and CV', async () => {
  const qs = [
    q('First Name', { required: true }), q('Last Name', { required: true }), q('Email', { required: true }), q('Phone'),
    q('Resume/CV', { type: 'input_file', required: true }),
    q('LinkedIn Profile'), q('GitHub URL'), q('Website'),
    q('Are you legally authorized to work in the United States?', { type: 'multi_value_single_select', required: true, options: YES_NO }),
    q('Will you now or in the future require sponsorship for employment visa status?', { type: 'multi_value_single_select', required: true, options: YES_NO }),
    q('Are you open to relocation?', { type: 'multi_value_single_select', options: ['Yes', 'No'] }),
    q('What are your salary expectations?'), q('What is your notice period?'),
    q('How did you hear about this job?'), q('Current location (city)')
  ]
  const pack = await buildPack({ job: job(qs), cv: CV, profile: PROFILE, now: NOW })
  const got = Object.fromEntries(pack.answers.map(a => [a.question, [a.answer, a.source]]))
  assert.deepEqual(got, {
    'First Name': ['Ada', 'cv'], 'Last Name': ['Lovelace', 'cv'], Email: ['ada@x.dev', 'cv'], Phone: ['+44 20 1234 5678', 'cv'],
    'Resume/CV': ['Ada-Lovelace-CV.pdf', 'cv'],
    'LinkedIn Profile': ['https://linkedin.com/in/ada', 'cv'], 'GitHub URL': ['https://github.com/ada', 'cv'], Website: ['https://ada.dev', 'profile'],
    'Are you legally authorized to work in the United States?': ['Yes', 'profile'],
    'Will you now or in the future require sponsorship for employment visa status?': ['No', 'profile'],
    'Are you open to relocation?': ['Yes', 'profile'],
    'What are your salary expectations?': ['150000 USD', 'profile'], 'What is your notice period?': ['4 weeks', 'profile'],
    'How did you hear about this job?': ['Company careers page', 'rule'],
    'Current location (city)': ['New York', 'profile']
  })
  const auth = answerFor(pack, 'Are you legally authorized to work in the United States?')
  assert.equal(auth.required, true)
  assert.equal(auth.type, 'multi_value_single_select')
  assert.deepEqual(auth.options, ['Yes', 'No'])
})

test('authorized "without sponsorship" is an authorization question; needing sponsorship elsewhere answers both', async () => {
  const qs = [q('Are you authorized to work in the US without sponsorship?', { options: YES_NO }), q('Do you require visa sponsorship?', { options: YES_NO })]
  const ok = await buildPack({ job: job(qs), cv: CV, profile: PROFILE, now: NOW })
  assert.deepEqual(ok.answers.map(a => a.answer), ['Yes', 'No'])
  const needs = await buildPack({ job: job(qs), cv: CV, profile: { authorizedIn: ['DE'], needsSponsorship: true }, now: NOW })
  assert.deepEqual(needs.answers.map(a => a.answer), ['No', 'Yes'])
})

test('pack shape: ids, fields with values only, pdf name, createdAt; no AI → no call', async () => {
  const pack = await buildPack({ job: job([]), cv: CV, profile: PROFILE, now: NOW })
  assert.equal(pack.jobId, 'job-1')
  assert.equal(pack.cvDocId, 'doc-1')
  assert.equal(pack.pdfName, 'Ada-Lovelace-CV.pdf')
  assert.equal(pack.createdAt, '2026-09-28T10:00:00.000Z')
  assert.deepEqual(pack.fields.slice(0, 4), [
    { label: 'First name', value: 'Ada' }, { label: 'Last name', value: 'Lovelace' },
    { label: 'Email', value: 'ada@x.dev' }, { label: 'Phone', value: '+44 20 1234 5678' }
  ])
  assert.ok(pack.fields.every(f => f.value))
  assert.ok(pack.fields.some(f => f.label === 'City' && f.value === 'New York'))
  assert.equal('coverLetterDocId' in pack, false)
})

test('no Greenhouse questions → the common set', async () => {
  const pack = await buildPack({ job: job(undefined), cv: CV, profile: PROFILE, now: NOW })
  assert.deepEqual(pack.answers.map(a => a.question), COMMON_QUESTIONS.map(c => c.label))
  assert.equal(answerFor(pack, 'How did you hear about this job?').answer, 'Company careers page')
})

test('EEO questions default to decline, picking the decline option when there is one', async () => {
  const qs = [
    q('Gender', { type: 'multi_value_single_select', options: ['Male', 'Female', 'Decline To Self Identify'] }),
    q('Are you Hispanic/Latino?', { type: 'multi_value_single_select', options: ['Yes', 'No', "I don't wish to answer"] }),
    q('Veteran Status', { type: 'multi_value_single_select', options: ['I am a veteran', 'I am not a veteran', 'I prefer not to answer'] }),
    q('Disability Status'),
    q('Race', { type: 'multi_value_single_select', options: ['Asian', 'White'] }),
    q('What is your sexual orientation?')
  ]
  const pack = await buildPack({ job: job(qs), cv: CV, profile: {}, now: NOW })
  assert.deepEqual(pack.answers.map(a => [a.answer, a.source]), [
    ['Decline To Self Identify', 'rule'], ["I don't wish to answer", 'rule'], ['I prefer not to answer', 'rule'],
    ['Decline to self-identify', 'rule'], ['', 'unanswered'], ['Decline to self-identify', 'rule']
  ])
  const own = await buildPack({ job: job([qs[0], qs[5]]), cv: CV, profile: { eeo: { gender: 'Female' } }, now: NOW })
  assert.deepEqual(own.answers.map(a => [a.answer, a.source]), [['Female', 'profile'], ['Decline to self-identify', 'rule']])
})

test('free-text questions go to AI (answer mode) and come back as source ai', async () => {
  const qs = [q('Why do you want to work at Globex?', { type: 'textarea', required: true }), q('Email'), q('Anything else?')]
  const assist = fakeAssist((j, questions) => ({ answers: questions.map(x => ({ answer: `About: ${x.label}`, status: 'ok', newFacts: [] })) }))
  const pack = await buildPack({ job: job(qs), cv: CV, profile: PROFILE, assist, now: NOW })
  assert.equal(assist.calls.length, 1)
  assert.deepEqual(assist.calls[0][1].map(x => x.label), ['Why do you want to work at Globex?', 'Anything else?'])
  assert.equal(assist.calls[0][2].profile.firstName, 'Ada')
  assert.deepEqual([answerFor(pack, 'Why do you want to work at Globex?').answer, answerFor(pack, 'Why do you want to work at Globex?').source],
    ['About: Why do you want to work at Globex?', 'ai'])
  assert.equal(answerFor(pack, 'Email').source, 'cv')
})

test('without AI, free-text and unknown questions are unanswered; nothing is guessed from an empty profile', async () => {
  const qs = [
    q('Why do you want to work at Globex?', { type: 'textarea', required: true }),
    q('Are you legally authorized to work in the United States?', { options: YES_NO }),
    q('Do you require visa sponsorship?', { options: YES_NO }), q('Are you willing to relocate?'),
    q('What are your salary expectations?'), q('Pick a team', { options: ['Red', 'Blue'] })
  ]
  const pack = await buildPack({ job: job(qs), cv: { docId: 'd', content: '' }, profile: {}, now: NOW })
  for (const a of pack.answers) assert.deepEqual([a.answer, a.source], ['', 'unanswered'], a.question)
  assert.equal(pack.answers[0].required, true)
  assert.equal(pack.pdfName, 'CV.pdf')
})

test('never invents facts: guarded, empty or failing AI answers stay unanswered', async () => {
  const qs = [q('Why us?', { type: 'textarea' }), q('Tell us about a project.', { type: 'textarea' }), q('Team size?', { type: 'textarea' })]
  const guarded = fakeAssist(() => ({ answers: [
    { answer: 'I led 47 engineers at Initech.', status: 'new-facts', newFacts: ['47', 'Initech'] },
    { answer: '', status: 'empty', needsInput: 'Which project?' },
    { answer: 'Fine answer.', status: 'ok', newFacts: [] }
  ] }))
  const pack = await buildPack({ job: job(qs), cv: CV, profile: PROFILE, assist: guarded, now: NOW })
  assert.deepEqual(pack.answers.map(a => a.source), ['unanswered', 'unanswered', 'ai'])
  assert.equal(pack.answers[0].answer, '')

  const failing = fakeAssist(() => { throw Object.assign(new Error('down'), { code: 'network' }) })
  const p2 = await buildPack({ job: job(qs), cv: CV, profile: PROFILE, assist: failing, now: NOW })
  assert.ok(p2.answers.every(a => a.source === 'unanswered'))
})

test('end to end with the real assist guard: an invented employer never reaches the pack', async () => {
  const client = { async complete () { return { text: JSON.stringify({ answers: [{ n: 1, answer: 'I scaled the Initech payments team to 40 people.' }, { n: 2, answer: 'I built the billing service at Acme.' }] }) } } }
  const assist = createAssist({ client, getState: () => ({ content: CONTENT, doc: parse(CONTENT) }), loadPlaybook: async () => null })
  const pack = await buildPack({ job: job([q('Why us?', { type: 'textarea' }), q('A project?', { type: 'textarea' })]), cv: CV, profile: PROFILE, assist, now: NOW })
  assert.deepEqual(pack.answers.map(a => [a.answer, a.source]), [['', 'unanswered'], ['I built the billing service at Acme.', 'ai']])
})
