// AI provider clients (spec assist §2). Pure: fetch and storage are injected; nothing runs at import.
import { parseJsonLoose } from './guard.js'

const ANTHROPIC_MODELS = ['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']

export const PROVIDERS = {
  anthropic: { auth: 'key', defaultModel: 'claude-sonnet-5' },
  openai: { auth: 'key', base: 'https://api.openai.com/v1' },
  openrouter: { auth: 'oauth', base: 'https://openrouter.ai/api/v1' },
  ollama: { auth: 'none', base: 'http://localhost:11434/v1', local: true },
  lmstudio: { auth: 'none', base: 'http://localhost:1234/v1', local: true },
  custom: { auth: 'optional' },
}

const DEFAULT_MAX_TOKENS = 16000
const JSON_ONLY = 'Reply with JSON only (no prose, no code fences), matching this JSON Schema:'
const VERIFIER_KEY = 'recto:openrouter-verifier'

export class AiError extends Error {
  constructor(code, message) {
    super(message || code)
    this.name = 'AiError'
    this.code = code
  }
}

// ponytail: model-name heuristics; move to per-model capability data if the list grows.
const noForcedTool = model => /^claude-(opus-5-5|fable-5-1|mythos)/.test(model ?? '')
const basicWebFetch = model => /haiku|-3-|-4-[0125]/.test(model ?? '')

async function request(url, init, { fetch, provider }) {
  let res
  try {
    res = await fetch(url, init)
  } catch (e) {
    if (init.signal?.aborted || e?.name === 'AbortError') throw new AiError('aborted', 'Request cancelled')
    throw new AiError(PROVIDERS[provider]?.local ? 'cors' : 'network', e?.message)
  }
  let data
  try { data = await res.json() } catch { data = undefined }
  if (!res.ok) {
    const message = data?.error?.message || `HTTP ${res.status}`
    const code = res.status === 401 || res.status === 403 ? 'auth' : res.status === 429 || res.status === 529 ? 'rate-limit' : 'bad-response'
    const err = new AiError(code, message)
    err.status = res.status
    throw err
  }
  if (data === undefined) throw new AiError('bad-response', 'Response was not JSON')
  return data
}

const usageOf = (input, output) => input == null && output == null ? undefined : { inputTokens: input, outputTokens: output }

function result(text, json, usage) {
  const r = { text }
  if (json !== undefined) r.json = json
  if (usage) r.usage = usage
  return r
}

function tryJson(text) {
  try { return parseJsonLoose(text) } catch { return undefined }
}

function anthropicClient(conn, fetch) {
  const post = (body, signal) => request('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': conn.apiKey ?? '',
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
    signal,
  }, { fetch, provider: 'anthropic' })

  return {
    async complete({ system, messages = [], json, maxTokens, signal, tools = [] }) {
      const body = { model: conn.model, max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS, messages }
      const toolDefs = []
      const name = json ? json.title || 'result' : undefined
      if (json) {
        toolDefs.push({ name, description: 'Return the result as JSON matching this schema.', input_schema: json })
        if (noForcedTool(conn.model)) {
          body.tool_choice = { type: 'auto' }
          system = [system, `Call the ${name} tool with your answer.`].filter(Boolean).join('\n\n')
        } else body.tool_choice = { type: 'tool', name }
      }
      if (tools.includes('web_fetch')) {
        toolDefs.push({ type: basicWebFetch(conn.model) ? 'web_fetch_20250910' : 'web_fetch_20260209', name: 'web_fetch', max_uses: 3 })
      }
      if (system) body.system = system
      if (toolDefs.length) body.tools = toolDefs
      const data = await post(body, signal)
      if (!Array.isArray(data?.content)) throw new AiError('bad-response', 'Unexpected response shape')
      const usage = usageOf(data.usage?.input_tokens, data.usage?.output_tokens)
      const call = json && data.content.find(b => b.type === 'tool_use' && b.name === name)
      if (call) return result(JSON.stringify(call.input), call.input, usage)
      const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('')
      return result(text, json ? tryJson(text) : undefined, usage)
    },
    async listModels() { return [...ANTHROPIC_MODELS] },
  }
}

function openaiClient(conn, fetch) {
  const base = (conn.provider === 'custom' ? conn.baseUrl ?? '' : PROVIDERS[conn.provider].base).replace(/\/+$/, '')
  const headers = { 'content-type': 'application/json' }
  if (conn.apiKey) headers.authorization = `Bearer ${conn.apiKey}`
  let jsonSchemaUnsupported = false

  async function send({ system, messages, json, maxTokens, signal }, useSchema) {
    const sys = json && !useSchema ? [system, `${JSON_ONLY} ${JSON.stringify(json)}`].filter(Boolean).join('\n\n') : system
    const body = { model: conn.model, messages: sys ? [{ role: 'system', content: sys }, ...messages] : messages }
    // OpenAI's own API rejects max_tokens on gpt-5 / o-series; compatible servers expect max_tokens.
    if (maxTokens != null) body[conn.provider === 'openai' ? 'max_completion_tokens' : 'max_tokens'] = maxTokens
    if (useSchema) body.response_format = { type: 'json_schema', json_schema: { name: json.title || 'result', schema: json } }
    return request(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal }, { fetch, provider: conn.provider })
  }

  return {
    async complete({ system, messages = [], json, maxTokens, signal }) {
      const args = { system, messages, json, maxTokens, signal }
      let data
      if (json && !jsonSchemaUnsupported) {
        try {
          data = await send(args, true)
        } catch (e) {
          if (e.status !== 400) throw e
          jsonSchemaUnsupported = true
        }
      }
      data ??= await send(args, false)
      const text = data?.choices?.[0]?.message?.content
      if (typeof text !== 'string') throw new AiError('bad-response', 'Unexpected response shape')
      return result(text, json ? tryJson(text) : undefined, usageOf(data.usage?.prompt_tokens, data.usage?.completion_tokens))
    },
    async listModels() {
      const data = await request(`${base}/models`, { headers }, { fetch, provider: conn.provider })
      if (!Array.isArray(data?.data)) throw new AiError('bad-response', 'Unexpected response shape')
      let ids = data.data.map(m => m?.id).filter(id => typeof id === 'string')
      if (conn.provider === 'openai') ids = ids.filter(id => /^(gpt-|o\d|chatgpt)/.test(id) && !/realtime|audio|transcribe|tts|image|search|embedding/.test(id))
      return ids.sort()
    },
  }
}

export function createClient(connection, { fetch = globalThis.fetch } = {}) {
  const conn = { model: PROVIDERS[connection.provider]?.defaultModel, ...connection }
  if (!PROVIDERS[conn.provider]) throw new TypeError(`Unknown provider: ${conn.provider}`)
  const client = conn.provider === 'anthropic' ? anthropicClient(conn, fetch) : openaiClient(conn, fetch)
  client.test = async () => {
    try {
      await client.complete({ messages: [{ role: 'user', content: 'Reply with: ok' }], maxTokens: 16 })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: { code: e.code ?? 'bad-response', message: e.message } }
    }
  }
  return client
}

const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64url(new Uint8Array(digest))
}

export async function startOpenRouterSignIn({ callbackUrl, storage = globalThis.sessionStorage }) {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
  storage.setItem(VERIFIER_KEY, verifier)
  const url = new URL('https://openrouter.ai/auth')
  url.searchParams.set('callback_url', callbackUrl)
  url.searchParams.set('code_challenge', await pkceChallenge(verifier))
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

export async function finishOpenRouterSignIn(code, { fetch = globalThis.fetch, storage = globalThis.sessionStorage } = {}) {
  const verifier = storage.getItem(VERIFIER_KEY)
  storage.removeItem(VERIFIER_KEY) // codes and verifiers are single-use
  if (!verifier) throw new AiError('auth', 'Sign-in expired, please sign in again')
  const data = await request('https://openrouter.ai/api/v1/auth/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
  }, { fetch, provider: 'openrouter' })
  if (typeof data?.key !== 'string') throw new AiError('bad-response', 'No key in response')
  return data.key
}
