// Application pack (discover-apply spec §3, §5): per job a tailored CV, cover letter, drafted screening answers and
// standard fields, plus Open application page, Download PDF, Mark applied and the exact `recto autoapply` command.
// Opened from a Discover card, the board's card drawer, the Job tab or the command bar.
import { h } from './dom.js'
import { addCoverLetterDoc, withSignal } from './job-panel.js'
import { loadProfile } from '../profile.js'
import { buildPack } from '../jobs/pack.js'
import { parseJob } from '../jobs/parse.js'
import { createAssist } from '../ai/assist.js'
import { getConnection } from '../ai/connections.js'
import { download } from '../io/files.js'

const safeUrl = u => /^https?:\/\//i.test(u ?? '') ? u : null
const shq = s => /^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`

const fileSafe = s => String(s).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')

/** Jobs file holding only this job, so `recto autoapply` works on exactly this application. */
export const jobsFileFor = jobId => `recto-job-${fileSafe(jobId)}.json`

/** The command that fills this job's application in a visible Chrome and stops before Submit (spec §4). */
export const autoapplyCommand = (jobsFile, cvFile) => `recto autoapply --jobs ${shq(jobsFile)} --cv ${shq(cvFile)}`

export function openPack(store, ctx, jobId, { onChange } = {}) {
  const { t, tracker } = ctx
  const current = () => {
    const job = tracker.get(jobId)
    return job && { ...job, applyUrl: job.applyUrl || job.url, pack: job.pack ?? null }
  }
  if (!current()) return ctx.toast?.(t('job.notFound'))
  let busy = null // AbortController while building
  const body = h('div', { class: 'pack-body' })
  const title = h('h2', { tabIndex: -1 })
  const dialog = h('dialog', { class: 'pack', closedby: 'any', 'aria-label': t('pack.title') },
    h('header', { class: 'pack-head' }, title,
      h('button', { class: 'ui-btn ui-btn--sm ui-btn--ghost', type: 'button', 'aria-label': t('pack.close'), onClick: () => close() }, '×')),
    body)
  dialog.addEventListener('close', () => busy?.abort(), { once: true })

  const docName = id => store.state.docs.find(d => d.id === id)?.name ?? null
  const cvName = () => store.state.name || store.state.doc.header?.name || t('app.untitled')
  const btn = (label, onClick, action, cls = '') => h('button', { class: `ui-btn ui-btn--sm ${cls}`.trim(), type: 'button', dataset: { action }, onClick }, label)
  const copy = text => navigator.clipboard?.writeText(text).then(() => ctx.toast?.(t('pack.copied')), () => ctx.toast?.(t('pack.copyFailed')))

  // The pack lives on the tracker job, so it survives reloads and travels in the jobs export
  function savePack(pack) {
    const job = tracker.get(jobId)
    if (job) tracker.save({ ...job, pack })
    onChange?.()
  }

  async function aiClient(signal) {
    const client = ctx.ai?.getClient?.()
    if (!client) return null
    const ok = ctx.ai.ensureConsent ? await ctx.ai.ensureConsent(getConnection()?.provider) : true
    return ok ? withSignal(client, signal) : null
  }
  const promptJob = job => ({ ...job, keywords: parseJob(job.text ?? '').keywords ?? [] })
  const assistFor = client => createAssist({ client, getState: () => ({ content: store.state.content, doc: store.state.doc }) })

  // Greenhouse exposes the form's questions on the job detail; others (and failures) get the common set.
  async function withQuestions(job, signal) {
    if (job.questions?.length || job.source !== 'greenhouse') return job
    try {
      const { fetchDetails } = await import('../jobs/sources.js')
      return await fetchDetails({ ...job, board: job.board || job.id.split(':')[1] }, { fetch: (...a) => globalThis.fetch(...a), signal })
    } catch (err) {
      console.warn('recto: pack questions unavailable', err)
      return job
    }
  }

  // Tailored CV = a copy of the open CV linked to the job (reused on a rebuild while it still exists); with AI, its
  // tailor cards wait in the Suggest tab.
  async function build() {
    const ac = busy = new AbortController()
    render()
    try {
      const job = await withQuestions(current(), ac.signal)
      const client = await aiClient(ac.signal)
      const name = cvName()
      let tailored = null
      if (client) {
        tailored = await assistFor(client).tailor(promptJob(job)).catch(err => {
          if (!ac.signal.aborted) ctx.toast?.(t('pack.tailorFailed'))
          console.warn('recto: pack tailor', err)
          return null
        })
      }
      if (ac.signal.aborted) return
      const prev = job.pack
      if (!(prev?.cvDocId && docName(prev.cvDocId) && store.openDoc(prev.cvDocId))) {
        store.duplicateDoc()
        store.renameDoc(`${name} — ${job.company || job.title || t('job.untitled')}`)
      }
      const cvDocId = store.state.docId
      tracker.link(jobId, cvDocId)
      if (tailored?.suggestions?.length) {
        ctx.assistQueue ??= new Map()
        ctx.assistQueue.set(cvDocId, tailored.suggestions)
      }
      const pack = await buildPack({
        job, profile: loadProfile(), assist: client ? assistFor(client) : undefined,
        cv: { docId: cvDocId, content: store.state.content, doc: store.state.doc },
      })
      if (tailored?.suggestions?.length) pack.tailored = true
      if (prev?.coverLetterDocId) pack.coverLetterDocId = prev.coverLetterDocId
      savePack(pack)
    } catch (err) {
      if (!ac.signal.aborted) {
        console.error('recto: pack failed', err)
        ctx.toast?.(t('pack.failed'))
      }
    } finally {
      busy = null
      if (dialog.open) render()
    }
  }

  function openDoc(id, then) {
    if (store.state.docId === id) {
      closeAll()
      return then?.()
    }
    if (!store.openDoc(id)) return ctx.toast?.(t('jobs.docMissing'))
    closeAll()
    if (!then) return
    // print once the opened doc has rendered; give up quietly rather than print much later
    const off = store.subscribe((s, changed) => { if (changed.has('report')) { off(); clearTimeout(timer); then() } })
    const timer = setTimeout(off, 10000)
  }
  const closeAll = () => document.querySelectorAll('#dialogs dialog[open]').forEach(d => d.close())

  async function coverLetter(job, pack) {
    const ac = busy = new AbortController()
    render()
    try {
      const client = await aiClient(ac.signal)
      if (!client) return
      const letter = await assistFor(client).coverLetter(promptJob(job))
      const id = addCoverLetterDoc(store, letter, `${cvName()} — ${t('job.letter.name')} — ${job.company || job.title || t('job.untitled')}`)
      tracker.link(jobId, id)
      savePack({ ...pack, coverLetterDocId: id })
    } catch (err) {
      if (!ac.signal.aborted) ctx.toast?.(t('pack.letterFailed'))
      console.warn('recto: pack cover letter', err)
    } finally {
      busy = null
      if (dialog.open) render()
    }
  }

  // tracker.export's format with just this job (pack and apply URL included)
  const jobsExport = job => JSON.stringify({ format: 'recto-jobs', version: 1, jobs: [job] }, null, 2)

  function markApplied() {
    const job = tracker.get(jobId)
    if (!job) return
    tracker.save({ ...job, status: 'applied' })
    ctx.toast?.(t('pack.applied', { title: job.title || t('job.untitled') }))
    onChange?.()
    render()
  }

  // ---------- view ----------
  function cvSection(pack) {
    const name = docName(pack.cvDocId)
    return [h('h3', {}, t('pack.cv')),
      name ? h('p', {}, name) : h('p', { class: 'ui-muted' }, t('jobs.docMissing'), ' ', btn(t('pack.prepare'), build, 'pack-build')),
      pack.tailored && h('p', { class: 'pack-note' }, t('pack.reviewTailored')),
      name && h('div', { class: 'pack-actions' },
        btn(t('pack.openDoc'), () => openDoc(pack.cvDocId), 'pack-open-cv'),
        btn(t('pack.pdf'), () => openDoc(pack.cvDocId, () => ctx.topbar?.print?.()), 'pack-pdf'),
        h('span', { class: 'ui-muted' }, pack.pdfName))]
  }

  function letterSection(job, pack) {
    const name = pack.coverLetterDocId && docName(pack.coverLetterDocId)
    return [h('h3', {}, t('pack.letter')),
      name ? h('div', { class: 'pack-actions' }, h('span', {}, name), btn(t('pack.openDoc'), () => openDoc(pack.coverLetterDocId), 'pack-open-letter'))
        : ctx.ai?.getClient?.() ? btn(t('pack.letter.create'), () => coverLetter(job, pack), 'pack-letter')
          : h('p', { class: 'ui-muted' }, t('pack.letter.needsAi'), ' ',
            h('button', { class: 'job-profile-link', type: 'button', onClick: () => ctx.openAiDialog?.() }, t('pack.letter.connect')))]
  }

  function question(a, i, pack) {
    const update = value => {
      const cur = current()?.pack ?? pack // other answers may have been edited since this render
      savePack({ ...cur, answers: cur.answers.map((x, k) => k === i ? { ...x, answer: value } : x) })
    }
    const id = `pack-q-${i}`
    const control = a.options?.length
      ? h('select', { class: 'ui-select', id, onChange: e => update(e.target.value) },
        h('option', { value: '' }, t('pack.choose')), a.options.map(o => h('option', { value: o, selected: o === a.answer }, o)))
      : a.type === 'textarea' ? h('textarea', { class: 'ui-input pack-q__text', id, rows: 4, value: a.answer, onChange: e => update(e.target.value) })
        : h('input', { class: 'ui-input', id, type: 'text', value: a.answer, onChange: e => update(e.target.value) })
    const shown = !a.answer ? 'unanswered' : a.source === 'unanswered' ? 'you' : a.source
    return h('div', { class: 'pack-q', dataset: { source: shown } },
      h('div', { class: 'pack-q__head' },
        h('label', { class: 'pack-q__label', htmlFor: id }, a.question, a.required && h('span', { 'aria-label': t('pack.required') }, '*'),
          h('span', { class: `pack-badge is-${shown}` }, t(`pack.source.${shown}`))),
        h('button', { class: 'ui-btn ui-btn--sm ui-btn--ghost', type: 'button', dataset: { action: 'pack-copy' }, 'aria-label': t('pack.copyField', { label: a.question }), onClick: () => copy(control.value) }, t('pack.copy'))),
      control)
  }

  function render() {
    const job = current()
    if (!job) return close()
    title.textContent = job.title || t('job.untitled')
    const meta = [job.company, job.location].filter(Boolean).join(' · ')
    const url = safeUrl(job.applyUrl)
    const head = [meta && h('p', { class: 'ui-muted' }, meta),
      h('div', { class: 'pack-actions' },
        url && h('a', { class: 'ui-btn ui-btn--sm ui-btn--primary', href: url, target: '_blank', rel: 'noopener noreferrer', dataset: { action: 'pack-open-page' } }, t('pack.openPage')),
        job.status === 'applied' ? h('span', { class: 'ui-badge is-ok' }, t('pack.isApplied'))
          : btn(t('pack.markApplied'), markApplied, 'pack-applied'))]
    if (busy) {
      return body.replaceChildren(...head.filter(Boolean), h('div', { class: 'pack-busy', role: 'status' },
        h('span', { class: 'job-spinner', 'aria-hidden': 'true' }), t('pack.busy'), btn(t('app.cancel'), () => busy?.abort(), 'pack-cancel')))
    }
    const pack = job.pack
    if (!pack) {
      return body.replaceChildren(...head.filter(Boolean), h('p', { class: 'ui-muted' }, t('pack.empty')), btn(t('pack.prepare'), build, 'pack-build', 'ui-btn--primary'))
    }
    const unanswered = pack.answers.filter(a => a.required && !a.answer).length
    const cvFile = fileSafe(`${docName(pack.cvDocId) || 'cv'}.cv.json`)
    const jobsFile = jobsFileFor(jobId)
    const command = autoapplyCommand(jobsFile, cvFile)
    body.replaceChildren(...[head,
      cvSection(pack),
      letterSection(job, pack),
      h('h3', {}, t('pack.questions', { n: pack.answers.length })),
      unanswered > 0 && h('p', { class: 'pack-note' }, t('pack.unanswered', { n: unanswered })),
      pack.answers.map((a, i) => question(a, i, pack)),
      h('h3', {}, t('pack.fields')),
      pack.fields.length ? h('dl', { class: 'pack-fields' }, pack.fields.map(f => [h('dt', {}, f.label), h('dd', {}, f.value),
        h('button', { class: 'ui-btn ui-btn--sm ui-btn--ghost', type: 'button', 'aria-label': t('pack.copyField', { label: f.label }), onClick: () => copy(f.value) }, t('pack.copy'))]))
        : h('p', { class: 'ui-muted' }, t('pack.noFields'), ' ', h('button', { class: 'job-profile-link', type: 'button', onClick: () => ctx.openProfileDialog?.() }, t('pack.editProfile'))),
      h('h3', {}, t('pack.cli')),
      h('p', { class: 'ui-muted' }, t('pack.cli.hint', { jobs: jobsFile, cv: cvFile })),
      h('code', { class: 'pack-cli' }, command),
      h('div', { class: 'pack-actions' },
        btn(t('pack.copy'), () => copy(command), 'pack-copy-cli'),
        btn(t('pack.jobsFile'), () => download(jobsFile, jobsExport(job), 'application/json'), 'pack-jobs-file')),
      h('p', { class: 'ui-muted' }, t('pack.cli.safety')),
    ].flat(Infinity).filter(Boolean))
  }

  const close = ctx.openDialog(dialog)
  render()
  title.focus()
  if (!current().pack) build()
  return close
}
