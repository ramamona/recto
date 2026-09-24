// Side panels (spec 5.3 Right): Check (preflight issues with Locate / Fix) and ATS (what a parser reads).
import { extractFields, extractText } from '../preflight/ats.js'
import { download } from '../io/files.js'
import { h } from './dom.js'
import { makeTabs } from './inspector.js'

const PANELS = ['check', 'ats']
const SEVERITIES = ['error', 'warn', 'info']

// Stream-order text, one `--- page N ---` block per rendered page; logical order before the first render.
export function atsText(doc, layout, placement) {
  if (!placement?.length) return extractText(doc, layout)
  const pages = Math.max(...placement.map(p => p.page))
  const out = []
  for (let n = 1; n <= pages; n++) {
    const text = extractText(doc, layout, placement.filter(p => p.page === n))
    out.push(`--- page ${n} ---`, ...(text ? [text] : []), '')
  }
  return out.join('\n').trimEnd()
}

// A content fix is stale once any line it expects has changed (issues lag the source by one render).
const isStale = (fix, content) => fix.kind === 'content' && (() => {
  const lines = content.split('\n')
  return fix.edits.some(e => lines[e.line - 1] !== e.expect)
})()

export function mountPanels(root, store, ctx) {
  const { t } = ctx
  const tabs = makeTabs(PANELS, id => t(`panels.tab.${id}`), id => store.setUi({ panel: id }), t('panels.title'))
  const badge = h('span', { class: 'ui-badge pnl-count', hidden: true })
  tabs.buttons[0].append(' ', badge)
  const body = h('div', { class: 'ui-scroll pnl-body', role: 'tabpanel', tabIndex: -1 })
  root.replaceChildren(tabs.bar, body)

  const panelOf = s => PANELS.includes(s.ui.panel) ? s.ui.panel : 'check'
  const button = (label, onClick, props = {}) => h('button', { type: 'button', class: 'ui-btn ui-btn--sm', onClick, ...props }, label)

  async function fit(pages) {
    const res = await ctx.canvas?.fit?.(pages)
    if (res?.reachedFloor) ctx.toast?.(t('inspector.fit.floor', { n: pages }))
  }

  function locate(issue) {
    if (issue.sectionId) store.select({ kind: 'section', id: issue.sectionId })
    if (issue.line) store.reveal(issue.line)
  }

  async function fix(issue, btn) {
    if (issue.fix.kind === 'action') {
      btn.disabled = true
      try { await fit(issue.fix.pages) } finally { btn.disabled = false }
    } else if (!store.applyFix(issue)) ctx.toast?.(t('panels.fix.stale'))
  }

  function issueItem(issue, content) {
    const stale = issue.fix && isStale(issue.fix, content)
    const where = [issue.line && t('panels.line', { n: issue.line }), issue.page && t('panels.page', { n: issue.page })].filter(Boolean).join(' · ')
    return h('li', { class: `pnl-issue is-${issue.severity}` },
      h('p', { class: 'pnl-issue__msg' }, t(issue.msg, issue.vars)),
      h('div', { class: 'pnl-issue__foot' },
        where && h('span', { class: 'pnl-issue__where' }, where),
        (issue.line || issue.sectionId) && button(t('panels.locate'), () => locate(issue)),
        issue.fix && button(t(`preflight.${issue.rule}.fix`, { ...issue.vars, ...issue.fix }), e => fix(issue, e.currentTarget), {
          class: `ui-btn ui-btn--sm ui-btn--primary${stale ? ' is-stale' : ''}`,
          'aria-disabled': stale ? 'true' : null, title: stale ? t('panels.fix.stale') : null,
        })))
  }

  function checkPanel(s) {
    if (!s.issues.length) return h('p', { class: 'pnl-empty' }, t('panels.check.empty'))
    return SEVERITIES.map(sev => {
      const list = s.issues.filter(i => i.severity === sev)
      return list.length && h('section', { class: 'pnl-group' },
        h('h3', { class: 'ui-group__title' }, t(`panels.check.${sev}`, { n: list.length })),
        h('ul', { class: 'pnl-issues' }, list.map(i => issueItem(i, s.content))))
    })
  }

  function fieldsList(f) {
    const rows = [
      ['name', f.name], ['label', f.label], ['emails', f.emails.join(', ')], ['phones', f.phones.join(', ')],
      ['urls', f.urls.join(', ')], ['location', f.location],
    ]
    return h('dl', { class: 'pnl-fields' },
      rows.map(([k, v]) => [h('dt', null, t(`panels.ats.${k}`)), h('dd', { class: v ? null : 'is-missing' }, v || t('panels.ats.notFound'))]),
      h('dt', null, t('panels.ats.sections')),
      h('dd', null, h('ul', { class: 'pnl-sections' }, f.sections.map(sec => h('li', { class: sec.category ? null : 'is-missing' },
        sec.title || t('inspector.section.untitled'), ' → ',
        sec.category ? t('panels.ats.category', { category: sec.category, n: sec.entries.length }) : t('panels.ats.uncategorized'))))))
  }

  function atsPanel(s) {
    const text = atsText(s.doc, s.layout, s.placement)
    const name = (s.name || s.doc.header?.name || 'cv').replace(/[\\/:*?"<>|\s]+/g, '-')
    const pre = h('pre', { class: 'pnl-text', tabIndex: 0, 'aria-label': t('panels.ats.textLabel') }, text)
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(text)
        ctx.toast?.(t('panels.ats.copied'))
      } catch {
        getSelection().selectAllChildren(pre) // clipboard denied: leave it one Cmd/Ctrl+C away
        ctx.toast?.(t('panels.ats.copyFailed'))
      }
    }
    return [
      h('div', { class: 'pnl-bar' },
        h('span', { class: 'pnl-note' }, t(s.placement?.length ? 'panels.ats.stream' : 'panels.ats.logical')),
        button(t('panels.ats.copy'), copy),
        button(t('panels.ats.download'), () => download(`${name}.txt`, text, 'text/plain;charset=utf-8'))),
      pre,
      h('h3', { class: 'ui-group__title pnl-subtitle' }, t('panels.ats.fields')),
      fieldsList(extractFields(s.doc, s.layout)),
    ]
  }

  function render(s) {
    const panel = panelOf(s)
    body.setAttribute('aria-labelledby', tabs.select(panel).id)
    const top = body.scrollTop
    const hadFocus = body.contains(document.activeElement)
    body.replaceChildren(...[panel === 'check' ? checkPanel(s) : atsPanel(s)].flat(Infinity).filter(Boolean))
    body.scrollTop = top
    if (hadFocus && !body.contains(document.activeElement)) body.focus({ preventScroll: true })
  }

  function updateBadge(s) {
    const counts = SEVERITIES.map(sev => s.issues.filter(i => i.severity === sev).length)
    const sev = SEVERITIES[counts.findIndex(n => n > 0)]
    badge.hidden = !sev
    badge.className = `ui-badge pnl-count is-${sev}`
    badge.textContent = String(s.issues.length)
  }

  const WATCH = { check: ['issues', 'content'], ats: ['doc', 'layout', 'placement', 'name'] }
  let shown = panelOf(store.state)
  store.subscribe((s, changed) => {
    if (changed.has('issues')) updateBadge(s)
    const panel = panelOf(s)
    if (panel !== shown || WATCH[panel].some(k => changed.has(k))) render(s)
    shown = panel
  })
  updateBadge(store.state)
  render(store.state)
}
