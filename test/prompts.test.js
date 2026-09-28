import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as P from '../src/ai/prompts.js'

const SOURCE = '# Jo Doe\njo@doe.dev\n\n## Experience\n### Engineer | Acme | 2020 – 2022\n- Led the billing rewrite'
const JOB = { title: 'Staff Engineer', company: 'Globex', text: 'We need Go and Kubernetes.', keywords: ['Go', 'Kubernetes'] }
const text = p => p.system + '\n' + p.messages.map(m => m.content).join('\n')

const builders = {
  suggestPrompt: { source: SOURCE },
  rewritePrompt: { source: SOURCE, lines: [6], instruction: 'shorter' },
  tailorPrompt: { source: SOURCE, job: JOB },
  evaluatePrompt: { source: SOURCE, job: JOB },
  coverLetterPrompt: { source: SOURCE, job: JOB },
}

test('every CV prompt carries the rule, the grammar and the numbered source', () => {
  for (const [name, args] of Object.entries(builders)) {
    const p = P[name](args)
    const t = text(p)
    assert.ok(t.includes(P.NO_FABRICATION), name)
    assert.ok(t.includes(P.GRAMMAR), name)
    assert.ok(t.includes('6│ - Led the billing rewrite'), name)
    assert.ok(t.includes('1│ # Jo Doe'), name)
    assert.equal(p.messages[0].role, 'user')
    assert.equal(typeof p.json, 'object')
    assert.equal(p.json.type, 'object')
    assert.ok(p.json.title)
  }
})

test('the no-fabrication rule is the spec text', () => {
  assert.ok(P.NO_FABRICATION.startsWith('Only rephrase, reorder, cut or emphasise facts already present in the CV.'))
  assert.ok(P.NO_FABRICATION.endsWith('ask for it in `needsInput` instead of inventing it.'))
})

test('numberSource pads nothing and keeps blank lines', () => {
  assert.equal(P.numberSource('a\n\nb'), '1│ a\n2│ \n3│ b')
})

test('rewrite names the selected lines and maps instruction ids', () => {
  const t = text(P.rewritePrompt({ source: SOURCE, lines: [5, 6], instruction: 'quantify' }))
  assert.match(t, /lines 5, 6/)
  assert.match(t, /number/i)
  assert.match(text(P.rewritePrompt({ source: SOURCE, lines: [6], instruction: 'Make it punchy' })), /Make it punchy/)
})

test('job prompts include the posting', () => {
  for (const name of ['tailorPrompt', 'evaluatePrompt', 'coverLetterPrompt']) {
    const t = text(P[name]({ source: SOURCE, job: JOB }))
    assert.ok(t.includes('We need Go and Kubernetes.'), name)
    assert.ok(t.includes('Globex'), name)
  }
})

test('schemas match spec §6', () => {
  const s = P.suggestPrompt({ source: SOURCE }).json
  const item = s.properties.suggestions.items
  assert.deepEqual(item.required, ['line', 'expect', 'replacement', 'reason', 'category'])
  assert.deepEqual(item.properties.category.enum, ['impact', 'clarity', 'keyword', 'concision', 'grammar', 'structure'])
  const t = P.tailorPrompt({ source: SOURCE, job: JOB }).json
  assert.ok(t.properties.keywordsAdded && t.properties.summary)
  const e = P.evaluatePrompt({ source: SOURCE, job: JOB }).json
  assert.deepEqual(e.properties.recommendation.enum, ['apply', 'consider', 'skip'])
  const row = e.properties.rows.items.properties
  assert.deepEqual(row.importance.enum, ['critical', 'high', 'meaningful'])
  assert.deepEqual(row.match.enum, ['strong', 'partial', 'missing', 'na'])
  assert.deepEqual(e.properties.rows.items.properties.evidence.required, ['line', 'text'])
  for (const k of ['archetype', 'seniority', 'remote', 'tldr']) assert.ok(e.properties.role.properties[k], k)
  assert.deepEqual(P.coverLetterPrompt({ source: SOURCE, job: JOB }).json.required, ['paragraphs'])
})

test('extractJobPrompt returns the §3 shape schema and includes the text', () => {
  const p = P.extractJobPrompt({ text: 'Senior Go Engineer at Globex' })
  assert.ok(text(p).includes('Senior Go Engineer at Globex'))
  for (const k of ['title', 'company', 'location', 'requirements', 'keywords']) assert.ok(p.json.properties[k], k)
  assert.deepEqual(p.json.properties.requirements.items.properties.kind.enum, ['must', 'nice'])
})

test('evaluate prompt: two passes, the JD is untrusted data, local rows are passed on', () => {
  const t = text(P.evaluatePrompt({ source: SOURCE, job: JOB, rows: [{ jdSignal: 'We need Go and Kubernetes.', importance: 'critical' }] }))
  assert.match(t, /Evaluate how well this CV fits the job/)
  assert.match(t, /Pass 1/)
  assert.match(t, /Pass 2/)
  assert.match(t, /untrusted data/i)
  assert.ok(t.includes('[critical] We need Go and Kubernetes.'))
  assert.ok(t.indexOf('untrusted') < t.indexOf('Job posting:'))
})

// ---------- playbook ----------
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPlaybook } from '../src/ai/playbook.js'

const PLAYBOOK = {
  core: 'CORE-TEXT', writing: 'WRITING-TEXT', grammar: 'GRAMMAR-TEXT',
  modes: { review: 'MODE-review', rewrite: 'MODE-rewrite', tailor: 'MODE-tailor', evaluate: 'MODE-evaluate', coverLetter: 'MODE-coverLetter', extractJob: 'MODE-extractJob', answer: 'MODE-answer' },
}
const withPlaybook = {
  review: ['suggestPrompt', builders.suggestPrompt, true],
  rewrite: ['rewritePrompt', builders.rewritePrompt, true],
  tailor: ['tailorPrompt', builders.tailorPrompt, true],
  evaluate: ['evaluatePrompt', builders.evaluatePrompt, false],
  coverLetter: ['coverLetterPrompt', builders.coverLetterPrompt, true],
  extractJob: ['extractJobPrompt', { text: 'Go job' }, false],
  answer: ['answerPrompt', { source: SOURCE, job: JOB, questions: [{ label: 'Why us?' }] }, false],
}

test('with a playbook: core, writing (writing modes only), grammar, the mode file, then the rule', () => {
  for (const [mode, [name, args, writing]] of Object.entries(withPlaybook)) {
    const s = P[name](args, PLAYBOOK).system
    const at = k => s.indexOf(k)
    assert.ok(at('CORE-TEXT') === 0, mode)
    assert.equal(s.includes('WRITING-TEXT'), writing, mode)
    assert.ok(at('GRAMMAR-TEXT') > at('CORE-TEXT'), mode)
    assert.ok(at(`MODE-${mode}`) > at('GRAMMAR-TEXT'), mode)
    for (const other of Object.keys(PLAYBOOK.modes)) if (other !== mode) assert.ok(!s.includes(`MODE-${other}`), `${mode} has ${other}`)
    assert.ok(at(P.NO_FABRICATION) > at(`MODE-${mode}`), mode)
    assert.ok(!s.includes(P.FALLBACK), mode)
  }
})

test('without a playbook: the built-in FALLBACK text', () => {
  assert.equal(P.suggestPrompt({ source: SOURCE }).system, P.FALLBACK)
  assert.equal(P.suggestPrompt({ source: SOURCE }, null).system, P.FALLBACK)
  assert.ok(P.FALLBACK.includes(P.GRAMMAR) && P.FALLBACK.includes(P.NO_FABRICATION))
})

test('loadPlaybook reads every file through the injected reader; a missing file rejects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recto-pb-'))
  try {
    await mkdir(join(dir, 'agent/modes'), { recursive: true })
    const files = ['recto', 'writing', 'grammar', 'modes/review', 'modes/rewrite', 'modes/tailor', 'modes/evaluate', 'modes/cover-letter', 'modes/extract-job', 'modes/answer']
    for (const f of files) await writeFile(join(dir, `agent/${f}.md`), `# ${f}\n`)
    const { readFile } = await import('node:fs/promises')
    const read = p => readFile(join(dir, p), 'utf8')
    const pb = await loadPlaybook({ read })
    assert.equal(pb.core, '# recto')
    assert.equal(pb.modes.coverLetter, '# modes/cover-letter')
    assert.equal(pb.modes.extractJob, '# modes/extract-job')
    assert.equal(pb.modes.answer, '# modes/answer')
    await rm(join(dir, 'agent/modes/tailor.md'))
    await assert.rejects(loadPlaybook({ read }))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('the real playbook files load and go into prompts', { skip: !existsSync(new URL('../agent/modes/extract-job.md', import.meta.url)) && 'agent/ playbook not written yet' }, async () => {
  const pb = await loadPlaybook()
  for (const v of [pb.core, pb.writing, pb.grammar, ...Object.values(pb.modes)]) assert.ok(v.length > 0)
  const s = P.tailorPrompt(builders.tailorPrompt, pb).system
  assert.ok(s.includes(pb.core) && s.includes(pb.modes.tailor) && s.includes(P.NO_FABRICATION))
})

test('answerPrompt: numbered questions, CV, job and profile facts; rule and untrusted-data note; answers schema', () => {
  const p = P.answerPrompt({
    source: SOURCE, job: JOB,
    questions: [{ label: 'Why do you want to join Globex?' }, { label: 'Describe a project you are proud of.' }],
    profile: { city: 'Berlin', noticePeriod: '3 months', eeo: { gender: 'Female' }, email: 'jo@doe.dev' }
  })
  const t = text(p)
  assert.match(t, /1\. Why do you want to join Globex\?/)
  assert.match(t, /2\. Describe a project you are proud of\./)
  assert.ok(t.includes('6│ - Led the billing rewrite'))
  assert.ok(t.includes('We need Go and Kubernetes.'))
  assert.ok(t.includes('3 months') && t.includes('Berlin'))
  assert.ok(!t.includes('Female'), 'EEO answers never go to the model')
  assert.ok(t.includes(P.NO_FABRICATION))
  assert.match(p.system, /untrusted/)
  const item = p.json.properties.answers.items
  assert.deepEqual(item.required, ['n', 'answer'])
  assert.ok(item.properties.needsInput)
  assert.ok(!P.answerPrompt({ source: SOURCE, job: JOB, questions: [] }).system.includes(P.FALLBACK))
})
