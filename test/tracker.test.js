import test from 'node:test'
import assert from 'node:assert/strict'
import { createTracker } from '../src/jobs/tracker.js'

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
