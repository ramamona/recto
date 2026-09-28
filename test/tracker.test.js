import test from 'node:test'
import assert from 'node:assert/strict'
import { createTracker, STATUSES, staleApplied } from '../src/jobs/tracker.js'

function memStorage(init = {}) {
  const m = new Map(Object.entries(init))
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), map: m }
}

let clock = 0
const now = () => new Date(Date.UTC(2026, 8, 25, 0, 0, clock++))

test('save fills defaults, get/list/remove round-trip through storage', () => {
  const s = memStorage()
  const t = createTracker(s, { now })
  const a = t.save({ title: 'Engineer', company: 'Acme', text: 'JD', source: 'paste' })
  assert.match(a.id, /\w/)
  assert.equal(a.status, 'saved')
  assert.deepEqual([a.docIds, a.evaluations, a.notes], [[], [], ''])
  assert.equal(a.createdAt, a.updatedAt)
  const b = t.save({ title: 'Designer', company: 'Brightside' })
  assert.deepEqual(t.list().map(j => j.id), [b.id, a.id], 'most recently updated first')
  assert.ok(JSON.parse(s.map.get('recto:jobs')).length === 2)
  const again = createTracker(s, { now })
  assert.equal(again.get(a.id).title, 'Engineer')
  const upd = again.save({ ...again.get(a.id), status: 'applied' })
  assert.equal(upd.createdAt, a.createdAt)
  assert.ok(upd.updatedAt > a.updatedAt)
  assert.equal(again.list()[0].id, a.id)
  assert.equal(again.remove(a.id), true)
  assert.equal(again.remove(a.id), false)
  assert.equal(again.get(a.id), null)
})

test('invalid status falls back to saved', () => {
  const t = createTracker(memStorage(), { now })
  assert.equal(t.save({ title: 'x', status: 'hacked' }).status, 'saved')
})

test('addEvaluation appends with a timestamp; link dedupes doc ids', () => {
  const t = createTracker(memStorage(), { now })
  const j = t.save({ title: 'x' })
  t.addEvaluation(j.id, { kind: 'local', score: 71 })
  const ev = t.addEvaluation(j.id, { kind: 'ai', score: 4, recommendation: 'apply' }).evaluations
  assert.deepEqual(ev.map(e => [e.kind, e.score]), [['local', 71], ['ai', 4]])
  assert.ok(ev.every(e => typeof e.at === 'string'))
  t.link(j.id, 'doc1')
  assert.deepEqual(t.link(j.id, 'doc1').docIds, ['doc1'])
  assert.equal(t.addEvaluation('nope', {}), null)
  assert.equal(t.link('nope', 'd'), null)
})

test('corrupt storage never throws and reads as empty', () => {
  for (const raw of ['{not json', '"str"', '{"a":1}', '[1,null,"x",{"noid":true}]']) {
    const t = createTracker(memStorage({ 'recto:jobs': raw }), { now })
    assert.deepEqual(t.list(), [], raw)
    assert.equal(t.get('x'), null)
  }
  const throwing = { getItem() { throw new Error('denied') }, setItem() {} }
  assert.deepEqual(createTracker(throwing).list(), [])
})

test('export → import into an empty tracker restores jobs; duplicates and junk are reported', () => {
  const t = createTracker(memStorage(), { now })
  const a = t.save({ title: 'Engineer', company: 'Acme' })
  t.addEvaluation(a.id, { kind: 'local', score: 50 })
  const json = t.export()
  assert.equal(JSON.parse(json).format, 'recto-jobs')
  const u = createTracker(memStorage(), { now })
  assert.deepEqual(u.import(json), { added: 1, warnings: [] })
  assert.deepEqual(u.get(a.id), t.get(a.id))
  const again = u.import(json)
  assert.equal(again.added, 0)
  assert.deepEqual(again.warnings, [{ code: 'duplicate', index: 0 }])
  const junk = u.import(JSON.stringify([{ title: 'Plain array ok' }, 5, { status: 'x' }]))
  assert.equal(junk.added, 1)
  assert.deepEqual(junk.warnings, [{ code: 'invalid-job', index: 1 }, { code: 'invalid-job', index: 2 }])
  assert.deepEqual(u.import('nope'), { added: 0, warnings: [{ code: 'invalid-json' }] })
})

test('status enum has no-response; statusHistory records creation and every status change', () => {
  assert.deepEqual(STATUSES, ['saved', 'applied', 'interview', 'offer', 'rejected', 'no-response', 'skipped'])
  const t = createTracker(memStorage(), { now })
  const a = t.save({ title: 'x' })
  assert.deepEqual(a.statusHistory, [{ status: 'saved', at: a.createdAt }])
  const same = t.save({ ...a, notes: 'n' })
  assert.equal(same.statusHistory.length, 1, 'no entry without a status change')
  const b = t.save({ ...same, status: 'applied', statusHistory: [] })
  assert.deepEqual(b.statusHistory.map(h => h.status), ['saved', 'applied'], 'stored history wins over the passed one')
  assert.equal(b.statusHistory[1].at, b.updatedAt)
  assert.deepEqual(t.save({ ...b, status: 'no-response' }).statusHistory.map(h => h.status), ['saved', 'applied', 'no-response'])
})

test('stored and imported jobs without history migrate to one entry', () => {
  const old = { id: 'j1', title: 'Old', status: 'applied', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' }
  const t = createTracker(memStorage({ 'recto:jobs': JSON.stringify([old]) }), { now })
  assert.deepEqual(t.get('j1').statusHistory, [{ status: 'applied', at: old.updatedAt }])
  assert.deepEqual(t.list()[0].statusHistory, [{ status: 'applied', at: old.updatedAt }])
  const u = createTracker(memStorage(), { now })
  u.import(JSON.stringify([{ ...old, id: 'j2', statusHistory: [{ status: 'bogus', at: 1 }] }]))
  assert.deepEqual(u.get('j2').statusHistory, [{ status: 'applied', at: old.updatedAt }])
})

test('staleApplied: applied with no status change for 21 days (default)', () => {
  const at = '2026-09-01T00:00:00.000Z'
  const job = { status: 'applied', statusHistory: [{ status: 'saved', at: '2026-08-01T00:00:00.000Z' }, { status: 'applied', at }], updatedAt: '2026-09-20T00:00:00.000Z' }
  assert.equal(staleApplied(job, new Date('2026-09-21T00:00:00.000Z')), false)
  assert.equal(staleApplied(job, new Date('2026-09-22T00:00:00.000Z')), true)
  assert.equal(staleApplied(job, Date.parse('2026-09-10T00:00:00.000Z'), 7), true)
  assert.equal(staleApplied({ ...job, status: 'interview' }, new Date('2026-12-01')), false)
  assert.equal(staleApplied({ status: 'applied', updatedAt: at }, new Date('2026-10-01')), true, 'falls back to updatedAt')
  assert.equal(staleApplied(null, new Date()), false)
})

test('discover fields and the application pack survive save, reload, export and import; junk is dropped', () => {
  const s = memStorage()
  const t = createTracker(s, { now })
  const pack = { jobId: 'remotive:remotive:1', cvDocId: 'doc1', fields: [{ label: 'Email', value: 'a@b.c' }], answers: [{ question: 'Why?', answer: '', source: 'unanswered' }], pdfName: 'A-CV.pdf' }
  const questions = [{ label: 'Resume', type: 'input_file', required: true }]
  const a = t.save({ id: 'remotive:remotive:1', source: 'remotive', title: 'x', applyUrl: 'https://x.example/apply', board: 'remotive', questions, pack })
  assert.deepEqual([a.source, a.applyUrl, a.board, a.questions, a.pack], ['remotive', 'https://x.example/apply', 'remotive', questions, pack])
  assert.equal(t.save({ title: 'y', source: 'arbeitnow' }).source, 'arbeitnow')
  assert.deepEqual(createTracker(s, { now }).get(a.id).pack, pack, 'kept in storage')
  const u = createTracker(memStorage(), { now })
  u.import(t.export())
  assert.deepEqual(u.get(a.id), t.get(a.id))
  const junk = t.save({ title: 'z', applyUrl: 'javascript:alert(1)', board: 5, questions: [null, { type: 'x' }, 'q'], pack: { answers: 'no' } })
  assert.deepEqual(['applyUrl', 'board', 'questions', 'pack'].filter(k => k in junk), [])
  const many = t.save({ title: 'm', questions: Array.from({ length: 150 }, (_, i) => ({ label: `Q${i}` })), pack: { ...pack, answers: [{ question: 'x'.repeat(300_000) }] } })
  assert.equal(many.questions.length, 100)
  assert.equal(many.pack, undefined, 'oversized pack dropped')
})
