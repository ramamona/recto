import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCsv, isLinkedInApplications, linkedinApplications } from '../src/jobs/linkedin.js'
import { createTracker } from '../src/jobs/tracker.js'

const CSV = [
  'Application Date,Contact Email,Contact Phone Number,Company Name,Job Title,Job Url,Resume Name,Question and Answers',
  '2026-03-14 10:22:01 UTC,,,Acme,"Engineer, Platform",https://www.linkedin.com/jobs/view/123/,cv.pdf,"Q: ""Years?"" A: 5"',
  '2026-03-15 09:00:00 UTC,,,Brightside,Designer,,cv.pdf,',
  ',,,,,,,',
  ''
].join('\r\n')

test('parseCsv handles quotes, escaped quotes, CRLF and blank rows', () => {
  const rows = parseCsv('﻿a,"b,c","d ""e"""\r\n1,"multi\nline",3\n\n')
  assert.deepEqual(rows, [['a', 'b,c', 'd "e"'], ['1', 'multi\nline', '3']])
})

test('detects LinkedIn applications CSV and rejects other files', () => {
  assert.equal(isLinkedInApplications(CSV), true)
  assert.equal(isLinkedInApplications('{"format":"recto-jobs","jobs":[]}'), false)
  assert.equal(isLinkedInApplications('Company Name,Other\nAcme,1'), false)
})

test('maps rows to applied jobs with link and application date, skipping blank rows', () => {
  const [a, b] = linkedinApplications(CSV)
  assert.equal(linkedinApplications(CSV).length, 2)
  assert.deepEqual([a.title, a.company, a.url, a.status, a.source], ['Engineer, Platform', 'Acme', 'https://www.linkedin.com/jobs/view/123/', 'applied', 'linkedin'])
  assert.equal(a.createdAt, '2026-03-14T10:22:01.000Z')
  assert.equal(b.url, '')
  assert.match(b.id, /^linkedin:Brightside\|Designer\|/)
})

test('imports into the tracker as applied; re-import reports duplicates, not copies', () => {
  const store = new Map()
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) }
  const t = createTracker(storage)
  assert.deepEqual(t.import(linkedinApplications(CSV)), { added: 2, warnings: [] })
  const [job] = t.list().filter(j => j.company === 'Acme')
  assert.deepEqual([job.status, job.source], ['applied', 'linkedin'])
  assert.equal(job.statusHistory[0].status, 'applied')
  const again = t.import(linkedinApplications(CSV))
  assert.equal(again.added, 0)
  assert.deepEqual(again.warnings.map(w => w.code), ['duplicate', 'duplicate'])
  assert.equal(t.list().length, 2)
})
