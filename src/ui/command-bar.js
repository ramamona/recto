// Command bar (review-jobs spec §4): Cmd/Ctrl-K opens a searchable, keyboard-first list of AI and app actions.
// Actions call existing ctx/store functions; one whose function is not available yet is left out of the list,
// never shown disabled — the frame (Task 32) and the job/board features (Tasks 33-34) can land in any order.
import { h, on, isMod } from './dom.js'

const RECENT_KEY = 'recto:cmdbar:recent'
const RECENT_MAX = 6

function loadRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY))
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function pushRecent(id) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...loadRecent().filter(x => x !== id)].slice(0, RECENT_MAX)))
  } catch {
    // private window or quota: recents just don't persist
  }
}

/** True when every character of `query` appears in `text`, in order (case-insensitive). */
export function fuzzyMatch(query, text) {
  const q = String(query).trim().toLowerCase()
  if (!q) return true
  const t = String(text).toLowerCase()
  let i = 0
  for (const c of q) {
    i = t.indexOf(c, i)
    if (i === -1) return false
    i++
  }
  return true
}

/** Recent ids first (most recent first), then the rest in list order; both groups keep only matched actions. */
export function orderActions(actions, query, recent) {
  const matched = actions.filter(a => fuzzyMatch(query, a.label))
  if (query.trim()) return matched
  const byRecent = id => recent.indexOf(id)
  const known = matched.filter(a => byRecent(a.id) !== -1).sort((x, y) => byRecent(x.id) - byRecent(y.id))
  const rest = matched.filter(a => byRecent(a.id) === -1)
  return [...known, ...rest]
}

// A job-specific AI action just opens the Job tab: evaluate/tailor/cover-letter live there (job-panel.js owns
// the active job and its own AI calls; nothing on ctx names the active job yet).
function jobAction(id, label, ctx, store) {
  return { id, group: 'ai', label, available: () => typeof ctx.openPanel === 'function', run: () => ctx.openPanel('job') }
}

/** The full action list for the current ctx/store, already filtered to what is actually available. */
export function buildActions(store, ctx) {
  const t = ctx.t
  const openPanel = id => () => (ctx.openPanel ? ctx.openPanel(id) : store.setUi({ panel: id }))
  const list = [
    { id: 'ai.improve', group: 'ai', label: t('cmd.ai.improve'), available: () => typeof ctx.runAssist === 'function', run: () => ctx.runAssist(a => a.suggest()) },
    {
      id: 'ai.rewrite', group: 'ai', label: t('cmd.ai.rewrite'), available: () => typeof ctx.editor?.focusLine === 'function',
      run: () => { store.setUi({ tab: 'write' }); ctx.editor.focusLine(store.state.caretLine || 1); ctx.toast?.(t('cmd.ai.rewrite.hint')) },
    },
    jobAction('ai.tailor', t('cmd.ai.tailor'), ctx, store),
    jobAction('ai.evaluate', t('cmd.ai.evaluate'), ctx, store),
    jobAction('ai.coverLetter', t('cmd.ai.coverLetter'), ctx, store),
    { id: 'app.templates', group: 'app', label: t('cmd.app.templates'), available: () => typeof ctx.topbar?.showTemplates === 'function', run: () => ctx.topbar.showTemplates() },
    { id: 'app.jobsBoard', group: 'app', label: t('cmd.app.jobsBoard'), available: () => typeof ctx.openJobsDialog === 'function', run: () => ctx.openJobsDialog() },
    { id: 'app.exportPdf', group: 'app', label: t('cmd.app.exportPdf'), available: () => typeof ctx.topbar?.print === 'function', run: () => ctx.topbar.print() },
    { id: 'app.exportTxt', group: 'app', label: t('cmd.app.exportTxt'), available: () => typeof ctx.topbar?.exportTxt === 'function', run: () => ctx.topbar.exportTxt() },
    { id: 'app.exportJsonResume', group: 'app', label: t('cmd.app.exportJsonResume'), available: () => typeof ctx.topbar?.exportJsonResume === 'function', run: () => ctx.topbar.exportJsonResume() },
    { id: 'app.fit1', group: 'app', label: t('cmd.app.fit', { n: 1 }), available: () => typeof ctx.canvas?.fit === 'function', run: () => ctx.canvas.fit(1) },
    { id: 'app.fit2', group: 'app', label: t('cmd.app.fit', { n: 2 }), available: () => typeof ctx.canvas?.fit === 'function', run: () => ctx.canvas.fit(2) },
    { id: 'app.xray', group: 'app', label: t('cmd.app.xray'), available: () => true, run: () => store.setUi({ xray: !store.state.ui.xray }) },
    { id: 'app.connectAi', group: 'app', label: t('cmd.app.connectAi'), available: () => typeof ctx.openAiDialog === 'function', run: () => ctx.openAiDialog() },
    { id: 'app.profile', group: 'app', label: t('cmd.app.profile'), available: () => typeof ctx.openProfileDialog === 'function', run: () => ctx.openProfileDialog() },
  ]
  const sections = (store.state.doc?.sections ?? []).map(s => ({
    id: `nav.${s.id}`, group: 'nav', label: t('cmd.nav.section', { title: s.title || t('app.untitled') }),
    available: () => true,
    run: () => { store.setUi({ tab: 'write' }); store.select({ kind: 'section', id: s.id }); store.reveal(s.line) },
  }))
  return [...list, ...sections].filter(a => a.available())
}

export function mountCommandBar(store, ctx) {
  const { t } = ctx
  let closeDialog = null

  function open() {
    if (closeDialog) return
    const input = h('input', { class: 'ui-input cmd-bar__input', type: 'text', placeholder: t('cmd.placeholder'), 'aria-label': t('cmd.placeholder'), autocomplete: 'off' })
    const list = h('ul', { class: 'cmd-bar__list', role: 'listbox', id: 'cmd-bar-list' })
    const dialog = h('dialog', { class: 'ui-dialog cmd-bar', closedby: 'any', 'aria-label': t('cmd.title') },
      h('div', { class: 'cmd-bar__box' }, input, list))

    const actions = buildActions(store, ctx)
    const recent = loadRecent()
    let shown = []
    let active = 0

    function choose(a) {
      pushRecent(a.id)
      dialog.close()
      a.run()
    }

    function paint() {
      shown = orderActions(actions, input.value, recent)
      active = shown.length ? Math.min(active, shown.length - 1) : 0
      list.replaceChildren(...shown.map((a, i) => h('li', {
        class: `cmd-bar__item${i === active ? ' is-active' : ''}`, role: 'option', id: `cmd-bar-item-${i}`,
        'aria-selected': String(i === active), dataset: { group: a.group },
        onClick: () => choose(a), onMousemove: () => { if (active !== i) { active = i; paint() } },
      }, h('span', { class: 'cmd-bar__group' }, t(`cmd.group.${a.group}`)), h('span', { class: 'cmd-bar__label' }, a.label))))
      input.setAttribute('aria-activedescendant', shown.length ? `cmd-bar-item-${active}` : '')
      if (!shown.length) list.append(h('li', { class: 'cmd-bar__empty' }, t('cmd.empty')))
    }

    on(input, 'input', () => { active = 0; paint() })
    on(input, 'keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, Math.max(shown.length - 1, 0)); paint() }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); paint() }
      else if (e.key === 'Enter') { e.preventDefault(); if (shown[active]) choose(shown[active]) }
    })

    paint()
    closeDialog = ctx.openDialog(dialog)
    dialog.addEventListener('close', () => { closeDialog = null }, { once: true })
    input.focus()
  }

  on(document, 'keydown', e => {
    if (!isMod(e) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k') return
    e.preventDefault()
    open()
  })
}
