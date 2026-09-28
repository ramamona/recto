import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeQuestion, similarity, findAnswer, remember, mapChoice, importAnswers, exportAnswers,
  COMMON_QUESTIONS, commonQuestions, completeness, MAX_ANSWERS, MAX_QUESTION, MAX_ANSWER
} from '../src/jobs/answers.js'

const NOW = '2026-09-28T10:00:00.000Z'
const entry = (question, answer, o = {}) => ({ id: `id-${question.length}`, question, answer, updatedAt: NOW, uses: 1, ...o })

test('normalizeQuestion lowercases, strips punctuation and stop words', () => {
  assert.equal(normalizeQuestion('What is your Notice Period?'), 'notice period')
  assert.equal(normalizeQuestion("Do you hold a current driver's licence?"), 'hold drivers licence')
  assert.equal(normalizeQuestion('  '), '')
  assert.equal(normalizeQuestion(null), '')
})

test('similarity is token Jaccard on normalized questions', () => {
  assert.equal(similarity('What is your notice period?', 'Notice period'), 1)
  assert.equal(similarity('notice period', 'notice period weeks'), 2 / 3)
  assert.equal(similarity('salary', 'notice'), 0)
  assert.equal(similarity('', 'notice'), 0)
  assert.equal(similarity('the', 'the'), 0)
})

test('findAnswer: exact normalized match, then same pack rule, then similarity ≥ 0.6', () => {
  const bank = [
    entry('Why do you want to join us?', 'I like the product.'),
    entry('What is your notice period?', '4 weeks'),
    entry('Describe your experience leading distributed engineering teams', 'Led three teams across two time zones.')
  ]
  assert.deepEqual(findAnswer(bank, 'why do you want to join us'), { answer: 'I like the product.', entry: bank[0] })
  // same rule (notice period) despite different words
  assert.equal(findAnswer(bank, 'Notice period required by your current employer')?.answer, '4 weeks')
  // similarity: 6 of 7 content words shared (≥ 0.6)
  assert.equal(findAnswer(bank, 'Describe your experience leading distributed engineering teams remotely')?.answer, 'Led three teams across two time zones.')
  // below the threshold
  assert.equal(findAnswer(bank, 'Describe a failure'), null)
  assert.equal(findAnswer([], 'anything'), null)
  assert.equal(findAnswer(null, 'anything'), null)
  assert.equal(findAnswer(bank, '?'), null)
})

test('findAnswer maps choice answers onto the offered options, skipping entries that fit none', () => {
  const bank = [entry('Do you have a current police check?', 'Yes, issued 2026')]
  assert.equal(findAnswer(bank, 'Do you have a current police check?', { options: ['Yes', 'No'] })?.answer, 'Yes')
  assert.equal(findAnswer([entry('Q one two', 'Yes')], 'Q one two', { options: ['Yes, I do', 'No'] })?.answer, 'Yes, I do')
  assert.equal(findAnswer(bank, 'Do you have a current police check?', { options: ['Red', 'Blue'] }), null)
  // a later entry that fits wins over an earlier one that doesn't
  const two = [entry('Preferred team?', 'Platform'), entry('Preferred team', 'Red')]
  assert.equal(findAnswer(two, 'Preferred team?', { options: ['Red', 'Blue'] })?.answer, 'Red')
})

test('findAnswer never reuses a work-rights answer across different countries', () => {
  const bank = [entry('Do you have the right to work in Australia?', 'Yes')]
  assert.equal(findAnswer(bank, 'Do you have the right to work in Australia?')?.answer, 'Yes')
  assert.equal(findAnswer(bank, 'Do you have the right to work in the United States?'), null)
})

test('mapChoice: exact, prefix either way, decline', () => {
  assert.equal(mapChoice(['Yes', 'No'], 'yes'), 'Yes')
  assert.equal(mapChoice(['Yes, I am', 'No'], 'Yes'), 'Yes, I am')
  assert.equal(mapChoice(['Yes', 'No'], 'No, not yet'), 'No')
  assert.equal(mapChoice(['Yesterday', 'No'], 'Yes'), '')
  assert.equal(mapChoice(['Male', 'Female', 'Prefer not to say'], 'decline'), 'Prefer not to say')
  assert.equal(mapChoice(['A'], ''), '')
})

test('remember adds new answers first with uses 1, and never mutates the bank', () => {
  const bank = [entry('Why us?', 'Product')]
  const next = remember(bank, { question: ' What is your notice period? ', answer: ' 4 weeks ', options: ['2 weeks', '4 weeks', ''] }, NOW)
  assert.equal(next.length, 2)
  assert.deepEqual({ ...next[0], id: 'x' }, { id: 'x', question: 'What is your notice period?', answer: '4 weeks', options: ['2 weeks', '4 weeks'], updatedAt: NOW, uses: 1 })
  assert.match(next[0].id, /^ans-/)
  assert.equal(bank.length, 1)
  assert.equal(remember(bank, { question: '', answer: 'x' }, NOW), bank)
  assert.equal(remember(bank, { question: 'Q', answer: '  ' }, NOW), bank)
})

test('remember updates a similar entry (≥ 0.85) in place and bumps uses', () => {
  const bank = [entry('Other', 'x'), entry('What is your notice period?', '2 weeks', { uses: 3 })]
  const next = remember(bank, { question: 'Notice period?', answer: '4 weeks' }, '2026-10-01T00:00:00Z')
  assert.equal(next.length, 2)
  assert.deepEqual(next[1], { ...bank[1], answer: '4 weeks', updatedAt: '2026-10-01T00:00:00.000Z', uses: 4 })
  // not similar enough → added
  assert.equal(remember(bank, { question: 'Notice period for contractors', answer: '1 week' }, NOW).length, 3)
})

test('remember caps question, answer and bank size', () => {
  const next = remember([], { question: 'q'.repeat(900), answer: 'a'.repeat(9000) }, NOW)
  assert.equal(next[0].question.length, MAX_QUESTION)
  assert.equal(next[0].answer.length, MAX_ANSWER)
  const full = Array.from({ length: MAX_ANSWERS }, (_, i) => entry(`unique question ${i} zz${i}`, 'a', { id: `e${i}` }))
  const more = remember(full, { question: 'A brand new question about pets', answer: 'Cats' }, NOW)
  assert.equal(more.length, MAX_ANSWERS)
  assert.equal(more[0].answer, 'Cats')
  assert.equal(more.at(-1).id, `e${MAX_ANSWERS - 2}`)
})

test('import merges an export back; export is a tagged JSON file', () => {
  const bank = remember([], { question: 'Why us?', answer: 'Product' }, NOW)
  const file = JSON.parse(exportAnswers(bank))
  assert.equal(file.format, 'recto-answers')
  assert.deepEqual(file.answers, bank)
  const merged = importAnswers([], file)
  assert.deepEqual(merged.map(e => [e.question, e.answer, e.updatedAt]), [['Why us?', 'Product', NOW]])
  assert.equal(importAnswers(bank, [{ question: 'Why us', answer: 'Mission' }], NOW)[0].answer, 'Mission')
  assert.deepEqual(importAnswers(bank, 'junk'), bank)
})

test('commonQuestions uses the preset wording for the active country', () => {
  const au = commonQuestions('AU')
  const q = id => au.find(x => x.id === id)?.question
  assert.equal(q('rightToWork'), 'Do you have the right to work in Australia?')
  assert.match(q('salary'), /including super\b/)
  assert.ok(q('workingWithChildren') && q('policeCheck') && q('indigenous'))
  assert.equal(q('backgroundCheck'), undefined)
  assert.equal(q('veteran'), undefined)

  const us = commonQuestions('United States')
  assert.match(us.find(x => x.id === 'salary').question, /401\(k\)/)
  assert.ok(us.some(x => x.id === 'veteran') && us.some(x => x.id === 'backgroundCheck'))
  assert.ok(!us.some(x => x.id === 'workingWithChildren' || x.id === 'indigenous'))

  const other = commonQuestions('Narnia')
  assert.equal(other.find(x => x.id === 'rightToWork').question, 'Do you have the right to work in Narnia?')
  assert.match(other.find(x => x.id === 'salary').question, /retirement contributions/)
  assert.equal(commonQuestions('').find(x => x.id === 'rightToWork').question, 'Do you have the right to work in this country?')
  assert.ok(COMMON_QUESTIONS.every(x => x.id && x.section && x.text && typeof x.filled === 'function'))
})

test('completeness counts profile fields and saved answers', () => {
  const empty = completeness({}, 'AU')
  assert.equal(empty.total, commonQuestions('AU').length)
  assert.ok(empty.missing.some(q => q.id === 'noticePeriod'))
  const some = completeness({ noticePeriod: '4 weeks', workRights: 'citizen', answers: [entry('What is your highest level of education?', 'Bachelor of Science')] }, 'AU')
  assert.equal(some.answered, empty.answered + 7) // right to work, citizenship, visa n/a, sponsorship, notice, start, education (bank)
  assert.ok(!some.missing.some(q => ['noticePeriod', 'earliestStart', 'rightToWork', 'education'].includes(q.id)))
  assert.equal(some.answered + some.missing.length, some.total)
})
