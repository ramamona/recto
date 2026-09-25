// Right pane (review-jobs spec §4): full-height tabs Design (inspector.js) · Review (review-panel.js) ·
// Job (job-panel.js) · Suggest (assist-panel.js). Each tab renders itself into a persistent root; this module only
// mounts them and shows the one named by state.ui.panel.
import { h } from './dom.js'
import { makeTabs, mountInspector } from './inspector.js'
import { mountReviewPanel } from './review-panel.js'
import { mountAssistPanel } from './assist-panel.js'

export const PANELS = ['design', 'review', 'job', 'suggest']

export function mountPanels(root, store, ctx) {
  const { t } = ctx
  const tabs = makeTabs(PANELS, id => t(`panels.tab.${id}`), id => ctx.openPanel ? ctx.openPanel(id) : store.setUi({ panel: id }), t('panels.side'))
  const placeholder = () => h('p', { class: 'app-placeholder ui-muted' }, t('app.unavailable'))

  // Design brings its own sub-tabs and scroller; the others scroll inside the pane.
  const panes = Object.fromEntries(PANELS.map((id, i) => [id, h('div', {
    class: id === 'design' ? 'app-side__pane' : 'app-side__pane ui-scroll pnl-body',
    role: 'tabpanel', tabIndex: -1, dataset: { panel: id }, 'aria-labelledby': tabs.buttons[i].id,
  })]))
  const roots = { design: panes.design, review: h('div', { class: 'rv-root' }), job: h('div', { class: 'jp-root' }), suggest: h('div', { class: 'as-root' }) }
  for (const id of ['review', 'job', 'suggest']) panes[id].append(roots[id])
  root.replaceChildren(tabs.bar, ...Object.values(panes))

  // One broken tab must not take the others down.
  const mount = async (id, fn) => {
    try {
      await fn(roots[id], store, ctx)
    } catch (err) {
      console.error(`recto: ${id} panel failed`, err)
      roots[id].replaceChildren(placeholder())
    }
  }
  mount('design', mountInspector)
  mount('review', mountReviewPanel)
  mount('suggest', mountAssistPanel)
  mount('job', async (...a) => (await import('./job-panel.js')).mountJobPanel(...a))

  const panelOf = s => PANELS.includes(s.ui.panel) ? s.ui.panel : 'design'
  let shown = null
  function show(s) {
    const panel = panelOf(s)
    if (panel === shown) return
    const hadFocus = shown && panes[shown].contains(document.activeElement)
    shown = panel
    tabs.select(panel)
    for (const id of PANELS) panes[id].hidden = id !== panel
    if (hadFocus) panes[panel].focus({ preventScroll: true })
  }
  store.subscribe((s, changed) => { if (changed.has('ui')) show(s) })
  show(store.state)
}
