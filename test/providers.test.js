import test from 'node:test'
import assert from 'node:assert/strict'
import { createClient, PROVIDERS, pkceChallenge, startOpenRouterSignIn, finishOpenRouterSignIn } from '../src/ai/providers.js'

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// Records every call; `reply` is a Response, a function (url, init, n) → Response, or an Error to throw.
function stub(reply) {
  const calls = []
  const fetch = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined })
    const r = typeof reply === 'function' ? reply(url, init, calls.length) : reply
    if (r instanceof Error) throw r
    return r
  }
  return { fetch, calls }
}

const openaiReply = (content, extra = {}) => json({ choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 5, completion_tokens: 2 }, ...extra })
const schema = { title: 'suggestions', type: 'object', properties: { suggestions: { type: 'array' } }, required: ['suggestions'] }

test('PROVIDERS lists the six connection types', () => {
  assert.deepEqual(Object.keys(PROVIDERS), ['anthropic', 'openai', 'openrouter', 'ollama', 'lmstudio', 'custom'])
  assert.equal(PROVIDERS.anthropic.defaultModel, 'claude-sonnet-5')
})

test('anthropic: request shape, text response, usage', async () => {
  const s = stub(json({ content: [{ type: 'text', text: 'Hello' }], usage: { input_tokens: 3, output_tokens: 1 } }))
  const c = createClient({ provider: 'anthropic', model: 'claude-sonnet-5', apiKey: 'sk-a' }, { fetch: s.fetch })
  const r = await c.complete({ system: 'sys', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 })
  assert.deepEqual(r, { text: 'Hello', usage: { inputTokens: 3, outputTokens: 1 } })
  const { url, init, body } = s.calls[0]
  assert.equal(url, 'https://api.anthropic.com/v1/messages')
  assert.equal(init.method, 'POST')
  assert.equal(init.headers['x-api-key'], 'sk-a')
  assert.equal(init.headers['anthropic-version'], '2023-06-01')
  assert.equal(init.headers['anthropic-dangerous-direct-browser-access'], 'true')
  assert.deepEqual(body, { model: 'claude-sonnet-5', max_tokens: 100, system: 'sys', messages: [{ role: 'user', content: 'hi' }] })
})

test('anthropic: json via forced tool call', async () => {
  const s = stub(json({ content: [{ type: 'tool_use', name: 'suggestions', input: { suggestions: [1] } }] }))
  const c = createClient({ provider: 'anthropic', model: 'claude-sonnet-5', apiKey: 'k' }, { fetch: s.fetch })
  const r = await c.complete({ system: 's', messages: [{ role: 'user', content: 'x' }], json: schema })
  assert.deepEqual(r.json, { suggestions: [1] })
  assert.equal(r.text, '{"suggestions":[1]}')
  const b = s.calls[0].body
  assert.deepEqual(b.tools, [{ name: 'suggestions', description: 'Return the result as JSON matching this schema.', input_schema: schema }])
  assert.deepEqual(b.tool_choice, { type: 'tool', name: 'suggestions' })
})

test('anthropic: models without forced tool choice use auto and still read the tool call', async () => {
  const s = stub(json({ content: [{ type: 'thinking', thinking: '' }, { type: 'tool_use', name: 'suggestions', input: { suggestions: [] } }] }))
  const c = createClient({ provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'k' }, { fetch: s.fetch })
  const r = await c.complete({ messages: [{ role: 'user', content: 'x' }], json: schema })
  assert.deepEqual(s.calls[0].body.tool_choice, { type: 'auto' })
  assert.match(s.calls[0].body.system, /suggestions tool/)
  assert.deepEqual(r.json, { suggestions: [] })
})

test('anthropic: json falls back to tolerant parse of text', async () => {
  const s = stub(json({ content: [{ type: 'text', text: '```json\n{"suggestions":[2]}\n```' }] }))
  const c = createClient({ provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'k' }, { fetch: s.fetch })
  assert.deepEqual((await c.complete({ messages: [], json: schema })).json, { suggestions: [2] })
})

test('anthropic: web_fetch server tool', async () => {
  const s = stub(json({ content: [{ type: 'server_tool_use', name: 'web_fetch' }, { type: 'web_fetch_tool_result' }, { type: 'text', text: 'Job text' }] }))
  const c = createClient({ provider: 'anthropic', model: 'claude-sonnet-5', apiKey: 'k' }, { fetch: s.fetch })
  const r = await c.complete({ messages: [{ role: 'user', content: 'Fetch https://x.test/job' }], tools: ['web_fetch'] })
  assert.equal(r.text, 'Job text')
  assert.deepEqual(s.calls[0].body.tools, [{ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 3 }])
  const h = createClient({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'k' }, { fetch: stub(json({ content: [] })).fetch })
  await h.complete({ messages: [], tools: ['web_fetch'] }) // older model uses the basic variant (no throw)
})

test('anthropic: listModels is the static list', async () => {
  const c = createClient({ provider: 'anthropic', apiKey: 'k' }, { fetch: () => { throw new Error('no network') } })
  assert.deepEqual(await c.listModels(), ['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'])
})

test('openai: request shape, json_schema response_format, parse', async () => {
  const s = stub(openaiReply('{"suggestions":[]}'))
  const c = createClient({ provider: 'openai', model: 'gpt-5', apiKey: 'sk-o' }, { fetch: s.fetch })
  const r = await c.complete({ system: 'sys', messages: [{ role: 'user', content: 'hi' }], json: schema, maxTokens: 50 })
  assert.deepEqual(r, { text: '{"suggestions":[]}', json: { suggestions: [] }, usage: { inputTokens: 5, outputTokens: 2 } })
  const { url, init, body } = s.calls[0]
  assert.equal(url, 'https://api.openai.com/v1/chat/completions')
  assert.equal(init.headers.authorization, 'Bearer sk-o')
  assert.deepEqual(body, {
    model: 'gpt-5', max_completion_tokens: 50, // OpenAI rejects max_tokens on gpt-5 / o-series
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
    response_format: { type: 'json_schema', json_schema: { name: 'suggestions', schema } },
  })
})

test('openai-compatible: 400 on response_format falls back to JSON-only prompt, once per client', async () => {
  const s = stub((url, init, n) => n === 1 ? json({ error: { message: 'response_format not supported' } }, 400) : openaiReply('Sure! {"suggestions":[3]} hope it helps'))
  const c = createClient({ provider: 'lmstudio', model: 'm' }, { fetch: s.fetch })
  const r = await c.complete({ system: 'sys', messages: [{ role: 'user', content: 'x' }], json: schema })
  assert.deepEqual(r.json, { suggestions: [3] })
  assert.equal(s.calls.length, 2)
  assert.equal(s.calls[1].body.response_format, undefined)
  assert.match(s.calls[1].body.messages[0].content, /^sys\n\nReply with JSON only/)
  await c.complete({ messages: [], json: schema })
  assert.equal(s.calls.length, 3)
  assert.equal(s.calls[2].body.response_format, undefined)
})

test('openai-compatible: unparseable json output leaves json undefined (caller retries)', async () => {
  const c = createClient({ provider: 'ollama', model: 'm' }, { fetch: stub(openaiReply('no json here')).fetch })
  const r = await c.complete({ messages: [], json: schema })
  assert.equal(r.text, 'no json here')
  assert.equal(r.json, undefined)
})

test('endpoints: openrouter, ollama, lmstudio, custom', async () => {
  const cases = [
    [{ provider: 'openrouter', model: 'm', apiKey: 'or' }, 'https://openrouter.ai/api/v1/chat/completions', 'Bearer or'],
    [{ provider: 'ollama', model: 'm' }, 'http://localhost:11434/v1/chat/completions', undefined],
    [{ provider: 'lmstudio', model: 'm' }, 'http://localhost:1234/v1/chat/completions', undefined],
    [{ provider: 'custom', model: 'm', baseUrl: 'https://gw.test/v1/' }, 'https://gw.test/v1/chat/completions', undefined],
    [{ provider: 'custom', model: 'm', baseUrl: 'https://gw.test/v1', apiKey: 'ck' }, 'https://gw.test/v1/chat/completions', 'Bearer ck'],
  ]
  for (const [conn, url, auth] of cases) {
    const s = stub(openaiReply('ok'))
    assert.equal((await createClient(conn, { fetch: s.fetch }).complete({ messages: [] })).text, 'ok')
    assert.equal(s.calls[0].url, url)
    assert.equal(s.calls[0].init.headers.authorization, auth)
  }
  const s = stub(openaiReply('ok'))
  await createClient({ provider: 'ollama', model: 'm' }, { fetch: s.fetch }).complete({ messages: [], maxTokens: 9 })
  assert.equal(s.calls[0].body.max_tokens, 9)
})

test('listModels per OpenAI-compatible provider', async () => {
  const data = { data: [{ id: 'gpt-5' }, { id: 'text-embedding-3-small' }, { id: 'o4-mini' }, { id: 'whisper-1' }, { id: 'gpt-4o-realtime-preview' }, { id: 'dall-e-3' }] }
  const o = stub(json(data))
  assert.deepEqual(await createClient({ provider: 'openai', apiKey: 'k' }, { fetch: o.fetch }).listModels(), ['gpt-5', 'o4-mini'])
  assert.equal(o.calls[0].url, 'https://api.openai.com/v1/models')
  assert.equal(o.calls[0].init.headers.authorization, 'Bearer k')
  for (const [conn, url] of [
    [{ provider: 'openrouter' }, 'https://openrouter.ai/api/v1/models'],
    [{ provider: 'ollama' }, 'http://localhost:11434/v1/models'],
    [{ provider: 'lmstudio' }, 'http://localhost:1234/v1/models'],
    [{ provider: 'custom', baseUrl: 'http://127.0.0.1:8000/v1' }, 'http://127.0.0.1:8000/v1/models'],
  ]) {
    const s = stub(json({ data: [{ id: 'b' }, { id: 'a' }] }))
    assert.deepEqual(await createClient(conn, { fetch: s.fetch }).listModels(), ['a', 'b'])
    assert.equal(s.calls[0].url, url)
  }
})

test('error normalization', async () => {
  const code = async (conn, reply, opts = {}) => {
    try { await createClient(conn, { fetch: stub(reply).fetch }).complete({ messages: [], ...opts }) } catch (e) { return e.code }
    return 'no-error'
  }
  const a = { provider: 'anthropic', model: 'm', apiKey: 'k' }
  const o = { provider: 'openai', model: 'm', apiKey: 'k' }
  assert.equal(await code(a, json({ error: { message: 'bad key' } }, 401)), 'auth')
  assert.equal(await code(o, json({}, 403)), 'auth')
  assert.equal(await code(a, json({}, 429)), 'rate-limit')
  assert.equal(await code(o, json({}, 429)), 'rate-limit')
  assert.equal(await code(o, json({}, 500)), 'bad-response')
  assert.equal(await code(a, new TypeError('Failed to fetch')), 'network')
  assert.equal(await code({ provider: 'ollama', model: 'm' }, new TypeError('Failed to fetch')), 'cors')
  assert.equal(await code(o, new Response('not json', { status: 200 })), 'bad-response')
  assert.equal(await code(o, json({ choices: [] })), 'bad-response')
  assert.equal(await code(a, json({ nope: 1 })), 'bad-response')
  const ac = new AbortController()
  ac.abort()
  assert.equal(await code(o, new DOMException('The operation was aborted.', 'AbortError'), { signal: ac.signal }), 'aborted')
})

test('signal is passed through and a message accompanies each error', async () => {
  const s = stub(json({ error: { message: 'invalid x-api-key' } }, 401))
  const ac = new AbortController()
  const err = await createClient({ provider: 'anthropic', model: 'm', apiKey: 'k' }, { fetch: s.fetch }).complete({ messages: [], signal: ac.signal }).catch(e => e)
  assert.equal(s.calls[0].init.signal, ac.signal)
  assert.equal(err.message, 'invalid x-api-key')
})

test('test() reports ok or the normalized error', async () => {
  assert.deepEqual(await createClient({ provider: 'openai', model: 'm', apiKey: 'k' }, { fetch: stub(openaiReply('pong')).fetch }).test(), { ok: true })
  const r = await createClient({ provider: 'openai', model: 'm', apiKey: 'k' }, { fetch: stub(json({}, 401)).fetch }).test()
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'auth')
})

test('pkceChallenge matches the RFC 7636 test vector', async () => {
  assert.equal(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
})

test('OpenRouter sign-in: auth URL, stored verifier, code exchange', async () => {
  const mem = new Map()
  const storage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) }
  const url = new URL(await startOpenRouterSignIn({ callbackUrl: 'http://localhost:8080/', storage }))
  assert.equal(url.origin + url.pathname, 'https://openrouter.ai/auth')
  assert.equal(url.searchParams.get('callback_url'), 'http://localhost:8080/')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  const verifier = mem.get('recto:openrouter-verifier')
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(url.searchParams.get('code_challenge'), await pkceChallenge(verifier))

  const s = stub(json({ key: 'sk-or-123' }))
  assert.equal(await finishOpenRouterSignIn('the-code', { fetch: s.fetch, storage }), 'sk-or-123')
  assert.equal(s.calls[0].url, 'https://openrouter.ai/api/v1/auth/keys')
  assert.equal(s.calls[0].init.method, 'POST')
  assert.deepEqual(s.calls[0].body, { code: 'the-code', code_verifier: verifier, code_challenge_method: 'S256' })
  assert.equal(mem.has('recto:openrouter-verifier'), false)

  const e = await finishOpenRouterSignIn('again', { fetch: s.fetch, storage }).catch(x => x)
  assert.equal(e.code, 'auth')
  mem.set('recto:openrouter-verifier', 'v')
  const bad = await finishOpenRouterSignIn('c', { fetch: stub(json({}, 403)).fetch, storage }).catch(x => x)
  assert.equal(bad.code, 'auth')
})
