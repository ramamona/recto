import { test } from 'node:test'
import assert from 'node:assert/strict'
import { latestScore, filterJobs } from '../src/ui/jobs-dialog.js'

test('latestScore takes the newest evaluation of a kind', () => {
  const job = { evaluations: [{ kind: 'local', score: 40 }, { kind: 'ai', score: 3 }, { kind: 'local', score: 71 }, { kind: 'local' }] }
  assert.equal(latestScore(job, 'local'), 71)
  assert.equal(latestScore(job, 'ai'), 3)
  assert.equal(latestScore({ evaluations: [] }, 'ai'), null)
  assert.equal(latestScore({}, 'ai'), null)
})

test('filterJobs keeps all or one status', () => {
  const jobs = [{ id: 'a', status: 'saved' }, { id: 'b', status: 'applied' }]
  assert.deepEqual(filterJobs(jobs, '').map(j => j.id), ['a', 'b'])
  assert.deepEqual(filterJobs(jobs, 'applied').map(j => j.id), ['b'])
})
