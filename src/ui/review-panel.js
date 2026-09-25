// Review tab (review-jobs spec §4): the ATS report from state.ats (score ring, weighted checks with Locate/Fix,
// "What the ATS sees" mock form), then the preflight list and the X-ray text as collapsible sections.
import { extractText } from '../preflight/ats.js'
import { download } from '../io/files.js'
import { h } from './dom.js'
import { hasString } from './i18n.js'

const SEVERITIES = ['error', 'warn', 'info']
const ITEM_CLASS = { critical: 'is-error', warning: 'is-warn', info: 'is-info' }
const WATCH = ['ats', 'issues', 'content', 'doc', 'layout', 'placement', 'name']

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

export function mountReviewPanel(root, store, ctx) {
  const { t } = ctx
  const opened = new Set() // <details> the user opened or closed survive re-renders
  const closed = new Set()
  const button = (label, onClick, props = {}) => h('button', { type: 'button', class: 'ui-btn ui-btn--sm', onClick, ...props }, label)

  function details(key, summary, body, openByDefault) {
    // summary clicks (keyboard included) are the user's choice; 'toggle' also fires for the initial `open`
    const remember = () => {
      const open = !el.open
      ;(open ? opened : closed).add(key)
      ;(open ? closed : opened).delete(key)
    }
    const el = h('details', { class: 'rv-details', open: opened.has(key) || (openByDefault && !closed.has(key)) },
      h('summary', { onClick: remember }, summary), body)
    return el
  }

  async function fit(pages) {
    const res = await ctx.canvas?.fit?.(pages)
    if (res?.reachedFloor) ctx.toast?.(t('inspector.fit.floor', { n: pages }))
  }

  function locate(it) {
    if (it.sectionId) store.select({ kind: 'section', id: it.sectionId })
    if (it.line) store.reveal(it.line)
  }

  async function fix(it, btn) {
    if (it.fix.kind === 'action') {
      btn.disabled = true
      try { await fit(it.fix.pages) } finally { btn.disabled = false }
    } else if (!store.applyFix(it)) ctx.toast?.(t('panels.fix.stale'))
  }

  // Shared by ATS check items ({ severity: critical|warning|info }) and preflight issues ({ severity, rule }).
  function itemRow(it, content, cls) {
    const stale = it.fix && isStale(it.fix, content)
    const fixKey = it.rule ? `preflight.${it.rule}.fix` : `${it.msg}.fix`
    const where = [it.line && t('panels.line', { n: it.line }), it.page && t('panels.page', { n: it.page })].filter(Boolean).join(' · ')
    return h('li', { class: `pnl-issue ${cls}` },
      h('p', { class: 'pnl-issue__msg' }, t(it.msg, itemVars(it))),
      h('div', { class: 'pnl-issue__foot' },
        where && h('span', { class: 'pnl-issue__where' }, where),
        (it.line || it.sectionId) && button(t('panels.locate'), () => locate(it)),
        it.fix && button(hasString(fixKey) ? t(fixKey, { ...it.vars, ...it.fix }) : t('review.fix'), e => fix(it, e.currentTarget), {
          class: `ui-btn ui-btn--sm ui-btn--primary${stale ? ' is-stale' : ''}`,
          'aria-disabled': stale ? 'true' : null, title: stale ? t('panels.fix.stale') : null,
        })))
  }

  // ats.entries.incomplete carries field ids; ats.headings.missing a category id
  function itemVars({ msg, vars = {} }) {
    if (Array.isArray(vars.missing)) return { ...vars, missing: vars.missing.map(k => t(`review.field.${k}`)).join(', '), title: vars.title || t('review.untitled') }
    if (msg === 'ats.headings.missing') return { ...vars, section: t(`review.section.${vars.section}`) }
    return vars
  }

  // ---------- ATS report ----------

  function scoreHead(ats, issues) {
    const ring = h('div', { class: `rv-ring is-${ats.grade}`, role: 'img', 'aria-label': t('review.score.label', ats) },
      h('span', { class: 'rv-ring__score' }, String(ats.score)), h('span', { class: 'rv-ring__grade' }, ats.grade))
    ring.style.setProperty('--rv-p', String(ats.score))
    return h('div', { class: 'rv-head' }, ring,
      h('div', { class: 'rv-head__text' },
        h('h3', { class: 'rv-head__title' }, t('review.score.title')),
        h('p', { class: 'ui-muted rv-head__note' }, t('review.score.note')),
        h('p', { class: 'ui-muted rv-head__note' }, t('review.issues', { n: issues.length }))))
  }

  function checkRow(c, content) {
    const lost = c.weight - c.earned
    const bar = h('span', { class: 'rv-bar', 'aria-hidden': 'true' }, h('span', { class: 'rv-bar__fill' }))
    bar.firstChild.style.width = `${Math.round(100 * c.earned / c.weight)}%`
    const summary = [h('span', { class: 'rv-check__name' }, t(`review.check.${c.id}`)), bar,
      h('span', { class: `rv-check__pts${lost ? ' is-lost' : ''}` }, t('review.points', c))]
    const body = [h('p', { class: 'ui-muted rv-check__hint' }, t(`review.check.${c.id}.hint`)),
      c.items.length ? h('ul', { class: 'pnl-issues' }, c.items.map(it => itemRow(it, content, ITEM_CLASS[it.severity] ?? 'is-info')))
        : h('p', { class: 'rv-ok' }, t('review.check.ok'))]
    return h('li', { class: 'rv-check' }, details(`check:${c.id}`, summary, body, lost > 0))
  }

  function fieldRow(key, value, missing) {
    return [h('dt', {}, t(`review.field.${key}`)),
      missing ? h('dd', { class: 'is-missing' }, t(`review.reason.${missing}`)) : h('dd', {}, value)]
  }

  function entryList(key, entries, missing) {
    if (missing) return fieldRow(key, '', missing)
    return [h('dt', {}, t(`review.field.${key}`)), h('dd', {}, h('ul', { class: 'rv-entries' }, entries.map(e => h('li', { class: e.missing.length ? 'is-missing' : null },
      h('span', {}, [e.title, e.company].filter(Boolean).join(' · ') || t('review.untitled')),
      h('span', { class: 'ui-muted' }, [[e.start, e.current ? t('review.present') : e.end].filter(Boolean).join(' – '), e.location].filter(Boolean).join(' · ')),
      e.missing.length > 0 && h('span', { class: 'rv-reason' }, t('review.entry.missing', { fields: e.missing.map(k => t(`review.field.${k}`)).join(', ') })),
      e.line && button(t('panels.locate'), () => locate(e))))))]
  }

  function mockForm(f) {
    const m = f.missing ?? {}
    return h('dl', { class: 'pnl-fields rv-form' },
      ['name', 'email', 'phone', 'location'].map(k => fieldRow(k, f[k], m[k])),
      fieldRow('links', f.links.map(l => l.url).join(', '), !f.links.length && 'not-found'),
      entryList('work', f.work, m.work),
      entryList('education', f.education, m.education),
      fieldRow('skills', f.skills.join(', '), m.skills))
  }

  // ---------- preflight and X-ray (moved from the old Check / ATS panels) ----------

  function preflightList(s) {
    if (!s.issues.length) return h('p', { class: 'pnl-empty' }, t('panels.check.empty'))
    return SEVERITIES.map(sev => {
      const list = s.issues.filter(i => i.severity === sev)
      return list.length > 0 && h('section', { class: 'pnl-group' },
        h('h4', { class: 'ui-group__title' }, t(`panels.check.${sev}`, { n: list.length })),
        h('ul', { class: 'pnl-issues' }, list.map(i => itemRow(i, s.content, `is-${sev}`))))
    })
  }

  function xray(s) {
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
    ]
  }

  function render(s) {
    const scroller = root.closest('.ui-scroll') ?? root
    const top = scroller.scrollTop
    const hadFocus = root.contains(document.activeElement)
    const { ats } = s
    root.replaceChildren(...[
      ats ? [scoreHead(ats, s.issues), h('h3', { class: 'ui-group__title rv-title' }, t('review.checks')),
        h('ol', { class: 'rv-checks' }, ats.checks.map(c => checkRow(c, s.content))),
        h('h3', { class: 'ui-group__title rv-title' }, t('review.form.title')),
        h('p', { class: 'ui-muted rv-hint' }, t('review.form.hint')),
        mockForm(ats.fields)]
        : h('p', { class: 'ui-muted rv-hint' }, t('review.pending')),
      details('preflight', t('review.preflight', { n: s.issues.length }), preflightList(s), !ats),
      details('xray', t('review.xray'), xray(s), false),
    ].flat(Infinity).filter(Boolean))
    scroller.scrollTop = top
    if (hadFocus && !root.contains(document.activeElement)) root.closest('[tabindex]')?.focus({ preventScroll: true })
  }

  store.subscribe((s, changed) => { if (WATCH.some(k => changed.has(k))) render(s) })
  render(store.state)
}
