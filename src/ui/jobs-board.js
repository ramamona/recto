// Jobs board (review-jobs spec §5): full-screen kanban over the tracker, detail drawer, search, export/import.
import { h, uid } from './dom.js'
import { ask } from './topbar.js'
import { STATUSES, staleApplied } from '../jobs/tracker.js'
import { openFile, download } from '../io/files.js'

export const COLUMNS = STATUSES
const COLLAPSED = 'skipped'
const DAY = 864e5
const num = v => typeof v === 'number' && Number.isFinite(v)
const evals = job => Array.isArray(job?.evaluations) ? job.evaluations.filter(e => e && typeof e === 'object') : []
const safeUrl = u => /^https?:\/\//i.test(u ?? '') ? u : null

/** { status: jobs[] } for every column; unknown statuses land in Saved; `query` matches title/company/location/notes. */
export function groupJobs(jobs, query) {
  const q = String(query ?? '').trim().toLowerCase()
  const out = Object.fromEntries(COLUMNS.map(s => [s, []]))
  for (const j of jobs) {
    if (q && ![j.title, j.company, j.location, j.notes].some(v => String(v ?? '').toLowerCase().includes(q))) continue
    out[COLUMNS.includes(j.status) ? j.status : 'saved'].push(j)
  }
  return out
}

/** Neighbouring column for ←/→ (dir -1/1), or null at the edge. */
export const stepStatus = (status, dir) => COLUMNS[COLUMNS.indexOf(status) + dir] ?? null

/** Whole days since the last status change, or null when unknown. */
export function daysSince(job, now = new Date()) {
  const at = Date.parse(job?.statusHistory?.at(-1)?.at ?? job?.updatedAt)
  return Number.isFinite(at) ? Math.max(0, Math.floor((+now - at) / DAY)) : null
}

/** Newest stored Evaluation (`source` local|ai); legacy `kind` scores are not evaluations. */
export const latestEvaluation = job => evals(job).findLast(e => e.source === 'local' || e.source === 'ai') ?? null

/** Card scores: newest match estimate (0–100) and ★ score (1–5), AI preferred over local. */
export function scoresOf(job) {
  const list = evals(job)
  // job-panel stores `match: <number>`; `{score}` and source-less legacy `kind: 'local'` scores are older shapes.
  const matchOf = e => num(e.match) ? e.match : num(e.match?.score) ? e.match.score
    : !e.source && e.kind === 'local' && num(e.score) ? e.score : null
  const m = list.findLast(e => matchOf(e) !== null)
  const star = src => list.findLast(e => (e.source === src || (src === 'ai' && e.kind === 'ai')) && num(e.score))
  const s = star('ai') ?? star('local')
  return {
    match: m ? matchOf(m) : null,
    stars: s ? { score: s.score, source: s.source ?? s.kind } : null
  }
}

export function openJobsBoard(store, ctx, { tracker = ctx.tracker, now = () => new Date() } = {}) {
  const { t } = ctx
  let query = ''
  let openId = null
  let showSkipped = false
  const titleId = uid('board')
  const label = job => job.title || t('jobs.untitled')
  const liveDocs = job => (job.docIds ?? []).filter(id => store.state.docs.some(d => d.id === id))
  const docName = id => store.state.docs.find(d => d.id === id)?.name || t('app.untitled')
  const stars = s => t('board.stars', { score: s.score.toFixed(1), source: t(`board.source.${s.source === 'ai' ? 'ai' : 'local'}`) })

  const live = h('p', { class: 'visually-hidden', role: 'status', 'aria-live': 'polite' })
  const counts = h('span', { class: 'board-counts ui-muted' })
  const columns = h('div', { class: 'board-columns' })
  const drawer = h('aside', { class: 'board-drawer', hidden: true, 'aria-label': t('board.details') })

  function move(id, status, { focus = false } = {}) {
    const job = tracker.get(id)
    if (!job || !status || job.status === status) return
    tracker.save({ ...job, status })
    live.textContent = t('board.moved', { title: label(job), status: t(`jobs.status.${status}`) })
    render()
    if (focus) columns.querySelector(`[data-job="${CSS.escape(id)}"]`)?.focus()
  }

  function openDocument(id) {
    if (store.openDoc(id)) close()
    else ctx.toast(t('jobs.docMissing'))
  }
  const docButtons = job => liveDocs(job).map(id => h('button', {
    class: 'board-doc', type: 'button', dataset: { action: 'board-doc' }, onClick: e => { e.stopPropagation(); openDocument(id) }
  }, docName(id)))

  function card(job) {
    const { match, stars: s } = scoresOf(job)
    const days = daysSince(job, now())
    const stale = staleApplied(job, now())
    return h('article', {
      class: `board-card${job.id === openId ? ' is-open' : ''}`, tabIndex: 0, draggable: 'true',
      dataset: { job: job.id }, 'aria-label': t('board.card', { title: label(job), company: job.company || t('board.noCompany') }),
      onDragstart: e => { e.dataTransfer.setData('text/plain', job.id); e.dataTransfer.effectAllowed = 'move' },
      onClick: () => showDrawer(job.id),
      onKeydown: e => {
        if (e.target !== e.currentTarget || e.altKey || e.metaKey || e.ctrlKey) return
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showDrawer(job.id) }
        const dir = { ArrowLeft: -1, ArrowRight: 1 }[e.key]
        if (dir) { e.preventDefault(); move(job.id, stepStatus(job.status, dir), { focus: true }) }
      }
    },
    job.company && h('p', { class: 'board-card__company' }, job.company),
    h('h3', { class: 'board-card__title' }, label(job)),
    job.location && h('p', { class: 'board-card__meta ui-muted' }, job.location),
    h('p', { class: 'board-card__scores' },
      match != null && h('span', { class: 'board-chip' }, t('board.match', { score: Math.round(match) })),
      s && h('span', { class: 'board-chip board-chip--stars' }, stars(s)),
      days != null && h('span', { class: 'ui-muted' }, t('board.days', { days }))),
    liveDocs(job).length > 0 && h('div', { class: 'board-card__docs' }, docButtons(job)),
    stale && h('p', { class: 'board-card__stale' }, h('button', {
      class: 'ui-btn ui-btn--sm', type: 'button', dataset: { action: 'board-stale' },
      onClick: e => { e.stopPropagation(); move(job.id, 'no-response') }
    }, t('board.stale'))))
  }

  function column(status, jobs) {
    const collapsed = status === COLLAPSED && !showSkipped && !query
    const head = h('h2', { class: 'board-col__title' }, t(`jobs.status.${status}`), ' ', h('span', { class: 'board-col__count' }, String(jobs.length)))
    return h('section', {
      class: `board-col${collapsed ? ' is-collapsed' : ''}`, dataset: { status },
      onDragover: e => { e.preventDefault(); e.currentTarget.classList.add('is-over') },
      onDragleave: e => { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.classList.remove('is-over') },
      onDrop: e => { e.preventDefault(); e.currentTarget.classList.remove('is-over'); move(e.dataTransfer.getData('text/plain'), status) }
    },
    status === COLLAPSED
      ? h('button', { class: 'board-col__toggle', type: 'button', 'aria-expanded': String(!collapsed), onClick: () => { showSkipped = !showSkipped; render() } }, head)
      : head,
    !collapsed && h('div', { class: 'board-col__cards' }, jobs.map(card)))
  }

  function render() {
    const all = tracker.list()
    const groups = groupJobs(all, query)
    counts.textContent = all.length ? t('board.total', { count: all.length }) : t('jobs.empty')
    columns.replaceChildren(...COLUMNS.map(s => column(s, groups[s])))
    if (openId) renderDrawer()
  }

  // ---------- detail drawer ----------
  function showDrawer(id) {
    openId = id
    render()
    drawer.querySelector('.board-drawer__title')?.focus()
  }
  function hideDrawer() {
    const id = openId
    openId = null
    drawer.hidden = true
    render()
    if (id) columns.querySelector(`[data-job="${CSS.escape(id)}"]`)?.focus()
  }

  function evaluationSummary(job) {
    const ev = latestEvaluation(job)
    const { match, stars: s } = scoresOf(job)
    if (!ev && !s && match == null) return h('p', { class: 'ui-muted' }, t('board.noEvaluation'))
    const unmet = (ev?.rows ?? []).filter(r => r?.match === 'missing' && r.importance !== 'meaningful').slice(0, 5)
    return [
      h('p', { class: 'board-eval__score' },
        s && h('strong', {}, stars(s)),
        ev?.recommendation && h('span', { class: `board-rec is-${ev.recommendation}` }, t(`board.rec.${ev.recommendation}`)),
        match != null && h('span', { class: 'ui-muted' }, t('board.match', { score: Math.round(match) }))),
      ev?.role?.tldr && h('p', {}, ev.role.tldr),
      (ev?.caps ?? []).map(c => h('p', { class: 'board-eval__cap' }, t(`board.cap.${c}`))),
      ev?.legitimacy?.level && ev.legitimacy.level !== 'ok' && h('p', { class: 'board-eval__cap' }, t(`board.legit.${ev.legitimacy.level}`)),
      unmet.length > 0 && [h('h4', {}, t('board.unmet')), h('ul', { class: 'board-eval__rows' }, unmet.map(r => h('li', {}, r.jdSignal || r.requirement || '')))]
    ]
  }

  function remove(job) {
    ask(ctx, {
      title: t('jobs.delete'), body: h('p', {}, t('jobs.delete.confirm', { title: label(job) })),
      confirm: t('jobs.delete'), danger: true, onConfirm() { tracker.remove(job.id); hideDrawer() }
    })
  }

  function renderDrawer() {
    const job = tracker.get(openId)
    if (!job) { openId = null; drawer.hidden = true; return }
    const url = safeUrl(job.url)
    const notes = h('textarea', {
      class: 'ui-input board-notes', rows: 6, value: job.notes, dataset: { field: 'notes' },
      onChange: e => { const cur = tracker.get(job.id); if (cur) tracker.save({ ...cur, notes: e.target.value }) }
    })
    const notesId = uid('notes')
    notes.id = notesId
    drawer.hidden = false
    drawer.replaceChildren(
      h('header', { class: 'board-drawer__head' },
        h('h2', { class: 'board-drawer__title', tabIndex: -1 }, label(job)),
        h('button', { class: 'ui-btn ui-btn--sm ui-btn--ghost', type: 'button', 'aria-label': t('board.closeDetails'), onClick: hideDrawer }, '×')),
      h('p', { class: 'ui-muted' }, [job.company, job.location].filter(Boolean).join(' · ')),
      h('div', { class: 'board-drawer__row' },
        h('select', {
          class: 'ui-select', 'aria-label': t('jobs.status.for', { title: label(job) }), dataset: { field: 'status' },
          onChange: e => move(job.id, e.target.value)
        }, COLUMNS.map(s => h('option', { value: s, selected: s === job.status }, t(`jobs.status.${s}`)))),
        url && h('a', { class: 'ui-btn ui-btn--sm', href: url, target: '_blank', rel: 'noopener noreferrer' }, t('board.sourceLink')),
        h('button', { class: 'ui-btn ui-btn--sm', type: 'button', dataset: { action: 'board-job-tab' }, onClick: () => { store.setUi({ panel: 'job', jobId: job.id }); close() } }, t('board.openJobTab'))),
      h('section', { class: 'board-eval' }, h('h3', {}, t('board.evaluation')), evaluationSummary(job)),
      h('section', {}, h('h3', {}, h('label', { htmlFor: notesId }, t('board.notes'))), notes),
      h('section', {}, h('h3', {}, t('board.timeline')), h('ol', { class: 'board-timeline' },
        (job.statusHistory ?? []).map(e => h('li', {}, h('span', {}, t(`jobs.status.${e.status}`)), ' ',
          h('time', { class: 'ui-muted', datetime: e.at }, new Date(e.at).toLocaleDateString()))))),
      h('section', {}, h('h3', {}, t('board.docs')),
        liveDocs(job).length ? h('div', { class: 'board-card__docs' }, docButtons(job)) : h('p', { class: 'ui-muted' }, t('board.noDocs'))),
      h('footer', { class: 'board-drawer__foot' },
        h('button', { class: 'ui-btn ui-btn--danger ui-btn--sm', type: 'button', dataset: { action: 'board-delete' }, onClick: () => remove(job) }, t('jobs.delete'))))
  }

  // ---------- export / import ----------
  async function importJobs() {
    try {
      const f = await openFile({ accept: '.json' })
      if (!f) return
      const { added, warnings } = tracker.import(f.text)
      render()
      ctx.toast([t('jobs.imported', { count: added }), ...warnings.slice(0, 3).map(w => t(`jobs.import.${w.code}`, { n: (w.index ?? 0) + 1 }))].join(' '))
    } catch (err) {
      console.error(err)
      ctx.toast(t('app.file.failed'))
    }
  }
  const exportJobs = () => download('recto-jobs.json', tracker.export(), 'application/json')

  const search = h('input', {
    class: 'ui-input board-search', type: 'search', placeholder: t('board.search'), 'aria-label': t('board.search'),
    onInput: e => { query = e.target.value; render() }
  })
  const dialog = h('dialog', { class: 'board', 'aria-labelledby': titleId },
    h('header', { class: 'board-head' },
      h('h1', { class: 'board-head__title', id: titleId }, t('jobs.title')), counts, search,
      h('span', { class: 'ui-spacer' }),
      h('button', { class: 'ui-btn ui-btn--sm', type: 'button', dataset: { action: 'jobs-import' }, onClick: importJobs }, t('jobs.import')),
      h('button', { class: 'ui-btn ui-btn--sm', type: 'button', dataset: { action: 'jobs-export' }, onClick: exportJobs }, t('jobs.export')),
      h('button', { class: 'ui-btn ui-btn--sm ui-btn--primary', type: 'button', dataset: { action: 'board-close' }, onClick: () => close() }, t('board.close'))),
    h('p', { class: 'board-hint ui-muted' }, t('board.hint')),
    h('div', { class: 'board-body' }, columns, drawer),
    live)
  // Esc closes the drawer first, then the board (keydown too: Chrome ignores cancel's preventDefault without user activation)
  const escDrawer = e => { if (openId && (e.type === 'cancel' || e.key === 'Escape')) { e.preventDefault(); hideDrawer() } }
  dialog.addEventListener('keydown', escDrawer)
  dialog.addEventListener('cancel', escDrawer)
  render()
  const close = ctx.openDialog(dialog)
  search.focus()
  return close
}
