// Insights view (career-suite spec §6 patterns/stats/detect-reposts/calibrate/upskill/titles, training/project; §7):
// full-screen like the board. Cards over the tracker: funnel (CSV export), response rates, rejections, repost/ghost
// suspects, score calibration, skill gaps (+ AI upskill plan), adjacent titles (+ AI titles, "Add to target roles")
// and Career advice (AI evaluation of a course or project). AI output is a draft rendered with textContent only.
import { hubNav } from './hub-nav.js'
import { h, uid } from './dom.js'
import { withSignal } from './job-panel.js'
import { funnel, rates, rejections, reposts, calibration, skillGaps, adjacentTitles } from '../jobs/insights.js'
import { loadProfile, saveProfile } from '../profile.js'
import { createAssist } from '../ai/assist.js'
import { getConnection } from '../ai/connections.js'
import { download } from '../io/files.js'

export const RATE_KEYS = ['source', 'ats', 'band', 'remote']
export const BRIEF_MODES_USED = ['upskill', 'titles', 'training', 'project']
const pct = r => Math.round((Number(r) || 0) * 100)

// Spreadsheet-safe cell: quoted when needed; a leading = + - @ can't start a formula
function csvCell(v) {
  let s = String(v ?? '')
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** The funnel as CSV: stage, count, conversion from the previous stage in %. */
export function funnelCsv(rows) {
  return ['stage,count,conversion %', ...(rows ?? []).map(r => [r.stage, r.count, pct(r.rate)].map(csvCell).join(','))].join('\n') + '\n'
}

/** What adjacent titles grow from: the profile's target roles, then evaluated archetypes (not 'other'); case-insensitive unique. */
export function titleSeeds(jobs, profile) {
  const archetypes = (jobs ?? []).flatMap(j => (j?.evaluations ?? []).map(e => e?.role?.archetype))
  const seen = new Set()
  return [...(profile?.targetRoles ?? []), ...archetypes.filter(a => a !== 'other')]
    .filter(v => typeof v === 'string' && v.trim())
    .map(v => v.trim())
    .filter(v => !seen.has(v.toLowerCase()) && seen.add(v.toLowerCase()))
}

/** Profile with `title` appended to targetRoles; the same object when blank or already there. */
export function addTargetRole(profile, title) {
  const v = String(title ?? '').trim()
  const roles = profile?.targetRoles ?? []
  if (!v || roles.some(r => r.toLowerCase() === v.toLowerCase())) return profile
  return { ...profile, targetRoles: [...roles, v] }
}

export function openInsights(store, ctx, { tracker = ctx.tracker } = {}) {
  const { t } = ctx
  const titleId = uid('insights')
  let rateBy = 'source'
  let adviceMode = 'training'
  let adviceText = ''
  const briefs = {} // slot → Brief
  const errors = {} // slot → message
  let busy = null // { slot, ac }
  const body = h('div', { class: 'ins-body' })
  const live = h('p', { class: 'visually-hidden', role: 'status', 'aria-live': 'polite' })

  const btn = (label, onClick, action, cls = '') => h('button', { class: `ui-btn ui-btn--sm ${cls}`.trim(), type: 'button', dataset: { action }, onClick }, label)
  const client = () => ctx.ai?.getClient?.() ?? null
  const empty = key => h('p', { class: 'ins-empty ui-muted' }, t(key))
  const card = (key, ...children) => h('section', { class: 'ins-card', dataset: { card: key }, 'aria-labelledby': `${titleId}-${key}` },
    h('h2', { id: `${titleId}-${key}` }, t(`insights.${key}`)), ...children)
  const table = (cols, rows) => h('table', { class: 'ins-table' },
    h('thead', {}, h('tr', {}, cols.map(c => h('th', { scope: 'col' }, c)))),
    h('tbody', {}, rows.map(r => h('tr', {}, r.map((v, i) => h(i ? 'td' : 'th', i ? {} : { scope: 'row' }, String(v)))))))

  function errorText(e) {
    const key = `ai.error.${e?.code}`
    const s = e?.code ? t(key) : key
    return s === key ? e?.message || t('job.error.generic') : s
  }

  // AI: connect first, consent per provider, never a call without both
  async function generate(slot, mode, args) {
    if (busy) return
    const c = client()
    if (!c) return ctx.openAiDialog?.()
    if (ctx.ai.ensureConsent && !(await ctx.ai.ensureConsent(getConnection()?.provider))) return
    const ac = new AbortController()
    busy = { slot, ac }
    errors[slot] = ''
    render()
    try {
      const assist = createAssist({ client: withSignal(c, ac.signal), getState: () => ({ content: store.state.content, doc: store.state.doc }) })
      briefs[slot] = await assist.brief(mode, args)
      live.textContent = t('insights.ready')
    } catch (e) {
      if (!ac.signal.aborted) errors[slot] = errorText(e)
    } finally {
      busy = null
      render()
    }
  }

  function aiButton(slot, label, run) {
    if (!client()) return btn(t('insights.connect'), () => ctx.openAiDialog?.(), 'insights-connect')
    const b = btn(busy?.slot === slot ? t('insights.working') : label, run, `insights-${slot}`)
    b.disabled = !!busy
    return b
  }

  function briefView(slot) {
    const b = briefs[slot]
    return [
      errors[slot] && h('p', { class: 'ins-error', role: 'alert' }, errors[slot]),
      b && h('article', { class: 'ins-brief' },
        h('h3', {}, b.title),
        b.sections.map(s => [h('h4', {}, s.heading), s.body && h('p', {}, s.body), s.items.length > 0 && h('ul', {}, s.items.map(i => h('li', {}, i)))]),
        b.needsInput.length > 0 && [h('h4', {}, t('insights.needsInput')), h('ul', {}, b.needsInput.map(i => h('li', {}, i)))],
        h('p', { class: 'ui-muted' }, t('insights.draft')))
    ]
  }

  // ---------- cards ----------
  function funnelCard(jobs) {
    const rows = funnel(jobs)
    const top = rows[0].count || 1
    return card('funnel',
      h('ol', { class: 'ins-funnel' }, rows.map((r, i) => h('li', {},
        h('span', { class: 'ins-funnel__label' }, t(`insights.stage.${r.stage}`)),
        h('span', { class: 'ins-bar' }, h('span', { style: { width: `${Math.round(r.count / top * 100)}%` } })),
        h('span', { class: 'ins-funnel__num' }, String(r.count), i > 0 && h('span', { class: 'ui-muted' }, ` · ${pct(r.rate)}%`))))),
      h('div', { class: 'ins-actions' }, btn(t('insights.exportCsv'), () => download('recto-funnel.csv', funnelCsv(rows), 'text/csv'), 'insights-csv')))
  }

  function ratesCard(jobs) {
    const rows = rates(jobs, rateBy)
    const by = h('select', { class: 'ui-select', 'aria-label': t('insights.rates.by'), dataset: { field: 'rates-by' }, onChange: e => { rateBy = e.target.value; render() } },
      RATE_KEYS.map(k => h('option', { value: k, selected: k === rateBy }, t(`insights.by.${k}`))))
    return card('rates', by, rows.length
      ? table([t(`insights.by.${rateBy}`), t('insights.col.applied'), t('insights.col.responded'), t('insights.col.interviews'), t('insights.col.offers'), t('insights.col.rate')],
        rows.map(r => [r.key, r.applied, r.responded, r.interviews, r.offers, `${pct(r.rate)}%`]))
      : empty('insights.noApplied'))
  }

  function rejectionsCard(jobs) {
    const r = rejections(jobs)
    const tally = (items, key) => h('ul', { class: 'ins-list' }, items.map(i => h('li', {}, h('span', {}, i[key]), h('span', { class: 'ui-muted' }, String(i.count)))))
    return card('rejections', r.total ? [
      h('p', {}, t('insights.rejections.total', { count: r.total })),
      h('h3', {}, t('insights.rejections.stages')), tally(r.stages, 'stage'),
      h('h3', {}, t('insights.rejections.reasons')), r.reasons.length ? tally(r.reasons, 'reason') : empty('insights.rejections.noReasons')
    ] : empty('insights.rejections.none'))
  }

  function repostsCard(jobs) {
    const list = reposts(jobs)
    return card('reposts', h('p', { class: 'ui-muted' }, t('insights.reposts.hint')), list.length
      ? h('ul', { class: 'ins-list' }, list.map(r => h('li', {},
        h('span', {}, `${r.title} — ${r.company}`), h('span', { class: 'ui-muted' }, t(`insights.repost.${r.reason}`, { n: r.ids.length })))))
      : empty('insights.reposts.none'))
  }

  function calibrationCard(jobs) {
    const rows = calibration(jobs)
    return card('calibration', h('p', { class: 'ui-muted' }, t('insights.calibration.hint')), rows.some(r => r.applied)
      ? table([t('insights.col.band'), t('insights.col.applied'), t('insights.col.interviews'), t('insights.col.interviewRate')],
        rows.map(r => [`★ ${r.band}`, r.applied, r.interviews, `${pct(r.rate)}%`]))
      : empty('insights.calibration.none'))
  }

  function gapsCard(jobs) {
    const gaps = skillGaps(jobs)
    return card('gaps', gaps.length ? [
      h('ul', { class: 'ins-list' }, gaps.map(g => h('li', {}, h('span', {}, g.skill), h('span', { class: 'ui-muted' }, t('insights.gaps.jobs', { count: g.count }))))),
      h('div', { class: 'ins-actions' }, aiButton('upskill', t('insights.gaps.ai'),
        () => generate('upskill', 'upskill', { extra: { profile: loadProfile(), gaps } }))),
      briefView('upskill')
    ] : empty('insights.gaps.none'))
  }

  function titlesCard(jobs) {
    const profile = loadProfile()
    const seeds = titleSeeds(jobs, profile)
    const titles = adjacentTitles(seeds)
    const add = v => {
      saveProfile(addTargetRole(loadProfile(), v))
      live.textContent = t('insights.titles.added', { title: v })
      render()
    }
    return card('titles', titles.length
      // adjacentTitles never returns its inputs, so a title already in targetRoles is not listed
      ? h('ul', { class: 'ins-list' }, titles.map(v => h('li', {}, h('span', {}, v), h('button', {
        class: 'ui-btn ui-btn--sm', type: 'button', dataset: { action: 'insights-add-role' }, 'aria-label': t('insights.titles.addFor', { title: v }), onClick: () => add(v)
      }, t('insights.titles.add')))))
      : empty('insights.titles.none'),
    h('div', { class: 'ins-actions' }, aiButton('titles', t('insights.titles.ai'),
      () => generate('titles', 'titles', { extra: { profile, adjacent: titles, seeds } }))),
    briefView('titles'))
  }

  function adviceCard() {
    const id = uid('advice')
    const mode = h('select', { class: 'ui-select', 'aria-label': t('insights.advice.kind'), dataset: { field: 'advice-mode' }, onChange: e => { adviceMode = e.target.value } },
      ['training', 'project'].map(m => h('option', { value: m, selected: m === adviceMode }, t(`insights.advice.${m}`))))
    const text = h('textarea', {
      class: 'ui-textarea ins-advice', id, rows: 4, value: adviceText, placeholder: t('insights.advice.placeholder'),
      dataset: { field: 'advice-text' }, onInput: e => { adviceText = e.target.value }
    })
    const ask = () => adviceText.trim() ? generate('advice', adviceMode, { notes: adviceText, extra: { profile: loadProfile() } }) : text.focus()
    return card('advice', h('p', { class: 'ui-muted' }, t('insights.advice.hint')),
      mode, h('label', { class: 'ui-label', htmlFor: id }, t('insights.advice.label')), text,
      h('div', { class: 'ins-actions' }, aiButton('advice', t('insights.advice.ai'), ask)),
      briefView('advice'))
  }

  function render() {
    const jobs = tracker.list()
    body.replaceChildren(...(jobs.length
      ? [funnelCard(jobs), ratesCard(jobs), calibrationCard(jobs), rejectionsCard(jobs), repostsCard(jobs), gapsCard(jobs), titlesCard(jobs), adviceCard()]
      : [h('div', { class: 'ins-none' }, empty('insights.empty'),
        h('div', { class: 'ins-actions' },
          ctx.openDiscover && btn(t('cmd.app.discover'), () => ctx.openDiscover(), 'insights-discover'),
          ctx.openPipeline && btn(t('insights.pipeline'), () => ctx.openPipeline(), 'insights-pipeline'))),
      adviceCard()]))
  }

  const dialog = h('dialog', { class: 'board insights', 'aria-labelledby': titleId },
    h('header', { class: 'board-head' },
      h('h1', { class: 'visually-hidden', id: titleId, tabIndex: -1 }, t('insights.title')),
      hubNav(ctx, 'insights'),
      h('span', { class: 'ui-muted board-head__intro' }, t('insights.intro')),
      h('span', { class: 'ui-spacer' }),
      btn(t('board.close'), () => close(), 'insights-close')),
    body, live)
  dialog.addEventListener('close', () => busy?.ac.abort(), { once: true })
  render()
  const close = ctx.openDialog(dialog)
  dialog.querySelector('h1').focus()
  return close
}
