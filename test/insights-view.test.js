import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { funnelCsv, titleSeeds, addTargetRole, RATE_KEYS, BRIEF_MODES_USED } from '../src/ui/insights-view.js'
import { buildActions } from '../src/ui/command-bar.js'
import { BRIEF_MODES } from '../src/ai/prompts.js'

test('funnelCsv: header plus one row per stage, rate as a percentage', () => {
  const csv = funnelCsv([{ stage: 'saved', count: 10, rate: 1 }, { stage: 'applied', count: 4, rate: 0.4 }, { stage: 'offer', count: 0, rate: 0 }])
  assert.equal(csv, 'stage,count,conversion %\nsaved,10,100\napplied,4,40\noffer,0,0\n')
  assert.equal(funnelCsv([]), 'stage,count,conversion %\n')
})

test('funnelCsv quotes cells with commas, quotes or newlines and neutralises formula prefixes', () => {
  const csv = funnelCsv([{ stage: 'a,"b"', count: 1, rate: 0.5 }, { stage: '=HYPERLINK()', count: 2, rate: 0 }])
  assert.equal(csv.split('\n')[1], '"a,""b""",1,50')
  assert.equal(csv.split('\n')[2], "'=HYPERLINK(),2,0")
})

test('titleSeeds: target roles, then evaluated archetypes (not "other"), deduped case-insensitively', () => {
  const jobs = [
    { evaluations: [{ role: { archetype: 'engineering' } }] },
    { evaluations: [{ role: { archetype: 'other' } }, { score: 4 }] },
    { evaluations: [{ role: { archetype: 'data' } }, { role: { archetype: 'design' } }] },
    { title: 'no evals' }
  ]
  assert.deepEqual(titleSeeds(jobs, { targetRoles: ['Frontend Engineer', 'frontend engineer', 'Data'] }),
    ['Frontend Engineer', 'Data', 'engineering', 'design'])
  assert.deepEqual(titleSeeds([], {}), [])
  assert.deepEqual(titleSeeds(undefined, undefined), [])
})

test('addTargetRole appends once (case-insensitive), trims, never mutates', () => {
  const p = { name: 'x', targetRoles: ['UI Engineer'] }
  const next = addTargetRole(p, '  Design Engineer ')
  assert.deepEqual(next.targetRoles, ['UI Engineer', 'Design Engineer'])
  assert.deepEqual(p.targetRoles, ['UI Engineer'])
  assert.equal(addTargetRole(p, 'ui engineer'), p)
  assert.equal(addTargetRole(p, '   '), p)
  assert.deepEqual(addTargetRole({}, 'Data Analyst').targetRoles, ['Data Analyst'])
})

test('the view asks only for brief modes the assistant knows', () => {
  for (const m of BRIEF_MODES_USED) assert.ok(BRIEF_MODES.includes(m), m)
  assert.deepEqual(RATE_KEYS, ['source', 'ats', 'band', 'remote'])
})

test('command bar: Insights, Pipeline inbox and Apply to all saved appear when wired; apply queues the saved jobs', () => {
  const t = (k, v) => v ? `${k}:${JSON.stringify(v)}` : k
  const store = { state: { doc: { sections: [] }, ui: {} }, setUi () {} }
  const calls = []
  const jobs = [{ id: 'a', status: 'saved' }, { id: 'b', status: 'applied' }, { id: 'c', status: 'saved' }]
  const ctx = {
    t, tracker: { list: () => jobs },
    openInsights: () => calls.push('insights'), openPipeline: () => calls.push('pipeline'),
    openApplyQueue: o => calls.push(o), openDiscover: () => calls.push('discover'), openProfileDialog: () => calls.push('profile')
  }
  const ids = buildActions(store, ctx).map(a => a.id)
  for (const id of ['app.insights', 'app.pipeline', 'app.applySaved', 'app.discover', 'app.profile']) assert.ok(ids.includes(id), id)
  const byId = id => buildActions(store, ctx).find(a => a.id === id)
  byId('app.insights').run()
  byId('app.pipeline').run()
  byId('app.applySaved').run()
  assert.deepEqual(calls, ['insights', 'pipeline', { jobIds: ['a', 'c'] }])
  // not wired, or nothing saved → left out (never shown disabled)
  const bare = buildActions(store, { t }).map(a => a.id)
  assert.ok(!bare.includes('app.insights') && !bare.includes('app.pipeline') && !bare.includes('app.applySaved'))
  const none = buildActions(store, { ...ctx, tracker: { list: () => [{ id: 'b', status: 'applied' }] } }).map(a => a.id)
  assert.ok(!none.includes('app.applySaved'))
})

test('every key the insights view and command bar use has English text (en.json + parts)', () => {
  const read = p => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'))
  const dir = new URL('../locales/_parts', import.meta.url)
  const parts = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')) : []
  const en = Object.assign(read('locales/en.json'), ...parts.map(f => read(`locales/_parts/${f}`)))
  const keys = ['src/ui/insights-view.js', 'src/ui/command-bar.js'].flatMap(f =>
    [...readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').matchAll(/\bt\(\s*'([^'\n]+)'/g)].map(m => m[1]))
  const built = [
    ...RATE_KEYS.map(k => `insights.by.${k}`),
    ...['saved', 'applied', 'responded', 'interview', 'offer'].map(s => `insights.stage.${s}`),
    ...['duplicate', 'refreshed'].map(r => `insights.repost.${r}`),
    ...['training', 'project'].map(m => `insights.advice.${m}`),
    ...['funnel', 'rates', 'calibration', 'rejections', 'reposts', 'gaps', 'titles', 'advice'].map(c => `insights.${c}`)
  ]
  assert.deepEqual([...keys, ...built].filter(k => !(k in en)), [])
})
