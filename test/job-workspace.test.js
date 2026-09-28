// Job workspace + Compare pure helpers (career-suite spec §6, §7): brief text, artifacts, follow-up toggles, salary input,
// practice questions, reply classification with AI fallback, pack summary, compare cells, and every UI string exists.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import {
  TABS, briefText, withArtifact, toggleFollowUp, desiredPay, prepQuestions, classifyReplyWith, storyText, packSummary
} from '../src/ui/job-workspace.js'
import { COMPARE_FIELDS, cellText } from '../src/ui/compare-view.js'

const BRIEF = {
  title: 'Prep for Acme',
  sections: [
    { heading: 'Likely questions', body: 'Mapped to your stories.', items: ['Tell me about a hard bug?', 'Why Acme?', 'Not a question'] },
    { heading: 'Questions to ask', body: '', items: ['What does success look like?'] },
    { heading: 'Notes', body: 'Be concise.', items: [] }
  ],
  needsInput: ['Salary band']
}

test('workspace tabs are the spec §7 set, Overview first', () => {
  assert.deepEqual(TABS, ['overview', 'pack', 'research', 'outreach', 'interview', 'offer', 'followups'])
})

test('briefText is plain text: title, headings, bodies, bulleted items, needs-input', () => {
  assert.equal(briefText(BRIEF), [
    'Prep for Acme', '',
    'Likely questions', 'Mapped to your stories.', '- Tell me about a hard bug?', '- Why Acme?', '- Not a question', '',
    'Questions to ask', '- What does success look like?', '',
    'Notes', 'Be concise.', '',
    '- Salary band'
  ].join('\n'))
  assert.equal(briefText(null), '')
  assert.equal(briefText({ sections: [] }), '')
})

test('withArtifact stores the latest brief per mode and keeps the others', () => {
  const job = { id: 'a', artifacts: { research: { sections: [] } } }
  const out = withArtifact(job, 'email', BRIEF)
  assert.deepEqual(Object.keys(out.artifacts), ['research', 'email'])
  assert.equal(out.artifacts.email, BRIEF)
  assert.equal(job.artifacts.email, undefined, 'input untouched')
  assert.equal(withArtifact({ id: 'b' }, 'research', BRIEF).artifacts.research, BRIEF)
})

test('toggleFollowUp updates a stored item in place or adds the plan item', () => {
  const item = { due: '2026-10-01', kind: 'follow-up' }
  assert.deepEqual(toggleFollowUp({}, item, true), [{ due: '2026-10-01', kind: 'follow-up', done: true }])
  const job = { followUps: [{ due: '2026-10-01', kind: 'follow-up', done: true }, { due: '2026-10-08', kind: 'follow-up', done: false }] }
  assert.deepEqual(toggleFollowUp(job, item, false), [{ due: '2026-10-01', kind: 'follow-up', done: false }, job.followUps[1]])
  assert.equal(job.followUps[0].done, true, 'input untouched')
})

test('desiredPay prefers the minimum salary, then the expectation text', () => {
  assert.equal(desiredPay({ salaryMin: 150000, salaryExpectation: '160k' }), 150000)
  assert.equal(desiredPay({ salaryMin: null, salaryExpectation: '160k' }), '160k')
  assert.equal(desiredPay({}), null)
})

test('prepQuestions takes the questions of a prep brief, not the ones to ask', () => {
  assert.deepEqual(prepQuestions(BRIEF), ['Tell me about a hard bug?', 'Why Acme?'])
  assert.deepEqual(prepQuestions(null), [])
})

test('classifyReplyWith trusts confident rules and asks the AI only below 0.5', async () => {
  let asked = 0
  const ai = async () => { asked++; return { kind: 'interview', status: 'interview', confidence: 0.9, quote: '' } }
  const sure = await classifyReplyWith('Unfortunately we will not be moving forward with your application.', ai)
  assert.equal(sure.kind, 'rejection')
  assert.equal(sure.source, 'rules')
  assert.equal(asked, 0)
  const vague = await classifyReplyWith('Hi, thanks for the chat.', ai)
  assert.equal(vague.kind, 'interview')
  assert.equal(vague.source, 'ai')
  assert.equal(asked, 1)
  const noAi = await classifyReplyWith('Hi, thanks for the chat.')
  assert.equal(noAi.kind, 'other')
  assert.equal(noAi.source, 'rules')
  const broken = await classifyReplyWith('Hi.', async () => { throw new Error('down') })
  assert.equal(broken.source, 'rules', 'an AI failure keeps the rule result')
})

test('storyText lays out a story as STAR+R lines, skipping blanks', () => {
  assert.equal(storyText({ title: 'Outage', situation: 'Prod down', task: '', action: 'Rolled back', result: 'Back in 5 min', reflection: '' }),
    'Outage\nSituation: Prod down\nAction: Rolled back\nResult: Back in 5 min')
})

test('packSummary counts ready answers and required gaps', () => {
  const pack = { answers: [
    { answer: 'Yes', required: true }, { answer: '', required: true }, { answer: '', required: false }, { answer: 'x', required: false }
  ] }
  assert.deepEqual(packSummary(pack), { total: 4, answered: 2, missing: 1 })
  assert.equal(packSummary(null), null)
})

test('cellText formats compare rows for the table', () => {
  const t = (k, v) => v ? `${k}:${JSON.stringify(v)}` : k
  const row = { title: 'Dev', company: 'Acme', location: 'Sydney', remote: 'hybrid', score: 4.25, match: 71.6, recommendation: 'apply',
    caps: ['no-sponsorship'], legitimacy: 'caution', salary: 'A$150k', gaps: ['Go', 'K8s'] }
  assert.ok(COMPARE_FIELDS.includes('score') && COMPARE_FIELDS.includes('gaps'))
  assert.equal(cellText(row, 'score', t), '4.3')
  assert.equal(cellText(row, 'match', t), '72%')
  assert.equal(cellText(row, 'recommendation', t), 'board.rec.apply')
  assert.equal(cellText(row, 'caps', t), 'compare.cap.no-sponsorship')
  assert.equal(cellText(row, 'legitimacy', t), 'compare.legit.caution')
  assert.equal(cellText(row, 'gaps', t), 'Go; K8s')
  assert.equal(cellText(row, 'salary', t), 'A$150k')
  const empty = { score: null, match: null, recommendation: '', caps: [], legitimacy: '', salary: '', gaps: [], remote: 'unknown' }
  for (const f of COMPARE_FIELDS) assert.equal(typeof cellText(empty, f, t), 'string')
  assert.equal(cellText(empty, 'score', t), '—')
  assert.equal(cellText(empty, 'legitimacy', t), '—')
})

test('every key the workspace and Compare use has English text (en.json + parts)', () => {
  const read = p => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'))
  const dir = new URL('../locales/_parts', import.meta.url)
  const parts = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')) : []
  const en = Object.assign(read('locales/en.json'), ...parts.map(f => read(`locales/_parts/${f}`)))
  const keys = ['job-workspace', 'compare-view'].flatMap(f => {
    const src = readFileSync(new URL(`../src/ui/${f}.js`, import.meta.url), 'utf8')
    return [...src.matchAll(/\bt\(\s*'([^'\n]+)'/g)].map(m => m[1])
  })
  const built = [
    ...TABS.map(k => `ws.tab.${k}`),
    ...['recruiter', 'hiring-manager', 'peer', 'other'].map(k => `ws.contact.kind.${k}`),
    ...['screen', 'interview', 'final', 'offer'].map(k => `ws.outcome.stage.${k}`),
    ...['follow-up', 'thank-you', 'check-in'].map(k => `ws.follow.kind.${k}`),
    ...['offer', 'rejection', 'interview', 'info-request', 'auto-ack', 'other'].map(k => `ws.reply.kind.${k}`),
    ...['base', 'currency', 'super', 'bonus', 'equity', 'deadline', 'notes'].map(k => `ws.offer.${k}`),
    ...['offeredVsDesired', 'offeredVsAdvertised', 'advertisedVsDesired'].map(k => `ws.gap.${k}`),
    ...['research', 'redflags', 'email', 'outreach', 'interview-prep', 'interview-plan', 'debrief', 'negotiate', 'offer-review', 'followup', 'compare'].map(m => `ws.mode.${m}`),
    ...COMPARE_FIELDS.map(f => `compare.field.${f}`),
    ...['no-sponsorship', 'closed', 'deal-breaker', 'role-mismatch'].map(c => `compare.cap.${c}`),
    ...['ok', 'caution', 'red-flag'].map(l => `compare.legit.${l}`),
    ...['apply', 'consider', 'skip'].map(r => `board.rec.${r}`)
  ]
  assert.deepEqual([...new Set([...keys, ...built])].filter(k => !(k in en)), [])
})
