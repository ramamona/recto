// Compare 2–5 jobs side by side (career-suite spec §6 "ofertas"): the deterministic table from insights.compare, plus an
// optional AI 'compare' recommendation (a draft, shown with textContent only, not stored).
import { h, uid } from './dom.js'
import { compare } from '../jobs/insights.js'
import { renderBrief, briefText, assistFor, aiErrorText, copyText } from './job-workspace.js'

export const COMPARE_FIELDS = ['company', 'location', 'remote', 'score', 'match', 'recommendation', 'caps', 'legitimacy', 'salary', 'gaps']
const DASH = '—'

/** One table cell as text; empty values show a dash. */
export function cellText(row, field, t) {
  const v = row[field]
  switch (field) {
    case 'score': return v == null ? DASH : v.toFixed(1)
    case 'match': return v == null ? DASH : `${Math.round(v)}%`
    case 'remote': return !v || v === 'unknown' ? DASH : v
    case 'recommendation': return v ? t(`board.rec.${v}`) : DASH
    case 'caps': return v?.length ? v.map(c => t(`compare.cap.${c}`)).join('; ') : DASH
    case 'legitimacy': return v ? t(`compare.legit.${v}`) : DASH
    case 'gaps': return v?.length ? v.join('; ') : DASH
    default: return v ? String(v) : DASH
  }
}

export function openCompare(store, ctx, { jobIds, tracker = ctx.tracker }) {
  const { t } = ctx
  const jobs = jobIds.map(id => tracker.get(id)).filter(Boolean)
  const rows = compare(jobs)
  const titleId = uid('compare')
  let busy = null
  let brief = null

  const aiBox = h('section', { class: 'ws-block compare-ai' })
  function renderAi() {
    const connected = !!ctx.ai?.getClient?.()
    aiBox.replaceChildren(
      h('div', { class: 'ws-block__head' }, h('h3', {}, t('ws.mode.compare')),
        connected
          ? h('button', { class: 'ui-btn ui-btn--sm', type: 'button', dataset: { action: 'compare-ai' }, disabled: !!busy, onClick: recommend },
            t(busy ? 'ws.generating' : brief ? 'ws.regenerate' : 'ws.generate'))
          : h('button', { class: 'ui-btn ui-btn--sm', type: 'button', dataset: { action: 'ws-connect' }, onClick: () => ctx.openAiDialog?.() }, t('ws.connect')),
        brief && h('button', { class: 'ui-btn ui-btn--sm', type: 'button', dataset: { action: 'ws-copy' }, onClick: () => copyText(ctx, briefText(brief)) }, t('ws.copy'))),
      brief ? renderBrief(brief, t) : h('p', { class: 'ui-muted' }, t('compare.aiHint')))
  }

  async function recommend() {
    if (busy) return
    const ac = busy = new AbortController()
    renderAi()
    try {
      const assist = await assistFor(store, ctx, ac.signal)
      if (!assist || ac.signal.aborted) return
      const out = await assist.brief('compare', { extra: { jobs: rows } })
      if (!ac.signal.aborted) brief = out
    } catch (e) {
      if (!(ac.signal.aborted || e?.code === 'aborted' || e?.name === 'AbortError')) {
        console.warn('recto: compare', e)
        ctx.toast?.(aiErrorText(t, e))
      }
    } finally {
      busy = null
      if (!ac.signal.aborted) renderAi()
    }
  }

  const table = h('div', { class: 'compare-scroll' }, h('table', { class: 'compare-table' },
    h('thead', {}, h('tr', {}, h('td', {}), rows.map(r => h('th', { scope: 'col' }, r.title || t('jobs.untitled'))))),
    h('tbody', {}, COMPARE_FIELDS.map(f => h('tr', { dataset: { field: f } },
      h('th', { scope: 'row' }, t(`compare.field.${f}`)), rows.map(r => h('td', {}, cellText(r, f, t))))))))

  const dialog = h('dialog', { class: 'compare', closedby: 'any', 'aria-labelledby': titleId },
    h('header', { class: 'pack-head' }, h('h2', { id: titleId }, t('compare.title', { count: rows.length })),
      h('button', { class: 'ui-btn ui-btn--sm ui-btn--ghost', type: 'button', 'aria-label': t('compare.close'), dataset: { action: 'compare-close' }, onClick: () => close() }, '×')),
    table, aiBox)
  dialog.addEventListener('close', () => busy?.abort(), { once: true })
  renderAi()
  const close = ctx.openDialog(dialog)
  return close
}
