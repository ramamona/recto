import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connectionLabel, connectionProblem, takeOAuthCode } from '../src/ui/ai-dialog.js'

const t = (key, vars) => vars ? `${key}(${Object.values(vars).join(',')})` : key

test('connectionLabel names the provider and model, or just AI', () => {
  assert.equal(connectionLabel(null, t), 'ai.button')
  assert.equal(connectionLabel({ provider: 'openai', model: 'gpt-5' }, t), 'ai.button.connected(ai.provider.openai,gpt-5)')
  assert.equal(connectionLabel({ provider: 'ollama', model: '' }, t), 'ai.button.connected(ai.provider.ollama,)')
})

test('connectionProblem enforces what each provider needs', () => {
  assert.equal(connectionProblem({ provider: 'custom', model: 'm', apiKey: '' }), 'baseUrl')
  assert.equal(connectionProblem({ provider: 'custom', model: 'm', baseUrl: 'ftp://x' }), 'baseUrl')
  assert.equal(connectionProblem({ provider: 'custom', model: 'm', baseUrl: 'http://127.0.0.1:9/v1' }), null)
  assert.equal(connectionProblem({ provider: 'openai', model: 'gpt-5' }), 'apiKey')
  assert.equal(connectionProblem({ provider: 'anthropic', model: 'x', apiKey: ' ' }), 'apiKey')
  assert.equal(connectionProblem({ provider: 'openrouter', model: 'a' }), 'signIn')
  assert.equal(connectionProblem({ provider: 'ollama', model: '' }), 'model')
  assert.equal(connectionProblem({ provider: 'ollama', model: 'llama3' }), null)
  assert.equal(connectionProblem({ provider: 'nope', model: 'x' }), 'provider')
  assert.equal(connectionProblem(null), 'provider')
  assert.equal(connectionProblem({ provider: 'custom', model: 'm', baseUrl: 'https://x/v1' }, { needModel: false }), null)
  assert.equal(connectionProblem({ provider: 'ollama', model: '' }, { needModel: false }), null)
})

test('takeOAuthCode reads ?code= and returns the URL without it', () => {
  assert.equal(takeOAuthCode('http://127.0.0.1:8710/'), null)
  assert.deepEqual(takeOAuthCode('http://127.0.0.1:8710/?code=abc&x=1#h'), { code: 'abc', url: 'http://127.0.0.1:8710/?x=1#h' })
  assert.deepEqual(takeOAuthCode('https://a.b/app/index.html?code=z'), { code: 'z', url: 'https://a.b/app/index.html' })
  assert.equal(takeOAuthCode('http://h/?code='), null)
})

test('every key the AI and Jobs dialogs use has English text', async () => {
  const { readFileSync, readdirSync, existsSync } = await import('node:fs')
  const { PROVIDER_IDS } = await import('../src/ai/connections.js')
  const { STATUSES } = await import('../src/jobs/tracker.js')
  const read = p => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'))
  // parts are merged into en.json after each wave (ai.error.* comes from the Suggest tab's part)
  const parts = existsSync(new URL('../locales/_parts', import.meta.url)) ? readdirSync(new URL('../locales/_parts', import.meta.url)) : []
  const en = Object.assign(read('locales/en.json'), ...parts.map(f => read(`locales/_parts/${f}`)))
  const src = ['src/ui/ai-dialog.js', 'src/ui/jobs-dialog.js', 'src/ui/topbar.js'].map(f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')).join('\n')
  const literal = [...src.matchAll(/\bt\(\s*'([^'\n]+)'/g), ...src.matchAll(/\?\s*'([a-z]+\.[^'\n]+)'\s*:\s*'([^'\n]+)'/g)].flatMap(m => m.slice(1))
  const built = [
    ...PROVIDER_IDS.flatMap(p => [`ai.provider.${p}`, `ai.provider.${p}.hint`]), 'ai.local.ollama', 'ai.local.lmstudio',
    ...['provider', 'baseUrl', 'apiKey', 'signIn', 'model'].map(p => `ai.problem.${p}`),
    ...['no-client', 'auth', 'rate-limit', 'network', 'cors', 'bad-response', 'aborted'].map(c => `ai.error.${c}`),
    ...STATUSES.map(s => `jobs.status.${s}`),
    ...['company', 'title', 'status', 'local', 'ai', 'docs', 'updated', 'actions'].map(c => `jobs.col.${c}`),
    ...['invalid-json', 'invalid-job', 'duplicate'].map(c => `jobs.import.${c}`),
  ]
  assert.deepEqual([...literal, ...built].filter(k => !(k in en)), [])
})
