import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { splitInput, urlKey, dedupeItems, ITEM_STATES } from '../src/ui/pipeline-view.js'
import { selectAbove } from '../src/ui/discover-view.js'

test('splitInput: one URL per line, JDs separated by blank lines', () => {
  const text = [
    'https://jobs.lever.co/acme/1',
    '  https://boards.greenhouse.io/x/jobs/2  ',
    '',
    '',
    'Senior Engineer at Acme',
    'We need TypeScript.',
    'Apply: https://acme.com/apply',
    '',
    'https://jobs.ashbyhq.com/y/3'
  ].join('\n')
  assert.deepEqual(splitInput(text), [
    { kind: 'url', value: 'https://jobs.lever.co/acme/1' },
    { kind: 'url', value: 'https://boards.greenhouse.io/x/jobs/2' },
    { kind: 'text', value: 'Senior Engineer at Acme\nWe need TypeScript.\nApply: https://acme.com/apply' },
    { kind: 'url', value: 'https://jobs.ashbyhq.com/y/3' }
  ])
  assert.deepEqual(splitInput('  \n\r\n '), [])
  assert.deepEqual(splitInput(undefined), [])
  // Windows line endings, whitespace-only separator lines
  assert.deepEqual(splitInput('JD one\r\n  \r\nJD two').map(i => i.value), ['JD one', 'JD two'])
})

test('urlKey normalises for dedupe: host case, hash, trailing slash; keeps the query', () => {
  assert.equal(urlKey('https://Boards.Greenhouse.io/x/jobs/2/#apply'), 'https://boards.greenhouse.io/x/jobs/2')
  assert.equal(urlKey('https://acme.com/careers?gh_jid=7'), 'https://acme.com/careers?gh_jid=7')
  assert.notEqual(urlKey('https://acme.com/careers?gh_jid=7'), urlKey('https://acme.com/careers?gh_jid=8'))
  assert.equal(urlKey('not a url'), '')
  assert.equal(urlKey('javascript:alert(1)'), '')
})

test('dedupeItems drops URLs already tracked (url or applyUrl) or repeated in the input; JD texts dedupe exactly', () => {
  const jobs = [{ id: 'a', url: 'https://jobs.lever.co/acme/1/' }, { id: 'b', url: '', applyUrl: 'https://acme.com/apply#x' }, { id: 'c' }]
  const items = [
    { kind: 'url', value: 'https://jobs.lever.co/acme/1' },
    { kind: 'url', value: 'https://acme.com/apply' },
    { kind: 'url', value: 'https://new.example/job/9' },
    { kind: 'url', value: 'https://NEW.example/job/9#top' },
    { kind: 'text', value: 'JD one' },
    { kind: 'text', value: 'JD one' },
    { kind: 'text', value: 'JD two' }
  ]
  const { fresh, duplicates } = dedupeItems(items, jobs)
  assert.deepEqual(fresh.map(i => i.value), ['https://new.example/job/9', 'JD one', 'JD two'])
  assert.deepEqual(duplicates.map(d => [d.value, d.jobId ?? null]), [
    ['https://jobs.lever.co/acme/1', 'a'], ['https://acme.com/apply', 'b'], ['https://NEW.example/job/9#top', null], ['JD one', null]
  ])
  // queued items count as "seen" too
  assert.deepEqual(dedupeItems([{ kind: 'url', value: 'https://q.example/1' }], [], [{ kind: 'url', value: 'https://q.example/1/' }]).fresh, [])
  assert.deepEqual(dedupeItems([], undefined), { fresh: [], duplicates: [] })
})

test('selectAbove picks the ids of results at or above the ★ threshold', () => {
  const r = (id, score) => ({ posting: { id }, evaluation: score == null ? undefined : { score } })
  assert.deepEqual(selectAbove([r('a', 4.2), r('b', 3.9), r('c', 4), r('d')], 4), ['a', 'c'])
  assert.deepEqual(selectAbove([], 4), [])
})

test('every key the pipeline and discover selection use has English text (en.json + parts)', () => {
  const read = p => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'))
  const dir = new URL('../locales/_parts', import.meta.url)
  const parts = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')) : []
  const en = Object.assign(read('locales/en.json'), ...parts.map(f => read(`locales/_parts/${f}`)))
  const keys = ['src/ui/pipeline-view.js', 'src/ui/discover-view.js'].flatMap(f =>
    [...readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').matchAll(/\bt\(\s*'([^'\n]+)'/g)].map(m => m[1]))
  const built = [...ITEM_STATES.map(s => `pipeline.state.${s}`), ...['fetch', 'evaluate', 'save', 'pack'].map(s => `pipeline.step.${s}`)]
  assert.deepEqual([...keys, ...built].filter(k => !(k in en)), [])
})
