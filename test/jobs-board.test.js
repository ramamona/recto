import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { COLUMNS, groupJobs, stepStatus, daysSince, scoresOf, latestEvaluation } from '../src/ui/jobs-board.js'

test('columns follow the tracker order, Skipped last', () => {
  assert.deepEqual(COLUMNS, ['saved', 'applied', 'interview', 'offer', 'rejected', 'no-response', 'skipped'])
})

test('groupJobs buckets by status and filters by search across title, company, location, notes', () => {
  const jobs = [
    { id: 'a', status: 'saved', title: 'Data Engineer', company: 'Acme', location: 'Berlin', notes: '' },
    { id: 'b', status: 'applied', title: 'Designer', company: 'Globex', location: 'Remote', notes: 'referral from Kim' },
    { id: 'c', status: 'bogus', title: 'X', company: 'Y' }
  ]
  const all = groupJobs(jobs, '')
  assert.deepEqual(Object.keys(all), COLUMNS)
  assert.deepEqual(all.saved.map(j => j.id), ['a', 'c'])
  assert.deepEqual(all.applied.map(j => j.id), ['b'])
  assert.deepEqual(groupJobs(jobs, '  acme ').saved.map(j => j.id), ['a'])
  assert.deepEqual(groupJobs(jobs, 'KIM').applied.map(j => j.id), ['b'])
  assert.deepEqual(groupJobs(jobs, 'berlin').applied, [])
})

test('stepStatus moves one column left or right and stops at the edges', () => {
  assert.equal(stepStatus('saved', 1), 'applied')
  assert.equal(stepStatus('applied', -1), 'saved')
  assert.equal(stepStatus('saved', -1), null)
  assert.equal(stepStatus('no-response', 1), 'skipped')
  assert.equal(stepStatus('skipped', 1), null)
})

test('daysSince counts whole days from the last status change', () => {
  const now = new Date('2026-09-25T12:00:00Z')
  assert.equal(daysSince({ statusHistory: [{ status: 'saved', at: '2026-09-01T00:00:00Z' }, { status: 'applied', at: '2026-09-20T11:00:00Z' }] }, now), 5)
  assert.equal(daysSince({ updatedAt: '2026-09-25T01:00:00Z' }, now), 0)
  assert.equal(daysSince({}, now), null)
})

test('scoresOf reads the newest match estimate and prefers the AI star score over the local one', () => {
  assert.deepEqual(scoresOf({}), { match: null, stars: null })
  const legacy = { evaluations: [{ kind: 'local', score: 64 }, { kind: 'ai', score: 4 }] }
  assert.deepEqual(scoresOf(legacy), { match: 64, stars: { score: 4, source: 'ai' } })
  const local = { evaluations: [{ source: 'local', score: 3.2, match: { score: 71 } }] }
  assert.deepEqual(scoresOf(local), { match: 71, stars: { score: 3.2, source: 'local' } })
  const both = { evaluations: [{ source: 'ai', score: 4.1 }, { source: 'local', score: 2.5, match: { score: 50 } }] }
  assert.deepEqual(scoresOf(both), { match: 50, stars: { score: 4.1, source: 'ai' } })
})

test('scoresOf reads the shapes job-panel really writes', async () => {
  const { evaluationRecord } = await import('../src/ui/job-panel.js')
  const stored = evaluationRecord({ source: 'local', score: 3.4, recommendation: 'apply', match: { score: 99 } })
  assert.equal('match' in stored, false)
  const quick = { at: '2026-09-01T00:00:00Z', source: 'local', score: 3.1, recommendation: 'apply', match: 68 }
  assert.deepEqual(scoresOf({ evaluations: [quick, stored] }), { match: 68, stars: { score: 3.4, source: 'local' } })
  assert.deepEqual(scoresOf({ evaluations: [stored] }), { match: null, stars: { score: 3.4, source: 'local' } })
  const ai = evaluationRecord({ source: 'ai', score: 4.2 })
  assert.deepEqual(scoresOf({ evaluations: [quick, ai] }), { match: 68, stars: { score: 4.2, source: 'ai' } })
})

test('latestEvaluation filters on source, newest first', () => {
  const a = { source: 'local', score: 3 }
  const b = { source: 'ai', score: 4 }
  assert.equal(latestEvaluation({ evaluations: [a, b, { kind: 'local', score: 80 }] }), b)
  assert.equal(latestEvaluation({ evaluations: [{ kind: 'ai', score: 4 }] }), null)
  assert.equal(latestEvaluation({}), null)
})

test('every key the board uses has English text (en.json + parts)', () => {
  const read = p => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'))
  const dir = new URL('../locales/_parts', import.meta.url)
  const parts = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')) : []
  const en = Object.assign(read('locales/en.json'), ...parts.map(f => read(`locales/_parts/${f}`)))
  const src = readFileSync(new URL('../src/ui/jobs-board.js', import.meta.url), 'utf8')
  const literal = [...src.matchAll(/\bt\(\s*'([^'\n]+)'/g)].map(m => m[1])
  const built = [
    ...COLUMNS.map(s => `jobs.status.${s}`),
    'board.source.ai', 'board.source.local',
    ...['apply', 'consider', 'skip'].map(r => `board.rec.${r}`),
    ...['no-sponsorship', 'closed', 'deal-breaker'].map(c => `board.cap.${c}`),
    ...['caution', 'red-flag'].map(l => `board.legit.${l}`),
    ...['invalid-json', 'invalid-job', 'duplicate'].map(c => `jobs.import.${c}`)
  ]
  assert.deepEqual([...literal, ...built].filter(k => !(k in en)), [])
})
