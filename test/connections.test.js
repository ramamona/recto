import test from 'node:test'
import assert from 'node:assert/strict'

let n = 0
// Fresh module per test: its in-memory state stands in for a page load.
const load = () => import(`../src/ai/connections.js?${++n}`)
function memStorage(init = {}) {
  const m = new Map(Object.entries(init))
  return { m, getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }
}
const conn = { provider: 'openai', model: 'gpt-5', apiKey: 'sk-1', remember: false }

test('PROVIDER_IDS', async () => {
  assert.deepEqual((await load()).PROVIDER_IDS, ['anthropic', 'openai', 'openrouter', 'ollama', 'lmstudio', 'custom'])
})

test('connection lives in memory only unless remember', async () => {
  const c = await load()
  const storage = memStorage()
  assert.equal(c.getConnection({ storage }), null)
  c.setConnection(conn, { storage })
  assert.deepEqual(c.getConnection({ storage }), conn)
  assert.doesNotMatch(storage.m.get('recto:ai') ?? '', /sk-1/)
  const next = await load()
  assert.equal(next.getConnection({ storage }), null)
})

test('remember persists and restores; turning it off removes the key', async () => {
  const storage = memStorage()
  const c = await load()
  c.setConnection({ ...conn, remember: true }, { storage })
  assert.match(storage.m.get('recto:ai'), /sk-1/)
  const next = await load()
  assert.deepEqual(next.getConnection({ storage }), { ...conn, remember: true })
  next.setConnection(conn, { storage })
  assert.doesNotMatch(storage.m.get('recto:ai') ?? '', /sk-1/)
})

test('forgetConnection clears memory and storage', async () => {
  const storage = memStorage()
  const c = await load()
  c.setConnection({ ...conn, remember: true }, { storage })
  c.grantConsent('openai', { persist: true, storage })
  c.forgetConnection({ storage })
  assert.equal(c.getConnection({ storage }), null)
  assert.equal(storage.m.has('recto:ai'), false)
  assert.equal(c.hasConsent('openai', { storage }), false)
})

test('setConnection rejects unknown providers', async () => {
  const c = await load()
  assert.throws(() => c.setConnection({ provider: 'nope' }, { storage: memStorage() }))
})

test('consent: session-only vs persisted', async () => {
  const storage = memStorage()
  const c = await load()
  assert.equal(c.hasConsent('anthropic', { storage }), false)
  c.grantConsent('anthropic', { storage })
  assert.equal(c.hasConsent('anthropic', { storage }), true)
  assert.equal((await load()).hasConsent('anthropic', { storage }), false)
  c.grantConsent('ollama', { persist: true, storage })
  assert.equal((await load()).hasConsent('ollama', { storage }), true)
})

test('corrupt or unavailable storage never throws', async () => {
  const c = await load()
  assert.equal(c.getConnection({ storage: memStorage({ 'recto:ai': '{nope' }) }), null)
  const broken = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') }, removeItem() { throw new Error('denied') } }
  c.setConnection({ ...conn, remember: true }, { storage: broken })
  assert.deepEqual(c.getConnection({ storage: broken }), { ...conn, remember: true })
  c.forgetConnection({ storage: broken })
})
