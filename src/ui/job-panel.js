// Job tab (assist spec §7): paste a job link or description → job card, Recto match estimate, legitimacy flags,
// and the AI actions Evaluate / Tailor CV / Draft cover letter / Save to tracker.
import { h, svg, debounce } from './dom.js'
import { fetchJob } from '../jobs/fetch.js'
import { parseJob } from '../jobs/parse.js'
import { matchCv } from '../jobs/match.js'
import { checkLegitimacy } from '../jobs/legitimacy.js'
import { createAssist, coverLetterDoc } from '../ai/assist.js'
import { getConnection } from '../ai/connections.js'

const ATS = ['greenhouse', 'lever', 'ashby']
const BANDS = ['keywords', 'requirements', 'parseability', 'essentials']
const RING = 2 * Math.PI * 52

export const isJobUrl = input => /^https?:\/\/\S+$/i.test(String(input ?? '').trim())

/** serve.js answers `HEAD /api/fetch` without a url with 400; static hosts 404. Returns the proxy origin or null. */
export async function probeProxy(fetch, origin) {
  try {
    const res = await fetch(`${origin}/api/fetch`, { method: 'HEAD' })
    return res.status === 400 ? origin : null
  } catch {
    return null
  }
}

/** Fill a job's card fields from parsed ones; `prefer` (AI refinement) lets parsed fields win unless the source is an ATS API. */
export function mergeJob(job, parsed, { prefer = false } = {}) {
  const parsedWins = prefer && !ATS.includes(job.source)
  const out = { ...job }
  for (const k of ['title', 'company', 'location', 'postedAt']) {
    const [a, b] = parsedWins ? [parsed?.[k], job[k]] : [job[k], parsed?.[k]]
    const v = a || b
    if (v) out[k] = v
  }
  return out
}

/** The client with `signal` added to every call, so Cancel aborts AI requests made through createAssist. */
export const withSignal = (client, signal) => ({ ...client, complete: args => client.complete({ ...args, signal }) })

export const latestEvaluation = job => (job?.evaluations ?? []).filter(e => e?.kind === 'ai').at(-1) ?? null

const bandClass = score => score >= 75 ? 'is-good' : score >= 50 ? 'is-fair' : 'is-poor'

export function mountJobPanel(root, store, ctx) {
  const { t } = ctx
  let job = null // Job-like: { id?, url, source, title, company, location, text, postedAt?, evaluations? }
  let parsed = null
  let legit = null
  let evaluation = null
  let busy = null // { label, ac }
  let proxy = null

  const button = (label, onClick, cls = '') => h('button', { type: 'button', class: `ui-btn ui-btn--sm ${cls}`.trim(), onClick }, label)
  const input = h('textarea', {
    class: 'ui-textarea job-input', rows: 4, id: 'job-input', placeholder: t('job.input.placeholder'), 'aria-label': t('job.input.label'),
  })
  const analyzeBtn = button(t('job.analyze'), () => analyze(), 'ui-btn--primary')
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); analyze() }
  })
  const out = h('div', { class: 'job-out', 'aria-live': 'polite' })
  root.replaceChildren(h('div', { class: 'job-panel' },
    h('div', { class: 'job-form' }, input, h('div', { class: 'job-form__bar' }, analyzeBtn)), out))

  // ---------- helpers ----------

  const client = () => ctx.ai?.getClient?.() ?? null
  const state = () => ({ content: store.state.content, doc: store.state.doc })
  const cvName = () => store.state.name || store.state.doc.header?.name || t('app.untitled')
  const companyOf = () => job.company || job.title || t('job.untitled')
  const promptJob = () => ({ ...job, keywords: parsed?.keywords ?? [] })

  function errorText(e) {
    if (e?.code === 'needs-paste') return t('job.error.needs-paste')
    const key = `ai.error.${e?.code}`
    const s = e?.code ? t(key) : key
    return s === key ? e?.message || t('job.error.generic') : s
  }

  async function run(label, fn) {
    if (busy) return
    busy = { label, ac: new AbortController() }
    render()
    try {
      await fn(busy.ac.signal)
    } catch (e) {
      if (!(busy?.ac.signal.aborted || e?.code === 'aborted' || e?.name === 'AbortError')) {
        console.warn('recto: job panel', e)
        ctx.toast?.(errorText(e), e?.code === 'needs-paste' ? {} : { action: { label: t('job.retry'), run: () => run(label, fn) } })
      }
    } finally {
      busy = null
      render()
    }
  }

  async function aiReady() {
    if (!client()) {
      ctx.toast?.(t('job.ai.connect'))
      ctx.openAiDialog?.()
      return false
    }
    const provider = getConnection()?.provider
    return ctx.ai.ensureConsent ? !!(await ctx.ai.ensureConsent(provider)) : true
  }

  const assist = signal => createAssist({ client: withSignal(client(), signal), getState: state })

  // Anthropic's server-side web_fetch, only when that provider is connected and the user consents.
  function webFetchFor(signal) {
    if (!client() || getConnection()?.provider !== 'anthropic') return undefined
    return async url => {
      if (!(await ctx.ai.ensureConsent?.('anthropic'))) return null
      const r = await withSignal(client(), signal).complete({
        tools: ['web_fetch'], maxTokens: 8000,
        messages: [{ role: 'user', content: `Fetch ${url} and reply with the full text of the job posting only, as plain text.` }],
      })
      return r.text
    }
  }

  function show(next, p = parseJob(next.text)) {
    parsed = p
    job = mergeJob(next, p)
    legit = checkLegitimacy(job, { saved: ctx.tracker?.list?.() ?? [], now: new Date(), parsed: p })
    evaluation = latestEvaluation(job)
    render()
  }

  // ---------- actions ----------

  function analyze() {
    const value = input.value.trim()
    if (!value) return input.focus()
    if (!isJobUrl(value)) return show({ url: '', source: 'paste', title: '', company: '', location: '', text: value })
    run('job.busy.fetch', async signal => {
      proxy ??= probeProxy(globalThis.fetch, location.origin)
      const got = await fetchJob(value, { proxyBase: (await proxy) ?? undefined, webFetch: webFetchFor(signal), signal })
      show(got)
    })
  }

  const refine = () => run('job.busy.refine', async signal => {
    if (!(await aiReady())) return
    const p = await assist(signal).extractJob(job.text)
    show(mergeJob(job, p, { prefer: true }), p)
  })

  // Save or update without dropping status, docIds or evaluations kept by the tracker.
  function ensureSaved() {
    const tracker = ctx.tracker
    const cur = job.id ? tracker.get(job.id) : null
    const fields = { url: job.url, source: job.source, title: job.title, company: job.company, location: job.location, text: job.text }
    if (job.postedAt) fields.postedAt = job.postedAt
    job = { ...job, ...tracker.save({ ...cur, ...fields, id: job.id }) }
    return job.id
  }

  function saveToTracker() {
    const id = ensureSaved()
    const score = currentMatch()?.score
    if (Number.isFinite(score)) job = { ...job, ...ctx.tracker.addEvaluation(id, { kind: 'local', score }) }
    ctx.toast?.(t('job.saved'))
    render()
  }

  const evaluate = () => run('job.busy.evaluate', async signal => {
    if (!(await aiReady())) return
    const ev = await assist(signal).evaluate(promptJob())
    const id = ensureSaved()
    job = { ...job, ...ctx.tracker.addEvaluation(id, { kind: 'ai', ...ev }) }
    evaluation = latestEvaluation(job)
  })

  const tailor = () => run('job.busy.tailor', async signal => {
    if (!(await aiReady())) return
    // Ask first (on the original, same text as the copy) so a failure leaves no orphan copy.
    const result = await assist(signal).tailor(promptJob())
    const name = cvName()
    const id = ensureSaved()
    store.duplicateDoc()
    store.renameDoc(`${name} — ${companyOf()}`)
    const docId = store.state.docId
    ctx.tracker.link(id, docId)
    ctx.assistQueue ??= new Map()
    ctx.assistQueue.set(docId, result.suggestions)
    ctx.toast?.(t('job.tailored', { n: result.suggestions.length }))
    store.setUi({ panel: 'suggest' })
  })

  const coverLetter = () => run('job.busy.letter', async signal => {
    if (!(await aiReady())) return
    const letter = await assist(signal).coverLetter(promptJob())
    const { content, doc, layout } = store.state
    const name = cvName()
    const id = ensureSaved()
    store.newDoc()
    store.setContent(coverLetterDoc(content, doc, letter))
    // same look as the CV; its per-section config belongs to the CV's sections
    store.setLayout(Object.entries(layout).filter(([k]) => k !== 'sections').map(([k, value]) => ({ path: [k], value })))
    store.renameDoc(`${name} — ${t('job.letter.name')} — ${companyOf()}`)
    ctx.tracker.link(id, store.state.docId)
    ctx.toast?.(t('job.letter.done'))
  })

  function openSaved(id) {
    const saved = ctx.tracker?.get?.(id)
    if (!saved) return ctx.toast?.(t('job.notFound'))
    input.value = saved.url || ''
    show(saved)
  }

  // ---------- view ----------

  function currentMatch() {
    if (!parsed) return null
    const s = store.state
    return matchCv({ doc: s.doc, source: s.content, layout: s.layout, report: s.report, issues: s.issues }, parsed)
  }

  function jobCard() {
    const meta = [job.company, job.location].filter(Boolean).join(' · ')
    return h('article', { class: 'job-card' },
      h('h3', { class: 'job-card__title' }, job.title || t('job.untitled')),
      meta && h('p', { class: 'job-card__meta' }, meta),
      isJobUrl(job.url) && h('a', { class: 'job-card__link', href: job.url, target: '_blank', rel: 'noopener noreferrer' }, t('job.source')),
      h('div', { class: 'job-card__bar' },
        client() && button(t('job.refine'), refine),
        button(t('job.clear'), () => { job = parsed = legit = evaluation = null; input.value = ''; render(); input.focus() })))
  }

  function gauge(score) {
    const arc = RING * score / 100
    return svg('svg', { class: `job-gauge ${bandClass(score)}`, viewBox: '0 0 120 120', role: 'img', 'aria-label': t('job.match.aria', { score }) },
      svg('circle', { class: 'job-gauge__track', cx: 60, cy: 60, r: 52 }),
      svg('circle', { class: 'job-gauge__arc', cx: 60, cy: 60, r: 52, 'stroke-dasharray': `${arc} ${RING}`, transform: 'rotate(-90 60 60)' }),
      svg('text', { class: 'job-gauge__num', x: 60, y: 60, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, String(score)))
  }

  function chip(label, onClick, cls) {
    return h('button', { type: 'button', class: `job-chip ${cls}`, onClick }, label)
  }

  function addKeyword(m) {
    const section = store.state.doc.sections.find(s => s.id === m.where)
    if (section) {
      store.select({ kind: 'section', id: section.id })
      store.reveal(section.line)
    }
    ctx.toast?.(section ? t('job.missing.add', { keyword: m.keyword, section: section.title || t('job.missing.cv') })
      : t('job.missing.addCv', { keyword: m.keyword }))
  }

  function matchView(m) {
    return h('section', { class: 'job-match' },
      h('h3', { class: 'ui-group__title' }, t('job.match.title')),
      h('div', { class: 'job-match__top' }, gauge(m.score),
        h('ul', { class: 'job-bands' }, BANDS.map(b => {
          const { score, weight } = m.bands[b]
          return h('li', { class: `job-band ${bandClass(score)}` },
            h('span', { class: 'job-band__label' }, t(`job.band.${b}`, { weight })),
            h('span', { class: 'job-band__bar' }, h('span', { style: { width: `${score}%` } })),
            h('span', { class: 'job-band__num' }, String(score)))
        }))),
      h('p', { class: 'job-note' }, t('job.match.note')),
      m.missing.length > 0 && [
        h('h4', { class: 'job-sub' }, t('job.missing', { n: m.missing.length })),
        h('div', { class: 'job-chips' }, m.missing.map(k => chip(k.keyword, () => addKeyword(k), `is-missing is-${k.kind}`)))],
      m.present.length > 0 && [
        h('h4', { class: 'job-sub' }, t('job.present', { n: m.present.length })),
        h('div', { class: 'job-chips' }, m.present.map(k => chip(k.keyword, () => k.lines[0] && store.reveal(k.lines[0]), 'is-present')))])
  }

  function legitView() {
    return h('section', { class: 'job-legit' },
      h('h3', { class: 'ui-group__title' }, t('job.legit.title'), ' ',
        h('span', { class: `ui-badge job-level is-${legit.level}` }, t(`job.legit.${legit.level}`))),
      legit.signals.length > 0 && h('ul', { class: 'job-signals' }, legit.signals.map(s => h('li', { class: `job-signal is-${s.severity}` },
        h('span', null, t(`legit.${s.code}`)),
        s.evidence && h('q', { class: 'job-signal__evidence' }, s.evidence)))))
  }

  function evaluationView(ev) {
    return h('section', { class: 'job-eval' },
      h('h3', { class: 'ui-group__title' }, t('job.eval.title'), ' ',
        h('span', { class: 'job-eval__score' }, t('job.eval.score', { score: ev.score })), ' ',
        h('span', { class: `ui-badge job-rec is-${ev.recommendation}` }, t(`job.eval.${ev.recommendation}`))),
      ev.summary && h('p', { class: 'job-eval__summary' }, ev.summary),
      ev.requirements?.length > 0 && h('table', { class: 'job-reqs' },
        h('thead', null, h('tr', null, ['req', 'verdict', 'evidence'].map(c => h('th', { scope: 'col' }, t(`job.eval.col.${c}`))))),
        h('tbody', null, ev.requirements.map(r => h('tr', { class: `is-${r.verdict}` },
          h('td', null, r.text), h('td', null, t(`job.eval.${r.verdict}`)), h('td', null, r.evidence))))),
      ev.gaps?.length > 0 && [h('h4', { class: 'job-sub' }, t('job.eval.gaps')), h('ul', { class: 'job-gaps' }, ev.gaps.map(g => h('li', null, g)))],
      ev.levelFit && h('p', null, h('strong', null, t('job.eval.level')), ' ', ev.levelFit),
      ev.legitimacy?.notes && h('p', null, h('strong', null, t('job.eval.legit', { level: t(`job.legit.${ev.legitimacy.level}`) })), ' ', ev.legitimacy.notes),
      ev.pitch && h('p', { class: 'job-eval__pitch' }, h('strong', null, t('job.eval.pitch')), ' ', ev.pitch))
  }

  function render() {
    analyzeBtn.disabled = !!busy
    const status = busy && h('div', { class: 'job-busy', role: 'status' },
      h('span', { class: 'job-spinner', 'aria-hidden': 'true' }), h('span', null, t(busy.label)),
      button(t('app.cancel'), () => busy?.ac.abort()))
    if (!job) return out.replaceChildren(...[status || h('p', { class: 'job-empty ui-muted' }, t('job.empty'))])
    const m = currentMatch()
    out.replaceChildren(...[status, jobCard(), matchView(m), legitView(),
      h('div', { class: 'job-actions' },
        button(t('job.evaluate'), evaluate), button(t('job.tailor'), tailor),
        button(t('job.letter'), coverLetter), button(t('job.save'), saveToTracker, 'ui-btn--primary')),
      evaluation && evaluationView(evaluation)].flat(Infinity).filter(Boolean))
    for (const b of out.querySelectorAll('.job-actions button, .job-card__bar button')) b.disabled = !!busy
  }

  // Live match: the CV changed (issues arrive after each render, so they cover content and layout edits).
  const refresh = debounce(() => job && render(), 150)
  const openFromUi = s => {
    const id = s.ui.jobId
    if (!id) return
    queueMicrotask(() => store.setUi({ jobId: null })) // consumed, so opening the same job again works
    openSaved(id)
  }
  const unsubscribe = store.subscribe((s, changed) => {
    if (changed.has('ui')) openFromUi(s)
    if (['doc', 'layout', 'issues'].some(k => changed.has(k))) refresh()
  })
  openFromUi(store.state)
  render()
  return { destroy () { unsubscribe(); refresh.cancel(); busy?.ac.abort() } }
}
