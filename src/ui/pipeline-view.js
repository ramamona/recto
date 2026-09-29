// Pipeline inbox (career-suite spec §6 auto-pipeline/pipeline/batch): paste many job links or descriptions, then
// "Process all" fetches, parses, evaluates (local; AI too when the user ticks it), saves to the tracker with source
// 'pipeline' and builds an application pack for each. Failed items keep their raw text for an edit and retry.
import { hubNav } from './hub-nav.js'
import { h, uid } from './dom.js'
import { isJobUrl, probeProxy, mergeJob, withSignal, evaluationRecord } from './job-panel.js'
import { fetchJob } from '../jobs/fetch.js'
import { parseJob } from '../jobs/parse.js'
import { matchCv } from '../jobs/match.js'
import { evaluateJob } from '../jobs/evaluate.js'
import { buildPack } from '../jobs/pack.js'
import { loadProfile } from '../profile.js'
import { createAssist } from '../ai/assist.js'
import { getConnection } from '../ai/connections.js'

export const ITEM_STATES = ['queued', 'working', 'done', 'failed', 'duplicate']
const CONCURRENCY = 2

/** Input → `[{ kind: 'url'|'text', value }]`: blocks split on blank lines; a block of only URLs gives one item per line. */
export function splitInput(text) {
  return String(text ?? '').split(/\r?\n[ \t]*\r?\n/).flatMap(block => {
    const lines = block.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    if (!lines.length) return []
    return lines.every(isJobUrl) ? lines.map(value => ({ kind: 'url', value })) : [{ kind: 'text', value: lines.join('\n') }]
  })
}

/** Comparable form of a job URL (no hash, no trailing slash, lower-case host); '' when not http(s). */
export function urlKey(url) {
  try {
    const u = new URL(String(url ?? '').trim())
    if (!/^https?:$/.test(u.protocol)) return ''
    return u.origin + u.pathname.replace(/\/+$/, '') + u.search
  } catch {
    return ''
  }
}

/** Splits `items` into fresh ones and duplicates (a URL already tracked or queued, or repeated; the same JD text twice). */
export function dedupeItems(items, jobs = [], queued = []) {
  const tracked = new Map()
  for (const j of jobs ?? []) for (const u of [j?.url, j?.applyUrl]) if (urlKey(u)) tracked.set(urlKey(u), j.id)
  const seen = new Set(queued.map(i => i.kind === 'url' ? urlKey(i.value) : i.value))
  const fresh = []
  const duplicates = []
  for (const item of items) {
    const key = item.kind === 'url' ? urlKey(item.value) : item.value
    if (tracked.has(key)) duplicates.push({ ...item, jobId: tracked.get(key) })
    else if (seen.has(key)) duplicates.push(item)
    else { seen.add(key); fresh.push(item) }
  }
  return { fresh, duplicates }
}

async function pool(items, n, fn) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++])
  }))
}

export function openPipeline(store, ctx, { tracker = ctx.tracker } = {}) {
  const { t } = ctx
  let items = [] // { key, kind, value, state, step?, error?, jobId?, score?, recommendation? }
  let running = null // AbortController for Process all
  let deep = false
  let proxy = null
  const titleId = uid('pipeline')

  const input = h('textarea', {
    class: 'ui-textarea pl-input', rows: 8, placeholder: t('pipeline.placeholder'), 'aria-label': t('pipeline.input'), dataset: { field: 'pipeline-input' }
  })
  const controls = h('div', { class: 'pl-controls' })
  const summary = h('span', { class: 'ui-muted pl-summary' })
  const applyStep = h('section', { class: 'pl-step', hidden: true })
  const list = h('ol', { class: 'pl-rows', 'aria-label': t('pipeline.queue') })
  const live = h('p', { class: 'visually-hidden', role: 'status', 'aria-live': 'polite' })

  const client = () => ctx.ai?.getClient?.() ?? null
  const cvState = () => {
    const s = store.state
    return { source: s.content, doc: s.doc, layout: s.layout, issues: s.issues, report: s.report }
  }

  function enqueue() {
    const { fresh, duplicates } = dedupeItems(splitInput(input.value), tracker.list(), items.filter(i => i.state !== 'duplicate'))
    const row = (i, state) => ({ key: uid('pl'), kind: i.kind, value: i.value, state, jobId: i.jobId })
    items = [...items, ...fresh.map(i => row(i, 'queued')), ...duplicates.map(i => row(i, 'duplicate'))]
    input.value = ''
    live.textContent = t('pipeline.added', { count: fresh.length, dupes: duplicates.length })
    render()
  }

  // Consent once per run; a refusal runs the batch locally
  async function aiAssist(signal) {
    if (!deep || !client()) return null
    const ok = ctx.ai.ensureConsent ? await ctx.ai.ensureConsent(getConnection()?.provider) : true
    return ok ? createAssist({ client: withSignal(client(), signal), getState: () => ({ content: store.state.content, doc: store.state.doc }) }) : null
  }

  async function jobFrom(item, signal) {
    if (!isJobUrl(item.value)) return { url: '', source: 'paste', title: '', company: '', location: '', text: item.value }
    proxy ??= probeProxy(globalThis.fetch, location.origin)
    return fetchJob(item.value, { proxyBase: (await proxy) ?? undefined, signal })
  }

  const step = (item, name) => { item.step = name; render() }

  async function processItem(item, assist, signal) {
    item.state = 'working'
    item.error = ''
    step(item, 'fetch')
    const got = await jobFrom(item, signal)
    const parsed = parseJob(got.text)
    const job = mergeJob(got, parsed)
    step(item, 'evaluate')
    const saved = tracker.list()
    const local = evaluateJob(cvState(), job, { profile: loadProfile(), now: new Date(), liveness: job.url ? 200 : undefined, saved })
    const match = matchCv(cvState(), parsed).score
    let ev = local
    if (assist) {
      ev = await assist.evaluate({ ...job, keywords: parsed.keywords ?? [] }, { local }).catch(err => {
        if (signal.aborted) throw err
        console.warn('recto: pipeline AI evaluation', err)
        return local
      })
    }
    signal.throwIfAborted()
    step(item, 'save')
    const fields = { url: job.url, source: 'pipeline', title: job.title, company: job.company, location: job.location, text: job.text, status: 'saved' }
    if (job.postedAt) fields.postedAt = job.postedAt
    const { id } = tracker.save(fields)
    // the full record (rows, role) feeds Insights' skill gaps and calibration
    tracker.addEvaluation(id, { ...evaluationRecord(local), match })
    if (ev !== local) tracker.addEvaluation(id, { ...evaluationRecord(ev), match })
    step(item, 'pack')
    const pack = await buildPack({
      job: tracker.get(id), profile: loadProfile(), assist: assist ?? undefined,
      cv: { docId: store.state.docId, content: store.state.content, doc: store.state.doc }
    })
    const cur = tracker.get(id)
    if (cur) tracker.save({ ...cur, pack })
    Object.assign(item, { state: 'done', jobId: id, score: ev.score, recommendation: ev.recommendation })
  }

  async function run(targets) {
    if (running || !targets.length) return
    const ac = running = new AbortController()
    for (const item of targets) item.state = 'queued'
    render()
    const assist = await aiAssist(ac.signal)
    await pool(targets, CONCURRENCY, async item => {
      if (ac.signal.aborted) return
      try {
        await processItem(item, assist, ac.signal)
      } catch (err) {
        if (ac.signal.aborted) { item.state = 'queued'; return }
        console.warn('recto: pipeline item', err)
        item.state = 'failed'
        item.error = err?.code === 'needs-paste' ? t('job.error.needs-paste') : err?.message || t('job.error.generic')
      }
      render()
    })
    if (running === ac) running = null
    const done = targets.filter(i => i.state === 'done').length
    live.textContent = t('pipeline.finished', { done, failed: targets.filter(i => i.state === 'failed').length })
    render()
  }

  function processAll() {
    if (running) return running.abort()
    if (input.value.trim()) enqueue()
    run(items.filter(i => i.state === 'queued'))
  }

  function retry(item, text) {
    const [next] = splitInput(text)
    if (!next) return
    Object.assign(item, { kind: next.kind, value: text.trim(), draft: undefined })
    run([item])
  }

  // ---------- view ----------
  const btn = (label, onClick, action, cls = '') => h('button', { class: `ui-btn ui-btn--sm ${cls}`.trim(), type: 'button', dataset: { action }, onClick }, label)
  const doneIds = () => items.filter(i => i.state === 'done' && tracker.get(i.jobId)?.status === 'saved').map(i => i.jobId)

  // One button: whatever is pasted joins the list and every waiting item is checked and saved
  function renderControls() {
    const ai = client()
    const ready = doneIds()
    controls.replaceChildren(...[
      btn(running ? t('app.cancel') : t('pipeline.check'), processAll, 'pipeline-process', running ? '' : 'ui-btn--primary'),
      ai && h('label', { class: 'ai-row pl-deep' },
        h('input', { type: 'checkbox', checked: deep, disabled: !!running, dataset: { field: 'pipeline-deep' }, onChange: e => { deep = e.target.checked } }),
        t('pipeline.deep'))
    ].filter(Boolean))
    const counts = ['done', 'failed', 'duplicate'].map(k => [k, items.filter(i => i.state === k).length]).filter(([, n]) => n)
    summary.textContent = counts.map(([k, n]) => t(`pipeline.count.${k}`, { n })).join(' · ')
    applyStep.hidden = !ready.length || !ctx.openApplyQueue
    applyStep.replaceChildren(h('h2', { class: 'pl-step__title' }, t('pipeline.step3')),
      h('p', { class: 'ui-muted ai-hint' }, t('pipeline.step3.hint')),
      btn(t('pipeline.apply', { n: ready.length }), () => ctx.openApplyQueue({ jobIds: ready }), 'pipeline-apply', 'ui-btn--primary'))
  }

  function row(item) {
    const job = item.jobId ? tracker.get(item.jobId) : null
    const name = job ? [job.title || t('job.untitled'), job.company].filter(Boolean).join(' — ') : item.value.split('\n')[0]
    const state = h('span', { class: 'pl-row__state' },
      item.state === 'working' ? t(`pipeline.step.${item.step}`) : t(`pipeline.state.${item.state}`))
    const parts = [h('span', { class: 'pl-row__name', title: item.value }, name), state]
    if (item.state === 'done') {
      parts.push(Number.isFinite(item.score) && h('span', { class: 'board-chip board-chip--stars' }, t('discover.stars', { score: item.score.toFixed(1) })),
        ctx.openPack && btn(t('pack.open'), () => ctx.openPack(item.jobId), 'pipeline-pack'))
    }
    if (item.state !== 'working' && !(running && item.state === 'queued')) {
      parts.push(h('button', {
        class: 'ui-btn ui-btn--sm ui-btn--ghost pl-row__remove', type: 'button', 'aria-label': t('pipeline.remove', { name }), dataset: { action: 'pipeline-remove' },
        onClick: () => { items = items.filter(i => i !== item); render() }
      }, '×'))
    }
    if (item.state === 'failed') {
      // the edit survives re-renders while other items are processed
      const raw = h('textarea', {
        class: 'ui-textarea pl-raw', rows: 3, value: item.draft ?? item.value, 'aria-label': t('pipeline.raw', { name }),
        onInput: e => { item.draft = e.target.value }
      })
      const again = btn(t('job.retry'), () => retry(item, raw.value), 'pipeline-retry', 'ui-btn--primary')
      again.disabled = !!running
      parts.push(h('p', { class: 'pl-row__error' }, item.error), h('div', { class: 'pl-row__fix' }, raw, again))
    }
    return h('li', { class: `pl-row is-${item.state}`, dataset: { state: item.state } }, parts.filter(Boolean))
  }

  function render() {
    renderControls()
    list.replaceChildren(...(items.length ? items.map(row) : [h('li', { class: 'pl-empty ui-muted' }, t('pipeline.empty'))]))
  }

  const dialog = h('dialog', { class: 'board pipeline', 'aria-labelledby': titleId },
    h('header', { class: 'board-head' },
      h('h1', { class: 'visually-hidden', id: titleId }, t('pipeline.title')),
      hubNav(ctx, 'pipeline'),
      h('span', { class: 'ui-muted board-head__intro' }, t('pipeline.intro')),
      h('span', { class: 'ui-spacer' }),
      btn(t('board.close'), () => close(), 'pipeline-close')),
    h('div', { class: 'pl-body' },
      h('section', { class: 'pl-step' }, h('h2', { class: 'pl-step__title' }, t('pipeline.step1')),
        h('p', { class: 'ui-muted ai-hint' }, t('pipeline.step1.hint')), input, controls),
      h('section', { class: 'pl-step' }, h('h2', { class: 'pl-step__title' }, t('pipeline.step2'), ' ', summary),
        h('p', { class: 'ui-muted ai-hint' }, t('pipeline.step2.hint')), list),
      applyStep),
    live)
  dialog.addEventListener('close', () => running?.abort(), { once: true })
  render()
  const close = ctx.openDialog(dialog)
  input.focus()
  return close
}
