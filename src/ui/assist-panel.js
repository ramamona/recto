// Suggest tab (assist spec §7): AI diff cards (accept per item, never auto-applied) and deterministic local tips.
// Cards live in ctx.assistQueue (docId → cards) so a tailored copy opens with its cards.
import { h } from './dom.js'
import { createAssist } from '../ai/assist.js'
import { validateSuggestions } from '../ai/guard.js'
import { getConnection } from '../ai/connections.js'
import { localSuggestions } from '../suggest/local.js'

// ---------- pure ----------

const tokens = s => s.split(/(\s+)/).filter(Boolean)

/** Word-level LCS diff: [op, text] runs with op '=' | '-' | '+'; '=' and '-' rebuild `a`, '=' and '+' rebuild `b`. */
export function wordDiff(a, b) {
  const x = tokens(a), y = tokens(b)
  // ponytail: O(n·m) table, fine for single CV lines
  const dp = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0))
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  }
  const out = []
  const push = (op, s) => out.at(-1)?.[0] === op ? (out.at(-1)[1] += s) : out.push([op, s])
  let i = 0, j = 0
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) { push('=', x[i]); i++; j++ }
    else if (j >= y.length || (i < x.length && dp[i + 1][j] >= dp[i][j + 1])) push('-', x[i++])
    else push('+', y[j++])
  }
  return out
}

/** Cards worth showing: stale ones (the line changed since) and ones that break the line's grammar are hidden. */
export function visibleCards(cards, content) {
  const lines = String(content ?? '').split('\n')
  return (cards ?? []).filter(c => c.status !== 'stale' && c.status !== 'invalid' && lines[c.line - 1] === c.expect)
}

/** Edits for "Accept all safe": clean cards only (never new facts), the first card per line. */
export function safeEdits(cards, content) {
  const seen = new Set()
  return visibleCards(cards, content).filter(c => c.status === 'ok' && !seen.has(c.line) && seen.add(c.line))
    .map(c => ({ line: c.line, expect: c.expect, text: c.replacement }))
}

/** The client with an abort signal on every completion, so Cancel stops the request. */
export const withSignal = (client, signal) => ({ ...client, complete: o => client.complete({ ...o, signal }) })

// ---------- mount ----------

export function mountAssistPanel(root, store, ctx) {
  const { t } = ctx
  ctx.assistQueue ??= new Map()
  const getState = () => store.state
  const client = () => ctx.ai?.getClient?.() ?? null
  // Built per use: the connected client can change at any time.
  Object.defineProperty(ctx, 'assist', { configurable: true, get: () => createAssist({ client: client(), getState }) })

  let busy = null // AbortController of the running AI request
  let editing = null // { card, text } while a card's replacement is edited inline
  const toast = (key, vars, opts) => ctx.toast?.(t(key, vars), opts)
  const cards = () => ctx.assistQueue.get(store.state.docId) ?? []
  const setCards = list => { ctx.assistQueue.set(store.state.docId, list); render() }
  const button = (label, onClick, cls = '') => h('button', { type: 'button', class: `ui-btn ui-btn--sm ${cls}`.trim(), onClick }, label)

  /** Run an AI task (`assist => Promise<{ suggestions }>`) with consent, spinner and Cancel; cards land in this tab. */
  async function run(task) {
    const c = client()
    if (!c) return ctx.openAiDialog?.()
    if (!(await ctx.ai.ensureConsent?.(getConnection()?.provider))) return
    busy?.abort()
    const ac = new AbortController()
    busy = ac
    const docId = store.state.docId
    store.setUi({ panel: 'suggest' })
    try {
      const { suggestions } = await task(createAssist({ client: withSignal(c, ac.signal), getState }))
      if (ac.signal.aborted || store.state.docId !== docId) return
      const old = cards().filter(o => !suggestions.some(s => s.line === o.line))
      setCards([...suggestions, ...old])
      if (!visibleCards(suggestions, store.state.content).length) toast('suggest.ai.none')
    } catch (e) {
      if (ac.signal.aborted || e.code === 'aborted') return
      if (!e.code) console.error('recto: assist failed', e)
      toast(`ai.error.${e.code ?? 'bad-response'}`, null, { action: { label: t('suggest.retry'), run: () => run(task) } })
    } finally {
      if (busy === ac) busy = null
      render()
    }
  }
  ctx.runAssist = run

  function cancel() {
    busy?.abort()
    busy = null
    render()
  }

  const apply = edits => store.applyFix({ fix: { kind: 'content', edits } }) || toast('panels.fix.stale')
  const accept = c => apply([{ line: c.line, expect: c.expect, text: c.replacement }])
  const reject = c => setCards(cards().filter(o => o !== c))

  function saveEdit() {
    const { card, text } = editing
    const { content, doc } = store.state
    const next = validateSuggestions(content, doc, [{ ...card, replacement: text }])[0]
    if (next.status === 'invalid') return toast('suggest.card.invalid')
    editing = null
    setCards(cards().map(o => o === card ? next : o))
  }

  function diffLine(parts, op, cls) {
    return h('p', { class: `as-diff ${cls}` }, parts.filter(([o]) => o === '=' || o === op)
      .map(([o, s]) => o === '=' ? s : h(op === '-' ? 'del' : 'ins', null, s)))
  }

  function card(c) {
    const parts = wordDiff(c.expect, c.replacement)
    const isEditing = editing?.card === c
    const after = isEditing
      ? h('textarea', { class: 'ui-textarea as-edit', value: editing.text, 'aria-label': t('suggest.card.after'), onInput: e => { editing.text = e.target.value } })
      : diffLine(parts, '+', 'as-diff--after')
    return h('li', { class: `as-card is-${c.status}` },
      h('div', { class: 'as-card__head' },
        h('span', { class: 'ui-badge as-cat' }, t(`suggest.category.${c.category}`)),
        c.status === 'new-facts' && h('span', { class: 'ui-badge is-warn', title: c.newFacts?.join(', ') }, t('suggest.card.newFacts')),
        h('span', { class: 'as-card__where' }, t('panels.line', { n: c.line }))),
      diffLine(parts, '-', 'as-diff--before'),
      after,
      c.reason && h('p', { class: 'as-card__reason' }, c.reason),
      c.needsInput && h('p', { class: 'as-card__needs' }, t('suggest.card.needs', { what: c.needsInput })),
      h('div', { class: 'as-card__foot' }, isEditing
        ? [button(t('suggest.card.save'), saveEdit, 'ui-btn--primary'), button(t('suggest.card.cancel'), () => { editing = null; render() })]
        : [
            button(t('suggest.card.accept'), () => accept(c), 'ui-btn--primary'),
            button(t('suggest.card.reject'), () => reject(c)),
            button(t('suggest.card.edit'), () => { editing = { card: c, text: c.replacement }; render() }),
            button(t('panels.locate'), () => store.reveal(c.line)),
          ]))
  }

  function aiSection(s) {
    const shown = visibleCards(cards(), s.content)
    const safe = safeEdits(shown, s.content)
    const connected = !!client()
    return h('section', { class: 'pnl-group as-ai' },
      h('div', { class: 'as-bar' },
        busy
          ? [h('span', { class: 'as-spinner', role: 'status' }, t('suggest.ai.working')), button(t('suggest.ai.cancel'), cancel)]
          : h('button', { type: 'button', class: 'ui-btn ui-btn--sm ui-btn--primary', disabled: !connected, onClick: () => run(a => a.suggest()) }, t('suggest.ai.improve')),
        !connected && h('button', { type: 'button', class: 'ed-link-btn', onClick: () => ctx.openAiDialog?.() }, t('suggest.ai.connect')),
        h('span', { class: 'ui-spacer' }),
        safe.length > 0 && button(t('suggest.ai.acceptAll', { n: safe.length }), () => apply(safe))),
      shown.length > 0 && h('ul', { class: 'as-cards' }, shown.map(card)))
  }

  function localSection(s) {
    const tips = localSuggestions(s.content, s.doc, s.layout?.lang)
    return h('section', { class: 'pnl-group' },
      h('h3', { class: 'ui-group__title' }, t('suggest.local.title', { n: tips.length })),
      tips.length
        ? h('ul', { class: 'pnl-issues' }, tips.map(tip => h('li', { class: 'pnl-issue is-info' },
            h('p', { class: 'pnl-issue__msg' }, t(tip.message, tip.vars)),
            h('div', { class: 'pnl-issue__foot' },
              h('span', { class: 'pnl-issue__where' }, t('panels.line', { n: tip.line })),
              button(t('panels.locate'), () => store.reveal(tip.line)),
              tip.fix && button(t('suggest.local.fix'), () => store.applyFix(tip) || toast('panels.fix.stale'), 'ui-btn--primary')))))
        : h('p', { class: 'pnl-empty' }, t('suggest.local.empty')))
  }

  function render(s = store.state) {
    if (s.ui.panel === 'suggest') root.replaceChildren(aiSection(s), localSection(s))
  }

  store.subscribe((s, changed) => {
    if (['content', 'doc', 'docId', 'ui', 'layout'].some(k => changed.has(k))) render(s)
  })
  addEventListener('recto:ai', () => render()) // AI_EVENT from ai-dialog.js: connected / disconnected
  render()
  return { run }
}
