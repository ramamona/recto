// AI connections dialog and the per-provider consent prompt (assist spec §2, §7).
// Keys stay in memory unless "Remember" is ticked; nothing here logs a connection.
import { h, uid, replaceChildren } from './dom.js'
import { dialogBox, ask } from './topbar.js'
import { PROVIDERS, createClient, startOpenRouterSignIn, finishOpenRouterSignIn } from '../ai/providers.js'
import { PROVIDER_IDS, getConnection, setConnection, forgetConnection, hasConsent, grantConsent } from '../ai/connections.js'

/** Fired on window whenever the active connection changes (top bar, Suggest tab). */
export const AI_EVENT = 'recto:ai'
const DEFAULT_MODEL = { anthropic: PROVIDERS.anthropic.defaultModel, openrouter: 'openrouter/auto' }
const HOSTS = { anthropic: 'api.anthropic.com', openai: 'api.openai.com', openrouter: 'openrouter.ai', gemini: 'generativelanguage.googleapis.com', github: 'models.github.ai', ollama: 'localhost:11434', lmstudio: 'localhost:1234' }

const blank = s => !String(s ?? '').trim()
const changed = () => dispatchEvent(new Event(AI_EVENT))
const errorText = (t, e) => `${t(`ai.error.${e?.code ?? 'bad-response'}`)}${e?.message ? ` (${e.message})` : ''}`

export function connectionLabel(conn, t) {
  return conn ? t('ai.button.connected', { provider: t(`ai.provider.${conn.provider}`), model: conn.model ?? '' }) : t('ai.button')
}

/** What the connection still lacks: 'provider' | 'baseUrl' | 'apiKey' | 'signIn' | 'model' | null. */
export function connectionProblem(conn, { needModel = true } = {}) {
  const auth = PROVIDERS[conn?.provider]?.auth
  if (!auth) return 'provider'
  if (conn.provider === 'custom' && !/^https?:\/\/[^/\s]+/i.test(String(conn.baseUrl ?? '').trim())) return 'baseUrl'
  if (auth === 'key' && blank(conn.apiKey)) return 'apiKey'
  if (auth === 'oauth' && blank(conn.apiKey)) return 'signIn'
  if (needModel && blank(conn.model)) return 'model'
  return null
}

/** OpenRouter returns to the app with ?code=; returns the code and the URL without it, or null. */
export function takeOAuthCode(href) {
  const url = new URL(href)
  const code = url.searchParams.get('code')
  if (!code) return null
  url.searchParams.delete('code')
  return { code, url: url.href }
}

const hostOf = conn => {
  if (conn.provider !== 'custom') return HOSTS[conn.provider]
  try { return new URL(conn.baseUrl).host } catch { return conn.baseUrl }
}

// createClient is cheap, but the OpenAI client remembers whether json_schema is supported: keep one per connection.
let cached = { key: '', client: null }
function clientFor(conn) {
  const key = JSON.stringify(conn)
  if (cached.key !== key) cached = { key, client: createClient(conn) }
  return cached.client
}

/** Resolves true once the user has agreed to send their CV to `provider` (asked once per session unless remembered). */
export function ensureConsent(ctx, provider = getConnection()?.provider) {
  const conn = getConnection()
  if (!provider || !conn) return Promise.resolve(false)
  if (hasConsent(provider)) return Promise.resolve(true)
  const { t } = ctx
  return new Promise(resolve => {
    let agreed = false
    const remember = h('input', { type: 'checkbox', class: 'ui-check', id: uid('consent') })
    const dialog = dialogBox(t('ai.consent.title', { provider: t(`ai.provider.${provider}`) }), [
      h('p', {}, t('ai.consent.what')),
      h('p', {}, t('ai.consent.where', { provider: t(`ai.provider.${provider}`), host: hostOf(conn.provider === provider ? conn : { provider }) ?? '' })),
      h('p', { class: 'ui-muted' }, t('ai.consent.never')),
      h('label', { class: 'ai-row', htmlFor: remember.id }, remember, t('ai.consent.remember')),
    ], [
      h('button', { class: 'ui-btn', type: 'button', onClick: () => close() }, t('app.cancel')),
      h('button', { class: 'ui-btn ui-btn--primary', type: 'button', dataset: { action: 'consent-send' }, onClick: () => { agreed = true; close() } }, t('ai.consent.send')),
    ])
    dialog.classList.add('ai-consent')
    dialog.addEventListener('close', () => {
      if (agreed) grantConsent(provider, { persist: remember.checked })
      resolve(agreed)
    }, { once: true })
    const close = ctx.openDialog(dialog)
  })
}

/** The ctx.ai facade main.js exposes to the Assist panels. */
export function createAi(ctx) {
  return {
    getClient() {
      const conn = getConnection()
      return conn && !connectionProblem(conn) ? clientFor(conn) : null
    },
    getConnection,
    ensureConsent: provider => ensureConsent(ctx, provider),
    label: () => connectionLabel(getConnection(), ctx.t),
  }
}

/** Finish the OpenRouter redirect: exchange the code for a key, then show the dialog with the result. */
export async function finishSignIn(store, ctx, code) {
  try {
    const apiKey = await finishOpenRouterSignIn(code)
    setConnection({ provider: 'openrouter', model: DEFAULT_MODEL.openrouter, apiKey, remember: getConnection()?.remember ?? false })
    changed()
    openAiDialog(store, ctx, { provider: 'openrouter', notice: ctx.t('ai.signedIn') })
  } catch (e) {
    openAiDialog(store, ctx, { provider: 'openrouter', notice: errorText(ctx.t, e), error: true })
  }
}

export function openAiDialog(store, ctx, { provider, notice = '', error = false } = {}) {
  const { t } = ctx
  const fresh = p => {
    const cur = getConnection()
    return cur?.provider === p ? { ...cur } : { provider: p, model: DEFAULT_MODEL[p] ?? '', baseUrl: '', apiKey: '', remember: cur?.remember ?? false }
  }
  let draft = fresh(provider ?? getConnection()?.provider ?? 'anthropic')
  let models = []

  const status = h('p', { class: 'ai-status', role: 'status' })
  const say = (msg, kind = '') => {
    status.textContent = msg
    status.className = `ai-status ${kind}`
  }

  const cards = h('div', { class: 'ai-cards', role: 'group', 'aria-label': t('ai.providers') })
  const form = h('div', { class: 'ai-form' })
  const list = h('datalist', { id: uid('models') })
  const disconnect = h('button', { class: 'ui-btn ui-btn--danger', type: 'button', dataset: { action: 'ai-disconnect' }, onClick: onDisconnect }, t('ai.disconnect'))

  function field(label, control, hint) {
    control.id ||= uid('ai')
    return h('div', { class: 'ai-field' }, h('label', { class: 'ui-label', htmlFor: control.id }, label), control, hint && h('p', { class: 'ui-muted ai-hint' }, hint))
  }
  const input = (key, props) => h('input', {
    class: 'ui-input', value: draft[key] ?? '', spellcheck: false, autocomplete: 'off', dataset: { field: key },
    onInput: e => { draft[key] = e.target.value }, ...props,
  })

  function renderCards() {
    const cur = getConnection()
    cards.replaceChildren(...PROVIDER_IDS.map(p => h('button', {
      class: 'ai-card', type: 'button', 'aria-pressed': String(p === draft.provider), autofocus: p === draft.provider, dataset: { provider: p },
      onClick: () => { draft = fresh(p); models = []; say(''); render() },
    }, h('span', { class: 'ai-card__name' }, t(`ai.provider.${p}`)),
      h('span', { class: 'ai-card__hint ui-muted' }, t(`ai.provider.${p}.hint`)),
      cur?.provider === p && h('span', { class: 'ui-badge is-ok' }, t('ai.connected.badge')))))
  }

  const fillList = () => list.replaceChildren(...models.map(m => h('option', { value: m })))

  function renderForm() {
    const p = draft.provider
    const auth = PROVIDERS[p].auth
    // Anthropic's list is built in (no request), so it is offered straight away
    if (p === 'anthropic' && !models.length) createClient({ provider: p }).listModels().then(m => { models = m; fillList() })
    fillList()
    const signedIn = auth === 'oauth' && !blank(draft.apiKey)
    const remember = h('input', { type: 'checkbox', class: 'ui-check', checked: !!draft.remember, dataset: { field: 'remember' }, onChange: e => { draft.remember = e.target.checked } })
    remember.id = uid('ai')
    replaceChildren(form,
      p === 'custom' && field(t('ai.baseUrl'), input('baseUrl', { type: 'url', placeholder: 'http://localhost:8000/v1' }), t('ai.baseUrl.hint')),
      (auth === 'key' || auth === 'optional') && field(auth === 'key' ? t('ai.apiKey') : t('ai.apiKey.optional'), input('apiKey', { type: 'password' }), t('ai.apiKey.hint')),
      auth === 'oauth' && h('div', { class: 'ai-field' },
        signedIn && h('p', { class: 'ai-status is-ok' }, t('ai.signedIn.short')),
        h('button', { class: 'ui-btn', type: 'button', dataset: { action: 'ai-signin' }, onClick: signIn }, t(signedIn ? 'ai.signIn.again' : 'ai.signIn'))),
      PROVIDERS[p].local && h('p', { class: 'ui-muted ai-hint' }, t(`ai.local.${p}`)),
      field(t('ai.model'), h('div', { class: 'ai-row' },
        input('model', { list: list.id, placeholder: t('ai.model.placeholder') }),
        h('button', { class: 'ui-btn ui-btn--icon', type: 'button', dataset: { action: 'ai-models' }, 'aria-label': t('ai.model.refresh'), title: t('ai.model.refresh'), onClick: refreshModels }, '↻'),
        list)),
      h('label', { class: 'ai-row', htmlFor: remember.id }, remember, t('ai.remember')),
      h('p', { class: 'ui-muted ai-hint' }, t('ai.remember.hint')),
    )
  }

  function render() {
    renderCards()
    renderForm()
    disconnect.hidden = !getConnection()
  }

  const trimmed = () => {
    const c = { provider: draft.provider, model: String(draft.model ?? '').trim(), remember: !!draft.remember }
    if (!blank(draft.apiKey)) c.apiKey = draft.apiKey.trim()
    if (draft.provider === 'custom') c.baseUrl = String(draft.baseUrl ?? '').trim()
    return c
  }
  const blocked = (conn, opts) => {
    const problem = connectionProblem(conn, opts)
    if (problem) say(t(`ai.problem.${problem}`), 'is-error')
    return !!problem
  }

  async function refreshModels() {
    const conn = trimmed()
    if (blocked(conn, { needModel: false })) return
    say(t('ai.model.loading'))
    try {
      models = await createClient(conn).listModels()
      if (blank(draft.model) && models[0]) draft.model = models[0]
      renderForm()
      say(t('ai.model.count', { count: models.length }), 'is-ok')
    } catch (e) { say(errorText(t, e), 'is-error') }
  }

  async function test() {
    const conn = trimmed()
    if (blocked(conn)) return
    say(t('ai.test.running'))
    const r = await createClient(conn).test()
    r.ok ? say(t('ai.test.ok'), 'is-ok') : say(errorText(t, r.error), 'is-error')
  }

  async function signIn() {
    try {
      store.flush()
      location.assign(await startOpenRouterSignIn({ callbackUrl: location.origin + location.pathname }))
    } catch (e) { say(errorText(t, e), 'is-error') }
  }

  function connect() {
    const conn = trimmed()
    if (blocked(conn)) return
    setConnection(conn)
    changed()
    ctx.toast(t('ai.connected', { provider: t(`ai.provider.${conn.provider}`) }))
    close()
  }

  function onDisconnect() {
    ask(ctx, {
      title: t('ai.disconnect'), body: h('p', {}, t('ai.disconnect.confirm')), confirm: t('ai.disconnect'), danger: true,
      onConfirm() {
        forgetConnection()
        changed()
        draft = fresh(draft.provider)
        render()
        say(t('ai.disconnected'))
      },
    })
  }

  const body = [
    h('div', { class: 'ai-privacy' }, h('strong', {}, t('ai.privacy.title')), h('p', {}, t('ai.privacy.body'))),
    cards, form, status,
  ]
  const dialog = dialogBox(t('ai.title'), body, [
    disconnect, h('span', { class: 'ui-spacer' }),
    h('button', { class: 'ui-btn', type: 'button', dataset: { action: 'ai-test' }, onClick: test }, t('ai.test')),
    h('button', { class: 'ui-btn', type: 'button', onClick: () => close() }, t('ai.close')),
    h('button', { class: 'ui-btn ui-btn--primary', type: 'button', dataset: { action: 'ai-connect' }, onClick: connect }, t('ai.connect')),
  ])
  dialog.classList.add('ai-dialog')
  render()
  if (notice) say(notice, error ? 'is-error' : 'is-ok')
  const close = ctx.openDialog(dialog)
  return close
}
