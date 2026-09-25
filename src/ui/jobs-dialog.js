// Jobs tracker dialog (assist spec §7): saved jobs with status, scores, linked documents, export/import.
import { h } from './dom.js'
import { dialogBox, ask } from './topbar.js'
import { STATUSES } from '../jobs/tracker.js'
import { openFile, download } from '../io/files.js'

/** Score of the newest evaluation of `kind` ('local' 0–100, 'ai' 1–5), or null. */
export function latestScore(job, kind) {
  const ev = (job.evaluations ?? []).findLast(e => e.kind === kind && typeof e.score === 'number')
  return ev ? ev.score : null
}

export const filterJobs = (jobs, status) => status ? jobs.filter(j => j.status === status) : jobs

export function openJobsDialog(store, ctx, { tracker = ctx.tracker } = {}) {
  const { t } = ctx
  let status = ''
  const dash = '—'
  const rows = h('tbody')
  const filter = h('select', {
    class: 'ui-select', 'aria-label': t('jobs.filter'), dataset: { field: 'status-filter' },
    onChange: e => { status = e.target.value; render() },
  }, h('option', { value: '' }, t('jobs.filter.all')), STATUSES.map(s => h('option', { value: s }, t(`jobs.status.${s}`))))

  const docName = id => store.state.docs.find(d => d.id === id)?.name || t('app.untitled')
  const hasDoc = id => store.state.docs.some(d => d.id === id)

  function openJob(id) {
    store.setUi({ panel: 'job', jobId: id, tab: 'check' })
    close()
  }
  function openDocument(id) {
    if (store.openDoc(id)) close()
    else ctx.toast(t('jobs.docMissing'))
  }
  function remove(job) {
    ask(ctx, {
      title: t('jobs.delete'), body: h('p', {}, t('jobs.delete.confirm', { title: job.title || t('jobs.untitled') })),
      confirm: t('jobs.delete'), danger: true, onConfirm() { tracker.remove(job.id); render() },
    })
  }

  function row(job) {
    const label = job.title || t('jobs.untitled')
    const local = latestScore(job, 'local')
    const ai = latestScore(job, 'ai')
    const docs = job.docIds.filter(hasDoc)
    return h('tr', { dataset: { job: job.id } },
      h('td', {}, job.company || dash),
      h('td', {}, h('button', { class: 'jobs-link', type: 'button', dataset: { action: 'job-open' }, onClick: () => openJob(job.id) }, label)),
      h('td', {}, h('select', {
        class: 'ui-select', 'aria-label': t('jobs.status.for', { title: label }), dataset: { field: 'status' },
        onChange: e => { tracker.save({ ...job, status: e.target.value }); render() },
      }, STATUSES.map(s => h('option', { value: s, selected: s === job.status }, t(`jobs.status.${s}`))))),
      h('td', { class: 'jobs-num' }, local == null ? dash : String(local)),
      h('td', { class: 'jobs-num' }, ai == null ? dash : t('jobs.aiScore', { score: ai })),
      h('td', {}, docs.length ? h('ul', { class: 'jobs-docs' }, docs.map(id => h('li', {},
        h('button', { class: 'jobs-link', type: 'button', dataset: { action: 'job-doc' }, onClick: () => openDocument(id) }, docName(id))))) : dash),
      h('td', { class: 'ui-muted' }, job.updatedAt ? new Date(job.updatedAt).toLocaleDateString() : dash),
      h('td', { class: 'jobs-actions' },
        h('button', { class: 'ui-btn ui-btn--sm', type: 'button', onClick: () => openJob(job.id) }, t('jobs.open')),
        h('button', { class: 'ui-btn ui-btn--sm ui-btn--ghost', type: 'button', dataset: { action: 'job-delete' }, 'aria-label': t('jobs.delete.for', { title: label }), onClick: () => remove(job) }, t('jobs.delete'))))
  }

  function render() {
    const all = tracker.list()
    const jobs = filterJobs(all, status)
    rows.replaceChildren(...(jobs.length ? jobs.map(row) : [h('tr', {}, h('td', { class: 'jobs-empty ui-muted', colSpan: 8 },
      all.length ? t('jobs.empty.filter') : t('jobs.empty')))]))
  }

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

  const cols = ['company', 'title', 'status', 'local', 'ai', 'docs', 'updated', 'actions']
  const table = h('table', { class: 'jobs-table' },
    h('thead', {}, h('tr', {}, cols.map(c => h('th', { scope: 'col', class: c === 'local' || c === 'ai' ? 'jobs-num' : undefined },
      c === 'actions' ? h('span', { class: 'visually-hidden' }, t('jobs.col.actions')) : t(`jobs.col.${c}`))))),
    rows)
  const dialog = dialogBox(t('jobs.title'), [
    h('div', { class: 'jobs-bar' }, filter, h('span', { class: 'ui-muted' }, t('jobs.hint'))),
    h('div', { class: 'jobs-scroll' }, table),
  ], [
    h('button', { class: 'ui-btn', type: 'button', dataset: { action: 'jobs-import' }, onClick: importJobs }, t('jobs.import')),
    h('button', { class: 'ui-btn', type: 'button', dataset: { action: 'jobs-export' }, onClick: exportJobs }, t('jobs.export')),
    h('span', { class: 'ui-spacer' }),
    h('button', { class: 'ui-btn ui-btn--primary', type: 'button', onClick: () => close() }, t('ai.close')),
  ])
  dialog.classList.add('ui-dialog--wide', 'jobs-dialog')
  render()
  const close = ctx.openDialog(dialog)
  return close
}
